# Event Streaming Design (Phases 1–3)

Date: 2026-08-23
Status: Approved (design reviewed in chat; Approach A selected)
Scope: `draftly-agent-backend/src/draftly/` (observability, events, workflows,
app/api) + `draftly-agent-frontend` (phase 2) + docker compose (redis service)

Scope extension (2026-08-23, post-analysis review): the read-side
observability surface — runs/steps audit APIs, review queue APIs, metrics
exposition, evaluations org-scoping fix, and routing/performance/job-history
read endpoints — is folded into Phase 4 of this spec (see §Observability
surface). These pair with streaming: SSE carries live events; the audit
tables and read APIs carry replay and history.

## Problem

Every Strands graph execution in Draftly is blocking:

- `workflows/runner.py:95` — `await graph.invoke_async(...)` waits for full
  graph completion before anything is observable.
- `app/api/routes/documentation.py:61` — `POST /documentation/sync` blocks the
  HTTP request until the entire research→impact→write→review→audit→deliver
  pipeline finishes ("v1 executes sync synchronously"); clients fall back to
  polling `GET /sync/{job_id}`.
- `integrations/strands/client.py:75` — `StrandsClient.invoke()` same pattern.

Consequences: users stare at a spinner for minutes-long runs; per-node
latency and failure attribution require log spelunking across ~20 agents;
support answers appear only once, late.

Dead infrastructure proves the intent existed but was never wired:
`observability/events.py` defines `stream_graph_events()` (adapts
`graph.stream_async` into SSE-shaped dicts, docstring "plan §9.3") and an
in-process `EventStream` pub/sub hub with `format_sse()`. Both are exported
from `observability/__init__.py` and imported by zero call sites.

## Goal

A unified, phased event-streaming bus that carries Strands graph events from
the worker process to browsers and integrations in real time:

1. **Phase 1 — Transport + docs UX**: worker publishes filtered events to
   Redis; API exposes SSE; `/documentation/sync` returns `202 {run_id}`
   immediately.
2. **Phase 2 — Observability**: persist envelopes for replay/resume; live
   execution-graph view in the frontend; per-node metrics from `node_stop`.
3. **Phase 3 — Support chat**: progressive Slack/Discord message rendering
   from writer/researcher text deltas.
4. **Phase 4 — Observability surface (read-side APIs)**: expose the data
   already persisted but unreachable by the frontend — run audit trail
   (`agent_runs`/`agent_steps`), review queue, model-routing decisions,
   performance aggregates, job history, metrics exposition; plus the
   evaluations org-scoping fix.

Non-goals: bi-directional browser→agent messaging (WebSocket), event replay
for arbitrary historical windows beyond Last-Event-ID resume, streaming for
the evaluation/feedback graphs (they keep `invoke_async`), replacing the
existing idempotency/interrupt persistence model, memory-listing APIs
(deferred), and any write-path changes to the audit/routing/reviews schemas.

## Why Strands makes this cheap

`Graph.stream_async()` yields the same final `GraphResult` as
`invoke_async()` *plus* an async iterator of raw dict events. Zero changes to
any of the ~20 agent builders or the three surface graphs. Event families
(per SDK docs):

| Family | Keys | Draftly use |
|---|---|---|
| Lifecycle | `init_event_loop`, `start_event_loop`, `message`, `force_stop` | mostly dropped; `force_stop` surfaced as error detail |
| Model stream | `data` (text chunk), `delta`, `reasoning` | `text_delta` from `data`; rest dropped |
| Tool | `current_tool_use` (`toolUseId`, `name`, `input`) | `tool_progress` |
| Multi-agent | `multiagent_node_start/stream/stop`, `multiagent_handoff`, `multiagent_result` | pipeline progress backbone |

The Python SDK deliberately ships no serialization filter — the docs
prescribe owning a `filter_event` function. That function becomes our
envelope shaper and the single place that knows the wire contract.

## Architecture decision

Approach A — Redis pub/sub backbone (chosen over DB tail-poll: ~1s latency
and write amplification make token streaming janky; over dual-mode: two code
paths contradict the "unified bus" goal).

```
┌─ Worker container ──────────────────────────┐   ┌─ API container ──────────────┐   ┌─ Browser ─┐
│ WorkflowRunner.run()                        │   │ GET /workflows/{run_id}/events│   │EventSource│
│   graph.stream_async(task, state) ──►       │   │   Redis subscribe ──►        │   │    ▲      │
│   filter_graph_event() → envelope           │ ──┼─► EventStream hub ──►        │ ──┼───┘       │
│   RedisEventPublisher ─► draftly:events:{run_id}│  format_sse() + heartbeat     │   │           │
└─────────────────────────────────────────────┘   └──────────────────────────────┘   └───────────┘
```

Key properties:

- **Runner semantics preserved.** The runner's streaming helper consumes the
  final `result` event to obtain the identical `GraphResult`; interrupt
  storage, status marking, routing telemetry are untouched. Flag-off runs use
  today's exact `invoke_async` path.
- **One subscription per run on the API side**, fanned out locally by the
  existing `EventStream` hub so N browser tabs share one Redis connection.
- **Never fail a workflow over streaming** — publisher errors are logged and
  swallowed (mirrors `_record_routing_outcome`'s best-effort philosophy).
- CockroachDB does not support `LISTEN/NOTIFY`, ruling out a Postgres-only
  transport; Redis also unlocks phase 3 token latency.

## Wire contract

Envelope (stable JSON):

```json
{
  "type": "node_start | node_stream | node_stop | handoff | text_delta | tool_progress | workflow_result",
  "run_id": "…", "surface": "documentation",
  "seq": 42, "ts": "2026-08-23T…Z",
  "node_id": "writer?",
  "payload": { … }
}
```

Filter mapping (module-level pure function `filter_graph_event(event, ctx)`):

| Raw Strands event | Envelope | Notes |
|---|---|---|
| `multiagent_node_start` | `node_start` | `{node_id, node_type}` |
| `multiagent_node_stream` | unwrap nested | nested `data`→`text_delta`; `current_tool_use` (with name)→`tool_progress` |
| `multiagent_node_stop` | `node_stop` | `{node_id, status, duration_ms}` from NodeResult |
| `multiagent_handoff` | `handoff` | `{from_node_ids, to_node_ids}` |
| `result` | `workflow_result` | `{status, interrupts}`; terminal — ends the stream |
| `force_stop` | `workflow_result` variant | include `force_stop_reason` |
| everything else | dropped | lifecycle flags, raw `delta`, `reasoning` |

Redis channels: `draftly:events:{run_id}`. Messages are the envelope JSON.

## Components

New / changed files:

- `draftly/events/envelope.py` (new) — `StreamEnvelope` dataclass +
  `filter_graph_event()` pure mapper + seq counter helper.
- `draftly/events/redis_bus.py` (new) — thin async wrapper around
  `redis.asyncio`: `publish(run_id, envelope)`, `subscribe(run_id)`
  (async iterator), reconnect/backoff. No other module imports redis.
- `draftly/workflows/runner.py` — optional `publisher` ctor arg; when set,
  `run()` uses new `_stream_invoke(graph, task, state)` (iterate
  `stream_async`, publish filtered envelopes, return GraphResult); else
  current path byte-for-byte.
- `draftly/observability/events.py` — keep `EventStream`/`format_sse`
  as-is; `stream_graph_events` delegates to the envelope filter.
- `draftly/app/api/routes/workflows.py` (new) —
  `POST /workflows/{run_id}/stream-ticket` (auth: existing Clerk token via
  `get_verified_token`; verifies org access through the job record; issues
  one-time short-lived ticket because `EventSource` cannot set headers)
  and `GET /workflows/{run_id}/events?ticket=…` returning
  `StreamingResponse(media_type="text/event-stream")`: ticket check → Redis
  subscribe → `EventStream` fan-out → `format_sse` frames; heartbeat comment
  every 15s; terminal `workflow_result` ends response.
- `draftly/app/api/routes/documentation.py` — `/sync` submits via the task
  runner and returns `202 {job_id, run_id}` without awaiting completion;
  `GET /sync/{job_id}` unchanged (fallback polling).
- `draftly/app/config.py` — `redis_url`, `events_streaming_enabled`,
  `events_heartbeat_seconds`.
- `docker/` + infra — add `redis:7-alpine` service; wire env var.
- Frontend (phase 2): `useWorkflowEvents` hook (`EventSource` with
  reconnect + Last-Event-ID); `execution-graph.tsx` consumes
  `node_start/handoff/node_stop`; writer pane appends `text_delta`.
- Phase 3: support surfaces subscribe to `text_delta` for their run and
  progressively edit Discord messages / Slack `chat.update` (≥1s throttle).

## Observability surface (Phase 4 — read-side APIs)

Analysis finding: the backend persists rich telemetry that no API route
exposes, and the frontend dashboard is entirely mock-fed
(`dashboard/data.ts` hardcodes every dataset). Phase 4 exposes what already
exists — read-only, org-scoped, no schema changes:

| # | Gap | Existing persistence | New surface |
|---|---|---|---|
| 1 | **Review queue unreachable** | `reviews` table; `ReviewsRepository.list_reviews/get_review/record_decision` and `ReviewService.list_pending/get_by_run_id/decide` exist; only the resume route (`POST /github/review/{run_id}`) is exposed | `GET /reviews` (status/org filters), `GET /reviews/{id}` — decisions keep using the existing resume route |
| 2 | **Run audit trail unreachable** | `agent_runs`/`agent_steps` written by `RunAuditLogger` → `AgentRunsRepository` (write-only today) | `AgentRunsRepository.list_runs/get_run/list_steps`; `GET /runs`, `GET /runs/{run_id}`, `GET /runs/{run_id}/steps` |
| 3 | **Metrics invisible + evaluations org bug** | in-process `Metrics` registry with `render()`/`snapshot()` but no HTTP endpoint (and per-container registries); `list_evaluations` hardcodes `org_id=""` at `routes/evaluations.py:40` | `GET /metrics` (Prometheus text) + `GET /metrics/snapshot` (JSON); evaluations route takes the Clerk token's `org_id` |
| 4 | **Routing/performance/job history unreachable** | `RoutingRepository.recent(limit)` exists; `DatabasePerformanceStore.get_all()` exists (no repo method); `JobRepositoryImpl.get/list_active` exist | `GET /observability/routing-decisions`, `GET /observability/model-performance`, `GET /jobs` (active list) + `PerformanceRepository.all()` |
| 5 | **Strands-native metrics uncaptured** (per Strands observability docs: token usage, tool success rates, cycle counts, limit-hit rates, TTFT) | SDK exposes all of it on `AgentResult.metrics` (`EventLoopMetrics`) and via stream events, but zero source reads `accumulated_usage`; configured limits (`strands_max_node_executions`, timeouts) are never measured against; the `Metrics` registry only holds generic `traced()` spans | Wire the registry (Prometheus `/metrics` from #3): loop/graph counters, tool counters, token counters, limit-hit counters, TTFF histogram — exported from `RunAuditLogger` flushes and the runner's streaming path |

Design rules for #5: metrics are **exported, not persisted** — no new columns
on `agent_runs`/`routing`/`reviews` (respects non-goals); token/limit signals
go to the Prometheus registry plus structlog lines carrying `run_id` so they
remain joinable with audit rows.

Design rules: all list endpoints require `get_verified_token`, filter by
the token's `org_id`, clamp `limit` (≤200), and return plain JSON dicts
(matching existing route style). The reviews decide path intentionally stays
on `POST /github/review/{run_id}` to avoid duplicating resume logic.
Multi-process metrics caveat is documented, not solved: each container's
registry is process-local; `/metrics` reflects the serving process only.

Frontend wiring (mock replacement in `dashboard/data.ts` consumers:
`agent-activity`, `system-pulse`, `quality-gates`, `needs-attention`,
`active-workflows`, plus `components/reviews/*`) is covered by Task 15 of
the implementation plan, which rewires these components onto the endpoints
above using the existing `api/client.ts` auth plumbing — no new
dependencies.

## Error handling & backpressure

- Slow SSE consumer: `EventStream` already drops + warns on `QueueFull`
  (maxsize 256). Client resyncs via Last-Event-ID (phase 1: reconnect gets
  live tail only; phase 2 replays missed seq range from the DB log).
- Redis unavailable at publish time: log warning once per run, continue run.
  At subscribe time: SSE returns 503.
- Client disconnect: cancel local subscription; worker unaffected.
- Ticket auth: single-use, TTL 60s, bound to `(org_id, run_id)`.
- Heartbeats keep proxies from idling out connections.

## Testing

- Unit: `filter_graph_event` table-driven tests using recorded raw Strands
  event dicts (each family → expected envelope or None); seq monotonicity;
  envelope JSON round-trip with `default=str` guard.
- Unit: runner in streaming mode with the existing `StubModel` doubles
  extended to emit `stream_async` events — assert published sequence AND
  that outcome handling (interrupts, status marking) matches the
  `invoke_async` golden path. Extend `tests/workflows/test_phase5_runner_events.py`.
- Unit: publisher swallow-failure behavior with `fakeredis` raising.
- API: SSE route via httpx ASGI transport — auth rejection without valid
  ticket, frame format, terminal-on-result, heartbeat presence.
- Contract: flag-off regression proving zero behavioral delta.
- Read-side APIs: fake-repo route tests per endpoint (org scoping, limit
  clamping, 404 paths); evaluations org pass-through test; metrics snapshot
  shape test.

## Rollout / risks

- Feature-flagged (`events_streaming_enabled=false` default) → mergeable
  incrementally; docs UX flips the flag first.
- Risk: event volume from chatty nodes — mitigated by dropping non-envelope
  families at the source (worker side) rather than at consumers.
- Risk: Redis as new SPOF for UX (never for correctness — workflows complete
  without it).
