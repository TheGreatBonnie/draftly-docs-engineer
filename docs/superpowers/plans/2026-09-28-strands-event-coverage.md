# Strands Event Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps in `filter_graph_event` so per-model-call stop reasons, per-node tokens, throttling, and reasoning presence reach the SSE wire — and fix TTFT measurement for reasoning models.

**Architecture:** Every change routes through the existing single choke point, `filter_graph_event` (`src/draftly/events/stream_envelope.py`). Two existing envelope types gain fields (`node_stop`, `tool_progress`); four new types are added (`model_call`, `reasoning_activity`, `tool_stream_data`, `retry_throttle`). The runner records metrics off the new envelopes. The UI union gains the new types. No migration, no new dependency, no agent-construction change.

**Tech Stack:** Python 3.11, Strands Agents SDK 1.52.0, pytest, structlog, Next.js/React/TypeScript (UI), Redis Streams, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-09-28-strands-event-coverage-design.md`

## Global Constraints

- **`filter_graph_event` stays the only place that knows Strands event shapes.** No new module may read `strands.types._events` keys. Tasks 2–7 all land in that one file.
- **The filter stays pure.** `filter_graph_event(event, *, run_id, surface) -> StreamEnvelope | None` has no state and no side effects (module docstring, `stream_envelope.py:5`). Every new branch must be a pure function of one event. This is why `model_call` carries **only** `stop_reason` and does not correlate usage across events — see Task 5.
- **`reasoningText` never reaches the wire or the log.** `reasoning_activity` carries a character *count* and a boolean only. Spec §5.3. Two prior regressions (`agents/factory.py:96` `callback_handler=None`, `observability/logging.py:71-73` `show_locals=False`) were caused by leaking it.
- **Never forward raw tool content.** `tool_result` is unreachable anyway (Task 6), and `tool_stream_data` forwards a byte *count*, never the bytes.
- **Accept both redacted-key spellings.** The docs page says `redactedContent`; the SDK builds `reasoningRedactedContent` (`strands/types/_events.py:183`). Check both.
- **New envelope types are additive.** Every current consumer already ignores unknown types. Do not make a new type mandatory.
- **No new feature flags.** `settings.events_streaming_enabled` is the existing kill switch.
- **No migration.** `workflow_events` (`persistence/migrations/032_workflow_events.sql`) has no `CHECK` on `type`.
- **Work from `draftly-agent-backend/`** except Task 9, which works from `draftly-agent-ui/`.
- Python style: `from __future__ import annotations` in every module, `dict[str, Any]` builtin generics, module/function docstrings explaining *why*.

---

## File Structure

**Modified (backend):**
- `src/draftly/events/stream_envelope.py` — the filter. Tasks 2–7 all land here.
- `src/draftly/workflows/runner.py` — TTFT trigger, new metrics. Task 8.
- `src/draftly/integrations/database/workflow_events_store.py` — replay limit + truncation signal. Task 1.
- `src/draftly/app/api/routes/workflows.py` — handle the truncation signal. Task 1.
- `src/draftly/events/redis_stream_bus.py` — document the `MAX_STREAM_LEN` coupling. Task 1.

**Modified (UI):**
- `hooks/use-workflow-events.ts` — union + array. Task 9.
- `hooks/use-workflow-run.ts` — fold `model_call` into `mergedSteps`. Task 9.
- `components/sections/workflows/model-call-timeline.tsx` — **new**. Task 9.

**Modified (tests):**
- `tests/events/test_envelope.py` — Tasks 2–7.
- `tests/workflows/test_phase5_runner_events.py` — Task 8.
- `tests/events/test_replay_limits.py` — **new**. Task 1.
- `tests/events/test_graph_stream_coverage.py` — **new**. Task 10.

---

## Task 1: Fix the retention mismatch (prerequisite)

Spec §7. A pre-existing bug that this work would worsen, so it lands first and alone.

`redis_stream_bus.py:17` trims the live stream at 1000 events. `workflow_events_store.py:67` caps Postgres replay at 500. A run with 501–1000 events has its tail trimmed from Redis while `min_live_seq` is set to the max *replayed* seq, so live events 501+ are skipped forever. **Events 501+ are permanently lost.**

**Files:**
- Modify: `src/draftly/integrations/database/workflow_events_store.py:62-88`
- Modify: `src/draftly/events/redis_stream_bus.py:17`
- Modify: `src/draftly/app/api/routes/workflows.py:394-408`
- Test: `tests/events/test_replay_limits.py` (create)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `WorkflowEventsStore.REPLAY_LIMIT: int = 2000`; `WorkflowEventsStore.list_after_page(run_id, *, seq, limit=None) -> tuple[list[dict[str, Any]], bool]` where the bool is `truncated`

- [ ] **Step 1: Write the failing test**

Create `tests/events/test_replay_limits.py`:

```python
"""Replay paging must not silently truncate a resume (spec §7)."""

from __future__ import annotations

from typing import Any

import pytest

from draftly.events.redis_stream_bus import MAX_STREAM_LEN
from draftly.integrations.database.workflow_events_store import WorkflowEventsStore


class FakeClient:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.calls: list[tuple[Any, ...]] = []

    async def fetch_all(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append((query, *args))
        return self._rows


def _row(seq: int) -> dict[str, Any]:
    return {
        "run_id": "r",
        "seq": seq,
        "ts": None,
        "type": "text_delta",
        "node_id": "n",
        "payload": {},
    }


def test_replay_limit_covers_everything_the_live_stream_keeps() -> None:
    """The gap between trim and replay is permanently unreachable."""
    assert WorkflowEventsStore.REPLAY_LIMIT >= MAX_STREAM_LEN


@pytest.mark.asyncio
async def test_list_after_page_reports_truncation() -> None:
    store = WorkflowEventsStore(client=FakeClient([_row(i) for i in range(1, 7)]))  # type: ignore[arg-type]

    page, truncated = await store.list_after_page("r", seq=0, limit=5)

    assert truncated is True
    assert [row["seq"] for row in page] == [1, 2, 3, 4, 5]


@pytest.mark.asyncio
async def test_list_after_page_not_truncated_when_short() -> None:
    store = WorkflowEventsStore(client=FakeClient([_row(1)]))  # type: ignore[arg-type]

    page, truncated = await store.list_after_page("r", seq=0, limit=500)

    assert truncated is False
    assert len(page) == 1


@pytest.mark.asyncio
async def test_list_after_keeps_its_signature() -> None:
    """Existing callers pass a limit positionally by keyword; do not break them."""
    store = WorkflowEventsStore(client=FakeClient([_row(1), _row(2)]))  # type: ignore[arg-type]

    page = await store.list_after("r", seq=0, limit=1)
    assert [row["seq"] for row in page] == [1]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_replay_limits.py -v
```

Expected: FAIL — `AttributeError: type object 'WorkflowEventsStore' has no attribute 'REPLAY_LIMIT'`

- [ ] **Step 3: Read the existing `list_after` before editing**

```bash
cd draftly-agent-backend
sed -n '55,95p' src/draftly/integrations/database/workflow_events_store.py
```

Note its exact current signature and which client method it calls (`fetch_all` vs something else) and match it in Step 4. The `FakeClient` above assumes `fetch_all(query, *args)`.

- [ ] **Step 4: Implement `list_after_page`**

Add the class constant and the paging method, preserving the existing SQL projection and row-shaping:

```python
class WorkflowEventsStore:
    #: Replay must cover at least everything the live Redis stream still
    #: holds. ``MAX_STREAM_LEN`` in ``events/redis_stream_bus.py`` trims the
    #: live stream; if replay covers less, the gap between the two is
    #: permanently unreachable on resume (spec §7).
    REPLAY_LIMIT: int = 2000
```

```python
    async def list_after_page(
        self,
        run_id: str,
        *,
        seq: int,
        limit: int | None = None,
    ) -> tuple[list[dict[str, Any]], bool]:
        """One page of events after ``seq``, plus a ``truncated`` flag.

        Fetches ``limit + 1`` rows so a full page is distinguishable from a
        short one without a second COUNT query. A caller must not treat a
        truncated page as a complete replay.
        """
        page_size = self.REPLAY_LIMIT if limit is None else limit
        rows = await self.client.fetch_all(
            """
            SELECT run_id, seq, ts, type, node_id, payload
            FROM workflow_events
            WHERE run_id = $1 AND seq > $2
            ORDER BY seq ASC
            LIMIT $3
            """,
            run_id,
            seq,
            page_size + 1,
        )
        truncated = len(rows) > page_size
        return [self._shape(row) for row in rows[:page_size]], truncated
```

`list_after` becomes a thin wrapper that keeps its existing signature so current callers are untouched:

```python
    async def list_after(
        self,
        run_id: str,
        *,
        seq: int,
        limit: int = REPLAY_LIMIT,
    ) -> list[dict[str, Any]]:
        """First page after ``seq``, ignoring truncation.

        Prefer ``list_after_page`` where a resume must not silently lose events.
        """
        page, _ = await self.list_after_page(run_id, seq=seq, limit=limit)
        return page
```

If the current `list_after` inlines its row shaping rather than calling a helper, factor that into a `_shape(row) -> dict[str, Any]` static method and call it from both. Reuse the existing payload-decoding logic verbatim — do not rewrite it.

- [ ] **Step 5: Handle truncation in the SSE route**

In `workflows.py`, replace the replay-load block (lines 394–408). Read it first; the edit keeps the existing `min_live_seq` assignment and `sse_replay_loaded` log, and adds the truncation warning:

```python
            replayed, truncated = await events_repo.list_after_page(
                run_id, seq=min_live_seq
            )
            if truncated:
                logger.warning(
                    "sse_replay_truncated",
                    run_id=run_id,
                    min_live_seq=min_live_seq,
                    loaded=len(replayed),
                )
```

- [ ] **Step 6: Document the coupling in the bus**

```python
STREAM_PREFIX = "draftly:stream"

#: Per-run live-stream cap. ``WorkflowEventsStore.REPLAY_LIMIT`` must stay
#: >= this value or the gap between the two is permanently unreachable on
#: resume (spec §7). Asserted by
#: ``tests/events/test_replay_limits.py::test_replay_limit_covers_everything_the_live_stream_keeps``.
MAX_STREAM_LEN = 1000  # ~1000 events per run
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_replay_limits.py -v
```

Expected: 4 passed

- [ ] **Step 8: Run the broader suites for regressions**

```bash
cd draftly-agent-backend
pytest tests/events/ tests/api/ tests/persistence/ -q
```

Expected: all pass. `list_after` kept a compatible signature, so existing callers are unaffected.

- [ ] **Step 9: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/integrations/database/workflow_events_store.py \
        src/draftly/events/redis_stream_bus.py \
        src/draftly/app/api/routes/workflows.py \
        tests/events/test_replay_limits.py
git commit -m "fix(events): align replay limit with stream trim and report truncation"
```

---

## Task 2: Read both nesting depths

Spec §3(a). Typed events arrive flat (`nested["data"]`); raw provider chunks arrive wrapped (`nested["event"]["messageStop"]`) because `ModelStreamChunkEvent` (`strands/types/_events.py:113`) carries a single chunk under `"event"`. The new branches need both, so the accessor is extracted and tested in isolation.

**Files:**
- Modify: `src/draftly/events/stream_envelope.py:244-266`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: nothing
- Produces: `_raw_chunk(nested: dict[str, Any]) -> dict[str, Any]` (module-private). Tasks 5 and 7 call it.

- [ ] **Step 1: Write the failing test**

Add to `class TestFilterMapping` in `tests/events/test_envelope.py`:

```python
    def test_raw_chunk_accessor_reads_the_wrapped_provider_chunk(self) -> None:
        # ModelStreamChunkEvent (_events.py:113) nests the whole payload
        # under "event", so text arrives as nested["event"]["data"].
        from draftly.events.stream_envelope import _raw_chunk

        assert _raw_chunk({"event": {"messageStop": {"stopReason": "max_tokens"}}}) == {
            "messageStop": {"stopReason": "max_tokens"}
        }

    def test_raw_chunk_accessor_returns_empty_for_flat_events(self) -> None:
        from draftly.events.stream_envelope import _raw_chunk

        assert _raw_chunk({"data": "hello"}) == {}
        assert _raw_chunk({}) == {}
        assert _raw_chunk({"event": "not-a-dict"}) == {}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v -k "raw_chunk"
```

Expected: FAIL — `ImportError: cannot import name '_raw_chunk'`

- [ ] **Step 3: Implement the accessor**

In `stream_envelope.py`, directly above `filter_graph_event`:

```python
def _raw_chunk(nested: dict[str, Any]) -> dict[str, Any]:
    """The provider chunk behind a ``ModelStreamChunkEvent``, or ``{}``.

    Two nesting depths reach the filter, both verified on a real graph
    (spec §3). Typed events arrive flat -- ``{"data": "hi"}``. Raw provider
    chunks arrive wrapped one level deeper, because
    ``ModelStreamChunkEvent`` (``strands/types/_events.py:113``) builds
    ``{"event": chunk}``. ``messageStop`` and ``metadata`` -- the only
    reachable source of per-model-call telemetry -- are on the wrapped side.
    """
    return _as_dict(nested.get("event"))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v
```

Expected: all pass. The single-nested `text_delta` and `tool_progress` paths are untouched in this task.

- [ ] **Step 5: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/events/stream_envelope.py tests/events/test_envelope.py
git commit -m "refactor(events): read both stream nesting depths"
```

---

## Task 3: Per-node tokens on `node_stop` (plus a dead code path)

Spec §5.1. `NodeResult` has **no** `.metrics` — verified `hasattr(nr, "metrics")` is `False`. Its usage hangs directly off `accumulated_usage`. The existing `_token_usage` (`:211`) chains through `.metrics`, so it silently returns `None` for a `NodeResult`. Per-node tokens are extracted in three places in this codebase and reach the wire zero times.

**Files:**
- Modify: `src/draftly/events/stream_envelope.py:209-217, 268-287`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: nothing
- Produces: `_usage_counts(usage: Any) -> dict[str, int] | None`; `_node_result_usage(node_result: Any) -> dict[str, int] | None`. `node_stop` payload gains `tokens_in`, `tokens_out`, `cycle_count`, `n_interrupts`.

- [ ] **Step 1: Write the failing tests**

Add to `TestFilterMapping`:

```python
    def test_node_stop_reads_usage_off_the_real_node_result_shape(self) -> None:
        # NodeResult (strands/multiagent/base.py) has no ``.metrics``; its
        # usage is a direct attribute. The existing _token_usage chain
        # returns None here, so tokens never reached the wire.
        node_result = SimpleNamespace(
            status=Status.COMPLETED,
            execution_time=1250,
            accumulated_usage={"inputTokens": 8100, "outputTokens": 16384},
            execution_count=3,
            interrupts=[SimpleNamespace(id="i1", reason="needs_review")],
        )
        env = filter_graph_event(
            {"type": "multiagent_node_stop", "node_id": "impact", "node_result": node_result},
            **KW,
        )
        assert env is not None
        assert env.payload["tokens_in"] == 8100
        assert env.payload["tokens_out"] == 16384
        assert env.payload["cycle_count"] == 3
        assert env.payload["n_interrupts"] == 1

    def test_node_stop_omits_absent_fields(self) -> None:
        env = filter_graph_event(node_stop(), **KW)
        assert env is not None
        assert "tokens_in" not in env.payload
        assert "cycle_count" not in env.payload

    def test_token_usage_still_works_for_agent_result_shape(self) -> None:
        # workflow_result must keep working: AgentResult DOES own a
        # ``.metrics`` EventLoopMetrics. Do not "fix" the shared helper.
        env = filter_graph_event({"result": _agent_result()}, **KW)
        assert env is not None
        assert env.type == "workflow_result"
        assert env.payload["tokens_in"] == 8100
```

`Status` is already imported in the test file (`from strands.multiagent.base import Status`). Add a module-level helper next to the existing fixtures:

```python
def _agent_result() -> Any:
    """Minimal AgentResult-like object: it owns ``.metrics``, unlike NodeResult."""
    return SimpleNamespace(
        status=Status.COMPLETED,
        interrupts=[],
        metrics=SimpleNamespace(
            accumulated_usage={"inputTokens": 8100, "outputTokens": 16384}
        ),
    )
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v -k "node_stop or token_usage"
```

Expected: the first two FAIL with `KeyError: 'tokens_in'` / `KeyError: 'cycle_count'`. The third passes (guards against regressing `workflow_result`).

- [ ] **Step 3: Implement the accessors**

Add next to `_token_usage` (`stream_envelope.py:209-217`):

```python
def _usage_counts(usage: Any) -> dict[str, int] | None:
    """``{"tokens_in", "tokens_out"}`` from a Strands ``Usage``; None if absent."""
    if not isinstance(usage, Mapping):
        return None
    return {
        "tokens_in": int(usage.get("inputTokens") or 0),
        "tokens_out": int(usage.get("outputTokens") or 0),
    }


def _node_result_usage(node_result: Any) -> dict[str, int] | None:
    """Per-node tokens.

    ``NodeResult`` (strands/multiagent/base.py:52) has no ``.metrics`` -- unlike
    ``AgentResult``, whose usage hangs off an ``EventLoopMetrics``. Its usage is
    a direct ``accumulated_usage`` attribute, so the ``_token_usage`` chain
    resolves to ``getattr(None, ...)`` and silently yields None (spec §5.1).
    Keep this separate rather than "fixing" ``_token_usage``, which is correct
    for ``AgentResult`` and is what makes ``workflow_result`` tokens work.
    """
    return _usage_counts(getattr(node_result, "accumulated_usage", None))
```

`Mapping` is already imported (`stream_envelope.py:14`).

- [ ] **Step 4: Enrich the `node_stop` branch**

Replace `stream_envelope.py:268-287`:

```python
    if kind == "multiagent_node_stop":
        raw_result = event.get("node_result")
        node_result = _as_dict(raw_result)
        if node_result:
            # Dict-shaped node_result: only produced by test fixtures. Real
            # runs always carry a NodeResult object (graph.py constructs one
            # explicitly), which has ``execution_time`` in milliseconds and no
            # ``duration`` key -- see the docstring on the branch below.
            status = str(node_result.get("status", "UNKNOWN"))
            duration = node_result.get("duration")
            duration_ms = int(float(duration) * 1000) if duration is not None else None
            usage = _usage_counts(node_result.get("accumulated_usage"))
            cycle_count = node_result.get("execution_count")
            interrupts = node_result.get("interrupts")
        else:
            status = _status_name(raw_result)
            duration_ms = getattr(raw_result, "execution_time", None)
            usage = _node_result_usage(raw_result)
            cycle_count = getattr(raw_result, "execution_count", None)
            interrupts = getattr(raw_result, "interrupts", None)
        payload: dict[str, Any] = {
            "status": status,
            # Units are milliseconds on both paths and are deliberately left
            # unchanged: the UI already renders them (spec §5.2).
            "duration_ms": duration_ms,
        }
        if usage is not None:
            payload.update(usage)
        if cycle_count is not None:
            payload["cycle_count"] = int(cycle_count)
        if interrupts:
            payload["n_interrupts"] = len(interrupts)
        return StreamEnvelope(
            type="node_stop",
            run_id=run_id,
            surface=surface,
            node_id=node_str,
            payload=payload,
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v
```

Expected: all pass. `test_node_stop_extracts_status_and_duration` and `test_node_stop_accepts_real_node_result_shape` assert exact payload equality and still pass, because the new keys are *absent* when their fixtures carry no usage or cycle count. Verify rather than assume — if one fails, its fixture gained a metrics object; fix the assertion, not the implementation.

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/events/stream_envelope.py tests/events/test_envelope.py
git commit -m "fix(events): read per-node tokens from the real NodeResult shape"
```

---

## Task 4: `tool_progress` gains a redacted input summary and a phase

Spec §5.2. `input` accumulates as arguments stream and carries repo paths, queries, and pasted issue text — forwarding it raw is a disclosure incident. Emit the *shape*, never the values.

**Files:**
- Modify: `src/draftly/events/stream_envelope.py:254-265`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: `redact_value(value, *, max_bytes)` (`steering/redaction.py:131`), already imported at `stream_envelope.py:17`
- Produces: `tool_progress` payload gains `phase: "start"`, `input_summary: dict[str, Any]`. The gate relaxes from `tool.get("name")` to `tool.get("name") or tool_use_id`.

- [ ] **Step 1: Write the failing tests**

Add to `TestFilterMapping`:

```python
    def test_tool_progress_summarizes_input_without_disclosing_values(self) -> None:
        raw = node_stream({
            "current_tool_use": {
                "name": "github_read_file",
                "toolUseId": "t1",
                "input": {"path": "infra/prod.env", "issue_body": "x" * 400},
            }
        })
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "tool_progress"
        assert env.payload["phase"] == "start"
        # Allowlisted identifiers keep a bounded value; everything else is a
        # byte count. Neither the path nor the issue text survives whole.
        assert env.payload["input_summary"]["path"] == "infra/prod.env"
        assert env.payload["input_summary"]["issue_body"] == 400

    def test_tool_progress_emits_before_the_name_is_known(self) -> None:
        # While arguments stream, the model has not sent a name yet. Gating on
        # name alone hid the first events of every call.
        raw = node_stream({"current_tool_use": {"toolUseId": "t2", "input": {}}})
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.payload["name"] == ""
        assert env.payload["tool_use_id"] == "t2"

    def test_tool_progress_summary_is_bounded(self) -> None:
        raw = node_stream({
            "current_tool_use": {
                "name": "hybrid_search",
                "toolUseId": "t3",
                "input": {"query": "y" * 50_000},
            }
        })
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.payload["input_summary"]["query"] <= 4096

    def test_unidentifiable_tool_use_is_still_dropped(self) -> None:
        assert filter_graph_event(node_stream({"current_tool_use": {"input": {}}}), **KW) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v -k "tool_progress"
```

Expected: the three new tests FAIL. `test_nested_tool_progress_maps_only_with_name` also FAILS — it asserts the unnamed case is dropped, which this task deliberately reverses. Step 5 updates it.

- [ ] **Step 3: Implement the summary helper**

Add above `filter_graph_event`:

```python
#: Argument names whose values are safe to show. Everything else is reduced to
#: a byte count. Tool arguments routinely carry file bodies, repo paths, and
#: pasted issue text, so nothing is forwarded by default.
_SAFE_ARG_NAMES: frozenset[str] = frozenset({"owner", "repo", "ref", "path"})

_TOOL_INPUT_MAX_BYTES = 4096
_SAFE_ARG_MAX_CHARS = 200


def _summarize_tool_input(raw: Any) -> dict[str, Any]:
    """Describe a tool's arguments without disclosing their values.

    Each argument maps either to its byte length (the default) or, for the
    allowlist in ``_SAFE_ARG_NAMES``, to a bounded truncated string. Non-string
    values report ``0`` -- their shape alone is not worth the bytes. The result
    is passed through ``redact_value`` so a secret-shaped argument name is
    masked even on the length path.
    """
    if not isinstance(raw, Mapping):
        return {}
    summary: dict[str, Any] = {}
    for key, value in raw.items():
        name = str(key)
        if not isinstance(value, str):
            summary[name] = 0
        elif name in _SAFE_ARG_NAMES:
            summary[name] = value[:_SAFE_ARG_MAX_CHARS]
        else:
            summary[name] = min(len(value.encode("utf-8")), _TOOL_INPUT_MAX_BYTES)
    return redact_value(summary, max_bytes=_TOOL_INPUT_MAX_BYTES)
```

- [ ] **Step 4: Wire it into the tool branch**

Replace `stream_envelope.py:254-265`:

```python
        tool = _as_dict(nested.get("current_tool_use"))
        tool_use_id = str(tool.get("toolUseId", "") or "")
        if tool.get("name") or tool_use_id:
            return StreamEnvelope(
                type="tool_progress",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={
                    "name": str(tool.get("name", "") or ""),
                    "tool_use_id": tool_use_id,
                    "phase": "start",
                    "input_summary": _summarize_tool_input(tool.get("input")),
                },
            )
        return None
```

- [ ] **Step 5: Update the superseded test**

`test_nested_tool_progress_maps_only_with_name` asserted an unnamed `current_tool_use` is dropped. Replace it:

```python
    def test_nested_tool_progress_maps_with_or_without_name(self) -> None:
        named = node_stream({"current_tool_use": {"name": "search_docs", "toolUseId": "t1"}})
        env = filter_graph_event(named, **KW)
        assert env is not None
        assert env.type == "tool_progress"
        assert env.payload["name"] == "search_docs"

        # A call whose arguments are still streaming has a toolUseId but no
        # name yet; dropping it hid the start of the call.
        unnamed = node_stream({"current_tool_use": {"toolUseId": "t2"}})
        assert filter_graph_event(unnamed, **KW) is not None
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py tests/workflows/ -q
```

Expected: all pass. `use-workflow-run.ts:38` reads `payload.name` for the step label; an empty name already falls back to `node_id` at that call site, so no UI change is needed here.

- [ ] **Step 7: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/events/stream_envelope.py tests/events/test_envelope.py
git commit -m "feat(events): summarize tool input shape on tool_progress"
```

---

## Task 5: `model_call` from the raw provider chunk

Spec §3(b) and §5.3. **This is the highest-value item in the plan.** It is what would have made run `9ab7a0a0`'s 16,384 `outputTokens` and `stop_reason: max_tokens` visible at the `impact` node at the moment it was hit, rather than reconstructed afterwards from a raised `MaxTokensReachedException`.

It is also the item the earlier design got wrong. `ModelStopReason` — the rich event carrying `usage` and `metrics` — sets `is_callback_event = False` (`strands/types/_events.py:216`) and never reaches the filter. The only reachable per-call signal is `messageStop.stopReason` inside a double-nested raw chunk. `OpenAIModel.format_chunk` (`strands/models/openai.py:543-586`) normalises every provider's finish reason into that same shape, so one branch covers all seven providers.

**Why the payload is `stop_reason` only:** `stopReason` and `usage` arrive as *separate* chunks. Correlating them would require state, and the filter is pure by contract (module docstring, `stream_envelope.py:5`). Per-node token totals are already covered by `node_stop` (Task 3), so the gap is not worth breaking purity for.

**Files:**
- Modify: `src/draftly/events/stream_envelope.py:244-266`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: `_raw_chunk` (Task 2)
- Produces: envelope type `model_call` with payload `{"stop_reason": str}`

- [ ] **Step 1: Write the failing tests**

Add a new class to `tests/events/test_envelope.py`:

```python
class TestModelCall:
    def test_message_stop_chunk_becomes_model_call(self) -> None:
        raw = node_stream({"event": {"messageStop": {"stopReason": "max_tokens"}}})
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "model_call"
        assert env.node_id == "writer"
        assert env.payload == {"stop_reason": "max_tokens"}

    @pytest.mark.parametrize("reason", ["end_turn", "tool_use", "max_tokens", "content_filtered"])
    def test_every_stop_reason_survives(self, reason: str) -> None:
        raw = node_stream({"event": {"messageStop": {"stopReason": reason}}})
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.payload["stop_reason"] == reason

    def test_other_raw_chunks_are_not_model_calls(self) -> None:
        # The wrapped side carries the whole provider chunk stream; only
        # messageStop is a per-call signal.
        for chunk in (
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {}}},
            {"contentBlockDelta": {"delta": {"text": "hi"}}},
            {"contentBlockStop": {}},
            {"metadata": {"usage": {"inputTokens": 5, "outputTokens": 7}}},
        ):
            assert filter_graph_event(node_stream({"event": chunk}), **KW) is None, chunk

    def test_message_stop_without_reason_is_dropped(self) -> None:
        assert filter_graph_event(node_stream({"event": {"messageStop": {}}}), **KW) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v -k "ModelCall or model_call or stop_reason"
```

Expected: FAIL — the parametrized and primary cases return `None`. The two negative tests may already pass; they are guards.

- [ ] **Step 3: Implement the branch**

Insert at the **top** of the `multiagent_node_stream` branch, immediately after `nested = _as_dict(event.get("event"))`. It must precede the `data` check so a chunk carrying both is not misread as text:

```python
    if kind == "multiagent_node_stream":
        nested = _as_dict(event.get("event"))

        # Per-model-call stop reason, read from the raw provider chunk.
        # ModelStopReason would be richer -- it carries usage and latency -- but
        # sets is_callback_event = False (_events.py:216) and never reaches the
        # filter. messageStop inside a ModelStreamChunkEvent is the only
        # reachable per-call signal, and format_chunk normalises every provider
        # into it (spec §3b).
        stop_reason = _as_dict(_raw_chunk(nested).get("messageStop")).get("stopReason")
        if stop_reason:
            return StreamEnvelope(
                type="model_call",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={"stop_reason": str(stop_reason)},
            )

        if isinstance(nested.get("data"), str):
            ...
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/events/stream_envelope.py tests/events/test_envelope.py
git commit -m "feat(events): surface per-model-call stop reason as model_call"
```

---

## Task 6: `reasoning_activity` — presence, never content

Spec §4 and §5.3. `reasoningText` and `reasoning_signature` both arrive as flat typed events with `reasoning: True`, and both are currently dropped. This task surfaces *that* reasoning happened, and nothing more.

The signature is the more important of the two to keep off the wire: it is round-trip conversation state that must be sent back to the provider or the conversation is rejected. It is closer to a message ID than to a log line.

**Files:**
- Modify: `src/draftly/events/stream_envelope.py:244-266`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: nothing
- Produces: envelope type `reasoning_activity` with payload `{"chars": int, "redacted": bool}`

- [ ] **Step 1: Write the failing tests**

Add to `tests/events/test_envelope.py`:

```python
class TestReasoningActivity:
    def test_reasoning_text_reports_presence_without_content(self) -> None:
        raw = node_stream({
            "reasoningText": "Let me analyze the PR diff",
            "delta": {"reasoningContent": {"text": "Let me analyze the PR diff"}},
            "reasoning": True,
        })
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "reasoning_activity"
        assert env.payload["chars"] == 24
        assert env.payload["redacted"] is False
        assert "Let me analyze" not in str(env.payload)

    def test_reasoning_signature_is_never_streamed(self) -> None:
        # reasoning_signature is round-trip conversation state: it must go back
        # to the provider on later turns. Never telemetry, never on the wire.
        raw = node_stream({
            "reasoning_signature": "SIG-abc123",
            "delta": {"reasoningContent": {"signature": "SIG-abc123"}},
            "reasoning": True,
        })
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "reasoning_activity"
        assert "SIG-abc123" not in str(env.payload)
        assert "abc123" not in str(env.payload)

    @pytest.mark.parametrize("key", ["reasoningRedactedContent", "redactedContent"])
    def test_redaction_accepts_both_key_spellings(self, key: str) -> None:
        # The docs page says ``redactedContent``; the SDK builds
        # ``reasoningRedactedContent`` (_events.py:183). Accept both.
        raw = node_stream({key: b"xyz", "delta": {}, "reasoning": True})
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "reasoning_activity"
        assert env.payload["redacted"] is True

    def test_reasoning_tag_alone_is_still_activity(self) -> None:
        # ``reasoning`` is a type tag, not content. It must not be mistaken for
        # a payload value.
        raw = node_stream({"reasoning": True, "delta": {}})
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.payload == {"chars": 0, "redacted": False}
        assert "True" not in str(env.payload)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v -k "Reasoning or reasoning"
```

Expected: all FAIL with `assert env is not None`.

- [ ] **Step 3: Implement the branch**

Insert after the `model_call` branch in `multiagent_node_stream`:

```python
        if nested.get("reasoning"):
            # Presence only, never content. Reasoning text has already reached
            # a log sink twice -- via PrintingCallbackHandler (factory.py:96)
            # and via invocation_state locals (logging.py:71) -- and must not
            # reach a third. A redacted block still tells the user the model is
            # thinking, which is what stops a long run from looking hung.
            redacted = bool(
                nested.get("reasoningRedactedContent") or nested.get("redactedContent")
            )
            text = nested.get("reasoningText")
            return StreamEnvelope(
                type="reasoning_activity",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={
                    "chars": len(text) if isinstance(text, str) else 0,
                    "redacted": redacted,
                },
            )
```

- [ ] **Step 4: Remove the superseded drop test case**

`TestDroppedAndTerminal::test_noise_is_dropped` is parametrized and currently includes `{"reasoning": True, "reasoningText": "thinking"}`, which now maps. Remove that one case; the others stay dropped per spec §5.4. Read the existing parametrization first and edit only that entry.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/events/stream_envelope.py tests/events/test_envelope.py
git commit -m "feat(events): report reasoning presence without streaming content"
```

---

## Task 7: `tool_stream_data` and `retry_throttle`

Spec §5.3. Two low-volume, low-risk branches. `ToolStreamEvent` and `EventLoopThrottleEvent` both inherit the default `is_callback_event = True`, so unlike `ToolResultEvent` they do reach the filter — though `tool_stream_event` only fires for tools that opt in (e.g. `RepoReadCachePlugin.stream`, `steering/repo_read_cache_plugin.py:64`).

**Files:**
- Modify: `src/draftly/events/stream_envelope.py:244-266`
- Test: `tests/events/test_envelope.py`

**Interfaces:**
- Consumes: nothing
- Produces: envelope types `tool_stream_data` `{"tool_use_id", "name", "bytes"}` and `retry_throttle` `{"delay_seconds": float}`

- [ ] **Step 1: Write the failing tests**

Add to `tests/events/test_envelope.py`:

```python
class TestToolStreamAndThrottle:
    def test_tool_stream_event_becomes_tool_stream_data(self) -> None:
        # The SDK builds {"type": "tool_stream", "tool_stream_event":
        # {tool_use, data}} (_events.py:324) -- ``data`` is a dict here, so a
        # isinstance(nested.get("data"), str) check cannot see it.
        raw = node_stream({
            "type": "tool_stream",
            "tool_stream_event": {
                "tool_use": {"toolUseId": "t9", "name": "github_read_file"},
                "data": "chunk of body",
            },
        })
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert env.type == "tool_stream_data"
        assert env.payload["tool_use_id"] == "t9"
        assert env.payload["name"] == "github_read_file"
        assert env.payload["bytes"] == 13

    def test_tool_stream_event_without_a_tool_use_is_dropped(self) -> None:
        raw = node_stream({"type": "tool_stream", "tool_stream_event": {"data": "x"}})
        assert filter_graph_event(raw, **KW) is None

    def test_throttled_delay_becomes_retry_throttle(self) -> None:
        env = filter_graph_event(node_stream({"event_loop_throttled_delay": 4}), **KW)
        assert env is not None
        assert env.type == "retry_throttle"
        assert env.payload["delay_seconds"] == 4.0

    def test_tool_stream_never_forwards_content(self) -> None:
        raw = node_stream({
            "type": "tool_stream",
            "tool_stream_event": {
                "tool_use": {"toolUseId": "t1", "name": "x"},
                "data": {"secret": "SECRET-VALUE"},
            },
        })
        env = filter_graph_event(raw, **KW)
        assert env is not None
        assert "SECRET-VALUE" not in str(env.payload)
        assert "data" not in env.payload
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v -k "tool_stream or throttled or ToolStream"
```

Expected: 3 FAIL with `assert env is not None`.

- [ ] **Step 3: Implement the byte-count helper**

Add above `filter_graph_event`:

```python
def _content_bytes(content: Any) -> int:
    """Byte length of a streamed tool payload, without its content.

    Tool results and streams carry file bodies, diffs, and API responses. The
    UI needs to know a payload was substantial; it does not need the bytes.
    """
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content.encode("utf-8"))
    if isinstance(content, (bytes, bytearray)):
        return len(content)
    try:
        return len(json.dumps(content, default=str).encode("utf-8"))
    except (TypeError, ValueError):
        return 0
```

`json` is already imported (`stream_envelope.py:12`).

- [ ] **Step 4: Implement both branches**

Insert after the `reasoning_activity` branch in `multiagent_node_stream`:

```python
        if nested.get("type") == "tool_stream":
            streamed = _as_dict(nested.get("tool_stream_event"))
            tool_use = _as_dict(streamed.get("tool_use"))
            tool_use_id = str(tool_use.get("toolUseId", "") or "")
            if not tool_use_id:
                return None
            return StreamEnvelope(
                type="tool_stream_data",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={
                    "tool_use_id": tool_use_id,
                    "name": str(tool_use.get("name", "") or ""),
                    "bytes": _content_bytes(streamed.get("data")),
                },
            )

        if "event_loop_throttled_delay" in nested:
            # Backpressure the user would otherwise read as a hang.
            return StreamEnvelope(
                type="retry_throttle",
                run_id=run_id,
                surface=surface,
                node_id=node_str,
                payload={"delay_seconds": round(float(nested["event_loop_throttled_delay"] or 0), 3)},
            )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/events/test_envelope.py -v
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/events/stream_envelope.py tests/events/test_envelope.py
git commit -m "feat(events): surface tool stream data and throttle delays"
```

---

## Task 8: TTFT and metrics in the runner

Spec §5.3 and §8. `runner.py:1544` records `draftly_run_ttft_ms` on the first `text_delta`. A thinking model emits reasoning first — verified: `{"reasoningText": …, "reasoning": True}` precedes the first `{"data": …}` — so the metric systematically excludes exactly the latency reasoning adds.

**Files:**
- Modify: `src/draftly/workflows/runner.py:1543-1549`
- Test: `tests/workflows/test_phase5_runner_events.py`

**Interfaces:**
- Consumes: envelope types `text_delta`, `reasoning_activity`, `model_call`, `tool_progress`, `retry_throttle` (Tasks 3–7)
- Produces: metric `draftly_run_ttft_ms` (semantics changed), `draftly_model_calls_total{stop_reason}`, `draftly_tool_starts_total`, `draftly_reasoning_chars_total`, `draftly_throttle_delays_total`

- [ ] **Step 1: Write the failing tests**

Add to `tests/workflows/test_phase5_runner_events.py`. Reuse the module's existing `RecordingPublisher`, `StreamingFakeGraph`, `make_context`, `completed_result`, and `PR_EVENT` — read the file first and do not redefine them:

```python
REASONING_FIRST_EVENTS = [
    {"type": "multiagent_node_start", "node_id": "writer", "node_type": "agent"},
    {
        "type": "multiagent_node_stream",
        "node_id": "writer",
        "event": {"reasoningText": "thinking hard", "delta": {}, "reasoning": True},
    },
    {"type": "multiagent_node_stream", "node_id": "writer", "event": {"data": "answer"}},
    {
        "type": "multiagent_node_stop",
        "node_id": "writer",
        "node_result": {"status": "COMPLETED", "duration": 0.1},
    },
    {"result": completed_result()},
]


class TestRunnerTtftAndMetrics:
    @staticmethod
    def _ttft_count() -> int:
        from draftly.observability.metrics import metrics as registry

        return registry.snapshot()["timings"].get("draftly_run_ttft_ms", {}).get("count", 0)

    async def test_ttft_counts_reasoning_as_first_token(self) -> None:
        before = self._ttft_count()
        publisher = RecordingPublisher()
        graph = StreamingFakeGraph(completed_result(), REASONING_FIRST_EVENTS)
        runner = WorkflowRunner(
            make_context(), graph_factory=lambda r, s: graph, publisher=publisher
        )

        await runner.run(dict(PR_EVENT))

        assert self._ttft_count() == before + 1
        assert "reasoning_activity" in [e.type for e in publisher.published]

    async def test_ttft_still_fires_on_text_delta_without_reasoning(self) -> None:
        before = self._ttft_count()
        publisher = RecordingPublisher()
        graph = StreamingFakeGraph(completed_result(), STREAM_EVENTS)
        runner = WorkflowRunner(
            make_context(), graph_factory=lambda r, s: graph, publisher=publisher
        )

        await runner.run(dict(PR_EVENT))

        assert self._ttft_count() == before + 1

    async def test_stream_metrics_are_counted(self) -> None:
        from draftly.observability.metrics import metrics as registry

        events = [
            {"type": "multiagent_node_start", "node_id": "writer", "node_type": "agent"},
            {
                "type": "multiagent_node_stream",
                "node_id": "writer",
                "event": {"event": {"messageStop": {"stopReason": "max_tokens"}}},
            },
            {
                "type": "multiagent_node_stream",
                "node_id": "writer",
                "event": {"event_loop_throttled_delay": 3},
            },
            {
                "type": "multiagent_node_stop",
                "node_id": "writer",
                "node_result": {"status": "COMPLETED", "duration": 0.1},
            },
            {"result": completed_result()},
        ]
        before = dict(registry.snapshot()["counters"])
        publisher = RecordingPublisher()
        graph = StreamingFakeGraph(completed_result(), events)
        runner = WorkflowRunner(
            make_context(), graph_factory=lambda r, s: graph, publisher=publisher
        )

        await runner.run(dict(PR_EVENT))

        after = registry.snapshot()["counters"]
        assert after["draftly_model_calls_total{stop_reason=max_tokens}"] == (
            before.get("draftly_model_calls_total{stop_reason=max_tokens}", 0) + 1
        )
        assert after["draftly_throttle_delays_total"] == (
            before.get("draftly_throttle_delays_total", 0) + 1
        )
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd draftly-agent-backend
pytest tests/workflows/test_phase5_runner_events.py -v -k "Ttft or stream_metrics"
```

Expected: `test_ttft_counts_reasoning_as_first_token` FAILS (`reasoning_activity` not published, TTFT not recorded); `test_stream_metrics_are_counted` FAILS with `KeyError: 'draftly_model_calls_total{stop_reason=max_tokens}'`.

- [ ] **Step 3: Fix the TTFT trigger**

Replace `runner.py:1543-1546`:

```python
                if envelope is not None:
                    # Reasoning counts as first token: a thinking model emits
                    # reasoning deltas before any text, so gating on text_delta
                    # alone understated TTFT by exactly the reasoning latency.
                    if not ttft_recorded and envelope.type in _FIRST_TOKEN_TYPES:
                        ttft_recorded = True
                        _metrics.observe("draftly_run_ttft_ms", time.monotonic() - started_at)
                    self._record_envelope_metrics(envelope)
                    seq = seq_allocator.next() if seq_allocator is not None else seq + 1
```

- [ ] **Step 4: Add the constant**

Add near the top of `runner.py`, after the imports and before `_metrics` (`runner.py:79`):

```python
#: Envelope types that mark the model has started producing. ``reasoning_activity``
#: is included because a thinking model reasons before it writes.
_FIRST_TOKEN_TYPES: frozenset[str] = frozenset({"text_delta", "reasoning_activity"})
```

- [ ] **Step 5: Add the metric recorder**

Add as a method on `WorkflowRunner`, immediately above `_invoke_streaming`:

```python
    def _record_envelope_metrics(self, envelope: StreamEnvelope) -> None:
        """Counters derived from stream envelopes.

        ``Metrics`` is a flat, label-free registry
        (``observability/metrics.py:30``), so the label rides in the metric
        name. ``stop_reason`` is a closed ``Literal`` set
        (``strands/types/event_loop.py:39``), so the name space stays bounded.
        """
        payload = envelope.payload
        kind = envelope.type
        if kind == "model_call":
            reason = str(payload.get("stop_reason") or "unknown")
            _metrics.increment(f"draftly_model_calls_total{{stop_reason={reason}}}")
        elif kind == "tool_progress":
            _metrics.increment("draftly_tool_starts_total")
        elif kind == "retry_throttle":
            _metrics.increment("draftly_throttle_delays_total")
            _metrics.increment(
                "draftly_throttle_seconds_total", float(payload.get("delay_seconds") or 0)
            )
        elif kind == "reasoning_activity":
            chars = int(payload.get("chars") or 0)
            if chars:
                _metrics.increment("draftly_reasoning_chars_total", float(chars))
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd draftly-agent-backend
pytest tests/workflows/test_phase5_runner_events.py -v
```

Expected: all pass. `STREAM_EVENTS` is unchanged, so `TestRunnerStreaming::test_publisher_wired_streams_and_preserves_outcome`'s exact type list still matches.

- [ ] **Step 7: Run the broader suites**

```bash
cd draftly-agent-backend
pytest tests/workflows/ tests/events/ tests/graph/ tests/observability/ -q
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/workflows/runner.py tests/workflows/test_phase5_runner_events.py
git commit -m "feat(events): count reasoning as first token and record stream metrics"
```

---

## Task 9: UI consumers

Spec §9. The new types are additive — every current consumer already ignores unknown types — so this task is purely about making them visible.

**Files:**
- Modify: `draftly-agent-ui/hooks/use-workflow-events.ts:6-17, 32-44`
- Modify: `draftly-agent-ui/hooks/use-workflow-run.ts:33-40`
- Create: `draftly-agent-ui/components/sections/workflows/model-call-timeline.tsx`
- Modify: `draftly-agent-ui/components/sections/workflows/index.ts`

**Interfaces:**
- Consumes: envelope types from Tasks 5–7
- Produces: `ModelCallTimeline({ events }: { events: StreamEvent[] })`

- [ ] **Step 1: Extend the type union**

In `hooks/use-workflow-events.ts`, add the four members to `StreamEventType`:

```typescript
export type StreamEventType =
  | "node_start"
  | "node_stop"
  | "handoff"
  | "text_delta"
  | "tool_progress"
  | "tool_stream_data"
  | "model_call"
  | "retry_throttle"
  | "reasoning_activity"
  | "stage_change"
  | "stage_manifest"
  | "stage_progress"
  | "overall_progress"
  | "workflow_result"
  | "steering";
```

- [ ] **Step 2: Extend the runtime array**

In the same file, mirror it in `EVENT_TYPES` and add `export` so a test can import it:

```typescript
export const EVENT_TYPES: StreamEventType[] = [
  "node_start",
  "node_stop",
  "handoff",
  "text_delta",
  "tool_progress",
  "tool_stream_data",
  "model_call",
  "retry_throttle",
  "reasoning_activity",
  "stage_change",
  "stage_manifest",
  "stage_progress",
  "overall_progress",
  "workflow_result",
  "steering",
];
```

- [ ] **Step 3: Add a drift guard, if the repo has a test runner**

Check for one before writing a test:

```bash
cd draftly-agent-ui
cat package.json | grep -A 15 '"scripts"'
ls vitest.config.* jest.config.* 2>/dev/null
```

If a TS test runner exists, create `hooks/__tests__/use-workflow-events.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../use-workflow-events";

describe("EVENT_TYPES", () => {
  it("has no duplicates", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("covers every backend envelope type", () => {
    for (const t of [
      "node_start", "node_stop", "handoff", "text_delta", "tool_progress",
      "tool_stream_data", "model_call", "retry_throttle", "reasoning_activity",
      "workflow_result",
    ]) {
      expect(EVENT_TYPES).toContain(t);
    }
  });
});
```

**If no test runner exists, skip this step and note it in the commit message.** Do not add a test framework to satisfy a guard test.

- [ ] **Step 4: Fold `model_call` into `mergedSteps`**

In `hooks/use-workflow-run.ts`, widen the filter and add per-call token display:

```typescript
  const mergedSteps = useMemo(() => {
    const persisted = data.data?.steps ?? [];
    const known = new Set(persisted.map((step) => `${String(step.seq)}:${String(step.name)}`));
    const liveSteps = live.events
      .filter(
        (event) =>
          event.type === "node_start" ||
          event.type === "node_stop" ||
          event.type === "tool_progress" ||
          event.type === "model_call",
      )
      .map((event) => ({
        seq: event.seq,
        name:
          event.type === "model_call"
            ? `model · ${String(event.payload.stop_reason ?? "unknown")}`
            : String(event.payload.name ?? event.node_id ?? event.type),
        status:
          event.type === "node_stop"
            ? String(event.payload.status ?? "completed").toLowerCase()
            : "running",
        detail: event.payload,
      }));
    return [...persisted, ...liveSteps.filter((step) => !known.has(`${step.seq}:${step.name}`))];
  }, [data.data?.steps, live.events]);
```

- [ ] **Step 5: Create the timeline component**

First read `components/sections/workflows/steering-event-timeline.tsx` and mirror its `Card` wrapper, heading structure, and text sizing exactly.

Create `components/sections/workflows/model-call-timeline.tsx`:

```typescript
"use client";

import { Card } from "@/components/ui/card";
import type { StreamEvent } from "@/hooks/use-workflow-events";

const RELEVANT = new Set(["model_call", "retry_throttle", "reasoning_activity"]);

/**
 * Per-model-call signal that the log could not provide: the stop reason on
 * every call, plus rate-limit backpressure.
 *
 * `reasoning_activity` shows a character count only — reasoning text is never
 * on the wire (spec §5.3).
 */
export function ModelCallTimeline({ events }: { events: StreamEvent[] }) {
  const rows = events.filter((event) => RELEVANT.has(event.type));
  if (rows.length === 0) return null;

  return (
    <Card className="p-4" aria-labelledby="model-call-timeline-title">
      <h2 id="model-call-timeline-title" className="font-semibold">
        Model calls
      </h2>
      <ul className="mt-3 space-y-1 text-sm">
        {rows.map((event) => (
          <li key={event.seq} className="flex justify-between gap-3">
            <span className="text-foreground-secondary">
              {event.type === "reasoning_activity"
                ? `reasoning · ${String(event.payload.chars ?? 0)} chars`
                : event.type === "retry_throttle"
                  ? `throttled · ${String(event.payload.delay_seconds ?? 0)}s`
                  : `model · ${String(event.payload.stop_reason ?? "unknown")}`}
            </span>
            {event.type === "model_call" && event.payload.stop_reason === "max_tokens" ? (
              <span className="text-destructive">truncated</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

- [ ] **Step 6: Export and render it**

Add to `components/sections/workflows/index.ts`:

```typescript
export { ModelCallTimeline } from "./model-call-timeline";
```

Then in `workflow-run-detail-page.tsx`, render it next to the existing steering timeline. Read the file first — the steering timeline sits in a `<div className="mt-4">` around line 63 — and mirror that, passing `live.events`:

```typescript
<div className="mt-4">
  <ModelCallTimeline events={live.events} />
</div>
```

- [ ] **Step 7: Typecheck and lint**

```bash
cd draftly-agent-ui
pnpm tsc --noEmit
pnpm lint
```

Expected: no errors. If `tsc` is not wired as a script, use the `typecheck` script from `package.json`.

- [ ] **Step 8: Commit**

```bash
cd draftly-agent-ui
git add hooks/use-workflow-events.ts hooks/use-workflow-run.ts \
        components/sections/workflows/
git commit -m "feat(ui): surface per-model-call stop reasons and reasoning presence"
```

---

## Task 10: End-to-end verification against a real graph

Every other task drives `filter_graph_event` with synthetic dicts. This one proves the envelopes appear on a real `graph.stream_async` — and it is the task that catches design errors, exactly as it caught three in this plan's first draft. `StubModel` yields Bedrock-style chunks, so `process_stream` runs and `messageStop` / `metadata` / reasoning deltas all flow, with no live model required.

**Files:**
- Test: `tests/events/test_graph_stream_coverage.py` (create)

**Interfaces:**
- Consumes: everything from Tasks 2–7
- Produces: nothing

- [ ] **Step 1: Write the graph-level test**

```python
"""Real GraphBuilder runs: prove the new envelopes reach a live stream.

Drives an actual graph under StubModel, which yields Bedrock-style chunks, so
the same ``process_stream`` path Bedrock takes runs without a live model
(spec §2.3). This is the test that disproved the first version of this design.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from strands import Agent, tool
from strands.multiagent import GraphBuilder
from tests.stub_model import StubModel

from draftly.events.stream_envelope import filter_graph_event

KW = {"run_id": "cov-1", "surface": "documentation"}


@tool
def echo(text: str) -> str:
    """Echo the given text back."""
    return f"ECHO:{text}"


class _ToolThenTextModel(StubModel):
    """One tool call, then a text answer -- exercises the tool branches."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._calls = 0

    async def stream(self, messages: Any, tool_specs: Any = None, system_prompt: Any = None, **kw: Any) -> Any:
        self._calls += 1
        yield {"messageStart": {"role": "assistant"}}
        if self._calls == 1:
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": "echo"}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps({"text": "hi"})}}}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": "answer"}}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"contentBlockStop": {}}
        yield {"metadata": {"usage": {"inputTokens": 8100, "outputTokens": 16384, "totalTokens": 24484}}}


class _ReasoningModel(StubModel):
    """Reasoning first, then text -- the interleaving that breaks TTFT."""

    async def stream(self, messages: Any, tool_specs: Any = None, system_prompt: Any = None, **kw: Any) -> Any:
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {"reasoningContent": {}}}}
        yield {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Let me check the diff"}}}}
        yield {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "SIG-abc123"}}}}
        yield {"contentBlockStop": {}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "answer"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120}}}


async def _envelopes(model: Any, *, tools: list[Any] | None = None) -> list[Any]:
    builder = GraphBuilder()
    builder.add_node(Agent(model=model, tools=tools or [], name="w"), "w")
    builder.set_entry_point("w")
    graph = builder.build()
    out: list[Any] = []
    async for raw in graph.stream_async("write the docs"):
        if not isinstance(raw, dict):
            continue
        envelope = filter_graph_event(raw, **KW)
        if envelope is not None:
            out.append(envelope)
    return out


@pytest.mark.asyncio
async def test_real_graph_emits_model_call_and_node_tokens() -> None:
    envelopes = await _envelopes(StubModel(text="hello"))
    types = [e.type for e in envelopes]

    assert "node_start" in types
    assert "text_delta" in types
    assert "node_stop" in types
    assert types[-1] == "workflow_result"

    # The whole point of the design: the per-call stop reason is on the wire.
    assert "model_call" in types, (
        "messageStop never reached the filter. Check that the model yields "
        "Bedrock-style chunks so process_stream runs."
    )
    assert {e.payload["stop_reason"] for e in envelopes if e.type == "model_call"} == {"end_turn"}

    stops = [e for e in envelopes if e.type == "node_stop"]
    assert stops
    assert any("tokens_in" in s.payload for s in stops), (
        "per-node tokens missing -- NodeResult.accumulated_usage may have changed"
    )


@pytest.mark.asyncio
async def test_real_graph_emits_tool_progress() -> None:
    envelopes = await _envelopes(_ToolThenTextModel(text="x"), tools=[echo])
    types = [e.type for e in envelopes]

    assert "tool_progress" in types
    # Two model calls: the tool-use turn and the text turn.
    assert {e.payload["stop_reason"] for e in envelopes if e.type == "model_call"} == {
        "tool_use",
        "end_turn",
    }


@pytest.mark.asyncio
async def test_real_graph_emits_reasoning_without_content() -> None:
    envelopes = await _envelopes(_ReasoningModel(text="x"))
    types = [e.type for e in envelopes]

    assert "reasoning_activity" in types
    # Reasoning must arrive before any text, or the TTFT fix is untestable.
    assert types.index("reasoning_activity") < types.index("text_delta")

    blob = json.dumps([e.payload for e in envelopes if e.type == "reasoning_activity"])
    assert "Let me check" not in blob
    assert "SIG-abc123" not in blob
    assert any(e.payload.get("chars", 0) > 0 for e in envelopes if e.type == "reasoning_activity")
```

- [ ] **Step 2: Run the tests**

```bash
cd draftly-agent-backend
pytest tests/events/test_graph_stream_coverage.py -v
```

Expected: 3 passed. **If `model_call` is missing, do not weaken the assertion.** Add a temporary `print(raw)` inside `_envelopes`, inspect the nested shape, and reconcile against Task 5's branch condition — that is precisely how the first draft of this design was found wrong.

- [ ] **Step 3: Run the full backend suite**

```bash
cd draftly-agent-backend
pytest -q
```

Expected: all pass. Any failure is a real regression from Tasks 1–8 — fix it, do not relax the test.

- [ ] **Step 4: Commit**

```bash
cd draftly-agent-backend
git add tests/events/test_graph_stream_coverage.py
git commit -m "test(events): verify new envelopes on a real graph stream"
```

---

## Post-implementation: what still needs a live provider

Task 10 proves the envelopes appear on the Bedrock-style path, and — per spec §2.2 — that is the same path every provider takes, because `OpenAIModel.format_chunk` normalises OpenAI chunks into Bedrock shapes before `process_stream` runs. The residual risk is small and specific:

**First live run on any provider:** confirm `model_call` appears with a real `stop_reason`, and that `draftly_model_calls_total{stop_reason=...}` increments. A `max_tokens` there is the signal that would have caught run `9ab7a0a0` at the moment it failed.

**Do not expect `latencyMs` from provider metadata on six of seven providers.** `openai.py:598` hardcodes `"latencyMs": 0` with a literal `# TODO`. Any future latency field sourced from the `metadata` chunk will read `0` on every OpenAI-compatible provider. Per-call `timeToFirstByteMs` *is* computed in `process_stream:479-481` and is provider-independent, so prefer it.

**Not implemented, by design:** `tool_complete`. `ToolResultEvent` sets `is_callback_event = False` and never reaches the filter (spec §6). Building it requires a Strands `HookProvider` on `AfterToolCallEvent` — Draftly already has the pattern in `RepoReadCachePlugin` — but that touches agent construction rather than the filter, and the hook must be proven to fire before it is worth building. Spec §11 decision 3.
