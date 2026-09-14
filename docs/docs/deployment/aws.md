# AWS Deployment

> **Status:** Implemented
> **Date:** 2026-08-25
> **Scope:** Deploying Draftly agent-backend services to AWS infrastructure.

## 1. Overview

Draftly deploys as two containerized services on AWS: the **API server** (FastAPI) and the **event worker** (background job processor). Both share a common base image and connect to managed infrastructure: NeonDB (PostgreSQL), Redis, and external APIs (GitHub, Slack, Discord, LLM providers).

```mermaid
flowchart LR
    ALB["ALB"] --> API["API Container"]
    API --> NeonDB[("NeonDB")]
    API --> Redis[("Redis")]
    Worker["Worker Container"] --> Redis
    Worker --> NeonDB
    API --> GitHub["GitHub API"]
    Worker --> GitHub
    API --> LLM["LLM Providers"]
    Worker --> LLM
    API --> Slack["Slack API"]
    Worker --> Slack
```

## 2. Container Images

Draftly builds three Docker images from the `docker/` directory:

| Image | Dockerfile | Purpose | Port |
|-------|-----------|---------|------|
| Base | `docker/Dockerfile` | Shared Python 3.11 + uv environment | — |
| API | `docker/Dockerfile.api` | FastAPI server | 8000 |
| Worker | `docker/Dockerfile.worker` | Event worker process | — |

### Multi-Stage Build

All images use a two-stage build:

1. **Builder stage** — Installs dependencies with `uv sync --frozen --no-dev`.
2. **Runtime stage** — Copies only the `.venv` and `src/` directories for a minimal production image.

### Building

```bash
# Base image
docker build -f docker/Dockerfile -t draftly-base .

# API image
docker build -f docker/Dockerfile.api -t draftly-api .

# Worker image
docker build -f docker/Dockerfile.worker -t draftly-worker .
```

## 3. Infrastructure Requirements

### 3.1 Compute

| Service | Recommended | Minimum |
|---------|------------|---------|
| API | 2 vCPU, 4 GB RAM | 1 vCPU, 2 GB RAM |
| Worker | 2 vCPU, 4 GB RAM | 1 vCPU, 2 GB RAM |

The worker benefits from more memory due to concurrent agent graph execution. The `worker_concurrency` setting (default: 4) controls how many events are processed simultaneously.

### 3.2 Database (NeonDB / PostgreSQL)

- **Connection pooling:** `database_pool_min_size=2`, `database_pool_max_size=10`
- **URL format:** `postgresql://user:pass@host:5432/draftly`
- **Environment variable:** `NEON_DATABASE_URL` or `DATABASE_URL`

### 3.3 Redis

- **URL format:** `redis://host:6379/0`
- **Used for:** Event streaming, semantic cache, rate limiting, API cache, RQ job queues
- **Environment variable:** `REDIS_URL`

### 3.4 Load Balancer

- Route `/api/*` to the API container on port 8000.
- Health check endpoint: `/api/health` (or configured health path).
- No routing to the worker container (it is not HTTP-serving).

## 4. Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` / `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `GITHUB_APP_ID` | GitHub App identifier |
| `GITHUB_PRIVATE_KEY_PATH` | Path to GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook signature secret |

### LLM Providers

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (for GPT models) |
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude models) |
| `FAST_MODEL` | Model for fast tasks (default: `gpt-4.1-mini`) |
| `REASONING_MODEL` | Model for complex reasoning (default: `gpt-4.1`) |

### Slack Integration

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot user OAuth token |
| `SLACK_SIGNING_SECRET` | Request signing secret |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode |

### Discord Integration

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_PUBLIC_KEY` | Application public key |
| `DISCORD_APP_ID` | Application ID |

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Deployment environment | `development` |
| `DEBUG` | Enable debug mode | `false` |
| `HOST` | Bind address | `0.0.0.0` |
| `PORT` | Bind port | `8000` |
| `FRONTEND_URL` | Frontend application URL | `http://localhost:3000` |
| `API_KEY` | API authentication key | — |
| `LOG_LEVEL` | Logging level | `INFO` |

### Workers & Scheduler

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKER_ENABLED` | Enable background worker | `true` |
| `WORKER_CONCURRENCY` | Concurrent event processing | `4` |
| `SCHEDULER_ENABLED` | Enable cron scheduler | `true` |
| `RQ_QUEUE_PREFIX` | Redis Queue prefix | `draftly` |
| `RQ_WORKER_QUEUES` | Queues to process | `scheduled,webhooks,default` |

### Strands Runtime

| Variable | Description | Default |
|----------|-------------|---------|
| `STRANDS_GRAPH_ID` | Graph identifier | `draftly-main-graph` |
| `STRANDS_MAX_NODE_EXECUTIONS` | Max node invocations per run | `10` |
| `STRANDS_EXECUTION_TIMEOUT` | Total graph timeout (seconds) | `600` |
| `STRANDS_NODE_TIMEOUT` | Per-node timeout (seconds) | `180` |
| `STRANDS_REVIEW_POLICY` | Human review trigger | `always` |

### Security

| Variable | Description |
|----------|-------------|
| `REQUIRE_API_KEY` | Require API key authentication |
| `CLERK_PUBLISHABLE_KEY` | Clerk authentication |
| `CLERK_SECRET_KEY` | Clerk authentication |
| `CLERK_SIGNING_SECRET` | Clerk webhook verification |

## 5. Scaling Considerations

### API Service

- Scale horizontally behind the ALB.
- Each instance handles independent requests; no shared in-process state.
- Connection pooling is per-instance; adjust `database_pool_max_size` based on instance count.

### Worker Service

- Scale horizontally; Redis Queue handles job distribution.
- Each worker processes `WORKER_CONCURRENCY` events simultaneously.
- Monitor queue depth to add workers when backpressure builds.
- Agent graph execution is CPU-bound; match vCPU count to concurrency.

### Redis

- Use ElastiCache or a managed Redis instance.
- Ensure sufficient memory for pub/sub, streams, and RQ job data.
- Monitor connection count across API and worker instances.

### Database

- NeonDB handles connection pooling at the infrastructure level.
- For self-hosted PostgreSQL, use PgBouncer or similar connection pooler.
- Monitor connection count: `database_pool_max_size * instance_count` must stay below `max_connections`.

## 6. Monitoring

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| `draftly_tokens_input_total` | Prometheus | — |
| `draftly_tokens_output_total` | Prometheus | — |
| `draftly_run_ttft_ms` | Prometheus | > 5000ms |
| `draftly_limit_hits_total` | Prometheus | > 0 (indicates budget exhaustion) |
| Worker queue depth | RQ Dashboard | > 100 pending jobs |
| API response time | ALB metrics | p99 > 2s |
| Database connections | NeonDB dashboard | > 80% pool utilization |

## 7. File Reference

- `docker/Dockerfile` — Base image
- `docker/Dockerfile.api` — API image
- `docker/Dockerfile.worker` — Worker image
- `src/draftly/app/config.py` — All configuration variables
- `pyproject.toml` — Python dependencies
- `uv.lock` — Locked dependency versions
