# The Initialization Stages Pipeline

> **Document type:** Explanation
> **Scope:** The onboarding/initialization workflow shared between `draftly-agent-backend` and `draftly-agent-frontend`
> **Audience:** Engineers working on either repository

This document explains the initialization stages pipeline: what happens when a new Draftly workspace analyzes a GitHub repository for the first time, why the work is split into discrete stages, and why each stage exists. It is a *discussion* — for step-by-step code paths, follow the file map at the end.

---

## 1. What initialization is

Initialization is the one-time, high-cost job that turns an empty workspace and a raw GitHub repository into a populated, queryable knowledge foundation. It is the difference between handing a user an empty SaaS shell and handing them a dashboard that already understands their code, docs, issues, and conversations.

It is implemented as a **five-stage backend workflow** (`STAGES` in `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py`):

| # | Stage | Human label | Backend function |
|---|-------|-------------|------------------|
| 0 | *(prerequisite steps)* | Workspace → Preferences | `app/api/routes/onboarding.py` |
| 1 | `repository_ingestion` | Processing documentation | `SyncService.sync()` (`documentation/sync_service.py`) |
| 2 | `knowledge_construction` | Building knowledge base | `run_knowledge_construction()` (`workflows/onboarding/stages.py`) |
| 3 | `initial_evaluation` | Running evaluation | `run_initial_evaluation()` (`workflows/onboarding/stages.py`) |
| 4 | `health_report` | Calculating health | `run_health_report()` (`workflows/onboarding/stages.py`) |
| 5 | `recommendations` | Preparing recommendations | `run_recommendations()` (`workflows/onboarding/stages.py`) |

The frontend (`draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx` + `components/onboarding/initialization-progress.tsx`) renders that workflow **live** as it happens — not as a decorative spinner, but driven by real backend events over Server-Sent Events (SSE).

> Design intent (from `reference/onboarding-flow.md`): onboarding must not be "a collection of seven client-side pages." It is a **guided UI for initializing a workspace**, backed by a persistent onboarding state machine and a durable initialization workflow.

---

## 2. The big picture

```
┌─────────────────────────────  FRONTEND  ─────────────────────────────┐
│  initialize/page.tsx                                                 │
│   │  useStepGuard("initialize")                     (keeps order)   │
│   │  getInitializeStatus() → INITIALIZING? → resume : startInitialize()│
│   │                                                                    │
│   ▼                                                                    │
│  useWorkflowEvents(runId, ticket)                                     │
│   │  POST /workflows/{runId}/stream-ticket  →  SSE stream             │
│   ▼                                                                    │
│  stage_manifest ──► dynamic task list (StageConfig[])                │
│  stage_change   ──► stage history (started / completed + stats)      │
│  stage_progress ──► per-stage progress bar (0–100)                   │
│  tool_progress  ──► live "N files processed" (documentation_sync)    │
│  workflow_result──► /onboarding/complete  OR  error + retry          │
│                              ▲                                        │
└──────────────────────────────┼────────────────────────────────────────┘
                               │ SSE StreamEnvelope (seq-ordered)
┌─────────────────────────────  BACKEND  ───────────────────────────────┐
│  POST /onboarding/initialize → _execute_initialization()             │
│   • acquire Redis init-lock (idempotent per run_id)                  │
│   • issue stream ticket                                              │
│   • store init_run_id in onboarding row                              │
│   • background task : worker.run_task("onboarding.initialize")       │
│                                                                       │
│  run_onboarding_initialize()  ← publishes every stage to the stream  │
│   1. repository_ingestion  ──► SyncService.sync()                    │
│   2. knowledge_construction ─► LLM fact/relationship extraction      │
│   3. initial_evaluation     ─► heuristics + sampled LLM scoring      │
│   4. health_report          ─► composite health score + freshness    │
│   5. recommendations        ─► LLM prioritized recommendations       │
│    ► mark_step_and_set_state("initialization","COMPLETED")           │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 3. The control plane (what makes the pipeline safe)

Before the stages themselves, it is worth understanding the machinery that keeps the pipeline honest. Without it, initialization would be a flaky script with duplicate runs and no way to explain progress.

### 3.1 A linear state machine, not a boolean

The onboarding flow tracks a persistent state (`state` on the onboarding row) driven by a strict transition table in `app/api/routes/onboarding.py`:

```python
_TRANSITIONS = {
    "WORKSPACE_CREATED":        {"NOT_STARTED", "WORKSPACE_CREATED"},
    "GITHUB_CONNECTED":         {"WORKSPACE_CREATED", "GITHUB_CONNECTED"},
    "REPOSITORY_SELECTED":      {"GITHUB_CONNECTED", "REPOSITORY_SELECTED"},
    "DOCUMENTATION_DISCOVERED": {"REPOSITORY_SELECTED", "DOCUMENTATION_DISCOVERED"},
    "INTEGRATIONS_CONFIGURED":  {"DOCUMENTATION_DISCOVERED", "INTEGRATIONS_CONFIGURED"},
    "PREFERENCES_CONFIGURED":   {"INTEGRATIONS_CONFIGURED", "PREFERENCES_CONFIGURED"},
}
```

- **Same-state replays are allowed** (idempotent POSTs are safe).
- **Skipping is not** — an out-of-order request gets `409 Cannot <action> from <state>`.

**Why it matters:** Because each stage's outputs are *consumed* by the next, order is not cosmetic. If a user could jump to the evaluation stage without a repository, the pipeline would score an empty corpus. The state machine makes the sequencing a server-enforced invariant rather than a UI convention. The frontend's `useStepGuard` mirrors it client-side (via `STATE_TO_STEP`) so a freshly opened tab routes to the correct place — but the server remains the source of truth.

### 3.2 Run IDs, tickets, and the Redis init-lock

- Each invocation gets a unique `run_id` (`onboarding-init-{org}-{hex}`).
- A **Redis lock** (`onboarding:init-lock:{org_id}`, TTL 2h) with `SET NX` guarantees **one initialization per workspace at a time**; the same `run_id` re-acquires it (idempotency), any other `run_id` is bounced with `state: INITIALIZING, resumed: true`.
- The run_id doubles as a Redis Stream consumer group identifier, and a short-lived **stream ticket** authenticates the SSE subscription.

**Why it matters:** The lock is the difference between one expensive workflow and five competing ones. Combined with the "Resume UI" design, it means a user who refreshes mid-run reconnects to the *same* stream instead of starting a duplicate pipeline. Retries (see §6) are only legal from `FAILED`.

### 3.3 Every stage is announced on an event stream

`run_onboarding_initialize` wraps all of its communication in sequential `StreamEnvelope` messages published through a Pluggable event publisher:

- `stage_manifest` — the ordered list of stages (the UI builds its task list from this, dynamically)
- `stage_change` — `{stage, status: started|completed, stats?}`
- `stage_progress` — `{stage, progress: 0–100}`
- `tool_progress` — granular stats inside a stage (e.g. `documentation_sync` doc/chunk counts)
- `workflow_result` — `COMPLETED` (with counts) or `FAILED` (with error)

The frontend dedupes by the envelope's **sequence number**, keeps the last 500 events, and reconnects with capped exponential backoff (5 attempts, 1s→15s). It deliberately does **not** tear down on idle — the server's keep-alive pings are what keep a healthy stream alive.

**Why it matters:** This is the mechanism that makes the progress UI *true*. Every checkmark, progress bar, and "N files processed" counter is derived from actual server-side milestones — there is no fake progress. It also decouples the UI from the pipeline: any workflow that emits these envelopes gets a progress UI for free.

---

## 4. The stages, one by one

### Stage 0 — Prerequisite steps (frontend-driven, pre-seed the assumptions)

These are the *onboarding steps* that must complete before initialization may run: workspace creation, GitHub connection, repository selection, documentation discovery, integrations, and preferences. In the initialization UI they are shown as **pre-completed preset tasks** (`PRESET_TASKS` in `initialization-progress.tsx`):

- Workspace created
- GitHub connected
- Repository indexed
- Documentation discovered

**Benefits**

- Reassures the user that everything configured so far carried over into the run.
- Keeps the initialization screen focused on the *new* work rather than re-explaining setup.
- The separation means each step stays independently testable and re-runnable (`/onboarding/*` POST endpoints are idempotent).

**Why it matters:** These steps determine the *inputs* to the pipeline — which repository, which GitHub installation, which `doc_include`/`doc_exclude` globs, which integrations. The selected-repository payload that reaches the workflow is the accumulated result of these steps, so getting them right structurally is what lets Stage 1 run without asking any questions.

---

### Stage 1 — `repository_ingestion` · "Processing documentation"

**What it does.** `SyncService.sync()` pulls the repository's tree from GitHub and:

1. Discovers candidate documentation files via deterministic glob classification (`discover_documentation`), honoring the user's `include`/`exclude` patterns (defaults: include `README.md`, `docs/**`, `*.md`, `*.mdx`; exclude `node_modules/**`, `dist/**`, etc.).
2. Fetches and processes up to 8 files concurrently (bounded `asyncio.Semaphore`).
3. Runs a **content-hash skip** — a file whose stored `source_hash` matches is skipped, so re-syncs are cheap (except orphaned rows with no chunks).
4. Parses markdown (`parse_markdown`), chunks it (`chunk_document`), upserts a `Document` record, and stores chunks in memory via **one `embed_batch` + one transaction per file**.
5. Captures per-file commit dates (capped at 200 files) — the future freshness signal.
6. Emits a baseline snapshot (`create_baseline`) and calls back progress continuously.

Progress escapes while the sync is *still running* via a **dirty-flag + background flusher** (`_flush_event` + `_progress_loop` in `initialize.py`): the UI sees `document_count`/`chunk_count` climbing in near-real-time instead of after the whole stage returns.

**Benefits**

- **Cheap re-runs:** content-hashing avoids re-embedding unchanged files — in embedded-vector systems, embedding is the expensive part.
- **Batch writes:** one embed batch per file (one per chunk-batch in Stage 2) means thousands of chunks do not become thousands of round-trips.
- **Resilience:** per-file failures are recorded (`failed_files`) and do not abort the run; a sync that stores *zero* docs while failing files is treated as a hard failure, not a silent success.
- **Honest progress:** the throttled flusher streams progress mid-sync and is torn down cleanly by `_cancel_flusher()` (no orphaned background loops).

**Why it matters:** This stage is the data foundation. Everything downstream — extraction, evaluation, health, recommendations — operates on these documents and chunks. If this stage is wrong, every other stage is wrong on garbage. The content-hash + batch-write design is also what makes initialization *repeatable* and *resumable* rather than a one-shot data-loading script.

---

### Stage 2 — `knowledge_construction` · "Building knowledge base"

**What it does.** `run_knowledge_construction()` recalls up to 500 synced chunks and uses an **LLM to extract structured knowledge** from each:

- `facts` → stored as `Knowledge` entries (batched: one embed + one transaction per batch of 50 chunks).
- `relationships` → typed edges (`IMPLEMENTS`, `DOCUMENTED_BY`, `AFFECTS`, `DERIVED_FROM`) added to the **documentation graph** (`context.docgraph`). Invalid/inferred types fall back to `DERIVED_FROM` and are logged.
- `procedures` → enqueued as `procedure_pattern` memory candidates for later curation.

The LLM is called under bounded concurrency (`LLM_MAX_CONCURRENCY`, default 8, env-configurable), with a 10s per-chunk timeout, and — critically — **one `Agent` is reused for all calls** instead of constructing a provider-backed agent per call (which would redo expensive setup hundreds of times).

**Benefits**

- **Graph, not just text:** facts without relationships would be a pile of notes. Typed relationships are what later let Draftly answer "how does `X` affect `Y`?" — the graph is the knowledge *structure*, facts are the knowledge *content*.
- **Cost/time control:** the concurrency cap trades stage latency against provider rate limits, and the per-call timeout converts a hung provider from a workflow-stopper into a recorded `failed_chunk`.
- **Graceful degradation:** an unresolvable model degrades to per-call Agent construction (old behavior) instead of failing hard.

**Why it matters:** This is where the raw corpus becomes an *understanding*. Without it, the platform has documents but no knowledge. The relationship edges into the docgraph are what later power the graphify-style querying, affected-docs tooling, and memory retrieval — it is the intellectual core of "Draftly understands your product."

---

### Stage 3 — `initial_evaluation` · "Running evaluation"

**What it does.** `run_initial_evaluation()` scores the corpus on four dimensions — **coverage, completeness, structure, length** — using a two-layer blend:

1. **Heuristic pass (cheap, full corpus):** every document is scanned deterministically — does it mention expected topics (`readme`, `getting started`, `api`, …)? Does it have a title, headings, code blocks, links? Is its length in a sane range?
2. **LLM pass (expensive, sampled):** a *deterministic* sample of up to `EVAL_LLM_SAMPLE_SIZE` (25) docs is scored semantically by the LLM — heuristic dimensions separately, so the cost is bounded (Task 8).
3. **Blend:** final dimension = `0.4 × heuristic + 0.6 × LLM` when LLM data exists, pure heuristic otherwise. The overall score weights coverage/completeness at 30% each, structure/length at 20% each.

**Benefits**

- **Bounded cost:** heuristics already scanned every doc, so the LLM pass only needs a spread of 25 — mathematically representative via even step sampling, not random (deterministic, reproducible).
- **Robust to LLM failure:** if the model errors or scores parse badly, the blend quietly falls back to heuristics instead of producing a broken score.
- **False-precision guard:** `_parse_llm_scores` rejects any output missing or out-of-range for the four dimensions, so a hallucinated JSON blob cannot corrupt the corpus score.

**Why it matters:** Evaluation is the *judgment* layer. It converts a pile of doc files into a number (and per-dimension numbers) that the rest of the system — health scoring, opportunity ranking, the dashboard's quality metrics — can act on. It also establishes the *baseline*: the first evaluation is the reference point the ongoing documentation loop measures drift against. Bounding its cost is what makes it acceptable to run during onboarding rather than only as an overnight batch.

---

### Stage 4 — `health_report` · "Calculating health"

**What it does.** `run_health_report()` is a **deterministic aggregation stage** — the only stage with no LLM calls. It combines the evaluation score with structural and freshness facts from the sync:

```
health = 0.70 × eval_score
       + 0.15 × min(document_count / 50, 1)      ← corpus size signal
       + 0.15 × min((sections / docs) / 5, 1)    ← structural density signal
```

Plus a **freshness** dimension derived from the per-file commit dates captured in Stage 1 (`1 − avg_days / STALE_DAYS`, neutral `0.5` when unknown).

**Benefits**

- **Deterministic and cheap:** a pure computation — no network, no model, no variance between runs. It composes the *judgment* (eval) with the *facts* (doc count, section ratio, recency).
- **Anti-gaming:** a huge but empty or stale corpus cannot score high — dilution by volume is impossible because doc count is only 15%.
- **Honest unknowns:** missing commit dates yield a neutral freshness (0.5) instead of a fake 0 or 1.

**Why it matters:** Health is the single most legible output of initialization — it is what the completion screen and dashboard show first. It needs to be explainable (weighted sum of known quantities), stable (no LLM nondeterminism), and meaningful. It also seeds the archival baseline used to detect future drift: no baseline, no "your docs got worse" signal.

---

### Stage 5 — `recommendations` · "Preparing recommendations"

**What it does.** `run_recommendations()` hands the health/eval/dimension scores and counts to the LLM and asks for **3–5 prioritized recommendations**, each with a `priority` (high/medium/low), a short `title`, a detail sentence, and the `category` (dimension) it addresses. It reuses one Agent; a parse failure degrades to an empty list.

**Benefits**

- **Closes the loop:** evaluation says "structure is 0.31 and coverage is 0.42" — recommendations say *"Merge inline one-liners into dedicated pages"* (an action, not an abstract number).
- **Prioritized:** the dashboard sorts by `priority`, so the user's first improvement is the highest-leverage one, not the first thing the model thought of.
- **Non-blocking:** a failed/slow model yields `[]` — the rest of the pipeline is already finished; recommendations are additive value, not a hard dependency.

**Why it matters:** Numbers motivate nothing; *actions* do. Recommendations are what converts initialization from "we analyzed your docs" into "here are the first three things worth doing." They are the artifact that makes a new user feel the product has already done real work for them, and they give the ongoing feedback loop a concrete starting agenda.

---

### Completion

After Stage 5, the workflow:

1. Persists the accumulated results — `document_count`, `chunk_count`, `knowledge_count`, `eval_score`, `health_score`, and the recommendations — into the onboarding row (`mark_step_and_set_state(org_id, "initialization", "COMPLETED", ...)`).
2. Emits `workflow_result { COMPLETED, document_count, chunk_count }`.
3. Returns `WorkflowStatus.DELIVERED`.

The frontend, on `COMPLETED`, routes to `/onboarding/complete`, which renders the "Draftly is ready" summary (sources, knowledge, health, opportunities). `POST /onboarding/complete` finalizes with a **fake-success guard**: completion is rejected unless the row carries a real `document_count` — so an accidentally-poisoned COMPLETED row cannot masquerade as success.

---

## 5. How the frontend renders the pipeline

All rendering lives in `components/onboarding/initialization-progress.tsx`, driven by props computed in `initialize/page.tsx` from the SSE event history:

| Prop | Source | Renders |
|------|--------|---------|
| `stageManifest` | `stage_manifest` | Dynamic task list (labels like "Building knowledge base") |
| `stageHistory` | `stage_change` | Checkmarks, "In progress" / "Pending", relative timestamps |
| `stageProgress` | `stage_progress` | Per-active-stage percentage bar |
| `syncProgress` | `tool_progress` (name `documentation_sync`) | Sub-detail "N files processed" under the discovery task |
| `finalStats` | `workflow_result` | Final doc/chunk counts |

Mechanics worth noting:

- The task list is **preset tasks (pre-completed) + backend stages from the manifest**, so new backend stages appear automatically with no frontend change — the manifest is the contract.
- `activeStage` is derived, not tracked: the last event marked `started` without a matching `completed`. A stage that fails is simply never completed, so the spinner logic stays correct without extra state.
- The active task row shows a progress bar with **threshold-based helper text** ("Initializing…" < 30, "Processing content…" < 60, "Embedding content and creating relationships" < 85, "Finalizing…" ≥ 85) — reassuring copy that changes as the iconographic progress does.
- The right column sells the outcome ("Creating your project knowledge graph") with live stat tiles (Documents, Chunks, Connections, Health) fed by the same server counters.

**Why it matters:** The UI is a *faithful projector* of the backend pipeline, not a mock. Because every state it shows is event-derived, there is no desynchronization between what the user sees and what the server is doing — and no code path where the UI claims "completed" while the backend is still running.

---

## 6. Failure, retry, and resilience

- **Failure surfacing:** exceptions in the workflow → `onboarding_repo.mark_failed(...)`, state `FAILED`, `workflow_result { FAILED, error }`. The frontend shows a dedicated `InitializationError` panel — never an indefinite spinner (a hard UX requirement from the spec: "Never leave the user on an indefinite spinner").
- **Retry is gated:** `POST /onboarding/initialize/retry` is allowed **only** from the `FAILED` state and is **idempotent** — it re-enters the same `_execute_initialization` path, so it cannot start duplicate workflows.
- **Sticky runs:** if a previous attempt was left in `INITIALIZING` (e.g. a crash or timeout), starting again transparently *resumes* that run (the same `run_id`) rather than spawning a new one.
- **Lock hygiene:** the init-lock is always released in a `finally` block; the background progress flusher is always cancelled (`_cancel_flusher`) on failure so a failed run cannot orphan a publisher loop.
- **Connection loss:** the SSE hook reconnects with capped backoff and, after 5 failed attempts, surfaces a "Lost contact with the server" error with a retry path — matching the spec's instruction that retries be idempotent and safe.

**Why it matters:** Initialization is long (minutes) and expensive (hundreds of LLM calls). In that window, users will refresh tabs, lose Wi-Fi, and hit provider timeouts. A durable, idempotent, lock-protected design converts all of those events from *lost work* into *harmless interruptions*.

---

## 7. Design principles behind the stages

1. **Process before judgment before advice.** Ingest first (Stage 1), then understand (2), then judge (3), then summarize health (4), then advise (5). Each stage consumes the previous, so ordering is intrinsic, not stylistic.
2. **Determinism where possible, LLM where necessary.** Hash-skips, heuristics, the health formula, and sampling are deterministic and free. The LLM is reserved for extraction, semantic quality, and recommendations — the only places genuine judgment is required.
3. **Bounded cost at every step.** Concurrency caps (sync 8, LLM 8), timeouts (10s), sample caps (25 docs), commit-date caps (200), and batch writes all exist so that *first-use cost scales with corpus size sub-linearly*.
4. **Everything is resumable and idempotent.** Locks, run IDs, content hashing, and state-machine gating mean the pipeline can be interrupted and restarted without duplicating work or double-indexing.
5. **Progress is evidence, not animation.** Every UI element is derived from sequenced server events, so the interface can be trusted.

---

## 8. Why it matters (the short version)

- **For the user:** a populated dashboard, an honest live progress view, a health score and concrete recommendations — instead of an empty shell or an opaque spinner.
- **For the product:** a repeatable, bounded-cost path from "connected a repo" to "Draftly understands the product" — the moment the agent's memory, docgraph, and evaluation loop have a real foundation to stand on.
- **For the platform:** fault-tolerant orchestration (locks, idempotency, resumability) that keeps a minutes-long, hundreds-of-LLM-calls job safe under refresh, disconnect, and provider failure.

---

## 9. File map

### Backend (`draftly-agent-backend/src/draftly/`)

| File | Role |
|------|------|
| `workflows/onboarding/initialize.py` | Workflow orchestrator: `STAGES`, `STAGE_LABELS`, `run_onboarding_initialize`, event publishing, flusher/lock cleanup |
| `workflows/onboarding/stages.py` | Stages 2–5: knowledge construction, evaluation, health, recommendations (+ prompts, result dataclasses, sampling/concurrency helpers) |
| `documentation/sync_service.py` | Stage 1: GitHub → parse → chunk → embed/transaction, baseline, commit-date capture |
| `documentation/discovery.py` | Deterministic glob include/exclude classification |
| `documentation/chunker.py`, `parser.py`, `baseline.py` | Sync building blocks |
| `app/api/routes/onboarding.py` | State machine, `/onboarding/*` endpoints, `_execute_initialization`, Redis init-lock, retry/completion guards |
| `app/composition/workers.py` / `app/workers/task_runner.py` | Task registration + background execution of `onboarding.initialize` |
| `persistence/repositories/onboarding.py` | Onboarding row read/write, `mark_step`, `mark_step_and_set_state`, `mark_failed` |
| `events/stream_envelope.py`, `events/redis_stream_bus.py` | Sequential SSE envelope publishing |

### Frontend (`draftly-agent-frontend/`)

| File | Role |
|------|------|
| `app/(onboarding)/onboarding/initialize/page.tsx` | Page: resume-or-start, stage history/progress derivation, result routing |
| `components/onboarding/initialization-progress.tsx` | Task list rendering, preset tasks, active/progress/stat tiles, helper text |
| `components/onboarding/initialization-error.tsx` | Failure + retry UI |
| `hooks/use-workflow-events.ts` | SSE client: ticket fetch, reconnect backoff, seq dedupe |
| `api/onboarding.ts` | REST client for all `/onboarding/*` endpoints |
| `lib/onboarding/types.ts` | `StageConfig`, `InitializeStatus`, `OnboardingState` |
| `lib/onboarding/use-step-guard.ts`, `constants.ts`, `steps.ts` | Client-side ordering/validation mirror of the state machine |

### Design references

- `reference/DESIGN.md` — §12 "Step 7 — Initialize Draftly" (init page spec), §13 (failure UI + retry rules), §14 (completion)
- `reference/onboarding-flow.md` — state machine + "durable initialization workflow" design rationale