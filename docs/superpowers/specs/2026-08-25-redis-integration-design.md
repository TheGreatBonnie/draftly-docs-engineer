# Redis Integration Design Spec for Draftly

**Date:** 2026-08-25
**Status:** Approved
**Scope:** Full Redis integration across backend + frontend

## 1. Overview

Draftly currently uses Redis exclusively for pub/sub event streaming (`RedisEventBus`). This design adds 6 new Redis-backed subsystems to the backend (semantic caching, vector search, event streams, rate limiting, distributed state, API response caching) and 2 frontend improvements (SWR client-side caching, dashboard push via SSE).

## 2. Architecture Principles

- **Single Redis DB, prefix namespacing** — all keys under `draftly:` prefix
- **Graceful degradation** — cache/vector/rate-limit failures never fail a workflow
- **Dual-write migration** — new subsystems write to both Redis and existing stores during transition
- **Provider-level cache interception** — transparent to agent code
- **Per-org vector indexes** — first-class multi-tenant isolation

## 3. Current State

### 3.1 Redis Usage Today

Redis is used exclusively for pub/sub via `RedisEventBus` (`events/redis_bus.py`):
- `publish(envelope)` — fire-and-forget to `draftly:events:{run_id}`
- `subscribe(run_id)` — async generator yielding `StreamEnvelope`
- Feature-flagged via `events_streaming_enabled` (default `False`)
- The "only module allowed to import redis" constraint

### 3.2 Pain Points

- **Zero LLM caching** — 5-12 fresh LLM calls per documentation workflow
- **pgvector isolation gap** — vector search has no `org_id` filter (`vector_search.py:37-63`)
- **Fragile pub/sub** — fire-and-forget, requires PostgreSQL tee for replay
- **No rate limiting** — unbounded webhook and API ingestion
- **In-memory state** — `TicketStore`, `EMAStatsStore`, `ModelHealthRegistry` lost on restart

## 4. Subsystem Specifications

### 4.1 Redis Connection Layer

**Module:** `src/draftly/integrations/redis.py`

Shared Redis connection pool. All subsystems import from here.

```python
class RedisClient:
    def __init__(self, url: str): ...
    async def health_check(self) -> bool: ...
    def pipeline(self) -> RedisPipeline: ...
    @property
    def native(self) -> redis.asyncio.Redis: ...
```

- Replaces the "only redis_bus imports redis" constraint
- `RedisEventBus` gets a `RedisClient` injected instead of creating its own connection
- Health check exposed at `GET /health/redis`
- Single Redis DB with prefix namespacing

### 4.2 Semantic Cache

**Module:** `src/draftly/integrations/semantic_cache.py`

Cache LLM responses keyed by prompt similarity. Intercepts at the provider level.

**Cache flow:**
1. Embed prompt text using existing `EmbeddingService`
2. Exact-match lookup: `GET draftly:llmcache:exact:{sha256(system+message+model)}`
3. If miss: vector search `FT.SEARCH draftly:llmcache:semantic:{org_id} ...`
4. If similarity >= 0.90: return cached response
5. If miss: call LLM, store result with TTL

**TTL by task type:**
- `fast`: 600s (10 min)
- `reasoning`: 1800s (30 min)
- `documentation_generation`: 3600s (1 hr)
- `evaluation`: 0 (never cached)
- `support`: 900s (15 min)

**Invalidation:** TTL-based + explicit on documentation update events.

### 4.3 Vector Search

**Module:** `src/draftly/integrations/redis_vector_search.py`

Migrate vector storage/search to Redis while keeping PostgreSQL as source of truth for `memory_items` metadata.

**Per-org RediSearch index:**
```
FT.CREATE draftly:vectors:{org_id}
  ON HASH PREFIX 1 draftly:vec:{org_id}:
  SCHEMA
    memory_item_id TAG
    namespace TAG
    embedding VECTOR HNSW 12 FLOAT32 1536 COSINE
    importance NUMERIC
    content_hash TEXT
    created_at NUMERIC
```

**Dual-write pattern:**
- `MemoryService.store()` writes to PostgreSQL AND Redis
- `MemoryService.search()` reads from Redis, falls back to pgvector
- Background cleanup job removes stale Redis entries

**Persistence:** RDB + AOF.

### 4.4 Event Streams

**Module:** `src/draftly/events/redis_stream_bus.py`

Replace pub/sub with Redis Streams for durable event delivery.

**Stream key:** `draftly:stream:{run_id}`
**Entry:** `XADD ... MAXLEN ~ 1000 * seq {n} type {t} node_id {nid} payload {json} ts {iso}`

**Consumer model:** Unique consumer per SSE connection (not shared groups).

**Resume:** `Last-Event-ID` maps to Redis stream entry ID natively.

**Auto-trim:** `MAXLEN ~ 1000` per run.

### 4.5 Rate Limiting

**Module:** `src/draftly/integrations/rate_limiter.py`

Sliding window via Sorted Sets.

| Scope | Key Pattern | Limit | Window |
|-------|------------|-------|--------|
| GitHub webhooks | `draftly:ratelimit:github:{installation_id}` | 100 | 60s |
| Slack events | `draftly:ratelimit:slack:{workspace_id}` | 50 | 60s |
| Discord events | `draftly:ratelimit:discord:{guild_id}` | 50 | 60s |
| API per user | `draftly:ratelimit:api:{user_id}` | 30 | 60s |
| LLM per org | `draftly:ratelimit:llm:{org_id}:{task_type}` | configurable | 60s |

### 4.6 Distributed State

#### Ticket Store
**Key:** `draftly:ticket:{ticket_id}` → JSON `{run_id, user_id, created_at}`
**TTL:** 60 seconds
**Consume:** Lua script for atomic GET+DEL

#### EMA Stats Store
**Key:** `draftly:ema:{task_type}:{model_name}` → Hash
**Fields:** `sample_count`, `mean_latency_ms`, `variance_latency_ms`, `success_rate`, `p50_latency_ms`, `p95_latency_ms`, `quality_ema`
**TTL:** None (persistent)
**Warm-start:** Load all `draftly:ema:*` keys at boot
**Primary:** Redis is source of truth, PostgreSQL is backup

#### Provider Health
**Key:** `draftly:health:{provider_name}` → JSON `{status, last_failure_at, cooldown_until}`
**TTL:** 300 seconds (auto-expires after cooldown)

### 4.7 API Response Cache

**Module:** `src/draftly/integrations/api_cache.py`

FastAPI middleware caching GET responses.

| Endpoint Pattern | TTL |
|-----------------|-----|
| `/api/workflows/` | 10s |
| `/api/repositories` | 60s |
| `/api/documentation` | 30s |
| `/api/observability/` | 20s |

**Invalidation:** POST/DELETE handlers invalidate matching prefix keys.

### 4.8 Dashboard Event Broadcast (Backend → Frontend Push)

**Module:** `src/draftly/events/dashboard_broadcaster.py`

Backend broadcasts dashboard-relevant events via Redis pub/sub so the frontend can replace polling with push.

**Events broadcast:**
- `review_created` — new review pending
- `review_decided` — review approved/rejected
- `job_started` — background job began
- `job_completed` — background job finished
- `run_completed` — workflow run finished

**Redis channel:** `draftly:dashboard:{org_id}`

**Implementation:** Hook into existing event publishers (`_TeePublisher`, webhook handlers) to fan out dashboard events. Uses the shared `RedisClient`.

**New SSE endpoint:** `GET /api/events/dashboard?ticket=...` with ticket-based auth (reuses `RedisTicketStore`). Streams dashboard events as SSE frames.

### 4.9 Frontend: SWR + Dashboard Push

**Package:** `swr` (~4kB, peer dependency on React 19)

#### SWR Provider

Add `SWRProvider` to root layout with global config:
- `dedupingInterval: 5000` — dedupe identical requests within 5s
- `revalidateOnFocus: true` — refetch when tab regains focus
- `revalidateOnReconnect: true` — refetch on network recovery
- `errorRetryCount: 3` — retry failed requests 3 times

#### usePolling → useSWR Migration

Replace `usePolling` with `useSWR` in all 7 dashboard components:

| Component | Current Poll | SWR Key | SWR Config |
|-----------|-------------|---------|------------|
| `ActiveWorkflows` | 15s | `dashboard:active-jobs` | `refreshInterval: 15000` |
| `RecentSignals` | 15s | `dashboard:recent-runs` | `refreshInterval: 15000` |
| `NeedsAttention` | 20s | `dashboard:pending-reviews` | `refreshInterval: 20000` |
| `SystemPulse` | 30s | `dashboard:metrics` | `refreshInterval: 30000` |
| `QualityGates` (perf) | 60s | `dashboard:model-perf` | `refreshInterval: 60000` |
| `QualityGates` (reviews) | 30s | `dashboard:all-reviews` | `refreshInterval: 30000` |
| `AgentActivity` | 20s | `dashboard:run-steps` | `refreshInterval: 20000` |

#### useDashboardEvents Hook

Subscribes to `GET /api/events/dashboard` SSE. On receiving events, calls `mutate()` on the relevant SWR key to trigger instant revalidation:

```typescript
useDashboardEvents({
  "review_created": () => mutate("dashboard:pending-reviews"),
  "review_decided": () => { mutate("dashboard:pending-reviews"); mutate("dashboard:all-reviews"); },
  "job_started": () => mutate("dashboard:active-jobs"),
  "job_completed": () => mutate("dashboard:active-jobs"),
  "run_completed": () => { mutate("dashboard:recent-runs"); mutate("dashboard:run-steps"); },
});
```

**Fallback:** If SSE connection fails, SWR polling continues unchanged. Push is an optimization, not a requirement.

## 5. Redis Key Schema

```
draftly:ticket:{id}             → SSE auth ticket (String, TTL 60s)
draftly:ema:{task}:{model}      → EMA performance stats (Hash)
draftly:health:{provider}       → Provider cooldown (String, TTL 300s)
draftly:ratelimit:{type}:{id}   → Rate limit window (Sorted Set)
draftly:llmcache:exact:{hash}   → Exact LLM cache (String, TTL varies)
draftly:llmcache:semantic:{org} → Semantic LLM cache index (RediSearch)
draftly:vec:{org}:{item_id}     → Vector embeddings (Hash, per-org RediSearch)
draftly:stream:{run_id}         → Workflow events (Stream, MAXLEN ~1000)
draftly:apicache:{org}:{ep}     → API response cache (String, TTL 10-120s)
draftly:sse:conn:{run_id}       → Active SSE connections (Hash)
```

## 6. Configuration

New fields in `src/draftly/app/config.py`:
```python
semantic_cache_enabled: bool = True
semantic_cache_similarity_threshold: float = 0.90
semantic_cache_ttl: dict[str, int] = {
    "fast": 600, "reasoning": 1800, "documentation_generation": 3600,
    "support": 900, "evaluation": 0
}
vector_search_backend: Literal["redis", "pgvector", "dual"] = "dual"
event_bus_backend: Literal["pubsub", "stream", "dual"] = "dual"
rate_limiting_enabled: bool = True
api_cache_enabled: bool = True
```

## 7. Migration Phases

| Phase | Subsystems | Risk |
|-------|-----------|------|
| 1 | Connection + Ticket + EMA + Health | Low |
| 2 | Rate Limiting + API Cache | Low |
| 3 | Event Streams | Medium |
| 4 | Semantic Cache | Medium |
| 5 | Vector Search | High |
| 6 | Dashboard Push (backend broadcaster + SSE endpoint) | Low |
| 7 | Frontend SWR + Dashboard Push (install swr, migrate hooks, add useDashboardEvents) | Low |

## 8. Key Files

### Backend (`draftly-agent-backend`)

| File | Action | Subsystem |
|------|--------|-----------|
| `src/draftly/integrations/redis.py` | Create | Connection |
| `src/draftly/integrations/semantic_cache.py` | Create | Semantic cache |
| `src/draftly/integrations/redis_vector_search.py` | Create | Vector search |
| `src/draftly/events/redis_stream_bus.py` | Create | Event streams |
| `src/draftly/events/dashboard_broadcaster.py` | Create | Dashboard push |
| `src/draftly/integrations/rate_limiter.py` | Create | Rate limiting |
| `src/draftly/integrations/api_cache.py` | Create | API cache |
| `src/draftly/events/redis_bus.py` | Modify | Accept shared RedisClient |
| `src/draftly/app/config.py` | Modify | Add settings |
| `src/draftly/app/lifecycle.py` | Modify | Initialize subsystems |
| `src/draftly/app/api/routes/workflows.py` | Modify | Distributed TicketStore |
| `src/draftly/app/api/routes/events.py` | Modify | Add dashboard SSE endpoint |
| `src/draftly/models/performance.py` | Modify | Redis-backed EMA |
| `src/draftly/models/providers/base.py` | Modify | Semantic cache wrap |
| `docker-compose.redis.yml` | Modify | Persistence config |

### Frontend (`draftly-agent-frontend`)

| File | Action | Subsystem |
|------|--------|-----------|
| `package.json` | Modify | Add `swr` dependency |
| `app/(app)/layout.tsx` | Modify | Add `SWRProvider` |
| `hooks/use-polling.ts` | Modify | Deprecate (keep for backwards compat) |
| `hooks/use-dashboard-events.ts` | Create | SSE subscription for dashboard events |
| `components/dashboard/active-workflows.tsx` | Modify | usePolling → useSWR |
| `components/dashboard/recent-signals.tsx` | Modify | usePolling → useSWR |
| `components/dashboard/needs-attention.tsx` | Modify | usePolling → useSWR |
| `components/dashboard/system-pulse.tsx` | Modify | usePolling → useSWR |
| `components/dashboard/quality-gates.tsx` | Modify | usePolling → useSWR |
| `components/dashboard/agent-activity.tsx` | Modify | usePolling → useSWR |

## 9. Testing Strategy

- Unit tests: `fakeredis` for all Redis interactions (already in dev deps)
- Integration tests: Docker Compose Redis for E2E
- Graceful degradation tests: kill Redis, verify fallback paths
- Load tests: semantic cache hit rates under realistic workloads
- Migration tests: dual-write consistency between Redis and PostgreSQL
