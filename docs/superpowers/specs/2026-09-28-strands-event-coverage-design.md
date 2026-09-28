# Strands Event Coverage — Design

**Date:** 2026-09-28
**Status:** approved for planning
**Scope:** `draftly-agent-backend` streaming filter + SSE contract; `draftly-agent-ui` consumers
**Related:** [`analysis/2026-09-28-strands-stream-events.md`](../analysis/2026-09-28-strands-stream-events.md) (evidence base), [`2026-08-23-event-streaming-design.md`](2026-08-23-event-streaming-design.md) (original wire contract)

---

## 1. Problem

`filter_graph_event` (`src/draftly/events/stream_envelope.py:220`) is the single
choke point mapping raw Strands events onto Draftly SSE envelopes. It handles
6 of ~20 emitted event types. The drops are not bugs — each is a deliberate
`return None` — but the boundary was drawn against a much narrower data
surface than the SDK now provides. Three concrete losses:

1. **Tools are start-only.** `current_tool_use` fires when a tool *begins*.
   Nothing reports that it ended, how long it took, or whether it errored.
   `ToolResultEvent` is yielded by the executor for **every** tool and is
   dropped.
2. **Per-model-call telemetry is discarded.** `ModelStopReason` yields
   `stop_reason`, `usage`, and `latencyMs`/`timeToFirstByteMs` as the final
   event of every model turn. It is dropped.
3. **TTFT is measured wrong for reasoning models.** `runner.py:1544` records
   `draftly_run_ttft_ms` on the first `text_delta`. A thinking model emits
   reasoning deltas *first*, so the metric silently excludes exactly the
   latency reasoning adds — on the model class Draftly routes reasoning work to.

The same vocabulary feeds three sinks with different constraints: the worker
log, the SSE wire, and the UI. One filter serves all three. That constraint
drives most decisions below.

---

## 2. What the SDK actually emits (verified, not documented)

The docs page is the vocabulary; the installed SDK is the truth. Read from
`strands/types/_events.py` and `strands/event_loop/streaming.py` at the
installed version. **Three places where the docs are wrong or silent**, each
of which would have produced a broken implementation if trusted:

| # | Docs say | SDK builds | Consequence |
|---|---|---|---|
| 1 | `redactedContent` | `{"reasoningRedactedContent": …}` (`_events.py:183`) | Matching the documented name is a silent no-op. Must accept **both**. |
| 2 | `tool_stream_event` | `{"type": "tool_stream", "tool_stream_event": {"tool_use": …, "data": …}}` (`_events.py:324`) | `data` is **not** at top level. The existing `isinstance(nested.get("data"), str)` check cannot see it. |
| 3 | *(not listed)* | `tool_result` (`_events.py:287`) | The most important gap is one the docs never mention. |

### 2.1 The `stop` key has two arities

Two different `TypedEvent` classes both build a `"stop"` key:

| Class | Tuple | Emitted by |
|---|---|---|
| `ModelStopReason` (`:212`) | `(stop_reason, message, usage, metrics)` — **4** | `process_stream` (`streaming.py:454, 486`) |
| `EventLoopStopEvent` (`:245`) | `(stop_reason, message, metrics, request_state, interrupts, structured_output, checkpoint)` — **7** | `_stop_for_interrupts` / normal agent stop |

`event_loop.py:697` destructures the 4-tuple. Any consumer of `event["stop"]`
**must branch on arity** — a 7-tuple index-2 read returns
`EventLoopMetrics`, not `Usage`. Getting this wrong yields plausible-looking
nonsense, not an exception.

### 2.2 Provider coverage is not uniform

| Signal | Bedrock / Anthropic | OpenAI-compatible (6 of 7 Draftly providers) |
|---|---|---|
| `ModelStopReason` (`stop`, 4-tuple) | yes | **no** — `openai.py` never calls `process_stream` |
| `EventLoopThrottleEvent` | yes | yes (raised from `ModelThrottledException`) |
| `ToolResultEvent` | yes | yes |
| `ToolStreamEvent` | opt-in per tool | opt-in per tool |
| Reasoning deltas | `reasoningText` keys | `data_type: "reasoning"` chunks (`openai.py:740`) — **translation to typed events unverified** |

Six of Draftly's seven providers are `OpenAIModel` wrappers
(`mantle`, `openrouter`, `requesty`, `orcarouter`, `nvidia`,
`nebius_token_factory`); only `bedrock.py` is native. **The design must
degrade, not assume.** `model_call` is emitted when available and simply
absent otherwise — never synthesized, never defaulted.

### 2.3 Empirical status

Verified by execution against a real `GraphBuilder` graph and `StubModel`
(`tests/stub_model.py` yields Bedrock-style chunks, so `process_stream` runs
and `ModelStopReason` **does** fire without a live model). Not verified against
a live provider — Bedrock returned `Operation not allowed`, `requesty` HTTP 402.
The §2.2 provider column is source-derived.

---

## 3. The four reasoning fields

These are four *different kinds of thing* sharing a prefix. They are not four
parallel text streams.

| Field | Kind | What it is | On the wire? |
|---|---|---|---|
| `reasoning` | boolean marker | Discriminator: "this event is reasoning" | consumed as a branch condition, never forwarded |
| `reasoningText` | content | The model's actual deliberation | **no** — see §4 |
| `reasoning_signature` | opaque proof | Cryptographic signature over the reasoning block | **no** — must round-trip to the model |
| `reasoningRedactedContent` | absence marker | Provider withheld the reasoning (safety) | presence only |

**`reasoning` is a type tag.** It carries no content. `payload["text"] =
event["reasoning"]` streams the literal string `"True"` to users.

**`reasoning_signature` is conversation state, not telemetry.** It must be sent
back on subsequent turns or the provider rejects the conversation. It is
closer to a message ID than to a log line: never to the browser, never
dropped by the SDK. Draftly does not manage it — that is the SDK's job — but
it is the reason the field is not treated like the other three.

**`reasoningRedactedContent` is a signal, not content.** It means thinking
happened and was withheld. The product value is showing *that*, so a 16k-token
thinking run does not present as a 30-second hang.

**Delta lifecycle** (`event_loop/streaming.py`): `handle_content_block_delta`
appends text, tool input, *or reasoning* to state; `handle_content_block_stop`
finalizes. Reasoning arrives interleaved with text throughout generation, not
as one block at the end.

---

## 4. Decision: reasoning presence, not reasoning text

**`reasoningText` does not reach the wire and does not reach the log.**

Rationale, in order of weight:

1. **Precedent.** Draftly has suppressed reasoning twice and both times it was
   correct: `callback_handler=None` (`agents/factory.py:96`) after
   `PrintingCallbackHandler` spliced reasoning deltas into log records, and
   `show_locals=False` (`observability/logging.py:71-73`) after
   `invocation_state` rendered each node's own conversation — `reasoningContent`
   included — into the sink.
2. **The volume problem is unsolved.** Reasoning roughly doubles delta rate on
   a thinking model. `MAX_STREAM_LEN = 1000` (`redis_stream_bus.py:17`) and
   `list_after(limit=500)` (`workflow_events_store.py:67`) are the binding
   constraints, and they are mismatched (§6). Streaming a high-frequency
   signal through a bounded buffer that already truncates is a regression.
3. **It is reversible.** Presence-only is a strict subset. If the product
   later wants the text, it is a payload change on one branch, not a redesign.

What ships instead:

- **`reasoning_activity`** envelope — `{"chars": <int>, "redacted": <bool>}`.
  Fixes the perceived hang and the TTFT measurement bug without moving a single
  character of chain of thought.
- **TTFT counts reasoning activity as first token** (§5.1).

---

## 5. Design

Everything routes through `filter_graph_event`. It stays the only place that
knows Strands shapes.

### 5.1 Partial events, completed

**`node_stop` — add tokens and error.** `node_result.metrics.accumulated_usage`
holds the same field `_token_usage` (`:209`) already reads for the final
result, and the same field `runner.py:102` already walks over
`graph_result.execution_order`. Per-node tokens are extracted three times in
this codebase and reach the wire zero times. Add `tokens_in`, `tokens_out`,
and `error` to the existing payload. **No new envelope type.**

**`tool_progress` — add a bounded input summary and a phase.** `input`
accumulates as streaming proceeds and carries repo paths, queries, and issue
text. Forward it raw and it is a disclosure incident. Emit a *shape* summary:
argument names, JSON types, and string lengths — never values — plus
`phase: "start"`. Relax the name gate to `toolUseId` so the first events of a
call (before the name is known) are no longer dropped. **Existing type.**

**TTFT counts reasoning.** `runner.py:1544`: fire on first `text_delta` **or**
first `reasoning_activity`. No wire change; fixes a measurement bug.

### 5.2 New envelope types

Each is a new `type` string. Additive — unknown types are already dropped by
every consumer (`use-workflow-events.ts` filters, `support_progressive.py`
ignores, `workflow_events` has no CHECK on `type`).

| Type | Source key | Payload | Volume | Notes |
|---|---|---|---|---|
| `tool_complete` | `tool_result` | `tool_use_id`, `name`, `status`, `content_bytes`, `is_error` | 1 / tool | Universal. Closes the start-only gap. **Never forwards `content`.** |
| `tool_stream_data` | `tool_stream_event` | `tool_use_id`, `name`, `bytes` | opt-in | Needs its own branch — `data` is nested (§2 #2). Makes `RepoReadCachePlugin.stream` visible. |
| `model_call` | `stop` (4-tuple) | `stop_reason`, `tokens_in`, `tokens_out`, `latency_ms`, `ttfb_ms` | 1 / model turn | **Arity-gated.** Per-call `max_tokens` visibility, which is the whole point. |
| `retry_throttle` | `event_loop_throttled_delay` | `delay_seconds` | rare | Backpressure stops looking like a hang. |
| `reasoning_activity` | `reasoning: True` | `chars`, `redacted` | high | **Presence only** (§4). Accepts both redacted key spellings. |

`model_call` is the highest-value addition: it is what would have made run
`9ab7a0a0`'s 16,384 `outputTokens` visible at the `impact` node *at the moment
it was hit*, instead of reconstructed afterwards from an exception.

### 5.3 Nested-payload unwrapping

`ModelStreamChunkEvent` (`_events.py:113`) also builds an `"event"` key, so a
`multiagent_node_stream` can nest twice. A single helper
(`_typed_payload`) unwraps one extra level **only when the outer dict carries
none of the recognized typed keys** — so the existing `data` / `current_tool_use`
path is byte-for-byte unchanged and the new branches are robust to either
nesting depth. Extracted as its own task precisely because it is the kind of
defensive shape-guessing that deserves an isolated, reviewable test.

### 5.4 Deliberately not implemented

| Signal | Why not |
|---|---|
| `message` (complete assistant turn) | Redundant — it is the sum of the `text_delta`s already delivered. "What actually completed" is answered by `workflow_result`, which exists. Adding it doubles text volume for no new information. |
| `delta` (raw provider delta) | Provider-internal; `data` and `reasoningText` are its projections. |
| `init_event_loop` / `start_event_loop` | `node_start` covers entry. `start_event_loop` fires per cycle and would double-count UI steps; the `steering` envelope already gives a per-cycle signal. |
| `node_result.content` | Draft content. The codebase is consistently careful never to put it on the wire. |
| `reasoningText` | §4. |
| `reasoning_signature` | §3 — round-trip state, not telemetry. |
| `structured_output` | Already consumed directly off `AgentResult` by callers. |

### 5.5 Not in scope

Fixing the incorrect `{"stop": …}` claim in the `_is_max_tokens_event`
docstring (`integrations/strands/models.py:80-85`) — the fix is correct, only
its stated reason is wrong, and it is flagged in the analysis doc. Comment-only
change, worth doing, separate ticket.

---

## 6. Prerequisite: the retention mismatch

`MAX_STREAM_LEN = 1000` (`redis_stream_bus.py:17`) trims the live Redis stream
at 1000 events. `list_after(limit=500)` (`workflow_events_store.py:67`) caps
Postgres replay at 500. A run producing 501–1000 events has its tail trimmed
from Redis but is only replayed to seq 500 from Postgres — after which
`min_live_seq` (set to the max replayed seq, `workflows.py:410`) drops
everything still arriving live. **Events 501+ are permanently lost.**

This exists today and is not caused by this design. But `tool_complete` and
`model_call` each add one event per tool/turn, pushing runs closer to the
line. Land the fix first: make the replay limit and the stream trim agree, and
stop `list_after` from silently truncating a resume.

---

## 7. Metrics

| Metric | Type | Fires |
|---|---|---|
| `draftly_run_ttft_ms` | histogram | **changed** — now first `text_delta` **or** first `reasoning_activity` |
| `draftly_model_calls_total` | counter | `model_call`, labelled by `stop_reason` |
| `draftly_tool_calls_total` | counter | `tool_complete`, labelled by `status` |
| `draftly_reasoning_chars_total` | counter | `reasoning_activity` (count only) |
| `draftly_throttle_delays_total` | counter | `retry_throttle` |

Existing `draftly_tokens_input_total` / `draftly_tokens_output_total`
(`runner.py:107-109`) are unchanged. `model_call` is additive per-call detail;
the run-level totals remain the aggregate source of truth.

---

## 8. Consumer contract

New types are additive; the contract is "unknown types are ignored," which
every current consumer already honours.

**Backend** — no changes required. `support_progressive.py` ignores unknown
types. `workflow_events.append` has no `type` CHECK. `github.py` and
`workflows.py` filter on specific types.

**`draftly-agent-ui`**
- `hooks/use-workflow-events.ts` — add the five types to the `StreamEventType`
  union and the `EVENT_TYPES` array.
- `hooks/use-workflow-run.ts` — fold `tool_complete` and `model_call` into
  `mergedSteps` so per-node token and latency appear on the run page.
- `components/sections/workflows/` — a run-detail timeline row for
  `model_call` / `retry_throttle`, and a "thinking" indicator driven by
  `reasoning_activity`.

---

## 9. Testing

`filter_graph_event` is a pure function — table-driven unit tests cover every
new branch with synthetic event dicts, including both redacted-key spellings
and both `stop` arities.

`StubModel` yields Bedrock-style chunks, so `process_stream` runs and
`ModelStopReason` fires **without a live model**. That converts §2.3's
source-derived claim into an execution-verified one: a graph-level test
asserting a `model_call` envelope appears on a real `graph.stream_async`.

Not verifiable without provider credentials: that `mantle`/`openrouter` emit
`model_call` at all. They will not — §2.2 — and the design's arity guard makes
that a non-event rather than a failure. The first live run on Bedrock should be
watched to confirm `model_call` appears.

---

## 10. Decisions taken without input (flagged for override)

| # | Decision | Rationale |
|---|---|---|
| 1 | Reasoning presence-only, no text | §4. Precedent + unsolved volume problem. |
| 2 | New wire types included | The request was "all events." Additive and backward-compatible. |
| 3 | No new feature flags | `events_streaming_enabled` is the existing kill switch. Volume is bounded (1 event per tool/turn, zero for reasoning text). YAGNI. |
| 4 | Retention fix lands first | §6. It is a pre-existing bug that this work makes worse. |
| 5 | `message` excluded | §5.4. Redundant with `text_delta`. |

Each is cheap to reverse if you disagree — 1–4 are a config or ordering
change; 5 is a filter branch.
