# Redis Queue Integration Design

**Date:** 2026-08-26
**Status:** Approved
**Approach:** Standard RQ with sync wrappers (Approach A)

---

## 1. Problem Statement

The current background job system uses a custom in-process `DraftlyScheduler` that polls an in-memory job registry every 30s. This has several limitations:

- **No persistence:** Jobs are lost if the worker process crashes
- **No retry:** Failed jobs are logged and re-raised with no automatic retry
- **No distributed processing:** Single-process, single-threaded execution
- **No progress tracking:** Frontend `GET /jobs` returns only `{ job_id }` — no status, progress, or error details
- **Stubbed scheduler:** `build_scheduler_client()` returns `None`, meaning the cron polling loop has no jobs

Redis is already in the stack (event bus, rate limiting, caching) but is not used as a job queue broker.

## 2. Goals

1. **Reliability:** Jobs survive process restarts, automatic retry with exponential backoff
2. **Scalability:** Multiple worker processes can consume from the same queues
3. **Observability:** Rich job status tracking for frontend polling (status, progress, error, retry count)
4. **Simplicity:** Minimal new infrastructure — leverage existing Redis instance

## 3. Non-Goals

- Horizontal worker scaling (future enhancement, not in initial scope)
- Job prioritization beyond queue-level separation (future enhancement)
- Real-time job progress via SSE (reuse existing `useWorkflowEvents` hook where needed)

## 4. Architecture

```
                    ┌─────────────────────────────────────┐
                    │         Webhook Entrypoints          │
                    │  (GitHub, Slack, Discord webhooks)   │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │        WorkflowRunner (run.py)       │
                    │  - Idempotency claim (DB)            │
                    │  - Enqueue to RQ "webhooks" queue    │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Redis (Queues + Broker)                        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  "scheduled"  │  │  "webhooks"   │  │  "default"   │              │
│  │  queue        │  │  queue        │  │  queue       │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┼──────────────────┘                       │
│                            │                                          │
│  ┌─────────────────────────▼──────────────────────────────────────┐  │
│  │              rq-scheduler (cron scheduling)                     │  │
│  │  Enqueues to "scheduled" queue based on cron expressions       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    RQ Worker (single process)                         │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  DraftlyWorker (worker.py)                                    │   │
│  │  - Wraps TaskRunner as RQ job functions                       │   │
│  │  - Provides sync wrappers for async workflows                 │   │
│  │  - Manages RQ worker lifecycle                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Queues consumed: scheduled (high), webhooks (high), default (low)  │
│  Retry: 3 attempts, exponential backoff                              │
│  DLQ: FailedJobRegistry → admin review                               │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │      Postgres (jobs table)           │
                    │  - Status sync from RQ               │
                    │  - Progress tracking                 │
                    │  - Frontend polling endpoint          │
                    └─────────────────────────────────────┘
```

## 5. Queue Design

Three queues with clear separation of concerns:

| Queue | Purpose | Priority | Retry | TTL |
|-------|---------|----------|-------|-----|
| `scheduled` | Cron-triggered background jobs | High | 3 attempts, exponential backoff (10s, 30s, 60s) | 24h |
| `webhooks` | Event-driven workflow jobs (GitHub, Slack, Discord) | High | 2 attempts, linear backoff (15s, 30s) | 1h |
| `default` | On-demand jobs (API `POST /jobs/run`) | Low | 1 attempt (no retry) | 30min |

### Job Serialization

Each RQ job stores:

```python
{
    "task_name": str,          # e.g., "documentation.sync"
    "kwargs": dict,            # workflow arguments
    "org_id": str | None,      # multi-tenant isolation
    "enqueued_at": str,        # ISO timestamp
    "job_id": str,             # UUID for idempotency
}
```

### Queue Routing

| Task Name | Queue |
|-----------|-------|
| `documentation.sync` | `scheduled` |
| `documentation.sync_repository` | `scheduled` |
| `documentation.stale_scan` | `scheduled` |
| `support.gap_scan` | `scheduled` |
| `evaluation.loop` | `scheduled` |
| `memory.curation` | `scheduled` |
| `memory.maintenance` | `scheduled` |
| `onboarding.initialize` | `default` |
| `github_pr` | `webhooks` |
| `github_release` | `webhooks` |
| `github_issue` | `webhooks` |
| `slack_support` | `webhooks` |
| `discord_support` | `webhooks` |

### Dead Letter Queue

RQ's `FailedJobRegistry` captures permanently failed jobs. Failed jobs are also synced to the Postgres `jobs` table with `status=failed` and `error` populated.

## 6. Worker Architecture

### Single RQ Worker Process

```python
# workers/rq_worker.py (new entrypoint)
"""RQ worker entrypoint.

Runs a single RQ worker consuming from all three queues.
Replaces workflow_worker.py, indexing_worker.py, and evaluation_worker.py.

Usage:
    python -m workers.rq_worker
"""
from rq import Queue, SimpleWorker
from rq_scheduler import Scheduler

# RQ is sync, so we use SimpleWorker (no fork)
# Each job runs in the worker's process with its own event loop
```

### Sync Wrapper Pattern

Each async workflow function gets a sync wrapper that creates/reuses an event loop:

```python
def make_sync_handler(async_handler):
    """Wrap an async handler for RQ's sync execution model."""
    def sync_handler(*args, **kwargs):
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(async_handler(*args, **kwargs))
        finally:
            loop.close()
    return sync_handler
```

### Entrypoint Changes

| Entrypoint | Current | After RQ |
|------------|---------|----------|
| `workers/workflow_worker.py` | Custom scheduler loop | **Removed** — replaced by `rq_worker.py` |
| `workers/indexing_worker.py` | Custom interval loop | **Removed** — replaced by scheduled job via rq-scheduler |
| `workers/evaluation_worker.py` | Custom interval loop | **Removed** — replaced by scheduled job via rq-scheduler |
| `workers/rq_worker.py` | N/A | **New** — main RQ worker entrypoint |
| `workers/event_worker.py` | FastAPI app | **Unchanged** — still runs webhook handlers |

## 7. Job Registration

### Current

`TaskRunner.register(name, handler)` maps task names to async handlers. `composition/workers.py` builds the runner with `TASK_REGISTRY`.

### After RQ

Task handlers are registered as RQ job functions. The `TASK_REGISTRY` dict stays the same, but instead of calling `task_runner.run()`, we `queue.enqueue()`.

```python
# composition/rq_jobs.py (new)
from rq import Queue
from rq.decorators import job

QUEUE_MAP = {
    "documentation.sync": "scheduled",
    "documentation.sync_repository": "scheduled",
    "documentation.stale_scan": "scheduled",
    "support.gap_scan": "scheduled",
    "evaluation.loop": "scheduled",
    "memory.curation": "scheduled",
    "memory.maintenance": "scheduled",
    "onboarding.initialize": "default",
    "github_pr": "webhooks",
    "github_release": "webhooks",
    "github_issue": "webhooks",
    "slack_support": "webhooks",
    "discord_support": "webhooks",
}

def get_queue_for_task(task_name: str) -> str:
    return QUEUE_MAP.get(task_name, "default")

def enqueue_job(queue_name: str, task_name: str, **kwargs):
    """Enqueue a task to the appropriate RQ queue."""
    q = Queue(queue_name, connection=redis_conn)
    job = q.enqueue(
        make_sync_handler(TASK_HANDLERS[task_name]),
        kwargs=kwargs,
        job_id=str(uuid4()),
        retry=Retry(max=3, interval=[10, 30, 60]),
        ttl=3600,
        meta={"task_name": task_name, "enqueued_at": datetime.utcnow().isoformat()},
    )
    return job
```

## 8. Scheduling (rq-scheduler)

### Current

`DraftlyScheduler` polls every 30s using `croniter` to find due jobs.

### After RQ

`rq-scheduler` manages cron schedules directly in Redis. On startup, it schedules all cron jobs. No polling loop needed.

```python
# composition/scheduler.py (new)
from rq_scheduler import Scheduler

def setup_rq_scheduler(scheduler: Scheduler):
    """Register all cron jobs with rq-scheduler."""
    for job_def in SCHEDULED_JOBS:
        scheduler.cron(
            job_def["schedule"],
            func=make_sync_handler(TASK_HANDLERS[job_def["name"]]),
            kwargs=job_def.get("arguments", {}),
            queue_name="scheduled",
            id=job_def["id"],
        )
```

### SCHEDULED_JOBS

Stays the same as current `composition/workers.py:75-112`:

```python
SCHEDULED_JOBS = [
    {"id": "documentation-sync", "name": "documentation.sync", "schedule": "0 2 * * *", "arguments": {}},
    {"id": "stale-docs-scan", "name": "documentation.stale_scan", "schedule": "0 3 * * 0", "arguments": {}},
    {"id": "support-gap-scan", "name": "support.gap_scan", "schedule": "0 4 * * *", "arguments": {}},
    {"id": "evaluation-loop", "name": "evaluation.loop", "schedule": "0 5 * * *", "arguments": {}},
    {"id": "memory-curation", "name": "memory.curation", "schedule": "*/30 * * * *", "arguments": {}},
    {"id": "memory-maintenance", "name": "memory.maintenance", "schedule": "0 6 * * 0", "arguments": {}},
]
```

## 9. API Changes

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/jobs` | GET | List active jobs (from RQ + Postgres sync) |
| `GET /api/jobs/:job_id` | GET | Get job detail (status, progress, result, error) |
| `POST /api/jobs/:job_id/cancel` | POST | Cancel a queued/started job |

### Modified Endpoint

`POST /api/jobs/run` changes from synchronous to async enqueue:

```python
@router.post("/run")
async def run_job(body: JobRequest, request: Request):
    application = request.app.state.draftly
    job = enqueue_job(application.rq_queue, body.job_name, **body.arguments)
    return {"status": "queued", "job_id": job.id}
```

**Response change:** Currently returns `{ status: "completed", result: ... }`. After RQ, returns `{ status: "queued", job_id: "..." }`.

## 10. Frontend Integration

### New Type

```typescript
export type JobStatus = {
  job_id: string;
  task_name: string;
  status: "queued" | "started" | "finished" | "failed";
  enqueued_at: string;
  started_at?: string;
  completed_at?: string;
  result?: unknown;
  error?: string;
  attempts: number;
};
```

### API Changes

```typescript
// api/observability.ts
export async function getJobStatus(jobId: string): Promise<JobStatus> {
  return request<JobStatus>(`/jobs/${jobId}`);
}

export async function listActiveJobs(): Promise<JobStatus[]> {
  return request<JobStatus[]>('/jobs');
}
```

### Component Updates

| Component | Change |
|-----------|--------|
| `ActiveWorkflows` | Polls `GET /jobs` (already does this, richer data now) |
| `AgentActivity` | Can show job progress from RQ metadata |
| `InitializePage` | Polls `GET /api/jobs/:job_id` instead of SSE for onboarding status |

## 11. Postgres Sync

Job status changes are synced from RQ to the existing `jobs` table:

- **On enqueue:** `INSERT INTO jobs (job_id, status='pending', ...)`
- **On start:** `UPDATE jobs SET status='active', started_at=... WHERE job_id=...`
- **On finish:** `UPDATE jobs SET status='completed', completed_at=..., result=... WHERE job_id=...`
- **On failure:** `UPDATE jobs SET status='failed', error=..., attempts=... WHERE job_id=...`

This keeps the Postgres `jobs` table as the source of truth for frontend polling, while RQ handles execution.

## 12. Configuration

### New Settings

```python
# config.py additions
rq_queue_prefix: str = "draftly"  # Redis key prefix for RQ queues
rq_scheduler_enabled: bool = True
rq_worker_queues: list[str] = ["scheduled", "webhooks", "default"]
```

### Dependencies

```toml
# pyproject.toml additions
"rq>=1.16.0",
"rq-scheduler>=0.10.0",
```

## 13. Migration Path

| Step | Description | Files |
|------|-------------|-------|
| 1 | Add `rq` and `rq-scheduler` to dependencies | `pyproject.toml` |
| 2 | Create `composition/rq_jobs.py` with job registration and enqueue functions | `src/draftly/app/composition/rq_jobs.py` |
| 3 | Create `workers/rq_worker.py` entrypoint | `workers/rq_worker.py` |
| 4 | Modify `POST /jobs/run` to enqueue instead of execute synchronously | `src/draftly/app/api/routes/jobs.py` |
| 5 | Add `GET /jobs` and `GET /jobs/:job_id` endpoints | `src/draftly/app/api/routes/jobs.py` |
| 6 | Update frontend `api/observability.ts` and `ActiveWorkflows` component | `draftly-agent-frontend/api/observability.ts`, `components/dashboard/active-workflows.tsx` |
| 7 | Remove `DraftlyScheduler`, `SchedulerClientAdapter`, `indexing_worker.py`, `evaluation_worker.py` | `src/draftly/app/workers/scheduler.py`, `src/draftly/app/workers/scheduler_adapter.py`, `workers/indexing_worker.py`, `workers/evaluation_worker.py` |
| 8 | Update Docker Compose to run RQ worker | `docker/docker-compose.yml` |

**No breaking changes:** The `TASK_REGISTRY` and workflow functions stay the same. Only the execution layer changes.

## 14. Testing Strategy

- **Unit tests:** Mock RQ connection, test `enqueue_job()`, `get_queue_for_task()`, sync wrapper
- **Integration tests:** Use `fakeredis` (already in dev deps) to test job enqueue/dequeue cycle
- **E2E tests:** Run RQ worker in test mode, enqueue a job, verify it completes and syncs to Postgres

## 15. Rollback Plan

If RQ integration causes issues:
1. Revert `POST /jobs/run` to synchronous execution
2. Re-enable `DraftlyScheduler` (code stays in git)
3. Remove `rq` and `rq-scheduler` from dependencies
4. Frontend falls back to existing polling behavior

## 16. Future Enhancements

- **Horizontal scaling:** Run multiple RQ worker processes across machines
- **Job prioritization:** Add priority levels within queues
- **Real-time progress:** Stream job progress via SSE (reuse existing `useWorkflowEvents`)
- **Job chaining:** Chain dependent jobs (e.g., sync → audit → evaluate)
- **Admin dashboard:** RQ Dashboard for monitoring queues and failed jobs
