Below is a production-oriented system-design guide based on your handwritten notes. I’ll treat **Draftly** as a modern web application with an API layer, PostgreSQL, AI/external-service integrations, background processing, and real-time progress updates. The architecture still applies if some of Draftly’s exact components differ.

# Draftly System Design Guide

## 1. The core design problem

A system usually starts simply:

```text
Browser
   |
   v
API Server
   |
   v
Database
```

That architecture is perfectly reasonable at low traffic.

The problems begin when Draftly has to handle:

- many users reading the same data,
- many users creating or updating data simultaneously,
- expensive AI or integration calls,
- jobs that take seconds or minutes,
- live progress updates,
- unreliable third-party APIs,
- retries without creating duplicate data,
- servers crashing mid-job,
- database contention,
- traffic spikes.

Your notes describe five major techniques for solving those problems:

```text
1. Scale reads
2. Scale writes
3. Real-time communication
4. Long-running jobs
5. Reliability
```

They should not be treated as five isolated topics. In a production architecture, they reinforce one another.

---

# 2. Scale reads

Your notes list:

- Caching
- Read replicas
- Database indexing

The goal is simple:

> Make frequently requested data cheap and fast to retrieve without overwhelming the primary database.

---

## 2.1 Database indexing

Indexing is normally the **first read optimization** you should make.

Without an index, PostgreSQL may need to scan a large portion of a table.

Suppose Draftly stores documents:

```sql
SELECT *
FROM documents
WHERE project_id = '123'
ORDER BY created_at DESC;
```

If there are millions of documents, this becomes expensive.

An index such as:

```sql
CREATE INDEX idx_documents_project_created
ON documents(project_id, created_at DESC);
```

lets PostgreSQL locate the relevant rows much faster.

### Good indexing candidates

For Draftly, likely fields include:

```text
user_id
organization_id
workspace_id
project_id
repository_id
status
created_at
updated_at
external_id
```

You might also use compound indexes:

```text
(project_id, created_at)

(organization_id, status)

(repository_id, branch_name)
```

### Use indexing when

- queries are becoming slow,
- tables are growing,
- the same filters appear frequently,
- joins are expensive,
- sorting large result sets is common.

### Do not blindly index everything

Indexes have a cost.

Every write must update the relevant indexes.

So:

```text
More indexes
    ↓
faster reads
    ↓
slower writes
    ↓
more storage
```

Indexes should be driven by real queries.

Use tools such as:

```sql
EXPLAIN ANALYZE
```

to inspect query plans.

---

# 3. Caching

Caching avoids recomputing or reloading information that has already been retrieved.

Instead of:

```text
Request
   ↓
API
   ↓
PostgreSQL
```

you introduce a fast cache:

```text
Request
   ↓
API
   ↓
Redis
   |
   +--- cache hit → return result

   +--- cache miss
          ↓
      PostgreSQL
          ↓
      populate Redis
```

Redis is commonly used because reads are extremely fast.

---

## Example

Imagine Draftly exposes:

```http
GET /projects/123
```

Instead of querying PostgreSQL every time:

```text
Redis key:

project:123
```

The flow becomes:

```text
1. Look for project:123 in Redis.
2. If found → return it.
3. Otherwise query PostgreSQL.
4. Put result into Redis.
5. Return result.
```

This is known as **cache-aside**.

---

## Cache expiration

Every cache entry should generally have a TTL:

```text
project:123

TTL = 5 minutes
```

Otherwise outdated data can survive indefinitely.

---

## Cache invalidation

The notoriously difficult part is keeping the cache consistent.

Suppose:

```text
PATCH /projects/123
```

updates PostgreSQL.

You should then invalidate:

```text
project:123
```

The next read reloads fresh data.

A common pattern:

```text
write DB
   ↓
invalidate cache
```

rather than trying to manually update every cached representation.

---

## Excellent things to cache

For Draftly:

```text
project metadata
repository metadata
user permissions
workspace settings
configuration
expensive dashboard summaries
frequently accessed generated artifacts
external API responses
```

Avoid aggressively caching rapidly changing transactional data unless consistency rules are well defined.

---

# 4. Read replicas

Eventually your primary PostgreSQL instance may become overwhelmed by reads.

Instead of:

```text
                    ┌──────────────┐
All requests ──────►│ Primary DB   │
                    └──────────────┘
```

use:

```text
                     ┌──────────────┐
Writes ─────────────►│ Primary DB   │
                     └──────┬───────┘
                            │ replication
                 ┌──────────┴─────────┐
                 ↓                    ↓
           Read Replica 1       Read Replica 2
                 ↑                    ↑
               reads                reads
```

The primary handles:

```text
INSERT
UPDATE
DELETE
```

Replicas handle suitable:

```text
SELECT
```

---

## The important problem: replication lag

Replication is usually asynchronous.

A user might:

```text
1. Create project
2. Immediately request project
```

If that second request goes to a replica before replication catches up:

```text
404 Not Found
```

even though the project exists.

Therefore Draftly should implement **read-after-write consistency** where necessary.

Possible policy:

```text
Immediately after a mutation:
    read from primary

Normal browsing:
    read from replica
```

---

# 5. Recommended read-scaling order

Do not immediately deploy ten replicas.

Usually scale progressively:

```text
Step 1
Optimize SQL

Step 2
Add indexes

Step 3
Add connection pooling

Step 4
Cache hot data

Step 5
Add read replicas

Step 6
Consider specialized storage/search systems
```

---

# 6. Scale writes

Your notes list:

- batching,
- sharding,
- asynchronous writes.

Writes are harder to scale than reads because multiple machines have to coordinate state.

---

# 7. Batching

Batching means combining many small operations into fewer large ones.

Instead of:

```text
INSERT row 1
INSERT row 2
INSERT row 3
...
INSERT row 1000
```

do:

```text
INSERT 1000 rows
```

or process updates as a group.

---

## Draftly example

Suppose a repository scan finds 20,000 files.

Bad design:

```text
20,000 HTTP calls
20,000 DB transactions
20,000 commits
```

Better:

```text
scan files
    ↓
buffer records
    ↓
write batches of 500
```

Advantages:

```text
fewer network round trips
fewer DB transactions
higher throughput
lower CPU overhead
```

---

## When to batch

Good candidates include:

```text
analytics events
embedding records
repository metadata
audit events
bulk imports
search-index updates
usage metrics
```

---

# 8. Asynchronous writes

Not every operation needs to finish before the HTTP response returns.

Suppose a user starts documentation generation.

Bad flow:

```text
Browser
   ↓
POST /generate
   ↓
API waits 90 seconds
   ↓
LLM
   ↓
Git provider
   ↓
database
   ↓
Browser receives response
```

There are many failure opportunities.

A better design:

```text
Browser
   ↓
POST /generate
   ↓
API
   ↓
Create job
   ↓
Queue job
   ↓
202 Accepted
```

Then separately:

```text
Queue
  ↓
Worker
  ↓
Generate documentation
  ↓
Persist result
```

The request becomes fast while heavy processing happens asynchronously.

---

# 9. Sharding

Sharding splits data across multiple database instances.

For example:

```text
Tenant A–M → Database 1
Tenant N–Z → Database 2
```

or:

```text
hash(organization_id) % 4

Shard 0
Shard 1
Shard 2
Shard 3
```

---

## Why shard?

Eventually one database server has physical limits:

```text
CPU
RAM
disk IOPS
connection count
storage
```

Sharding distributes those constraints.

---

## Why sharding should come late

It creates major operational complexity.

You now have to solve:

```text
Which shard owns this record?

How do we migrate tenants?

How do cross-shard joins work?

How are backups coordinated?

How are IDs generated?

What happens when a shard becomes overloaded?
```

Therefore Draftly should generally prefer:

```text
indexes
caching
batching
queues
vertical DB scaling
read replicas
partitioning
```

before introducing application-level sharding.

---

# 10. Real-time data

Your notes list:

- WebSockets
- Server-Sent Events
- Long polling

These solve a different problem:

> How does the backend notify the browser when something changes?

This is particularly useful for long-running Draftly workflows.

---

# 11. Long polling

The simplest approach is polling:

```text
GET /jobs/123
GET /jobs/123
GET /jobs/123
GET /jobs/123
```

every few seconds.

Long polling improves this.

The server keeps the request open until:

```text
something changes

OR

timeout occurs
```

Then the client reconnects.

### Advantages

Simple and compatible.

### Disadvantages

More HTTP overhead and connection churn.

Use long polling when real-time requirements are modest or client environments make SSE/WebSockets unsuitable.

---

# 12. Server-Sent Events

SSE creates a persistent server → browser stream.

Example:

```text
GET /jobs/123/events
```

The server can send:

```text
event: progress
data: {"percent":20}

event: progress
data: {"percent":55}

event: completed
data: {"documentId":"abc"}
```

SSE is excellent when communication mostly goes in one direction:

```text
Server ───────► Browser
```

This makes it particularly appropriate for:

```text
AI generation progress
repository import progress
job logs
workflow state changes
background-processing notifications
```

---

# 13. WebSockets

WebSockets provide bidirectional communication:

```text
Browser ◄────────► Server
```

They are useful when both sides continuously send information.

Examples:

```text
collaborative editing
chat
multiplayer interaction
presence indicators
live cursors
interactive streaming interfaces
```

For simply displaying background-job progress, SSE is often simpler.

---

# 14. Choosing between them

| Requirement                      | Recommended approach |
| -------------------------------- | -------------------- |
| Occasional updates               | Polling              |
| Simple near-real-time updates    | Long polling         |
| Backend → browser updates        | SSE                  |
| Continuous two-way communication | WebSockets           |
| Collaborative editor             | WebSockets           |
| Background job progress          | SSE                  |

---

# 15. Long-running jobs

Your notes list:

- Message queues
- Worker pools
- Workflow engines

This is one of the most important parts of a production AI application.

---

# 16. Message queues

A queue separates the API layer from expensive work.

Architecture:

```text
                 ┌─────────────┐
Browser ────────►│ API servers │
                 └──────┬──────┘
                        │
                        ▼
                 ┌─────────────┐
                 │ Job Queue   │
                 └──────┬──────┘
                        │
                 ┌──────┴──────┐
                 ▼             ▼
             Worker 1       Worker 2
```

Potential systems include:

```text
Redis-backed queues
RabbitMQ
Amazon SQS
Kafka
Google Pub/Sub
```

The correct choice depends on scale and delivery semantics.

---

# 17. Worker pools

A worker pool is a group of processes that pull jobs from the queue.

Suppose Draftly receives:

```text
100 documentation-generation jobs
```

With:

```text
10 workers
```

each worker handles work independently.

The queue absorbs spikes.

```text
Normal traffic:

queue → 4 jobs

Traffic spike:

queue → 2,000 jobs

Workers continue processing steadily.
```

This protects the main application.

---

# 18. Worker specialization

Not every job should necessarily share the same queue.

Draftly could eventually have:

```text
repo-import queue
AI-generation queue
embedding queue
webhook queue
email queue
cleanup queue
```

Then workers can scale independently.

For example:

```text
AI generation
10 workers

Email
2 workers

Repository indexing
20 workers
```

---

# 19. Workflow engines

Queues are excellent for individual jobs.

Complex business workflows require more.

Imagine this Draftly process:

```text
1. Clone repository
2. Parse repository
3. Build dependency graph
4. Generate embeddings
5. Retrieve external context
6. Generate documentation
7. Validate output
8. Persist result
9. Publish update
```

If step 6 fails, what should happen?

A simple queue implementation can become complicated.

Workflow engines solve this.

Conceptually:

```text
Workflow
   |
   ├── Task A
   |
   ├── Task B
   |
   ├── Task C
   │     retry
   │     retry
   │
   └── Task D
```

They typically provide:

```text
durable execution
retries
timeouts
state persistence
workflow history
task scheduling
failure recovery
```

For complex multi-step AI pipelines, a workflow engine can become much easier to reason about than dozens of ad-hoc queue consumers.

## Draftly's durable page workflow

Draftly's documentation generation is a concrete instance of a workflow engine. The top-level Strands Graph owns the lifecycle (classify → context → research → impact → document → changelog → changelog_evaluate → deliver, plus a human ReviewGate), while per-document authoring runs inside a Draftly-owned durable DAG adapter (`DocumentationWorkflowNode` + `PageWorkflowExecutor` + `PageWorkflowRepository`).

```text
document node
    ↓ seeds write:<page>:1 → evaluate:<page>:1 per planned page
per-page revision loops (max 3 automatic attempts, only failed pages)
    ↓
cross_page_review (only after every page passes)
    ↓
passed → changelog → deliver
    ↓
escalated (budget exhausted / no evidence) → human ReviewGate → resume
```

Why Draftly owns the DAG adapter instead of `strands_tools.workflow`:

- **Lease-based durability.** Tasks, page states, and evaluations are persisted in PostgreSQL. Claims use `FOR UPDATE SKIP LOCKED` plus a lease (`lease_owner`, `lease_expires_at`); `reset_expired_leases` lets a restarted worker reclaim orphaned tasks and resume the DAG. The Strands Workflow tool manages task state in memory and cannot survive process death.
- **Sealed-artifact accounting.** Each page artifact is immutable (`DocumentArtifact` with `artifact_id`, monotonically increasing `version`, `content_hash`, `status="sealed"`). Writes reserve versions atomically (`documentation_page_states.next_version`) and `record_artifact` only promotes strictly newer versions, so a late write can never clobber a newer artifact. Task histories and evaluations carry the exact artifact identity they graded.
- **Separate concurrency budgets.** Writers and evaluators claim through different semaphores, so distinct provider rate limits are a first-class scheduling concern.
- **Deterministic gates stay deterministic.** The quality gate is Draftly's own rubric (`compute_page_metrics`); the DAG schedules it per page instead of letting a general flow runner reinterpret verdicts.
- **Deadlock detection.** `DeadlockedWorkflowError` is raised when pending tasks are not reachable from completed dependencies.

Key behaviors:

- **Per-page attempts.** `MAX_AUTOMATIC_EVALUATION_ATTEMPTS = 3`. Attempts persist per page; infrastructure retries retried once by `retry_or_fail_task` do not consume quality attempts. One failing page never restarts passing pages.
- **Missing-evidence escalation.** A page with no usable path-scoped evidence (no `_evidence_has_signals`) records `awaiting_human_review` immediately with "No page-scoped evidence is available; human review required" — it never passes and never falls back to a batch revision.
- **Cross-page review placement.** The `cross_page_review` task (`cross-page-review:<digest>`) is enqueued only after the last evaluation settles every page as passed. A clean verdict passes the workflow; a `correct` verdict returns targeted per-page instructions that schedule revision pairs for only the named pages.
- **Restart behavior.** Seeding is idempotent (`ON CONFLICT DO NOTHING`, pinned task ids); expired leases are reclaimed before each claim round; `resume()` applies human decisions (`approve` is idempotent, `request_changes` schedules one human-guided pair per escalated page, `reject` cancels pending tasks).
- **Hard cutover.** The legacy `document → review → evaluate` Strands loop and its `FanOutWriterNode` / `ReviewNode` are deleted; offline fixtures fail fast (no shadow drafting). A cutover script exits 0 only when no documentation workflow remains in `queued`, `running`, `pending_review`, or `pending_intervention`.

---

# 20. Reliability

Your notes contain four critical ideas:

- retries + backoff,
- idempotency,
- circuit breakers,
- self-healing.

These are what prevent ordinary failures from becoming outages.

---

# 21. Retries

External systems fail.

Examples:

```text
LLM provider timeout
Git provider 503
database connection reset
DNS issue
rate limit
network interruption
```

Some failures are temporary.

So retry.

Bad:

```text
retry immediately
retry immediately
retry immediately
retry immediately
```

That may make an outage worse.

Better:

```text
attempt 1
wait 1 second

attempt 2
wait 2 seconds

attempt 3
wait 4 seconds

attempt 4
wait 8 seconds
```

This is **exponential backoff**.

Add random jitter:

```text
4 seconds ± random delay
```

to prevent thousands of workers from retrying simultaneously.

---

# 22. Retry only retryable failures

Not everything should be retried.

Retry:

```text
429 Too Many Requests
502
503
504
network timeout
temporary connection errors
```

Usually do not retry:

```text
400 malformed request
401 invalid authentication
403 permission denied
404 when logically permanent
validation errors
```

---

# 23. Idempotency

Retries introduce a dangerous possibility.

Suppose:

```text
Create document
```

succeeds.

But the response is lost.

The client retries.

Without protection:

```text
Document #1 created
Document #2 created
```

Idempotency guarantees that repeated attempts represent the **same logical operation**.

For example:

```http
POST /generations

Idempotency-Key:
abf91c29...
```

Backend stores:

```text
key → result
```

If the request repeats:

```text
same key
   ↓
same result
```

instead of performing the operation again.

---

# 24. Idempotency in workers

Worker jobs also need idempotency.

Suppose:

```text
generate-document:job-982
```

runs twice because of redelivery.

The worker should detect:

```text
job-982 already completed
```

and avoid duplicating side effects.

This becomes especially important with queues that provide **at-least-once delivery**.

---

# 25. Circuit breakers

Suppose Draftly depends on an external API.

That API goes down.

Without protection:

```text
10,000 requests
    ↓
10,000 calls to broken service
    ↓
10,000 timeouts
    ↓
workers become exhausted
    ↓
Draftly also fails
```

A circuit breaker monitors failures.

```text
CLOSED
   ↓
requests allowed

failure threshold exceeded
   ↓

OPEN
   ↓
requests rejected quickly

wait
   ↓

HALF OPEN
   ↓
allow test requests

service healthy?
   ↓
CLOSED
```

This prevents one dependency failure from cascading through Draftly.

---

# 26. Self-healing

Self-healing means infrastructure automatically recovers from common failures.

Examples:

```text
worker crashes
→ container restarted

API pod fails health check
→ removed from traffic

server dies
→ replacement instance starts

job worker becomes unhealthy
→ orchestrator replaces it
```

In Kubernetes-style environments:

```text
readiness probe
liveness probe
restart policy
replica count
autoscaling
```

provide much of this behavior.

---

# 27. Combine the five areas into one architecture

A production Draftly architecture could look like this:

```text
                         USERS
                           │
                           ▼
                  ┌─────────────────┐
                  │ CDN / Edge      │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ Load Balancer   │
                  └────────┬────────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
               API Server      API Server
                    │             │
                    └──────┬──────┘
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
      Redis Cache      PostgreSQL        Job Queue
                          │                  │
                          │          ┌───────┴────────┐
                          │          ▼                ▼
                          │      Worker Pool      Worker Pool
                          │          │                │
                          │          └───────┬────────┘
                          │                  │
                          │             External APIs
                          │
                    replication
                          │
                ┌─────────┴─────────┐
                ▼                   ▼
          Read Replica         Read Replica

Workers / workflows
          │
          ▼
     Event stream
          │
          ▼
       SSE layer
          │
          ▼
       Browser
```

That architecture captures all five topics from your notes.

---

# 28. A practical Draftly request flow

Imagine the user clicks:

> Generate documentation

The production flow should resemble this.

### Step 1 — browser submits request

```http
POST /projects/123/generations
```

including an idempotency key.

---

### Step 2 — API validates

The API checks:

```text
authentication
authorization
quota
project status
input validity
```

---

### Step 3 — database transaction

Create:

```text
generation
status = queued
```

and possibly an **outbox event** in the same transaction.

---

### Step 4 — queue

The job enters:

```text
generation_jobs
```

The API immediately responds:

```http
202 Accepted
```

with:

```json
{
  "jobId": "gen_982",
  "status": "queued"
}
```

---

### Step 5 — browser subscribes

The browser opens:

```http
GET /jobs/gen_982/events
```

using SSE.

---

### Step 6 — worker claims the job

```text
worker-7
   ↓
gen_982
```

and updates:

```text
status = processing
```

---

### Step 7 — workflow executes

For example:

```text
fetch repository
      ↓
analyze repository
      ↓
retrieve context
      ↓
generate content
      ↓
validate content
      ↓
persist result
```

---

### Step 8 — progress events

Workers emit:

```text
10% repository fetched

30% repository analyzed

55% context prepared

80% documentation generated

95% validating
```

The SSE layer forwards those to the browser.

---

### Step 9 — success

Database:

```text
status = completed
```

Cache invalidated.

Event emitted:

```text
generation.completed
```

Browser receives:

```text
completed
```

and fetches the final resource.

---

# 29. Use an outbox pattern for reliable events

A subtle failure can happen here:

```text
Database write succeeds

↓

Process crashes

↓

Queue publish never happens
```

The database now says:

```text
job exists
```

but no worker knows about it.

A robust architecture uses the **transactional outbox pattern**.

Inside one PostgreSQL transaction:

```text
INSERT job

INSERT outbox_event

COMMIT
```

Another process reads:

```text
outbox_event
```

and publishes it to the queue.

Therefore either both records exist or neither exists.

---

# 30. State machine for jobs

Never let background-job states become arbitrary strings.

Define a state machine.

For example:

```text
QUEUED
  │
  ▼
RUNNING
  │
  ├──────────► RETRYING
  │               │
  │               └────► RUNNING
  │
  ├──────────► FAILED
  │
  ├──────────► CANCELLED
  │
  └──────────► COMPLETED
```

This makes:

```text
UI
monitoring
retry logic
analytics
operations
```

much easier.

---

# 31. Dead-letter queues

Some jobs will repeatedly fail.

Do not retry them forever.

For example:

```text
attempt 1
attempt 2
attempt 3
attempt 4
attempt 5
```

Then:

```text
Dead Letter Queue
```

Operations can inspect them later.

Store information such as:

```text
job ID
error
stack trace
attempt count
payload reference
last attempted time
```

---

# 32. Rate limiting

Draftly should protect both itself and downstream providers.

Possible limits:

```text
requests / user
requests / organization
generations / minute
repository imports / hour
concurrent AI jobs / tenant
```

Redis is commonly useful for rate-limit counters.

---

# 33. Backpressure

Imagine users submit:

```text
50,000 jobs
```

while workers can handle only:

```text
500/hour
```

The system must not keep accepting unlimited work.

Options include:

```text
tenant concurrency limits
queue-size thresholds
rate limiting
temporary rejection
priority queues
autoscaling workers
```

This is called **backpressure**.

Without it, queues can become a delayed outage rather than protection.

---

# 34. Isolation between customers

For a multi-tenant Draftly deployment, one large customer should not starve everyone else.

Possible design:

```text
per-tenant concurrency limits
weighted queues
priority classes
resource quotas
```

Instead of:

```text
Tenant A → 50,000 jobs

Tenant B → waits 8 hours
```

you want fairness.

---

# 35. Database connection pooling

This is another production requirement.

Suppose you deploy:

```text
20 API instances
20 worker instances
```

and each opens:

```text
50 database connections
```

You suddenly have:

```text
40 × 50 = 2,000 connections
```

which can overwhelm PostgreSQL.

Use connection pooling:

```text
Application
      ↓
Connection Pool
      ↓
PostgreSQL
```

and keep connection limits intentional.

---

# 36. Separate synchronous from asynchronous paths

This is an important architectural rule.

### Synchronous path

Should be fast:

```text
authentication
reading project metadata
creating job record
simple CRUD
authorization
```

Target roughly:

```text
tens to hundreds of milliseconds
```

where practical.

### Asynchronous path

Use for:

```text
LLM generation
repository cloning
large file processing
embedding
web crawling
analysis
bulk indexing
long integrations
```

This keeps API latency predictable.

---

# 37. Failure domains

Ask:

> What happens if this dependency disappears for 10 minutes?

Consider:

```text
PostgreSQL down
Redis down
queue down
LLM provider down
Git provider down
worker fleet down
SSE connection drops
```

Draftly should degrade appropriately.

For example:

### Redis unavailable

Perhaps:

```text
cache bypass
→ query PostgreSQL
```

rather than total failure.

### LLM provider unavailable

```text
jobs stay queued/retrying
API remains healthy
```

### SSE unavailable

```text
UI falls back to polling
```

Graceful degradation is often more useful than trying to make every component infinitely reliable.

---

# 38. Observability

None of this architecture is useful if you cannot see what it is doing.

Draftly should have three observability pillars:

```text
Logs
Metrics
Traces
```

---

## Logs

Structured logs:

```json
{
  "jobId": "gen_982",
  "projectId": "proj_123",
  "worker": "worker-7",
  "event": "generation_started"
}
```

Avoid logs that are only:

```text
Something failed.
```

---

## Metrics

Important metrics include:

```text
HTTP latency
HTTP error rate
requests/sec

DB query latency
DB connections
DB CPU

cache hit ratio

queue depth
oldest job age
jobs/sec
job failure rate

worker utilization

external API latency
external API failures
retry count
```

---

## Distributed tracing

One user request might touch:

```text
API
database
queue
worker
LLM
Git provider
Redis
```

A trace ID lets you follow one operation through the entire system.

```text
trace_id = 8ac91...

API
 ↓
queue publish
 ↓
worker
 ↓
LLM
 ↓
DB
```

For a distributed system, this can save enormous debugging time.

---

# 39. Health checks

Use different health concepts.

### Liveness

```text
Is this process alive?
```

If no:

```text
restart it
```

### Readiness

```text
Can this process safely receive traffic?
```

If no:

```text
remove from load balancer
```

Those are not the same thing.

---

# 40. Data consistency model

Not all Draftly data needs the same consistency guarantees.

Use **strong consistency** for things like:

```text
billing
permissions
ownership
job state transitions
quota consumption
```

Eventual consistency is usually acceptable for:

```text
analytics
search indexes
cached dashboards
secondary metadata
progress indicators
```

This distinction allows the architecture to scale without sacrificing correctness where it matters.

---

# 41. Suggested service boundaries

Do not immediately build 30 microservices.

A good early production architecture could remain a **modular monolith**:

```text
Draftly API

modules:
  auth
  users
  organizations
  projects
  repositories
  generations
  billing
  integrations
```

plus separate:

```text
worker processes
```

This provides clean boundaries without the operational complexity of many services.

Extract services only when there is a real reason, such as:

```text
independent scaling
security isolation
different runtime requirements
large engineering ownership boundaries
extreme reliability requirements
```

---

# 42. Suggested logical architecture

```text
                 ┌────────────────────┐
                 │   Web / Mobile UI  │
                 └──────────┬─────────┘
                            │ HTTPS
                            ▼
                 ┌────────────────────┐
                 │ API Gateway / LB   │
                 └──────────┬─────────┘
                            │
              ┌─────────────┴──────────────┐
              │                            │
              ▼                            ▼
       ┌──────────────┐             ┌──────────────┐
       │ API Instance │             │ API Instance │
       └───────┬──────┘             └───────┬──────┘
               │                            │
               └────────────┬───────────────┘
                            │
          ┌─────────────────┼────────────────────┐
          │                 │                    │
          ▼                 ▼                    ▼
      ┌───────┐       ┌───────────┐       ┌───────────┐
      │ Redis │       │PostgreSQL │       │ Job Queue │
      └───────┘       └─────┬─────┘       └─────┬─────┘
                            │                   │
                      replication              │
                            │           ┌───────┴────────┐
                            ▼           ▼                ▼
                       Read DB       Worker           Worker
                                        │                │
                                        └───────┬────────┘
                                                │
                                      ┌─────────┼─────────┐
                                      ▼         ▼         ▼
                                    LLM     Git APIs   Search/API
                                                │
                                                ▼
                                          Event Stream
                                                │
                                                ▼
                                               SSE
                                                │
                                                ▼
                                            Browser
```

---

# 43. Suggested lifecycle of a Draftly job

A robust generation job might look like:

```text
                create
                  │
                  ▼
               QUEUED
                  │
                  ▼
             INITIALIZING
                  │
                  ▼
         FETCHING_REPOSITORY
                  │
                  ▼
           ANALYZING_CODE
                  │
                  ▼
          RETRIEVING_CONTEXT
                  │
                  ▼
             GENERATING
                  │
                  ▼
             VALIDATING
                  │
                  ▼
              SAVING
                  │
                  ▼
             COMPLETED
```

Any intermediate state can transition to:

```text
RETRYING
FAILED
CANCELLED
```

This gives your UI meaningful progress without guessing percentages.

---

# 44. Suggested technology responsibilities

Rather than saying one technology solves everything, give each one a clear role.

| Component       | Responsibility                           |
| --------------- | ---------------------------------------- |
| PostgreSQL      | Durable source of truth                  |
| Redis           | Cache, locks, counters, ephemeral state  |
| Queue           | Decouple background work                 |
| Workers         | Execute expensive work                   |
| Workflow engine | Coordinate complex durable pipelines     |
| SSE             | Push job progress to browser             |
| Object storage  | Large artifacts/files                    |
| Search engine   | Full-text or semantic search when needed |
| CDN             | Static/public content                    |
| Load balancer   | Spread incoming traffic                  |

A key principle:

> PostgreSQL should generally remain the authoritative source of truth. Redis and search indexes should be reconstructable secondary systems.

---

# 45. What not to put in Redis

Avoid making Redis the only copy of critical information such as:

```text
billing state
document ownership
final generated documents
permissions
workflow completion state
```

unless Redis persistence and failure semantics have been deliberately designed for it.

Use Redis primarily for information that can be rebuilt:

```text
cache entries
rate limits
short-lived locks
presence
temporary job progress
```

---

# 46. Locking and duplicate execution

Suppose two workers accidentally process the same repository.

You may need a distributed lock:

```text
lock:repository:123
```

with:

```text
owner ID
TTL
```

But locks should not replace idempotency.

A correct design assumes:

> A job might execute more than once.

Then it makes repeated execution safe.

---

# 47. Timeouts everywhere

Every network operation should have a timeout.

Never allow:

```text
call external API

wait forever
```

Configure:

```text
connect timeout
request timeout
worker execution timeout
database statement timeout
```

A dependency that is merely slow can be as damaging as one that has crashed.

---

# 48. Graceful shutdown

When deploying a new worker version:

Bad:

```text
kill process immediately
```

Potential result:

```text
half-written output
lost work
duplicate processing
```

Better:

```text
stop accepting jobs
      ↓
finish current job
      ↓
release resources
      ↓
shutdown
```

For long workflows, workers should checkpoint state so execution can continue elsewhere.

---

# 49. Deployment strategy

A safe deployment flow can be:

```text
build artifact
      ↓
run automated tests
      ↓
run database migrations
      ↓
deploy small percentage
      ↓
observe metrics
      ↓
increase traffic
```

This can be implemented as:

```text
rolling deployment
canary deployment
blue/green deployment
```

Database migrations must remain backward-compatible during rolling deployments.

---

# 50. Scaling model

Think separately about each component.

### API

Scale based on:

```text
requests/sec
CPU
latency
```

### Workers

Scale based on:

```text
queue depth
job age
CPU/GPU usage
```

### Database

Scale through:

```text
query optimization
indexes
vertical scaling
connection pooling
read replicas
partitioning
eventual sharding
```

### Redis

Scale based on:

```text
memory
requests/sec
hot keys
```

Each subsystem has different scaling signals.

---

# 51. Priority queues

Not all work has the same importance.

Possible Draftly queues:

```text
high priority
    interactive user jobs

normal
    background generation

low
    indexing
    analytics
    cleanup
```

This prevents cleanup jobs from delaying something a user is actively waiting for.

---

# 52. Cancellation

Long-running AI workflows should support cancellation.

Browser:

```http
POST /jobs/123/cancel
```

Database:

```text
cancel_requested = true
```

Workers periodically check cancellation between stages:

```text
fetch
  ↓
check cancellation
  ↓
analyze
  ↓
check cancellation
  ↓
generate
```

Do not assume abruptly killing a worker is equivalent to safely cancelling a workflow.

---

# 53. Security architecture

System design also includes security boundaries.

Draftly should consider:

```text
TLS everywhere
secret manager
encrypted database storage
least-privilege credentials
short-lived cloud credentials
tenant isolation
audit logs
webhook signature verification
API rate limiting
input validation
```

Workers should not automatically receive every secret used by the main application.

Only give each component what it needs.

---

# 54. Handling external integrations

External systems should sit behind an internal adapter.

Instead of application code everywhere doing:

```text
GitHub API call
```

create:

```text
GitProvider

cloneRepository()
getFile()
createPullRequest()
```

Then implementations can be:

```text
GitHubProvider
GitLabProvider
BitbucketProvider
```

The adapter also becomes the natural place for:

```text
timeouts
retries
rate limiting
circuit breakers
logging
```

The same principle applies to LLM providers.

---

# 55. Cost controls

AI workloads introduce a scaling problem beyond infrastructure:

```text
token cost
```

Before starting expensive jobs, Draftly should enforce:

```text
tenant quota
max files
max repository size
max context
max concurrency
token budget
model selection rules
```

Background workers should record:

```text
input tokens
output tokens
model
duration
estimated cost
```

This lets you identify expensive workflows.

---

# 56. A sensible growth path for Draftly

Do not build the final distributed architecture on day one.

### Stage 1 — early production

```text
API
PostgreSQL
basic Redis
background queue
2–3 workers
SSE
```

Focus on:

```text
indexes
idempotency
timeouts
structured logs
```

---

### Stage 2 — growing usage

Add:

```text
more caching
worker autoscaling
dedicated queues
dead-letter queues
distributed tracing
read replica
better rate limiting
```

---

### Stage 3 — complex workflows

Introduce:

```text
workflow engine
priority scheduling
outbox pattern
advanced tenant quotas
provider circuit breakers
```

---

### Stage 4 — large scale

Only then consider:

```text
partitioning
regional deployments
multiple database clusters
sharding
specialized services
cross-region failover
```

This progression avoids **premature distributed-system complexity**.

---

# 57. How the five ideas fit together

Your handwritten notes can ultimately be summarized as one pipeline.

```text
                  USER REQUEST
                       │
                       ▼
                 API SERVERS
                       │
         ┌─────────────┼─────────────┐
         │             │             │
         ▼             ▼             ▼
      CACHE        DATABASE        QUEUE
         │             │             │
         │          indexes          ▼
         │         read replicas    WORKERS
         │                           │
         │                           ▼
         │                     WORKFLOW ENGINE
         │                           │
         │                     retries/backoff
         │                      idempotency
         │                   circuit breakers
         │                           │
         └─────────────┬─────────────┘
                       │
                       ▼
                    EVENTS
                       │
                       ▼
                SSE / WebSocket
                       │
                       ▼
                    BROWSER
```

The five concerns solve different bottlenecks:

| Concern           | Primary question                                      |
| ----------------- | ----------------------------------------------------- |
| Scale reads       | How can many users retrieve data cheaply?             |
| Scale writes      | How can many operations modify data safely?           |
| Real-time         | How does the client learn about changes immediately?  |
| Long-running jobs | How do expensive tasks run without blocking requests? |
| Reliability       | What happens when something inevitably fails?         |

---

# 58. Architectural rules I would use for Draftly

If I were defining the engineering rules for this architecture, they would be:

1. **PostgreSQL is the source of truth.**
2. **Redis is an optimization, not critical permanent storage.**
3. **HTTP requests should not perform long-running AI work synchronously.**
4. **Long work goes through a durable queue or workflow system.**
5. **Every worker operation must tolerate duplicate execution.**
6. **External-service calls need explicit timeouts, retries, and backoff.**
7. **Retries require idempotency.**
8. **Repeated external failures should trigger circuit breakers.**
9. **SSE should handle one-way progress updates unless two-way real-time interaction genuinely requires WebSockets.**
10. **Every important workflow should be observable through logs, metrics, and traces.**
11. **Scale PostgreSQL intelligently before reaching for sharding.**
12. **Queues should absorb temporary spikes, not unlimited traffic.**
13. **Cache invalidation should happen alongside mutations.**
14. **Worker concurrency should be limited per tenant and per external provider.**
15. **Every background job should have a durable lifecycle state.**

---

# 59. Final production picture

The full Draftly system would therefore behave like this:

```text
Users
  │
  ▼
CDN / Load Balancer
  │
  ▼
Stateless API Fleet
  │
  ├────────► Redis
  │             │
  │          caching
  │          rate limits
  │          ephemeral state
  │
  ├────────► PostgreSQL Primary
  │             │
  │          indexes
  │             │
  │          replication
  │             ▼
  │        Read Replicas
  │
  └────────► Durable Queue
                │
        ┌───────┴────────┐
        ▼                ▼
    Worker Pool      Worker Pool
        │                │
        └───────┬────────┘
                ▼
         Workflow Engine
                │
      ┌─────────┼─────────┐
      ▼         ▼         ▼
    LLMs      Git APIs   Other APIs
      │
      │ retries + backoff
      │ idempotency
      │ circuit breakers
      │
      ▼
   PostgreSQL
      │
      ▼
 Event / Progress Stream
      │
      ▼
      SSE
      │
      ▼
   User Interface
```

The central design philosophy is:

> **Keep the synchronous path short, move expensive work into durable asynchronous execution, make repeated operations safe, and assume every networked dependency will eventually fail.**

That single principle connects almost everything in your handwritten notes.
