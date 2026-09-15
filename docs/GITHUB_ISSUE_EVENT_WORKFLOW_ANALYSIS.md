# GitHub Issue Event Workflow Analysis

Complete analysis of the GitHub Issue event workflow across `draftly-agent-backend` and `draftly-agent-frontend`.

---

## Backend Architecture (`draftly-agent-backend`)

### 1. Ingestion Layer - Webhook Handling

**Live path**: `src/draftly/app/api/routes/github.py` → `POST /webhook` → `EventComposition.normalize_github` → `IssueProcessor` → `WorkflowRunner.run`

**Receiver**: the FastAPI route `github_webhook` (`routes/github.py:206`)
- Verifies the HMAC SHA-256 signature (`verify_webhook_signature`, `routes/github.py`)
- Reads `X-GitHub-Event` / `X-GitHub-Delivery`, parses the JSON body, handles `installation` inline, then calls `normalize_github(payload)` (`routes/github.py`).
- **No merged-gate for issues**: unlike PRs, issues have no merged filter. The route's merged-only gate is keyed on the event *prefix* `pull_request.*` (`routes/github.py:270`), so `issues.*` events pass straight through. Issue actions (opened/closed/reopened/updated) all proceed to the runner.

**Normalizer**: `EventComposition.normalize_github` (`app/composition/events.py:33`) routes by payload shape:
- `issue` **without** `pull_request` → `IssueProcessor` (`events/github/issue.py:11`)
- `pull_request` → `PullRequestProcessor` (shared GitHub surface; only `.merged` passes)
- `release` → `ReleaseProcessor`, `push` → `PushProcessor`
- plus `slack` / `discord` payload processors.

`IssueProcessor.support()` requires `payload["issue"]` and **no** `pull_request` key (`issue.py:49`) — so an "issue" payload that is actually a PR (GitHub sends the `issue` object inside `pull_request` payloads) is correctly excluded. `IssueProcessor.process()` returns a **`ProcessedEvent`** (`events/base.py:19`) with `event_type = "issues.<action>"` and an `issue` dict (`number`, `title`, `state`, `body`, `html_url`, `labels`, `action`) (`issue.py:34-46`).

**Supported issue events at the route**: `issues` (opened/closed/reopened/updated) and `issue_comment` are listed in the route docstring (`routes/github.py:215-216`). `issues.*` is natively dispatched; `issue_comment` is **documented intent only** — it has no processor branch in `normalize_github` and raises `ValueError` on arrival.

**Shared dispatch**: after normalization the route enqueues the event under the `github_pr.enqueue` task for **all** GitHub surfaces (PR, issue, release, push) — the task name is a misnomer, it is really a generic "GitHub webhook surface" enqueuer. The actual surface is resolved **inside the runner** from the normalized `event_type` (see §3). An `issues.*` event therefore routes to the **issue** surface graph, not the PR graph.

> **Legacy note**: `src/draftly/integrations/github/webhooks.py` (`GitHubWebhookHandler.parse`) carries its own `pull_request.merged` mapping but is orphaned/dead code — not on the live webhook path. The live issue path is the route → normalize → `IssueProcessor` flow above.

### 2. Event Normalization

| File | Component | Purpose |
|------|-----------|---------|
| `src/draftly/events/github/issue.py` | `IssueProcessor` | `issues.<action>` → normalized support-readable issue event |
| `src/draftly/events/base.py` | `BaseProcessor` / `ProcessedEvent` | Normalizer base + typed event envelope |
| `src/draftly/events/types.py` | `EventType` / `SURFACE_ISSUE` | Event-type registry; `issues` → `issue` surface |

`EventType.GITHUB_ISSUE = "issues"` (`types.py:17`). The `issue` surface constant is `SURFACE_ISSUE = "issue"` (`types.py:29`).

### 3. Event Dispatcher

**File**: `src/draftly/events/dispatcher.py` - `EventDispatcher`  
`SURFACE_BY_PREFIX` (`dispatcher.py:32`) maps event prefixes to graph surfaces:
```
issues            → issue surface      → issue graph
pull_request      → pull_request surface → documentation graph
release / push    → pull_request surface → documentation graph
slack / discord   → support surface    → support graph
```
`EventDispatcher.route(event)` (`dispatcher.py:56`) reads `event.event_type`, extracts the prefix via `event_prefix()` (`orchestration/routing/classifiers.py`), and returns the surface string. The `WorkflowRunner` calls `route()` (`workflows/runner.py:125`) to select the surface, then `_default_graph_factory` → `build_graph_for_run(run_id, surface, ...)` picks the issue graph via `_BUILDERS["issue"] = build_issue_graph` (`integrations/strands/graph.py:28`).

**Idempotency**: `WorkflowRunner.run` performs an atomic `try_claim` on the events table before touching the graph (`runner.py:141`), marking the event `completed`/`failed`/`pending_review` and detecting duplicates (`runner.py:373`). Issue events respect this shared claim; there is no separate issue claim.

### 4. Workflow Layer

**File**: `src/draftly/workflows/github/issue_resolution.py`  
**Function**: `run_github_issue_workflow()`  
Thin adapter: normalized `issues.*` event → `WorkflowRunner.run` → Issue Graph. Registered as `github_issue` in `app/composition/workflows.py:130`.

> **Note**: `process_issue_feedback()` (`workflows/github/issue_feedback.py:20`) records an issue as a feedback signal (topic/question/source=github_issue/state), but it is **defined and exported, not wired into the live issue-run path** — the live runner handles post-run memory itself. It is documented intent (plan §7.2), not invoked on the `github_issue` runtime path.

### 5. Strands Multi-Agent Graph - Core Intelligence

**File**: `src/draftly/orchestration/graphs/issue_graph.py` (`ISSUE_GRAPH_ID = "draftly-issue-graph"`, `build_issue_graph`)

#### Graph Structure:
```
classify → context → research(Swarm) → impact
  ├─(answer)─► answer ─┐
  ├─(update)─► update ─┤
  └─(create)─► create ─┴─► evaluate ─(passed)──► deliver
                                │▲
                                └─(needs_revision_of)─┘
```
Same backbone topology as the PR graph, but with issue-specific surface agents.

#### Nodes & Agents:

| Node | Agent Factory | Tools Used | Purpose |
|------|--------------|-----------|---------|
| `classify` | `build_classifier()` | None (pure reasoning) | Validates surface (`is_valid_surface` edge) |
| `context` | `build_context_agent()` | github_intelligence, semantic/keyword_search (+ optional `MemoryGroundedNode`) | Gathers issue + docs evidence bundle |
| `research` | `build_research_swarm()` (4 agents) | GitHub / Slack / Discord / Docs tools | Deep research across channels |
| `impact` | `build_issue_analyzer()` | github_intelligence, semantic_search | Analyzes the *issue* for a doc gap; routes to answer/update/create |
| `answer` | `build_answer_writer()` | semantic/keyword_search | Writes a direct issue answer/pointer |
| `update`/`create` | `build_writer_agent()` ×2 | documentation_engineer, documentation | Generates doc changes |
| `evaluate` | `EvaluatorNode` | Deterministic quality scoring | Validates grounding, completeness, citation coverage |
| `deliver` | `build_issue_responder()` | github_intelligence (incl. `create_comment`) | Posts the reply/comment on the issue |

The `classify` node's `is_valid_surface` condition (`issue_graph.py:116`) is the entry gate — the classifier confirms the event is a valid issue-surface before any work starts. Research is the shared 4-agent swarm (see §6) — issues reuse the same swarm as PRs, so the swarm's GitHub researcher can pull related PRs/code while the docs researcher checks the doc store.

### 6. Research Swarm (4 Specialized Agents)

Defined in `src/draftly/agents/subagents.py` (`build_research_swarm`) using agents from `src/draftly/agents/shared/research.py` — identically reused by the issue, support, and PR graphs:

| Agent | Tools | Focus |
|-------|-------|-------|
| `github_researcher` | GitHub intelligence tools | PRs, issues, diffs, code |
| `slack_researcher` | Slack search, get_thread | Slack conversation history |
| `discord_researcher` | Discord search, get_thread | Discord conversation history |
| `docs_researcher` | Semantic/keyword/hybrid search | Documentation store coverage |

Swarm config: `max_handoffs=20`, `max_iterations=20`, `execution_timeout=900.0`, `node_timeout=300.0`, entry point = github_researcher (`subagents.py:40-48`).

### 7. Tools Registry

From `issue_graph.py` tool groups (resolved via `ToolRegistry` in `app/composition/tools.py`):

**Issue context (agent)**: `github_intelligence` = `[get_pull_request, get_issue, get_diff, get_files, create_comment]`; `semantic_search`, `keyword_search`.

**Answer writer**: `semantic_search`, `keyword_search`.

**Doc gap writers (update/create)**: `documentation_engineer`, `documentation` (markdown/frontmatter/links/structure).

**Deliver (issue_responder)**: `github_intelligence` — notably includes `create_comment` for posting the final reply on the issue (`deliver` step). No PR-creation tools (issues respond in-thread, they do not open docs PRs).

**Search Tools** (shared): `semantic_search`, `keyword_search`, `hybrid_search`.

**Memory tools** (shared): `knowledge`, `search`, `curation`, `affected_docs`.

### 8. Memory & Feedback Systems

| File | Purpose |
|------|---------|
| `memory/service.py` | Persistent knowledge storage |
| `workflows/post_run/candidate_extractor.py` | `record_post_run_memory` — records episode + memory candidates after a completed issue run (`runner.py:208`) |
| `feedback/gap_detector.py` | Detects documentation gaps from reviews/signals |
| `feedback/knowledge_updater.py` | Updates knowledge base after doc merges |

### 9. Persistence Layer

**Directory**: `src/draftly/persistence/`

#### Repositories (`persistence/repositories/`) — shared with all surfaces:

| Repository | Purpose | Key Methods |
|------------|---------|-------------|
| `documents.py` - `DocumentRepository` | Documentation storage & retrieval | `create`, `find_by_repository`, `save`, `upsert`, `get_by_org_and_path`, `search`, `update`, `delete` |
| `github.py` | GitHub installations & workflows | `store_github_installation`, `list_github_installations`, `store_github_workflow`, `get_github_workflow_by_issue`, `update_github_workflow_status` |
| `memory.py` - `MemoryRepository` | Vector memory storage | Embedding-based retrieval, knowledge persistence |
| `reviews.py` - `ReviewsRepository` | Human review tracking | Review requests, decisions, comments |
| `evaluations.py` | Evaluation results storage | Scores, reasons, iteration tracking |
| `delivery.py` | Delivery receipts | Delivery records, status |
| `workflow_events.py` | Workflow event log | Event history, audit trail |
| `agent_runs.py` | Agent execution tracking | Run metadata, performance metrics |
| `support.py` | Support conversations | Slack/Discord thread persistence |
| `organizations.py` | Org configuration | GitHub/Slack/Discord org mappings |
| `routing.py` / `slack.py` / `discord.py` / `jobs.py` / `events.py` | Cross-cutting config & logging | Model routing, platform config, job/event stores |

#### Persistence Flow in Issue Workflow:

```
1. Event Ingestion
   └─► workflow_events.py: Store incoming webhook event

2. Workflow Execution
   ├─► agent_runs.py: Track each graph node execution
   ├─► evaluations.py: Store evaluation scores & reasons
   └─► reviews.py: Create review request on ReviewGate interrupt

3. Response Generation
   ├─► documents.py: Store any doc drafts (when issue → update/create)
   └─► delivery.py: Record delivery receipt (issue comment posted)

4. Post-Run Memory
   └─► post_run/candidate_extractor.py: Record episode + candidate gaps
```

### 10. Evaluation

- **`EvaluatorNode`** (`src/draftly/orchestration/nodes/evaluate.py`): Deterministic scoring
  - Citation coverage: 40%
  - Completeness: 30%
  - Length heuristic: 30%
  - Threshold: 0.70
  - Revision loop: `needs_revision_of("update"|"create")` edges, max 2 iterations (default `evaluator_max_iterations`)
- Evaluation packages (`src/draftly/evaluation/`): `runner.py`, `service.py`, `store.py`, `failure_analyzer.py`, `evaluators/`; CLI `scripts/run_evaluation.py`. The `issue` surface is a supported surface in `evaluation/online.py` for replay/eval.

### 11. Review Gate

- **`ReviewGate`** (`src/draftly/orchestration/hooks/review_gate.py`) - graph **hook provider** that owns human approval: interrupts execution, sets workflow status to `pending_review` (`runner.py:195`)
- **`review/service.py`**, **`review/queue.py`**: review queue management
- **`persistence/repositories/reviews.py`**: persists review requests, decisions, comments
- The issue graph's `deliver` node (`issue_responder`) is built without the HITL intervention because `ReviewGate` owns approval via the interrupt mechanism (`issue_graph.py` wires `[ReviewGate()]`).

---

## Frontend Architecture (`draftly-agent-frontend`)

There is **no dedicated GitHub issue list/detail page**. Issue-triggered runs surface through the generic **Workflows** list/detail, the **Reviews** queue, **Agents** (which name the `issue_analyzer`/`issue_responder` roles), and the integrations pages.

### 1. Integrations Page

**Route**: `app/(app)/integrations/page.tsx`  
**Component**: `Integrations()` in `components/integrations/integrations.tsx`
- Shows connected systems: GitHub, Slack, Discord; the GitHub row reads "sync pull requests, **issues**, and CI status".

**GitHub integration detail**: `app/(app)/integrations/github/page.tsx` → `components/integrations/github-detail-content.tsx` — connection health, connected orgs/repos table, repository chips, "Install GitHub App"/"+ Add More"/disconnect. Copy: "generate documentation from **issues** and pull requests." `api/github.ts` handles `/github/install-url`, `/github/installations`, `/github/link`.

### 2. Workflows Dashboard

**Route**: `app/(app)/workflows/page.tsx`  
**Component**: `Workflows()` in `components/workflows/workflows.tsx`
- Runs list w/ status tabs, search, live refresh. Backend `WorkflowListItem` → `WorkflowRow`.
- `components/workflows/data.ts`: `triggerIcons` define **commit** (GitBranch), **chat** (MessageSquare), **support** (Headphones). Note: `workflows.tsx` currently hardcodes the PR/commit trigger icon on rows, so issue runs are differentiated by the `triggerLabel` text and status rather than a distinct icon today.

`app/(app)/workflows/[id]/page.tsx` → `components/workflows/workflow-detail.tsx` renders a live run for any surface (issue included) via the shared `useWorkflowEvents` SSE hook: `ExecutionGraph` (live "Classify→Context→Research→Impact→Answer→Update→Create→Evaluate→Deliver" pipeline), `ActiveExecution` ("Active Agent" banner + tool progress), `ArtifactsPanel` (Draft Updates / Execution Plan / Research Report), `EventLog`, `EvidenceCollected`, `EvaluationCriteria`, `WorkflowSummary`.

### 3. Agents Visualization

**Route**: `app/(app)/agents/page.tsx`  
`components/agents/agent-icons.tsx` keys icons by agent role, including **`issue_analyzer`** (FileSearch) and **`issue_responder`** (GitBranch) — the two issue-specific graph agents. Agent Detail exposes "Surface: …" and live steps via `useWorkflowEvents`.

### 4. Dashboard

**Route**: `app/(app)/dashboard/page.tsx`  
- Real-time SSE monitoring (`components/dashboard/dashboard-events-listener.tsx` → `useDashboardEvents`), listens for `review_created`, `review_decided`, `job_started`, `job_completed`, `run_completed`.
- `components/dashboard/recent-signals.tsx` branches on run source: `run.source === "slack" | "discord"` gets an `Inbox` icon (support); GitHub-sourced runs get `GitBranch`.

### 5. Review & Evaluation Pages (shared across surfaces)

Issue-graph runs that hit the ReviewGate interrupt land in the human review queue:

| Route | Component(s) | Purpose |
|-------|-------------|---------|
| `app/(app)/reviews/page.tsx` | `components/reviews/reviews.tsx` | Review queue, lists pending human approvals |
| `app/(app)/reviews/[id]/page.tsx` | `review-detail.tsx`, `review-detail-content.tsx` (diff add/remove analysis), `review-detail-sidebar.tsx`, `review-counter-cards.tsx` | Diff/review detail for human approval; reads `review.workflow`, `review.pr.trigger_label`, `issue_number` |
| `app/(app)/evaluations/page.tsx` + `evaluations/[id]/page.tsx` | `components/evaluations/` | Evaluation scores, filters, detail |
| `app/(app)/knowledge/…` / `documentation/…` | `components/knowledge/`, `components/documentation/` | Knowledge base & doc store search/detail |

### 6. Event Streaming Infrastructure

- **`hooks/use-workflow-events.ts`** — core SSE hook: `POST /api/workflows/{run_id}/stream-ticket` → `EventSource('/api/workflows/{run_id}/events?ticket=…')`; parses `node_start/stop`, `handoff`, `text_delta`, `tool_progress`, `stage_change`, `stage_manifest`, `stage_progress`, `overall_progress`, `workflow_result`. Used by workflow detail, agents, and streaming.
- **`components/live-events/live-events-provider.tsx`** + **`hooks/use-dashboard-events.ts`** — tenant-wide dashboard SSE over `/api/workflows/events/dashboard`.
- **`hooks/use-live-refresh.ts`** — SWR polling + SSE-event-driven refetch fallback.

---

## Complete GitHub Issue Flow (End-to-End)

```
GitHub Issue #123 OPENED/UPDATED
       │
       ▼
POST /webhook (routes/github.py: verify_signature → parse → normalize)
       │
       ▼
[gate] is event pull_request.* and NOT *.merged? → NO (issues pass through)
       │
       ▼
IssueProcessor → normalized "issues.<action>" ProcessedEvent
       │
       ▼
enqueue "github_pr.enqueue" (RQ or in-process BackgroundTask)
       │
       ▼
WorkflowRunner.run(event) → EventDispatcher.route → surface = "issue"
       │
       ▼
idempotency try_claim (events table) → build_issue_graph (issue surface)
       │
       ├─► classify (EventClassifier → is_valid_surface)
       ├─► context (ContextAgent + MemoryGroundedNode)
       ├─► research (ResearchSwarm: 4 agents)
       ├─► impact (IssueAnalyzer → routes to answer/update/create)
       ├─► answer/update/create (SupportWriter or WriterAgent ×2)
       │     └─► evaluate (EvaluatorNode: citation 40 / completeness 30 / length 30)
       │           ├─► PASS → ReviewGate (human approval interrupt) → deliver
       │           └─► FAIL → revise loop (max 2 iterations)
       ├─► deliver (IssueResponder → create_comment on the issue)
       │
       ▼
Reply comment posted on the GitHub issue
       │
       ▼
runner outcome: mark completed → record_post_run_memory (episode + candidates)
       │
       ▼
(optional) issue-derived doc gap → update/create writes → future doc change/PR
```

### Persistence Checkpoints in Flow

| Step | Repository | Data Persisted |
|------|------------|----------------|
| Webhook received | `workflow_events.py` | Raw event + metadata |
| Workflow claim (idempotency) | `workflow_events.py` | Atomic `try_claim`; status `completed`/`failed`/`pending_review`, duplicate detection |
| Workflow started | `agent_runs.py` | Run ID, status, input |
| Each graph node | `agent_runs.py` | Node execution, duration, output |
| Evaluation | `evaluations.py` | Score, reasons, iteration |
| Review requested | `reviews.py` | ReviewRequest with diff, evidence |
| Doc drafted (if gap) | `documents.py` | Draft content, commit_sha, source_hash |
| Delivery | `delivery.py` | Issue-comment reply receipt, status |
| Post-run memory | `memory/*` / `post_run/candidate_extractor.py` | Episode + candidate gaps |

---

## Key Integrations

| System | Backend Integration | Frontend Display |
|--------|---------------------|------------------|
| **GitHub** | Webhook route → `IssueProcessor`; `github_intelligence` tools incl. `create_comment`; `IssueProcessor`/`issue_responder` agents | Integrations page + GitHub detail (issues copy), Workflows table (issue runs), Reviews queue/detail |
| **Slack** | Shared research swarm slack researcher; optional slack search in context | Integrations page + Slack detail ("support threads") |
| **Discord** | Shared research swarm discord researcher | Integrations page + Discord detail (trigger channels) |
| **Memory** | Vector store, knowledge graph, `MemoryGroundedNode` | Knowledge page, agent memory grounding |
| **Persistence** | CockroachDB/PostgreSQL (JSONB), DocumentStore, repositories | Workflow history + detail graph, Evaluation audit trail, Reviews queue |

---

## Features Used

1. **Event-Driven Architecture** - Redis streams for event bus (`_TeePublisher`, `RedisStreamBus`)
2. **Strands Multi-Agent Graphs** - Orchestrated agent workflows (`issue_graph`)
3. **Human-in-the-Loop (HITL)** - ReviewGate (graph hook) for approval; `deliver` (`issue_responder`) runs without its own HITL since ReviewGate owns approval
4. **Deterministic Evaluation** - Quality gates before human review (`EvaluatorNode`)
5. **Revision Loops** - Automatic retry on evaluation failure (max 2 iterations)
6. **Multi-Source Research** - Shared 4-agent swarm (GitHub, Slack, Discord, Docs)
7. **Persistent Memory** - Knowledge base updated after each completed run
8. **Real-time Dashboard** - SSE-based workflow monitoring (`useWorkflowEvents` + dashboard SSE, SWR polling fallback)
9. **Structured Output** - Pydantic models (`ImpactAnalysis`, `AnswerDraft`, `DeliveryReceipt`) for all agent outputs
10. **Full Persistence Coverage** - Events, agents, evaluations, reviews, documents, delivery, memory
11. **Audit Trail** - `workflow_events.py` + `agent_runs.py` + `RunAuditLogger`
12. **Document Versioning** - `documents.py` tracks commit_sha, source_hash, status transitions
13. **Idempotent Processing** - atomic `try_claim` on the events table; duplicate detection
14. **Surface Routing (issue)** - `issues.*` → `issue` surface via `SURFACE_BY_PREFIX`, resolved inside the runner by `event_type` prefix; issue delivery replies in-thread (no docs PR creation)
