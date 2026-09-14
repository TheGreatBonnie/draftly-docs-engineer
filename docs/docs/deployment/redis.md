# Redis Deployment Guide

> **Date:** 2026-08-25
> **Scope:** Production setup, persistence, monitoring, and failure recovery

## 1. Prerequisites

- Redis 7.x+ (or Valkey 7.x+ compatible)
- `redis-py` (Python client installed through `pyproject.toml`)
- RediSearch module when enabling Redis semantic cache or vector search; the plain-Redis setup below uses pgvector instead

## 2. Quick Start (Local)

```bash
# Start Redis with RediSearch via Docker
docker run -d \
  --name draftly-redis \
  -p 6379:6379 \
  -v draftly-redis-data:/data \
  redis/redis-stack-server:latest

# Verify
redis-cli ping
# => PONG
```

## 3. Configuration

All Redis settings are in `src/draftly/app/config.py`. Required environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection string |
| `SEMANTIC_CACHE_ENABLED` | `True` | Enable LLM semantic cache |
| `SEMANTIC_CACHE_SIMILARITY_THRESHOLD` | `0.90` | Min similarity for cache hit |
| `VECTOR_SEARCH_BACKEND` | `"dual"` | `redis`, `pgvector`, or `dual` |
| `EVENT_BUS_BACKEND` | `"dual"` | `pubsub`, `stream`, or `dual` |
| `RATE_LIMITING_ENABLED` | `True` | Enable rate limiting |
| `API_CACHE_ENABLED` | `True` | Enable API response cache |

### Single DB with Prefix

Draftly uses **one Redis database** (`db 0`) with the `draftly:` prefix on all keys. This is simpler than multi-DB and avoids the `SELECT` command overhead.

## 4. Persistence

### 4.1 Docker Compose (Recommended)

```yaml
# docker-compose.redis.yml
services:
  redis:
    image: redis/redis-stack-server:latest
    ports:
      - "6379:6379"
    volumes:
      - draftly-redis-data:/data
    command: >
      redis-server
      --appendonly yes
      --appendfsync everysec
      --save 60 1000
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  draftly-redis-data:
```

Start with:
```bash
docker compose -f docker-compose.redis.yml up -d
```

### 4.2 Persistence Settings

| Setting | Value | Rationale |
|---------|-------|-----------|
| `appendonly yes` | AOF enabled | Crash recovery |
| `appendfsync everysec` | Balanced durability | Good performance + safety |
| `save 60 1000` | RDB snapshot | Every 60s if 1000+ keys changed |
| `maxmemory 512mb` | Memory limit | Prevent OOM |
| `maxmemory-policy allkeys-lru` | Evict least-recently-used | Semantic cache is most evictable |

## 5. Production Setup

### 5.1 AWS ElastiCache

```bash
# Create Redis cluster
aws elasticache create-cache-cluster \
  --cache-cluster-id draftly-redis \
  --engine redis \
  --engine-version 7.1 \
  --cache-node-type cache.t3.micro \
  --num-cache-nodes 1 \
  --vpc-security-group-ids sg-xxxxx \
  --subnet-group-name draftly-redis

# Set environment variable
export REDIS_URL="redis://draftly-redis.xxxxx.0001.use1.cache.amazonaws.com:6379/0"
```

### 5.2 GCP Memorystore

```bash
gcloud redis instances create draftly-redis \
  --size=1 \
  --region=us-central1 \
  --redis-version=redis_7_1 \
  --tier=basic
```

### 5.3 Azure Cache for Redis

```bash
az redis create \
  --name draftly-redis \
  --resource-group draftly-rg \
  --location eastus \
  --sku Basic \
  --vm-size C0
```

## 6. Monitoring

### 6.1 Health Check Endpoint

```bash
curl http://localhost:8000/api/health
# Returns: {"redis": "connected", "postgres": "connected"}
```

### 6.2 Redis CLI Diagnostics

```bash
# Connection count
redis-cli INFO clients | grep connected_clients

# Memory usage
redis-cli INFO memory | grep used_memory_human

# Key count by prefix
redis-cli --scan --count 100 | grep "^draftly:" | cut -d: -f1-2 | sort | uniq -c | sort -rn

# Stream info
redis-cli XINFO STREAM draftly:stream:{run_id}

# Vector index stats
redis-cli FT.INFO draftly:llmcache:semantic:*
```

### 6.3 Key Metrics to Watch

| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| `connected_clients` | > 100 | > 500 |
| `used_memory_human` | > 400MB | > 500MB (at limit) |
| `instantaneous_ops_per_sec` | > 10000 | > 50000 |
| `rejected_connections` | > 0 | > 0 sustained |
| `evicted_keys` | > 0 | > 1000/min |

## 7. Failure Recovery

### 7.1 Redis Outage

**Impact:** All subsystems fall back to graceful degradation (see [architecture/redis.md](../architecture/redis.md#5-graceful-degradation)).

**Recovery steps:**
1. Redis restarts or becomes available
2. `RedisClient` reconnects automatically (connection pool)
3. Subsystems resume normal operation
4. Semantic cache rebuilds naturally (no warm-up needed)
5. EMA stats reload from PostgreSQL on next request

### 7.2 Memory Pressure

```bash
# Check what's using memory
redis-cli MEMORY USAGE draftly:llmcache:semantic:org_123
redis-cli MEMORY USAGE draftly:vec:org_123:*

# Force eviction of semantic cache
redis-cli DEL draftly:llmcache:semantic:org_*

# Check eviction policy
redis-cli CONFIG GET maxmemory-policy
```

### 7.3 Vector Index Corruption

```bash
# Drop and recreate a semantic cache index
redis-cli FT.DROPINDEX draftly:llmcache:semantic:org_123

# The index is recreated automatically on next cache write
```

### 7.4 Stream Consumer Cleanup

```bash
# List consumers for a run
redis-cli XINFO CONSUMERS draftly:stream:run_123 consumer_group_1

# Delete a specific consumer
redis-cli XGROUP DELCONSUMER draftly:stream:run_123 consumer_group_1 consumer_abc
```

## 8. Backup

### 8.1 RDB Snapshot

```bash
# Force a snapshot
redis-cli BGSAVE

# Copy to S3
aws s3 cp /data/dump.rdb s3://draftly-backups/redis/dump-$(date +%Y%m%d).rdb
```

### 8.2 AOF Backup

```bash
# Rewrite AOF for smaller file
redis-cli BGREWRITEAOF

# Copy to S3
aws s3 cp /data/appendonly.aof s3://draftly-backups/redis/aof-$(date +%Y%m%d).aof
```

## 9. Security

- **TLS:** Enable in production (`--tls-port 6380 --port 0`)
- **ACL:** Create a Draftly-specific user with `draftly:*` key pattern permissions
- **Network:** Redis should NOT be exposed to public internet
- **Authentication:** Use `--requirepass` or Redis ACL in production

```bash
# Create a restricted user
redis-cli ACL SETUSER draftly on >your-strong-password ~draftly:* +@all -DEBUG -CONFIG
```

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Connection refused` | Redis not running | `docker compose up -d redis` |
| `DENIED Redis is running in protected mode` | No bind address | Add `--bind 0.0.0.0` or set password |
| `OOM command not allowed` | Memory limit reached | Increase `maxmemory` or tune eviction |
| `NOGROUP No such key` | Stream expired or deleted | Recreate stream (handled by app) |
| Slow `FT.SEARCH` | Large vector index | Increase RediSearch memory or shard |

## 11. Compose and RQ worker alternatives

Run these commands from the backend directory. The [README](../../README.md#run-draftly) recommends native API and RQ processes with Redis in Docker.

The checked-in [Compose file](../../docker-compose.redis.yml) uses `redis:7-alpine`, which supports queues and streams but does **not** include RediSearch. For that image, set `VECTOR_SEARCH_BACKEND=pgvector` and `SEMANTIC_CACHE_ENABLED=false` in the native processes' `.env`. The Redis Stack example above is an alternative when you need Redis vector search or semantic caching; do not start both examples on port 6379.

Start just the Redis dependency:

```bash
docker compose -f docker-compose.redis.yml up -d redis
```

For containerized queue consumption, the Compose file also defines `rq-worker`:

```bash
docker compose -f docker-compose.redis.yml up -d
```

That worker reads `.env`, overrides `REDIS_URL` to `redis://redis:6379/0`, and waits for the Redis health check. Configure the same pgvector/cache settings for plain Redis. This command does not start the API.

The current [worker Dockerfile](../../docker/Dockerfile.worker) copies the local `secrets/` directory into the image. Compose sets `GITHUB_PRIVATE_KEY_PATH=secrets/private-key.pem`; make the configured key available for GitHub App operations. A mounted key alone does not remove a key already baked into an image. Treat such an image as sensitive and do not publish it. Native workers avoid this container packaging issue.

To build and run a standalone worker locally with a read-only key mount:

```bash
docker build -f docker/Dockerfile.worker -t draftly-worker .
docker run --rm --env-file .env \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -e GITHUB_PRIVATE_KEY_PATH=/run/secrets/private-key.pem \
  -v "$PWD/secrets/private-key.pem:/run/secrets/private-key.pem:ro" \
  draftly-worker
```

On macOS and Windows, `host.docker.internal` addresses a service running on the host. A container's `localhost` addresses that container; this applies to `DATABASE_URL` as well as Redis. Configure the database hostname accordingly. Linux host access requires an appropriate host gateway or network configuration.

The worker consumes the `scheduled`, `webhooks`, and `default` queues. This guide does not establish that periodic jobs have been registered merely because a worker is running. Container commands were inspected against the files but were not built or started during the README review.
