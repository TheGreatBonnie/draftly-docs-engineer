# CockroachDB / PostgreSQL Setup

> **Status:** Implemented
> **Date:** 2026-08-25
> **Scope:** Database provisioning, connection configuration, migration execution, schema overview, and performance tuning for Draftly Agent Backend

## 1. Overview

Draftly Agent Backend connects to a **NeonDB** (managed PostgreSQL) instance using **asyncpg** as the async driver. The database schema is defined across 32 sequential SQL migrations and includes the `vector` extension (pgvector) for semantic search. The system is compatible with both standard PostgreSQL and CockroachDB, though the current deployment targets NeonDB.

## 2. Connection Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes (fallback) | Full PostgreSQL connection string |
| `NEON_DATABASE_URL` | No (preferred) | NeonDB-specific connection string |

Resolution order: explicit constructor arg > `NEON_DATABASE_URL` > `DATABASE_URL`.

### Connection Pool Settings

| Parameter | Default | Description |
|---|---|---|
| `pool_min_size` | 2 | Minimum idle connections |
| `pool_max_size` | 10 | Maximum total connections |
| `command_timeout` | 30 | Per-query timeout (seconds) |

The pool is lazily initialized on first database operation. The `DatabaseClient.start()` method creates the asyncpg pool; `close()` drains it.

### Connection String Format

```
postgresql://user:password@host:port/database?sslmode=require
```

NeonDB requires `sslmode=require`. For local development, omit SSL or use `sslmode=disable`.

## 3. Running Migrations

Migrations are plain SQL files under `src/draftly/persistence/migrations/`. They are designed to be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### Apply All Migrations

Apply migrations in numbered order (001 through 032):

```bash
# Using psql directly
for f in src/draftly/persistence/migrations/[0-3]*.sql; do
  psql "$DATABASE_URL" -f "$f"
done

# Or using the application's migration runner (if available)
python -m draftly.persistence.migrate
```

### Verify Migration State

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

### Adding a New Migration

1. Create a file named `033_<description>.sql` in `src/draftly/persistence/migrations/`
2. Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency
3. Reference `organizations(clerk_org_id)` for tenant isolation where needed

## 4. Schema Overview

The schema spans approximately 25 tables across these domains:

### Tenant

| Table | Purpose |
|---|---|
| `organizations` | Multi-tenant organizations (Clerk-based auth) |

### Memory

| Table | Purpose |
|---|---|
| `memory_items` | Core memory records with importance, confidence, versioning |
| `memory_embeddings` | Vector embeddings (1536-dim) linked to memory items |
| `memory_sources` | Provenance: source type, URL, commit SHA, content hash |
| `memory_links` | Graph edges between memory items |
| `memory_feedback` | User/agent feedback scores |
| `memory_access_log` | Retrieval audit trail (query, similarity, rank) |
| `memory_consolidations` | Merge/dedup/summarize operation log |
| `memory_candidates` | Outbox table for pending memory operations |

### Documentation

| Table | Purpose |
|---|---|
| `documentation` | Synced documentation content with quality flags |
| `knowledge_nodes` | Knowledge graph nodes (code, concept, doc, eval) |
| `doc_edges` | Knowledge graph edges (IMPLEMENTS, DOCUMENTED_BY, etc.) |

### Events

| Table | Purpose |
|---|---|
| `events` | GitHub event log with idempotency |
| `workflow_events` | Durable SSE event log for replay |
| `episodes` | Agent run episodes with embeddings |

### Operations

| Table | Purpose |
|---|---|
| `jobs` | Background job scheduler |
| `agent_runs` | Agent run audit trail |
| `agent_steps` | Per-step execution log within a run |
| `reviews` | Human-in-the-loop review requests |
| `evaluations` | Evaluation results with metrics |
| `procedures` | Reusable procedure patterns with embeddings |

### Delivery

| Table | Purpose |
|---|---|
| `delivery_plans` | Delivery plan records |
| `delivery_commits` | Git commit records |
| `delivery_pull_requests` | Pull request records |

### Integrations

| Table | Purpose |
|---|---|
| `github_installations` | GitHub App installation records |
| `github_workflows` | GitHub workflow tracking |
| `slack_installations` | Slack workspace installations |
| `slack_workflows` | Slack workflow tracking |
| `discord_workflows` | Discord workflow tracking |

### Routing

| Table | Purpose |
|---|---|
| `routing_decisions` | LLM routing decision log |
| `model_performance` | Per-model/per-task aggregate stats |

### User & Configuration

| Table | Purpose |
|---|---|
| `reviewers` | Reviewer profiles with notification preferences |
| `onboarding_state` | Per-org onboarding state machine |
| `repositories` | Connected repository configuration |
| `support_threads` | Support conversation threads |
| `support_messages` | Support messages within threads |

## 5. Vector Search Setup (pgvector)

### Enable the Extension

The `vector` extension is created by migration 003:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Vector Tables

Three tables store vector embeddings, all using `vector(1536)`:

| Table | Column | Index |
|---|---|---|
| `memory_embeddings` | `embedding` | HNSW cosine |
| `episodes` | `embedding` | HNSW cosine |
| `procedures` | `embedding` | HNSW cosine |

### HNSW Index Creation

```sql
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_vector
ON memory_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_episodes_embedding
ON episodes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_procedures_embedding
ON procedures USING hnsw (embedding vector_cosine_ops);
```

### Search Query Pattern

```sql
SELECT *, 1 - (embedding <=> $1::VECTOR) AS similarity
FROM memory_embeddings me
JOIN memory_items mi ON mi.id = me.memory_item_id
WHERE mi.namespace = $2 AND mi.status = 'active'
ORDER BY embedding <=> $1::VECTOR
LIMIT $3;
```

The `<=>` operator computes cosine distance; `1 - distance` gives similarity.

## 6. Performance Considerations

### Indexes

The schema includes targeted indexes for common query patterns:
- Org-scoped lookups on most tables (`idx_*_org`)
- Status-filtered partial indexes (`idx_memory_candidates_pending`, `idx_reviews_pending`)
- Time-ordered indexes for event/review listing
- HNSW vector indexes for approximate nearest-neighbor search

### Connection Pool Tuning

For production workloads:
- Increase `pool_max_size` if running concurrent agent workflows
- Monitor connection usage via `SHOW STATISTICS` or pg_stat_activity
- NeonDB scales compute automatically; connection limits depend on plan tier

### Query Patterns

- **Parameterized queries:** All SQL uses `$1`, `$2`, ... placeholders (asyncpg native format)
- **Transactions:** Multi-statement writes (e.g., memory insert + embedding) use explicit `conn.transaction()` blocks
- **Batch operations:** `memory_candidates` uses `FOR UPDATE SKIP LOCKED` for safe concurrent claim
- **Upserts:** `ON CONFLICT DO UPDATE` for idempotent writes (events, workflows, routing stats)

### NeonDB Specifics

- NeonDB provides automatic scaling and branching
- Connection pooling is handled at the NeonDB proxy level; the application pool connects to the proxy
- Use `neon.tech` endpoint with SSL for production

## File Reference

- `src/draftly/integrations/database/client.py` — DatabaseClient
- `src/draftly/integrations/database/vector_search.py` — VectorSearch
- `src/draftly/persistence/migrations/` — All 32 migration files
- `src/draftly/persistence/stores/routing.py` — Routing/performance stores
