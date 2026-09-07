# SSE-Starlette Migration Design

**Date:** 2026-08-27
**Status:** Draft
**Scope:** `draftly-agent-backend/src/draftly/events/` + `draftly-agent-backend/src/draftly/app/api/routes/workflows.py`
**Depends on:** 2026-08-23-event-streaming-design.md (Phase 1-2), 2026-08-25-redis-integration-design.md (§4.4 Event Streams)

## 1. Problem

The current SSE implementation in `workflows.py` manually constructs SSE frames:

```python
def _format_envelope(envelope: StreamEnvelope) -> str:
    body = json.dumps(envelope.to_dict(), default=str)
    return f"id: {envelope.seq}\nevent: {envelope.type}\ndata: {body}\n\n"
```

This approach has several issues:

1. **Non-compliant SSE framing** — Manual string formatting doesn't handle edge cases (multi-line data, special characters, comment lines for keepalive)
2. **Boilerplate heartbeat** — Manual `": ping\n\n"` comments instead of library-managed pings
3. **No disconnect detection** — Missing `request.is_disconnected()` checks in some paths
4. **Complex shutdown handling** — Manual task cancellation instead of library-managed graceful shutdown
5. **Testing difficulty** — `StreamingResponse` with manual generators is hard to test

The `sse-starlette` library provides W3C-compliant SSE handling with built-in heartbeat, disconnect detection, and shutdown management.

## 2. Goal

Replace the manual SSE framing in `workflows.py` with `sse-starlette`'s `EventSourceResponse`, while preserving:
- Ticket-based auth (EventSource can't set headers)
- NeonDB event replay for `Last-Event-ID` resume
- Redis Streams as the live event transport
- The existing `StreamEnvelope` wire format

## 3. Architecture

### 3.1 Current Flow

```
Browser → EventSource → GET /workflows/{run_id}/events?ticket=...
                              │
                              ▼
                    Ticket validation (RedisTicketStore)
                              │
                              ▼
                    NeonDB replay (WorkflowEventsStore.list_after)
                              │
                              ▼
                    _event_source() async generator
                              │
                              ├── Format SSE frames manually
                              ├── Heartbeat via ": ping\n\n"
                              └── Read from RedisStreamBus.subscribe()
```

### 3.2 Proposed Flow

```
Browser → EventSource → GET /workflows/{run_id}/events?ticket=...
                              │
                              ▼
                    Ticket validation (RedisTicketStore)
                              │
                              ▼
                    NeonDB replay (WorkflowEventsStore.list_after)
                              │
                              ▼
                    event_generator() async generator
                              │
                              ├── Yield StreamEnvelope dicts
                              └── Read from RedisStreamBus.subscribe()
                              │
                              ▼
                    sse_generator() wraps dicts as JSONServerSentEvent
                              │
                              ▼
                    EventSourceResponse (sse-starlette)
                              │
                              ├── W3C-compliant SSE framing
                              ├── Built-in heartbeat (configurable)
                              ├── Automatic disconnect detection
                              └── Graceful shutdown
```

## 4. Components

### 4.1 New Dependency

```toml
# pyproject.toml
dependencies = [
    "sse-starlette>=2.0.0",
]
```

### 4.2 Backend Changes

#### 4.2.1 `draftly/app/api/routes/workflows.py`

**Remove:**
- `_format_envelope()` function (lines 71-73)
- Manual `": ping\n\n"` heartbeat handling
- Manual `StreamingResponse` with `media_type="text/event-stream"`
- Manual queue-based heartbeat pump (`asyncio.Queue` + `_pump` + `_SENTINEL` + `asyncio.wait_for` timeout)

**Add:**
- Import `EventSourceResponse`, `JSONServerSentEvent` from `sse_starlette`
- Refactor `_event_source()` to yield dicts instead of formatted strings
- New `sse_generator()` wrapper that yields `JSONServerSentEvent`
- Return `EventSourceResponse` with configurable heartbeat

**Implementation approach:**

```python
from sse_starlette import EventSourceResponse, JSONServerSentEvent

# Step 1: _event_source() yields raw dicts (unchanged logic, new return type)
async def _event_source(
    bus: Any,
    run_id: str,
    *,
    replayed: list[dict[str, Any]] | None = None,
    min_live_seq: int = 0,
) -> AsyncGenerator[dict, None]:
    """Yield event dicts for sse-starlette wrapping."""
    # ... replay logic (unchanged) ...
    # ... Redis Stream subscription logic (unchanged) ...
    yield envelope.to_dict()  # Instead of manual SSE framing

# Step 2: stream_events() wraps with JSONServerSentEvent
@router.get("/{run_id}/events")
async def stream_events(
    run_id: str,
    ticket: str,
    request: Request,
    heartbeat: float | None = None,
) -> EventSourceResponse:
    # ... validation and replay logic (unchanged) ...

    heartbeat_seconds = float(
        heartbeat
        if heartbeat is not None and heartbeat > 0
        else getattr(
            request.app.state,
            "heartbeat",
            _DEFAULT_HEARTBEAT_SECONDS,
        )
    )

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

**Key changes:**
- `_event_source()` yields dicts, not formatted strings
- `sse_generator()` wraps dicts as `JSONServerSentEvent`
- `heartbeat` query parameter **retained** as optional override (existing API contract preserved)
- Heartbeat falls back to `request.app.state.heartbeat` (matches existing config access pattern)
- `request.is_disconnected()` **not needed** in generator — sse-starlette's `_listen_for_disconnect` handles client disconnect detection at the ASGI level via `receive()` (source: `sse.py:_listen_for_disconnect`). The queue-based pump pattern yields when data arrives; when the client disconnects, sse-starlette cancels the generator task group. Manual `is_disconnected()` is only required in generators doing blocking work outside the yield path.

#### 4.2.2 `draftly/events/redis_stream_bus.py`

**No changes required.** The existing `subscribe()` async generator already yields `StreamEnvelope` objects, which is exactly what `sse-starlette` needs.

### 4.3 Frontend Changes

**None.** The frontend `useWorkflowEvents` hook uses the browser's native `EventSource` API, which is protocol-compatible with `sse-starlette`'s output.

## 5. Benefits

| Aspect | Current | After Migration |
|--------|---------|-----------------|
| SSE Compliance | Manual string formatting | W3C spec compliant |
| Heartbeat | Manual `": ping\n\n"` via queue timeout | Built-in `ping=<config>` (concurrent task, no manual pump) |
| Disconnect Detection | Manual heartbeat timeout (no explicit check) | Library-managed via ASGI-level `_listen_for_disconnect` |
| Shutdown Handling | Manual task cancellation | Library-managed via `shutdown_event` (optional, not in initial scope) |
| Code Lines | ~100 lines in `_event_source()` | ~70 lines split across `_event_source()` + `sse_generator()` |
| Testing | Complex mocking | Works with FastAPI TestClient |

## 6. Testing Strategy

### 6.1 Test Dependencies

Add to `pyproject.toml` dev dependencies:
```toml
[project.optional-dependencies]
dev = [
    "sse-starlette>=2.0.0",  # TestClient included in base package
]
```

### 6.2 Unit Tests

**File:** `draftly-agent-backend/tests/api/test_workflows_sse_starlette.py`

```python
import pytest
from httpx import AsyncClient
from sse_starlette.testclient import EventSourceClient

async def test_sse_stream_replays_events(async_client: AsyncClient):
    """Verify NeonDB events are replayed on initial connection."""
    # Setup: create ticket, mock events_repo with stored events
    # Connect to SSE endpoint
    # Assert: all stored events are received in order
    # Assert: workflow_result terminates stream

async def test_sse_stream_lives_events(async_client: AsyncClient):
    """Verify live Redis Stream events are forwarded."""
    # Setup: create ticket, start mock workflow
    # Connect to SSE endpoint
    # Publish events to Redis Stream
    # Assert: events are received via SSE

async def test_sse_heartbeat_presence(async_client: AsyncClient):
    """Verify heartbeat comments are sent."""
    # Setup: create ticket, no events
    # Connect to SSE endpoint with short timeout
    # Assert: connection stays alive due to heartbeat

async def test_sse_disconnect_detection(async_client: AsyncClient):
    """Verify stream stops on client disconnect."""
    # Setup: create ticket, start slow workflow
    # Connect, receive some events, disconnect
    # Assert: generator stops cleanly

async def test_sse_json_event_format(async_client: AsyncClient):
    """Verify events are JSON with correct structure."""
    # Setup: create ticket, publish test event
    # Assert: data field contains valid JSON with type, run_id, seq
```

### 6.3 Integration Tests

**File:** `draftly-agent-backend/tests/integration/test_sse_starlette_e2e.py`

```python
async def test_sse_with_real_redis():
    """End-to-end test with real Redis and NeonDB."""
    # Setup: start workflow
    # Connect SSE client
    # Verify: receive all events including workflow_result
    # Verify: reconnect with Last-Event-ID resumes correctly
```

## 7. Migration Plan

### Phase 1: Add sse-starlette dependency

1. Add `sse-starlette>=2.0.0` to `pyproject.toml` dependencies
2. Add `sse-starlette>=2.0.0` to dev dependencies (for TestClient, included in base package)
3. Run `uv lock` to update lockfile
4. Verify no dependency conflicts with FastAPI/Starlette versions

### Phase 2: Refactor workflows.py

1. Add imports for `EventSourceResponse`, `JSONServerSentEvent`
2. Remove `_format_envelope()` function
3. Refactor `_event_source()` to yield dicts instead of formatted strings
4. Add `sse_generator()` wrapper that yields `JSONServerSentEvent`
5. Update `stream_events()` to return `EventSourceResponse`
6. Update `stream_dashboard_events()` similarly
7. Remove manual heartbeat handling
8. Remove manual `request.is_disconnected()` checks

### Phase 3: Update tests

1. Create `tests/api/test_workflows_sse_starlette.py`
2. Refactor existing SSE tests to use `EventSourceClient`
3. Add new tests for heartbeat and disconnect detection
4. Verify all existing tests pass

### Phase 4: Verify production behavior

1. Deploy to staging
2. Monitor SSE connection stability
3. Verify heartbeat prevents proxy timeouts
4. Confirm Last-Event-ID resume works correctly

## 8. Rollback Plan

If sse-starlette causes issues:

1. Revert `workflows.py` changes
2. Remove `sse-starlette` from dependencies
3. Run `uv lock` to restore previous lockfile

The existing manual SSE implementation will continue working unchanged.

## 9. References

- sse-starlette: https://github.com/sysid/sse-starlette
- FastAPI SSE docs: https://fastapi.tiangolo.com/tutorial/server-sent-events/
- MDN EventSource: https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- Existing design: 2026-08-23-event-streaming-design.md
- Redis integration: 2026-08-25-redis-integration-design.md

## Evaluation persistence + live lists (2026-09-02)

### Evaluation save path
`POST /api/evaluations/run` → `worker.run_task("evaluation.loop", org_id, run_id)`
→ `run_evaluation_loop` streams stage/progress/result envelopes on the run's
event-bus channel, writes a `jobs` row (`job_id = run_id`) so `/stream-ticket`
resolves, and persists via `EvaluationRepository.save_run_summary` → the
`evaluations` table row (org_id + run_id present). The scheduled
`evaluation.loop` RQ job takes the same path with `org_id=""` (global run).

### Dashboard producers
`WorkflowRunner` publishes `workflow:changed` (running / pending_review /
completed / failed) via `context.broadcaster` (org from `event.project_id`).
`run_evaluation_loop` publishes `workflow:changed` (running / completed /
failed, `kind="evaluation"`) and `evaluation:created` (evaluation_id, status).

Frame shape: `{ "type": "workflow:changed" | "evaluation:created", "payload": {...} }`.

### Frontend live lists
`LiveEventsProvider` opens one org dashboard EventSource
(`POST /api/workflows/dashboard-ticket` → `GET /api/workflows/events/dashboard`)
and bumps per-type counters. `useLiveVersion(types)` + `useLiveRefresh`
drive the Workflows list, sidebar running-count, and Evaluations list:
fetch on mount, refetch on event, 30s fallback poll. 5s interval polling is
removed from those three surfaces.

### Dashboard Redis Streams migration (2026-09-02)

The org-scoped dashboard pub/sub transport is replaced with Redis Streams for
durability + resume:

- `DashboardStreamBus` (`src/draftly/events/dashboard_stream_bus.py`) —
  `broadcast(org_id, event_type, payload)` and
  `subscribe(org_id, last_id="0", block_ms=15000)` against
  `draftly:dashstream:{org_id}` (xadd `maxlen=500` / xread). Same
  `broadcast()` signature and `{type, payload}` frame shape as legacy
  `DashboardBroadcaster`, plus a stream `id` per frame.
- Wired into `app.state.dashboard_broadcaster` (lifecycle) and
  `context.broadcaster` (composition/`workflows.py`) — producers unchanged.
- SSE route `GET /api/workflows/events/dashboard` reads the `Last-Event-ID`
  header and resumes via `subscribe(org_id, last_id=...)`; each frame carries
  the stream `id` so the EventSource tracks resume position automatically.
- Frontend `useDashboardEvents` + `LiveEventsProvider` persist `lastEventId`
  across client-driven reconnects and send `&Last-Event-ID=...` on resume, so
  frames published while the socket was down are replayed instead of lost.

Trade-off vs legacy pub/sub: bounded retained history (500 frames/org) and
reconnect replay cost, in exchange for no dropped frames when no subscriber
was connected. `active-workflows` widget remains on SWR 15s polling.
