# GitHub Release Event Workflow Analysis

Complete analysis of the GitHub Release event workflow across `draftly-agent-backend` and `draftly-agent-frontend`.

---

## Backend Architecture (`draftly-agent-backend`)

### 1. Ingestion Layer - Webhook Handling

**Live path**: `src/draftly/app/api/routes/github.py` → `POST /webhook` → `EventComposition.normalize_github` → `ReleaseProcessor` → `WorkflowRunner.run`

**Receiver**: the FastAPI route `github_webhook` (`routes/github.py:249`)
- Verifies the HMAC SHA-256 signature (`verify_webhook_signature`, `routes/github.py`)
- Reads `X-GitHub-Event` / `X-GitHub-Delivery`, parses the JSON body, handles `installation` inline, then calls `normalize_github(payload)` (`routes/github.py`).
- **No merged-like edge gate for releases.** The edge gate is keyed on the event *prefix* `pull_request.*` (`routes/github.py:313-321`), so every `release.*` action — published, prereleased, released, created, edited, unpublished, deleted — passes straight through and dispatches. There is no `"(skipped, ...)"` response for a release, unlike a non-admitted PR.

**Normalizer**: `EventComposition.normalize_github` (`app/composition/events.py:39`) routes by payload shape:
- `payload.get("release")` → `ReleaseProcessor` (`events/github/release.py`)
- `pull_request` → `PullRequestProcessor`
- `issue` (without `pull_request`) → `IssueProcessor`
- `push` (has `ref` + `commits`) → `PushProcessor`
- plus `slack` / `discord` payload processors.

`ReleaseProcessor.supports()` is `bool(payload.get("release"))` (`release.py:49-50`). `process()` returns a **`ProcessedEvent`** (`events/base.py:19`) with:
- `event_type = "release.<action>"`, where `action` defaults to `"published"` (`release.py:22`)
- a `release` dict carrying `id`, `tag_name`, `name`, `draft`, `prerelease`, `html_url`, plus the run-agnostic evidence bundle `source_event_type="release"`, `source_event_id`, `source_title` (release name/tag) and `source_summary` (release body) (`release.py:31-46`)
- **`content_relevant = action == "published" and not release.draft`** (`release.py:23`) — the single most important flag in this workflow (see §3 routing fork).

Event id uses the delivery id when present, else `release-<repo>-<tag>-<action>` (`release.py:53-58`). The legacy `src/draftly/integrations/github/webhooks.py` parse path is orphaned dead code, exactly as in the PR workflow — the live flow is the route → normalize → processor path above.

### 2. Event Normalization

| File | Component | Purpose |
|------|-----------|---------|
| `src/draftly/events/github/release.py` | `ReleaseProcessor` | `release.<action>` → normalized event with `content_relevant` flag |
| `src/draftly/events/base.py` | `BaseProcessor` / `ProcessedEvent` | Normalizer base + typed event envelope |
| `src/draftly/events/types.py` | `EventType` | Event-type registry; `release` → `GITHUB_RELEASE` |

### 3. Event Dispatcher - the routing fork

**File**: `src/draftly/events/dispatcher.py` - `EventDispatcher`

`dispatcher.route()` (`routes/github.py` dispatcher, `dispatcher.py:58-70`) checks **`content_relevant` first**, before the prefix table:

```
event.content_relevant (or body.content_relevant)  → surface = "content"     ← published, non-draft releases
prefix lookup: release → SURFACE_PULL_REQUEST     → surface = "pull_request" ← every other release action
```

Result — a release can take two completely different pipelines:

| Release situation | `content_relevant` | Surface | Graph builder | Output |
|---|---|---|---|---|
| **Published, non-draft** (`action=published` && `draft=false`) | `true` | `content` | `build_content_graph` | Blog / LinkedIn / X draft package (content store) |
| Draft, prerelease-flagged, `created`/`edited`/`unpublished`/`deleted`/`released`/`prereleased` | `false` | `pull_request` | `build_documentation_graph` | Documentation-graph output (changelog/doc PRs) |

The `release → pull_request` row in `SURFACE_BY_PREFIX` (`dispatcher.py:35`) is therefore only the **fallback** branch; any real one-click publish (`published`) routes to the content graph. The route persists the job with name **`github_release`** (`routes/github.py:342-345`) and dispatches through the dedicated **`github_release.enqueue`** task on the RQ **webhooks** queue (`_webhook_task_name`, `routes/github.py:78-79`).

**Idempotency**: same shared `WorkflowRunner.run` atomic `try_claim` on the events table before the graph runs (`runner.py:193-206`), marking `pending_review`/`completed`/`failed` and detecting duplicates. There is no pre-claim edge gate for releases (unlike PRs), so *every* release action touches an idempotency row.

### 4. Workflow Layer

**File**: `src/draftly/workflows/documentation/github_release_workflow.py`
**Function**: `run_release_workflow()`
Thin adapter (like `github_pr`): marks the job `running`, calls `WorkflowRunner.run(event)`, then `completed`/`failed` (`github_release_workflow.py:40-51`). The runner, not the adapter, resolves the surface from `content_relevant`.

### 5. Strands Multi-Agent Graph - Content Intelligence

**File**: `src/draftly/orchestration/graphs/content_graph.py` (`CONTENT_GRAPH_ID = "draftly-content-graph"`, `build_content_graph` at `content_graph.py:257`)

#### Graph Structure (published-release branch):
```
content_brief (Content Strategist)
   │
   ▼
content_blog (Blog Writer) ──► content_linkedin (Social Adapter) ─┐
                  └────────────► content_x (Social Adapter) ──────┴─► evaluate (ContentEvaluationNode)
                                                                        │ (eval_passed)
                                                                        ▼
                                                                     persist (ContentPersistNode) → package IN_REVIEW
                                                                        │ (eval_passed)
                                                                        ▼
                                                                     deliver (ContentApprovalNode) → package APPROVED
```
Edges/wiring (`content_graph.py:307-339`): `content_brief` is the entry point → `content_blog`; `content_blog` → `content_linkedin` and `content_blog` → `content_x`; both social nodes must complete before `evaluate` (`all_dependencies_complete`); `evaluate → persist` and `persist → deliver` are gated on `eval_passed`. `reset_on_revisit(True)`; ReviewGate + `RunAuditLogger` are the hook providers.

#### Nodes & Agents:

| Node | Agent | Purpose |
|------|-------|---------|
| `content_brief` | `build_content_strategist()` | Produces the shared content brief (angles, evidence) that all writers follow |
| `content_blog` | `build_blog_writer()` | Long-form blog variant |
| `content_linkedin` / `content_x` | `build_social_adapter()` ×2 | Channel-specific social variants, reused for both |
| `evaluate` | `build_content_grounding_judge()` | Grounding judge scoring each variant; aggregates blocking issues |
| `persist` | `ContentPersistNode` | `ContentService.create` package + revision, saves per-channel variants, sets status `IN_REVIEW` |
| `deliver` | `ContentApprovalNode` | Marks the package `APPROVED` after human green-light |

Unlike the PR workflow there is **no research swarm** (no multi-agent GitHub/Slack/Discord swarm) — the content graph is a writer pipeline grounded in the release evidence already carried in the normalized event. Writers receive **read-only-scoped** tools (`scope_read_only_tools`, `content_graph.py:293-301`) so releases cannot mutate GitHub.

### 6. Tools Registry

`build_content_graph` assembles tools from `ToolRegistry` (`app/composition/tools.py`):
- **Content**: `content` tool group (draft-only production)
- **Search**: `semantic_search`, `keyword_search` (+ `hybrid_search` when memory is present — `content_graph.py:282-288`)

The `content_repository` is a **build-time requirement**: `build_content_graph` raises `ValueError` if it is `None` (`graph.py:276-277`), and `build_graph_for_run` deliberately drops `content_repository` for every *other* surface so it never leaks into an incompatible builder (`graph.py:98-99`) — i.e. only content surfaces may consume it.

**Grounding is not applied to releases.** `grounding` / `repo_dir` are injected only for the `pull_request` surface (`graph.py:108-110`). Release evidence comes from the normalized event itself — `source_evidence` (html_url), `tag_name`, `name`, `body` — and from doc-store search; no git checkout is probed and no GitHub API diff is fetched for the content branch.

### 7. Persistence Layer

**Content store** (the release-specific store): `src/draftly/persistence/repositories/content.py` (`ContentRepository`) + `ContentService` in `src/draftly/content/service.py`. A release run persists a `ContentPackage` (status `DRAFT → IN_REVIEW → APPROVED/REJECTED`) with per-channel `ContentVariant`s (`BLOG`, `LINKEDIN`, `X` — `src/draftly/content/models.py`) and a revision history.

**Shared repositories reused from the PR workflow** (same 18-repo persistence layer): `jobs.py` (run row named `github_release`), `github.py` (`github_workflows` row with `event_type=release.<action>`), `workflow_events.py` (idempotency claim), `agent_runs.py` (per-node execution), `reviews.py` (ReviewGate requests), `evaluations.py` (if the doc-graph branch is taken), `memory.py` (interrupt/post-run knowledge), `delivery.py` (delivery receipts).

**Persistence flow in the Release workflow:**

```
1. Webhook received
   └─► workflow_events.py: incoming event + delivery_id
2. Pre-dispatch bookkeeping
   ├─► jobs.py: job row, name = "github_release", schedule = "webhook"
   └─► github.py: github_workflows row (run_id, event_type, installation_id, actor)
3. Runner claim
   └─► workflow_events.py: atomic try_claim → pending_review/completed/failed (duplicate detection)
4. Graph execution
   ├─► agent_runs.py: node execution + duration
   ├─► content.py: ContentPackage + revisions + variants (status IN_REVIEW)   ← content branch
   ├─► reviews.py: ReviewGate interrupt request (pending_review)
   └─► agent_runs.py / workflows state: post-run candidate extraction (runner.py:90)
5. Approval
   ├─► content.py: status → APPROVED/REJECTED via deliver node or review endpoint
   └─► reviews.py: decision recorded
```

### 8. Content API (draft-only production — the release frontend)

**File**: `src/draftly/app/api/routes/content.py` (mounted at `/api/content`, Clerk-authenticated)

| Endpoint | Purpose |
|---|---|
| `POST /content/generate` | Manual content brief (`source_event_type` in `pull_request`/`release`/`documentation`/`manual_brief`/`feedback_gap`); routes through `runner.run` with `content_relevant=true` |
| `GET /content` | List packages by org (+ `status` filter) |
| `GET /content/{package_id}` | Single package |
| `POST /content/{package_id}/review` | `approve` / `request_changes` / `reject` at the package level; blocks approval while `blocking_issues` remain (409); `request_changes` spawns a new revision → `DRAFT` |
| `GET /content/{package_id}/revisions` | Revision history |

This is a *second*, package-level approval surface alongside the runner's ReviewGate.

### 9. Review Gate

- **`ReviewGate`** (`src/draftly/orchestration/hooks/review_gate.py`) — graph hook that interrupts the content/doc graph after `persist`, setting workflow status `pending_review`.
- **`review/service.py` + `reviews.py`** — queue + persisted review requests.
- **Resume**: the paused graph is resumed via `POST /api/github/review/{run_id}` (shared `resume_review_decision`), with `STRANDS_REVIEW_POLICY=always` (default) meaning every release run stops for human approval.
- The content graph's `deliver` node (`ContentApprovalNode`) does **not** ship anything externally — "Draftly-only production": it marks the package `APPROVED` inside the store. No posting to blog/LinkedIn/X (that is future channel delivery).

### 10. Evaluation

- **`ContentEvaluationNode`** (`content_graph.py:95-155`, built around `make_grounding_judge(judge_agent)`) — evaluates each channel variant for grounding/evidence quality and emits per-channel `scores` + `blocking_issues`; only `eval_passed` edges into `persist`. No revision loop: FAIL just stops the run.
- **`evaluate_content_variant`** (`src/draftly/evaluation/evaluators/content_quality.py`) — deterministic quality scoring used by the non-graph draft path (`workflows/content/content_generation.py:124`).
- The **fallback documentation-graph branch** uses the PR workflow's `EvaluatorNode` (0.70 threshold, revision loop max 2).

### 11. Workflow Adapters / Direct Runs

- **`run_content_workflow`** (`src/draftly/workflows/content/content_generation.py:175`) — registry adapter for `content_generation` task; wraps the event with `event_type=content.manual`, `content_relevant=True` and calls `runner.run`.
- **`run_content_generation`** (`content_generation.py:94`) — older deterministic draft path: generates + scores variants without the Strands graph. Used by the content API when no composed runner is wired.
- Registered workflows: `github_release` (event), `github_pr`, `github_issue`, `slack_support`, `discord_support`, `content_generation`, plus the scheduled family (`workers.py:19-35`).

---

## Frontend Architecture (`draftly-agent-frontend`)

### 1. Content Page (release surface)

**Route**: `app/(app)/content/page.tsx` → `ContentPage()`
- Lists content packages via `listContent()` (SWR) and renders `ContentPackageView` (`components/content/content-package-view.tsx`) per package.
- Copy: *"Draft-only production … Review grounded blog, LinkedIn, and X variants before anything leaves Draftly."* — i.e. releases produce **drafts for human approval**, not published posts.
- Empty state: *"Content generated from releases, docs, briefs, or feedback gaps will appear here."*

### 2. Shared workflow surfaces reused by releases

Because release runs share the same job/run/review persistence as PRs, they surface in the generic pages from the PR workflow analysis: **Workflows dashboard** (`app/(app)/workflows/page.tsx` — trigger type *commit*-style, stage pipeline, execution graph), **Reviews** (`app/(app)/reviews/...` — `sourceType` queue + detail), **Dashboard** (SSE `run_completed`/`review_created` events), plus **Integrations/GitHub** (installations). There is no release-specific page beyond the content page.

---

## Complete GitHub Release Flow (End-to-End)

```
GitHub: v0.2.0 published on TheGreatBonnie/authly (draft=false)
       │
       ▼
POST /api/github/webhook  (routes/github.py:249: verify signature → parse → normalize)
       │
       ▼
ReleaseProcessor → event_type=release.published, content_relevant=true
       │  (events/github/release.py:23)
       ▼
[no edge gate — release never matches the pull_request.* prefix gate at routes/github.py:313]
       │
       ▼
resolve org identity → persist jobs (name=github_release) + github_workflows rows
       │
       ▼
dispatch github_release.enqueue → RQ "webhooks" queue  (routes/github.py:78-79; rq_jobs.py)
       │
       ▼
run_release_workflow (mark running) → WorkflowRunner.run (github_release_workflow.py)
       │
       ▼
idempotency claim (events.try_claim)  (runner.py:193)
       │
       ▼
dispatcher.route: content_relevant=true → surface=content  (dispatcher.py:58-62)
       │
       ▼
build_graph_for_run(surface=content) → build_content_graph  (graph.py:38)
       │
       ├─► content_brief (strategist → brief)
       ├─► content_blog (blog writer)
       ├─► content_linkedin + content_x (social adapters)
       ├─► evaluate (ContentEvaluationNode: grounding judge, blocking issues)
       ├─► persist (ContentPersistNode: package + variants + revision → IN_REVIEW)
       ├─► ReviewGate interrupt → pending_review
       └─► deliver (ContentApprovalNode → APPROVED) after approval
              │
              ▼
       package shown in frontend Content page as draft
```

**Fallback branch** (non-published release action, e.g. `created`/`prereleased`/a draft edit): `content_relevant=false` → `surface=pull_request` → `build_documentation_graph` → the same classify → context → research → impact → answer/update/create → evaluate → ReviewGate → deliver pipeline and persistence described in `GITHUB_PR_EVENT_WORKFLOW_ANALYSIS.md`.

### Persistence Checkpoints in Flow

| Step | Repository | Data Persisted |
|------|------------|----------------|
| Webhook received | `workflow_events.py` | Raw event + delivery_id |
| Pre-dispatch | `jobs.py` / `github.py` | `github_release` run row; `github_workflows` row (`event_type=release.<action>`) |
| Runner claim (idempotency) | `workflow_events.py` | Atomic `try_claim`, `pending_review`/`completed`/`failed` |
| Graph executed | `agent_runs.py` | Per-node execution, duration |
| Content generated | `content.py` | ContentPackage (`IN_REVIEW`) + variants + revision |
| Review requested | `reviews.py` | ReviewRequest on ReviewGate interrupt |
| Post-run memory | `memory.py` / candidates | Candidate extraction enqueued for `memory_curation` |
| Approved | `content.py` | Package status `APPROVED` |

---

## Key Integrations

| System | Backend Integration | Frontend Display |
|--------|---------------------|------------------|
| **GitHub** | Release webhook, installation token, `release` tool group (draft-only) | Integrations page / GitHub detail |
| **Content** | `ContentRepository` + `ContentService`, channels blog/LinkedIn/X | Content page (`content-package-view.tsx`) |
| **Memory** | Vector store + candidates (post-run extraction) | Knowledge page |
| **Persistence** | CockroachDB/PostgreSQL (JSONB), DocumentStore, 18 repositories | Workflow history/detail, Content page, Reviews queue |
| **Review** | ReviewGate interrupt + `POST /api/github/review/{run_id}`; `POST /content/{package_id}/review` | Reviews queue/detail; content approval |

---

## Features Used

1. **Event-Driven Architecture** — Redis streams, RQ webhooks queue
2. **Strands Multi-Agent Graph** — content graph (`draftly-content-graph`) and doc graph
3. **Surface Routing Fork** — `content_relevant` flag decides content-graph vs documentation-graph for the same event prefix
4. **Human-in-the-Loop** — ReviewGate interrupt + package-level content review
5. **Deterministic Evaluation** — grounding judge with blocking issues (content), EvaluatorNode (doc branch)
6. **Draft-Only Production** — generated variants stay inside Draftly (`APPROVED` ≠ published)
7. **Persistent Memory** — candidate extraction into `memory_curation` after each release run
8. **Full Persistence Coverage** — jobs, github_workflows, events, agent_runs, content, reviews
9. **Idempotent Processing** — atomic `try_claim`; duplicate detection
10. **No Admission Gate** — releases are never "skipped"; every action persists a run row

---

## Release vs PR Workflow

| Aspect | Release | PR |
|--------|---------|-----|
| Edge gate | none (all actions dispatch) | only `opened`/`merged` admitted (`routes/github.py:313`) |
| Task / queue | `github_release.enqueue` → webhooks | `github_pr.enqueue` → webhooks |
| Default surface | `content` (published, non-draft) | `pull_request` (always) |
| Primary graph | content graph (blog/LinkedIn/X) | documentation graph |
| Research swarm | none (writer-only) | 4-agent swarm |
| Evidence | event body/tag/html_url + doc search | PR diff/files via grounding (`local`/`github`/`docs`) |
| Deliver output | package `APPROVED` inside Draftly (no push) | branch/commit/PR/comment on GitHub |
| Job name | `github_release` | `github_pr` |
| Frontend surface | Content page | Reviews queue, PR diff review detail |