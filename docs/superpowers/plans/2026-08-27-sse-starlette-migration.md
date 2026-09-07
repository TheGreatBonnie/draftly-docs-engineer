# SSE-Starlette Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual SSE framing in `workflows.py` with `sse-starlette`'s `EventSourceResponse`. This is a **low-risk, high-value** refactor that improves W3C compliance, reduces boilerplate, and adds built-in heartbeat/disconnect handling.

**Architecture:** The SSE endpoint currently uses `StreamingResponse` with manual string formatting for SSE frames. After migration, it will use `EventSourceResponse` from `sse-starlette` which provides W3C-compliant SSE handling, built-in heartbeat, and graceful shutdown. The two-layer generator pattern is used: `_event_source()` yields raw dicts, `sse_generator()` wraps them as `JSONServerSentEvent`. No manual `request.is_disconnected()` check is needed — sse-starlette's `_listen_for_disconnect` task handles client disconnect detection at the ASGI level via `receive()`, and the queue-based pump pattern yields only when data arrives (the generator is not doing blocking work outside the yield path).

**Tech Stack:** Python 3.12 (asyncio, FastAPI, Starlette), sse-starlette 2.x, Redis Streams (XADD/XREAD), NeonDB (asyncpg), existing `StreamEnvelope` wire format

**Spec:** `docs/superpowers/specs/2026-08-27-sse-starlette-migration-design.md`

## Global Constraints

- Python 3.12+, asyncio only (no threads)
- Use `structlog` for logging (existing pattern)
- Follow existing test patterns: `pytest.mark.asyncio`, `unittest.mock`
- SSE auth: ticket-based via `RedisTicketStore` (existing, unchanged)
- Event envelope format: `StreamEnvelope` with `type`, `run_id`, `surface`, `seq`, `ts`, `payload` (existing)
- Frontend uses native `EventSource` API (no changes needed)
- Backend stream key pattern: `draftly:stream:{run_id}` (existing, unchanged)
- Follow existing code conventions (structlog, Pydantic models)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `draftly-agent-backend/pyproject.toml` | Modify | Add `sse-starlette>=2.0.0` dependency |
| `draftly-agent-backend/src/draftly/app/api/routes/workflows.py` | Modify | Refactor SSE endpoints to use `EventSourceResponse` |
| `draftly-agent-backend/tests/api/test_workflows_sse_starlette.py` | Create | New tests for sse-starlette integration |
| `draftly-agent-backend/tests/api/test_workflows_stream.py` | Modify | Update existing tests for compatibility |

---

## Part A: Backend

---

### Task 1: Add sse-starlette dependency

**Files:**
- Modify: `draftly-agent-backend/pyproject.toml`

**Interfaces:**
- Consumes: existing FastAPI/Starlette dependencies
- Produces: `sse-starlette` package available for import

- [ ] **Step 1: Add sse-starlette to main dependencies**

Add to `pyproject.toml` main dependencies:

```toml
dependencies = [
    # ... existing deps ...
    "sse-starlette>=2.0.0",
]
```

- [ ] **Step 2: Add sse-starlette to dev dependencies (for TestClient)**

Add to `pyproject.toml` optional dev dependencies:

```toml
[project.optional-dependencies]
dev = [
    # ... existing dev deps ...
    "sse-starlette>=2.0.0",
]
```

Note: `sse_starlette.testclient` is included in the base package — the `[pydantic]` extra is not needed for testing.

- [ ] **Step 3: Update lockfile**

```bash
cd draftly-agent-backend
uv lock
uv sync
```

- [ ] **Step 4: Verify imports work**

```bash
python -c "from sse_starlette import EventSourceResponse, JSONServerSentEvent; print('OK')"
python -c "from sse_starlette.testclient import EventSourceClient; print('OK')"
```

- [ ] **Step 5: Verify no dependency conflicts**

```bash
uv pip check
```

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-backend
git add pyproject.toml uv.lock
git commit -m "deps: add sse-starlette>=2.0.0 for W3C-compliant SSE"
```

---

### Task 2: Refactor workflows.py SSE endpoint

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflows.py`

**Interfaces:**
- Consumes: `sse_starlette.EventSourceResponse`, `sse_starlette.JSONServerSentEvent`, `StreamEnvelope` from existing events module
- Produces: Updated `stream_events()` and `stream_dashboard_events()` endpoints returning `EventSourceResponse`

- [ ] **Step 1: Add sse-starlette imports**

At the top of `workflows.py`, add:

```python
from sse_starlette import EventSourceResponse, JSONServerSentEvent
```

- [ ] **Step 2: Remove StreamingResponse import**

Remove `from fastapi.responses import StreamingResponse` — no longer needed after migration.

- [ ] **Step 3: Remove `_format_envelope()` function**

Delete the function (lines 71-73):

```python
# DELETE THIS FUNCTION
def _format_envelope(envelope: StreamEnvelope) -> str:
    body = json.dumps(envelope.to_dict(), default=str)
    return f"id: {envelope.seq}\nevent: {envelope.type}\ndata: {body}\n\n"
```

- [ ] **Step 4: Refactor `_event_source()` to yield dicts**

Replace the entire function with:

```python
async def _event_source(
    bus: Any,
    run_id: str,
    *,
    replayed: list[dict[str, Any]] | None = None,
    min_live_seq: int = 0,
) -> AsyncGenerator[dict, None]:
    """Yield event dicts for sse-starlette wrapping."""
    replayed_done = False
    for row in replayed or []:
        envelope = StreamEnvelope(
            type=str(row.get("type", "unknown")),
            run_id=run_id,
            surface=str(row.get("surface", "")),
            seq=int(row.get("seq", 0)),
            ts=str(row.get("ts") or ""),
            node_id=row.get("node_id"),
            payload=dict(row.get("payload") or {}),
        )
        yield envelope.to_dict()
        if envelope.type == "workflow_result":
            replayed_done = True

    if replayed_done:
        return

    queue: asyncio.Queue[StreamEnvelope | None] = asyncio.Queue()
    _SENTINEL = None

    async def _pump() -> None:
        try:
            async for envelope in bus.subscribe(run_id):
                await queue.put(envelope)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("sse_pump_error", run_id=run_id)
        finally:
            await queue.put(_SENTINEL)

    pump_task = asyncio.create_task(_pump())
    try:
        while True:
            try:
                envelope = await asyncio.wait_for(queue.get(), timeout=15.0)
            except TimeoutError:
                continue

            if envelope is _SENTINEL:
                return

            if envelope.seq <= min_live_seq:
                continue

            yield envelope.to_dict()
            if envelope.type == "workflow_result":
                return
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except asyncio.CancelledError:
            pass
```

- [ ] **Step 5: Update `stream_events()` to return EventSourceResponse**

Replace the endpoint with:
- `heartbeat` query parameter **retained** as optional override (preserves existing API contract)
- Config access via `request.app.state.heartbeat` (matches existing pattern in `workflows.py:168`)

Replace the endpoint with:

```python
@router.get("/{run_id}/events")
async def stream_events(
    run_id: str,
    ticket: str,
    request: Request,
    heartbeat: float | None = None,
) -> EventSourceResponse:
    claimed = await _tickets(request).consume(ticket)
    if claimed is None or claimed[0] != run_id:
        raise HTTPException(status_code=403, detail="Invalid or expired ticket")

    bus = getattr(request.app.state.draftly.workflows, "event_bus", None)
    if bus is None:
        raise HTTPException(status_code=503, detail="Event bus unavailable")

    heartbeat_seconds = float(
        heartbeat
        if heartbeat is not None and heartbeat > 0
        else getattr(
            request.app.state,
            "heartbeat",
            _DEFAULT_HEARTBEAT_SECONDS,
        )
    )

    replayed: list[dict[str, Any]] = []
    min_live_seq = 0
    last_event_id = request.headers.get("last-event-id", "")

    events_repo = getattr(
        getattr(request.app.state.draftly.dependencies, "repositories", None),
        "workflow_events",
        None,
    )
    if events_repo is not None:
        try:
            if last_event_id.isdigit():
                min_live_seq = int(last_event_id)
                replayed = await events_repo.list_after(run_id, seq=min_live_seq)
            else:
                replayed = await events_repo.list_after(run_id, seq=0)
        except Exception:
            logger.warning("sse_replay_failed run_id=%s", run_id, exc_info=True)

    gen = _event_source(bus, run_id, replayed=replayed, min_live_seq=min_live_seq)

    async def sse_generator():
        async for data in gen:
            yield JSONServerSentEvent(
                data=data,
                event=data.get("type", "message"),
                id=str(data.get("seq", "")),
            )

    return EventSourceResponse(
        sse_generator(),
        ping=heartbeat_seconds,  # Configurable via query param or app.state.heartbeat
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
```

- [ ] **Step 6: Update `stream_dashboard_events()` to return EventSourceResponse**

Apply similar changes:

```python
@router.get("/events/dashboard")
async def stream_dashboard_events(
    ticket: str,
    request: Request,
    heartbeat: float | None = None,
) -> EventSourceResponse:
    claimed = await _tickets(request).consume(ticket)
    if claimed is None:
        raise HTTPException(status_code=403, detail="Invalid or expired ticket")

    _, org_id = claimed
    broadcaster = getattr(request.app.state, "dashboard_broadcaster", None)
    if broadcaster is None:
        raise HTTPException(status_code=503, detail="Dashboard broadcaster unavailable")

    heartbeat_seconds = float(heartbeat if heartbeat and heartbeat > 0 else 15.0)

    async def _dashboard_source():
        gen = broadcaster.subscribe(org_id)
        while True:
            try:
                event = await asyncio.wait_for(gen.__anext__(), timeout=heartbeat_seconds)
            except StopAsyncIteration:
                return
            except TimeoutError:
                await asyncio.sleep(0.1)  # avoid tight-loop; sse-starlette ping handles keepalive
                continue
            yield event

    return EventSourceResponse(
        _dashboard_source(),
        ping=heartbeat_seconds,
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
```

- [ ] **Step 7: Verify syntax**

```bash
cd draftly-agent-backend
python3 -c "import ast; ast.parse(open('src/draftly/app/api/routes/workflows.py').read()); print('OK')"
```

- [ ] **Step 8: Verify imports work**

```bash
cd draftly-agent-backend
python -c "from draftly.app.api.routes.workflows import router; print('OK')"
```

- [ ] **Step 9: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/workflows.py
git commit -m "refactor: migrate SSE endpoints to sse-starlette EventSourceResponse"
```

---

### Task 3: Add sse-starlette tests

**Files:**
- Create: `draftly-agent-backend/tests/api/test_workflows_sse_starlette.py`

**Interfaces:**
- Consumes: `sse_starlette.testclient.EventSourceClient`, existing test fixtures (`async_client`, `mock_bus`, `mock_events_repo`)
- Produces: Test coverage for SSE replay, live events, heartbeat, JSON format

- [ ] **Step 1: Create new test file**

> **Note:** These test stubs are pseudocode showing intent. Variables like `run_id`, `ticket`, and fixture setup must be fleshed out during implementation using existing test patterns from `test_workflows_stream.py`.

```python
# draftly-agent-backend/tests/api/test_workflows_sse_starlette.py
"""Tests for SSE endpoints using sse-starlette EventSourceResponse."""

import json
import pytest
from httpx import AsyncClient
from sse_starlette.testclient import EventSourceClient


async def test_sse_stream_replays_stored_events(async_client, mock_bus, mock_events_repo):
    """Verify NeonDB events are replayed on initial connection."""
    with EventSourceClient(base_url="http://testserver") as client:
        events = list(client.events(f"/workflows/{run_id}/events?ticket={ticket}"))
        assert len(events) > 0
        assert events[0].event == "stage_change"


async def test_sse_stream_live_events(async_client, mock_bus):
    """Verify live Redis Stream events are forwarded."""
    with EventSourceClient(base_url="http://testserver") as client:
        events = list(client.events(f"/workflows/{run_id}/events?ticket={ticket}"))
        for i, event in enumerate(events):
            data = json.loads(event.data)
            assert "seq" in data


async def test_sse_heartbeat_presence(async_client, mock_bus):
    """Verify heartbeat keeps connection alive."""
    with EventSourceClient(base_url="http://testserver", timeout=2.0) as client:
        events = list(client.events(f"/workflows/{run_id}/events?ticket={ticket}"))
        # Connection stayed alive due to heartbeat


async def test_sse_json_event_format(async_client, mock_bus):
    """Verify events are JSON with correct structure."""
    with EventSourceClient(base_url="http://testserver") as client:
        events = list(client.events(f"/workflows/{run_id}/events?ticket={ticket}"))
        for event in events:
            data = json.loads(event.data)
            assert "type" in data
            assert "run_id" in data
            assert "seq" in data


async def test_sse_workflow_result_terminates_stream(async_client, mock_bus):
    """Verify workflow_result event terminates the stream."""
    # Test implementation
    pass
```

- [ ] **Step 2: Update existing tests (if needed)**

Check `draftly-agent-backend/tests/api/test_workflows_stream.py` and update as needed for compatibility.

- [ ] **Step 3: Run new tests**

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_workflows_sse_starlette.py -v
```

- [ ] **Step 4: Run existing tests**

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_workflows_stream.py -v
```

- [ ] **Step 5: Commit**

```bash
cd draftly-agent-backend
git add tests/api/test_workflows_sse_starlette.py tests/api/test_workflows_stream.py
git commit -m "test: add sse-starlette tests for SSE endpoints"
```

---

### Task 4: Verify end-to-end

**Files:**
- No new files — verification only

- [ ] **Step 1: Run all backend tests**

```bash
cd draftly-agent-backend
uv run pytest tests/ -v --tb=short
```

- [ ] **Step 2: Run typecheck**

```bash
cd draftly-agent-backend
python -m mypy src/draftly/app/api/routes/workflows.py --ignore-missing-imports
```

- [ ] **Step 3: Run linter**

```bash
cd draftly-agent-backend
python -m ruff check src/draftly/app/api/routes/workflows.py
```

- [ ] **Step 4: Run graphify update**

```bash
graphify update .
```

---

## Part B: Manual Testing

---

### Task 5: Manual testing checklist

- [ ] **Step 1: Basic SSE connection**
   - Open browser DevTools → Network → SSE
   - Verify `text/event-stream` content type
   - Verify events arrive with correct structure

- [ ] **Step 2: Heartbeat**
   - Wait 15+ seconds without events
   - Verify connection stays alive (no timeout)
   - Check for heartbeat in DevTools (sse-starlette sends as comments)

- [ ] **Step 3: Reconnection**
   - Disconnect network briefly
   - Reconnect
   - Verify `Last-Event-ID` header is sent
   - Verify missed events are replayed

- [ ] **Step 4: Workflow completion**
   - Start a workflow
   - Verify all events arrive in order
   - Verify `workflow_result` terminates the stream

- [ ] **Step 5: Dashboard SSE**
   - Open dashboard page
   - Verify dashboard events arrive
   - Verify heartbeat keeps connection alive

---

### Task 6: Production verification

- [ ] **Step 1: Deploy to staging**

- [ ] **Step 2: Monitor SSE connection stability**

After deployment, monitor for 24 hours:
- SSE connection count (should remain stable)
- Heartbeat interval (should be ~15s or configured value)
- Error rate (should not increase)
- Latency (should not increase)
- Memory usage (should not increase significantly)

---

## Summary of Changes

| Problem | Fix | Files |
|---------|-----|-------|
| Manual SSE framing | Use `sse-starlette` `EventSourceResponse` | `workflows.py` |
| Non-compliant SSE | W3C-compliant framing via library | `workflows.py` |
| Manual heartbeat | Built-in `ping=<config>` | `workflows.py` |
| Complex shutdown | Library-managed cleanup via `shutdown_event` | `workflows.py` |
| Silent exception swallowing | Log in `_pump()` via structlog | `workflows.py` |
| Testing difficulty | `EventSourceClient` test helper | `test_workflows_sse_starlette.py` |

## What's NOT Changed

- Frontend `useWorkflowEvents` hook — protocol-compatible
- `StreamEnvelope` wire format — unchanged
- `RedisStreamBus` / `RedisTicketStore` — unchanged
- NeonDB `WorkflowEventsStore` — unchanged
- `initialize.py` / `onboarding.py` — unchanged (publishers, not consumers)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| sse-starlette incompatibility | Low | High | Test thoroughly before merge |
| Performance regression | Low | Medium | Benchmark before/after |
| Breaking existing clients | Low | High | Frontend uses native EventSource, protocol-compatible |
| Dependency conflict | Low | Low | Run `uv lock` and verify |
| Missing disconnect detection | Low | High | sse-starlette handles disconnect via ASGI `_listen_for_disconnect`; queue-based pump pattern is sufficient |

---

## Rollback Plan

If issues arise:

1. Revert `workflows.py` changes
2. Remove `sse-starlette` from `pyproject.toml`
3. Run `uv lock` to restore previous lockfile
4. Deploy previous version

The manual SSE implementation will continue working unchanged.

---

## Success Criteria

- [ ] All existing SSE tests pass
- [ ] New sse-starlette tests pass
- [ ] Manual testing checklist complete
- [ ] No increase in error rate after deployment
- [ ] Heartbeat prevents proxy timeouts
- [ ] Last-Event-ID resume works correctly
- [ ] No regressions in workflow execution
- [ ] Dashboard SSE still works correctly
- [ ] Memory usage remains stable
- [ ] Documentation updated
