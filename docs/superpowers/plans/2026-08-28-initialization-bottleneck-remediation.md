# Initialization Workflow Bottleneck Remediation — Full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Eliminate correctness, latency, and resiliency bottlenecks in the onboarding initialization pipeline (backend → frontend). End-to-end init for a 100-file / 500-chunk repo shrinks from ~35–90 min to ~4–6 min; remove concurrent/duplicate-work hazards; give the UI a fallback path when SSE is interrupted.

**Priority tiers (from brainstorming analysis):**
- **Part A (P0 — Correctness):** single-flight init guard + resumable page, SSE replay/dedupe, org-scoped vector queries.
- **Part B (P1 — Latency):** concurrent GitHub sync + client reuse, bulk chunk deletes, batched DB inserts, parallel LLM stages + enforced timeout, sampled LLM evaluation.
- **Part C (P2 — Resiliency/UX):** move init to RQ worker, live throttled progress, watchdog + frontend status fallback.

**Architecture:**

```
POST /onboarding/initialize
  ├─ Redis init-lock (NX/TTL)                       [P0-1]
  ├─ enqueue onboarding.initialize (RQ default)     [P2-1]
  │    └─ run_onboarding_initialize (initialize.py)
  │        Stage 1 repository_ingestion  → SyncService.sync        [P1]
  │        Stage 2 knowledge_construction → stages.py              [P1]
  │        Stage 3 initial_evaluation     → stages.py              [P1]
  │        Stage 4 health_report          → stages.py              (unchanged)
  │        Stage 5 recommendations        → stages.py              (bounded concurrency)
  │    └─ timeout watchdog closes run                [P2-3]
Events → _TeePublisher (Redis Stream + Postgres) → SSE route       [P0-2]
Frontend: resume-from-status instead of blind re-POST [P0-1]
          lastSeq dedupe in useWorkflowEvents         [P0-2]
          status polling fallback when SSE exhausted  [P2-3]
```

**Tech Stack:** Python 3.11/3.12 (asyncio, FastAPI, asyncpg, httpx, structlog, rq); Next.js 15 (React, TypeScript, Vitest); Redis (Streams + locks); NeonDB/Postgres (pgvector, GIN).

**Specs/refs:** `reference/redis-streams-sse.md`; `docs/superpowers/specs/2026-08-27-onboarding-progress-analysis.md`.

## Global Constraints

- asyncio only (no threads for LLM/DB work); all stage functions stay `async`
- No changes to public `StreamEnvelope` format or SSE ticket auth; stream key `draftly:stream:{run_id}` + `maxlen=1000` unchanged
- Enforce `CHUNK_TIMEOUT_SECONDS = 10` (currently declared-but-unused); keep 500-chunk cap
- LLM concurrency bounded + configurable (`LLM_MAX_CONCURRENCY`, default 8)
- structlog; backend tests `unittest.mock` + `pytest.mark.asyncio`; Vitest for frontend; ruff + eslint clean
- New migrations start at `035` (latest is `034`)
- RQ move keeps an in-process fallback so tests / local single-process mode stay green
- **Strict TDD (red → green → refactor):** every task starts with a "Write failing tests" step — run them, confirm they fail for the expected reason, and only then implement. No production code without a failing test demanding it.

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/draftly/app/api/routes/onboarding.py` | Modify | P0-1 lock + `init_run_id`; P2-1 RQ enqueue; P2-3 watchdog |
| `backend/src/draftly/app/api/routes/workflows.py` | Modify | P0-2 seed `min_live_seq` from replay |
| `backend/src/draftly/events/redis_stream_bus.py` | Modify | P0-2 `last_id` pass-through (exists) + coverage |
| `backend/src/draftly/integrations/database/vector_search.py` | Modify | P0-3 org filter |
| `backend/src/draftly/persistence/repositories/memory.py` | Modify | P0-3 org pass-through |
| `backend/src/draftly/memory/repository.py` | Modify | P0-3 org on `search`; P1 bulk delete + bulk insert |
| `backend/src/draftly/memory/retrieval.py` | Modify | P0-3 org on `retrieve` |
| `backend/src/draftly/memory/service.py` | Modify | P0-3 org on `recall` |
| `backend/src/draftly/integrations/database/memory_store.py` | Modify | P1 `insert_batch` + bulk `delete_by_metadata` |
| `backend/src/draftly/workflows/onboarding/stages.py` | Modify | P1 concurrency/timeout/sampling/fact batching |
| `backend/src/draftly/workflows/onboarding/initialize.py` | Modify | P2 live progress flush; P1 session plumbing |
| `backend/src/draftly/documentation/sync_service.py` | Modify | P1 bounded-concurrency sync |
| `backend/src/draftly/integrations/github/client.py` | Modify | P1 reusable AsyncClient |
| `backend/src/draftly/persistence/migrations/035_memory_org_and_meta.sql` | Create | P0-3/P1 indexes |
| `backend/workers/rq_worker.py` (repo-root `workers/` package) | Modify | P2: extend the **existing** RQ worker (init-lock release); repoint Dockerfile CMD |
| `backend/docker/Dockerfile.worker` | Modify | P2 CMD → `workers.rq_worker` |
| `frontend/hooks/use-workflow-events.ts` | Modify | P0-2 `lastSeq` dedupe |
| `frontend/app/(onboarding)/onboarding/initialize/page.tsx` | Modify | P0-1 resume + P2 polling |
| Backend + frontend tests (per task) | Modify/Create | Regression + new behavior |

## Part A: P0 — Correctness

---

### Task 1: Single-flight init guard + resumable initialize page

**Why:** Two hazards today. (1) `POST /initialize` deliberately re-runs from `INITIALIZING` (`onboarding.py:426-430`), and the page fires `startInitialize()` on every mount when `runId` is null (`initialize/page.tsx:132-144`) — refresh during a run starts a **second concurrent pipeline** (duplicate GitHub calls, duplicate LLM spend, two writers to one corpus). (2) Run state is lost on refresh because the active `run_id` is never persisted, so the frontend cannot resume; its only move is a duplicate re-POST.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py`
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py` (extend — init-route tests already live here)
- Test: `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`

**Interfaces:**
- Consumes: redis at `request.app.state.draftly.redis_client.native`; existing `repos.onboarding.upsert`.
- Produces: `init_run_id` persisted in `selected_repository`; `GET /initialize/status` returns `run_id`; locked `POST /initialize` returns current `INITIALIZING` state with `resumed: true` instead of starting a second run.

- [ ] **Step 1: Write failing tests (red)**

- Backend (`tests/api/test_onboarding_routes.py`): double `POST /initialize` — second call returns 200 with the **first** run's `run_id` + `resumed: true`; workflow invoked **once** (mock `worker.run_task` + fake redis: first `set` returns True, subsequent return None).
- Backend: lock released in `finally` on workflow exception.
- Backend: no Redis on `app.state` → POST still succeeds (graceful fail-open; single-process mode stays green).
- Backend: `GET /initialize/status` includes `run_id`.
- Frontend (`tests/pages/initialize-page.test.tsx`): mount → `getInitializeStatus` returns `INITIALIZING` + `run_id` → hook called with that `run_id`, `startInitialize` **not** called.
- Frontend: default path still calls `startInitialize`, passes returned `run_id`/`ticket`.

Run `cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_onboarding_routes.py -q` and `cd draftly-agent-frontend && npx vitest run tests/pages/initialize-page.test.tsx` — confirm the new tests fail for the expected reasons before touching production code.

- [ ] **Step 2: Add Redis init-lock helpers in `onboarding.py`**

Add near `_init_worker_guard`:

```python
_INIT_LOCK_TTL_SECONDS = 7200  # MUST exceed the longest legitimate run. Raised from 600s: pre-P1
                               # runs take 35–90 min, so a 10-min TTL expired mid-run and let a
                               # refresh start a duplicate pipeline — the exact hazard this guards.
                               # Task 11's watchdog (1200s) is authoritative once shipped: keep
                               # TTL >= watchdog. CAS-keyed release stays safe across TTL expiry.

def _init_lock_key(org_id: str) -> str:
    return f"onboarding:init-lock:{org_id}"

def _redis(request: Request):
    """Redis client or None. Degrades gracefully: local/single-process mode and
    unit tests run without Redis, and the global constraints require they stay
    green — so a missing Redis means "no lock", never a 503."""
    redis_client = getattr(request.app.state.draftly, "redis_client", None)
    return redis_client.native if redis_client is not None else None

async def _try_acquire_init_lock(request: Request, org_id: str, run_id: str) -> bool:
    """True if this caller owns the lock (idempotent per run_id)."""
    redis = _redis(request)
    if redis is None:  # fail-open: without Redis there is no multi-process hazard
        return True
    acquired = await redis.set(
        _init_lock_key(org_id), run_id, nx=True, ex=_INIT_LOCK_TTL_SECONDS
    )
    if acquired or str(await redis.get(_init_lock_key(org_id))) == run_id:
        return True
    return False

async def _release_init_lock(request: Request, org_id: str, run_id: str) -> None:
    redis = _redis(request)
    if redis is None:
        return
    current = await redis.get(_init_lock_key(org_id))
    # NOTE: get-then-delete is not atomic; the run_id comparison makes a stale
    # release harmless (it never deletes a newer run's lock). Upgrade to a Lua
    # compare-and-delete only if exactness ever matters here.
    if current and str(current) == run_id:
        await redis.delete(_init_lock_key(org_id))
```

- [ ] **Step 3: Acquire lock + persist `run_id` in `_execute_initialization`**

After computing `run_id`:

```python
if not await _try_acquire_init_lock(request, org_id, run_id):
    current = await repos.onboarding.get(org_id)
    return {
        "state": "INITIALIZING",
        "run_id": (current or {}).get("selected_repository", {}).get("init_run_id"),
        "resumed": True,
    }
```

Persist run id (replaces the bare `upsert(state="INITIALIZING")` at `onboarding.py:380`):

```python
await repos.onboarding.upsert(
    org_id,
    state="INITIALIZING",
    failure=None,
    selected_repository={
        **(selected_repository or {}),
        "init_run_id": run_id,
    },
)
```

- [ ] **Step 4: Release the lock when the background run finishes**

In `_run_background`, wrap workflow execution in `try/finally` and call `_release_init_lock(request, org_id, run_id)` in `finally`.

- [ ] **Step 5: Return `run_id` from `GET /initialize/status`**

Add `"run_id": _selected(current).get("init_run_id")` to the response dict.

- [ ] **Step 6: Frontend — resume instead of blind re-POST**

Replace the mount effect in `initialize/page.tsx`:

```ts
useEffect(() => {
  if (runId) return;
  let cancelled = false;
  (async () => {
    try {
      const status = await getInitializeStatus();
      if (status.state === "INITIALIZING" && status.run_id) {
        setRunId(status.run_id);          // hook fetches a fresh ticket itself
        return;
      }
      const res = await startInitialize();
      if (res.run_id && res.ticket) {
        setRunId(res.run_id);
        setTicket(res.ticket);
      } else {
        setStartError("Initialization did not start.");
      }
    } catch {
      if (!cancelled) setStartError("We couldn't start initialization.");
    }
  })();
  return () => { cancelled = true; };
}, [runId]);
```

`useWorkflowEvents` already fetches a fresh one-time ticket when `ticket` is undefined (`use-workflow-events.ts:120-133`), so resume works with just `runId`.

- [ ] **Step 7: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_onboarding_routes.py -q
cd draftly-agent-frontend && npx vitest run tests/pages/initialize-page.test.tsx
```

---

### Task 2: SSE replay/dedupe — no duplicate events on connect or reconnect

**Why:** On connect/reconnect the server replays persisted events from Postgres (`workflows.py:169-177`), then pumps the Redis stream **from `"0"`** (`workflows.py:101` → `bus.subscribe(run_id)` default `last_id="0"`). With `min_live_seq=0` (no `Last-Event-ID`), the `seq <= min_live_seq` filter (`workflows.py:121`) drops nothing → same events delivered twice → duplicated stage rows + repeated `workflow_result` handling. The frontend also defeats the browser's automatic `Last-Event-ID` by manually closing/re-creating `EventSource` (`use-workflow-events.ts:92-161`), so every reconnect replays the stream.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflows.py`
- Modify: `draftly-agent-frontend/hooks/use-workflow-events.ts`
- Test: `draftly-agent-backend/tests/api/test_workflows_stream.py` (extend; starlette variant: `test_workflows_sse_starlette.py`)
- Test: `draftly-agent-frontend/__tests__/hooks/use-workflow-events.test.ts`

**Interfaces:**
- Consumes: `replayed: list[dict]` built in `stream_events`; `StreamEnvelope.seq` (app-level monotonic counter).
- Produces: `min_live_seq` = max replayed seq when no `Last-Event-ID`; client-side `lastSeqRef` filtering.

- [ ] **Step 1: Write failing tests (red)**

- Backend (`tests/api/test_workflows_stream.py`): no `Last-Event-ID`; replay has seqs 1–3 and live pump yields 1–4 → assert exactly one of each 1–4 and one `workflow_result` termination — fails today (1–3 delivered twice).
- Frontend (`__tests__/hooks/use-workflow-events.test.ts`): emit 1, 2, 3 then re-emit 2, 1 → assert 3 events total — fails today (5 events).
- Frontend: reconnect replay starting at seq 2 → assert only new seqs appended.

Run both suites and confirm the new tests fail with duplicates before implementing.

- [ ] **Step 2: Backend — derive `min_live_seq` from replay when no `Last-Event-ID`**

In `stream_events`, after building `replayed`:

```python
if replayed and not last_event_id.isdigit():
    min_live_seq = max(int(r.get("seq") or 0) for r in replayed)
    # Live-pump filter (envelope.seq <= min_live_seq) then drops the
    # already-replayed events; only newer seqs reach the client.
```

(The `Last-Event-ID` branch already sets `min_live_seq` from the header.)

- [ ] **Step 3: Backend — dedupe replayed rows by seq**

After `replayed = await events_repo.list_after(...)`, collapse duplicate seqs:

```python
seen: set[int] = set()
deduped = []
for row in replayed:
    seq = int(row.get("seq") or 0)
    if seq in seen:
        continue
    seen.add(seq)
    deduped.append(row)
replayed = deduped
```

- [ ] **Step 4: Frontend — monotonic `lastSeq` dedupe in `apply`**

In `use-workflow-events.ts`:

```ts
const lastSeqRef = useRef(0);

const apply = useCallback((event: StreamEvent) => {
  const seq = Number(event.seq ?? 0);
  if (seq && seq <= lastSeqRef.current) return;   // duplicate frame
  if (seq) lastSeqRef.current = seq;
  setEvents((prev) => [...prev.slice(-500), event]);
  // ...existing nodeStates / text / workflow_result handling unchanged
}, []);
```

Reset `lastSeqRef.current = 0` at the top of the effect body when `runId` changes (new run = new seq space). `seq` stays out of React state → no re-render from the dedupe check alone.

- [ ] **Step 5: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_workflows_stream.py tests/api/test_workflows_sse_starlette.py -q
cd draftly-agent-frontend && npx vitest run __tests__/hooks/use-workflow-events.test.ts
```

---

### Task 3: Org-scope all vector/memory queries

**Why:** `MemoryRetrieval.retrieve` → `DomainMemoryRepository.search` → `VectorSearch.search` never filters by `org_id` (`vector_search.py:46-61`). The `"*"`-query recalls in `stages.py` (`run_knowledge_construction` and `run_initial_evaluation`) can therefore return **another tenant's documents**; the resulting scores/extractions are poisoned. `delete_by_metadata` filters org in Python (correct but slow — fixed in Task 5).

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/database/vector_search.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/memory.py`
- Modify: `draftly-agent-backend/src/draftly/memory/repository.py`
- Modify: `draftly-agent-backend/src/draftly/memory/retrieval.py`
- Modify: `draftly-agent-backend/src/draftly/memory/service.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/035_memory_org_and_meta.sql`
- Test: `draftly-agent-backend/tests/unit/memory/` (search org-scoping)
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `org_id: str` already available at every call site (`run_knowledge_construction`, `run_initial_evaluation`).
- Produces: org-id threaded `recall → retrieve → search → semantic_search → SQL WHERE mi.org_id = $N`.

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/memory/`): `search` returns only records whose `org_id` matches (mock DB rows with two orgs) — fails today: the SQL has no org filter.
- Unit: `recall(org_id=...)` propagates org to the SQL layer (assert `fetch_all` called with org param) — fails today: no `org_id` parameter.
- Unit: migration `035_memory_org_and_meta.sql` exists and contains the three index DDLs (file-content smoke test).
- Regression: run `tests/unit/workflows/test_onboarding_stages.py` first to capture the baseline before mocks change.

Confirm the failures before implementing.

- [ ] **Step 2: Migration `035` — org + metadata indexes**

```sql
-- 035_memory_org_and_meta.sql
-- Org-scoped vector lookup and metadata deletes for onboarding init.

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_org
    ON memory_embeddings (org_id);

CREATE INDEX IF NOT EXISTS idx_memory_items_org_namespace
    ON memory_items (org_id, namespace);

-- Enables bulk DELETE ... WHERE metadata->>'document_id' = $1 (Task 5).
CREATE INDEX IF NOT EXISTS idx_memory_items_metadata_gin
    ON memory_items USING GIN (metadata);
```

- [ ] **Step 3: `VectorSearch.search(org_id=...)`**

Add `org_id: str | None = None` parameter (new callers pass it) and, when provided, add `AND mi.org_id = $3` (re-index params: vector, namespace, org_id, limit).

- [ ] **Step 4: Thread `org_id` through the stack**

- `persistence/repositories/memory.py::semantic_search` — add `org_id`, pass through.
- `memory/repository.py::search` — add `org_id`, pass through.
- `memory/retrieval.py::retrieve` — add `org_id`, pass to `self.repository.search`.
- `memory/service.py::recall` — add `org_id` (default `None`; init call sites must pass it), pass through.
- `stages.py` — both `recall(...)` calls pass `org_id=org_id`.

Keep `recall_knowledge` org-scoped too (it shares `retrieve`).

- [ ] **Step 5: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/memory tests/unit/workflows/test_onboarding_stages.py -q
```

---
## Part B: P1 — Latency

---

### Task 4: Concurrent GitHub sync + connection reuse

**Why:** `_request` creates a brand-new `httpx.AsyncClient` per call (`github/client.py:111-113, 144-146`) — DNS/TCP/TLS handshake per request. `SyncService.sync` processes files **strictly serially** (`sync_service.py:106-208`): each file = `get_file_contents` + `get_last_commit_date` + hash-check + parse/chunk + per-chunk DB writes. A 100-file repo ≈ 200 sequential network round trips × 0.3–1s each before DB work even starts.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/github/client.py`
- Modify: `draftly-agent-backend/src/draftly/documentation/sync_service.py`
- Test: `draftly-agent-backend/tests/unit/documentation/test_sync_service.py`

**Interfaces:**
- Consumes: existing `github` client methods (unchanged signatures).
- Produces: shared `httpx.AsyncClient` on the GitHub client; `SyncService` bounded-concurrency file loop (default 8).

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/documentation/test_sync_service.py`): 20 doc paths + mocked github → all files processed, counts correct, and calls overlap (use a barrier/semaphore-aware fake to prove `get_file_contents` concurrency) — fails today: the loop is strictly serial.
- Unit: a failing file does not abort siblings; `failed_files` populated.
- Regression: hash-skip and commit-date-cap tests remain green throughout.

Confirm the concurrency tests fail before implementing.

- [ ] **Step 2: Reusable `httpx.AsyncClient` in `GitHubClient`**

Add a lazily-created pooled client and use it in `_request`/`_request_text`:

```python
def _client(self) -> httpx.AsyncClient:
    if self._shared_client is None:
        self._shared_client = httpx.AsyncClient(
            timeout=self.timeout,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return self._shared_client
```

Refactor `_request`/`_request_text` to use `async with ...` → `await self._client().request(...)`. Keep per-call `Authorization` header overwrite as today. Do not close per call; add `aclose()` teardown matching codebase lifecycle style.

- [ ] **Step 3: Bounded-concurrency file loop in `SyncService.sync`**

Wrap the existing per-file body (get_file_contents → hash-skip → parse/chunk → upsert → chunk store → progress) into an inner `_process(path)` and run with a semaphore:

```python
sem = asyncio.Semaphore(8)
async def _worker(path: str) -> None:
    async with sem:
        try:
            await _process(path)
        except Exception:
            logger.exception("sync_file_failed path=%s", path)
            result.failed_files.append(path)

await asyncio.gather(*(_worker(path) for path in doc_paths))
```

Notes: `result`/`on_progress` mutation is single-thread-safe (event loop). Hash-skip + `get_last_commit_date` cap behavior preserved per file. Keep `result.baseline` creation unchanged.

- [ ] **Step 4: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/documentation/test_sync_service.py -q
```

### Task 5: Bulk delete of stale chunks

**Why:** Per file, sync deletes the document's old chunks via `DomainMemoryRepository.delete_by_metadata` (`memory/repository.py:104-121`), which calls `list_namespace` — a full **unfiltered** `SELECT * FROM memory_items WHERE namespace=$1` (every org, every chunk: `memory_store.py:224-239`) — then deletes chunk-by-chunk, one transaction each. Complexity ≈ F × (N + C) round trips — the dominant DB bottleneck in Stage 1.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/database/memory_store.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/memory.py`
- Modify: `draftly-agent-backend/src/draftly/memory/repository.py`
- Test: `draftly-agent-backend/tests/unit/memory/`

**Interfaces:**
- Consumes: `MemoryNamespaces.DOCUMENTS`, `org_id`, `metadata["document_id"]`.
- Produces: single-transaction `DELETE` scoped by `(org_id, namespace, metadata->>'document_id')`.

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/memory/`): bulk delete issues exactly one transaction, SQL contains `metadata->>$3 = $4` and `org_id = $1`, returns count (mock client) — fails today: `delete_by_metadata_bulk` doesn't exist.
- Unit: `org_id=None` path keeps the old fallback behavior.
- Regression: existing `tests/unit/memory/test_delete_by_metadata.py` tests stay green.

Confirm the failures before implementing.

- [ ] **Step 2: `DatabaseMemoryStore.delete_by_metadata_bulk`**

```python
async def delete_by_metadata_bulk(
    self, *, namespace: str, key: str, value: str, org_id: str
) -> int:
    """Delete all items for one document atomically. Returns deleted count."""
    async with self.client.transaction() as conn:
        await self.client.execute_conn(conn, """
            DELETE FROM memory_embeddings
            WHERE memory_item_id IN (
                SELECT id FROM memory_items
                WHERE org_id = $1 AND namespace = $2 AND metadata->>$3 = $4
            )
        """, org_id, namespace, key, value)
        row = await self.client.fetch_one_conn(conn, """
            WITH deleted AS (
                DELETE FROM memory_items
                WHERE org_id = $1 AND namespace = $2 AND metadata->>$3 = $4
                RETURNING id
            )
            SELECT count(*)::int AS deleted FROM deleted
        """, org_id, namespace, key, value)
        return int(row["deleted"]) if row else 0
```

> ⚠️ Two constraints. (1) Postgres **forbids aggregates in `RETURNING`** — `DELETE ... RETURNING count(*)` fails with `aggregate functions are not allowed in RETURNING`; the count must come from a CTE over the returned `id`s (see above). (2) Check migrations whether `memory_embeddings.memory_item_id` has `ON DELETE CASCADE`; if so, drop the first `DELETE`. (It does — migration `003` cascades — so the single CTE `DELETE` over `memory_items` alone is correct.)

- [ ] **Step 3: Wire through repositories**

- `persistence/repositories/memory.py::delete_by_metadata` — delegate to `store.delete_by_metadata_bulk` when `org_id` given; keep old scan fallback when org is None.
- `memory/repository.py::delete_by_metadata` — pass `org_id` through (it already has it) instead of the full-namespace Python filter loop.

- [ ] **Step 4: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/memory tests/unit/documentation/test_sync_service.py -q
```

---

### Task 6: Batched DB inserts (chunks + extracted facts)

**Why:** `store_batch` embeds all texts in one `embed_batch` (good) but then inserts each row in its **own transaction** (`memory_store.py:39-112`, `repository.py:123-142`) — 1 chunk = 1 txn. Task 4's concurrency makes this worse (up to 8 parallel single-insert txns). Stage 2 stores each extracted fact with its own `remember()` → own embed call + own txn (`stages.py:199-208`).

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/database/memory_store.py`
- Modify: `draftly-agent-backend/src/draftly/memory/repository.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Test: `draftly-agent-backend/tests/unit/memory/`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: existing `insert` column ordering; `store_batch(items)` signature.
- Produces: `insert_batch(items, embeddings)` — one transaction per batch; `store_batch` delegates.

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/memory/`): `store_batch` with a fake store asserts exactly **one** transaction for N items — fails today: one txn per item.
- Unit (`tests/unit/workflows/test_onboarding_stages.py`): extraction stage calls `context.memory.store_batch` once per 50-chunk batch with all extracted facts — fails today: per-fact `remember()`.

Confirm the failures before implementing.

- [ ] **Step 2: `DatabaseMemoryStore.insert_batch`**

```python
async def insert_batch(
    self,
    *,
    items: Sequence[dict],  # normalized: org_id, namespace, memory_type, content, importance, confidence, metadata, embedding
    model: str = "text-embedding-3-small",
    dimensions: int = 1536,
) -> list[dict[str, Any]]:
    memory_ids = [str(uuid4()) for _ in items]
    rows = []
    async with self.client.transaction() as conn:
        for item, memory_id in zip(items, memory_ids):
            row = await self.client.fetch_one_conn(conn, "INSERT INTO memory_items ... RETURNING <columns>", ...)
            await self.client.execute_conn(conn, "INSERT INTO memory_embeddings ...", ...)
            rows.append(row)
    return [self._row_to_memory(r) for r in rows]
```

(Prefer a single multi-row `VALUES` executemany if the DB driver allows; per-item statements inside one transaction is the baseline.)

- [ ] **Step 3: `store_batch` delegates + batch fact storage in Stage 2**

Keep the single `embed_batch`, then hand the whole batch to `insert_batch` (drop the per-item `repository.create` loop).

In `run_knowledge_construction`, collect `facts: list[Knowledge]` per 50-chunk batch and call `context.memory.store_batch(facts)` once at batch end (replaces per-fact `remember()`). Relationships/procedures stay per-item (low volume).

- [ ] **Step 4: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/memory tests/unit/workflows/test_onboarding_stages.py -q
```

### Task 7: Parallel LLM stages + enforced timeout + session reuse

**Why:** Stages 2 and 3 run up to **500 serial LLM calls each** (`stages.py:179-244` extraction; `stages.py:326-341` evaluation). At 2–5 s/call that is 15–40 min per stage. `CHUNK_TIMEOUT_SECONDS = 10` (`stages.py:68`) is **never used** — a hung provider stalls the workflow forever. A fresh `Agent(model=model)` is constructed per chunk (`stages.py:71-75`).

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `context.model` (unchanged), `CHUNK_BATCH_SIZE=50`.
- Produces: `LLM_MAX_CONCURRENCY = 8`; `_llm_generate(model, prompt, agent=None)` reusing an agent; per-chunk `asyncio.wait_for(..., CHUNK_TIMEOUT_SECONDS)`.

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/workflows/test_onboarding_stages.py`): mock `_llm_generate` sleeping > timeout → chunk lands in `failed_chunks`, batch continues — fails today: no timeout is enforced.
- Unit: concurrency cap — fake LLM tracks max in-flight; assert `<= LLM_MAX_CONCURRENCY` — fails today: calls are serial.
- Unit: `_parse_extraction` handles fenced / unfenced / invalid JSON — fails today: the function doesn't exist (logic is inline).
- Regression: existing stage tests stay green.

Confirm the failures before implementing.

- [ ] **Step 2: Extend the existing `_llm_generate` for agent reuse**

`_llm_generate` already exists at `stages.py:71` (it constructs `Agent(model=model)` on every call) — add an optional reuse parameter rather than a new function:

```python
async def _llm_generate(model: Any, prompt: str, agent: Any | None = None) -> str:
    if agent is None:
        agent = Agent(model=model)
    result = await agent.invoke_async(prompt)
    return str(result)
```

Create `agent = Agent(model=context.model)` once per stage and reuse for every chunk/doc.

- [ ] **Step 3: Bounded concurrency + timeout in `run_knowledge_construction`**

```python
sem = asyncio.Semaphore(LLM_MAX_CONCURRENCY)
async def _extract(chunk: dict) -> tuple[dict | None, str]:
    content = chunk.get("content", "")
    cid = chunk.get("id", "unknown")
    if not content.strip():
        return None, cid
    prompt = EXTRACTION_PROMPT.format(content=content[:2000])
    try:
        raw = await asyncio.wait_for(
            _llm_generate(context.model, prompt, agent=agent),
            timeout=CHUNK_TIMEOUT_SECONDS,
        )
        return _parse_extraction(raw), cid
    except Exception as exc:   # TimeoutError subclasses Exception on 3.11+ — caught here too; no redundant tuple
        logger.warning("knowledge_extraction_chunk_failed chunk=%s err=%s", cid, exc)
        return None, cid

results = await asyncio.gather(*(_extract(c) for c in batch))
```

Persist successes per batch; any `None` parsed result → `failed_chunks.append(cid)`. Keep the per-batch `tool_progress` / `stage_progress` publishes unchanged.

- [ ] **Step 4: Same pattern in `run_initial_evaluation`**

Apply the same semaphore + `wait_for` over the **sampled** docs (Task 8). Recommendations already make one LLM call — call `_llm_generate(model, prompt, agent=agent)` for symmetry.

- [ ] **Step 5: Extract `_parse_extraction`**

Move the markdown-fence-strip + `json.loads` block (inline at `stages.py:190-197`) into `_parse_extraction(raw: str) -> dict | None` so it is unit-testable and the concurrency path stays clean.

- [ ] **Step 6: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
```

---

### Task 8: Sample the LLM evaluation pass

**Why:** `run_initial_evaluation` calls the LLM **once per document** (up to 500 calls) for a 0.6-weight blend on top of heuristics that already scan the full corpus (`stages.py:321-341`, `HEURISTIC_WEIGHT=0.4`, `LLM_WEIGHT=0.6`). Marginal value of the 500th call is ~nil.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: heuristic dimensions computed over all docs.
- Produces: deterministic sample of ≤ `EVAL_LLM_SAMPLE_SIZE = 25` docs; `llm_count` scales the blend as before.

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/workflows/test_onboarding_stages.py`): 500 docs → exactly 25 LLM calls; 10 docs → 10 calls — fails today: one call per doc (500).
- Unit: sampling deterministic (two runs → same ids) — fails today: `_sample_docs` doesn't exist.
- Unit: heuristics still computed over all 500.

Confirm the failures before implementing.

- [ ] **Step 2: Deterministic sampling**

```python
EVAL_LLM_SAMPLE_SIZE = 25

def _sample_docs(docs: list[dict], k: int = EVAL_LLM_SAMPLE_SIZE) -> list[dict]:
    if len(docs) <= k:
        return list(docs)
    step = len(docs) / k
    return [docs[int(i * step)] for i in range(k)]   # deterministic spread, no RNG
```

- [ ] **Step 3: Use the sample in the LLM loop**

Iterate `_sample_docs(docs)` in place of `docs`. Keep the existing `HEURISTIC_WEIGHT`/`LLM_WEIGHT` blend math — only the call count is capped. Add `logger.info("initial_evaluation_sampled sampled=%d total=%d", llm_count, total)`.

- [ ] **Step 4: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
```

---

## Part C: P2 — Resiliency & UX

---

### Task 9: Move `onboarding.initialize` to the RQ worker

**Why:** Initialization runs **inside the API process** via `asyncio.create_task(_run_background())` → `worker.run_task(...)` (`onboarding.py:382-411`). Tens of minutes of LLM + GitHub I/O share the API event loop with every other request; no scaling, no queue observability, and process restarts kill runs. Codebase-review corrections — do **not** create any new worker module:
- `workers/rq_worker.py` (repo-root `workers/` package) **already exists**: a `SimpleWorker` consuming all three queues (`scheduled`, `webhooks`, `default`) via `build_rq_queues`, composing dependencies through `create_application` (`app.lifecycle`), with signal handling. Extend it; don't recreate it.
- `QUEUE_MAP["onboarding.initialize"] → "default"` (`rq_jobs.py`) is wired but nothing enqueues to it.
- `docker/Dockerfile.worker` runs `workers.event_worker`, which **exists but is the wrong workload**: it serves the FastAPI app under uvicorn (an API replica), so the "worker" container consumes no queues.

**Files:**
- Modify: `draftly-agent-backend/workers/rq_worker.py` (post-run init-lock release)
- Modify: `draftly-agent-backend/docker/Dockerfile.worker` (CMD → `workers.rq_worker`)
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py`
- Modify (pure move): extract Task 1's lock helpers from `onboarding.py` into `src/draftly/app/services/init_lock.py` so the worker process can import them; the route re-imports from there (tests stay green)
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py` (extend — init-route tests already live here)

**Interfaces:**
- Consumes: `build_rq_queues`, `enqueue_job`, `DatabaseJobsStore`, existing `TASK_REGISTRY`, existing `workers/rq_worker.py`.
- Produces: the worker container actually consumes `draftly:default`; the init route enqueues and returns `run_id`+`ticket` immediately; in-process `worker.run_task` fallback when RQ is disabled.

- [ ] **Step 1: Write failing tests (red)**

- Backend (`tests/api/test_onboarding_routes.py`): `_execute_initialization` with mocked RQ asserts `enqueue_job` called with `task_name="onboarding.initialize"`, `run_id`, `org_id`; returns immediately (no `worker.run_task` call); `jobs.insert` got `job_id=run_id`.
- Backend: RQ-disabled config falls back to in-process `worker.run_task` (pins today's fallback behavior).
- Backend: after the worker-side workflow finishes, the Redis init lock is released (fake redis: key gone).

Run the suite and confirm the new tests fail for the expected reasons before implementing.

- [ ] **Step 2: Route enqueues instead of `create_task`**

Replace the `asyncio.create_task(_run_background())` block in `_execute_initialization`:

```python
rq_queues = getattr(request.app.state.draftly, "rq_queues", None)
task_handlers = getattr(request.app.state.draftly, "task_handlers", None)
if rq_queues is not None and task_handlers is not None and config.rq_enabled:
    job = enqueue_job(
        queues=rq_queues, task_handlers=task_handlers,
        task_name="onboarding.initialize",
        org_id=org_id, selected_repository=selected_repository, run_id=run_id,
    )
    store = DatabaseJobsStore()
    await store.insert(
        job_id=run_id, org_id=org_id, name="onboarding.initialize",
        job_type="onboarding", schedule="manual",
        configuration={"rq_job_id": job.id},
    )
else:
    asyncio.create_task(_run_background())   # fallback: local/single-process mode
```

`jobs.insert(job_id=run_id, ...)` keeps `POST /workflows/{run_id}/stream-ticket` working (it validates `jobs.get(job_id=run_id)` + org match — `workflows.py:59-65`). If `rq_queues`/`task_handlers` are not yet exposed on `app.state.draftly`, wire them in `app/lifecycle.py` beside the existing redis client.

- [ ] **Step 3: Dockerfile.worker**

Change `CMD ["workers.event_worker"]` → `CMD ["workers.rq_worker"]` (one line; the module already exists at the repo-root `workers/` package).

- [ ] **Step 4: Lock lifecycle across processes**

Task 1's init lock now spans API + worker processes. The worker-side workflow already sets state FAILED/COMPLETED (`initialize.py:236-263`). In `workers/rq_worker.py`, wrap handler execution: after the `onboarding.initialize` task returns (success or failure), call the release helper from the extracted `app/services/init_lock.py` module using the worker's existing Redis connection, with `run_id` passed in the job kwargs. Decision: (a) explicit release in the worker (**chosen** — correct), with (b) the TTL as crash backstop; `_INIT_LOCK_TTL_SECONDS` (Task 1, 7200s) must stay ≥ the Task 11 watchdog (1200s).

- [ ] **Step 5: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_onboarding_routes.py tests/test_workers -q
# manual: start rq_worker, POST /onboarding/initialize, confirm job runs in worker process
```

---
### Task 10: Live throttled progress during `repository_ingestion`

**Why:** Stage 1 progress only flushes **after** sync completes (`initialize.py:98-107` — `_flush_progress` runs post-`sync`). During a now-concurrent sync (Task 4) the UI sits at 0% for the whole (much faster but still longest) stage. `maxlen=1000` retention means per-file spam must stay coalesced.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`

**Interfaces:**
- Consumes: `_on_sync_progress(document_count, chunk_count)` callback (unchanged signature).
- Produces: periodic `tool_progress` + `stage_progress` publishes every ~1s during sync.

- [ ] **Step 1: Write failing tests (red)**

- Unit (`tests/unit/workflows/test_onboarding_initialize.py`): fake sync invoking `_on_sync_progress` repeatedly → assert `stage_progress` published **before** `sync()` returns (short `asyncio.sleep` lets the loop flush) — fails today: flush happens only post-sync.
- Unit: teardown cancels the loop; failure path leaves no pending task.
- Unit: idle loop publishes nothing (dirty-flag gate — no duplicate frames into the 1000-entry stream).

Confirm the failures before implementing.

- [ ] **Step 2: Debounced progress flusher**

Start a background task before `sync`:

```python
_flush_event = asyncio.Event()
_flush_task: asyncio.Task | None = None

async def _progress_loop() -> None:
    while True:
        try:
            await asyncio.wait_for(_flush_event.wait(), timeout=1.0)
        except TimeoutError:
            continue   # nothing changed since last flush — don't publish duplicate frames
        _flush_event.clear()
        await _flush_progress()   # existing: publishes tool_progress + stage_progress

_flush_task = asyncio.create_task(_progress_loop())
```

In `_on_sync_progress`, after updating `_latest_progress`/`_sync_total_files`, call `_flush_event.set()`.

- [ ] **Step 3: Teardown**

After `sync()` returns: `await _flush_progress()` (final flush), then `_flush_task.cancel()` + `await asyncio.gather(_flush_task, return_exceptions=True)`. Ensure the outer `try/except` in `run_onboarding_initialize` cancels the task on failure too (no orphan loop).

- [ ] **Step 4: Stage-1 progress curve**

Keep `doc_count / total * 92` (capped at 92) as today. Emit `progress = 92` immediately before `_stage_complete("repository_ingestion", ...)` so the bar visibly completes. Reserve final 8% for completion deltas.

- [ ] **Step 5: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_initialize.py -q
```

---
### Task 11: Watchdog timeout + frontend status fallback

**Why:** No overall timeout — one hung LLM/provider stalls the workflow forever. And when SSE exhausts its reconnect budget (`use-workflow-events.ts:98-113`) the page shows "Lost contact" with no path forward until manual refresh (which, pre-Task 1, restarted everything).

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py` (workflow watchdog)
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`
- Test: `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`

**Interfaces:**
- Consumes: existing `mark_failed`, `getInitializeStatus`, `useWorkflowEvents` status.
- Produces: `INIT_WORKFLOW_TIMEOUT_SECONDS = 1200` watchdog; frontend polling fallback on `status === "error"`.

- [ ] **Step 1: Write failing tests (red)**

- Backend (`tests/unit/workflows/test_onboarding_initialize.py`): stage that sleeps past the timeout (inject a tiny timeout override for tests) → state FAILED with timeout error; `mark_failed` called; `workflow_result FAILED` published — fails today: no watchdog exists.
- Frontend (`tests/pages/initialize-page.test.tsx`): `status === "error"` → poll `FAILED` → error UI shown, no navigation loops.
- Frontend: poll `COMPLETED` → `router.push("/onboarding/complete")`.

Confirm the failures before implementing.

- [ ] **Step 2: Workflow-level watchdog**

Wrap the stage sequence (repository_ingestion → recommendations) in `asyncio.wait_for`:

```python
INIT_WORKFLOW_TIMEOUT_SECONDS = 1200  # 20 min ceiling for stages 1-5

# run_onboarding_initialize:
try:
    ...
    result_state = await asyncio.wait_for(_run_stages(), timeout=INIT_WORKFLOW_TIMEOUT_SECONDS)
    return result_state
except TimeoutError:
    logger.error("onboarding_initialize_timeout org=%s", org_id)
    if onboarding_repo:
        await onboarding_repo.mark_failed(org_id, "initialize",
            {"detail": f"Initialization exceeded {INIT_WORKFLOW_TIMEOUT_SECONDS}s"})
    state.errors.append("Initialization timed out")
    await _publish("workflow_result", {"status": "FAILED", "error": "Initialization timed out"})
    return state.finish(WorkflowStatus.FAILED)
```

`asyncio.TimeoutError` **is** `TimeoutError` on 3.11+ (aliased) — a single `except TimeoutError:` suffices; do not write a redundant tuple. Per-chunk `CHUNK_TIMEOUT_SECONDS` (Task 7) makes this backstop rarely fire. Keep `_INIT_LOCK_TTL_SECONDS` (Task 1, 7200s) ≥ this watchdog value so a legitimate run never outlives its lock.

- [ ] **Step 3: Frontend polling fallback**

```ts
useEffect(() => {
  if (status !== "error") return;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = async () => {
    try {
      const s = await getInitializeStatus();
      if (cancelled) return;
      if (s.state === "COMPLETED") return void router.push("/onboarding/complete");
      if (s.state === "FAILED") {
        setIsFailed(true);
        setFailure({ step: "initialize", detail: s.failure?.detail ?? "Initialization failed" });
        return;
      }
      timer = setTimeout(poll, 5000);   // still INITIALIZING → keep polling
    } catch {
      timer = setTimeout(poll, 5000);
    }
  };
  timer = setTimeout(poll, 1000);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [status, router]);
```

Keep the existing `InitializationError` retry button — `handleRetry` (page.tsx:148-160) already resets runId and calls `retryInitialize`.

- [ ] **Step 4: Verify (green)**

```
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_initialize.py -q
cd draftly-agent-frontend && npx vitest run tests/pages/initialize-page.test.tsx
```

---
## Expected latency model (100 files / 500 chunks)

| Stage | Today | After P1 | Driver |
|-------|-------|----------|--------|
| 1. repository_ingestion | 4–10 min | <1 min | Task 4 concurrent fetch, Task 5 bulk delete, Task 6 batch inserts |
| 2. knowledge_construction | 15–40 min | 2–4 min | Task 7 8-way concurrency + timeout |
| 3. initial_evaluation | 15–40 min | ~30 s | Task 8 sampling (25 docs) + Task 7 concurrency |
| 4. health_report | <1 s | <1 s | unchanged |
| 5. recommendations | 2–5 s | 2–5 s | unchanged |
| **End-to-end** | **35–90 min** | **~4–6 min** | watch budget: LLM stage dominates |

## Cross-cutting verification

Run before declaring the plan complete:

```
# Backend
cd draftly-agent-backend && ruff check src tests
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit tests/api -q   # full backend sweep (unit + route/SSE)
cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows tests/unit/memory tests/unit/documentation tests/api/test_onboarding_routes.py tests/api/test_workflows_stream.py -q

# Frontend
cd draftly-agent-frontend && npx eslint app components hooks lib api
cd draftly-agent-frontend && npx vitest run

# Keep knowledge graph current (AST-only)
graphify update .
```

Manual smoke (staging): start API + `rq_worker`, complete a real onboarding, verify:

1. Refresh mid-init resumes on the same run (no second sync / duplicate LLM spend).
2. SSE shows each stage row exactly once (reconnect mid-run too).
3. Init visible from RQ worker process; API stays responsive under load during init.
4. Kill the worker mid-run → orchestration fails loudly (watchdog + lock TTL backstop), UI shows retryable failure.
5. Stage 1 progress bar moves during sync (not just at completion).

## Rollout & risks

| Risk | Mitigation |
|------|-----------|
| GitHub rate limits under 8-way concurrency | Cap concurrency at 8; honor `Retry-After`/secondary-rate-limit in `_request` (add backoff before raising); keep `get_last_commit_date` cap at 200. |
| LLM provider rate limits | `LLM_MAX_CONCURRENCY` (default 8) configurable via env; `CHUNK_TIMEOUT_SECONDS` + batch-level failures degrade gracefully (`failed_chunks` already tolerated). |
| Migration `035` GIN index size on large `metadata` | `IF NOT EXISTS` + run during low-traffic window; index is append-only (inserts adjust incrementally). |
| Multi-process lock (Task 9) changes init semantics | Ship Tasks 1–8 first (in-process), then Task 9; fallback path keeps single-process dev/tests green. |
| Init lock TTL expires mid-run before the latency fixes land | Fixed in Task 1: `_INIT_LOCK_TTL_SECONDS = 7200` covers pre-P1 run durations (35–90 min); Task 11 watchdog (1200s) is authoritative once shipped — keep TTL ≥ watchdog; CAS-keyed release stays safe across TTL expiry. |
| SSE duplicates regress across deploys | Server + client dedupe are independent; Task 2 ships in one release to avoid mixed-version dupe windows. |
| Sampling changes eval scores | Blend math unchanged; `llm_count` still scales the average; verify heuristic-only fallback (no model) path unaffected. |

## Suggested implementation order

1. **Task 3** (org scoping — correctness, small, unblocks Tasks 5/8) → **Task 1** (lock/resume) → **Task 2** (SSE dedupe).
2. **Task 4 → 5 → 6** (sync path: concurrency + DB bulk ops).
3. **Task 7 → 8** (LLM stages: concurrency/timeout, then sampling).
4. **Task 10 → 11** (progress + watchdog/fallback).
5. **Task 9** last (RQ migration; depends on all of the above + infra).
---