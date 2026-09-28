# Strands Event Coverage — Design

**Date:** 2026-09-28
**Status:** design complete, corrected against execution-verified SDK behavior
**Scope:** `draftly-agent-backend` streaming filter + SSE contract; `draftly-agent-ui` consumers
**Related:** [`analysis/2026-09-28-strands-stream-events.md`](../analysis/2026-09-28-strands-stream-events.md) (evidence base), [`2026-08-23-event-streaming-design.md`](2026-08-23-event-streaming-design.md) (original wire contract)

> **Revision note.** An earlier draft of this design was written from the Strands
> docs page and source reading alone. Probing the installed SDK with a real
> `GraphBuilder` graph overturned three of its central claims. The corrections are
> §2.2 (provider coverage), §3 (what actually reaches the filter), and §5.2
> (`tool_complete` is not implementable here). **Where this document and the
> docs page disagree, this document is right** — every claim in §3 was observed
> by running the graph, not inferred.

---

## 1. Problem

`filter_graph_event` (`src/draftly/events/stream_envelope.py:220`) is the single
choke point mapping raw Strands events onto Draftly SSE envelopes. It handles
6 of the ~20 event types that reach it. The drops are not bugs — each is a
deliberate `return None` — but the boundary was drawn against a much narrower
data surface than the SDK provides. Three concrete losses:

1. **Per-model-call telemetry is discarded, and so is the reason it failed.**
   Every model turn ends with a stop reason and a usage record. A 16,384-token
   truncation is raised as `MaxTokensReachedException` and the *reason it
   happened* is only visible in the raw provider chunk that Draftly drops.
2. **Per-node tokens reach the wire zero times.** They are extracted in three
   places (`stream_envelope.py:211`, `runner.py:102`, `memory_grounding.py:171`)
   and none of them are correct for the shape that actually arrives (§5.1).
3. **TTFT is measured wrong for reasoning models.** `runner.py:1544` records
   `draftly_run_ttft_ms` on the first `text_delta`. A thinking model emits
   reasoning deltas first, so the metric excludes exactly the latency that
   reasoning adds.

---

## 2. What the SDK actually emits

### 2.1 The gate: `is_callback_event`

`Agent.stream_async` (`agent/agent.py:1257`) yields **only** events whose
`is_callback_event` is `True`, plus one explicit terminal `AgentResultEvent`.
`Graph._execute_node` forwards those verbatim into `MultiAgentNodeStreamEvent`.

This single predicate decides what is reachable. The base class returns `True`
(`types/_events.py:41`); three events override it to `False`:

| Event | `is_callback_event` | Reaches the filter? |
|---|---|---|
| `ToolResultEvent` (`_events.py:287`) | **`False`** (`:310`) | **no** |
| `ModelStopReason` (`_events.py:194`) | **`False`** (`:216`) | **no** |
| `EventLoopStopEvent` (`_events.py:220`) | **`False`** (`:250`) | **no** |
| `ModelStreamEvent` + subclasses | `len(self.keys()) > 0` | yes |
| `ToolStreamEvent` (`_events.py:314`) | default `True` | yes |
| `EventLoopThrottleEvent` (`_events.py:266`) | default `True` | yes |
| `AgentResultEvent` (`_events.py:458`) | yielded explicitly (`agent.py:1271`) | yes |

**The three `False` events are the most information-dense ones in the SDK.**
`ToolResultEvent` is emitted for *every* tool execution; `ModelStopReason`
carries the exact `usage` and `metrics` for every model call. This is not an
oversight in Draftly's filter — no filter can see them. §6 covers the
alternatives.

### 2.2 Provider coverage is uniform, not split

The docs and an earlier draft of this design claimed `model_call` telemetry was
Bedrock-only. **That was wrong.** `OpenAIModel.format_chunk` (`models/openai.py:529`)
converts OpenAI's `chunk_type`/`data_type` stream into Bedrock-shaped chunks
(`messageStart`, `contentBlockDelta`, `messageStop`, `metadata`), so
`process_stream` runs identically for all providers. All seven Draftly
providers share one event surface.

One provider-level difference does matter: for OpenAI-compatible providers
`latencyMs` is hardcoded to `0` (`openai.py:598` — a literal `# TODO`). Any
latency field sourced from the `metadata` chunk reads `0` on six of seven
providers. Per-call `timeToFirstByteMs` *is* computed in `process_stream:479-481`
and is provider-independent.

### 2.3 Empirical basis

Every claim in §3 was observed by running `GraphBuilder` graphs under
`StubModel` (`tests/stub_model.py`), which yields Bedrock-style chunks. One of
those runs ended in `MaxTokensReachedException` — the exact failure of run
`9ab7a0a0`, reproduced deliberately as the test fixture. Not verified: a live
provider key (Bedrock returns `Operation not allowed`; `requesty` HTTP 402).
Because of §2.2, the live/stub distinction is small.

---

## 3. Ground truth: what reaches `filter_graph_event`

Observed nested payloads inside `multiagent_node_stream`, in emission order:

| Nested shape | Reached | Currently |
|---|---|---|
| `{"init_event_loop": True}` | yes | dropped |
| `{"start": True}` | yes | dropped |
| `{"start_event_loop": True}` | yes | dropped |
| `{"event": <raw provider chunk>}` | yes | **dropped** |
| `{"data": str, "delta": …, "agent": …, "event_loop_cycle_id": …}` | yes | `text_delta` |
| `{"type": "tool_use_stream", "current_tool_use": {…}, "delta": …}` | yes | `tool_progress` |
| `{"reasoningText": str, "reasoning": True, "delta": …}` | yes | **dropped** |
| `{"reasoning_signature": str, "reasoning": True, "delta": …}` | yes | **dropped** |
| `{"event_loop_throttled_delay": float}` | yes | **dropped** |
| `{"message": {…}}` | yes | dropped |
| `{"result": AgentResult}` | yes | dropped |
| `{"tool_result": {…}}` | **never** | unreachable |

Three consequences that shape the whole design:

**(a) Events arrive at two nesting depths.** Typed events arrive flat
(`nested["data"]`). Raw provider chunks arrive wrapped
(`nested["event"]["messageStop"]`) — that is `ModelStreamChunkEvent`
(`_events.py:113`), whose whole payload is one chunk. Both depths are real and
the filter must read both.

**(b) The dropped raw chunks are where the per-call telemetry is.** `messageStop`
carries `stopReason` (`max_tokens`, `tool_use`, `end_turn`) and `metadata`
carries `usage`. This is the *only* reachable source of per-model-call truth,
because the richer `ModelStopReason` is gated off (§2.1). It is the direct
cause of run `9ab7a0a0` being undiagnosable in real time.

**(c) The docs page names keys that do not exist.** It documents
`redactedContent`; the SDK builds `reasoningRedactedContent` (`_events.py:183`).
It documents `tool_stream_event` as a bare key; the SDK builds
`{"type": "tool_stream", "tool_stream_event": {tool_use, data}}` (`:324`), where
`data` is a **dict**, so a `isinstance(nested.get("data"), str)` check cannot
see it. It does not mention `tool_result` at all.

---

## 4. The four reasoning fields

Four different kinds of thing sharing a prefix — not four parallel text streams.

| Field | Kind | On the wire? |
|---|---|---|
| `reasoning` | boolean **type tag** | consumed as a branch condition, never forwarded |
| `reasoningText` | the model's deliberation | **no** — §5.3 |
| `reasoning_signature` | opaque round-trip proof | **no** — §5.3 |
| `reasoningRedactedContent` | absence marker (provider withheld) | presence only |

**`reasoning` is a type tag, not content.** Treating it as data streams the
literal string `"True"` to users. The verified payload above shows
`reasoning: 'True'` — a Python `bool` rendered by `str()`.

**`reasoning_signature` is conversation state, not telemetry.** It must be sent
back on subsequent turns or the provider rejects the conversation. It is closer
to a message ID than to a log line. Draftly does not manage it — the SDK does —
but that is exactly why it must never be treated like the other three.

**`reasoningRedactedContent` is a signal, not content.** It means thinking
happened and was withheld. Showing *that* is what stops a 16k-token thinking run
from presenting as a 30-second hang.

---

## 5. Design

Everything routes through `filter_graph_event`. It stays the only place that
knows Strands shapes.

### 5.1 Two existing bugs in the paths being extended

Both were found while establishing §3, and both must be fixed for the new work
to function.

**`_token_usage` is the wrong accessor for `NodeResult`.** `_token_usage` (`:211`)
reads `result.metrics.accumulated_usage`. That is correct for `AgentResult`
(which owns an `EventLoopMetrics`), and is what makes `workflow_result` tokens
work. `NodeResult` has **no** `.metrics` — verified: `hasattr(nr, "metrics")` is
`False`, and its usage hangs directly off `accumulated_usage`. Chaining
`getattr(None, "accumulated_usage", None)` yields `None` silently, so any
per-node token work built on `_token_usage` would report nothing and look like a
provider problem. A separate accessor is required.

**`node_stop`'s dict branch reads a key that never occurs in production.**
`multiagent_node_stop` always carries a `NodeResult` **object**
(`multiagent/graph.py:1030-1038` constructs it explicitly). The dict branch at
`:271-274` reads `node_result["duration"]` and multiplies by 1000; no
`NodeResult` has a `duration` field — it has `execution_time`, already in
milliseconds (`multiagent/base.py:237-250`). The branch is exercised only by test
fixtures. `test_node_stop_accepts_real_node_result_shape` builds a
`SimpleNamespace(status=…, execution_time=1250)` that has neither `metrics` nor
`accumulated_usage`, so it passes while proving nothing about the real shape.

### 5.2 Partial events, completed

**`node_stop` — add per-node tokens, cycle count, interrupts, error.** Sourced
from the real `NodeResult`: `accumulated_usage`, `execution_count`, `interrupts`.
**No new envelope type.** The `duration` / `execution_time` divergence is
documented and the millisecond contract held constant; changing the units would
break the UI's existing duration rendering for no gain.

**`tool_progress` — add a bounded input summary and a phase.** `input`
accumulates as arguments stream and carries repo paths, queries, and pasted
issue text. Forwarding it raw is a disclosure incident. Emit the *shape* —
argument names, types, string lengths — never values, bar a small allowlist of
identifiers. The name gate also relaxes to `toolUseId`, so the first events of a
call (before the model has finished streaming the name) are no longer dropped.

### 5.3 New envelope types

| Type | Source | Payload | Volume |
|---|---|---|---|
| `model_call` | `messageStop.stopReason` + `metadata.usage` | `stop_reason`, `tokens_in`, `tokens_out`, `ttfb_ms` | 1 / model call |
| `reasoning_activity` | `reasoning: True` | `chars`, `redacted` | high |
| `tool_stream_data` | `tool_stream_event` | `tool_use_id`, `name`, `bytes` | opt-in |
| `retry_throttle` | `event_loop_throttled_delay` | `delay_seconds` | rare |

`model_call` is the highest-value item. It is what would have made run
`9ab7a0a0`'s 16,384 `outputTokens` and `stop_reason: max_tokens` visible at the
`impact` node at the moment it was hit, instead of reconstructed afterwards from
a raised exception.

`model_call` is assembled from **two** events, not one: `messageStop` carries the
reason, `metadata` carries the usage, and they arrive as separate raw chunks.
Emitting on `messageStop` alone and enriching on `metadata` would double-count;
the filter correlates them per node.

**`reasoningText` does not reach the wire and does not reach the log.** In order
of weight:

1. **Precedent.** Draftly has suppressed reasoning twice and both times it was
   correct: `callback_handler=None` (`agents/factory.py:96`) after
   `PrintingCallbackHandler` spliced reasoning deltas into log records, and
   `show_locals=False` (`observability/logging.py:71-73`) after
   `invocation_state` rendered each node's own conversation — `reasoningContent`
   included — into the sink. The `reasoning` delta path is now verified to
   deliver exactly what those two fixes suppressed.
2. **Volume.** Reasoning roughly doubles delta rate on a thinking model, against
   `MAX_STREAM_LEN = 1000` and a replay limit of 500 that are *mismatched* (§7).
3. **It is reversible.** Presence-only is a strict subset; adding text later is a
   payload change on one branch.

### 5.4 Deliberately not implemented

| Signal | Why not |
|---|---|
| `tool_complete` | **`ToolResultEvent.is_callback_event` is `False`** (§2.1). Not reachable by any filter. Requires a hook — §6. |
| `message` | Redundant — it is the sum of the `text_delta`s already delivered, and the nested `result` already reports the final usage. |
| `delta`, `agent`, `request_state`, `event_loop_cycle_id`, `event_loop_cycle_span`, `event_loop_cycle_trace` | Invocation scaffolding added by `ModelStreamEvent.prepare` (`_events.py:141-144`). Reaches the filter only because `prepare` mutates the event; carries no user-facing signal. |
| `contentBlockStart` / `contentBlockStop` / `contentBlockDelta` | Provider-internal structure. `data` and the reasoning keys are their projections. |
| `init_event_loop`, `start`, `start_event_loop` | `node_start` covers entry; `start_event_loop` fires per cycle and would double-count UI steps. |
| `node_result.result` | The nested `AgentResult` message is the draft body. The codebase is consistently careful never to put it on the wire. |
| `reasoningText`, `reasoning_signature` | §5.3, §4. |

### 5.5 Not in scope

The `_is_max_tokens_event` docstring (`integrations/strands/models.py:80-85`)
claims no Strands model yields `{"stop": …}`. `ModelStopReason` does. The *code*
is correct — it matches `messageStop`, the shape models actually emit — only the
stated reason is wrong. Comment-only fix, separate ticket.

---

## 6. Tool completion needs a different integration point

`tool_complete` is the most valuable missing event and the filter cannot supply
it. The reachable options, in order of cost:

1. **A Strands `HookProvider` on `AfterToolCallEvent`.** Draftly already has the
   pattern — `RepoReadCachePlugin` (`steering/repo_read_cache_plugin.py`) is a
   working `Plugin` using exactly this hook. It would build a `StreamEnvelope`
   and publish it directly, bypassing `filter_graph_event`. The "single choke
   point" constraint applies to *shaping raw Strands dicts*; a hook publishes
   semantic events and is not a second place where dict shapes are interpreted.
2. **Widen the SDK's gate** — not viable; it is a library change.

Option 1 is a coherent follow-on and is explicitly **out of scope here**: it
touches agent construction (`agents/factory.py`) rather than the filter, and the
hook must be proven to fire before it is worth building. Recorded so it is not
rediscovered as a mystery.

---

## 7. Prerequisite: the retention mismatch

`MAX_STREAM_LEN = 1000` (`redis_stream_bus.py:17`) trims the live Redis stream.
`list_after(limit=500)` (`workflow_events_store.py:67`) caps Postgres replay. A
run producing 501–1000 events has its tail trimmed from Redis while
`min_live_seq` is set to the max *replayed* seq, so live events 501+ are skipped
forever. **Events 501+ are permanently lost.**

This exists today and is not caused by this design — but `model_call` adds one
event per model call, pushing runs closer to the line. Land the fix first, and
make the replay limit and stream trim agree, and stop `list_after` from
silently truncating a resume.

---

## 8. Metrics

| Metric | Type | Fires |
|---|---|---|
| `draftly_run_ttft_ms` | histogram | **changed** — first `text_delta` **or** first `reasoning_activity` |
| `draftly_model_calls_total{stop_reason}` | counter | `model_call` |
| `draftly_tool_starts_total` | counter | `tool_progress` |
| `draftly_reasoning_chars_total` | counter | `reasoning_activity` (count only) |
| `draftly_throttle_delays_total` | counter | `retry_throttle` |

`Metrics` is a flat, label-free registry (`observability/metrics.py:30`), so
labels ride in the metric name. `stop_reason` is a closed `Literal` set
(`types/event_loop.py:39`), so the name space stays bounded.

---

## 9. Consumer contract

New types are additive; the contract is "unknown types are ignored," which every
current consumer already honours.

**Backend** — no changes required. `support_progressive.py` ignores unknown types.
`workflow_events` has no `CHECK` on `type` (`migrations/032_workflow_events.sql`).

**`draftly-agent-ui`**
- `hooks/use-workflow-events.ts` — four new members in the `StreamEventType`
  union and the `EVENT_TYPES` array.
- `hooks/use-workflow-run.ts` — fold `model_call` into `mergedSteps` so per-call
  stop reason and tokens appear on the run page.
- `components/sections/workflows/model-call-timeline.tsx` — **new**; the run-page
  surface for `model_call` / `retry_throttle` / `reasoning_activity`.

---

## 10. Testing

`filter_graph_event` is a pure function, so table-driven unit tests cover every
branch with synthetic dicts, including both redacted-key spellings and both
nesting depths.

The load-bearing test is a **real `GraphBuilder` run** under `StubModel`, which
is what caught the three errors in the earlier draft. It asserts that
`model_call` and `reasoning_activity` actually appear on a live stream. §2.3's
grounds for trusting the design are exactly the tests that failed when the
design was wrong.

Not verifiable without credentials: that a live provider emits the same
sequence. Because of §2.2 the shapes are provider-independent, so this is a
low-risk gap. The first live Bedrock-routed run should confirm `model_call`
appears with a non-zero `stop_reason`.

---

## 11. Decisions taken without input (flagged for override)

| # | Decision | Rationale |
|---|---|---|
| 1 | Reasoning presence-only, no text | §5.3. Two prior regressions were caused by leaking it. |
| 2 | New wire types included | The request was "all events." Additive and backward-compatible. |
| 3 | `tool_complete` deferred to a hook | §6. Structurally impossible via the filter. |
| 4 | No new feature flags | `events_streaming_enabled` is the existing kill switch. Volume is bounded. YAGNI. |
| 5 | Retention fix lands first | §7. Pre-existing bug that this work worsens. |
| 6 | `message` excluded | §5.4. Redundant with `text_delta`. |
| 7 | `node_stop` duration units unchanged | §5.2. Held constant to avoid breaking UI rendering. |

Each is cheap to reverse: 1–4 and 7 are a config, ordering, or payload change;
5 is one filter branch; 6 is one filter branch.
