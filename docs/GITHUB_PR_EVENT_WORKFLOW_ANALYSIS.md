# GitHub PR Event Workflow Analysis

Complete analysis of the GitHub Pull Request event workflow across `draftly-agent-backend` and `draftly-agent-frontend`.

---

## Backend Architecture (`draftly-agent-backend`)

### 1. Ingestion Layer - Webhook Handling

**Live path**: `src/draftly/app/api/routes/github.py` → `POST /webhook` → `EventComposition.normalize_github` → `PullRequestProcessor` → `WorkflowRunner.run`

**Receiver**: the FastAPI route `github_webhook` (`routes/github.py:194`)
- Verifies the HMAC SHA-256 signature (`verify_webhook_signature`, `routes/github.py`)
- Reads `X-GitHub-Event` / `X-GitHub-Delivery`, parses the JSON body, handles `installation` inline, then calls `normalize_github(payload)` (`routes/github.py`).
- **Route-level PR gate**: `pull_request.*` events whose normalized `event_type` ends in `.merged` or `.opened` are enqueued to the runner; all other PR actions (edited/closed-not-merged/synchronize) are dropped at the edge and return `"skipped, not merged/opened"` (`routes/github.py`). Defense-in-depth — the runner gate is authoritative.

**Normalizer**: `EventComposition.normalize_github` (`app/composition/events.py:33`) routes by payload shape:
- `pull_request` → `PullRequestProcessor` (`events/github/pull_request.py`)
- `issue` (without `pull_request`) → `IssueProcessor`
- `release` → `ReleaseProcessor`
- `push` → `PushProcessor`
- plus `slack` / `discord` payload processors.

`PullRequestProcessor.process()` returns a **`ProcessedEvent`** (`events/base.py:19`), not `GitHubPullRequestEvent`. If `action == "closed"` and `pull_request.merged` is truthy, it emits `pull_request.merged`; otherwise `pull_request.{action}` (`pull_request.py`).

**Supported events at the route**: `installation` (created/deleted — special-cased inline), `issues`, `pull_request` (opened/closed/merged/updated), `release`, and `push`. Natively dispatched: `pull_request`, `issues`, `release`, and `push`. Other GitHub event types are rejected with `422` until a dedicated normalizer and workflow are registered. Note: **only merged and opened PRs proceed past the PR gate**; other PR actions are skipped.

**Not handled (documented intent only)**: `synchronize`/`synchronized`, `review_requested`, `pull_request_review`, and `issue_comment` are referenced in the route docstring but are **not dispatched by `normalize_github`** and have no processor branch — `normalize_github` raises `ValueError` on unhandled payloads. The processor does not emit `pull_request.synchronize` even though the state model (`orchestration/state/documentation.py`) and tests reference it.

> **Legacy note**: `src/draftly/integrations/github/webhooks.py` (`GitHubWebhookHandler.parse`) exists and contains its own `pull_request.merged` mapping (`webhooks.py:103-107`), but it is **orphaned/dead code** — not referenced anywhere in `src/` and not on the live webhook path. It is kept for reference only; the live flow is the route → normalize → processor path above.

### 2. Event Normalization

| File | Component | Purpose |
|------|-----------|---------|
| `src/draftly/events/github/pull_request.py` | `PullRequestProcessor` | Processes PR-specific events |
| `src/draftly/events/github/events.py` | `GitHubPullRequestEvent` | Domain event model |
| `src/draftly/events/envelope.py` | `EventEnvelope` | Wraps events with correlation IDs |
| `src/draftly/events/types.py` | `EventType` | Event types registry |

### 3. Event Dispatcher

**File**: `src/draftly/events/dispatcher.py` - `EventDispatcher`  
Routes events to appropriate workflows via registry (`SURFACE_BY_PREFIX`):
```
pull_request      → pull_request surface → github_pr_workflow
release           → pull_request surface → github_release_workflow
push              → pull_request surface → github_pr_workflow
issues            → issue surface        → github_issue_workflow
slack             → support surface      → slack_support_workflow
discord           → support surface      → discord_support_workflow
```

Note: **push and release events also route to the `pull_request` surface**, so branch pushes and releases trigger the same documentation review graph as PR events. Releases now dispatch through the dedicated `github_release.enqueue` task; pushes remain on `github_pr.enqueue`. The full workflow registry (`src/draftly/app/composition/workflows.py`) includes: `github_pr`, `github_release`, `github_issue`, `slack_support`, `discord_support`, `documentation_sync`, `documentation_audit`, `feedback_loop`, `evaluation_loop`, `onboarding_initialize`, `memory_curation`, `memory_maintenance`.

**Related events in the pipeline** (`src/draftly/events/types.py`):
- `DOCUMENTATION_CHANGED` (`documentation.changed`) - `DocumentChangedProcessor` in `events/documentation/document_changed.py` (fed from sync jobs/repo webhooks, not the GitHub webhook path)
- `DOCUMENTATION_PUBLISHED` (`documentation.published`) - `events/documentation/publish_completed.py`
- `REVIEW_COMPLETED` (`review.completed`) - `events/documentation/review_completed.py`
- `pull_request.merged` - emitted when a PR is closed with `merged=true`; **merged and opened PR events run the documentation graph** — other non-merged/non-opened `pull_request.*` actions are skipped by the route edge gate and the runner gate (see §1). Routed through the PR surface.
- `PushProcessor` - handles branch pushes via `normalize_github` (routes to PR surface)

**Idempotency**: `WorkflowRunner` performs an atomic `try_claim` on the events table before running, marking events `pending_review`/`completed`/`failed` and detecting duplicate submissions. The PR gate runs **before** `try_claim`, so skipped (non-merged/non-opened) PR events leave no idempotency/audit/duplicate record.

### 4. Workflow Layer

**File**: `src/draftly/workflows/documentation/github_pr_workflow.py`  
**Function**: `run_pull_request_workflow()`  
Thin adapter: normalized PR event → `WorkflowRunner` → Documentation Graph

### 5. Strands Multi-Agent Graph - Core Intelligence

**File**: `src/draftly/orchestration/graphs/documentation_graph.py`

#### Graph Structure:
```
classify → context → research(Swarm) → impact
  ├─(answer)─► answer ─┐
  ├─(update)─► update ─┤
  └─(create)─► create ─┴─► evaluate ─(passed)──► deliver
                                │▲
                                └─(needs_revision_of)─┘
```

#### Nodes & Agents:

| Node | Agent Factory | Tools Used | Purpose |
|------|--------------|-----------|---------|
| `classify` | `build_classifier()` | None (pure reasoning) | Classifies event by surface/impact |
| `context` | `build_context_agent()` | GitHub intelligence, semantic/keyword/hybrid search, Slack/Discord search | Gathers evidence bundle |
| `research` | `build_research_swarm()` (4 agents) | GitHub tools, Slack tools, Discord tools, Doc search tools | Deep research across channels |
| `impact` | `build_impact_agent()` | Semantic/keyword/hybrid search, documentation tools | Analyzes doc impact, routes to answer/update/create |
| `answer`/`update`/`create` | `build_writer_agent()` (2 instances) | Documentation engineer tools, documentation tools | Generates doc changes |
| `evaluate` | `EvaluatorNode` | Deterministic quality scoring | Validates grounding, completeness, citation coverage |
| `deliver` | `build_delivery_agent()` | GitHub delivery tools, Slack/Discord post tools | Creates PR, posts messages |

### 6. Research Swarm (4 Specialized Agents)

Defined in `src/draftly/agents/subagents.py` using agents from `src/draftly/agents/shared/research.py`:

| Agent | Tools | Focus |
|-------|-------|-------|
| `github_researcher` | GitHub intelligence tools | PRs, issues, diffs, code |
| `slack_researcher` | Slack search, get_thread | Slack conversation history |
| `discord_researcher` | Discord search, get_thread | Discord conversation history |
| `docs_researcher` | Semantic/keyword/hybrid search | Documentation store coverage |

### 7. Tools Registry

From `documentation_graph.py` tool groups:

**GitHub Tools**:
- `get_pull_request`, `get_diff`, `get_files`
- `create_branch`, `create_commit`, `create_pull_request`
- `create_comment`, `get_issue`

**Search Tools**:
- `semantic_search`, `keyword_search`, `hybrid_search`

**Slack Tools**:
- `search_messages`, `get_thread`, `post_message`

**Discord Tools**:
- `search_messages`, `get_thread`, `post_message`

**Documentation Tools**:
- `markdown`, `frontmatter`, `links`, `structure`

**Memory Tools**:
- `knowledge`, `search`, `curation`, `affected_docs`

### 8. Memory & Feedback Systems

| File | Purpose |
|------|---------|
| `memory/service.py` | Persistent knowledge storage |
| `feedback/service.py` | Captures PR review comments as feedback |
| `feedback/gap_detector.py` | Detects documentation gaps from reviews |
| `feedback/knowledge_updater.py` | Updates knowledge base after doc merges |

### 9. Persistence Layer

**Directory**: `src/draftly/persistence/`

#### Repositories (`persistence/repositories/`):

| Repository | Purpose | Key Methods |
|------------|---------|-------------|
| `documents.py` - `DocumentRepository` | Documentation storage & retrieval | `create`, `find_by_repository`, `save`, `upsert`, `get_by_org_and_path`, `search`, `update`, `delete` |
| `github.py` | GitHub installations & workflows | `store_github_installation`, `list_github_installations`, `store_github_workflow`, `get_github_workflow_by_issue`, `update_github_workflow_status` |
| `memory.py` - `MemoryRepository` | Vector memory storage | Embedding-based retrieval, knowledge persistence |
| `reviews.py` - `ReviewsRepository` | Human review tracking | Review requests, decisions, comments |
| `evaluations.py` | Evaluation results storage | Scores, reasons, iteration tracking |
| `delivery.py` | Delivery receipts | PR creation records, delivery status |
| `workflow_events.py` | Workflow event log | Event history, audit trail |
| `agent_runs.py` | Agent execution tracking | Run metadata, performance metrics |
| `support.py` | Support conversations | Slack/Discord thread persistence |
| `organizations.py` | Org configuration | GitHub/Slack/Discord org mappings |
| `repository_config.py` | Repository settings | Documentation paths, sync config |
| `routing.py` - `RoutingRepository` / `PerformanceRepository` | Model routing & performance | Provider selection, latency tracking |
| `slack.py` / `discord.py` | Platform-specific data | Installation configs, channel mappings |
| `onboarding.py` | Onboarding state | Progress tracking, stage completion |
| `reviewers.py` | Reviewer assignments | User-role mappings, notification prefs |
| `jobs.py` | Background job tracking | Job status, scheduling, retries |
| `events.py` | Generic event storage | Event sourcing, replay capability |

#### Stores (`persistence/stores/`):
- `routing.py` - Routing performance data store
- Uses `DocumentStore` from `integrations/database/document_store.py` (CockroachDB/PostgreSQL with JSONB)

#### Migrations (`persistence/migrations/`):
- Schema versioning for CockroachDB

#### Persistence Flow in PR Workflow:

```
1. Event Ingestion
   └─► workflow_events.py: Store incoming webhook event

2. Workflow Execution
   ├─► agent_runs.py: Track each graph node execution
   ├─► evaluations.py: Store evaluation scores & reasons
   └─► reviews.py: Create review request on ReviewGate interrupt

3. Documentation Generation
   ├─► documents.py: Store generated doc changes (upsert with commit_sha, source_hash)
   └─► delivery.py: Record delivery receipt (PR URL, status)

4. Post-Merge
   ├─► documents.py: Update document status to 'published'
   ├─► memory.py: Update knowledge base embeddings
   └─► feedback/gap_detector.py → memory.py: Store detected gaps as structured knowledge

5. Internal Events (documentation lifecycle)
   ├─► documentation.changed / documentation.published: DocumentChangedProcessor / PublishCompletedProcessor
   └─► review.completed: ReviewCompletedProcessor

6. Feedback Loop
   ├─► feedback/service.py: Persist PR review comments
   └─► knowledge_updater.py: Update memory with resolved gaps
```

### 10. Evaluation

- **`EvaluatorNode`** (`src/draftly/orchestration/nodes/evaluate.py`): Deterministic scoring
  - Citation coverage: 40%
  - Completeness: 30%
  - Length heuristic: 30%
  - Threshold: 0.70
  - Revision loop: `needs_revision_of("update"|"create")` edges, max 2 iterations

- **Evaluation packages** (`src/draftly/evaluation/`): `runner.py`, `service.py`, `store.py`, `failure_analyzer.py`, `evaluators/`
- **Failure Analyzer**: For revision loops on evaluation failure
- **CLI**: `scripts/run_evaluation.py`

### 11. Review Gate

- **`ReviewGate`** (`src/draftly/orchestration/hooks/review_gate.py`) - graph **hook provider** that owns human approval: interrupts execution, sets workflow status to `pending_review`
- **`review/service.py`**: `ReviewService` - review queue management
- **`review/queue.py`**: `ReviewQueue` - review request queuing
- **`persistence/repositories/reviews.py`**: `ReviewsRepository` - persists review requests, decisions, comments
- **Note**: The graph's `deliver` agent is built with `hitl=False` because `ReviewGate` owns approval via the interrupt mechanism

---

## Frontend Architecture (`draftly-agent-frontend`)

### 1. Integrations Page

**Route**: `app/(app)/integrations/page.tsx`  
**Component**: `Integrations()` in `components/integrations/integrations.tsx`

**Features**:
- Shows connected systems: GitHub, Slack, Discord
- Displays repository counts, connection status
- API calls: `listInstallations()` (GitHub), `listSlackInstallations()`, `getDiscordStatus()`

### 2. Workflows Dashboard

**Route**: `app/(app)/workflows/page.tsx`  
**Component**: `Workflows()` in `components/workflows/workflows.tsx`

**Data** (`components/workflows/data.ts`):
- Trigger types: commit (GitBranch), chat (MessageSquare), support (Headphones)
- Stages: Planner → Researcher → Writer → Fact Checker → Reviewer
- Statuses: running, waiting, failed, queued, completed

### 3. Agents Visualization

**Route**: `app/(app)/agents/page.tsx`  
**Data**: `components/agents/data.tsx`

**6 Specialized Agents** (matching backend):

| Agent | Capabilities | Tools |
|-------|-------------|-------|
| **Planner** | Task Planning, Priority Scoring, Dependency Mapping, Workflow Routing | GitHub API, Jira API |
| **Researcher** | Source Discovery, Repository Search, Documentation Search, Conversation Search, Evidence Collection, Source Ranking | GitHub Search, Slack Search, Knowledge Search |
| **Writer** | Prose Generation, Code Examples, Formatting, Tone Matching | Template Engine, Style Guide, Code Formatter |
| **Fact Checker** | Claim Extraction, Source Verification, Confidence Scoring, Cross-Validation | Evidence Store, API Validator, Link Checker |
| **Reviewer** | Approval Routing, Change Detection, Risk Assessment, Notification | GitHub Review, Slack Notify, Email Notify |
| **Publisher** | PR Creation, Branch Management, CI Trigger, Rollback | GitHub API, CI/CD, Deploy Preview |

### 4. Dashboard

**Route**: `app/(app)/dashboard/page.tsx`  
**Components**:
- `ActiveWorkflows`, `AgentActivity`, `QualityGates`
- `NeedsAttention`, `DocumentationHealth`
- `RecentSignals`, `RecentDocumentationChanges` (in `components/dashboard/documentation-changes.tsx`)
- Also rendered but not listed in the earlier summary: `SystemPulse`, `SystemActivity`
- Real-time monitoring via SSE (`components/dashboard/dashboard-events-listener.tsx` → `DashboardEventsListener`, using the `useDashboardEvents` hook from `hooks/use-dashboard-events.ts` — opens an `EventSource`, with SWR polling fallback). Wired into the app shell at `app/(app)/layout.tsx`; listens for `review_created`, `review_decided`, `job_started`, `job_completed`, `run_completed`.

### 5. PR Review & Support Pages (workflow frontend surface)

These are the most PR-specific UIs and are part of the GitHub PR workflow surface:

| Route | Component(s) | Purpose |
|-------|-------------|---------|
| `app/(app)/reviews/page.tsx` | `components/reviews/reviews.tsx` | Review queue (`sourceType: "pr"`), lists pending human approvals |
| `app/(app)/reviews/[id]/page.tsx` | `review-detail.tsx`, `review-queue-list.tsx`, `review-detail-content.tsx` (diff add/remove line analysis), `review-detail-sidebar.tsx`, `review-counter-cards.tsx` | PR/diff review detail for human approval |
| `app/(app)/reviewers/page.tsx` | `components/reviewers/` (`reviewers.tsx`, `members-table.tsx`, `role-definitions.tsx`) | Reviewer/member role assignments |
| `app/(app)/evaluations/page.tsx` + `evaluations/[id]/page.tsx` | `components/evaluations/` | Evaluation scores, filters, detail |
| `app/(app)/knowledge/page.tsx` + `knowledge/[id]/page.tsx` | `components/knowledge/` | Knowledge base search & detail |
| `app/(app)/documentation/page.tsx` + `documentation/[slug]/page.tsx` | `components/documentation/` | Doc list, filters, sidebar, detail/article |
| `app/(app)/workflows/[id]/page.tsx` | `components/workflows/workflow-detail.tsx` (+ `stage-pipeline.tsx`, `event-log.tsx`, `execution-graph.tsx`, `active-execution.tsx`, `artifacts-panel.tsx`, `evidence-collected.tsx`, `evaluation-criteria.tsx`) | Per-workflow detail, execution graph, evidence |

### 6. Integrations Sub-pages

`app/(app)/integrations/{slack,github,discord}/page.tsx` → `components/integrations/` (`slack-detail-content.tsx`, `github-detail-content.tsx`, `discord-detail-content.tsx`, `connection-detail.tsx`, `active-connections.tsx`, `available-integrations.tsx`, `integration-summary.tsx`)

---

## Complete GitHub PR Flow (End-to-End)

```
GitHub PR #101 MERGED
       │
       ▼
POST /webhooks/github (routes/github.py: verify_signature → parse → normalize)
       │
       ▼
[gate] is event pull_request.* and NOT *.merged? → skip (neither PR nor post-merge work)
       │ (merged only passes)
       ▼
ProcessedEvent (normalized with event_id, event_type, correlation_id)
       │
       ▼
EventDispatcher → workflows registry → github_pr_workflow
       │
       ▼
WorkflowRunner → Documentation Graph (Strands GraphBuilder)
       │
       ├─► classify (EventClassifier) 
       ├─► context (ContextAgent + MemoryGroundedNode)
       ├─► research (ResearchSwarm: 4 agents)
       ├─► impact (ImpactAnalyzer → routes to answer/update/create)
       ├─► generate (WriterAgent × 2 instances)
        ├─► evaluate (EvaluatorNode - deterministic scoring + evaluation package)
       │     ├─► PASS → deliver
       │     └─► FAIL → revise loop (max 2 iterations)
       ├─► ReviewGate (human approval interrupt)
       └─► deliver (DeliveryAgent → GitHub PR creation)
             │
             ▼
       Documentation PR created in target repo
              │
              ▼
       PR merged → documentation.changed / documentation.published event → Knowledge Updater
              │
              ▼
       Feedback System captures PR review comments as gaps
              │
              ▼
       review.completed event → ReviewCompletedProcessor
```

Branch pushes (`push`) and `release` events also enter at the top. Because the PR gate is keyed on the **event prefix** (`pull_request.*`) rather than the shared `pull_request` surface, **push and release events are not affected** — pushes flow through `github_pr_workflow`, while releases flow through `github_release_workflow`.

### Persistence Checkpoints in Flow

| Step | Repository | Data Persisted |
|------|------------|----------------|
| Webhook received | `workflow_events.py` | Raw event + metadata |
| Workflow claim (idempotency) | `workflow_events.py` | Atomic `try_claim`, status `pending_review`/`completed`/`failed`, duplicate detection |
| Workflow started | `agent_runs.py` | Run ID, status, input |
| Each graph node | `agent_runs.py` | Node execution, duration, output |
| Evaluation | `evaluations.py` | Score, reasons, iteration |
| Review requested | `reviews.py` | ReviewRequest with diff, evidence |
| Doc generated | `documents.py` | Draft content, commit_sha, source_hash |
| Delivery | `delivery.py` | PR URL, branch, status |
| PR merged | `documents.py` | Status='published', last_committed_at |
| Knowledge update | `memory.py` | Embeddings, resolved gaps |
| Feedback captured | `feedback/service.py` | Review comments → structured gaps |
| Doc lifecycle events | `events/*` | `documentation.changed`, `documentation.published`, `review.completed` processors |

---

## Key Integrations

| System | Backend Integration | Frontend Display |
|--------|---------------------|------------------|
| **GitHub** | Webhook handler, PR tools, delivery tools | Integrations page (repo count + detail), Workflows table (PR trigger), Reviews queue/detail (PR review UI) |
| **Slack** | Slack search, post message tools | Integrations page + detail, Slack researcher agent |
| **Discord** | Discord search, post message tools | Integrations page + detail, Discord researcher agent |
| **Memory** | Vector store, knowledge graph | Knowledge page (search, stats, detail), agent memory grounding |
| **Persistence** | CockroachDB/PostgreSQL (JSONB), DocumentStore, 18 repositories | Workflow history + detail graph, Document versions, Evaluation audit trail, Reviews queue |

---

## Features Used

1. **Event-Driven Architecture** - Redis streams for event bus
2. **Strands Multi-Agent Graphs** - Orchestrated agent workflows
3. **Human-in-the-Loop (HITL)** - ReviewGate (graph hook) for approval; `deliver` agent runs `hitl=False` since ReviewGate owns approval
4. **Deterministic Evaluation** - Quality gates before human review
5. **Revision Loops** - Automatic retry on evaluation failure (max 2 iterations)
6. **Multi-Source Research** - GitHub, Slack, Discord, Docs
7. **Persistent Memory** - Knowledge base updated after each cycle
8. **Feedback Intelligence** - PR review comments → documentation gaps
9. **Real-time Dashboard** - SSE-based workflow monitoring (with SWR polling fallback)
10. **Structured Output** - Pydantic models for all agent outputs
11. **Full Persistence Coverage** - 18 repositories covering events, agents, evaluations, reviews, documents, delivery, memory, feedback
12. **Audit Trail** - Complete workflow event log with `workflow_events.py` and `agent_runs.py`
13. **Document Versioning** - `documents.py` tracks commit_sha, source_hash, status transitions
14. **Evaluation History** - `evaluations.py` stores scores, reasons, iterations for regression detection
15. **Idempotent Processing** - atomic `try_claim` on the events table; duplicate detection; `pending_review`/`completed`/`failed` status
16. **Internal Documentation Events** - `documentation.changed`, `documentation.published`, `review.completed` drive knowledge updates and feedback loops
17. **Multi-Surface Routing / Merged-Or-Opened PRs** - push, release, and PR events all route through the `pull_request` surface, but only **merged or opened** PR events are admitted by the PR gate; pushes and releases use their dedicated webhook tasks and are not filtered by the PR-only gate
