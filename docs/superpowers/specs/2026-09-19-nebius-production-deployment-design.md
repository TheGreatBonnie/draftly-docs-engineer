# Draftly Nebius Production Deployment — Design Specification

**Date:** 2026-09-19  
**Status:** Approved design, pending written-spec review  
**Target:** Nebius x NVIDIA Global AI Hackathon submission and production-style deployment

## Summary

Draftly will run as a production-style application on Nebius Managed Service for Kubernetes. The always-on Kubernetes control plane will host the Next.js UI, FastAPI API, a durable dispatch service, and a Nebius job reconciler. Each documentation workflow execution will run as a disposable Nebius Serverless AI Job. The job will call NVIDIA open-source models exclusively through Nebius Token Factory and will attempt Tavily research during every documentation workflow.

PostgreSQL remains the source of truth for workflow state, dispatch commands, evidence, reviews, and execution receipts. Redis continues to provide live event streams, locks, caches, and provider-health data, but no correctness or recovery path may depend exclusively on Redis. Existing Neon PostgreSQL, managed Redis, Clerk, and GitHub integrations remain in place for the hackathon deployment.

When a workflow reaches human review, its Serverless Job checkpoints `pending_review` and exits successfully. Approval or rejection is persisted by the API. Approval creates a durable resume command, and the dispatcher launches a new Serverless Job that resumes the workflow and performs delivery. No job remains alive while waiting for a person.

## Goals

- Host Draftly's public UI and API on Nebius Managed Kubernetes.
- Use Nebius Token Factory as the only LLM provider in the Nebius environment.
- Use NVIDIA open-source models served through Token Factory for all agent roles.
- Execute documentation workflows as Nebius Serverless AI Jobs.
- Attempt Tavily research in every documentation workflow.
- Continue safely with repository evidence when Tavily is unavailable or unusable.
- Preserve Draftly's evidence grounding, evaluation loops, human review, and GitHub delivery.
- Make dispatch, retries, resumption, and external side effects durable and idempotent.
- Provide production-grade security, observability, rollout, and recovery controls.
- Produce a demonstrable, significant update to the pre-existing Draftly project during the hackathon submission period.

## Non-goals

- Migrating Neon PostgreSQL or managed Redis to another service.
- Hosting custom models on Nebius Serverless Endpoints.
- Using any non-Token Factory LLM provider in the Nebius environment.
- Fine-tuning Nemotron models.
- Migrating Slack or Discord support workflows in the initial release.
- Running GPU nodes in the Kubernetes cluster.
- Rewriting the Strands documentation graph.
- Replacing Clerk authentication or the GitHub App.
- Multi-region Kubernetes or disaster recovery across regions.
- Automatically merging generated pull requests.

## Scope

### Initial production path

The first release supports the GitHub documentation workflow:

1. Receive a merged pull-request or release event.
2. Persist the normalized event, workflow run, and dispatch intent.
3. Launch a Serverless Job.
4. Research repository and existing documentation evidence.
5. Attempt Tavily research and record its outcome.
6. Use Token Factory models for classification, impact analysis, drafting, evaluation, and revision.
7. Persist the draft, evidence, model provenance, and evaluation results.
8. Checkpoint and exit at human review.
9. Persist the human decision.
10. Launch a separate resume job after approval.
11. Create exactly one GitHub pull request and persist the delivery receipt.

Scheduled evaluation, indexing, and memory-maintenance workloads migrate to scheduled Serverless Jobs after the primary documentation path is stable. Slack and Discord integrations remain disabled in the initial Nebius deployment because their response-time expectations are incompatible with multi-minute job provisioning.

## Architecture

### Control plane: Managed Kubernetes

The always-on control plane contains:

- **Ingress:** Public TLS termination and routing for the UI and API.
- **Next.js UI:** Two replicas serving the review workspace and operational views.
- **FastAPI API:** Two replicas handling authentication, webhooks, reads, review decisions, SSE, and dispatch-intent creation.
- **Dispatcher:** Claims durable outbox commands and creates Nebius Serverless Jobs.
- **Reconciler:** Polls Nebius job state, maps infrastructure outcomes into Draftly state, manages retries, and identifies stuck executions.
- **Migration job:** A gated Kubernetes Job executed before an application rollout.

The API and dispatcher must never execute an agent graph. They may validate, persist, dispatch, reconcile, and expose state only.

### Data plane: Serverless Jobs

Each workflow attempt runs from an immutable backend image digest. Its entrypoint accepts:

- `run_id`
- `phase` (`start`, `resume`, or a scheduled workload type)
- `attempt`
- `command_id`

The job loads all canonical inputs from PostgreSQL. No prompt, repository payload, workflow checkpoint, or secret is passed directly in the job creation request. The job atomically acquires an execution lease before advancing the graph.

The job:

1. Claims its run and phase.
2. Loads the persisted workflow context and checkpoint.
3. Executes the appropriate Strands graph segment.
4. Calls Token Factory for inference.
5. Calls Tavily for external research on documentation workflows.
6. Persists steps, evidence, drafts, evaluations, and checkpoints.
7. Publishes best-effort live events through Redis.
8. Releases or completes its execution lease.
9. Exits with a status that matches the committed workflow outcome.

Jobs use CPU-only regular compute because model inference is remote through Token Factory. Preemptible compute is excluded from the initial release to avoid introducing unnecessary interruption handling during the hackathon.

### Persistence and coordination

- **PostgreSQL and pgvector:** Canonical source for workflow runs, checkpoints, commands, receipts, evidence, reviews, drafts, evaluations, memory, model invocation metadata, and delivery receipts.
- **Redis:** Live SSE streams, short-lived locks, caches, rate limiting, provider health, and performance statistics.
- **Nebius Container Registry:** Immutable API, dispatcher, reconciler, workflow, and frontend images.
- **SecretStash:** Source of truth for credentials and sensitive configuration.

Redis loss may degrade live updates and caches but must not make a workflow unrecoverable. The UI reconstructs run history from PostgreSQL after reconnecting.

## Workflow lifecycle

### Start path

1. The API verifies and normalizes the incoming webhook.
2. In one PostgreSQL transaction, it creates or resolves the idempotent workflow run and inserts a `start` dispatch command.
3. The dispatcher claims the command with `FOR UPDATE SKIP LOCKED` semantics.
4. The dispatcher creates a Nebius Serverless Job using the pinned backend image digest.
5. The dispatcher records the Nebius job ID and marks the command dispatched.
6. The reconciler reflects Nebius `PROVISIONING`, `STARTING`, `IMAGE_PULLING`, and `RUNNING` states in Draftly.
7. The job acquires the run-phase lease and executes the graph.
8. At the review boundary, the job commits `pending_review`, seals its draft and evidence, and exits successfully.

### Resume path

1. The API validates the review decision and writes it to PostgreSQL.
2. Rejection moves the run to `rejected` without creating a new job.
3. Approval atomically moves the run to `resume_pending` and inserts a `resume` dispatch command.
4. The dispatcher creates a new Serverless Job.
5. The resume job acquires the resume-phase lease and loads the sealed checkpoint.
6. The delivery agent checks for a prior delivery receipt or existing pull request before mutation.
7. The job opens one GitHub pull request, persists the receipt, and commits `completed`.

### Cancellation

A user cancellation writes a durable cancellation request. The reconciler asks Nebius to cancel an active job and moves the run to `cancelled` only after no execution lease can continue. A job must check cancellation at node boundaries and before side-effecting tools.

## Durable contracts

### Dispatch command

Required fields:

- `command_id`
- `organization_id`
- `run_id`
- `phase`
- `attempt`
- `image_digest`
- `status`
- `not_before`
- `claimed_by`
- `claimed_at`
- `created_at`
- `updated_at`

The command is created in the same transaction as the workflow state transition that requires execution. A unique constraint on `(run_id, phase, attempt)` prevents duplicate commands.

### Execution receipt

Required fields:

- `command_id`
- `nebius_job_id`
- `state`
- `state_code`
- `state_message`
- `created_at`
- `started_at`
- `finished_at`
- `last_observed_at`

Only one active Nebius job may be associated with a command. A retry creates a new command with an incremented attempt.

### Execution lease

Required fields:

- `run_id`
- `phase`
- `owner_job_id`
- `attempt`
- `acquired_at`
- `heartbeat_at`
- `expires_at`

Only the active lease owner may advance a graph. Expired leases may be reclaimed only after reconciliation confirms that the prior job is no longer executing.

### External evidence

Required fields:

- `run_id`
- `query`
- `url`
- `title`
- `retrieved_at`
- `excerpt`
- `relevance_score`
- `source_type`
- `authority_class`
- `acceptance_status`
- `rejection_reason`

Only accepted evidence enters the grounding bundle. Raw Tavily results remain auditable but cannot be used by the writer unless they pass relevance and source-quality checks.

### Model invocation

Required fields:

- `run_id`
- `step_id`
- `provider`
- `model_id`
- `agent_role`
- `started_at`
- `latency_ms`
- `input_tokens`
- `output_tokens`
- `outcome`
- `error_class`

In the Nebius environment, `provider` must always equal `nebius_token_factory`.

## Token Factory design

Draftly will add a dedicated Token Factory provider rather than repurposing the existing NVIDIA NIM provider. The provider uses Token Factory's OpenAI-compatible API and environment-specific credentials:

- `NEBIUS_TOKEN_FACTORY_API_KEY`
- `NEBIUS_TOKEN_FACTORY_BASE_URL`
- role-specific Token Factory model IDs

The deployment sets `DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory`. No fallback chain may cross to Bedrock, NVIDIA NIM, Requesty, OrcaRouter, OpenRouter, or Mantle.

Role routing remains capability-based:

- Fast, lower-cost supported Nemotron model: classification, research-query planning, summarization, and routine checks.
- Stronger supported Nemotron model: impact analysis, documentation generation, difficult revision, and final review.

Exact model IDs are deployment configuration, not hard-coded architecture. Before promotion, live probes must verify tool calling, structured output where required, context limits, and response compatibility. A capability-compatible Token Factory model may serve as an internal fallback, but all invocations remain on Token Factory.

## Tavily research design

Every documentation workflow attempts Tavily research after internal repository/document retrieval and before impact analysis.

The research planner constructs bounded queries from:

- repository and package identity
- changed APIs or symbols
- dependency and SDK names
- release identifiers
- missing documentation concepts

The client limits result count, request duration, and total extracted content. It applies an authority policy that prefers official product documentation, specifications, standards, release notes, and primary repositories.

Tavily has four visible outcomes:

- `completed`: accepted external evidence is available.
- `empty`: the request succeeded but yielded no acceptable evidence.
- `degraded`: timeout, rate limit, authentication, or service failure exhausted the bounded retry policy.
- `rejected`: results were returned but failed authority, relevance, or safety checks.

Only `completed` results enter the grounding bundle. All other outcomes remain visible in the workflow trace and review UI. They do not fail the workflow; repository and existing-documentation evidence remain authoritative for project behavior.

Tavily content is untrusted input. It cannot issue instructions, broaden tool permissions, or override repository evidence. Prompt assembly labels it as external evidence and preserves source attribution.

## Failure handling

### Token Factory

- Retry timeouts, rate limits, and transient 5xx responses with capped exponential backoff and jitter.
- Try another configured Token Factory model only when it satisfies the required capabilities.
- If Token Factory options are exhausted, commit a retryable checkpoint and let the job fail with a classified error.
- Never switch to another provider silently.

### Tavily

- Use a small bounded retry budget.
- On exhaustion, persist `degraded` with the error class and continue.
- Never invent or substitute external citations.

### PostgreSQL

- Treat loss of canonical persistence as fatal to the current attempt.
- Do not advance graph state or perform delivery when a checkpoint cannot be committed.
- Rely on the execution lease and reconciler for safe recovery.

### Redis

- Continue canonical processing when possible.
- Mark live streaming and cache behavior degraded.
- Rehydrate the UI from persisted steps after recovery.

### Nebius Jobs

The reconciler maps Nebius outcomes as follows:

- Workload errors such as `StartFailed`, `ContainerFailed`, and `TimeoutExceeded` are retried only when their classified cause is transient and the run's retry budget remains.
- Infrastructure or capacity errors such as `NotEnoughResources` and internal `ERROR` outcomes use delayed retry and may select an approved alternate CPU preset in the same deployment region.
- Exhausted retries move the run to `failed` with an actionable error, last job ID, and manual retry capability.

### GitHub delivery

- Use a deterministic delivery idempotency key.
- Check persisted receipts and the target repository before creating a pull request.
- Persist branch and pull-request identifiers immediately after creation.
- A retry must resolve and reuse an existing delivery rather than create a duplicate.

## Kubernetes production design

### Workloads

- UI Deployment: minimum two replicas.
- API Deployment: minimum two replicas.
- Dispatcher Deployment: minimum two replicas with database-coordinated claims.
- Reconciler Deployment: minimum two replicas using PostgreSQL row claims with `FOR UPDATE SKIP LOCKED` so each active execution receipt is reconciled by one replica at a time.
- Migration Job: one execution per release before rollout.

### Availability and scaling

- Readiness and liveness probes on all long-running workloads.
- PodDisruptionBudgets for UI, API, dispatcher, and reconciler.
- Topology spread or anti-affinity across available worker nodes.
- Horizontal Pod Autoscaling for API and dispatcher.
- CPU-only node groups with cluster autoscaling.
- Rolling updates with zero maximum unavailable replicas for the API where cluster capacity permits.

### Networking

- Kubernetes worker nodes are private.
- A public load balancer exposes only the ingress path.
- PostgreSQL, Redis, Token Factory, Tavily, Clerk, GitHub, and Nebius APIs are explicit egress destinations.
- Kubernetes NetworkPolicies deny unrelated east-west and outbound traffic.
- SSE ingress settings support long-lived connections and reconnect semantics.

### Images

- Backend roles share one immutable image digest.
- Entrypoints select API, dispatcher, reconciler, migration, or workflow-job behavior.
- The frontend has a separate immutable image digest.
- Nebius Container Registry stores all promoted images.
- The Kubernetes node-group service account pulls same-project images without embedded registry credentials.

## Secrets and identity

SecretStash is the source of truth for:

- Token Factory credentials
- Tavily credentials
- database and Redis credentials
- GitHub App credentials
- Clerk credentials
- Nebius API credentials required by the dispatcher

Serverless Jobs use direct SecretStash environment-variable injection. For Kubernetes workloads, the deployment pipeline reads narrowly scoped secret versions from SecretStash and materializes namespaced Kubernetes Secrets. Secrets are not stored in Helm values, Terraform state input variables, container images, or Git history.

Separate identities and permissions are used for:

- Kubernetes node-group image pulls
- API runtime
- dispatcher job creation and cancellation
- reconciler job reads
- CI/CD deployment

GitHub delivery credentials are injected only into resume/delivery jobs. Start-phase jobs cannot receive GitHub mutation credentials.

## Observability

Every structured log, metric, workflow event, Tavily request, model invocation, and Nebius execution carries:

- `organization_id`
- `run_id`
- `step_id` where applicable
- `command_id` where applicable
- `nebius_job_id` where applicable
- `attempt`

### Metrics

- outbox backlog and oldest-command age
- dispatch attempts and failures
- Nebius provisioning latency
- job execution duration and outcome
- workflow retry count
- execution-lease conflicts and expirations
- Tavily outcome and degradation rate
- Token Factory latency, token use, and failure rate by model and role
- pending-review age
- delivery success and duplication-prevention events

### Logs

Kubernetes and Serverless Job workloads emit structured JSON to Nebius logging. By default, logs exclude raw prompts, model responses, retrieved secrets, tokens, and private repository contents. Evidence and drafts remain in the organization-scoped application stores.

### Alerts

- sustained outbox backlog
- repeated dispatch failures
- jobs stuck in provisioning or running beyond policy
- exhausted workflow retries
- elevated Token Factory failures
- PostgreSQL unavailability
- abnormal Tavily degradation rate
- runs stuck in delivery
- execution leases that cannot be reconciled

## Deployment and delivery

Infrastructure is managed with Terraform. Kubernetes resources are packaged with Helm.

The release pipeline:

1. Runs backend and frontend tests.
2. Performs dependency and secret-pattern scanning.
3. Builds backend and frontend images.
4. Scans the images.
5. Pushes immutable images to Nebius Container Registry.
6. Deploys the database migration Job to staging.
7. Deploys staging by image digest.
8. Runs smoke and end-to-end checks using real staging integrations.
9. Promotes the same image digests to production.
10. Verifies public health, readiness, webhook processing, SSE, dispatch, and job execution.

Rollback redeploys the prior known-good image digests. Database changes must be backward-compatible for at least one application version so the application can roll back independently.

## Testing strategy

### Unit tests

- Token Factory provider construction and request configuration
- provider gating that excludes all non-Token Factory providers
- role-to-model routing and capability checks
- Tavily query planning, normalization, authority filtering, and outcome states
- dispatch-state transitions
- retry classification and budgets
- outbox claims and lease acquisition
- delivery idempotency

### Contract tests

- Token Factory OpenAI-compatible request and response shapes
- Tavily request and normalized evidence shapes
- Nebius Jobs create, get, list, cancel, and lifecycle schemas
- SecretStash selector configuration
- GitHub delivery receipts

### Integration tests

- Atomic run and outbox creation
- Concurrent dispatcher claims
- Nebius receipt persistence
- lease conflict, heartbeat, expiry, and safe reclaim
- checkpoint and resume across separate processes
- Redis outage with PostgreSQL-backed recovery
- duplicate webhook, command, review, and delivery handling

### Staging tests

- Real Token Factory calls for every configured model role
- Real Tavily completed, empty, and forced degraded outcomes
- Real Serverless Job creation and reconciliation
- SecretStash injection into a workflow job
- Kubernetes ingress, authentication, health checks, and SSE reconnect
- Full GitHub documentation workflow through human approval and delivery

### Resilience and security tests

- terminate dispatcher and reconciler pods during active work
- expire an orphaned execution lease
- simulate Token Factory throttling and outage
- simulate Tavily timeout and authentication failure
- simulate Nebius capacity and container failures
- verify RBAC and NetworkPolicy restrictions
- verify secrets and private content do not appear in logs
- scan Git history, images, Terraform inputs, and manifests for credentials

## Rollout phases

1. **Provider and research foundation:** Token Factory provider, provider gate, Tavily client, evidence policy, and provenance.
2. **Durable execution foundation:** Outbox, receipts, leases, workflow entrypoint, and phase-aware credentials.
3. **Nebius orchestration:** Jobs client, dispatcher, reconciler, retry mapping, cancellation, and manual recovery.
4. **Managed Kubernetes infrastructure:** Network, cluster, node groups, registry, load balancing, identities, and SecretStash.
5. **Application deployment:** Helm packaging, autoscaling, probes, policies, migrations, and CI/CD.
6. **Product observability:** New states, job identifiers, Tavily outcomes, metrics, alerts, and recovery controls.
7. **Cutover and submission:** Public synthetic demo, real end-to-end run, judge access, documentation, and three-minute video.

## Acceptance criteria

- Every LLM invocation in the Nebius environment records `nebius_token_factory` as its provider.
- No non-Token Factory model provider is enabled in the Nebius environment.
- Every documentation workflow records a Tavily attempt and one visible Tavily outcome.
- Tavily degradation does not fail an otherwise grounded documentation workflow.
- No agent graph executes inside API, UI, dispatcher, or reconciler pods.
- Every start and resume phase has a persisted dispatch command and Nebius job receipt.
- A pending human review consumes no Serverless Job resources.
- Workflow recovery does not require Redis or container-local state.
- Duplicate events, retries, and approvals cannot create duplicate GitHub pull requests.
- The UI exposes provisioning, execution, review, retry, Tavily, and terminal states.
- The deployment is reproducible from Terraform, Helm, immutable image digests, and documented secret inputs.
- A real public demonstration completes from GitHub event through separate start and resume jobs to a delivered pull request.

## Hackathon evidence

The submission will explicitly identify the work added during the submission period:

- native Token Factory provider and Nemotron routing
- Tavily research in every documentation workflow
- Nebius Serverless Job execution and review resumption
- Managed Kubernetes production deployment
- job and model observability in the Draftly interface
- durable dispatch, execution receipts, and retry recovery

The demonstration video will show a real workflow trace containing the Token Factory model, Tavily outcome, Nebius job IDs, human checkpoint, separate resume job, and final GitHub pull request.

## References

- Nebius Token Factory quickstart: https://docs.tokenfactory.nebius.com/quickstart
- Nebius Serverless AI jobs: https://docs.nebius.com/serverless/jobs/manage
- Nebius Serverless AI lifecycle: https://docs.nebius.com/serverless/lifecycle
- Nebius Managed Kubernetes: https://docs.nebius.com/kubernetes/index
- Nebius Kubernetes registry integration: https://docs.nebius.com/kubernetes/workloads/images-container-registry
- Nebius Kubernetes load balancers: https://docs.nebius.com/kubernetes/clusters/load-balancer
- Nebius SecretStash: https://docs.nebius.com/mysterybox/overview
- Hackathon overview: https://nebiusglobalaihackathon.devpost.com/
- Hackathon rules: https://nebiusglobalaihackathon.devpost.com/rules
