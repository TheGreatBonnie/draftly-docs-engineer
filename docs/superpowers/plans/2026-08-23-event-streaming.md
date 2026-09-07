# Event Streaming Implementation Plan (Phases 1–3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Strands graph events from the worker process through Redis to browser SSE consumers, turning blocking documentation runs into live progress feeds — and expose the already-persisted audit/routing/review/metrics data through org-scoped read APIs.

**Architecture:** Worker swaps `graph.invoke_async` for a streaming helper that iterates `graph.stream_async`, filters raw Strands dicts into typed envelopes (`draftly/events/envelope.py`), and publishes them to Redis channels; the API bridges Redis → existing `EventStream` hub → SSE frames. Flag-off behavior is byte-for-byte today's path. Phase 4 adds read-only REST surface over `agent_runs`/`agent_steps`, `reviews`, routing/performance stores, jobs, and process metrics.

**Tech Stack:** Python 3.11 / FastAPI / strands-agents>=1.52 (`Graph.stream_async`) / `redis>=5` asyncio client / pytest (asyncio_mode=auto) / Next.js React frontend (phase 2).

**Spec:** `docs/superpowers/specs/2026-08-23-event-streaming-design.md`

## Global Constraints

- **This workspace is NOT a git repository** — omit all commit steps; each task ends at green tests + lint + typecheck.
- All commands run from `draftly-agent-backend/`; tests/lint/typecheck: `make test`, `make lint` (`uv run ruff check .`), `make typecheck` (`uv run mypy src`).
- ruff line-length 100, target py311; mypy `disallow_untyped_defs = true` — every function needs annotations.
- pytest `asyncio_mode = "auto"` — plain `async def test_*` works, no decorators.
- Never fail a workflow over streaming: publisher errors are logged and swallowed.
- Feature flag default OFF: `events_streaming_enabled=false` keeps today's exact behavior.
- Follow existing style: structlog loggers, `from __future__ import annotations`, dataclasses over classes where possible.

---

## Phase 1 — Transport + Docs UX

### Task 1: Envelope module (`StreamEnvelope` + `filter_graph_event`)

**Files:**
- Create: `src/draftly/events/envelope.py`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `EnvelopeType = Literal["node_start", "node_stream", "node_stop", "handoff", "text_delta", "tool_progress", "workflow_result"]`
  - `@dataclass StreamEnvelope` fields: `type: str`, `run_id: str`, `surface: str`, `seq: int = 0`, `ts: str = ""` (UTC ISO), `node_id: str | None = None`, `payload: dict[str, Any]`
  - `filter_graph_event(event: Mapping[str, Any], *, run_id: str, surface: str) -> StreamEnvelope | None` — pure mapper per spec table.

- [ ] **Step 1: Write the failing tests**

```python
# tests/events/test_envelope.py
"""Envelope shaping: raw Strands streaming events -> wire envelopes."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from draftly.events.envelope import StreamEnvelope, filter_graph_event

KW = {"run_id": "evt-1", "surface": "documentation"}


def node_start() -> dict[str, Any]:
    return {"type": "multiagent_node_start", "node_id": "writer", "node_type": "agent"}


def node_stream(nested: dict[str, Any]) -> dict[str, Any]:
    return {"type": "multiagent_node_stream", "node_id": "writer", "event": nested}


def node_stop(status: str = "COMPLETED") -> dict[str, Any]:
    return {
        "type": "multiagent_node_stop",
        "node_id": "writer",
        "node_result": {"status": status, "duration": 1.25},
    }


def handoff() -> dict[str, Any]:
    return {
        "type": "multiagent_handoff",
        "from_node_ids": ["classify"],
        "to_node_ids": ["research"],
    }


class TestFilterMapping:
    def test_node_start_maps(self) -> None:
        env = filter_graph_event(node_start(), **KW)
        assert env is not None
        assert env.type == "node_start"
        assert env.node_id == "writer"
        assert env.payload == {"node_type": "agent"}

    def test_nested_text_delta_maps(self) -> None:
        env = filter_graph_event(node_stream({"data": "# Draftly docs"}), **KW)
        assert env is not None
        assert env.type == "text_delta"
        assert env.node_id == "writer"
        assert env.payload == {"text": "# Draftly docs"}

    def test_nested_tool_progress_maps_only_with_name(self) -> None:
        tool = {"current_tool_use": {"name": "search_docs", "toolUseId": "t1", "input": {}}}
        env = filter_graph_event(node_stream(tool), **KW)
        assert env is not None
        assert env.type == "tool_progress"
        assert env.payload["name"] == "search_docs"

        unnamed = node_stream({"current_tool_use": {"input": {}}})
        assert filter_graph_event(unnamed, **KW) is None

    def test_node_stop_extracts_status_and_duration(self) -> None:
        env = filter_graph_event(node_stop(), **KW)
        assert env is not None
        assert env.type == "node_stop"
        assert env.payload == {"status": "COMPLETED", "duration_ms": 1250}

    def test_handoff_maps(self) -> None:
        env = filter_graph_event(handoff(), **KW)
        assert env is not None
        assert env.type == "handoff"
        assert env.payload == {"from": ["classify"], "to": ["research"]}


class TestDroppedAndTerminal:
    @pytest.mark.parametrize(
        "raw",
        [
            {"init_event_loop": True},
            {"start_event_loop": True},
            {"delta": "raw"},
            {"reasoning": True, "reasoningText": "thinking"},
            {"message": {"role": "assistant"}},
            {},
        ],
    )
    def test_noise_is_dropped(self, raw: dict[str, Any]) -> None:
        assert filter_graph_event(raw, **KW) is None

    def test_force_stop_without_result_maps_terminal_error(self) -> None:
        raw = {"force_stop": True, "force_stop_reason": "max_iterations"}
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "workflow_result"
        assert env.payload["status"] == "FAILED"
        assert env.payload["force_stop_reason"] == "max_iterations"

    def test_result_event_carries_status_and_interrupts(self) -> None:
        interrupt = type("Interrupt", (), {"id": "i-1", "reason": {"summary": "review"}})()
        result = type(
            "GraphResult",
            (),
            {"status": type("Status", (), {"name": "INTERRUPTED"})(), "interrupts": [interrupt]},
        )()
        raw = {"result": result}
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "workflow_result"
        assert env.payload["status"] == "INTERRUPTED"
        assert env.payload["interrupts"] == [{"id": "i-1", "reason": {"summary": "review"}}]
        # no metrics on this double -> token keys omitted entirely
        assert "tokens_in" not in env.payload

    def test_result_event_includes_token_usage_when_present(self) -> None:
        result = type(
            "GraphResult",
            (),
            {
                "status": type("Status", (), {"name": "COMPLETED"})(),
                "interrupts": [],
                "metrics": SimpleNamespace(
                    accumulated_usage={"inputTokens": 1200, "outputTokens": 340}
                ),
            },
        )()
        env = filter_graph_event({"result": result}, **KW)
        assert env is not None
        assert env.payload["tokens_in"] == 1200
        assert env.payload["tokens_out"] == 340


class TestEnvelopeShape:
    def test_envelope_json_round_trip(self) -> None:
        env = StreamEnvelope(type="node_start", run_id="r", surface="documentation")
        env.payload = {"node_type": "agent"}
        decoded = json.loads(json.dumps(env.to_dict()))
        assert decoded["type"] == "node_start"
        assert decoded["run_id"] == "r"
        assert decoded["seq"] == 0
        assert decoded["ts"]

    def test_non_dict_event_is_dropped(self) -> None:
        assert filter_graph_event("garbage", **KW) is None  # type: ignore[arg-type]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/events/test_envelope.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'draftly.events.envelope'`

- [ ] **Step 3: Write the implementation**

```python
# src/draftly/events/envelope.py
"""Wire-envelope shaping for Strands graph streams (spec §Wire contract).

``filter_graph_event`` is the single place that knows how raw Strands
streaming dicts map onto Draftly's compact SSE envelopes; everything else
consumes ``StreamEnvelope``. Pure module: no I/O, fully table-testable.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

EnvelopeType = Literal[
    "node_start",
    "node_stream",
    "node_stop",
    "handoff",
    "text_delta",
    "tool_progress",
    "workflow_result",
]


@dataclass(slots=True)
class StreamEnvelope:
    """One filtered graph event, ready for JSON serialization."""

    type: str
    run_id: str
    surface: str
    seq: int = 0
    ts: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    node_id: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "run_id": self.run_id,
            "surface": self.surface,
            "seq": self.seq,
            "ts": self.ts,
            "node_id": self.node_id,
            "payload": self.payload,
        }


def _now_ms() -> int:
    return int(time.monotonic() * 1000)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _status_name(result: Any) -> str:
    status = getattr(result, "status", None)
    name = getattr(status, "name", None) or str(status or "UNKNOWN")
    return str(name)


def _interrupt_records(result: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for interrupt in getattr(result, "interrupts", None) or []:
        records.append(
            {
                "id": str(getattr(interrupt, "id", "")),
                "reason": getattr(interrupt, "reason", None),
            }
        )
    return records


def _token_usage(result: Any) -> dict[str, int] | None:
    """Per-run token totals from EventLoopMetrics; None when unavailable."""
    usage = getattr(getattr(result, "metrics", None), "accumulated_usage", None)
    if not isinstance(usage, dict):
        return None
    return {
        "tokens_in": int(usage.get("inputTokens") or 0),
        "tokens_out": int(usage.get("outputTokens") or 0),
    }


def filter_graph_event(
    event: Mapping[str, Any],
    *,
    run_id: str,
    surface: str,
) -> StreamEnvelope | None:
    """Map one raw Strands event to an envelope, or None to drop it."""

    if not isinstance(event, Mapping):
        return None

    kind = str(event.get("type", ""))
    node_id = event.get("node_id")
    node_str = str(node_id) if node_id is not None else None

    if kind == "multiagent_node_start":
        return StreamEnvelope(
            type="node_start",
            run_id=run_id,
            surface=surface,
            node_id=node_str,
            payload={"node_type": str(event.get("node_type", "agent"))},
        )

    if kind == "multiagent_node_stream":
        nested = _as_dict(event.get("event"))
        if "data" in nested and isinstance(nested.get("data"), str):
            return StreamEnvelope(
                type="text_delta",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={"text": nested["data"]},
            )
        tool = _as_dict(nested.get("current_tool_use"))
        if tool.get("name"):
            return StreamEnvelope(
                type="tool_progress",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={
                    "name": str(tool["name"]),
                    "tool_use_id": str(tool.get("toolUseId", "")),
                },
            )
        return None

    if kind == "multiagent_node_stop":
        node_result = _as_dict(event.get("node_result"))
        duration = node_result.get("duration")
        return StreamEnvelope(
            type="node_stop",
            run_id=run_id,
            surface=surface,
            node_id=node_str,
            payload={
                "status": str(node_result.get("status", "UNKNOWN")),
                "duration_ms": int(float(duration) * 1000) if duration is not None else None,
            },
        )

    if kind == "multiagent_handoff":
        return StreamEnvelope(
            type="handoff",
            run_id=run_id,
            surface=surface,
            payload={
                "from": [str(n) for n in event.get("from_node_ids", [])],
                "to": [str(n) for n in event.get("to_node_ids", [])],
            },
        )

    if "result" in event:
        result = event["result"]
        payload: dict[str, Any] = {
            "status": _status_name(result),
            "interrupts": _interrupt_records(result),
        }
        usage = _token_usage(result)
        if usage is not None:
            payload.update(usage)
        return StreamEnvelope(
            type="workflow_result",
            run_id=run_id,
            surface=surface,
            payload=payload,
        )

    if event.get("force_stop"):
        return StreamEnvelope(
            type="workflow_result",
            run_id=run_id,
            surface=surface,
            payload={
                "status": "FAILED",
                "force_stop_reason": str(event.get("force_stop_reason", "unknown")),
                "interrupts": [],
            },
        )

    return None
```

Note: remove the unused `_now_ms` helper if ruff flags it (F841/F401 hygiene) — duration conversion uses the value carried on the event.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/events/test_envelope.py -q`
Expected: PASS (all)

- [ ] **Step 5: Lint + typecheck**

Run: `make lint && make typecheck`
Expected: clean

---

### Task 2: Settings + dependencies

**Files:**
- Modify: `pyproject.toml:7-39` (dependencies array) and `[project.optional-dependencies] dev` / `[dependency-groups] dev`
- Modify: `src/draftly/app/config.py` (add an "Events streaming" section near the Workers section, ~line 137)

**Interfaces:**
- Produces: settings fields read later as `settings.redis_url`, `settings.events_streaming_enabled`, `settings.events_heartbeat_seconds`.

- [ ] **Step 1: Add dependencies**

In `pyproject.toml` main `dependencies` list, add after `"websockets>=10",`:

```toml
    "redis>=5.0.0",
```

Add `fakeredis` to BOTH dev groups (`[project.optional-dependencies].dev` and `[dependency-groups].dev`):

```toml
    "fakeredis>=2.23.0",
```

Then sync: `uv sync --all-extras`
Expected: lock resolves, installs redis + fakeredis.

- [ ] **Step 2: Add settings**

In `src/draftly/app/config.py`, insert before the Workers section comment:

```python
    # ------------------------------------------------------------------
    # Events streaming (spec: 2026-08-23-event-streaming-design)
    # ------------------------------------------------------------------

    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("REDIS_URL"),
    )
    events_streaming_enabled: bool = False
    events_heartbeat_seconds: int = 15
```

- [ ] **Step 3: Verify config loads**

Run: `uv run python -c "from draftly.app.config import get_settings; s = get_settings(); print(s.redis_url, s.events_streaming_enabled)"`
Expected: prints `redis://localhost:6379/0 False`

Run: `uv run pytest tests/api/test_routes_smoke.py -q`
Expected: PASS (no config regressions)

---

### Task 3: Redis bus (`publish` / `subscribe`)

**Files:**
- Create: `src/draftly/events/redis_bus.py`
- Test: `tests/events/test_redis_bus.py`

**Interfaces:**
- Consumes: `StreamEnvelope` from Task 1; settings `redis_url`.
- Produces:
  - `class RedisEventBus`: `async publish(envelope: StreamEnvelope) -> bool` (False on any Redis error — swallowed+logged), `def subscribe(run_id: str) -> AsyncIterator[StreamEnvelope]` (async generator; ends when the peer closes or on cancel), `async close() -> None`.
  - `channel_for(run_id: str) -> str` returning `f"draftly:events:{run_id}"`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/events/test_redis_bus.py
"""RedisEventBus publish/subscribe against fakeredis."""

from __future__ import annotations

import pytest
from fakeredis.aioredis import FakeRedis

from draftly.events.envelope import StreamEnvelope
from draftly.events.redis_bus import RedisEventBus, channel_for


def envelope(seq: int = 1) -> StreamEnvelope:
    return StreamEnvelope(type="node_start", run_id="evt-9", surface="support", seq=seq)


async def test_channel_naming() -> None:
    assert channel_for("evt-9") == "draftly:events:evt-9"


async def test_publish_returns_true_and_delivers(monkeypatch: pytest.MonkeyPatch) -> None:
    bus = RedisEventBus(redis_client=FakeRedis())
    received: list[StreamEnvelope] = []

    async def consume() -> None:
        async for env in bus.subscribe("evt-9"):
            received.append(env)

    import asyncio

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)  # let subscription register
    assert await bus.publish(envelope()) is True
    await asyncio.sleep(0.05)
    task.cancel()
    assert len(received) == 1
    assert received[0].type == "node_start"
    assert received[0].run_id == "evt-9"
    await bus.close()


async def test_publish_swallows_redis_errors() -> None:
    class ExplodingClient:
        def publish(self, channel: str, message: str) -> "ExplodingClient":
            raise ConnectionError("redis down")

        async def close(self) -> None:
            return None

    bus = RedisEventBus(redis_client=ExplodingClient())  # type: ignore[arg-type]
    assert await bus.publish(envelope()) is False
    await bus.close()


async def test_subscribe_survives_bad_json() -> None:
    client = FakeRedis()
    bus = RedisEventBus(redis_client=client)
    await client.publish(channel_for("evt-9"), b"not-json")
    await client.publish(channel_for("evt-9"), envelope(seq=2).to_json().encode())

    seen: list[StreamEnvelope] = []

    async def drain() -> None:
        async for env in bus.subscribe("evt-9"):
            seen.append(env)
            if len(seen) == 1:
                break

    import asyncio

    await asyncio.wait_for(drain(), timeout=2)
    assert seen[0].seq == 2
    await bus.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/events/test_redis_bus.py -q`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write the implementation**

```python
# src/draftly/events/redis_bus.py
"""Async Redis pub/sub wrapper for workflow event envelopes.

The only module allowed to import redis. Publishing NEVER raises: a
streaming outage must not fail a workflow (spec §Error handling).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import structlog

from draftly.events.envelope import StreamEnvelope

logger = structlog.get_logger(__name__)

CHANNEL_PREFIX = "draftly:events"


def channel_for(run_id: str) -> str:
    return f"{CHANNEL_PREFIX}:{run_id}"


class RedisEventBus:
    """Publish envelopes to / subscribe iterators over run channels."""

    def __init__(self, redis_client: Any = None, url: str | None = None) -> None:
        if redis_client is not None:
            self._client = redis_client
        else:
            import redis.asyncio as aioredis

            self._client = aioredis.from_url(url or "redis://localhost:6379/0")
        self._pubsubs: list[Any] = []

    async def publish(self, envelope: StreamEnvelope) -> bool:
        try:
            await self._client.publish(channel_for(envelope.run_id), envelope.to_json())
            return True
        except Exception:
            logger.warning(
                "event_bus_publish_failed run_id=%s type=%s",
                envelope.run_id,
                envelope.type,
                exc_info=True,
            )
            return False

    async def subscribe(self, run_id: str) -> AsyncIterator[StreamEnvelope]:
        pubsub = self._client.pubsub()
        await pubsub.subscribe(channel_for(run_id))
        self._pubsubs.append(pubsub)
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    data = message.get("data")
                    raw = data.decode() if isinstance(data, bytes | bytearray) else str(data)
                    yield StreamEnvelope.from_json(raw)
                except Exception:
                    logger.warning("event_bus_bad_frame run_id=%s", run_id, exc_info=True)
        finally:
            await self._close_pubsub(pubsub)

    async def _close_pubsub(self, pubsub: Any) -> None:
        try:
            await pubsub.unsubscribe()
            await pubsub.aclose()
        except Exception:
            pass
        if pubsub in self._pubsubs:
            self._pubsubs.remove(pubsub)

    async def close(self) -> None:
        for pubsub in list(self._pubsubs):
            await self._close_pubsub(pubsub)
        try:
            await self._client.aclose()
        except Exception:
            pass
```

Then extend `StreamEnvelope` in `src/draftly/events/envelope.py` with the two serialization helpers the bus uses:

```python
    def to_json(self) -> str:
        return json.dumps(self.to_dict(), default=str)

    @classmethod
    def from_json(cls, raw: str) -> StreamEnvelope:
        data = json.loads(raw)
        known = {f for f in cls.__dataclass_fields__}  # noqa: C416
        return cls(**{k: v for k, v in data.items() if k in known})
```

(`json` import already required at top of envelope.py.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/events/ -q`
Expected: PASS (envelope + bus suites)

Run: `make lint && make typecheck`
Expected: clean

---

### Task 4: Runner streaming path behind publisher flag

**Files:**
- Modify: `src/draftly/workflows/runner.py` (ctor + `run()` step 3 around line 92–107)
- Modify: `tests/workflows/test_phase5_runner_events.py` (add streaming suite)

**Interfaces:**
- Consumes: `filter_graph_event`/`StreamEnvelope` (Task 1); publisher duck-type `async publish(envelope) -> Any`.
- Produces: `WorkflowRunner(context, graph_factory=..., publisher=None)`; graphs used in streaming mode MUST implement `stream_async(task, invocation_state=...) -> AsyncIterator[dict]` whose final yielded event contains `"result"`. New module-level exception `class StreamingResultMissing(RuntimeError)` raised if the stream ends without a result event.

- [ ] **Step 1: Write the failing tests** (append to `tests/workflows/test_phase5_runner_events.py`)

```python
# ================================================================
# Streaming mode (§7.5 #5) — publisher wired => stream_async path
# ================================================================

from draftly.events.envelope import StreamEnvelope


class StreamingFakeGraph(FakeGraph):
    """Emits scripted events then the terminal result event."""

    def __init__(self, result, events=None):
        super().__init__(result)
        self.events = list(events or [])
        self.streamed_task = None

    async def stream_async(self, task, invocation_state=None, **kwargs):
        del kwargs
        self.streamed_task = task
        for raw in self.events:
            yield raw
        yield {"result": self.result}


class RecordingPublisher:
    def __init__(self):
        self.published: list[StreamEnvelope] = []

    async def publish(self, envelope):
        self.published.append(envelope)


STREAM_EVENTS = [
    {"type": "multiagent_node_start", "node_id": "classify", "node_type": "agent"},
    {"init_event_loop": True},  # noise — must be dropped
    {
        "type": "multiagent_node_stream",
        "node_id": "writer",
        "event": {"data": "hello "},
    },
    {
        "type": "multiagent_node_stop",
        "node_id": "classify",
        "node_result": {"status": "COMPLETED", "duration": 0.5},
    },
    {
        "type": "multiagent_handoff",
        "from_node_ids": ["classify"],
        "to_node_ids": ["write"],
    },
]


async def test_publisher_wired_streams_and_preserves_outcome():
    publisher = RecordingPublisher()
    context = make_context()
    graph = StreamingFakeGraph(completed_result(), STREAM_EVENTS)
    runner = WorkflowRunner(
        context, graph_factory=lambda r, s: graph, publisher=publisher
    )

    state = await runner.run(dict(PR_EVENT))

    assert state.status.value == "delivered"
    types = [e.type for e in publisher.published]
    assert types == [
        "node_start",
        "text_delta",
        "node_stop",
        "handoff",
        "workflow_result",
    ]
    seqs = [e.seq for e in publisher.published]
    assert seqs == [1, 2, 3, 4, 5]
    assert all(e.run_id == "evt-1" for e in publisher.published)
    assert all(e.surface == "pull_request" for e in publisher.published)
    assert context.events.statuses["evt-1"] == "completed"


async def test_no_publisher_keeps_invoke_async_path():
    context = make_context()
    graph = FakeGraph(completed_result())
    runner = WorkflowRunner(context, graph_factory=lambda r, s: graph)

    state = await runner.run(dict(PR_EVENT))

    assert state.status.value == "delivered"
    assert len(graph.calls) == 1


async def test_streaming_interrupt_outcome_matches_invoke_path():
    publisher = RecordingPublisher()
    context = make_context()
    graph = StreamingFakeGraph(interrupted_result(), STREAM_EVENTS[:1])
    runner = WorkflowRunner(
        context, graph_factory=lambda r, s: graph, publisher=publisher
    )

    state = await runner.run(dict(PR_EVENT))

    assert state.status.value == "pending_review"
    assert len(state.interrupts) == 1
    terminal = publisher.published[-1]
    assert terminal.type == "workflow_result"
    assert terminal.payload["status"] == "INTERRUPTED"
    assert terminal.payload["interrupts"][0]["id"].endswith("doc-review")


async def test_stream_missing_result_raises():
    class NoResultGraph(StreamingFakeGraph):
        async def stream_async(self, task, invocation_state=None, **kwargs):
            for raw in self.events:
                yield raw

    publisher = RecordingPublisher()
    context = make_context()
    graph = NoResultGraph(completed_result(), STREAM_EVENTS[:1])
    runner = WorkflowRunner(
        context, graph_factory=lambda r, s: graph, publisher=publisher
    )

    with pytest.raises(RuntimeError, match="without a result"):
        await runner.run(dict(PR_EVENT))
```

Also extend `FakeGraph`'s sibling doubles used elsewhere in this file? No — only `WorkflowRunner` changes; existing tests construct runners without `publisher`, which stays optional.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/workflows/test_phase5_runner_events.py -q`
Expected: FAIL — `TypeError: WorkflowRunner.__init__() got an unexpected keyword argument 'publisher'`

- [ ] **Step 3: Implement**

In `src/draftly/workflows/runner.py`:

Imports (top): `from collections.abc import AsyncIterator`, and `from draftly.events.envelope import StreamEnvelope, filter_graph_event`.

Ctor change:

```python
    def __init__(
        self,
        context: WorkflowContext,
        *,
        graph_factory: GraphFactory | None = None,
        dispatcher: EventDispatcher | None = None,
        publisher: Any = None,
    ) -> None:
        self.context = context
        self._graph_factory = graph_factory or _default_graph_factory(context)
        self.dispatcher = dispatcher or EventDispatcher()
        self.publisher = publisher
```

Replace step 3 block in `run()` (the `started = time.monotonic()` … `state.result = result` section) with:

```python
        # 3. Invoke; runtime context rides in invocation_state, never in
        #    the prompt. ReviewGate reads review_policy before delivering.
        started = time.monotonic()
        invocation_state = {
            "run_id": run_id,
            "review_policy": self.context.review_policy(),
            "delivery_summary": "",
            "evaluation": {},
            "evidence_count": 0,
            "source": str(event.get("source") or "github"),
            "event_type": str(event.get("event_type") or "unknown"),
            "project_id": str(event.get("project_id") or ""),
        }
        if self.publisher is not None:
            result = await self._invoke_streaming(
                graph, json.dumps(event), invocation_state, surface
            )
        else:
            result = await graph.invoke_async(
                json.dumps(event), invocation_state=invocation_state
            )
```

Add methods:

```python
    class _StreamMissing(RuntimeError):
        pass

    async def _invoke_streaming(
        self,
        graph: Any,
        task: str,
        invocation_state: dict[str, Any],
        surface: str,
    ) -> Any:
        """Iterate graph.stream_async, publish envelopes, return GraphResult."""
        seq = 0
        result: Any = None
        async for raw in graph.stream_async(task, invocation_state=invocation_state):
            envelope = filter_graph_event(
                raw if isinstance(raw, dict) else {},
                run_id=invocation_state["run_id"],
                surface=surface,
            )
            if envelope is not None:
                seq += 1
                envelope.seq = seq
                await self._safe_publish(envelope)
            if isinstance(raw, dict) and ("result" in raw or raw.get("force_stop")):
                # Re-shape terminal events so the runner sees the same
                # payload semantics as filter_graph_event produced above.
                if envelope is not None and envelope.type == "workflow_result":
                    result = self._result_from_payload(raw, envelope)
        if result is None:
            raise RuntimeError(
                "stream ended without a result event "
                f"run_id={invocation_state['run_id']}"
            )
        return result

    async def _safe_publish(self, envelope: StreamEnvelope) -> None:
        try:
            await self.publisher.publish(envelope)
        except Exception:
            logger.warning(
                "runner_publish_failed run_id=%s seq=%s",
                envelope.run_id,
                envelope.seq,
                exc_info=True,
            )

    @staticmethod
    def _result_from_payload(raw: dict[str, Any], envelope: StreamEnvelope) -> Any:
        """Recover the original GraphResult object from the terminal event."""
        original = raw.get("result")
        if original is not None:
            return original
        # force_stop without result: synthesize a failed MultiAgentResult-like
        # object so outcome handling below behaves as FAILED.
        return SimpleNamespace(
            status=Status.FAILED,
            interrupts=[],
            execution_order=[],
            failed_nodes=0,
        )
```

Add import `from types import SimpleNamespace`. Remove the now-unused `_StreamMissing` sketch (use the plain `RuntimeError` raise shown).

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/workflows/test_phase5_runner_events.py -q`
Expected: PASS — all prior outcomes tests still green (flag-off unchanged) + new streaming suite green.

Run: `make lint && make typecheck`
Expected: clean

---

### Task 5: Composition wiring + local redis compose

**Files:**
- Modify: `src/draftly/app/composition/workflows.py:107` (inject publisher when enabled)
- Create: `docker-compose.redis.yml` (backend root, beside Makefile)
- Test: `tests/composition/test_workflows_composition.py` (extend if present, else create focused test)

**Interfaces:**
- Consumes: `RedisEventBus` (Task 3); settings (Task 2); `ComposedWorkflows.runner` gains a publisher.
- Produces: composition returns runner with `publisher` set iff `events_streaming_enabled`; API process accesses the SAME bus via app state (`request.app.state.draftly.event_bus`) — Task 6 wires that attribute here too.

- [ ] **Step 1: Failing test**

```python
# tests/composition/test_workflows_composition.py
"""Composition wires RedisEventBus into the runner only when enabled."""

from __future__ import annotations

from typing import Any

from draftly.app.composition.workflows import build_workflows


class StubSettings:
    worker_enabled = True
    events_streaming_enabled = True
    redis_url = "redis://localhost:6379/0"

    strands = type("S", (), {"session_storage_dir": ".draftly/sessions"})()

    def __getattr__(self, name: str) -> Any:
        return None


def test_disabled_flag_leaves_runner_unpublished() -> None:
    settings = StubSettings()
    settings.events_streaming_enabled = False
    composed = build_workflows(settings=settings)
    assert composed.runner.publisher is None


def test_enabled_flag_attaches_bus() -> None:
    composed = build_workflows(settings=StubSettings())
    assert composed.runner.publisher is not None
```

Check the actual signature of `build_workflows` in `composition/workflows.py` first and adapt construction kwargs to match reality (it may take explicit args rather than `settings=`); the assertions above are the contract.

Run: `uv run pytest tests/composition/test_workflows_composition.py -q`
Expected: FAIL (publisher always None / signature mismatch surfaced)

- [ ] **Step 2: Implement wiring**

In `build_workflows(...)` (same function containing `runner = WorkflowRunner(context)`):

```python
    publisher = None
    event_bus = None
    if getattr(config, "events_streaming_enabled", False):
        from draftly.events.redis_bus import RedisEventBus

        event_bus = RedisEventBus(url=getattr(config, "redis_url", None))
        publisher = event_bus

    runner = WorkflowRunner(context, publisher=publisher)
```

Return the bus alongside so the API layer reuses one connection pool — extend the `ComposedWorkflows` dataclass with `event_bus: Any = None` and pass it; expose it on app state wherever `ComposedWorkflows` is attached (`app.state.draftly.event_bus = composed.event_bus` — locate the attachment point in `app/lifecycle.py` and add one line).

- [ ] **Step 3: Compose file for local dev**

```yaml
# docker-compose.redis.yml — local dev dependency for event streaming
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
```

Run: `docker compose -f docker-compose.redis.yml up -d && docker compose -f docker-compose.redis.yml ps`
Expected: redis healthy (or skip if Docker unavailable — unit tests use fakeredis).

- [ ] **Step 4: Verify**

Run: `uv run pytest tests/composition/ tests/workflows/ -q && make lint && make typecheck`
Expected: PASS, clean

---

### Task 6: SSE routes — stream ticket + events endpoint

**Files:**
- Create: `src/draftly/app/api/routes/workflows.py`
- Modify: `src/draftly/app/api/routes/__init__.py` (add `workflows`)
- Modify: `src/draftly/app/api/app.py` (include_router alongside existing entries)
- Modify: `src/draftly/observability/events.py` (reuse `EventStream`/`format_sse` — no change needed unless imports require adjustment)
- Test: `tests/api/test_workflows_stream.py`

**Interfaces:**
- Consumes: `get_verified_token` (existing auth dep), repositories `.jobs.get(job_id=...)`, `RedisEventBus.subscribe` (Task 3), `EventStream` + `format_sse` (observability/events.py), `EventSourceResponse` NOT used — plain `fastapi.responses.StreamingResponse`.
- Produces:
  - `POST /workflows/{run_id}/stream-ticket` → `{"ticket": "..."}`
  - `GET /workflows/{run_id}/events?ticket=...` → `text/event-stream`; frames `event: <type>\ndata: <envelope json>`; heartbeat comments `: ping`; terminal `workflow_result` ends the response with status 200.
  - In-memory ticket store `TicketStore.issue(run_id, org_id, ttl=60) -> str` / `TicketStore.consume(ticket) -> tuple[str, str] | None` (single-use).

- [ ] **Step 1: Failing tests**

```python
# tests/api/test_workflows_stream.py
"""SSE endpoint: ticket auth, frame shape, terminal-on-result."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fakeredis.aioredis import FakeRedis
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from draftly.app.api.routes.workflows import (
    TicketStore,
    router,
    set_event_bus_factory,
)


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    application = FastAPI()
    application.include_router(router)

    tickets = TicketStore(ttl_seconds=60)
    application.state.tickets = tickets

    class FakeJobsRepo:
        async def get(self, *, job_id: str) -> dict[str, Any] | None:
            if job_id == "evt-1":
                return {"job_id": "evt-1", "org_id": "org-1", "status": "running"}
            return None

    class FakeRepositories:
        jobs = FakeJobsRepo()

    class FakeDraftlyState:
        repositories = FakeRepositories()
        event_bus = None  # set per-test

    application.state.draftly = FakeDraftlyState()

    async def fake_token(request: Any) -> dict[str, Any]:
        return {"org_id": "org-1", "sub": "user-1"}

    from draftly.app.api import auth

    monkeypatch.setattr(auth, "get_verified_token", lambda: fake_token)
    return application


async def issue_ticket(app: FastAPI, run_id: str = "evt-1") -> str:
    return app.state.tickets.issue(run_id, org_id="org-1")


async def test_rejects_invalid_ticket(app: FastAPI) -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        resp = await client.get("/workflows/evt-1/events", params={"ticket": "bogus"})
    assert resp.status_code == 403


async def test_unknown_run_ticket_denied(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    # ticket issued for unknown run fails the org-access check at issuance
    with pytest.raises(LookupError):
        await _checked_issue(app, "missing-run")


async def _checked_issue(app: FastAPI, run_id: str) -> str:
    # replicate route logic: run must exist in jobs for org
    jobs = app.state.draftly.repositories.jobs
    record = await jobs.get(job_id=run_id)
    if record is None:
        raise LookupError(run_id)
    return app.state.tickets.issue(run_id, org_id=str(record["org_id"]))


async def test_stream_frames_and_terminal(app: FastAPI) -> None:
    from draftly.events.envelope import StreamEnvelope
    from draftly.events.redis_bus import RedisEventBus

    bus = RedisEventBus(redis_client=FakeRedis())
    app.state.draftly.event_bus = bus
    ticket = app.state.tickets.issue("evt-1", org_id="org-1")

    start = StreamEnvelope(
        type="node_start", run_id="evt-1", surface="documentation", seq=1
    )
    done = StreamEnvelope(
        type="workflow_result", run_id="evt-1", surface="documentation", seq=2
    )
    done.payload = {"status": "COMPLETED", "interrupts": []}

    body = b""

    async def consume() -> None:
        nonlocal body
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            async with client.stream(
                "GET", "/workflows/evt-1/events", params={"ticket": ticket}
            ) as resp:
                assert resp.status_code == 200
                async for chunk in resp.aiter_bytes():
                    body += chunk

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.2)  # subscriber attaches
    await bus.publish(start)
    await bus.publish(done)
    await asyncio.wait_for(task, timeout=5)

    text = body.decode()
    assert "event: node_start" in text
    assert '"type": "workflow_result"' in text.replace("'type'", '"type"') or '"workflow_result"' in text
    await bus.close()


async def test_tickets_are_single_use(app: FastAPI) -> None:
    app.state.tickets.issue("evt-1", org_id="org-1")
    store: TicketStore = app.state.tickets
    ticket = store.issue("evt-1", org_id="org-1")
    assert store.consume(ticket) == ("evt-1", "org-1")
    assert store.consume(ticket) is None
```

NOTE: adapt the `fake_token` monkeypatch to however `get_verified_token` is actually consumed by routes (it is used as `dependencies=[Depends(get_verified_token)]` in existing routers — mirror that usage in the new router so the override mechanism matches `tests/api/test_routes_smoke.py`; copy its exact override pattern).

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/api/test_workflows_stream.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the route module**

```python
# src/draftly/app/api/routes/workflows.py
"""Workflow event streaming: one-time tickets + SSE bridge (spec §Components).

Browser EventSource cannot set headers, so clients exchange their Clerk
token for a single-use short-lived ticket bound to (org_id, run_id), then
open GET /workflows/{run_id}/events?ticket=...
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from draftly.app.api.auth import get_verified_token
from draftly.events.envelope import StreamEnvelope

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/workflows", tags=["workflows"])

_HEARTBEAT_SECONDS = 15


class TicketStore:
    """Single-use, TTL-bound stream tickets (in-process)."""

    def __init__(self, ttl_seconds: int = 60) -> None:
        self._ttl = ttl_seconds
        self._tickets: dict[str, tuple[str, str, float]] = {}

    def issue(self, run_id: str, *, org_id: str) -> str:
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = (run_id, org_id, time.monotonic() + self._ttl)
        return ticket

    def consume(self, ticket: str) -> tuple[str, str] | None:
        entry = self._tickets.pop(ticket, None)
        if entry is None:
            return None
        run_id, org_id, expires_at = entry
        if time.monotonic() > expires_at:
            return None
        return run_id, org_id


def _tickets(request: Request) -> TicketStore:
    store = getattr(request.app.state, "tickets", None)
    if store is None:
        store = TicketStore()
        request.app.state.tickets = store
    return store


async def _issue_ticket(
    run_id: str,
    request: Request,
    token: dict[str, Any] = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = str(token.get("org_id") or "")
    if not org_id:
        raise HTTPException(status_code=400, detail="No organization selected")

    repositories = request.app.state.draftly.repositories
    record = await repositories.jobs.get(job_id=run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
    if str(record.get("org_id") or "") != org_id:
        raise HTTPException(status_code=403, detail="Run belongs to another organization")

    return {"ticket": _tickets(request).issue(run_id, org_id=org_id)}


router.add_api_route(
    "/{run_id}/stream-ticket",
    _issue_ticket,
    methods=["POST"],
)


async def _event_source(
    request: Request,
    queue: asyncio.Queue[dict[str, Any] | None],
) -> AsyncIterator[str]:
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
        except TimeoutError:
            yield ": ping\n\n"
            continue
        if event is None:
            yield "event: workflow_result\ndata: {}\n\n"
            return
        yield _format_envelope(event)
        if event.get("type") == "workflow_result":
            return


def _format_envelope(event: dict[str, Any]) -> str:
    name = str(event.get("type", "message"))
    return f"event: {name}\ndata: {json.dumps(event, default=str)}\n\n"


@router.get("/{run_id}/events")
async def stream_events(
    run_id: str,
    ticket: str,
    request: Request,
) -> StreamingResponse:
    claimed = _tickets(request).consume(ticket)
    if claimed is None or claimed[0] != run_id:
        raise HTTPException(status_code=403, detail="Invalid or expired ticket")

    bus = getattr(request.app.state.draftly, "event_bus", None)
    if bus is None:
        raise HTTPException(status_code=503, detail="Event bus unavailable")

    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=256)

    async def pump() -> None:
        try:
            async for envelope in bus.subscribe(run_id):
                payload = envelope.to_dict() if isinstance(envelope, StreamEnvelope) else envelope
                try:
                    queue.put_nowait(payload)
                except asyncio.QueueFull:
                    logger.warning("sse_slow_consumer run_id=%s", run_id)
                if payload.get("type") == "workflow_result":
                    break
        except Exception:
            logger.warning("sse_pump_failed run_id=%s", run_id, exc_info=True)
        finally:
            queue.put_nowait(None)

    pump_task = asyncio.create_task(pump())

    async def on_close() -> None:
        pump_task.cancel()

    return StreamingResponse(
        _event_source(request, queue),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        background=on_close,  # replaced below if BackgroundTask needed
    )
```

If `background=` requires a starlette `BackgroundTask`, wrap: `background=BackgroundTask(on_close)` importing `from starlette.background import BackgroundTask`. Register the router: add `workflows` to `routes/__init__.py` imports/`__all__`, and in `app/api/app.py` add `app.include_router(workflows.router, prefix=settings.api_prefix)` mirroring neighboring lines.

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/api/test_workflows_stream.py tests/api/test_routes_smoke.py -q`
Expected: PASS

Run: `make lint && make typecheck`
Expected: clean

---

### Task 7: `POST /documentation/sync` returns 202 immediately

**Files:**
- Modify: `src/draftly/app/api/routes/documentation.py:46-69`
- Test: extend `tests/api/test_routes_smoke.py` (follow its existing stub patterns)

**Interfaces:**
- Consumes: existing `worker.task_runner.has_task` / scheduling; job repo `create` (JobRepositoryImpl.create, Task context).
- Produces: response `202 {"job_id": ..., "run_id": ..., "status": "submitted"}`; the sync work runs via the task scheduler instead of awaiting completion inline.

- [ ] **Step 1: Failing test** — add to `tests/api/test_routes_smoke.py` following that file's app/client fixtures:

```python
async def test_documentation_sync_returns_202_immediately(client) -> None:
    # client fixture already overrides auth + state per file conventions;
    # stub worker.task_scheduler.submit to capture without executing.
    captured = {}

    class FakeScheduler:
        async def submit(self, task_name, **kwargs):
            captured["task"] = task_name
            captured["kwargs"] = kwargs
            return "job-123"

    class FakeTaskRunner:
        def has_task(self, name):
            return name == "documentation.sync_repository"

    class FakeWorker:
        task_runner = FakeTaskRunner()
        task_scheduler = FakeScheduler()

    client.app.state.draftly.worker = FakeWorker()

    resp = await client.post(
        "/documentation/sync",
        json={"repository_full_name": "acme/api"},
    )

    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "submitted"
    assert captured["task"] == "documentation.sync_repository"
```

Adapt fixture names/stub shapes to what `test_routes_smoke.py` actually provides (read it first; it already stubs `invoke_async` at line 225 — reuse its pattern).

Run: `uv run pytest tests/api/test_routes_smoke.py -k sync -q`
Expected: FAIL (currently 200 + awaited result)

- [ ] **Step 2: Implement**

Replace the body of `sync_documentation` after the `has_task` guard:

```python
    scheduler = getattr(worker, "task_scheduler", None)
    if scheduler is None or not hasattr(scheduler, "submit"):
        raise HTTPException(status_code=503, detail="Scheduler unavailable")

    job_id = await scheduler.submit(
        "documentation.sync_repository",
        org_id=org_id,
        repository_full_name=body.repository_full_name,
        include=body.include,
        exclude=body.exclude,
    )

    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "run_id": job_id, "status": "submitted"},
    )
```

Import `JSONResponse` from `fastapi.responses`. If `task_scheduler.submit` does not exist yet on the real scheduler (`app/workers/scheduler.py`), add a minimal `submit` coroutine there that registers the task with its arguments and returns the generated job id, reusing whatever persistence `task_runner` uses for job records (mirror `DatabaseJobsStore.insert` call sites found via `grep -rn "jobs" src/draftly/integrations/database/`). The old synchronous behavior remains reachable through `POST /jobs/run` — do not delete it there.

- [ ] **Step 3: Verify**

Run: `uv run pytest tests/api -q && make lint && make typecheck`
Expected: PASS, clean

---

## Phase 2 — Observability (persist + frontend)

### Task 8: `workflow_events` persistence + Last-Event-ID replay

**Files:**
- Create: `src/draftly/integrations/database/workflow_events_store.py`
- Create: `src/draftly/persistence/repositories/workflow_events.py`
- Modify: `src/draftly/app/composition/workflows.py` (wrap publisher: persist + forward)
- Modify: `src/draftly/app/api/routes/workflows.py` (honor `Last-Event-ID` header: replay stored rows seq > last before going live)
- Test: `tests/persistence/test_workflow_events_store.py`, extend `tests/api/test_workflows_stream.py`

**Interfaces:**
- Consumes: database pool pattern of `integrations/database/jobs_store.py` (read it first; mirror its connection acquisition exactly); `StreamEnvelope`.
- Produces:
  - `WorkflowEventsStore.append(envelope_dict: dict) -> None`, `list_after(run_id: str, seq: int, limit: int = 500) -> list[dict]`
  - Repository impl delegating like `JobRepositoryImpl` does.
  - Table: `workflow_events (run_id TEXT, seq INT, ts TIMESTAMPTZ, type TEXT, node_id TEXT NULL, payload JSONB, PRIMARY KEY (run_id, seq))`.

- [ ] **Step 1: Migration SQL** — add to the migrations location used by `make migrate` (inspect Makefile target for the directory; create `NNNN_workflow_events.sql` there):

```sql
CREATE TABLE IF NOT EXISTS workflow_events (
    run_id TEXT NOT NULL,
    seq INT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    type TEXT NOT NULL,
    node_id TEXT,
    payload JSONB NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events (run_id, seq);
```

- [ ] **Step 2: Failing store test**

```python
# tests/persistence/test_workflow_events_store.py
"""Store round-trip against a stubbed pool (offline)."""

from __future__ import annotations

from typing import Any

from draftly.integrations.database.workflow_events_store import WorkflowEventsStore


class FakePool:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple]] = []
        self.rows: list[dict[str, Any]] = []

    def connection(self, timeout: float = 10.0):
        return FakeConn(self)


class FakeConn:
    def __init__(self, pool: FakePool) -> None:
        self.pool = pool

    async def __aenter__(self) -> FakeConn:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def execute(self, sql: str, *params: Any) -> None:
        self.pool.executed.append((sql, params))

    def cursor(self, row_factory: Any = None) -> FakeCursor:
        return FakeCursor(self.pool)


class FakeCursor:
    def __init__(self, pool: FakePool) -> None:
        self.pool = pool

    async def __aenter__(self) -> FakeCursor:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def fetchmany(self, size: int = 64) -> list[dict[str, Any]]:
        return list(self.pool.rows)


async def test_append_executes_insert() -> None:
    pool = FakePool()
    store = WorkflowEventsStore(pool=pool)
    await store.append({"run_id": "r1", "seq": 1, "type": "node_start"})
    sql, params = pool.executed[0]
    assert "INSERT INTO workflow_events" in sql
    assert params[0] == "r1"


async def test_list_after_selects_seq_gt() -> None:
    pool = FakePool()
    pool.rows = [{"seq": 2}]
    store = WorkflowEventsStore(pool=pool)
    rows = await store.list_after("r1", seq=1)
    assert rows == [{"seq": 2}]
    sql, _ = pool.executed[0]
    assert "seq >" in sql
```

Mirror the REAL pool interface from `jobs_store.py` — adjust `connection()/cursor()/fetchmany` shapes to match it exactly after reading that file; the assertions are the contract.

Run: `uv run pytest tests/persistence/test_workflow_events_store.py -q`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement store + repository**

`workflow_events_store.py` follows `jobs_store.py`'s structure verbatim (pool acquisition, SQL strings) with:

```sql
-- append
INSERT INTO workflow_events (run_id, seq, ts, type, node_id, payload)
VALUES (%s, %s, now(), %s, %s, %s::jsonb)
-- list_after
SELECT run_id, seq, ts, type, node_id, payload
FROM workflow_events WHERE run_id = %s AND seq > %s ORDER BY seq LIMIT %s
```

`persistence/repositories/workflow_events.py` mirrors `JobRepositoryImpl` delegation style:

```python
from __future__ import annotations

from typing import Any

from draftly.integrations.database.workflow_events_store import WorkflowEventsStore


class WorkflowEventRepositoryImpl:
    def __init__(self, store: WorkflowEventsStore | None = None) -> None:
        self.store = store or WorkflowEventsStore()

    async def append(self, envelope: dict[str, Any]) -> None:
        await self.store.append(envelope)

    async def list_after(self, run_id: str, *, seq: int, limit: int = 500) -> list[dict[str, Any]]:
        return await self.store.list_after(run_id, seq=seq, limit=limit)
```

- [ ] **Step 4: Wrap publisher in composition** — replace direct bus assignment with a tee:

```python
class TeePublisher:
    """Persist every envelope, then fan out to Redis; persistence failures logged."""

    def __init__(self, primary: Any, fallback_repo: Any) -> None:
        self.primary = primary
        self.repo = fallback_repo

    async def publish(self, envelope: Any) -> None:
        try:
            await self.repo.append(envelope.to_dict())
        except Exception:
            logger.warning("workflow_event_persist_failed", exc_info=True)
        await self.primary.publish(envelope)
```

Use `TeePublisher(event_bus, WorkflowEventRepositoryImpl(...))` when flag on AND db repo available; unit-test the tee ordering in `tests/composition/test_workflows_composition.py` (assert repo got dict BEFORE bus published — order matters for Last-Event-ID correctness).

- [ ] **Step 5: Replay in SSE route** — in `stream_events`, before pumping live:

```python
    last_event_id = request.headers.get("last-event-id")
    last_seq = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    events_repo = getattr(request.app.state.draftly.dependencies.repositories, "workflow_events", None)
    replayed: list[dict[str, Any]] = []
    if events_repo is not None and last_seq:
        replayed = await events_repo.list_after(run_id, seq=last_seq)
```

Yield replayed frames first (tagging each frame's `id:` field with `str(seq)` — extend `_format_envelope` to emit `id: {seq}\n`), then attach the live pump skipping envelopes with `seq <= last_seq`.

- [ ] **Step 6: Extend SSE tests** — replay case: seed fake repo with seq 2 row, connect with `Last-Event-ID: 1`, assert first frame is seq 2 then live frames follow.

Run: `uv run pytest tests/persistence tests/api/test_workflows_stream.py -q && make lint && make typecheck`
Expected: PASS, clean

---

### Task 9: Frontend live execution view

**Files:**
- Create: `draftly-agent-frontend/hooks/use-workflow-events.ts`
- Modify: `draftly-agent-frontend/components/workflows/execution-graph.tsx` (consume hook; color nodes running/done/failed from `node_start`/`node_stop.status`)
- Modify: the docs-sync submit UI (locate via `grep -rn "documentation/sync" draftly-agent-frontend`) — on 202 response, open the stream and drive progress instead of awaiting.

**Interfaces:**
- Consumes: `POST /workflows/{run_id}/stream-ticket` then `GET /workflows/{run_id}/events?ticket=`; envelope JSON shape from Task 1.
- Produces: `useWorkflowEvents(runId: string | null): { status: "idle"|"connecting"|"live"|"closed"|"error"; events: StreamEvent[]; nodeStates: Record<string, "running"|"completed"|"failed">; text: string }` where `StreamEvent = { type, runId, seq, ts, nodeId?, payload }`.

- [ ] **Step 1: Hook implementation**

```typescript
// draftly-agent-frontend/hooks/use-workflow-events.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type StreamEventType =
  | "node_start"
  | "node_stop"
  | "handoff"
  | "text_delta"
  | "tool_progress"
  | "workflow_result";

export interface StreamEvent {
  type: StreamEventType;
  runId: string;
  seq: number;
  ts: string;
  nodeId?: string | null;
  payload: Record<string, unknown>;
}

export type NodeState = "running" | "completed" | "failed";

export function useWorkflowEvents(runId: string | null) {
  const [status, setStatus] = useState<
    "idle" | "connecting" | "live" | "closed" | "error"
  >("idle");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [text, setText] = useState("");
  const sourceRef = useRef<EventSource | null>(null);

  const apply = useCallback((event: StreamEvent) => {
    setEvents((prev) => [...prev.slice(-500), event]);
    if (event.nodeId) {
      setNodeStates((prev) => ({
        ...prev,
        [event.nodeId as string]:
          event.type === "node_start"
            ? "running"
            : event.type === "node_stop"
              ? event.payload.status === "COMPLETED"
                ? "completed"
                : "failed"
              : (prev[event.nodeId as string] ?? "running"),
      }));
    }
    if (event.type === "text_delta" && typeof event.payload.text === "string") {
      setText((prev) => prev + event.payload.text);
    }
    if (event.type === "workflow_result") setStatus("closed");
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let source: EventSource | null = null;

    (async () => {
      setStatus("connecting");
      try {
        const res = await fetch(`/api/workflows/${runId}/stream-ticket`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`ticket ${res.status}`);
        const { ticket } = (await res.json()) as { ticket: string };
        if (cancelled) return;

        // Route through your existing API base/proxy path if one exists.
        source = new EventSource(`/api/workflows/${runId}/events?ticket=${encodeURIComponent(ticket)}`);
        sourceRef.current = source;
        source.onopen = () => setStatus("live");
        source.onmessage = (e) => apply(JSON.parse(e.data) as StreamEvent);
        for (const t of [
          "node_start",
          "node_stop",
          "handoff",
          "text_delta",
          "tool_progress",
          "workflow_result",
        ]) {
          source.addEventListener(t, (e) =>
            apply(JSON.parse((e as MessageEvent).data) as StreamEvent)
          );
        }
        source.onerror = () => {
          setStatus((s) => (s === "closed" ? s : "error"));
          source?.close();
        };
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [runId, apply]);

  return { status, events, nodeStates, text };
}
```

- [ ] **Step 2: Wire `execution-graph.tsx`** — map `nodeStates` onto the component's existing node rendering (read the file; apply className/color per state; show `tool_progress.name` as a subtitle on the active node). Add a `<pre>` writer pane fed by `text` next to the graph. Match the file's existing styling system (tailwind/shadcn per repo conventions).

- [ ] **Step 3: Submit flow** — find the sync submit handler; on `202 {run_id}` switch from loading-spinner-await to `const { status, nodeStates, text } = useWorkflowEvents(runId)` rendering; on `status === "closed"` refetch the documents list.

- [ ] **Step 4: Manual verification**

Run backend: `docker compose -f docker-compose.redis.yml up -d`, enable flag (`EVENTS_STREAMING_ENABLED=true`), `make run`; trigger a sync from the frontend; observe node states progressing and text accumulating. If no model keys available locally, verify against `curl -N "http://localhost:8000/workflows/<run>/events?ticket=<ticket>"` while a test run publishes synthetic envelopes through `RedisEventBus`.

---

## Phase 3 — Support Chat Progressive Rendering

### Task 10: Throttled progressive answers for Slack/Discord

**Files:**
- Create: `src/draftly/events/consumers/support_progressive.py`
- Modify: support workflow registration points `src/draftly/workflows/support/slack_support_workflow.py` and `discord_support_workflow.py` (subscribe the consumer to the run's `text_delta` stream when flag enabled)
- Test: `tests/events/test_support_progressive.py`

**Interfaces:**
- Consumes: `RedisEventBus.subscribe(run_id)`; `DiscordClient.edit_message(channel_id, message_id, content)` (exists, integrations/discord/client.py:171); Slack `chat.update` via existing SlackClient `_request` wrapper (add thin `update_message` method mirroring `send_message`).
- Produces: `SupportProgressiveRenderer(client, *, channel_ref, throttle_seconds=1.0)` with `async run(bus, run_id) -> None` — accumulates `text_delta`, edits the target message at most once per throttle window, stops on `workflow_result`.

- [ ] **Step 1: Failing test**

```python
# tests/events/test_support_progressive.py
"""Progressive renderer: accumulate + throttled edit + terminal stop."""

from __future__ import annotations

import asyncio

from draftly.events.consumers.support_progressive import (
    SupportProgressiveRenderer,
)
from draftly.events.envelope import StreamEnvelope


def delta(text: str, seq: int) -> StreamEnvelope:
    env = StreamEnvelope(type="text_delta", run_id="r", surface="support", seq=seq)
    env.payload = {"text": text}
    return env


class FakeBus:
    def __init__(self, envelopes: list[StreamEnvelope]) -> None:
        self.envelopes = envelopes

    async def subscribe(self, run_id: str):
        for env in self.envelopes:
            yield env


class FakeClient:
    def __init__(self) -> None:
        self.edits: list[str] = []

    async def edit_message(self, channel_id: str, message_id: str, content: str) -> None:
        self.edits.append(content)


async def test_edits_throttled_and_final_flush() -> None:
    client = FakeClient()
    renderer = SupportProgressiveRenderer(
        client,
        channel_ref=("ch-1", "msg-1"),
        throttle_seconds=0,
    )
    envelopes = [delta("a", 1), delta("b", 2), delta("c", 3)]
    envelopes.append(
        StreamEnvelope(
            type="workflow_result", run_id="r", surface="support", seq=4
        )
    )
    envelopes[-1].payload = {"status": "COMPLETED"}

    await asyncio.wait_for(renderer.run(FakeBus(envelopes), "r"), timeout=2)

    # zero throttle => one edit per delta
    assert client.edits == ["a", "ab", "abc"]
```

Add a second test with `throttle_seconds=60` asserting exactly ONE edit occurred (the coalesced final flush on `workflow_result`).

Run: `uv run pytest tests/events/test_support_progressive.py -q`
Expected: FAIL

- [ ] **Step 2: Implement**

```python
# src/draftly/events/consumers/support_progressive.py
"""Progressively render streamed agent output into chat messages."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import structlog

from draftly.events.envelope import StreamEnvelope

logger = structlog.get_logger(__name__)


class SupportProgressiveRenderer:
    def __init__(
        self,
        client: Any,
        *,
        channel_ref: tuple[str, str],
        throttle_seconds: float = 1.0,
    ) -> None:
        self.client = client
        self.channel_id, self.message_id = channel_ref
        self.throttle = throttle_seconds

    async def run(self, bus: Any, run_id: str) -> None:
        buffer = ""
        last_edit = 0.0
        async for envelope in bus.subscribe(run_id):
            if envelope.type == "text_delta":
                buffer += str(envelope.payload.get("text", ""))
                now = time.monotonic()
                if now - last_edit >= self.throttle:
                    await self._edit(buffer)
                    last_edit = now
            elif envelope.type == "workflow_result":
                if buffer:
                    await self._edit(buffer)
                return

    async def _edit(self, content: str) -> None:
        try:
            await self.client.edit_message(
                self.channel_id, self.message_id, content
            )
        except Exception:
            logger.warning("progressive_edit_failed", exc_info=True)
```

Slack side: add `update_message` to `integrations/slack/client.py` mirroring `send_message` but calling `chat.update` with `channel`/`ts`/`text`; the workflow passes `(channel_id, thread_ts)` as `channel_ref`.

Wire-in (both workflows): after the initial ack message is sent and IF `getattr(config, "events_streaming_enabled", False)`, spawn `asyncio.create_task(SupportProgressiveRenderer(...).run(bus, run_id))` before awaiting the runner; the renderer exits itself on `workflow_result`.

- [ ] **Step 3: Verify**

Run: `uv run pytest tests/events tests/workflows -q && make lint && make typecheck`
Expected: PASS, clean

Manual: send a Discord test message with flag on; watch the bot message edit progressively as researcher/writer nodes stream.

---

## Phase 4 — Observability Surface (Read-Side APIs)

### Task 11: Runs + steps audit read APIs

**Files:**
- Modify: `src/draftly/persistence/repositories/agent_runs.py` (add read methods)
- Create: `src/draftly/app/api/routes/runs.py`
- Modify: `src/draftly/app/api/routes/__init__.py` + `src/draftly/app/api/app.py` (register router)
- Test: `tests/api/test_runs_routes.py`

**Interfaces:**
- Consumes: `DatabaseClient` (`execute`, `fetch_one`, `fetch_all` — same methods `ReviewsRepository` uses); `get_verified_token`.
- Produces:
  - `AgentRunsRepository.list_runs(*, org_id: str | None = None, status: str | None = None, limit: int = 50) -> list[dict]`
  - `AgentRunsRepository.get_run(run_id: str) -> dict | None`
  - `AgentRunsRepository.list_steps(run_id: str) -> list[dict]`
  - Routes: `GET /runs?status=&limit=` (org forced from token), `GET /runs/{run_id}`, `GET /runs/{run_id}/steps`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_runs_routes.py
"""Runs audit API: org scoping, limit clamping, step listing."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from draftly.app.api.routes.runs import router


class FakeDatabase:
    def __init__(self, runs: list[dict[str, Any]] | None = None) -> None:
        self.runs = runs or []
        self.queries: list[tuple[str, tuple]] = []

    async def execute(self, sql: str, *params: Any) -> None:
        self.queries.append((sql, params))

    async def fetch_one(self, sql: str, *params: Any) -> dict[str, Any] | None:
        self.queries.append((sql, params))
        run_id = params[0] if params else None
        return next((r for r in self.runs if r["run_id"] == run_id), None)

    async def fetch_all(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        self.queries.append((sql, params))
        return list(self.runs)


def make_app(db: FakeDatabase) -> FastAPI:
    app = FastAPI()
    app.include_router(router)

    class FakeRepos:
        agent_runs = type("R", (), {"database": db})()

    class FakeDeps:
        repositories = FakeRepos()

    class FakeState:
        dependencies = FakeDeps()

    app.state.draftly = FakeState()
    return app


RUN_ROW = {
    "run_id": "evt-1",
    "source": "github",
    "event_type": "pull_request.opened",
    "org_id": "org-1",
    "status": "completed",
}


async def test_list_runs_filters_by_token_org(monkeypatch: pytest.MonkeyPatch) -> None:
    from draftly.app.api import auth

    captured: dict = {}

    def fake_token():
        async def dep() -> dict[str, Any]:
            return {"org_id": "org-1"}

        captured["dep"] = dep
        return dep

    monkeypatch.setattr(auth, "get_verified_token", fake_token)

    db = FakeDatabase(runs=[RUN_ROW])
    app = make_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/runs")

    assert resp.status_code == 200
    assert resp.json()["items"][0]["run_id"] == "evt-1"
    # org clause is bound from the token, never the client
    sql, params = db.queries[-1]
    assert "org_id" in sql


async def test_get_run_404() -> None:
    from draftly.app.api import auth

    monkeypatch_token = lambda: _ok_token  # noqa: E731
    monkeypatch_token.__name__ = "fake"

    async def _ok_token() -> dict[str, Any]:
        return {"org_id": "org-1"}

    import draftly.app.api.routes.runs as runs_mod

    original = runs_mod.get_verified_token
    runs_mod.get_verified_token = lambda: _ok_token  # type: ignore[assignment]
    try:
        app = make_app(FakeDatabase(runs=[RUN_ROW]))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
            resp = await client.get("/runs/missing")
        assert resp.status_code == 404
    finally:
        runs_mod.get_verified_token = original


async def test_limit_clamped_to_200(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _ok_token() -> dict[str, Any]:
        return {"org_id": "org-1"}

    import draftly.app.api.routes.runs as runs_mod

    runs_mod.get_verified_token = lambda: _ok_token  # type: ignore[assignment]
    db = FakeDatabase(runs=[])
    app = make_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        await client.get("/runs", params={"limit": 9999})
    _, params = db.queries[-1]
    assert max(int(p) for p in params if isinstance(p, int)) <= 200
```

NOTE: mirror the exact auth override mechanism used by `tests/api/test_routes_smoke.py` (read its fixtures first — it already overrides `invoke_async` at line 225 and likely patches `get_verified_token` via `app.dependency_overrides`; prefer `app.dependency_overrides[get_verified_token] = ...` over module monkeypatching if that is the file's pattern). The assertions above are the contract; adapt only the override plumbing.

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/api/test_runs_routes.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement repo reads** (append to `agent_runs.py`):

```python
    async def list_runs(
        self,
        *,
        org_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        if self.database is None:
            return []
        clauses: list[str] = []
        params: list[Any] = []
        if org_id:
            params.append(org_id)
            clauses.append(f"org_id = ${len(params)}")
        if status:
            params.append(status)
            clauses.append(f"status = ${len(params)}")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = await self.database.fetch_all(
            f"""
            SELECT run_id, source, event_type, org_id, status, error,
                   started_at, completed_at
            FROM agent_runs {where}
            ORDER BY started_at DESC
            LIMIT ${len(params) + 1}
            """,
            *params,
            max(1, min(limit, 200)),
        )
        return [dict(row) for row in rows]

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        if self.database is None:
            return None
        row = await self.database.fetch_one(
            """
            SELECT run_id, source, event_type, org_id, status, error,
                   started_at, completed_at
            FROM agent_runs WHERE run_id = $1
            """,
            run_id,
        )
        return dict(row) if row else None

    async def list_steps(self, run_id: str) -> list[dict[str, Any]]:
        if self.database is None:
            return []
        rows = await self.database.fetch_all(
            """
            SELECT seq, kind, name, status, duration_ms, detail
            FROM agent_steps WHERE run_id = $1 ORDER BY seq ASC
            """,
            run_id,
        )
        return [dict(row) for row in rows]
```

If `DatabaseClient.fetch_all` returns objects without `.keys()` for `dict(row)`, adapt to the access pattern used in `_row_to_record` of reviews.py (`row.get(...)`) instead.

- [ ] **Step 4: Implement the route**

```python
# src/draftly/app/api/routes/runs.py
"""Run audit trail API over agent_runs/agent_steps (spec §Observability surface)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from draftly.app.api.auth import get_verified_token

router = APIRouter(prefix="/runs", tags=["runs"], dependencies=[Depends(get_verified_token)])


def _repo(request: Request) -> Any:
    repo = getattr(
        getattr(request.app.state.draftly.dependencies, "repositories", None),
        "agent_runs",
        None,
    )
    if repo is None:
        raise HTTPException(status_code=503, detail="Store unavailable")
    return repo


@router.get("")
async def list_runs(
    request: Request,
    token: dict = Depends(get_verified_token),
    status: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List audit runs for the caller's organization."""
    items = await _repo(request).list_runs(
        org_id=str(token.get("org_id") or ""),
        status=status,
        limit=max(1, min(limit, 200)),
    )
    return {"items": items}


@router.get("/{run_id}")
async def get_run(
    run_id: str,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    run = await _repo(request).get_run(run_id)
    if run is None or str(run.get("org_id")) != str(token.get("org_id")):
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
    return {"run": run}


@router.get("/{run_id}/steps")
async def list_run_steps(
    run_id: str,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    run = await _repo(request).get_run(run_id)
    if run is None or str(run.get("org_id")) != str(token.get("org_id")):
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
    steps = await _repo(request).list_steps(run_id)
    return {"items": steps}
```

Register: add `runs` to `routes/__init__.py` imports/`__all__`; in `app/api/app.py` add `app.include_router(...)` mirroring neighboring lines.

- [ ] **Step 5: Verify**

Run: `uv run pytest tests/api/test_runs_routes.py tests/api/test_routes_smoke.py -q && make lint && make typecheck`
Expected: PASS, clean

---

### Task 12: Review queue read APIs

**Files:**
- Create: `src/draftly/app/api/routes/reviews.py`
- Modify: `routes/__init__.py` + `app.py` (register)
- Test: `tests/api/test_reviews_routes.py`

**Interfaces:**
- Consumes: `ReviewsRepository.list_reviews(*, status, org_id, limit)` and `get_review(id)` (both exist); `ReviewRecord` dataclass. Decisions intentionally stay on the existing `POST /github/review/{run_id}` resume route.
- Produces: `GET /reviews?status=pending&limit=` → `{items: [...]}`; `GET /reviews/{review_id}` → `{review: {...}}`. Serialization helper `review_to_dict(record) -> dict` (module-level, reused by both handlers).

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_reviews_routes.py
"""Review queue API: pending list + detail, org-scoped."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from draftly.app.api.routes.reviews import router
from draftly.persistence.repositories.reviews import ReviewRecord


def record(rid: str = "rev-1", org_id: str = "org-1", status: str = "pending") -> ReviewRecord:
    return ReviewRecord(
        id=rid,
        org_id=org_id,
        thread_id="evt-9",
        workflow="documentation",
        tool_name="doc-review",
        tool_args={"interrupt_id": "i-1"},
        action_description="docs update",
        status=status,
        created_at=datetime.now(UTC),
    )


class FakeRepo:
    def __init__(self) -> None:
        self.rows = [record()]
        self.calls: list[dict[str, Any]] = []

    async def list_reviews(self, *, status=None, org_id=None, limit=100):
        self.calls.append({"status": status, "org_id": org_id, "limit": limit})
        return [r for r in self.rows if not status or r.status == status]

    async def get_review(self, review_id: str):
        return next((r for r in self.rows if r.id == review_id), None)


def make_app(repo: FakeRepo) -> FastAPI:
    app = FastAPI()
    app.include_router(router)

    async def ok_token() -> dict[str, Any]:
        return {"org_id": "org-1", "sub": "user-1"}

    app.dependency_overrides[get_verified_token_dep()] = ok_token

    class FakeRepos:
        reviews = repo

    class FakeDeps:
        repositories = FakeRepos()

    class FakeState:
        dependencies = FakeDeps()

    app.state.draftly = FakeState()
    return app


def get_verified_token_dep():
    from draftly.app.api.auth import get_verified_token

    return get_verified_token


async def test_lists_pending_scoped_to_org() -> None:
    repo = FakeRepo()
    app = make_app(repo)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/reviews", params={"status": "pending"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"][0]["id"] == "rev-1"
    assert body["items"][0]["run_id"] == "evt-9"
    assert repo.calls[0]["limit"] <= 200


async def test_detail_404() -> None:
    app = make_app(FakeRepo())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/reviews/nope")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/api/test_reviews_routes.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```python
# src/draftly/app/api/routes/reviews.py
"""Review queue API (spec §Observability surface #1).

Read-only here: approve/reject keeps flowing through the existing
resume route POST /github/review/{run_id} so resume logic stays single-sourced.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from draftly.app.api.auth import get_verified_token
from draftly.persistence.repositories.reviews import ReviewRecord

router = APIRouter(prefix="/reviews", tags=["reviews"], dependencies=[Depends(get_verified_token)])


def review_to_dict(record: ReviewRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "org_id": record.org_id,
        "run_id": record.thread_id,
        "workflow": record.workflow,
        "tool_name": record.tool_name,
        "tool_args": record.tool_args,
        "action_description": record.action_description,
        "status": record.status,
        "decision": record.decision,
        "decision_comment": record.decision_comment,
        "decided_at": _iso(record.decided_at),
        "created_at": _iso(record.created_at),
        "expires_at": _iso(record.expires_at),
        "interrupt_id": (record.tool_args or {}).get("interrupt_id"),
    }


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _repo(request: Request) -> Any:
    repo = getattr(
        getattr(request.app.state.draftly.dependencies, "repositories", None),
        "reviews",
        None,
    )
    if repo is None:
        raise HTTPException(status_code=503, detail="Store unavailable")
    return repo


@router.get("")
async def list_reviews(
    request: Request,
    token: dict = Depends(get_verified_token),
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """List reviews (default: all statuses) for the caller's organization."""
    items = await _repo(request).list_reviews(
        status=status,
        org_id=str(token.get("org_id") or ""),
        limit=max(1, min(limit, 200)),
    )
    return {"items": [review_to_dict(r) for r in items]}


@router.get("/{review_id}")
async def get_review(
    review_id: str,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    record = await _repo(request).get_review(review_id)
    if record is None or record.org_id != str(token.get("org_id")):
        raise HTTPException(status_code=404, detail=f"Unknown review: {review_id}")
    return {"review": review_to_dict(record)}
```

Register in `routes/__init__.py` + `app.py` as in Task 11.

- [ ] **Step 4: Verify**

Run: `uv run pytest tests/api/test_reviews_routes.py -q && make lint && make typecheck`
Expected: PASS, clean

---

### Task 13: Metrics exposition + evaluations org-scoping fix

**Files:**
- Create: `src/draftly/app/api/routes/metrics.py`
- Modify: `src/draftly/app/api/routes/evaluations.py:30-43` (token org)
- Modify: `routes/__init__.py` + `app.py` (register metrics router)
- Test: `tests/api/test_metrics_and_eval_scope.py`

**Interfaces:**
- Consumes: `draftly.observability.metrics.metrics` singleton (`snapshot()`, `render()`).
- Produces: `GET /metrics` → Prometheus text (`text/plain; version=0.0.4`); `GET /metrics/snapshot` → JSON counters/gauges/timings. Evaluations route signature gains `token: dict = Depends(get_verified_token)`.

- [ ] **Step 1: Failing tests**

```python
# tests/api/test_metrics_and_eval_scope.py
"""Metrics endpoints shape + evaluations org pass-through."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from draftly.observability.metrics import metrics


def build_app() -> FastAPI:
    from draftly.app.api.routes.metrics import router as metrics_router

    app = FastAPI()
    app.include_router(metrics_router)
    return app


async def test_prometheus_exposition_contains_counter() -> None:
    metrics.increment("test_metric_total")
    app = build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/metrics")
    assert resp.status_code == 200
    assert "test_metric_total" in resp.text


async def test_snapshot_returns_registry_shape() -> None:
    metrics.set_gauge("test_gauge", 3.5)
    app = build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/metrics/snapshot")
    body = resp.json()
    assert set(body.keys()) == {"counters", "gauges", "timings"}
    assert body["gauges"]["test_gauge"] == 3.5


async def test_evaluations_route_passes_token_org(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    class FakeEvalRepo:
        async def search(self, *, org_id, evaluation_type=None, limit=50):
            seen["org_id"] = org_id
            seen["limit"] = limit
            return []

    class FakeRepos:
        evaluations = FakeEvalRepo()

    class FakeDeps:
        repositories = FakeRepos()

    class FakeState:
        dependencies = FakeDeps()

    from draftly.app.api.auth import get_verified_token
    from draftly.app.api.routes.evaluations import router as eval_router

    async def ok_token() -> dict:
        return {"org_id": "org-77"}

    app = FastAPI()
    app.include_router(eval_router)
    app.dependency_overrides[get_verified_token] = ok_token
    app.state.draftly = FakeState()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/evaluations", params={"limit": 500})

    assert resp.status_code == 200
    assert seen["org_id"] == "org-77"
    assert seen["limit"] == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/api/test_metrics_and_eval_scope.py -q`
Expected: FAIL — metrics router missing; eval route passes `""`.

- [ ] **Step 3: Implement**

```python
# src/draftly/app/api/routes/metrics.py
"""Process metrics exposition (spec §Observability surface #3).

Caveat documented in the spec: registries are process-local; this endpoint
reflects the serving process only (API container ≠ worker container).
Prometheus scrapers should target each container separately.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from draftly.observability.metrics import metrics

router = APIRouter(prefix="/metrics", tags=["metrics"], include_in_schema=False)


@router.get("")
async def prometheus() -> Response:
    return Response(content=metrics.render(), media_type="text/plain; version=0.0.4")


@router.get("/snapshot")
async def snapshot() -> dict:
    return metrics.snapshot()
```

Evaluations fix — change the handler signature and body:

```python
@router.get("")
async def list_evaluations(
    request: Request,
    token: dict = Depends(get_verified_token),
    evaluation_type: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List evaluation runs for the caller's organization."""
    repo = _evaluations(request)
    items = await repo.search(
        org_id=str(token.get("org_id") or ""),
        evaluation_type=evaluation_type,
        limit=max(1, min(limit, 200)),
    )
    return {"items": items}
```

Register the metrics router like Tasks 11/12.

- [ ] **Step 4: Verify**

Run: `uv run pytest tests/api -q && make lint && make typecheck`
Expected: PASS, clean (note: any existing smoke test asserting the old unauthenticated evaluations behavior must be updated to provide the token dependency).

---

### Task 14: Routing decisions, model performance, job history endpoints

**Files:**
- Modify: `src/draftly/persistence/repositories/routing.py` (add `PerformanceRepository.all`)
- Create: `src/draftly/app/api/routes/observability.py`
- Modify: `routes/__init__.py` + `app.py` (register)
- Test: `tests/api/test_observability_routes.py`

**Interfaces:**
- Consumes: `RoutingRepository.recent(limit)` (exists), `DatabaseRoutingStore.get_recent_decisions`; `DatabasePerformanceStore.get_all()` (exists, currently unreached from repo layer); `JobRepositoryImpl.get/list_active` (exist).
- Produces: `PerformanceRepository.all() -> list[dict]`; routes `GET /observability/routing-decisions?limit=`, `GET /observability/model-performance`, `GET /jobs` (active list; existing `POST /jobs/run` untouched).

- [ ] **Step 1: Failing tests**

```python
# tests/api/test_observability_routes.py
"""Routing/performance/jobs read endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from draftly.app.api.routes.observability import router


DECISION = {
    "request_id": "evt-1",
    "task_type": "writer",
    "selected_model": "claude-haiku",
    "provider": "bedrock",
    "score": 4.2,
    "latency_ms": 812.0,
    "success": True,
}

PERF = {"model_name": "claude-haiku", "task_type": "writer", "success_rate": 0.97}


class FakeRepos:
    routing = type("R", (), {"recent": staticmethod(lambda limit=100: [DECISION])})()
    performance = type("P", (), {"all": staticmethod(lambda: [PERF])})()
    jobs = type("J", (), {"list_active": staticmethod(lambda: [{"job_id": "j-1"}])})()


class FakeDeps:
    repositories = FakeRepos()


class FakeState:
    dependencies = FakeDeps()


def make_app() -> FastAPI:
    async def ok_token() -> dict[str, Any]:
        return {"org_id": "org-1"}

    from draftly.app.api.auth import get_verified_token

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = ok_token
    app.state.draftly = FakeState()
    return app


async def test_routing_decisions_clamps_limit() -> None:
    app = make_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/observability/routing-decisions", params={"limit": 10_000})
    assert resp.status_code == 200
    assert resp.json()["items"] == [DECISION]


async def test_model_performance_lists_aggregates() -> None:
    app = make_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/observability/model-performance")
    assert resp.status_code == 200
    assert resp.json()["items"] == [PERF]


async def test_jobs_active_list() -> None:
    app = make_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        resp = await client.get("/jobs")
    assert resp.status_code == 200
    assert resp.json()["items"] == [{"job_id": "j-1"}]
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/api/test_observability_routes.py -q`
Expected: FAIL — module missing / `PerformanceRepository.all` missing.

- [ ] **Step 3: Implement**

Add to `PerformanceRepository` in `routing.py`:

```python
    async def all(self) -> list[dict[str, Any]]:
        """All persisted per-task/model aggregates (read-side for dashboards)."""
        return await self._store.get_all()
```

New route module:

```python
# src/draftly/app/api/routes/observability.py
"""Cross-cutting telemetry reads: routing decisions, model performance, jobs."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from draftly.app.api.auth import get_verified_token

router = APIRouter(tags=["observability"], dependencies=[Depends(get_verified_token)])


def _repos(request: Request) -> Any:
    repos = getattr(request.app.state.draftly.dependencies, "repositories", None)
    if repos is None:
        raise HTTPException(status_code=503, detail="Stores unavailable")
    return repos


@router.get("/observability/routing-decisions")
async def routing_decisions(
    request: Request,
    limit: int = 100,
) -> dict[str, Any]:
    """Recent model-routing decisions with reason codes and actuals."""
    recent = getattr(_repos(request).routing, "recent", None)
    if recent is None:
        raise HTTPException(status_code=503, detail="Routing store unavailable")
    return {"items": await recent(limit=max(1, min(limit, 200)))}


@router.get("/observability/model-performance")
async def model_performance(request: Request) -> dict[str, Any]:
    """Persisted per-task/model EMA aggregates backing quality gates."""
    performance = getattr(_repos(request).performance, "all", None)
    if performance is None:
        raise HTTPException(status_code=503, detail="Performance store unavailable")
    return {"items": await performance()}


@router.get("/jobs")
async def active_jobs(request: Request) -> dict[str, Any]:
    """Currently active background jobs (history: GET /documentation/sync/{job_id})."""
    jobs = getattr(_repos(request).jobs, "list_active", None)
    if jobs is None:
        raise HTTPException(status_code=503, detail="Jobs store unavailable")
    return {"items": await jobs()}
```

Register in `routes/__init__.py` + `app.py`.

- [ ] **Step 4: Verify**

Run: `uv run pytest tests/api -q && make lint && make typecheck`
Expected: PASS, clean

---

### Task 15: Frontend integration — replace dashboard mocks with live APIs

**Files:**
- Create: `draftly-agent-frontend/api/observability.ts`
- Create: `draftly-agent-frontend/hooks/use-polling.ts`
- Modify: `draftly-agent-frontend/api/client.ts` (add `getApiToken()` accessor for the SSE ticket flow)
- Modify: `draftly-agent-frontend/hooks/use-workflow-events.ts` (Task 9's hook: fetch ticket through the shared client)
- Modify: `draftly-agent-frontend/components/dashboard/{agent-activity,active-workflows,needs-attention,quality-gates,system-pulse,recent-signals}.tsx`
- Modify: `draftly-agent-frontend/components/reviews/reviews.tsx` (+ `data.ts` consumers)
- Modify: `draftly-agent-frontend/components/dashboard/data.ts` (delete replaced mock exports)
- Test: none exist for frontend (no test runner configured) — verify via `npm run lint && npm run build` plus manual smoke against local backend

**Interfaces:**
- Consumes: `request<T>(path, options)` from `api/client.ts` (auth-injected, `/api` base rewritten to `API_URL` by next.config); Phase 4 endpoints from Tasks 11–14 (`/runs`, `/runs/{id}/steps`, `/reviews`, `/metrics/snapshot`, `/observability/routing-decisions`, `/observability/model-performance`, `/jobs`).
- Produces:
  - `listRuns(status?, limit?), getRun(id), getRunSteps(id), listReviews(status?), getMetricsSnapshot(), getRoutingDecisions(limit?), getModelPerformance(), getActiveJobs()`
  - `usePolling<T>(fn: () => Promise<T>, intervalMs: number | null): { data: T | null; error: Error | null; loading: boolean; refresh: () => void }`
  - `useRuns(limit?)`, `usePendingReviews()`, `useModelPerformance()`, `useJobs()`, `useMetricsSnapshot(intervalMs = 30_000)` convenience hooks wrapping usePolling.

- [ ] **Step 0: Read Next.js project rules first**

Per `draftly-agent-frontend/AGENTS.md`, this Next.js version has breaking changes vs training data — before writing any component code, skim the relevant guides under `draftly-agent-frontend/node_modules/next/dist/docs/`. All code below is client-side React ("use client" components + hooks), which is stable surface.

- [ ] **Step 1: Add the observability API module**

```typescript
// draftly-agent-frontend/api/observability.ts
import { request } from "./client";

export interface RunRecord {
  run_id: string;
  source: string;
  event_type: string;
  org_id: string;
  status: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface RunStep {
  seq: number;
  kind: string;
  name: string;
  status: string;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
}

export interface ReviewSummary {
  id: string;
  run_id: string;
  workflow: string;
  status: string;
  action_description: string | null;
  interrupt_id: string | null;
  created_at: string | null;
  expires_at: string | null;
}

export interface ModelPerformance {
  model_name: string;
  task_type: string;
  sample_count: number | null;
  success_rate: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  quality_ema: number | null;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timings: Record<string, Record<string, number>>;
}

export async function listRuns(
  status?: string,
  limit = 50,
): Promise<{ items: RunRecord[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set("status", status);
  return request(`/runs?${params.toString()}`);
}

export async function getRun(runId: string): Promise<{ run: RunRecord }> {
  return request(`/runs/${encodeURIComponent(runId)}`);
}

export async function getRunSteps(
  runId: string,
): Promise<{ items: RunStep[] }> {
  return request(`/runs/${encodeURIComponent(runId)}/steps`);
}

export async function listReviews(
  status?: string,
  limit = 100,
): Promise<{ items: ReviewSummary[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set("status", status);
  return request(`/reviews?${params.toString()}`);
}

export async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
  return request("/metrics/snapshot");
}

export async function getRoutingDecisions(
  limit = 100,
): Promise<{ items: Record<string, unknown>[] }> {
  return request(`/observability/routing-decisions?limit=${limit}`);
}

export async function getModelPerformance(): Promise<{
  items: ModelPerformance[];
}> {
  return request("/observability/model-performance");
}

export async function getActiveJobs(): Promise<{
  items: { job_id: string }[];
}> {
  return request("/jobs");
}
```

- [ ] **Step 2: Add the polling hook** (no SWR/react-query in deps — keep it dependency-free)

```typescript
// draftly-agent-frontend/hooks/use-polling.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number | null,
): { data: T | null; error: Error | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => {
    let cancelled = false;
    fnRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = refresh();
    if (intervalMs === null || intervalMs <= 0) return cancel;
    const id = setInterval(refresh, intervalMs);
    return () => {
      cancel();
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
```

- [ ] **Step 3: Expose the token accessor + route Task 9's ticket through the shared client**

In `api/client.ts`, add below `setPendingToken`:

```typescript
export function getApiToken(): Promise<string | null> {
  return _pendingToken ?? Promise.resolve(_token);
}
```

In `hooks/use-workflow-events.ts` (created in Task 9), replace the raw `fetch(...stream-ticket...)` block with:

```typescript
import { request } from "../api/client";
// ...
const res = await request<{ ticket: string }>(`/workflows/${runId}/stream-ticket`, {
  method: "POST",
});
const { ticket } = res;
```

(EventSource itself stays a raw browser API — it cannot carry the Authorization header; the one-time ticket remains the auth mechanism.)

- [ ] **Step 4: Rewire `agent-activity.tsx`** (canonical exemplar — same pattern applies to every component below)

Current file imports `{ agents }` from `"./data"` and maps synchronously. Replace with polled run-step activity derived from the runs API:

```tsx
"use client";

import { useMemo } from "react";
import { Panel } from "./shared";
import { toneClasses, dotClass, type Tone } from "./tone-utils";
import { useRunsActivity } from "@/hooks/use-runs-activity";
```

Create `hooks/use-runs-activity.ts` alongside (keeps the component dumb):

```typescript
// draftly-agent-frontend/hooks/use-runs-activity.ts
"use client";

import { useEffect, useState } from "react";
import { getRunSteps, listRuns, type RunRecord, type RunStep } from "../api/observability";

export interface AgentActivityItem {
  name: string;
  status: string;
  task: string;
  tone: Tone;
}

function statusToTone(status: string): Tone {
  if (status === "completed") return "positive";
  if (status === "failed") return "negative";
  return "neutral";
}

export function useRunsActivity(pollMs = 20_000): {
  items: AgentActivityItem[] | null;
  loading: boolean;
} {
  const [items, setItems] = useState<AgentActivityItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { items: runs } = await listRuns(undefined, 10);
        const latest = runs[0];
        if (!latest || cancelled) {
          if (!cancelled) setItems([]);
          return;
        }
        const { items: steps } = await getRunSteps(latest.run_id);
        if (cancelled) return;
        setItems(
          steps.slice(-8).map((step: RunStep) => ({
            name: step.name,
            status: step.status,
            task: `${latest.event_type} · ${step.kind}`,
            tone: statusToTone(step.status),
          })),
        );
      } catch {
        if (!cancelled) setItems(null); // keep panel renderable on API failure
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  return { items, loading };
}
```

Then in `agent-activity.tsx` replace the `agents.map(...)` source array with `items ?? []` and add an empty state row when `items?.length === 0` ("No agent activity yet") — preserve the existing `Panel`, timeline dot classes, and `toneClasses(agent.tone as Tone)` styling exactly; only the data source changes.

- [ ] **Step 5: Rewire remaining dashboard components** (same pattern; exact substitutions)

| Component | Remove import | Wire to | Mapping notes |
|---|---|---|---|
| `active-workflows.tsx` | `workflows` from `./data` | `getActiveJobs()` via `usePolling(getActiveJobs, 15_000)` | job_id → existing row key/title fields |
| `needs-attention.tsx` | `attention` from `./data` | `listReviews("pending")` via `usePolling` | `action_description` → message text; `expires_at` → urgency tone; clicking a row links to the review detail route |
| `quality-gates.tsx` | gate metrics from `./data` | `getModelPerformance()` via `usePolling(…, 60_000)` | `success_rate` → pass %; `p95_latency_ms` → latency cell |
| `system-pulse.tsx` | `pulseMetrics` from `./data` | `getMetricsSnapshot()` via `usePolling(…, 30_000)` | pick counters/timings keys matching existing pulse rows (e.g., any `*_milliseconds.p99_ms`) |
| `recent-signals.tsx` | `signals` from `./data` | `listRuns(undefined, 5)` via `usePolling` | `event_type` + `started_at` → signal rows |
| `workflows/workflow-table.tsx` + `detail-data.ts` | mock workflow arrays | `listRuns()` / `getRun(id)` / `getRunSteps(id)` | run rows keyed by `run_id`; detail tabs read steps |

For each: wrap the body in the standard tri-state (`loading` → skeleton row, `error || data === null` → inline error text with retry via `refresh`, else render existing markup against fetched fields). Preserve all existing class names/visual structure — this task swaps data sources, not design. Where a component's mock shape carries fields the API lacks (e.g., human labels), derive them from API fields or drop the row — do not invent placeholder data.

Run-detail completion summary: the terminal `workflow_result` SSE event (Task 1) carries `tokens_in`/`tokens_out` — in the workflow detail view, when the last streamed event has these fields render a completion line (e.g. "✓ Run complete · 12.4k tokens") directly from the stream; no extra fetch.

- [ ] **Step 6: Rewire the reviews queue**

In `components/reviews/reviews.tsx` (and its `data.ts` consumer): replace mock queue entries with `usePolling(() => listReviews("pending"), 20_000)`. Decision actions must call the EXISTING backend resume route — add to `api/github.ts` if not present:

```typescript
export async function decideReview(
  runId: string,
  approved: boolean,
  comment?: string,
): Promise<{ status: string; run_id: string }> {
  return request(`/github/review/${encodeURIComponent(runId)}`, {
    method: "POST",
    body: JSON.stringify({
      approved,
      reviewer_id: "", // server trusts stored identity (routes/github.py:340)
      comment: comment ?? null,
    }),
  });
}
```

Then call it from approve/reject buttons and `refresh()` the queue afterwards. Check `ReviewDecision`'s actual required fields in the backend (`src/draftly/review/models.py`) and match the payload exactly.

- [ ] **Step 7: Delete consumed mocks**

From `components/dashboard/data.ts`, remove every export whose consumer was rewired above (keep `navGroups` — sidebar still uses it). Grep confirms zero remaining importers before deleting:

```bash
grep -rn "from \"./data\"" draftly-agent-frontend/components/dashboard/*.tsx
```

- [ ] **Step 8: Verify**

```bash
cd draftly-agent-frontend && npm run lint && npm run build
```

Expected: clean build. Manual smoke: start backend (`make test` green, then `uvicorn` per Makefile `run` target) + frontend dev server; log in; confirm dashboard panels populate from real data (empty states acceptable with no runs), reviews queue lists pending doc-reviews created by a test run, approve flows hit `POST /github/review/{run_id}` and the queue refreshes.

---

### Task 16: Strands-native metrics instrumentation

**Files:**
- Modify: `src/draftly/workflows/runner.py` (module-level `_metrics`; TTFT + limit-hits in `_invoke_streaming` from Task 4; token extraction after invoke)
- Modify: `src/draftly/orchestration/hooks/audit.py` (`_flush_run`: per-node/tool registry counters)
- Modify: `src/draftly/app/api/routes/github.py` (`resume_review`: decision counters)
- Test: `tests/metrics/test_agent_metrics.py`

**Interfaces:**
- Consumes: `draftly.observability.metrics.Metrics` registry API (`increment`, `observe`); Task 4's `_invoke_streaming`; `RunAuditLogger._flush_run(repo, run_id, meta, steps)` signature unchanged; `GraphResult.execution_order[*].result.metrics.accumulated_usage` on agent nodes.
- Produces (registry names — scraped by Prometheus `/metrics` from Task 13, rendered by dashboards from Task 15):
  - `draftly_run_ttft_ms{surface}` — observed at first `text_delta`
  - `draftly_limit_hits_total{limit}` — `force_stop_reason` values and `no_result`
  - `draftly_tokens_total{model,direction}` — direction ∈ `input|output`
  - `draftly_node_steps_total{name,status}`, `draftly_tool_steps_total{name,status}`
  - `draftly_review_decisions_total{decision}` — `approved|rejected`
  - Module-level helper `extract_token_usage(graph_result, *, model) -> dict[str, int]` and module attribute `_metrics: Metrics` (default singleton) so tests inject an isolated registry.
- Division of responsibility with Task 1: `filter_graph_event` puts token totals **on the wire** (`workflow_result` payload `tokens_in`/`tokens_out`, for run-detail UI); `extract_token_usage` feeds the **Prometheus counters** (`draftly_tokens_input_total`/`draftly_tokens_output_total`). Both read the same `accumulated_usage`; neither duplicates the other's output path.


- [ ] **Step 1: Write the failing tests**

```python
# tests/metrics/test_agent_metrics.py
"""Strands-native metrics wiring (spec §Observability surface #5)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from draftly.observability.metrics import Metrics


@pytest.fixture
def registry() -> Metrics:
    return Metrics()


def _usage(inp: int, out: int) -> dict[str, int]:
    return {"inputTokens": inp, "outputTokens": out}


def _agent_node(inp: int, out: int) -> Any:
    return SimpleNamespace(
        result=SimpleNamespace(metrics=SimpleNamespace(accumulated_usage=_usage(inp, out)))
    )


def _graph_result(nodes: list[tuple[str, Any]]) -> Any:
    return SimpleNamespace(
        execution_order=[SimpleNamespace(node_id=n, result=r) for n, r in nodes]
    )


class TestExtractTokenUsage:
    def test_reads_agent_nodes(self) -> None:
        from draftly.workflows.runner import extract_token_usage

        gr = _graph_result([("writer", _agent_node(100, 20))])
        assert extract_token_usage(gr, model="claude-haiku") == {
            "input": 100,
            "output": 20,
        }

    def test_swallows_non_agent_nodes(self) -> None:
        from draftly.workflows.runner import extract_token_usage

        gr = _graph_result(
            [("classify", None), ("swarm", SimpleNamespace(results={}))]
        )
        assert extract_token_usage(gr, model="m") == {"input": 0, "output": 0}

    def test_accumulates_across_nodes(self) -> None:
        from draftly.workflows.runner import extract_token_usage

        gr = _graph_result(
            [("a", _agent_node(10, 5)), ("b", _agent_node(30, 7))]
        )
        assert extract_token_usage(gr, model="m") == {"input": 40, "output": 12}


class TestStreamingMetrics:
    async def test_ttft_and_force_stop_counters(
        self, registry: Metrics, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import draftly.workflows.runner as runner_mod

        events: list[dict[str, Any]] = [
            {"type": "multiagent_node_start", "node_id": "classify", "node_type": "agent"},
            {
                "type": "multiagent_node_stream",
                "node_id": "writer",
                "event": {"data": "hello"},
            },
            {"force_stop": True, "force_stop_reason": "max_iterations"},
        ]

        class Graph:
            async def stream_async(self, task, invocation_state=None, **kw: Any):
                for raw in events:
                    yield raw

        class Pub:
            published: list[Any] = []

            async def publish(self, envelope: Any) -> None:
                Pub.published.append(envelope)

        context = _context()
        runner = runner_mod.WorkflowRunner(
            context, graph_factory=lambda r, s: Graph(), publisher=Pub()
        )
        monkeypatch.setattr(runner_mod, "_metrics", registry)

        with pytest.raises(RuntimeError, match="without a result"):
            await runner.run(_event())

        assert registry.snapshot()["gauges"].get("noop") is None  # registry usable
        counters = registry.snapshot()["counters"]
        assert counters.get("draftly_limit_hits_total") == 1
        assert len(Pub.published) >= 1  # text_delta was seen => TTFT observed
        timings = registry.snapshot()["timings"]
        assert any("ttft" in name for name in timings)
```


Continuation of `tests/metrics/test_agent_metrics.py` — shared fakes plus audit-flush coverage:

```python
# ---- shared fakes (bottom of file) ----

def _context() -> Any:
    from draftly.workflows.context import WorkflowContext

    events = type(
        "E",
        (),
        {
            "try_claim": staticmethod(lambda *a, **k: True),
            "find_by_event_id": staticmethod(lambda event_id: None),
            "mark_status": staticmethod(lambda *a, **k: None),
        },
    )()
    return WorkflowContext(
        repositories=type("R", (), {"events": events})(),
        config=type("C", (), {"strands": None})(),
    )


def _event() -> dict[str, Any]:
    return {
        "event_id": "evt-m",
        "event_type": "pull_request.opened",
        "source": "github",
    }


class TestAuditFlushCounters:
    async def test_flush_increments_node_and_tool_counters(self, registry: Metrics, monkeypatch: pytest.MonkeyPatch) -> None:
        import draftly.orchestration.hooks.audit as audit_mod

        monkeypatch.setattr(audit_mod, "_metrics", registry)

        class Repo:
            calls: list[str] = []

            async def start_run(self, **kw: Any) -> None:
                Repo.calls.append("start")

            async def record_step(self, **kw: Any) -> None:
                Repo.calls.append("step")

            async def finish_run(self, **kw: Any) -> None:
                Repo.calls.append("finish")

        steps = [
            {"seq": 1, "kind": "node", "name": "classify", "status": "completed", "duration_ms": 12},
            {"seq": 2, "kind": "tool", "name": "search_docs", "status": "failed"},
        ]
        await audit_mod._flush_run(Repo(), "evt-x", {"source": "github"}, steps)

        counters = registry.snapshot()["counters"]
        assert counters["draftly_node_steps_total"] == 1
        assert counters["draftly_tool_steps_total"] == 1
```

And in `tests/api/test_reviews_routes.py` (extend Task 12's file):

```python
async def test_decision_counter_increments(monkeypatch: pytest.MonkeyPatch) -> None:
    from draftly.app.api.routes import github as github_mod
    from draftly.observability.metrics import Metrics

    registry = Metrics()
    monkeypatch.setattr(github_mod, "_metrics", registry)
    # ... drive POST /github/review/{run_id} through the existing smoke-test
    # fixtures with approved=True; then:
    # assert registry.snapshot()["counters"]["draftly_review_decisions_total"] == 1
```

(The final assertion is enabled when this test is wired to the real route fixtures — copy the setup from `test_routes_smoke.py`'s review tests; the counter name is the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/metrics/test_agent_metrics.py -q`
Expected: FAIL — `extract_token_usage` missing; `_metrics` attribute missing.

- [ ] **Step 3: Implement runner instrumentation**

In `src/draftly/workflows/runner.py`:

```python
import time as _time  # already imported as time

from draftly.observability.metrics import Metrics, metrics as _default_metrics

_metrics: Metrics = _default_metrics


def extract_token_usage(graph_result: Any, *, model: str) -> dict[str, int]:
    """Sum accumulated token usage across agent nodes (defensive)."""
    totals = {"input": 0, "output": 0}
    for node in getattr(graph_result, "execution_order", None) or []:
        node_result = getattr(node, "result", None)
        metrics_obj = getattr(node_result, "metrics", None)
        usage = getattr(metrics_obj, "accumulated_usage", None)
        if not isinstance(usage, dict):
            continue
        totals["input"] += int(usage.get("inputTokens") or 0)
        totals["output"] += int(usage.get("outputTokens") or 0)
    if totals["input"] or totals["output"]:
        for direction, value in totals.items():
            _metrics.increment(f"draftly_tokens_total", value)  # label via name below
    return totals
```

NOTE on labels: the registry is label-free by design (`metrics.py` has flat names), so emit per-direction names instead — replace the loop body with `_metrics.increment(f"draftly_tokens_input_total", totals["input"])` / `..._output_total`, and update the test/`Interfaces` names accordingly: `draftly_tokens_input_total{}` is implicit per model via routing telemetry joins. Simpler contract wins: **final metric names are `draftly_tokens_input_total` and `draftly_tokens_output_total`**, values accumulated per run; per-model attribution comes from the existing routing rows written in the same run.

In `_invoke_streaming`, add TTFT + limit-hit capture:

```python
        seq = 0
        result: Any = None
        started_at = time.monotonic()
        ttft_recorded = False
        async for raw in graph.stream_async(task, invocation_state=invocation_state):
            envelope = filter_graph_event(...)
            if envelope is not None:
                if not ttft_recorded and envelope.type == "text_delta":
                    ttft_recorded = True
                    _metrics.observe(
                        "draftly_run_ttft_ms",
                        time.monotonic() - started_at,
                    )
                ...
            if isinstance(raw, dict) and raw.get("force_stop"):
                _metrics.increment("draftly_limit_hits_total")
        if result is None:
            _metrics.increment("draftly_limit_hits_total")
            raise RuntimeError(...)
```

(`registry.snapshot()["timings"]` keys are suffixed `.duration_ms`-style by `observe`; the assertion `any("ttft" in name ...)` holds.)

After a successful invoke in `run()` (both paths), call:

```python
        try:
            extract_token_usage(result, model=str(getattr(self.context, "model", "unknown")))
        except Exception:
            logger.warning("token_usage_extract_failed run_id=%s", run_id, exc_info=True)
```

- [ ] **Step 4: Implement audit + review counters**

In `orchestration/hooks/audit.py`: add module-level `_metrics: Metrics = _default_metrics` (same injectable pattern); inside `_flush_run`'s step loop append:

```python
        kind_counts = {
            "node": "draftly_node_steps_total",
            "tool": "draftly_tool_steps_total",
        }
        for step in steps:
            await repo.record_step(run_id=run_id, **step)
            name = kind_counts.get(step.get("kind", ""), None)
            if name:
                _metrics.increment(name)
```

In `app/api/routes/github.py::resume_review`: add module-level `_metrics` import (same pattern) and after `outcome = await service.decide(decision)`:

```python
    _metrics.increment("draftly_review_decisions_total")
```

(Single flat counter; decision split arrives via log line `review_rejected`/`review_resumed` already present — keep it simple until the registry gains labels.)

- [ ] **Step 5: Verify**

Run: `uv run pytest tests/metrics tests/workflows tests/api -q && make lint && make typecheck`
Expected: PASS, clean. Manual: `curl localhost:8000/metrics | grep draftly_` shows the new series after one flagged-on run.


---

## Self-Review Notes

- Spec coverage: envelope ✓ (T1/T3), redis bus ✓ (T3), runner swap ✓ (T4), composition+config+docker ✓ (T2/T5), SSE+tickets ✓ (T6), 202 UX ✓ (T7), persistence+replay ✓ (T8), frontend ✓ (T9), progressive chat ✓ (T10). Evaluation/feedback graphs untouched per non-goals ✓.
- Phase 4 coverage (spec §Observability surface): runs/steps audit reads ✓ (T11), review queue reads ✓ (T12), metrics exposition + evaluations org fix ✓ (T13), routing/performance/jobs reads ✓ (T14). Review *decisions* deliberately reuse `POST /github/review/{run_id}` per spec — no duplicate resume path.
- Frontend integration: dashboard/reviews mock replacement ✓ (T15) — consumes only T11–T14 endpoints plus the T6 ticket route; uses the existing `api/client.ts` `request<T>` auth plumbing and `next.config` `/api` rewrite; no new dependencies.
- Metrics instrumentation (spec §Observability surface #5) ✓ (T16) — TTFT/limit-hits/tokens in the runner streaming path, node/tool counters from the audit flush, review-decision counter in the resume route. Registry is label-free by design, so token metrics use flat names (`draftly_tokens_input_total`) with per-model attribution via routing rows; all signals are export-only (no schema changes). T16 depends on T4's `_invoke_streaming` and feeds T13's `/metrics` + T15's panels.
- Type consistency checked: `StreamEnvelope.to_dict/to_json/from_json` used identically across T3/T4/T6/T8; `filter_graph_event(raw, *, run_id, surface)` consistent in T1/T4; `publisher.publish(envelope)` duck-type in T4/T5/T8; `bus.subscribe(run_id)` async-generator in T3/T6/T10; `review_to_dict(record)` module-level in T12; `PerformanceRepository.all()` defined T14 step 3 and consumed by its route + test.
- Known adaptation points called out inline for executors: `build_workflows` signature (T5), auth-override pattern (T6, T11 — prefer `app.dependency_overrides` if that is the smoke-test convention), smoke-test fixtures (T7), pool cursor shapes (T8), frontend proxy base path (T9), `dict(row)` vs `row.get(...)` access on DatabaseClient rows (T11). Each instructs reading the named existing file first — these are pattern-alignment steps, not missing designs.
