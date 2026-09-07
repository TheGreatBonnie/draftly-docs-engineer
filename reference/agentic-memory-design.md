# Agentic Memory Design

**Agentic Memory Design** is the cognitive architecture and system design that gives AI agents **persistent, structured, adaptive, and self-organizing memory across sessions and executions**.

It extends an AI agent beyond the stateless limits of an LLM context window by defining how information is:

1. **Captured**
2. **Interpreted**
3. **Stored**
4. **Retrieved**
5. **Updated**
6. **Connected**
7. **Validated**
8. **Forgotten**

For Draftly, Agentic Memory Design answers a fundamental question:

> **How does Draftly remember what it has learned about a software project while ensuring that old knowledge does not cause incorrect documentation?**

That distinction is important.

A simple RAG system might work like this:

```text
Store documents
      ↓
Create embeddings
      ↓
Similarity search
      ↓
Send results to LLM
```

Draftly needs something more sophisticated:

```text
Events
  │
  ▼
Interpret
  │
  ▼
Extract Knowledge
  │
  ├── Facts
  ├── Decisions
  ├── Experiences
  ├── Procedures
  │
  ▼
Curate
  │
  ├── Merge
  ├── Update
  ├── Link
  ├── Validate
  └── Forget
  │
  ▼
Persistent Memory
  │
  ▼
Retrieve Task-Relevant Context
  │
  ▼
Draftly Agent
```

This is what makes the memory **agentic**.

The system does not simply store information. It actively manages its own knowledge.

---

# Agentic Memory Architecture for Draftly

I recommend thinking about Draftly's memory as a layered architecture.

```text
┌───────────────────────────────────────────────────────┐
│                   DRAFTLY AGENTS                      │
│                                                       │
│ Change │ Research │ Generate │ Evaluate │ Publish     │
└───────────────────────┬───────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────┐
│              MEMORY ORCHESTRATION LAYER               │
│                                                       │
│ Retrieve │ Rank │ Compress │ Validate │ Write         │
└───────────────────────┬───────────────────────────────┘
                        │
            ┌───────────┴────────────┐
            ▼                        ▼
┌───────────────────────┐  ┌───────────────────────────┐
│    WORKING MEMORY     │  │    LONG-TERM MEMORY       │
│                       │  │                           │
│ Current task state    │  │ Episodic                 │
│ Recent evidence       │  │ Semantic                 │
│ Agent scratch state   │  │ Procedural               │
│ Execution context     │  │ Documentation knowledge  │
└───────────────────────┘  └─────────────┬─────────────┘
                                         │
                                         ▼
                         ┌───────────────────────────┐
                         │   MEMORY CURATOR AGENT    │
                         │                           │
                         │ Extract                   │
                         │ Deduplicate               │
                         │ Resolve contradictions    │
                         │ Update                    │
                         │ Link                      │
                         │ Forget                    │
                         └─────────────┬─────────────┘
                                       │
                                       ▼
                         ┌───────────────────────────┐
                         │          NEONDB           │
                         │                           │
                         │ Structured records        │
                         │ Vector representations    │
                         │ Relationships             │
                         │ Provenance                │
                         │ Version history           │
                         └───────────────────────────┘
```

---

# The Core Layers of Agentic Memory

## 1. Working Memory

**Working memory** is the temporary context an agent uses while completing its current task.

It usually exists only for the duration of a workflow or agent execution.

For example, Draftly receives this event:

```text
GitHub Pull Request #482

Changed files:

auth/token_service.py
auth/oauth.py
tests/test_tokens.py
```

The Change Detection Agent begins investigating.

Its working memory might contain:

```text
Current task:
Determine documentation impact of PR #482.

Files changed:
- auth/token_service.py
- auth/oauth.py

Detected changes:
- Token expiry changed.
- Refresh token support added.

Current hypothesis:
Authentication documentation may require updating.
```

This information does not necessarily need to become permanent memory.

### Draftly implementation

In the Strands-based architecture, working memory can include:

```text
Agent invocation state
+
Current event
+
Retrieved context
+
Tool outputs
+
Intermediate reasoning state
```

Conceptually:

```text
Event
  │
  ▼
Agent Run
  │
  ├── Current Task
  ├── Tool Results
  ├── Retrieved Memory
  └── Intermediate State
```

When the task finishes, most of this context should disappear.

Only important outcomes should be promoted to long-term memory.

### Key principle

> **Working memory is for thinking. It is not automatically for remembering.**

---

# 2. Long-Term Persistent Memory

Long-term memory stores knowledge that should survive beyond a single agent execution.

For Draftly, this memory belongs to the **software project**, not simply to an individual agent session.

For example:

```text
Project: Authly

Known facts:

- Authentication uses OAuth2.
- Public clients use PKCE.
- Access tokens expire after one hour.
- Refresh tokens are supported.
```

This information should remain available when Draftly processes future events.

A long-term memory system should contain multiple specialized forms of memory.

```text
Long-Term Memory
       │
       ├── Episodic
       │
       ├── Semantic
       │
       ├── Procedural
       │
       └── Documentation Knowledge
```

For Draftly, NeonDB can act as the durable system of record for this layer.

---

# 3. Episodic Memory

**Episodic memory records what happened.**

It stores experiences from previous agent executions.

For Draftly, an episode might look like:

```text
Episode: Documentation Update #A-9821

Trigger:
GitHub PR #482

Detected:
Token expiration changed from 24 hours to 1 hour.

Actions:
- Repository researched.
- Existing authentication documentation retrieved.
- Token lifecycle documentation updated.

Evaluation:
PASS

Human review:
APPROVED

Published:
docs/auth/token-lifecycle.md
```

This is different from semantic memory.

Semantic memory stores:

> Access tokens expire after one hour.

Episodic memory stores:

> Draftly discovered and documented this change while processing PR #482.

### Why Draftly needs episodic memory

It allows future agents to learn from previous workflows.

For example:

```text
Current Task:
Process PR modifying auth/token_service.py
```

Draftly retrieves:

```text
Similar Past Episode:

Changes to auth/token_service.py previously required updates to:

- docs/auth/token-lifecycle.md
- docs/auth/refresh-tokens.md
```

This improves documentation impact detection.

### Episodic memory schema

Conceptually:

```text
episode
│
├── episode_id
├── project_id
├── trigger_type
├── trigger_id
├── timestamp
├── agents_used
├── actions_taken
├── tools_used
├── outcome
├── evaluation_results
└── artifacts_created
```

---

# 4. Semantic Memory

**Semantic memory stores durable facts and knowledge.**

For Draftly, this is arguably the most important memory layer.

Examples:

```text
FACT
Access tokens expire after one hour.
```

```text
ARCHITECTURAL DECISION
Public OAuth clients must use PKCE.
```

```text
DOCUMENTATION RELATIONSHIP
Changes to authentication flows affect
docs/authentication.md.
```

```text
REPOSITORY KNOWLEDGE
The API authentication implementation is located
in auth/.
```

Semantic memory should not be treated as an append-only log.

It must evolve.

For example:

```text
Old fact:

Access tokens expire after 24 hours.
```

New repository evidence:

```text
TOKEN_EXPIRY = 3600
```

The Memory Curator performs:

```text
Existing Semantic Memory
        │
        ▼
New Evidence
        │
        ▼
Contradiction Detection
        │
        ▼
Old Memory Superseded
        │
        ▼
New Memory Becomes Current
```

Result:

```text
Historical:

Access tokens expired after 24 hours.
Status: SUPERSEDED
```

```text
Current:

Access tokens expire after 1 hour.
Status: ACTIVE
```

This is essential for documentation engineering.

> Draftly must remember that knowledge changed, not merely remember both versions without understanding their relationship.

---

# 5. Procedural Memory

**Procedural memory stores how Draftly performs tasks.**

This is knowledge about actions and workflows.

For example:

```text
When an authentication API changes:

1. Inspect implementation changes.
2. Identify affected endpoints.
3. Retrieve authentication documentation.
4. Check API references.
5. Generate documentation updates.
6. Run Strands Evals.
7. Request human review if confidence is below threshold.
```

Procedural memory can also contain learned patterns.

For example:

```text
Pattern:

Changes involving:

auth/token_service.py

Usually require reviewing:

docs/auth/token-lifecycle.md
```

Another example:

```text
Pattern:

Breaking API changes require:

- Migration guide evaluation
- API reference validation
- Changelog generation
```

This makes Draftly progressively better.

Instead of always starting from:

```text
"How should I investigate this?"
```

Draftly can retrieve:

```text
"When this kind of change happened previously,
this investigation strategy was successful."
```

---

# A Draftly-Specific Fourth Long-Term Layer: Documentation Memory

I would add a dedicated memory type specifically for Draftly.

## Documentation Memory

This represents Draftly's understanding of the documentation system itself.

For example:

```text
Code:
auth/token_service.py

Affects:
docs/auth/token-lifecycle.md

Documentation concepts:
- Access tokens
- Token expiry
- Refresh tokens
```

This can be represented as relationships:

```text
┌──────────────────────┐
│ auth/token_service.py│
└──────────┬───────────┘
           │
           │ implements
           ▼
┌──────────────────────┐
│ Token Lifecycle      │
└──────────┬───────────┘
           │
           │ documented by
           ▼
┌────────────────────────────┐
│ docs/auth/token-lifecycle  │
└────────────────────────────┘
```

This layer is extremely valuable because Draftly's core problem is not simply:

> Understand software.

It is:

> **Understand the relationship between software and its documentation.**

Over time, Draftly can build a **Documentation Knowledge Graph**.

```text
Repository Code
      │
      ├─────────────┐
      ▼             ▼
Concepts       API Contracts
      │             │
      └──────┬──────┘
             ▼
      Documentation
             │
             ▼
       Tests / Evals
             │
             ▼
      Historical Changes
```

---

# Memory Management Operations

The layers describe **what Draftly remembers**.

The following operations describe **how Draftly manages memory**.

---

## 1. Memory Capture

Every Draftly event produces potential knowledge.

```text
GitHub PR
Slack Discussion
Discord Question
Repository Change
Evaluation Result
Human Review
```

But these should not all become memories automatically.

Instead:

```text
Raw Event
    │
    ▼
Candidate Memory Extraction
    │
    ▼
Memory Curator Evaluation
    │
    ├── Durable?
    ├── Useful?
    ├── Supported by evidence?
    ├── Already known?
    └── Contradicts existing knowledge?
```

Only valuable information is promoted.

---

# 2. Retrieval

Draftly should never load its entire memory into the context window.

Instead:

```text
Current Task
      │
      ▼
Memory Query
      │
      ├── Semantic Search
      ├── Metadata Filtering
      ├── Graph Traversal
      └── Recency / Confidence Ranking
              │
              ▼
      Small Relevant Context Set
              │
              ▼
           Agent
```

Suppose the task is:

```text
Investigate PR #482 involving OAuth.
```

Draftly should retrieve:

```text
Relevant:

✓ OAuth architecture
✓ PKCE requirements
✓ Token lifecycle
✓ Related documentation
✓ Similar historical PRs
```

It should not retrieve:

```text
✗ Database migration history
✗ Billing documentation
✗ Discord support conversations about UI
✗ Unrelated API knowledge
```

This is where RAG becomes part of Agentic Memory Design.

---

# 3. Memory Evolution

Memory must change when the software changes.

The lifecycle is:

```text
New Evidence
      │
      ▼
Find Existing Memory
      │
      ├── No Match
      │      │
      │      ▼
      │   Create
      │
      ├── Supports Existing
      │      │
      │      ▼
      │ Increase Confidence
      │
      ├── Adds Information
      │      │
      │      ▼
      │ Update / Merge
      │
      └── Contradicts Existing
             │
             ▼
        Supersede / Resolve
```

The Memory Curator Agent is the primary owner of this process.

---

# 4. Memory Consolidation

Multiple events might describe the same fact.

For example:

```text
PR #482:
Added refresh tokens.
```

```text
Slack:
Refresh tokens are now available.
```

```text
Documentation:
Use refresh tokens to obtain new access tokens.
```

The system should avoid storing three unrelated copies.

Instead:

```text
Semantic Memory

Refresh tokens are supported.
        │
        ├── Evidence: PR #482
        ├── Evidence: Slack announcement
        └── Evidence: Repository implementation
```

This creates a stronger and more trustworthy memory.

---

# 5. Contradiction Resolution

This is one of the most important operations for Draftly.

Imagine:

```text
Memory:
Rate limit = 100 requests/minute
```

New evidence:

```text
Configuration:
RATE_LIMIT = 1000
```

The Memory Curator should investigate:

```text
Is the memory stale?
Is the code environment-specific?
Is the new evidence authoritative?
Was this a temporary experiment?
```

Then decide:

```text
UPDATE
```

or:

```text
KEEP BOTH WITH CONDITIONS
```

For example:

```text
Production:
1000 requests/minute

Free tier:
100 requests/minute
```

This is why memory curation should be an intelligent agent workflow rather than a simple database write.

---

# 6. Forgetting and Eviction

For Draftly, forgetting does not necessarily mean deleting everything.

I recommend three strategies.

### Soft eviction

```text
Memory:
Access tokens expire after 24 hours.

Status:
SUPERSEDED
```

The memory remains for historical reasoning but is excluded from normal retrieval.

---

### Archival

Old episodes can be compressed:

```text
Original:
50 individual agent events
```

Becomes:

```text
Summary:

Draftly successfully updated authentication documentation
following OAuth migration in May 2026.
```

---

### Hard deletion

Appropriate for:

```text
Duplicate records
Temporary debugging output
Low-confidence hallucinated knowledge
Invalid extracted facts
```

The principle should be:

> **Current knowledge should be easy to retrieve; historical knowledge should be available when explicitly needed; useless knowledge should disappear.**

---

# Implementing Agentic Memory in Draftly

I recommend this architecture.

```text
                     EVENT SOURCES
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
     GitHub          Slack          Discord
        │              │              │
        └──────────────┼──────────────┘
                       ▼
                 EVENT INGESTION
                       │
                       ▼
              ┌────────────────┐
              │ Draftly Router │
              └───────┬────────┘
                      │
                      ▼
               DRAFTLY AGENTS
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Research    Generate    Evaluate
          │           │           │
          └───────────┼───────────┘
                      ▼
              MEMORY CANDIDATES
                      │
                      ▼
          ┌─────────────────────────┐
          │   MEMORY CURATOR AGENT  │
          │                         │
          │ Extract                 │
          │ Classify                │
          │ Validate                │
          │ Deduplicate             │
          │ Link                    │
          │ Evolve                  │
          │ Forget                  │
          └────────────┬────────────┘
                       ▼
                MEMORY SERVICES
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Episodic     Semantic    Procedural
          │            │            │
          └────────────┼────────────┘
                       ▼
                     NEONDB
                       │
              ┌────────┴────────┐
              ▼                 ▼
       Structured Memory    Vector Index
              │                 │
              └────────┬────────┘
                       ▼
                MEMORY RETRIEVAL
                       │
                       ▼
                 FUTURE AGENTS
```

---

# The Memory Curator Agent in the Strands Architecture

The Memory Curator should be a specialized Strands agent rather than being embedded inside every other agent.

Conceptually:

```text
agents/
│
├── change_detector/
│
├── research/
│
├── documentation/
│
├── evaluator/
│
├── reviewer/
│
└── memory_curator/
    │
    ├── agent.py
    ├── prompt.md
    ├── models.py
    ├── policies.py
    └── skills/
```

The Memory Curator receives **memory candidates**, rather than raw memory writes.

Example:

```json
{
  "candidate": "Access tokens expire after one hour.",
  "type": "technical_fact",
  "project_id": "authly",
  "source": {
    "type": "github_pr",
    "id": "482"
  },
  "evidence": ["auth/token_service.py"],
  "confidence": 0.94
}
```

Its job is to determine:

```text
CREATE?
UPDATE?
MERGE?
SUPERSEDE?
REJECT?
ARCHIVE?
```

---

# NeonDB Memory Model

For Draftly, I recommend separating the logical memory model from the physical database implementation.

At the application level:

```text
Memory
│
├── Identity
├── Type
├── Content
├── Project Scope
├── Confidence
├── Importance
├── Status
├── Validity Period
├── Provenance
├── Relationships
└── Vector Representation
```

Conceptually:

```text
memory_records
│
├── id
├── project_id
├── memory_type
├── content
├── summary
├── confidence
├── importance
├── status
├── valid_from
├── valid_until
├── created_at
└── updated_at
```

Supporting provenance:

```text
memory_sources
│
├── memory_id
├── source_type
├── source_id
├── source_url
└── evidence
```

Relationships:

```text
memory_relationships
│
├── source_memory_id
├── target_memory_id
└── relationship_type
```

Examples:

```text
SUPPORTS
CONTRADICTS
SUPERSEDES
DERIVED_FROM
RELATED_TO
DOCUMENTED_BY
IMPLEMENTED_BY
```

This allows Draftly to build knowledge relationships without requiring that everything be represented as an explicit graph database.

---

# The Most Important Draftly Memory Flow

The complete memory loop should look like this:

```text
1. SOFTWARE CHANGES
        │
        ▼
2. DRAFTLY DETECTS EVENT
        │
        ▼
3. RETRIEVE RELEVANT MEMORY
        │
        ▼
4. AGENT PERFORMS WORK
        │
        ▼
5. EVALUATE RESULT
        │
        ▼
6. EXTRACT MEMORY CANDIDATES
        │
        ▼
7. MEMORY CURATOR
        │
        ├── Validate
        ├── Merge
        ├── Update
        ├── Link
        └── Forget
        │
        ▼
8. PERSIST CURATED MEMORY
        │
        ▼
9. FUTURE DRAFTLY AGENTS
   HAVE BETTER CONTEXT
```

This creates a feedback loop:

```text
         ┌────────────────────────────┐
         │     SOFTWARE EVOLUTION     │
         └──────────────┬─────────────┘
                        ▼
                  DRAFTLY WORK
                        ▼
                  EVALUATION
                        ▼
                MEMORY CURATION
                        ▼
                 BETTER MEMORY
                        ▼
              BETTER FUTURE WORK
                        │
                        └───────────────┐
                                        │
                                        ▼
                                SOFTWARE EVOLUTION
```

# The central design principle for Draftly

The most important principle I would use is:

> **Draftly should not remember events. Draftly should remember knowledge extracted from events, preserve the evidence behind that knowledge, and continuously update that knowledge as the software evolves.**

That gives Draftly three things that ordinary RAG systems struggle with:

- **Persistence** — knowledge survives across agent runs.
- **Adaptation** — knowledge changes when the software changes.
- **Reliability** — agents can trace knowledge back to evidence.

The **Memory Curator Agent** is therefore the intelligence responsible for the health of this memory system, while **NeonDB is the durable substrate that stores and retrieves it**.
