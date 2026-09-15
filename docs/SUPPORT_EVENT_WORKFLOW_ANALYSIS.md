# Support Event Workflow Analysis

> **Note:** This analysis has been updated for Tasks 7–9 of the
> `2026-09-06-slack-discord-wiring` plan. Key additions since the original:
> durable worker dispatch (RQ/webhooks queue), organization-scoped enrichment,
> explicit delivery routing (Slack/Discord/GitHub for doc gaps), shared
> review-resume, `SupportDeliveryReceipt` persistence with duplicate
> suppression, GitHub-only delivery isolation, and end-to-end integration tests.

Complete analysis of the Support event workflow (Slack & Discord) across `draftly-agent-backend` and `draftly-agent-frontend`.

---

## Backend Architecture (`draftly-agent-backend`)

### 1. Ingestion Layer - Webhook Handling

Support has **two** entry points (Slack and Discord), both feeding the same shared `WorkflowRunner` → Support Graph (`support` surface).

**Slack path**: `src/draftly/integrations/slack/app.py` → Bolt `AsyncApp` handlers (`app_mention` / `message`) → `_dispatch_message` → `EventComposition.normalize_slack` → `SlackProcessor` → `enrich_support_event` → `enqueue_support_event`
- Registered via `register_handlers` (`slack/app.py:45`); events arrive at `POST /slack/events` (`routes/slack.py:149`) through the Bolt adapter.
- **Dedup guard**: in-process `_processed_ts` set filters already-seen message timestamps (`slack/app.py:88`); `IGNORED_SUBTYPES` (`events/support/slack.py:11`) drops edits/deletes/joins/bots.
- Adds a 👀 eyes reaction to acknowledge, then normalizes the message into a support event, resolves the workspace to its linked Clerk org via `enrich_support_event` (`support/identity.py`), and dispatches through `enqueue_support_event` (`app/composition/rq_jobs.py`). Unlinked workspaces raise `SupportIdentityError` and are dropped at ingress. Dispatch is **durable**: RQ (`webhooks` queue, `slack_support.enqueue`) when enabled, the registered in-process task otherwise — never a synchronous graph run in the request (`slack/app.py:136-152`).

**Discord path**: `src/draftly/integrations/discord/app.py` → message pipeline → `_dispatch_to_event_bus` → `EventComposition.normalize_discord` → `DiscordProcessor` → `enrich_support_event` → `enqueue_support_event`
- Triggered by gateway message events (gated on configured **trigger channels** via `routes/discord.py` / `discord-detail-content.tsx`); dispatched as `discord_support.enqueue` on the `webhooks` queue (`discord/app.py:211-213`).

**Normalizers**:
- `SlackProcessor` (`events/support/slack.py:20`): `normalize_slack` → `ProcessedEvent` with `event_type = "slack.message"`, `source = "slack"`, `question` (message text), `channel`, `thread_ts`, `is_thread_reply`. Built from `{"event": {...}, "team_id": ...}` payload (`slack/app.py:126`).
- `DiscordProcessor` (`events/support/discord.py`): `normalize_discord` → `ProcessedEvent` with `event_type = "discord.message"`, `source = "discord"`, `question`, `channel`/guild, `thread_ts`/reply target.
- Both are wired as `slack` / `discord` processors in `EventComposition` (`app/composition/events.py:17-18,46-50`).

There is **no merged-like edge gate** for support: every non-ignored message (top-level or thread reply) is normalized and dispatched to the runner. `thread_ts` (`slack/app.py:94`) collapses thread replies onto the parent thread for context continuity.

### 2. Event Normalization

| File | Component | Purpose |
|------|-----------|---------|
| `src/draftly/events/support/slack.py` | `SlackProcessor` | message → `slack.message` support event |
| `src/draftly/events/support/discord.py` | `DiscordProcessor` | message → `discord.message` support event |
| `src/draftly/events/base.py` | `BaseProcessor` / `ProcessedEvent` | Normalizer base + typed event envelope |
| `src/draftly/events/types.py` | `EventType` / `SURFACE_SUPPORT` | `slack` / `discord` → `support` surface |

`EventType.SLACK_SUPPORT = "slack"`, `EventType.DISCORD_SUPPORT = "discord"` (`types.py:20-21`), both mapped to `SURFACE_SUPPORT = "support"` (`types.py:30,37-38`).

### 3. Event Dispatcher

**File**: `src/draftly/events/dispatcher.py` - `EventDispatcher`  
`SURFACE_BY_PREFIX` (`dispatcher.py:32`):
```
slack / discord   → support surface  → support graph
issues            → issue surface    → issue graph
pull_request / release / push → pull_request surface → documentation graph
```
`EventDispatcher.route(event)` (`dispatcher.py:56`) maps the event prefix to the surface. `WorkflowRunner.run` calls `route()` (`workflows/runner.py:125`), then `build_graph_for_run(..., surface="support")` → `_BUILDERS["support"] = build_support_graph` (`integrations/strands/graph.py:29`).

**Workflow adapters**: `run_slack_support` (`workflows/support/slack_support_workflow.py:16`) and `run_discord_support` (`workflows/support/discord_support_workflow.py:16`) wrap `WorkflowRunner.run`, registered as `slack_support` / `discord_support` (`app/composition/workflows.py:131-132`). The live Slack/Discord entry paths call `workflows.runner.run` directly (bypassing the registry). A `publisher` is threaded through so support runs stream via SSE (`slack_support_workflow.py:21`).

**Idempotency**: same `try_claim` atomic claim on the events table (`runner.py:141`), marking `completed`/`failed`/`pending_review` and detecting duplicates — shared across all surfaces.

### 4. Workflow Layer

- `run_slack_support` / `run_discord_support`: thin adapters → `WorkflowRunner` → Support Graph (see §5).
- The runner's `_finish_result` handles outcomes directly: a `Status.INTERRUPTED` result stores interrupts and transitions to `pending_review`; a `Status.COMPLETED` result delivers and persists a `SupportDeliveryReceipt`, then marks the thread resolved via `_resolve_support_thread` (`workflows/runner.py`). `resolve_support_thread` is the underlying bookkeeping helper, invoked on the live support-run path through the runner.
- **Build-time support runtime**: `WorkflowRunner.run` and `resume_review` wrap graph construction in `set_support_runtime(support_runtime_for(event))`, so the delivery graph is scoped to the correct platform and org, and `slack_post_message` / `discord_post_message` resolve the originating thread + per-installation credentials.

### 5. Strands Multi-Agent Graph - Core Intelligence

**File**: `src/draftly/orchestration/graphs/support_graph.py` (`SUPPORT_GRAPH_ID = "draftly-support-graph"`, `build_support_graph`)

#### Graph Structure:
```
classify → context → research(Swarm) → triage → impact
  ├─(answer)─► answer ─┐
  ├─(update)─► update ─┤
  └─(create)─► create ─┴─► evaluate ─(passed)──► deliver
                                │▲
                                └─(needs_revision_of)─┘
```
Unique to support: a dedicated **`triage`** node (question analyzer) sits between research and impact. Routing to answer/update/create keys off the **triage** node's `ImpactAnalysis`, because the `impact` node (solution researcher) produces free-text research rather than a routing verdict.

#### Nodes & Agents:

| Node | Agent Factory | Tools Used | Purpose |
|------|--------------|-----------|---------|
| `classify` | `build_classifier()` | None (pure reasoning) | Validates surface (`is_valid_surface` edge) |
| `context` | `build_context_agent()` | semantic/keyword_search, slack search+get_thread, discord search+get_thread (+ optional `MemoryGroundedNode`) | Thread + docs evidence bundle |
| `research` | `build_research_swarm()` (4 agents) | GitHub / Slack / Discord / Docs tools | Deep research across channels |
| `triage` | `build_question_analyzer()` | semantic_search | Routes the question; emits `ImpactAnalysis` used for answer/update/create routing |
| `impact` | `build_solution_researcher()` | semantic/keyword_search, github_intelligence | Free-text solution research over docs/threads/code |
| `answer` | `build_answer_writer()` | semantic/keyword_search | Writes the direct thread reply |
| `update`/`create` | `build_writer_agent()` ×2 | documentation_engineer, documentation | Generates doc changes when the question reveals a gap |
| `evaluate` | `EvaluatorNode` | Deterministic quality scoring | Validates grounding, completeness, citation coverage |
| `deliver` | `build_delivery_agent()` | Platform poster (`slack_post_message` / `discord_post_message`) or GitHub delivery (`create_branch`/`create_commit`/`create_pull_request`/`create_comment`) | Posts the reply back into the thread |

The `deliver` node is built with a **delivery tool set scoped to the run's
origin source** (`_delivery_tools_for_source` in `support_graph.py`): Slack runs
receive only the Slack poster, Discord runs only the Discord poster, and
documentation-gap outcomes route to reviewed GitHub delivery. This isolation
guarantees a Slack/Discord direct answer can never post to the wrong platform
and a GitHub-only delivery flow can never post to Slack or Discord.

Key routing note (`support_graph.py:150-152`): the answer/update/create conditions are `route_to_answer_of("triage")`, `route_to_update_of("triage")`, `route_to_create_of("triage")` — they read the **triage** (question analyzer) verdict, not the impact node's output, since `impact` returns free-text research.

### 6. Research Swarm (4 Specialized Agents)

Identical swarm to issue/PR — `build_research_swarm` in `src/draftly/agents/subagents.py`:

| Agent | Tools | Focus |
|-------|-------|-------|
| `github_researcher` | GitHub intelligence tools | PRs, issues, diffs, code |
| `slack_researcher` | Slack search, get_thread | Slack conversation history |
| `discord_researcher` | Discord search, get_thread | Discord conversation history |
| `docs_researcher` | Semantic/keyword/hybrid search | Documentation store coverage |

The swarm includes the `github_researcher` (can pull related code/PRs/issues) and the **docs researcher** (semantic/keyword/hybrid), so support runs research against both product code/repos and the documentation store — even though support has no local-repository tools at the agent level.

### 7. Tools Registry

From `support_graph.py` tool groups (via `ToolRegistry` in `app/composition/tools.py`):

**Context agent**: `semantic_search`, `keyword_search`, `slack_search`, `slack_get_thread`, `discord_search`, `discord_get_thread`.

**Research swarm**: `github_intelligence`, `slack_search`+`slack_get_thread`, `discord_search`+`discord_get_thread`, `semantic/keyword/hybrid_search`.

**Triage (question_analyzer)**: `semantic_search`.

**Impact (solution_researcher)**: `semantic_search`, `keyword_search`, `github_intelligence`.

**Answer writer**: `semantic_search`, `keyword_search`.

**Doc gap writers (update/create)**: `documentation_engineer`, `documentation`.

**Deliver (`build_delivery_agent`)**: platform poster (Slack or Discord, scoped to the run's origin) or GitHub delivery tools for documentation-gap outcomes; built with `hitl=False` because the graph-level `ReviewGate` owns human approval (`support_graph.py:119`).

Support surfaces have **no cross-platform delivery tools**: the delivery agent
is scoped to the originating platform, so a direct answer always returns to the
same Slack/Discord thread and never posts elsewhere. Documentation-gap outcomes
route explicitly to GitHub (branch → commit → PR) through `support_to_github`,
and only after a human approval via the review-resume helper. There is no
`repo_dir`-dependent tool wiring in the support graph (unlike the PR-surface
worktree flow).

### 8. Memory & Feedback Systems

| File | Purpose |
|------|---------|
| `memory/service.py` | Persistent knowledge storage |
| `workflows/post_run/candidate_extractor.py` | `record_post_run_memory` — records episode + memory candidates after a completed support run (`runner.py:208`) |
| `workflows/feedback/` | Scheduled `feedback_loop` (`support.gap_scan` task) clusters resolved support gaps into documentation gaps |

`Feedback intelligence reference`: the `support_reviewer` agent (`agents/support/support_reviewer.py`) and `evaluation/online.py` `SURFACE_EVENT_TYPES` support the `support` surface for eval/replay, though the `support_reviewer` agent is not wired into the graph's edges (reference/exporter only).

### 9. Persistence Layer

**Directory**: `src/draftly/persistence/`

#### Repositories (`persistence/repositories/`) — shared across all surfaces:

| Repository | Purpose | Key Methods |
|------------|---------|-------------|
| `support.py` | Support conversations | Slack/Discord thread persistence |
| `slack.py` / `discord.py` | Platform-specific data | Installation configs, channel mappings, trigger channels |
| `documents.py` - `DocumentRepository` | Documentation storage & retrieval | `create`, `find_by_repository`, `save`, `upsert`, `search`, `update`, `delete` |
| `memory.py` - `MemoryRepository` | Vector memory storage | Embedding-based retrieval |
| `reviews.py` - `ReviewsRepository` | Human review tracking | Review requests, decisions, comments |
| `evaluations.py` | Evaluation results storage | Scores, reasons, iteration tracking |
| `delivery.py` | Delivery receipts | Thread-reply delivery records |
| `workflow_events.py` | Workflow event log | Event history, audit trail |
| `agent_runs.py` | Agent execution tracking | Run metadata, performance metrics |
| `routing.py` / `jobs.py` / `events.py` | Cross-cutting | Model routing, jobs, event store |

#### Persistence Flow in Support Workflow:

```
1. Event Ingestion
   └─► workflow_events.py: Store incoming Slack/Discord message event

2. Workflow Execution
   ├─► agent_runs.py: Track each graph node execution
   ├─► evaluations.py: Store evaluation scores & reasons
   └─► reviews.py: Create review request on ReviewGate interrupt

3. Response
   ├─► documents.py: Store any doc drafts (when question → update/create)
   └─► delivery.py: Record thread-reply delivery receipt (slack/discord post)

4. Post-Run Memory
   └─► post_run/candidate_extractor.py: Record episode + candidate gaps
   └─► support.py: Thread persisted for the scheduled feedback loop
```

### 10. Evaluation

- **`EvaluatorNode`** (`src/draftly/orchestration/nodes/evaluate.py`): deterministic scoring — citation coverage 40%, completeness 30%, length heuristic 30%, threshold 0.70; revision loop `needs_revision_of("update"|"create")`, max 2 iterations (default).
- Evaluation packages (`src/draftly/evaluation/`): `runner.py`, `service.py`, `store.py`, `failure_analyzer.py`, `evaluators/`; CLI `scripts/run_evaluation.py`. The `support` surface is supported in `evaluation/online.py` for replay/eval.
- **`support_evaluation.py`** (`workflows/evaluation/`): support-specific evaluation workflow for offline quality runs.

### 11. Review Gate

- **`ReviewGate`** (`src/draftly/orchestration/hooks/review_gate.py`) - graph **hook provider** that owns human approval: interrupts execution, sets workflow status to `pending_review` (`runner.py:195`)
- **`review/service.py`**, **`review/queue.py`**: review queue management
- **`review/resume.py`** — `resume_review_decision`: shared review-resume helper that restores the persisted source event, resumes the paused graph with the decision, and only records the decision once the run reaches the expected status (approval → `delivered`, rejection → `failed`).
- **`persistence/repositories/reviews.py`**: persists review requests, decisions, comments
- The support graph's `deliver` agent is built with `hitl=False` (`support_graph.py:119`) because `ReviewGate` owns approval via the interrupt mechanism.
- Reviewer notification: reviewers with `notify_slack` / `notify_discord` prefs are notified when a review becomes pending (best-effort, non-fatal).

---

## Frontend Architecture (`draftly-agent-frontend`)

There is **no dedicated support ticket/thread inbox**. Support-triggered runs surface through the generic **Workflows** list/detail (trigger badge for support), the **Dashboard** (Needs Attention branches on `workflow === "support"`), the **Agents** page, and the Slack/Discord **integrations** pages (which are install/link surfaces, not ticket views).

### 1. Integrations Page

**Route**: `app/(app)/integrations/page.tsx`  
**Component**: `Integrations()` in `components/integrations/integrations.tsx`
- Shows connected systems: GitHub, Slack, Discord (Slack "…support conversations, threads"; Discord "support channels").

**Slack integration detail**: `app/(app)/integrations/slack/page.tsx` → `components/integrations/slack-detail-content.tsx` — "generate documentation from **support threads**", workspace stats, connection health (OAuth 2.0), Agent Access (Researcher, Documentation Agent), disconnect. `api/slack.ts` → `/slack/install-url`, `/slack/installations`, `/slack/link`. Handles `?team_id=` OAuth redirect (`routes/slack.py:138`).

**Discord integration detail**: `app/(app)/integrations/discord/page.tsx` → `components/integrations/discord-detail-content.tsx` — invite bot, link guild by ID, **Trigger Channels** checkboxes (which channels trigger support runs), disconnect. `api/discord.ts` → `/discord/invite-url`, `/discord/status`, `/discord/link`, `/discord/channels`, `/discord/trigger-channels`.

### 2. Workflows Dashboard

**Route**: `app/(app)/workflows/page.tsx`  
**Component**: `Workflows()` in `components/workflows/workflows.tsx`
- Runs list w/ status tabs, search, live refresh; `WorkflowListItem` → `WorkflowRow`.
- `components/workflows/data.ts`: `triggerIcons` include **support** → Headphones icon (the distinction for support-triggered runs). Today `workflows.tsx` hardcodes a PR/commit-style icon, so support runs are differentiated by `triggerLabel`/status rather than icon.

`app/(app)/workflows/[id]/page.tsx` → `components/workflows/workflow-detail.tsx` renders a live support run via `useWorkflowEvents` SSE: `ExecutionGraph` (live "Classify→Context→Research→Triage→Impact→Answer→Update→Create→Evaluate→Deliver" pipeline), `ActiveExecution`, `ArtifactsPanel`, `EventLog`, `EvidenceCollected`, `EvaluationCriteria`, `WorkflowSummary`. `components/workflows/stage-definitions.ts` labels the `answer` stage (issue/support reply node).

### 3. Agents Visualization

**Route**: `app/(app)/agents/page.tsx`  
`components/agents/agent-icons.tsx` keys icons by role including **`support_analyzer`** and **`support_researcher`** (support graph agents). Agent Detail exposes "Surface: …" and live steps via `useWorkflowEvents`.

### 4. Dashboard

**Route**: `app/(app)/dashboard/page.tsx`  
- `components/dashboard/needs-attention.tsx`: pending reviews where `review.workflow === "support"` show a `CircleHelp` icon (vs `CircleAlert` otherwise) — a first-class support signal.
- `components/dashboard/recent-signals.tsx`: `run.source === "slack" | "discord"` → `Inbox` icon (support) vs `GitBranch` for GitHub.
- Real-time SSE monitoring (`dashboard-events-listener.tsx` → `useDashboardEvents`), SWR polling fallback.

### 5. Review & Evaluation Pages (shared)

Support runs that hit ReviewGate land in the human review queue:

| Route | Component(s) | Purpose |
|-------|-------------|---------|
| `app/(app)/reviews/page.tsx` | `components/reviews/reviews.tsx` | Review queue, lists pending approvals |
| `app/(app)/reviews/[id]/page.tsx` | `review-detail.tsx`, `review-detail-content.tsx`, `review-detail-sidebar.tsx`, `review-counter-cards.tsx` | Diff/review detail for human approval; reads `review.workflow`, trigger label |
| `app/(app)/evaluations/page.tsx` + `evaluations/[id]/page.tsx` | `components/evaluations/` | Evaluation scores, filters, detail |
| `app/(app)/knowledge/…` / `documentation/…` | `components/knowledge/`, `components/documentation/` | Knowledge base & doc store search/detail |

### 6. Event Streaming Infrastructure

- **`hooks/use-workflow-events.ts`** — core SSE hook: `POST /api/workflows/{run_id}/stream-ticket` → `EventSource('/api/workflows/{run_id}/events?ticket=…')`; parses node/stage/tool/text events. Support runs stream through the same path (Slack/Discord runners pass a `publisher`).
- **`components/live-events/live-events-provider.tsx`** + **`hooks/use-dashboard-events.ts`** — tenant-wide dashboard SSE.
- **`hooks/use-live-refresh.ts`** — SWR polling + SSE-event-driven refetch fallback.

---

## Complete Support Flow (End-to-End)

```
Slack message / app_mention  OR  Discord message in a trigger channel
       │
       ▼
<slack> Bolt app_mention/message handler  OR  <discord> gateway handler
       │
       ▼
[gate] dedup (_processed_ts / ignored subtypes) & non-empty text; trigger-channel filter (Discord)
       │
       ▼
SlackProcessor / DiscordProcessor → normalized "slack.message" / "discord.message" event
       │
       ▼
enrich_support_event: workspace/guild → linked Clerk org (unlinked → dropped)
       │
       ▼
enqueue_support_event → worker queue (slack_support.enqueue / discord_support.enqueue)
       │
       ▼
WorkflowRunner.run (durable worker path) → job_id → idempotency try_claim
       │
       ▼
build_support_graph(source-scoped) → classify → context → research(Swarm)
       │
       ├─► triage (QuestionAnalyzer → ImpactAnalysis routing verdict)
       ├─► impact (SolutionResearcher → free-text solution research)
       ├─► answer/update/create (routed off triage verdict)
       │     └─► evaluate (EvaluatorNode: citation 40 / completeness 30 / length 30)
       │           ├─► PASS → ReviewGate (human approval interrupt) → deliver
       │           └─► FAIL → revise loop (max 2 iterations)
       └─► deliver (DeliveryAgent → origin-platform poster OR GitHub for doc gaps)
             │
             ▼
direct answer → reply posted into the originating Slack/Discord thread
doc gap     → reviewed GitHub PR (branch → commit → PR)
             │
             ▼
SupportDeliveryReceipt persisted (thread marked resolved only after durability)
             │
             ▼
record_post_run_memory (episode + candidates)
             │
             ▼
scheduled feedback_loop (support.gap_scan) clusters resolved support gaps
             │
             ▼
resolved gaps → documentation updates (doc graph)
```

### Persistence Checkpoints in Flow

| Step | Repository | Data Persisted |
|------|------------|----------------|
| Message received | `workflow_events.py` | Raw event + metadata |
| Workflow claim (idempotency) | `workflow_events.py` | Atomic `try_claim`; status `completed`/`failed`/`pending_review`, duplicate detection |
| Delivery (thread reply) | `delivery.py` / `SupportDeliveryReceipt` | Provider message id, channel/thread, source message, org, status — prevents duplicate replies |
| Thread persistence | `support.py` | Thread for the scheduled feedback loop |
| Post-run memory | `memory/*` / `post_run/candidate_extractor.py` | Episode + candidate gaps |

### Delivery routing & duplicate suppression

- `route_support_outcome(request)` (`workflows/support/support_resolution.py`)
  always routes documentation-gap outcomes to `"github"`; direct answers return
  to the origin platform.
- `support_to_github(request, registry, *, approved=False)` opens a reviewed
  GitHub PR (branch → commit → PR) and refuses to run without approval or a
  parseable `owner/repo` + `base_sha`.
- A `SupportDeliveryReceipt` is persisted **only after** a successful provider
  post and before the thread is marked resolved. The runner's
  `_existing_support_delivery` short-circuits any event with an existing
  receipt, so a redelivered Slack/Discord webhook never posts a second reply.

### End-to-end verification

`tests/integration/test_slack_support_delivery.py` and
`tests/integration/test_discord_support_delivery.py` drive the real normalizer,
org enrichment, in-process task handler, and review-resume helper with fake
provider clients (`run_fake_slack_question` / `run_fake_discord_question`).
They cover ingress, org enrichment, queue dispatch, review resume, delivery,
duplicate suppression, and final receipt persistence.

---

## Key Integrations

| System | Backend Integration | Frontend Display |
|--------|---------------------|------------------|
| **Slack** | Bolt handlers (`app_mention`/`message`), `SlackProcessor`, org enrichment, durable worker dispatch, slack search/get_thread/post_message tools, slack researcher | Integrations page + Slack detail ("support threads", OAuth status), Workflows table (support runs), Dashboard signal |
| **Discord** | Gateway handlers, `DiscordProcessor`, org enrichment, durable worker dispatch, discord search/get_thread/post_message tools, discord researcher, trigger-channel config | Integrations page + Discord detail (invite, trigger channels), Workflows, Dashboard signal |
| **GitHub** | Shared research swarm github researcher (code/issue/PR intel); reviewed PR delivery for documentation-gap outcomes | Integrations page (GitHub) |
| **Memory** | Vector store, knowledge graph, `MemoryGroundedNode` | Knowledge page, agent memory grounding |
| **Persistence** | CockroachDB/PostgreSQL (JSONB), DocumentStore, repositories | Workflow history + detail graph, Evaluation audit trail, Reviews queue |

---

## Features Used

1. **Event-Driven Architecture** — Redis streams for event bus; **durable worker dispatch** (RQ `webhooks` queue / in-process task fallback) for Slack/Discord support
2. **Strands Multi-Agent Graphs** - Orchestrated agent workflows (`support_graph`)
3. **Human-in-the-Loop (HITL)** - ReviewGate (graph hook) for approval; `deliver` runs `hitl=False` since ReviewGate owns approval; shared `resume_review_decision` resolves decisions
4. **Deterministic Evaluation** - Quality gates before human review (`EvaluatorNode`)
5. **Revision Loops** - Automatic retry on evaluation failure (max 2 iterations)
6. **Multi-Source Research** - Shared 4-agent swarm (GitHub, Slack, Discord, Docs)
7. **Persistent Memory** - Knowledge base updated after each completed run
8. **Thread-Aware Context** - Slack/Discord `thread_ts` collapses thread replies onto the parent for context continuity
9. **Triage Routing** - dedicated `triage` (question analyzer) node whose `ImpactAnalysis` verdict routes answer/update/create (routed via `route_to_*_of("triage")`)
10. **Feedback Intelligence** - scheduled `support.gap_scan` / `feedback_loop` clusters resolved support threads into doc gaps
11. **Real-time Dashboard** - SSE-based monitoring (`useWorkflowEvents` + dashboard SSE, SWR fallback)
12. **Structured Output** - Pydantic models (`ImpactAnalysis`, `EvidenceBundle`, `AnswerDraft`, `DeliveryReceipt`)
13. **Full Persistence Coverage** - Events, agents, evaluations, reviews, documents, delivery, support threads, `SupportDeliveryReceipt`
14. **Surface Routing (support)** - `slack`/`discord` → `support` surface via `SURFACE_BY_PREFIX`; origin-scoped delivery (in-thread replies); documentation-gap outcomes route explicitly to reviewed GitHub delivery
15. **Durable support delivery** - org enrichment before execution, per-installation credentials, delivery receipts prevent duplicate replies, Slack/Discord support jobs survive API restarts through the worker queue
