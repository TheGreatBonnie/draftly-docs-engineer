# Fix `POST /workflows/{run_id}/stream-ticket` 404 → live init progress never connects

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes. Test-driven: write failing tests (red) before implementation (green).

**Goal:** Make the onboarding live-progress SSE stream connect reliably. Today the `jobs` row backing a `run_id` is not reliably persisted, so the API returns `404 Unknown run` on every `stream-ticket` request and the frontend silently degrades to status polling.

**Scope (user-approved):** Backend + frontend. Jobs-insert failures **fail the request with a 5xx** (no silent swallow).

---

## Problem statement (from log analysis)

The supplied logs show a backend that is otherwise healthy returning, over ~40s, a repeated pattern:

```
POST /api/workflows/onboarding-init-org_3IXETMZxgiMiUu14HOFTo45sdUD-f7dfe49f/stream-ticket  →  404
```

with exponential backoff gaps (~1.5s → 4s → 6s → 10s → 16s), then continued `200` polls of `/api/onboarding/status` / `/api/onboarding/initialize/status`. That is the exact signature of `use-workflow-events.ts` exhausting its reconnect budget and falling back to polling (`initialize/page.tsx:202-234`).

**Root cause:** `GET /workflows/{run_id}/stream-ticket` → `workflows.py:59-61`:

```python
record = await jobs.get(job_id=run_id)   # actually FILTERS BY run_id column (jobs_store.py:93)
if record is None:
    raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
```

The `jobs` row that resolves a `run_id` must exist before the ticket can be issued, but it is **not reliably created** in two independent ways:

1. **The insert bypasses the app-wired store and swallows failures.**
   `onboarding.py:426-427` builds a brand-new `DatabaseJobsStore()` + `DatabaseClient()` instead of the app-wired `repositories.jobs` (the store `stream-ticket` reads, `workflows.py:54-55`), and wraps the whole insert in a bare `try/except` (`onboarding.py:436-440`) that only logs a `warning`. On any failure the run_id has **no jobs row** → every `stream-ticket` 404s. This diverges from the design (plan `2026-08-28-initialization-bottleneck-remediation.md:714` and test `test_onboarding_initialize.py:825` both use `repositories.jobs.insert`).

2. **The resumed path hands out a run_id with no jobs row.**
   `onboarding.py:401-407`: when the init lock is not acquired, `_execute_initialization` returns the **stored** `init_run_id` and returns early, skipping the jobs insert. On page reload while `INITIALIZING`, the frontend (`initialize/page.tsx:176-178`) reads that persisted `run_id` from `/initialize/status` and calls `stream-ticket` for it immediately (and never sets a `ticket`).

**Contributing factor:** migration `036_jobs_add_run_id.sql` makes `run_id TEXT UNIQUE`, so a re-insert must be `ON CONFLICT ... DO NOTHING`. And `use-workflow-events.ts` caps reconnects at `MAX_RECONNECT_ATTEMPTS=5` (up to 15s), so the UI falls back to polling — "works" but without real-time progress.

---

## Architecture / data flow (single diagram)

```
Frontend initialize/page.tsx
  │  resumed path: getInitializeStatus() → status.run_id   (page.tsx:176)
  │  fresh path:   startInitialize()      → run_id + ticket (page.tsx:180)
  ▼
POST /workflows/{run_id}/stream-ticket          (workflows.py:43)
  │  jobs.get(job_id=run_id)  → 404 if no row    ← BUG: row missing
  ▼
GET  /workflows/{run_id}/events?ticket=...      (workflows.py:147)  SSE
  │
Backend when run_id is minted (_execute_initialization, onboarding.py:379)
  ├─ try_acquire_init_lock?  ── no ──▶ return stored init_run_id  ← BUG: no jobs row
  │
  ├─ mint run_id = f"onboarding-init-{org_id}-{uuid4()[:8]}"
  ├─ issue ticket
  ├─ upsert onboarding record (init_run_id)
  ├─ jobs.insert(run_id, org_id, ...)           ← BUG: fresh store + swallowed errors
  └─ enqueue (RQ) or asyncio.create_task fallback
```

---

## Files

**Backend**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflows.py`
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`
- Test: `draftly-agent-backend/tests/api/test_workflows_stream.py`

**Frontend**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`
- Test: `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`
- Test: `draftly-agent-frontend/tests/hooks/use-workflow-events.test.ts`

---

## Task 1: Persist the jobs row via the app-wired store and fail loudly (root cause #1)

**Why:** `stream-ticket` reads `request.app.state.draftly.dependencies.repositories.jobs` (`workflows.py:54-55`). The job must be written through that same store so it is guaranteed visible; a swallowed insert must never silently break the stream.

**Files:** `onboarding.py`, tests.

**Step 1 — Write failing tests (red)**
- `tests/api/test_onboarding_routes.py`: `_execute_initialization` with mocked RQ asserts `repositories.jobs.insert` (the app-wired store) is called with `run_id`, `org_id`, `name="onboarding.initialize"`, `job_type="onboarding"`, `schedule="manual"`, and `configuration["rq_job_id"] == job.id`; and that a **fresh `DatabaseJobsStore()` is NOT constructed** (assert via a patched constructor not being called).
- `tests/api/test_onboarding_routes.py`: when `repositories.jobs.insert` raises, the route propagates a **5xx error** (assert the response status is 500 / an exception bubbles) instead of silently logging a warning.
- `tests/unit/workflows/test_onboarding_initialize.py`: RQ-enabled path pins the `configuration["rq_job_id"]` value (plan line 716-718) referenced by the test at line 825 (`repositories.jobs.insert` mock).

Confirm the new tests fail for the expected reasons before implementing.

**Step 2 — Rewrite the insert in `_execute_initialization`**
Replace the fresh-store block (`onboarding.py:425-440`) with the repository:

```python
try:
    await repositories.jobs.insert(
        run_id=run_id,
        org_id=org_id,
        name="onboarding.initialize",
        job_type="onboarding",
        schedule="manual",
        configuration={"rq_job_id": job_id}  # rq_job_id="" for the in-process fallback
    )
    logger.info("onboarding_jobs_inserted", run_id=run_id, org_id=org_id)
except Exception:
    logger.exception("onboarding_jobs_insert_failed", run_id=run_id, org_id=org_id)
    raise HTTPException(
        status_code=500, detail="Failed to register initialization run"
    )
```

- Use `repositories.jobs` (passed in as the `repos` arg) — do not construct a new store.
- Compute `job_id` from `job` when RQ-enabled (branch exists at `onboarding.py:454`), else `""`/omit `rq_job_id`.
- On failure **raise 500** (per user decision); do not swallow.

**Step 3 — Verify (green)**
```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_onboarding_routes.py tests/unit/workflows/test_onboarding_initialize.py -q
```

---

## Task 2: Guarantee a jobs row on the resumed path (root cause #2, backend)

**Why:** The lock-not-acquired branch (`onboarding.py:401-407`) returns a stored `init_run_id` without ensuring a jobs row exists. If that run_id is stale/dead, `stream-ticket` 404s forever and the frontend's resumed path (Task 3) can never stream.

**Files:** `onboarding.py`, tests.

**Step 1 — Write failing tests (red)**
- `tests/unit/workflows/test_onboarding_initialize.py`: when `_try_acquire_init_lock` returns `False` (resumed), assert the route reconciles a jobs row for the stored run_id via `INSERT ... ON CONFLICT (run_id) DO NOTHING` (idempotent — run_id is `UNIQUE` per migration 036) before returning it; OR mints a fresh run_id if reconciliation cannot succeed.

**Step 2 — Reconcile on the resumed path**
In `_execute_initialization`, the lock-not-acquired branch:

```python
if not await _try_acquire_init_lock(request, org_id, run_id):
    stored_run_id = (current or {}).get("selected_repository", {}).get("init_run_id")
    if stored_run_id:
        await repositories.jobs.upsert_on_conflict(
            run_id=stored_run_id, org_id=org_id,
            name="onboarding.initialize", job_type="onboarding",
            schedule="manual", configuration={},
        )
    return {"state": "INITIALIZING", "run_id": stored_run_id, "resumed": True}
```

- Add `upsert_on_conflict` (or an `INSERT ... ON CONFLICT (run_id) DO NOTHING`) to `DatabaseJobsStore` (`jobs_store.py`) and `JobRepositoryImpl` (`persistence/repositories/jobs.py`). Migration 036 already gives `run_id` a `UNIQUE` constraint.
- Keep it best-effort but log loudly on failure (do not 404-later silently).

**Step 3 — Verify (green)**
```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_initialize.py -q
```

---

## Task 3: Distinct, visible logging on unknown run (observability)

**Why:** Nothing currently surfaces the 404 incident in prod — it is invisible, which is why the bug lived unnoticed.

**Files:** `workflows.py`, tests.

**Step 1 — Write failing test (red)**
- `tests/api/test_workflows_stream.py`: unknown run logs a structured `stream_ticket_unknown_run` line at `error` with `run_id` and `org_id`.

**Step 2 — Add the log**
`workflows.py:59-61`:

```python
if record is None:
    logger.error("stream_ticket_unknown_run", run_id=run_id, org_id=org_id)
    raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
```

**Step 3 — Verify (green)**
```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_workflows_stream.py -q
```

---

## Task 4: Frontend — recover from a stale run_id (root cause #2, user-facing)

**Why:** `initialize/page.tsx:176-178` reuses a persisted `run_id` from `/initialize/status` on the resumed path; when it has no jobs row, `stream-ticket` 404s. The page never re-mints, so live progress never connects.

**Files:** `initialize/page.tsx`, tests.

**Step 1 — Write failing tests (red)**
- `tests/pages/initialize-page.test.tsx`: when the resumed `run_id` cannot be resolved (stream-ticket 404), the page re-runs `startInitialize()` and uses the returned `run_id` + `ticket` instead of polling a dead `run_id`.
- `tests/page` / `tests/hooks`: `handleRetry` captures `run_id` + `ticket` from the `retryInitialize()` response (currently discarded, `page.tsx:244`) so a retry resumes the live stream.

**Step 2 — Reconcile on the mounted resumed path**
- When the resumed path (page.tsx:176-178) yields a run_id, set `runId` but also reconcile a ticket via a backend call that guarantees a valid run (Task 1/2 make this reliable). Concretely: after setting `runId` from status, if streaming fails with an unknown-run error, call `startInitialize()` to mint a fresh `run_id` + `ticket` and update state.
- In `handleRetry` (page.tsx:236-248): capture and set `run_id`/`ticket` from `retryInitialize()`'s response.

**Step 3 — Verify (green)**
```
cd draftly-agent-frontend && npm test
```

---

## Task 5: Full verification (green)

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_onboarding_routes.py tests/unit/workflows/test_onboarding_initialize.py tests/api/test_workflows_stream.py -q
cd draftly-agent-frontend && npm test
# manual: start rq_worker + API; POST /onboarding/initialize; confirm
#   POST /workflows/{run_id}/stream-ticket → 200 {"ticket": ...}
#   GET  /workflows/{run_id}/events?ticket= → SSE frames stream live
```

Confirm each new test passes, then run the full local suite touched above.

---

## Acceptance criteria

- `POST /onboarding/initialize` returns `run_id` + `ticket`, and the jobs row is visible to `stream-ticket` in both RQ and in-process modes (`jobs.get` by `run_id` succeeds).
- A jobs-insert failure surfaces as a 5xx (not a silent warning that later 404s the stream).
- The resumed/INITIALIZING page path and `handleRetry` produce a **resolvable** run_id + ticket; stale run_ids are reconciled or re-minted.
- The 404 case logs a structured `stream_ticket_unknown_run` error with `run_id`/`org_id`.
- The logs no longer show the repeated `stream-ticket` 404 retry pattern for a legitimate run.

---

## Resolution (2026-08-29)

All tasks 1-5 complete. Final whole-branch review returned CHANGES_REQUESTED with
2 Important findings (F1 frontend re-mint strand, F2 backend resumed-reconcile
swallow) + 2 Minor (M3 param naming deferred, M4 log context). F1, F2, M4 fixed
with TDD; independent re-review: ALL ADDRESSED, no regressions.

Verification:
- Backend covering suite: **104 passed** (`tests/api/test_onboarding_routes.py`,
  `tests/unit/workflows/test_onboarding_initialize.py`,
  `tests/api/test_workflows_stream.py`, `tests/unit/persistence/test_jobs_store_sql.py`).
- Frontend: **78 passed / 2 failed**. The 2 failures are a pre-existing baseline
  timing bug in `tests/pages/initialize-page.test.tsx` ("SSE error -> polling
  fallback": test advances 1000ms but the page poll effect uses a 3000ms delay,
  so `getInitializeStatus` is called once, not the asserted twice). These also
  fail at committed HEAD and are unrelated to this task. Lint clean on all
  changed FE files.

Outstanding (tracked, out of scope): the 2 frontend SSE-page baseline failures
(either fix the test to advance ≥3000ms or align the page), M3 param rename, and
the pre-existing unrelated backend failures (`test_config_redis.py`,
`test_openrouter_provider.py`). No real-Postgres harness yet — runtime
idempotency of `ON CONFLICT (run_id) DO NOTHING` is verified at the SQL-shape
level only.

---

## Runtime follow-up (2026-08-29, post-review)

Manual verification of `POST /api/onboarding/initialize` against the live
Neon database exposed the **true** runtime root cause of the 500/404 — deeper
than a stale process:

1. **`DataError: invalid input for query argument $8: {...} (expected str, got dict)`**
   asyncpg 0.31.0 rejects a Python **dict** bound to a `jsonb` column even with
   `$8::JSONB`; the `::JSONB` cast alone does not change asyncpg's client-side
   codec for a dict value. The `configuration` param must be **`json.dumps`'d**
   to a string before binding.
   -> Fixed in `DatabaseJobsStore.insert` / `upsert_on_conflict`: pass
   `json.dumps(configuration)` (kept `$8::JSONB`). Verified live: insert + get
   by run_id succeed; upsert idempotent (DO NOTHING).

2. **`IndexError: record index out of range` in `_to_dict`** — `insert`/`upsert`
   RETURNING exposed only 8 columns but `_to_dict` reads row[0..9] positionally
   (asyncpg.Record is positional, not a dict). Unit tests masked this because the
   scripted client returns dicts.
   -> Added `last_run_at, next_run_at` to both RETURNING lists.

Both were the missing "real-Postgres harness" gap flagged as deferred. The
SQL-shape test now enforces the 10-column RETURNING contract and that
`configuration` is bound as a JSON string.

Also fixed to make RQ/docker mode actually run locally:
- `docker-compose.redis.yml`: worker `command` dropped the redundant
  `python -m` (Dockerfile ENTRYPOINT already supplies it) which caused
  `No module named python` crash-loop; added `env_file: .env` so model/API keys
  reach the container (worker couldn't resolve a model otherwise).
- `workers/rq_worker.py`: `worker.stop()` -> `worker.request_stop()` (RQ 2.11
  SimpleWorker has no `stop()`).
- `src/draftly/app/composition/rq_jobs.py`: `build_rq_queues` now sets
  `serializer=JSONSerializer` to match the worker's `serializer="json"`
  (mismatch made every enqueued job unreadable by the worker).

#22 rq-worker container verified Up and listening on scheduled/webhooks/default;
stale pickle RQ keys flushed. Known pre-existing warnings: un-awaited
`application.startup()` coroutine in `rq_worker.py` (worker still runs).

Verification: `tests/unit/persistence/test_jobs_store_sql.py` 7 passed;
covering suite 108 passed; full backend 793 passed / 6 failed (same 6
pre-existing out-of-scope failures). Live Neon probe confirmed insert/get/upsert.

---

## Runtime follow-up 2: "Initialization failed to start" (frontend)

### Symptom
Frontend `initialize/page.tsx` rendered the red "Initialization Failed" card with
detail `"Initialization did not start."` — the frontend's `startInitialize()`
returned a body with no `run_id`/`ticket`.

### Root cause (stale unreleased init lock)
`onboarding:init-lock:{org}` was still held by dead run
`onboarding-init-org_3IXETMZxgiMiUu14HOFTo45sdUD-431a2775` (TTL ~4019s remaining).
Redis queues were empty (no onboarding job enqueued/running), so no owner would
ever release it. Concurrently, the org's `onboarding_state` had been reset to
`PREFERENCES_CONFIGURED` with `selected_repository.init_run_id` cleared.

Failure chain in `_execute_initialization` (`onboarding.py`):
1. `_try_acquire_init_lock(new_run_id)` fails (lock held by `-431a2775`).
2. Resume branch reads `stored_run_id = init_run_id` = **null** (cleared).
3. `if stored_run_id:` is False -> skips reconcile.
4. Returned `{"state":"INITIALIZING","run_id":null,"resumed":true}` with **no ticket**.
5. Frontend `page.tsx:195`: null `run_id`/`ticket` -> `setStartError("Initialization did not start.")`
   -> red "Initialization Failed" card.

This is distinct from the stream-ticket 404 (that was a missing jobs row, fixed in
Task 2 and follow-up 1). This is an orphaned in-progress lock guarding a run the
state machine no longer references.

### Fix
- `src/draftly/app/services/init_lock.py`: added `force_release_init_lock(redis, org)`
  (unconditional guarded delete) for orphaned-run recovery.
- `src/draftly/app/api/routes/onboarding.py` `_execute_initialization`: when lock
  acquisition fails AND there is no resumable `stored_run_id`, force-release the
  stale lock, re-acquire for the fresh run, and fall through to the normal fresh
  start (issue ticket, upsert, insert job, dispatch). If the lock is still
  contested after release, return `503 Initialization already in progress`
  instead of a silent null `run_id`.
- `tests/api/test_onboarding_routes.py`: added
  `test_initialize_recovers_stale_lock_without_run_id` (asserts 200 + non-null
  run_id/ticket + `force_release_init_lock` awaited) and
  `test_initialize_503_when_lock_still_contested_after_release`.
- Operational unblock: released the stale `onboarding:init-lock:{org}` key in Redis.

### Verification
- New route tests pass (30 initialize-tests green); covering suite 121 passed/1 skipped.
- Full backend: **795 passed / 6 failed** (the 6 are the known pre-existing
  `test_config_redis` + ox-alpha failures; 793 -> 795 = the 2 new tests. No regressions).
- `main.py` runs uvicorn with `reload=True`; worker child PID 63980 restarted at
  13:13:48 (after the 13:12:13 edits), so the running API has the new code live.
- Stale lock released (key now absent; no remaining `onboarding:init-lock:*`).

---

## Runtime follow-up 3: Worker crashed reading the init job (SSE connected but no events)

### Symptom
`POST /onboarding/initialize` -> 200, `stream-ticket` -> 200, `sse_stream_start`, then
`sse_replay_loaded count=0` and the SSE closed after ~1s with **no live events**. The
MQ worker never actually executed the run.

### Root cause A: stale worker `request_stop()` call
`workers/rq_worker.py` called `worker.request_stop()` with **no args** in the signal
handler and in `finally`. RQ `BaseWorker.request_stop(signum, frame)` is a *signal
handler* and raises `TypeError` when called arg-less. On the job-decode failure this
crashed the worker's shutdown path and it hard-restarted without processing the job.
```
TypeError: BaseWorker.request_stop() missing 2 required positional arguments: 'signum' and 'frame'
```
Fix: register RQ's handler correctly (`worker.request_stop(signum, frame)`), drop the
invalid bare call, and drop the redundant `finally: worker.request_stop()`.

### Root cause B: a stale/corrupt job payload from a pre-fix enqueuer
Redis job `33b3ba5d` (run `...d9702990`) was stored **zlib-compressed** (372 bytes ->
597) with a `CompressedJSONSerializer` header. It had been enqueued by an older API
process (pre-JSONSerializer-fix, at 10:29) and left an orphaned run. The current worker
(`serializer="json"` == `JSONSerializer`) cannot read a compressed payload ->
`UnicodeDecodeError`. Current code (API `json.dumps`/`JSONSerializer`, worker
`"json"`) is consistent and non-compressing; the corrupt job was leftover.

### Fix + operational cleanup
- `workers/rq_worker.py`: correct `request_stop()` signal handling (removed unused `sys`).
- Cleared corrupt RQ job `33b3ba5d` from Redis; `rq:failed` registry empty.
- Released stale `onboarding:init-lock:{org}` for dead run `d9702990`.
- Reset stuck `onboarding_state` `INITIALIZING -> PREFERENCES_CONFIGURED`, cleared
  `init_run_id`/`init_stage` so the next `POST /initialize` is a clean fresh start.
- Rebuilt + recreated `rq-worker` container so it runs the fixed code.

### Verification
- `python -m py_compile workers/rq_worker.py` OK.
- New worker `e78dc838` starts, listens on all 3 queues, **no `request_stop` TypeError**.
- Redis: 0 jobs, empty queues, empty failed registry (no corrupt payloads).
- Onboarding state `PREFERENCES_CONFIGURED`, `init_run_id` cleared, lock released.
- Current API (PID 65706, started 13:19) has `JSONSerializer` enqueue (fix mtime 12:34 < start).
- Pre-existing, out of scope: `RuntimeWarning: coroutine 'DraftlyApplication.startup' was never awaited` (rq_worker.py:100) — worker still runs.

---

## Runtime follow-up 4: CORRECTED root cause — the RQ enqueue/execute design cannot run jobs

### Correction
Earlier follow-up 3 blamed a "stale zlib job from a pre-fix enqueuer" and claimed the
JSONSerializer change was the fix. That was WRONG. Live evidence (controlled redis
round-trips + in-process `perform()`) shows TWO REAL, INDEPENDENT defects that jointly
prevent ANY RQ-enqueued job from executing. Both are caused by the enqueue design, not
by leftover data.

### Bug 1 — RQ connections use decode_responses=True (FIXED)
RQ 2.11 unconditionally zlib-compresses job data at storage (`rq/job.py`:
`zlib.compress(self.data)` on save, `zlib.decompress` on load) — independent of the
serializer. The RQ connections (worker `rq_worker.py` and API `get_rq_connection`)
used `decode_responses=True`, so redis-py UTF-8-decoded the compressed bytes before RQ
could decompress -> `UnicodeDecodeError 'x9c...'` -> worker hard-crash, job lost.
Proven live: `JSON+decodeTrue` crashes; `JSON+raw` round-trips cleanly.
Fix applied: both connections `decode_responses=False` (redis.py:46, rq_worker.py:70),
worker container rebuilt, boots clean on all 3 queues. The prior `JSONSerializer`
change in build_rq_queues was a red herring (RQ compresses regardless).

### Bug 2 — enqueued handler is a non-importable closure (NOT YET FIXED, architectural)
`enqueue_job` wraps handlers in `make_sync_handler(handler)` -> a LOCAL closure
`make_sync_handler.<locals>.sync_handler`. RQ deserializes the function by qualified
path (`import_attribute`) -> `ValueError: Invalid attribute name: sync_handler` on
`perform()`. The closure is also un-picklable (`Can't pickle local object`). So even
after Bug 1, the worker cannot execute any RQ job (onboarding.initialize, documentation.*,
evaluation.loop, memory.*). Jobs stay `pending` forever.

### Intended architecture (from deep-dive of lifecycle.py / workers.py / task_runner.py)
- Both the API and the RQ worker build an `application` with `task_handlers` =
  `task_runner._tasks` = {task_name: async _wrap_workflow closure bound to workflows.context}
  (lifecycle.py:101-105). TaskRunner.run(name, **kwargs) awaits the handler.
- RQ is expected to dispatch by TASK NAME and let the worker resolve its OWN handler.
- The worker currently NEVER builds these handlers: `application.startup()` at
  rq_worker.py:102 is a coroutine that is never awaited (the RuntimeWarning), so
  `task_handlers` stays None in the worker.
- Webhook/surface workflows (github_pr etc.) are NOT in TASK_REGISTRY and run through
  the WorkflowRunner path, not enqueue_job — so only RQ-enqueued scheduled/onboarding
  tasks are affected.

### Recommended fix (per user: deep-dive first)
1. Add a module-level, importable RQ dispatcher (e.g. draftly/app/workers/rq_dispatch.py)
   exposing `dispatch(name, **kwargs)` that runs the handler for `name` in a fresh event
   loop (like make_sync_handler + TaskRunner.run), resolving from a module-global
   handler registry the worker populates at startup.
2. `enqueue_job` enqueues `dispatch` (module-level, importable) with
   `kwargs={'name': task_name, **job_args}` instead of `make_sync_handler(handler)`.
   (This also removes the now-unused task_handlers param need at dequeue.)
3. rq_worker.py: AWAIT `application.startup()` so `application.task_handlers` is built,
   then register those handlers in the dispatcher's global registry before worker.work().
4. Keep decode_responses=False (Bug 1 fix) and JSONSerializer on both sides.
5. TDD: update/extend tests/test_workers coverage so a real enqueue via build_rq_queues +
   enqueue_job round-trips through the dispatcher and executes (green) without relying on
   serializing a closure.

### Verified state now
- New regression tests tests/test_workers/test_rq_connection_decode.py (4) pass.
- Worker boots clean (no decode crash); Redis clean (0 jobs, empty queues); abandoned
  runs 08a6165a / c11d12fd / d9702990 -> status cancelled; onboarding_state reset to
  PREFERENCES_CONFIGURED, init_run_id cleared. Next initialize is a fresh start.
- Still open: Bug 2 (execution) fix pending user direction; pre-existing 6 test failures
  and the un-awaited startup() coroutine (bugs 2a) addressed in the Bug 2 fix.

---

## Runtime follow-up 5: Bug 2 fixed (dispatcher-based RQ execution) — DONE

Implemented the recommended design with TDD.

### Changes
- NEW `src/draftly/app/workers/rq_dispatch.py`: module-level, importable
  `dispatch(name, **kwargs)` that runs the async handler for `name` (from a
  module-global registry) in a fresh event loop. `register_handlers({})` replaces
  the registry; `get_handler(name)` looks up.
- `src/draftly/app/composition/rq_jobs.py` `enqueue_job`: now enqueues the
  module-level `dispatch` with `kwargs={'name': task_name, **job_args}` instead of
  the `make_sync_handler(handler)` closure (removed that import).
- `workers/rq_worker.py`: properly AWAIT `application.startup()` on a dedicated
  loop so `application.task_handlers` (task_runner._tasks) is built, then
  `register_handlers(application.task_handlers or {})` before `worker.work()`.
  Also removes the un-awaited-startup RuntimeWarning.
- `src/draftly/app/composition/rq_scheduler.py` `setup_rq_scheduler`: same fix —
  schedules `dispatch` with `kwargs={'name': task_name, **job args}` instead of a
  closure (same latent bug on the cron path).

### Tests (TDD)
- `tests/test_workers/test_rq_dispatch.py` (4): dispatch executes a registered
  async handler; missing handler raises ValueError; enqueue serializes real
  importable `dispatch` (verified via rq.utils.import_attribute resolves to the
  module-level dispatch, negative for closures); enqueued job re-fetches and
  executes through dispatch.
- `tests/test_workers/test_rq_scheduler.py` (2): scheduler registers the imported
  `dispatch` with task-name kwargs for every SCHEDULED_JOBS entry; skips when no
  handler.
- Full suite: 805 passed / 6 failed (the 6 = pre-existing out-of-scope
  test_redis_settings_defaults + ox-alpha family). No regressions.
- Debug note: RQ stores job.func_name in dotted form (`module.name`) and
  rq.utils.import_attribute resolves the dotted path to the real `dispatch`;
  the old closure path raises `ValueError: Invalid attribute name`.

### Deployed + verified live
- Rebuilt + recreated rq-worker. Boot logs now show:
  `rq_handlers_registered count=8`, `Worker ... started`, `Listening on
  draftly:scheduled, draftly:webhooks, draftly:default`, and NO
  `RuntimeWarning: ... was never awaited` / no `make_sync_handler` / no Traceback.
- Onboarding state reset to PREFERENCES_CONFIGURED, init_run_id cleared; Redis
  clean; abandoned runs cancelled. Next `/onboarding/initialize` is a fresh start
  the worker can now actually execute and stream (SSE events should flow).

---

## Runtime follow-up 6: Bug 3 fixed (persistent event loop for RQ dispatch) — DONE

The Bug 2 fix (dispatcher) deployed, and the live frontend init finally EXECUTED
the job — worker log showed `job 10b113a4 ... execute
(draftly.app.workers.rq_dispatch.dispatch)`, and `sse_replay_loaded count=2`
(events now exist in the stream, previously always 0). But the workflow crashed:

```
RuntimeError: Event loop is closed
asyncpg.exceptions._base.InterfaceError: cannot perform operation: another operation is in progress
ConnectionDoesNotExistError: connection was closed in the middle of operation
```

Root cause (Bug 3): the worker used to run application.startup() on a
THROWAWAY loop and close it; the asyncpg/Neon pool binds to the loop it is
created on. dispatch() then ran the handler on a FRESH loop, so the DB
connections belonged to the closed loop -> crash mid-workflow.

Fix (systematic-debugging -> TDD):
- rq_dispatch.py now runs a PROCESS-WIDE persistent event loop in a background
  thread (module-global `_loop` + `_shared_loop()`/`run_on_loop()`/`shutdown()`).
  dispatch() schedules the handler on that loop via run_coroutine_threadsafe.
- rq_worker.py: application.startup() now runs via run_on_loop() on the SAME
  persistent loop (removed the throwaway loop + `import asyncio`).
- Regression test `test_dispatch_reuses_a_persistent_loop_across_calls`
  (RED->GREEN): dispatch must reuse one live loop, never create+close per call.
- Full suite: 806 passed / 6 failed (6 = pre-existing out-of-scope), no regressions.

Deployed: rebuilt + recreated worker; boots clean (count=8, no Event-loop-closed,
no Traceback). Cleaned leftover state from the crashed run (orphan RQ job
10b113a4 deleted, queues emptied, onboarding reset to PREFERENCES_CONFIGURED,
init_run_id cleared, init lock deleted).

## Runtime follow-up 7: Bug 4 fixed — concurrent /initialize 500 on run_id UNIQUE — DONE

Once the worker actually ran jobs (Bug 2/Bug 3 fixed), final verification surfaced a
new failure that only presents under concurrency: two concurrent `POST
/onboarding/initialize` requests (`eb1b08e6`, `806d70f9`) both converged on the same
`run_id` `onboarding-init-...-29d5648e`:

- Request A: acquired lock, enqueued RQ job, then `repos.jobs.insert(...)` collided on
  the `jobs_run_id_key` UNIQUE constraint -> `UniqueViolationError` -> **500**.
- Request B: couldn't get lock, reconciled, inserted the jobs row first via
  `upsert_on_conflict`, returned 200.

Root cause: `_execute_initialization` (onboarding.py, `repos.jobs.insert(...)`) used a
plain, NON conflict-tolerant insert for the fresh-init path, while the resumed/reconcile
path already used the idempotent `upsert_on_conflict` (`ON CONFLICT (run_id) DO NOTHING`,
jobs_store.py). Two callers converging on the same run_id therefore raced on the UNIQUE
constraint -> 500.

Fix (systematic-debugging -> TDD):
- onboarding.py: changed the fresh-init success path from `repos.jobs.insert(...)` to
  `repos.jobs.upsert_on_conflict(...)` (same kwargs: run_id, org_id, name, job_type,
  schedule, configuration). Idempotent: both concurrent callers now 200 and the stream
  stays fully backed by a jobs row.
- Tests: updated the rq-enabled + rq-disabled mock setup/assertions across
  `tests/api/test_onboarding_routes.py` and `tests/unit/workflows/test_onboarding_initialize.py`
  from `jobs.insert` -> `jobs.upsert_on_conflict`, and added regression test
  `test_rq_fresh_init_does_not_use_plain_insert` (RED->GREEN) asserting the fresh-init
  success path calls `upsert_on_conflict` and NEVER plain `insert`.
- Full suite: 807 passed / 6 failed (6 = pre-existing out-of-scope ox-alpha +
  redis_settings_defaults), no regressions.

Deployed: rebuilt + recreated worker. Waiting on user to re-trigger `/onboarding/initialize`
in the frontend to confirm end-to-end (worker executes onboarding.initialize,
sse_replay_loaded count > 0, job reaches succeeded, SSE events stream with no 500).

## Runtime follow-up 8: Onboarding FAILED again — missing GitHub App private key in worker — DONE

After Bug 4 was deployed, the user reported onboarding state = `FAILED`. Inspecting the
onboarding_state.failure column surfaced the real failure detail:

```
[Errno 2] No such file or directory:
'/Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend/secrets/private-key.pem'
```

Root cause: `generate_jwt()` (integrations/github/app_auth.py) does
`Path(GITHUB_PRIVATE_KEY_PATH).read_text()`. `.env` sets
`GITHUB_PRIVATE_KEY_PATH` to an ABSOLUTE HOST path that only exists on the
macOS host. The RQ worker runs in Docker (`draftly-agent-backend-rq-worker-1`),
whose Dockerfile.worker copied neither `secrets/` nor a mount, so the file did
not exist inside the container -> `FileNotFoundError` inside the init job ->
onboarding FAILED. (The non-Docker API on the host never hit this.)

Fix:
- Attempted a read-only bind mount in docker-compose.redis.yml, but Docker
  Desktop on macOS does not share `/Applications` (mounts denied) without a GUI
  file-sharing change.
- Instead: `COPY secrets ./secrets` in Dockerfile.worker runtime stage, and in
  compose set worker `environment: GITHUB_PRIVATE_KEY_PATH=secrets/private-key.pem`
  (relative to WORKDIR `/app`, overriding the .env absolute path).
- Verified inside container: `exists: True size: 1679`, env path resolves.

Cleanup of the failed state (direct SQL via asyncpg):
- `DELETE FROM jobs WHERE org_id = <org>` (removed stale rows).
- Reset `onboarding_state` to `PREFERENCES_CONFIGURED`, `failure=NULL`,
  `selected_repository=NULL`, `stage_config=NULL`, `completed_steps='[]'`.
- Deleted stale Redis `onboarding:init-lock:<org>` key.

Worker rebuilt + recreated; boots clean (RQ working `draftly:default` queue,
Discord gateway connected, Slack Bolt running), private key readable. Ready to
re-trigger `/onboarding/initialize`.

## Runtime follow-up 9: E2E nearly works — GitHub 404 on empty repo path — DONE

Live re-run after follow-up 8 showed the pipeline finally EXECUTES end-to-end on
the API side:

```
POST /initialize -> 200, Job enqueued, onboarding_jobs_inserted (upsert fix held:
second concurrent request reconciled 200 instead of 500)
/stream-ticket -> 200
/events SSE -> sse_stream_start, sse_replay_loaded count=2
```

But the WORKER job failed in stage 1 (repository_ingestion) with:

```
HTTPStatusError: Client error '404 Not Found' for url 'https://api.github.com/repos/'
```

Root cause (systematic-debugging -> data + code):
- Traceback: initialize.py:582 `repo_full = ''` -> sync_service.sync(repository_full_name='')
  -> client.py:484 `f"/repos/{repository}"` -> `https://api.github.com/repos/` (empty).
- The org's `onboarding_state.selected_repository` only had keys
  `['init_stage','init_run_id','preferences']` — **`full_name` was absent**.
- WHY: the follow-up-8 cleanup reset state to `PREFERENCES_CONFIGURED` but set
  `selected_repository = NULL`. On reload the frontend resumed at the preferences
  step (state=PREFERENCES_CONFIGURED) and `/preferences` overwrote
  `selected_repository` with just `{...current, preferences}`, losing full_name /
  installation context entirely -> a doomed job that fails cryptically.

Fixes:
1. Data: restored the org's known-good `selected_repository` (full_name=
   TheGreatBonnie/authly, installation_id=157195808, github_org=TheGreatBonnie,
   default_branch=main, preferences, integrations, doc settings) — confirmed
   consistent with github_installations + repositories tables. Reset state to
   PREFERENCES_CONFIGURED, failure=NULL, cleared Redis init lock.
2. Code (defense-in-depth, TDD RED->GREEN): added a guard in
   `_execute_initialization` (onboarding.py) AFTER the resumed-path early-return
   and stale-lock recovery but BEFORE the ticket/enqueue: if
   `selected_repository["full_name"]` is missing (or has no `/`), reject
   `/initialize` with 409 "No repository selected" instead of enqueueing a doomed
   job. Regression test
   `test_initialize_409_when_selected_repository_lacks_full_name` (RED->GREEN).
   Guard placement verified not to break resumed-path single-flight (200) or
   reconcile-failure (500) paths.

Full suite: 808 passed / 6 failed (6 = pre-existing out-of-scope). The guard lives
in the host API (onboarding.py), so the worker image does NOT need a rebuild; the
restored data already carries full_name.

## Runtime follow-up 10: E2E succeeded end-to-end — then a FALSE frontend "Initialization Failed" banner — DONE

Re-triggered `/onboarding/initialize` at 12:01:18 -> run 8ac5fc1b, job d1fe7df0.
The worker executed ALL stages successfully:

```
repository_ingestion  complete  (1 doc, 5 chunks)   <- full_name fix unblocked GitHub
knowledge_construction complete  (0 facts; all 5 LLM extraction chunks failed -> warning)
initial_evaluation     complete  (score 0.2808)
health_report          complete  (score 0.22956)
recommendations        complete  (count 5)
onboarding_initialize_done docs=1 ; onboarding_init_lock_released
Job OK (d1fe7df0) in 0:01:59
```

SSE streamed all 27 events in order: stage_manifest -> per-stage
stage_change/stage_progress -> workflow_result COMPLETED (seq 27). DB
`onboarding_state`: state=COMPLETED, completed_steps=["initialization","preferences"],
failure=None.

Heads-up (not blocking): `knowledge_construction` logged 5x
`knowledge_extraction_chunk_failed ... err=<empty>` with the kimi-k2.5 model
loging "Tool #1: ExtractionOutput" -> 0 facts persisted. Separate concern to
investigate later (LLM tool-response parse), not the completion blocker.

### The reopening bug (frontend, TDD RED->GREEN)
User reported the UI showing "Initialization Failed" even though the run
COMPLETED. Root cause (systematic-debugging -> code trace):
- Backend `start_initialization` (onboarding.py) only allows `/initialize` from
  `INITIALIZING` (re-run) or `PREFERENCES_CONFIGURED`; for `COMPLETED` it raises
  409 "Cannot initialize from COMPLETED".
- Frontend initialize page mount effect (page.tsx) called `startInitialize()`
  whenever `getInitializeStatus()` didn't return `INITIALIZING`. For a COMPLETED
  state it fell through to `startInitialize()` -> 409 -> catch `setStartError`
  -> rendered the **"Initialization Failed"** banner (false positive). The
  `useStepGuard` COMPLETED->dashboard redirect raced and didn't reliably win.
- Fix (TDD): in the mount effect, handle terminal states before auto-start —
  COMPLETED -> `router.replace("/onboarding/complete")`; FAILED -> show the real
  `failure.detail` with the retry UI instead of re-starting; only
  PREFERENCES_CONFIGURED (and INITIALIZING w/o run_id) fall through to
  `startInitialize()`. Added 2 regression tests (COMPLETED navigates & does not
  call startInitialize; FAILED does not auto-start).
- Frontend suite: 80 passed / 2 failed (the 2 = pre-existing, confirmed failing on
  original committed code; unrelated polling-fallback tests). No new regressions.

Net: onboarding.initialize now executes end-to-end in the RQ worker and streams
SSE reliably, AND the frontend no longer shows a false failure banner once the
run reaches COMPLETED.

## Runtime follow-up 11: knowledge_construction extracted 0 facts — every chunk "failed" — DONE

Investigated the heads-up from follow-up 10 (5x `knowledge_extraction_chunk_failed
err=<empty>`, kimi-k2.5 logging "Tool #1: ExtractionOutput", 0 facts).

### Root cause (systematic-debugging -> subagent trace -> log timing)
This was NOT a data/parse bug. It was the app's own **10s per-chunk LLM timeout**
firing on every call:

- `_extract` wraps the Strands LLM call in `asyncio.wait_for(..., timeout=
  CHUNK_TIMEOUT_SECONDS=10)` (stages.py). On timeout it catches `Exception` and
  logs `knowledge_extraction_chunk_failed ... err=%s`.
- **Why `err=` is empty**: a bare `asyncio.TimeoutError` (== builtin TimeoutError
  on 3.11+) has `str() == ""` (verified: len 0). So the log is opaque, not a
  real parse error.
- Log timing confirms it exactly: `llm_generate` at 12:02:16.67 -> all 5
  `chunk_failed` at 12:02:26.67 = **9.99s** = the 10s `wait_for` deadline.
- Strands' structured-output/tool-parse path **never raises** (traced
  `structured_output_tool.py`, `event_loop/streaming.py`, tool executors) — it
  returns `None` / retries. So a parse failure cannot produce the empty `err=`.
- "Tool #1: ExtractionOutput" is just Strands' `PrintingCallbackHandler` stdout
  line when the model *begins* the structured-output tool call — i.e. kimi-k2.5
  starts responding but doesn't finish within 10s under 8-way concurrency
  (`LLM_MAX_CONCURRENCY=8`). The evaluation stage using the same model succeeded,
  so it's a latency-budget issue, not a hard model failure.

### Fix (TDD RED->GREEN, per user: "no timeouts, wait for the slower LLM calls")
- `CHUNK_TIMEOUT_SECONDS` is now env-configurable with default `0` = **no
  per-call deadline** (mirrors the `LLM_TOTAL_TOKENS_CAP=0 -> no limit`
  convention). Slow-but-productive providers like kimi-k2.5 get time to complete
  instead of being cut off mid-stream. Set a positive `CHUNK_TIMEOUT_SECONDS`
  env to restore a hard ceiling.
- Added `_llm_with_chunk_timeout(coro)` and used it at BOTH time-limited call
  sites (knowledge extraction + initial evaluation) so the config applies
  consistently. When `>0` it still bounds the call (existing
  "enforces_chunk_timeout" test — which sets 10s->0.1s — still passes).
- Improved failure logging: `err_type=%s` added so any future failure with an
  empty message (e.g. bare TimeoutError) is diagnosable instead of `err=`.
- New regression test `test_knowledge_construction_chunk_timeout_zero_waits_for_slow_llm`
  (RED: with the old code, `monkeypatch CHUNK_TIMEOUT_SECONDS=0` made
  `asyncio.wait_for(timeout=0)` return immediately with TimeoutError -> chunk
  failed, reproducing the production symptom; GREEN: now the slow call completes,
  `knowledge_count==1`).
- Full suite: **809 passed / 6 failed** (the 6 = pre-existing out-of-scope
  openrouter/redis failures, identical to baseline; +1 passing test, 0 regressions).

Note: the live org's onboarding is already COMPLETED, so a re-run is needed to
re-extract knowledge with the new no-timeout default. This is a forward fix; it
does not retroactively persist facts for run 8ac5fc1b.

## Runtime follow-up 12: onboarding jobs row stuck at "pending" — DONE

Symptom: while the init flow COMPLETED, the `jobs` table row for run 8ac5fc1b
still showed `status='pending'`, `last_run_at=NULL`.

### Root cause (systematic-debugging -> jobs_store trace + live DB)
The `jobs` row is only ever CREATED, never transitioned, for onboarding:
- `start_initialization`/`_execute_initialization` call
  `repos.jobs.upsert_on_conflict(..., job_type="onboarding", ...)`, which
  defaults `status="pending"` (jobs_store.py insert/upsert_on_conflict).
- `repos.jobs.update_status(...)` is wired ONLY for the documentation job
  driver (documentation.py sets "completed"/"failed"). The onboarding path
  never calls it: `onboarding_initialize_done` (initialize.py) just logged, and
  the RQ worker's own job completion does not write to this DB table.
So the row was bookkeeping (created for /stream-ticket, follow-ups 1-2) that
onboarding never flipped out of its default "pending" zero state. Verified live:
both rows for the org were `pending` with `last_run_at=NULL`.
Note: `update_status` matches `WHERE run_id = $2` (the param is named job_id
but refers to run_id), so the workflow passes `state.run_id` as job_id.

### Fix (TDD RED->GREEN)
Added a best-effort `_set_job_status(status)` helper inside
`run_onboarding_initialize` (guarded try/except so bookkeeping never fails the
workflow; no-op when `context.repositories.jobs` is absent). Called on every
terminal path:
- completion (`onboarding_initialize_done`) -> status "completed"
- `except Exception` failure handler -> "failed"
- watchdog `TimeoutError` handler -> "failed"
- early "No repository selected" FAILED path -> "failed"

New tests: `test_initialize_workflow_marks_job_completed` (asserts
`jobs.update_status(job_id=run_id, status="completed")` after a delivered run)
and `test_initialize_workflow_marks_job_failed_on_error` (asserts "failed").
Both RED->GREEN. Test helpers `_context()` + `fake_repositories` now stub
`jobs.update_status = AsyncMock`.
Full suite: 811 passed / 6 failed (6 = unchanged pre-existing
openrouter/redis out-of-scope failures; +2 passing tests, 0 regressions).

### Live reconciliation
Fix is forward-only; the already-completed run 8ac5fc1b would stay `pending`
forever. Authoritative completed run = `selected_repository.init_run_id` =
8ac5fc1b, so I set that row's status to `completed` (+ `last_run_at=now()`).
The stale `7f5a0690` row (earlier superseded attempt, terminal state unknown)
was left untouched.


