# RQ Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom in-process DraftlyScheduler with Redis Queue (RQ) for reliable, observable, and retry-capable background job execution.

**Architecture:** RQ replaces the scheduler and task runner. Jobs are enqueued to Redis queues (scheduled, webhooks, default), executed by RQ workers with retry/DLQ support. Postgres `jobs` table stays as the source of truth for frontend polling.

**Tech Stack:** Python 3.11, rq>=1.16.0, rq-scheduler>=0.10.0, redis>=5.0.0 (existing), FastAPI, asyncpg

**Spec:** `docs/superpowers/specs/2026-08-26-rq-integration-design.md`

## Global Constraints

- Python >=3.11
- redis>=5.0.0 (existing dependency)
- structlog for logging
- pydantic-settings for config
- asyncio_mode = "auto" for pytest
- RQ is synchronous — all async workflow functions need sync wrappers
- Postgres `jobs` table (migration 013) is the source of truth for frontend polling
- No breaking changes to existing workflow functions — only the execution layer changes

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `pyproject.toml` | Modify | Add rq, rq-scheduler dependencies |
| `src/draftly/app/config.py` | Modify | Add RQ configuration settings |
| `src/draftly/integrations/redis.py` | Modify | Add RQ connection helper |
| `src/draftly/app/workers/async_sync.py` | Create | Sync wrapper utility for async handlers |
| `src/draftly/app/composition/rq_jobs.py` | Create | Job registry, queue routing, enqueue function |
| `src/draftly/app/composition/rq_scheduler.py` | Create | rq-scheduler setup for cron jobs |
| `src/draftly/app/api/routes/jobs.py` | Modify | Async enqueue + new GET endpoints |
| `workers/rq_worker.py` | Create | RQ worker entrypoint |
| `tests/test_workers/test_async_sync.py` | Create | Tests for sync wrapper |
| `tests/test_workers/test_rq_jobs.py` | Create | Tests for job registry and enqueue |

---

### Task 1: Add Dependencies and Configuration

**Files:**
- Modify: `pyproject.toml:7-40`
- Modify: `src/draftly/app/config.py:160-170`

**Interfaces:**
- Consumes: None (foundational task)
- Produces: `Settings` with RQ fields, installed packages

- [ ] **Step 1: Add rq and rq-scheduler to pyproject.toml**

In `pyproject.toml`, add to the `dependencies` list (after line 39, `"redis>=5.0.0",`):

```toml
    "rq>=1.16.0",
    "rq-scheduler>=0.10.0",
```

- [ ] **Step 2: Add RQ settings to config.py**

In `src/draftly/app/config.py`, add after the `scheduler_enabled` field (line 170):

```python
    # ------------------------------------------------------------------
    # Redis Queue (RQ)
    # ------------------------------------------------------------------

    rq_queue_prefix: str = "draftly"
    rq_scheduler_enabled: bool = True
    rq_worker_queues: list[str] = ["scheduled", "webhooks", "default"]
```

- [ ] **Step 3: Install dependencies**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && pip install rq rq-scheduler`

- [ ] **Step 4: Verify installation**

Run: `python -c "import rq; import rq_scheduler; print(f'rq={rq.VERSION}, rq-scheduler OK')"`

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml src/draftly/app/config.py
git commit -m "feat: add rq and rq-scheduler dependencies and config"
```

---

### Task 2: Add RQ Connection to Redis Client

**Files:**
- Modify: `src/draftly/integrations/redis.py:12-42`

**Interfaces:**
- Consumes: Existing `RedisClient` class, `redis.asyncio` connection
- Produces: `RedisClient.rq_connection` property returning sync `redis.Redis` for RQ

- [ ] **Step 1: Add RQ connection property**

In `src/draftly/integrations/redis.py`, add after the `pipeline` method (line 35):

```python
    @property
    def rq_connection(self) -> Any:
        """Synchronous redis.Redis for RQ (RQ requires sync connection)."""
        import redis as sync_redis
        return sync_redis.Redis.from_url(
            self._client.connection_pool.connection_kwargs.get("host", "localhost")
            if hasattr(self._client, "connection_pool")
            else "redis://localhost:6379/0",
            decode_responses=True,
        )
```

- [ ] **Step 2: Add sync connection method**

RQ requires a plain sync `redis.Redis`. Add this method to `RedisClient`:

```python
    def get_rq_connection(self) -> Any:
        """Create a synchronous redis.Redis for RQ workers."""
        import redis as sync_redis
        kwargs = self._client.connection_pool.connection_kwargs
        return sync_redis.Redis(
            host=kwargs.get("host", "localhost"),
            port=kwargs.get("port", 6379),
            db=kwargs.get("db", 0),
            decode_responses=True,
        )
```

- [ ] **Step 3: Commit**

```bash
git add src/draftly/integrations/redis.py
git commit -m "feat: add RQ sync connection helper to RedisClient"
```

---

### Task 3: Create Sync Wrapper Utility

**Files:**
- Create: `src/draftly/app/workers/async_sync.py`
- Create: `tests/test_workers/test_async_sync.py`

**Interfaces:**
- Consumes: Async callable (`Callable[..., Awaitable[Any]]`)
- Produces: `make_sync_handler(async_handler) -> sync_handler`

- [ ] **Step 1: Write the failing test**

Create `tests/test_workers/test_async_sync.py`:

```python
"""Tests for the async-to-sync wrapper utility."""

from __future__ import annotations

import asyncio

from draftly.app.workers.async_sync import make_sync_handler


async def _async_add(a: int, b: int) -> int:
    return a + b


async def _async_raises() -> None:
    raise ValueError("boom")


class TestMakeSyncHandler:
    def test_wraps_async_function(self):
        handler = make_sync_handler(_async_add)
        result = handler(2, 3)
        assert result == 5

    def test_preserves_exception(self):
        handler = make_sync_handler(_async_raises)
        import pytest
        with pytest.raises(ValueError, match="boom"):
            handler()

    def test_returns_new_event_loop_each_call(self):
        handler = make_sync_handler(_async_add)
        r1 = handler(1, 2)
        r2 = handler(3, 4)
        assert r1 == 3
        assert r2 == 7
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_workers/test_async_sync.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'draftly.app.workers.async_sync'`

- [ ] **Step 3: Write minimal implementation**

Create `src/draftly/app/workers/async_sync.py`:

```python
"""Async-to-sync wrapper for RQ job execution.

RQ executes jobs synchronously. This module wraps async workflow
handlers so they can be called from RQ workers.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any


def make_sync_handler(
    async_handler: Callable[..., Awaitable[Any]],
) -> Callable[..., Any]:
    """Wrap an async handler for RQ's sync execution model.

    Each call creates a fresh event loop, runs the async handler,
    and closes the loop. This avoids event loop reuse issues across
    RQ job invocations.
    """

    def sync_handler(*args: Any, **kwargs: Any) -> Any:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(async_handler(*args, **kwargs))
        finally:
            loop.close()

    return sync_handler
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_workers/test_async_sync.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/app/workers/async_sync.py tests/test_workers/test_async_sync.py
git commit -m "feat: add async-to-sync wrapper for RQ job execution"
```

---

### Task 4: Create Job Registry and Enqueue Function

**Files:**
- Create: `src/draftly/app/composition/rq_jobs.py`
- Create: `tests/test_workers/test_rq_jobs.py`

**Interfaces:**
- Consumes: `TASK_REGISTRY` from `composition/workers.py`, `make_sync_handler` from `workers/async_sync.py`, sync `redis.Redis` connection
- Produces: `QUEUE_MAP`, `get_queue_for_task()`, `enqueue_job()`, `build_rq_queues()`

- [ ] **Step 1: Write the failing test**

Create `tests/test_workers/test_rq_jobs.py`:

```python
"""Tests for RQ job registry and enqueue functions."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from draftly.app.composition.rq_jobs import (
    QUEUE_MAP,
    build_rq_queues,
    enqueue_job,
    get_queue_for_task,
)


class TestGetQueueForTask:
    def test_scheduled_tasks(self):
        assert get_queue_for_task("documentation.sync") == "scheduled"
        assert get_queue_for_task("evaluation.loop") == "scheduled"
        assert get_queue_for_task("memory.curation") == "scheduled"

    def test_webhook_tasks(self):
        assert get_queue_for_task("github_pr") == "webhooks"
        assert get_queue_for_task("slack_support") == "webhooks"

    def test_default_tasks(self):
        assert get_queue_for_task("onboarding.initialize") == "default"
        assert get_queue_for_task("unknown_task") == "default"

    def test_all_registry_tasks_have_queues(self):
        from draftly.app.composition.workers import TASK_REGISTRY
        for task_name in TASK_REGISTRY:
            assert task_name in QUEUE_MAP, f"{task_name} missing from QUEUE_MAP"


class TestBuildRqQueues:
    def test_creates_queues(self):
        mock_conn = MagicMock()
        queues = build_rq_queues(mock_conn, prefix="test")
        assert "scheduled" in queues
        assert "webhooks" in queues
        assert "default" in queues
        assert len(queues) == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_workers/test_rq_jobs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'draftly.app.composition.rq_jobs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/draftly/app/composition/rq_jobs.py`:

```python
"""RQ job registry and enqueue functions.

Maps task names to RQ queues and provides the enqueue interface
used by API endpoints and rq-scheduler.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from rq import Queue, Retry
from rq.job import Job

from draftly.app.composition.workers import TASK_REGISTRY
from draftly.app.workers.async_sync import make_sync_handler

logger = structlog.get_logger(__name__)


# Task name → Queue name mapping
QUEUE_MAP: dict[str, str] = {
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
    """Return the RQ queue name for a given task."""
    return QUEUE_MAP.get(task_name, "default")


def build_rq_queues(
    connection: Any,
    prefix: str = "draftly",
) -> dict[str, Queue]:
    """Build RQ queue instances for all configured queues."""
    queues = {}
    for queue_name in ("scheduled", "webhooks", "default"):
        queues[queue_name] = Queue(
            f"{prefix}:{queue_name}",
            connection=connection,
        )
    return queues


def enqueue_job(
    queues: dict[str, Queue],
    task_handlers: dict[str, Any],
    task_name: str,
    prefix: str = "draftly",
    **kwargs: Any,
) -> Job:
    """Enqueue a task to the appropriate RQ queue.

    Args:
        queues: Dict of queue_name → Queue from build_rq_queues().
        task_handlers: Dict of task_name → async handler function.
        task_name: The task to enqueue (must be in TASK_REGISTRY).
        prefix: Redis key prefix for queue names.
        **kwargs: Arguments passed to the workflow handler.

    Returns:
        The RQ Job object.

    Raises:
        ValueError: If task_name is not registered.
    """
    if task_name not in TASK_REGISTRY:
        raise ValueError(f"Unknown task: {task_name}")

    queue_name = get_queue_for_task(task_name)
    queue = queues[queue_name]

    handler = task_handlers.get(task_name)
    if handler is None:
        raise ValueError(f"No handler registered for task: {task_name}")

    sync_handler = make_sync_handler(handler)
    job_id = str(uuid.uuid4())

    job = queue.enqueue(
        sync_handler,
        kwargs=kwargs,
        job_id=job_id,
        retry=Retry(max=3, interval=[10, 30, 60]),
        ttl=3600,
        meta={
            "task_name": task_name,
            "enqueued_at": datetime.now(timezone.utc).isoformat(),
        },
    )

    logger.info(
        "Job enqueued",
        task=task_name,
        queue=queue_name,
        job_id=job_id,
    )

    return job
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_workers/test_rq_jobs.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/app/composition/rq_jobs.py tests/test_workers/test_rq_jobs.py
git commit -m "feat: add RQ job registry with queue routing and enqueue"
```

---

### Task 5: Create RQ Worker Entrypoint

**Files:**
- Create: `workers/rq_worker.py`

**Interfaces:**
- Consumes: `build_rq_queues()` from `composition/rq_jobs.py`, `TASK_REGISTRY` from `composition/workers.py`, `Settings` from `config.py`
- Produces: RQ worker process that consumes from all queues

- [ ] **Step 1: Create the RQ worker entrypoint**

Create `workers/rq_worker.py`:

```python
"""RQ worker entrypoint.

Runs a single RQ worker consuming from all three queues
(scheduled, webhooks, default). Replaces workflow_worker.py,
indexing_worker.py, and evaluation_worker.py.

Usage:
    python -m workers.rq_worker
"""

from __future__ import annotations

import signal
import sys

import structlog
from rq import Connection, SimpleWorker

from draftly.app.config import get_settings
from draftly.app.composition.rq_jobs import build_rq_queues
from draftly.app.lifecycle import create_application
from draftly.observability.logging import configure_logging


def main() -> None:
    settings = get_settings()
    configure_logging(settings=settings)
    structlog.contextvars.bind_contextvars(worker="rq")

    log = structlog.get_logger("draftly.worker.rq")

    application = create_application(settings=settings)

    import redis as sync_redis

    redis_url = settings.redis_url
    conn = sync_redis.Redis.from_url(redis_url, decode_responses=True)

    queues = build_rq_queues(conn, prefix=settings.rq_queue_prefix)

    queue_names = [f"{settings.rq_queue_prefix}:{q}" for q in queues]

    worker = SimpleWorker(
        queue_names,
        connection=conn,
        serializer="json",
    )

    log.info(
        "RQ worker starting",
        queues=queue_names,
        prefix=settings.rq_queue_prefix,
    )

    def shutdown(signum: int, frame: object) -> None:
        log.info("RQ worker shutting down", signal=signum)
        worker.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        application.startup()
        worker.work()
    except KeyboardInterrupt:
        log.info("RQ worker interrupted")
    except Exception:
        log.exception("RQ worker failed")
    finally:
        worker.stop()
        conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify it imports correctly**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -c "from workers.rq_worker import main; print('OK')"`

- [ ] **Step 3: Commit**

```bash
git add workers/rq_worker.py
git commit -m "feat: add RQ worker entrypoint"
```

---

### Task 6: Create rq-scheduler Setup

**Files:**
- Create: `src/draftly/app/composition/rq_scheduler.py`

**Interfaces:**
- Consumes: `SCHEDULED_JOBS` from `composition/workers.py`, `make_sync_handler` from `workers/async_sync.py`, sync `redis.Redis` connection
- Produces: `setup_rq_scheduler()` function

- [ ] **Step 1: Create the scheduler setup**

Create `src/draftly/app/composition/rq_scheduler.py`:

```python
"""rq-scheduler setup for cron-triggered jobs.

Replaces the custom DraftlyScheduler polling loop with
rq-scheduler's built-in cron scheduling.
"""

from __future__ import annotations

from typing import Any

import structlog
from rq_scheduler import Scheduler

from draftly.app.composition.workers import SCHEDULED_JOBS
from draftly.app.workers.async_sync import make_sync_handler

logger = structlog.get_logger(__name__)


def setup_rq_scheduler(
    scheduler: Scheduler,
    task_handlers: dict[str, Any],
    prefix: str = "draftly",
) -> None:
    """Register all cron jobs with rq-scheduler.

    Args:
        scheduler: An rq-scheduler Scheduler instance.
        task_handlers: Dict of task_name → async handler function.
        prefix: Redis key prefix for queue names.
    """
    for job_def in SCHEDULED_JOBS:
        task_name = job_def["name"]
        handler = task_handlers.get(task_name)

        if handler is None:
            logger.warning(
                "Skipping scheduled job — no handler",
                job_id=job_def["id"],
                task=task_name,
            )
            continue

        sync_handler = make_sync_handler(handler)

        scheduler.cron(
            job_def["schedule"],
            func=sync_handler,
            kwargs=job_def.get("arguments", {}),
            queue_name=f"{prefix}:scheduled",
            id=job_def["id"],
        )

        logger.info(
            "Scheduled job registered",
            job_id=job_def["id"],
            task=task_name,
            cron=job_def["schedule"],
        )

    logger.info(
        "rq-scheduler setup complete",
        jobs=len(SCHEDULED_JOBS),
    )
```

- [ ] **Step 2: Commit**

```bash
git add src/draftly/app/composition/rq_scheduler.py
git commit -m "feat: add rq-scheduler setup for cron jobs"
```

---

### Task 7: Modify POST /jobs/run to Async Enqueue

**Files:**
- Modify: `src/draftly/app/api/routes/jobs.py:24-59`
- Create: `tests/test_api/test_jobs_rq.py`

**Interfaces:**
- Consumes: `enqueue_job()` from `composition/rq_jobs.py`, RQ queues from `application.rq_queues`
- Produces: Modified `POST /jobs/run` returning `{ status: "queued", job_id: "..." }`

- [ ] **Step 1: Write the failing test**

Create `tests/test_api/test_jobs_rq.py`:

```python
"""Tests for RQ-based job API endpoints."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


class TestRunJobEnqueue:
    @patch("draftly.app.api.routes.jobs.enqueue_job")
    def test_run_job_returns_queued(self, mock_enqueue):
        mock_job = MagicMock()
        mock_job.id = "test-job-id"
        mock_enqueue.return_value = mock_job

        from draftly.app.api.routes.jobs import run_job, JobRequest
        from unittest.mock import AsyncMock

        request = MagicMock()
        request.app.state.draftly = MagicMock()
        request.app.state.draftly.rq_queues = {"default": MagicMock()}
        request.app.state.draftly.task_handlers = {"test.task": MagicMock()}

        body = JobRequest(job_name="test.task", arguments={"key": "val"})

        import asyncio
        result = asyncio.get_event_loop().run_until_complete(
            run_job(body, request)
        )

        assert result["status"] == "queued"
        assert result["job_id"] == "test-job-id"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_api/test_jobs_rq.py -v`
Expected: FAIL (test will fail because `run_job` still returns "completed")

- [ ] **Step 3: Modify POST /jobs/run to enqueue**

Replace the entire `src/draftly/app/api/routes/jobs.py`:

```python
# app/api/routes/jobs.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from draftly.app.api.auth import get_verified_token
from draftly.app.composition.rq_jobs import enqueue_job
from draftly.integrations.database.jobs_store import DatabaseJobsStore

router = APIRouter(
    prefix="/jobs",
    tags=["jobs"],
    dependencies=[Depends(get_verified_token)],
)


class JobRequest(BaseModel):
    job_name: str
    arguments: dict[str, Any] = {}


@router.post("/run")
async def run_job(
    body: JobRequest,
    request: Request,
) -> dict[str, Any]:
    """
    Enqueue a registered Draftly job for background execution.
    """

    application = request.app.state.draftly

    rq_queues = getattr(application, "rq_queues", None)
    task_handlers = getattr(application, "task_handlers", None)

    if rq_queues is None or task_handlers is None:
        raise HTTPException(
            status_code=503,
            detail="RQ worker is not initialized",
        )

    if body.job_name not in task_handlers:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown job: {body.job_name}",
        )

    job = enqueue_job(
        queues=rq_queues,
        task_handlers=task_handlers,
        task_name=body.job_name,
        **body.arguments,
    )

    # Sync to Postgres jobs table for frontend polling
    store = DatabaseJobsStore()
    await store.insert(
        job_id=job.id,
        job_type=body.job_name,
        status="pending",
        name=body.job_name,
        payload=body.arguments,
    )

    return {
        "status": "queued",
        "job_id": job.id,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_api/test_jobs_rq.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/app/api/routes/jobs.py tests/test_api/test_jobs_rq.py
git commit -m "feat: change POST /jobs/run to async RQ enqueue"
```

---

### Task 8: Add GET /jobs and GET /jobs/:job_id Endpoints

**Files:**
- Modify: `src/draftly/app/api/routes/jobs.py`
- Modify: `tests/test_api/test_jobs_rq.py`

**Interfaces:**
- Consumes: RQ queues, Postgres `jobs` table via `JobRepository`
- Produces: `GET /api/jobs` and `GET /api/jobs/:job_id` endpoints

- [ ] **Step 1: Add tests for new endpoints**

Append to `tests/test_api/test_jobs_rq.py`:

```python
class TestListJobs:
    @patch("draftly.app.api.routes.jobs.JobRepositoryImpl")
    def test_list_jobs_returns_items(self, mock_repo_cls):
        mock_repo = MagicMock()
        mock_repo.list_active.return_value = [
            {"job_id": "j1", "status": "active"},
            {"job_id": "j2", "status": "pending"},
        ]
        mock_repo_cls.return_value = mock_repo

        from draftly.app.api.routes.jobs import list_jobs
        from unittest.mock import AsyncMock
        import asyncio

        request = MagicMock()
        request.app.state.draftly = MagicMock()

        result = asyncio.get_event_loop().run_until_complete(list_jobs(request))
        assert len(result["items"]) == 2


class TestGetJob:
    @patch("draftly.app.api.routes.jobs.JobRepositoryImpl")
    def test_get_job_returns_detail(self, mock_repo_cls):
        mock_repo = MagicMock()
        mock_repo.get.return_value = {
            "job_id": "j1",
            "status": "active",
            "task_name": "documentation.sync",
        }
        mock_repo_cls.return_value = mock_repo

        from draftly.app.api.routes.jobs import get_job
        from unittest.mock import AsyncMock
        import asyncio

        request = MagicMock()
        request.app.state.draftly = MagicMock()

        result = asyncio.get_event_loop().run_until_complete(get_job("j1", request))
        assert result["job_id"] == "j1"
        assert result["status"] == "active"
```

- [ ] **Step 2: Add the new endpoints to jobs.py**

Append to `src/draftly/app/api/routes/jobs.py`:

```python
from draftly.integrations.database.jobs_store import DatabaseJobsStore


@router.get("")
async def list_jobs(
    request: Request,
) -> dict[str, Any]:
    """
    List active background jobs.
    """

    store = DatabaseJobsStore()
    rows = await store.list_active()

    return {
        "items": rows,
    }


@router.get("/{job_id}")
async def get_job(
    job_id: str,
    request: Request,
) -> dict[str, Any]:
    """
    Get job detail by ID.
    """

    store = DatabaseJobsStore()
    row = await store.get(job_id=job_id)

    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"Job not found: {job_id}",
        )

    return row
```

- [ ] **Step 3: Run tests**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_api/test_jobs_rq.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/draftly/app/api/routes/jobs.py tests/test_api/test_jobs_rq.py
git commit -m "feat: add GET /jobs and GET /jobs/:job_id endpoints"
```

---

### Task 9: Integrate RQ into Application Lifecycle

**Files:**
- Modify: `src/draftly/app/composition/workers.py` (update `build_worker`)
- Modify: Application lifecycle (startup/shutdown)

**Interfaces:**
- Consumes: `build_rq_queues()` from `composition/rq_jobs.py`, `setup_rq_scheduler()` from `composition/rq_scheduler.py`
- Produces: `application.rq_queues`, `application.task_handlers` attributes

- [ ] **Step 1: Find the application lifecycle file**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && grep -r "create_application\|class.*Application" src/draftly/app/ --include="*.py" -l`

- [ ] **Step 2: Update composition/workers.py**

Replace `build_scheduler_client` and `build_worker` with RQ-aware versions in `src/draftly/app/composition/workers.py`:

```python
def build_rq_worker(
    *,
    task_runner: TaskRunner,
    redis_url: str,
    prefix: str = "draftly",
) -> dict[str, Any]:
    """Build RQ infrastructure: queues, scheduler config, task handlers.

    Returns a dict with:
        - rq_queues: dict of queue_name → Queue
        - task_handlers: dict of task_name → async handler
        - rq_scheduler: Scheduler instance (or None if disabled)
    """
    import redis as sync_redis
    from rq_scheduler import Scheduler

    conn = sync_redis.Redis.from_url(redis_url, decode_responses=True)
    queues = build_rq_queues(conn, prefix=prefix)

    # Build task_handlers dict from TASK_REGISTRY
    # task_runner exposes a public getter for handlers
    task_handlers = {}
    for task_name in TASK_REGISTRY:
        if task_runner.has_task(task_name):
            # Access via the public registry — _tasks is the internal dict
            handler = task_runner._tasks.get(task_name)
            if handler is not None:
                task_handlers[task_name] = handler

    scheduler = Scheduler(connection=conn)

    return {
        "rq_queues": queues,
        "task_handlers": task_handlers,
        "rq_scheduler": scheduler,
        "rq_connection": conn,
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/draftly/app/composition/workers.py
git commit -m "feat: add build_rq_worker for RQ integration"
```

---

### Task 10: Update Frontend API and Components

**Files:**
- Modify: `draftly-agent-frontend/api/observability.ts`
- Modify: `draftly-agent-frontend/components/dashboard/active-workflows.tsx`

**Interfaces:**
- Consumes: New `GET /api/jobs` and `GET /api/jobs/:job_id` endpoints
- Produces: Updated frontend types and polling

- [ ] **Step 1: Add JobStatus type to observability.ts**

In `draftly-agent-frontend/api/observability.ts`, add after the existing type definitions (around line 54):

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

- [ ] **Step 2: Add API functions**

In `draftly-agent-frontend/api/observability.ts`, add:

```typescript
export async function getJobStatus(jobId: string): Promise<JobStatus> {
  return request<JobStatus>(`/jobs/${jobId}`);
}

export async function listActiveJobs(): Promise<JobStatus[]> {
  const res = await request<{ items: JobStatus[] }>("/jobs");
  return res.items;
}
```

- [ ] **Step 3: Update ActiveWorkflows component**

In `draftly-agent-frontend/components/dashboard/active-workflows.tsx`, update the import and type to use `JobStatus` instead of the raw `{ job_id: string }[]`:

```typescript
import { listActiveJobs, JobStatus } from "@/api/observability";

// Change the polling function from getActiveJobs to listActiveJobs
// Update the component to show task_name, status, enqueued_at
```

- [ ] **Step 4: Commit**

```bash
git add draftly-agent-frontend/api/observability.ts draftly-agent-frontend/components/dashboard/active-workflows.tsx
git commit -m "feat: update frontend for RQ job status tracking"
```

---

### Task 11: Remove Old Scheduler Components

**Files:**
- Delete: `src/draftly/app/workers/scheduler.py`
- Delete: `src/draftly/app/workers/scheduler_adapter.py`
- Delete: `workers/indexing_worker.py`
- Delete: `workers/evaluation_worker.py`
- Modify: `workers/workflow_worker.py` (simplify or remove)

**Interfaces:**
- Consumes: None
- Produces: Cleaner codebase with only RQ-based scheduling

- [ ] **Step 1: Remove scheduler files**

```bash
rm src/draftly/app/workers/scheduler.py
rm src/draftly/app/workers/scheduler_adapter.py
rm workers/indexing_worker.py
rm workers/evaluation_worker.py
```

- [ ] **Step 2: Update workflow_worker.py**

Replace `workers/workflow_worker.py` content to use RQ:

```python
"""Workflow resume/retry worker entrypoint.

Now delegates to the RQ worker. This file is kept for backwards
compatibility but simply calls the RQ worker.

Usage:
    python -m workers.workflow_worker
"""

from __future__ import annotations

from workers.rq_worker import main

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Remove imports of deleted modules**

Search and remove any imports of `scheduler`, `scheduler_adapter` from other files:

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && grep -r "from draftly.app.workers.scheduler\|from draftly.app.workers.scheduler_adapter" src/ --include="*.py" -l`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: remove old scheduler components, delegate to RQ"
```

---

### Task 12: Update Docker Compose

**Files:**
- Modify: `docker/docker-compose.yml` (or `docker-compose.yml`)

**Interfaces:**
- Consumes: `workers/rq_worker.py` entrypoint
- Produces: RQ worker service in Docker Compose

- [ ] **Step 1: Add RQ worker service**

In the Docker Compose file, add a new service:

```yaml
  rq-worker:
    build:
      context: ..
      dockerfile: docker/Dockerfile.worker
    command: ["python", "-m", "workers.rq_worker"]
    environment:
      - REDIS_URL=redis://redis:6379/0
      - DATABASE_URL=${DATABASE_URL}
    depends_on:
      - redis
    restart: unless-stopped
```

- [ ] **Step 2: Commit**

```bash
git add docker/docker-compose.yml
git commit -m "feat: add RQ worker service to Docker Compose"
```

---

### Task 13: Write Integration Tests

**Files:**
- Create: `tests/test_workers/test_rq_integration.py`

**Interfaces:**
- Consumes: fakeredis (already in dev deps), all RQ modules
- Produces: Integration tests verifying enqueue → execute cycle

- [ ] **Step 1: Create integration test**

Create `tests/test_workers/test_rq_integration.py`:

```python
"""Integration tests for RQ job enqueue and execution cycle."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import fakeredis
import pytest
from rq import Queue
from rq.job import Job

from draftly.app.workers.async_sync import make_sync_handler


async def _mock_workflow(org_id: str = "test-org") -> dict:
    return {"status": "ok", "org_id": org_id}


class TestRQIntegration:
    def setup_method(self):
        self.fake_redis = fakeredis.FakeRedis(decode_responses=True)

    def test_enqueue_and_get_job(self):
        queue = Queue("draftly:test", connection=self.fake_redis)
        sync_handler = make_sync_handler(_mock_workflow)

        job = queue.enqueue(
            sync_handler,
            kwargs={"org_id": "test-org"},
            job_id="test-integration-001",
        )

        assert job.id == "test-integration-001"
        assert job.is_queued

        fetched = Job.fetch("test-integration-001", connection=self.fake_redis)
        assert fetched == job

    def test_execute_job(self):
        queue = Queue("draftly:test", connection=self.fake_redis)
        sync_handler = make_sync_handler(_mock_workflow)

        job = queue.enqueue(
            sync_handler,
            kwargs={"org_id": "exec-org"},
            job_id="test-exec-001",
        )

        result = job.perform()
        assert result == {"status": "ok", "org_id": "exec-org"}

    def test_queue_routing(self):
        from draftly.app.composition.rq_jobs import get_queue_for_task

        assert get_queue_for_task("documentation.sync") == "scheduled"
        assert get_queue_for_task("github_pr") == "webhooks"
        assert get_queue_for_task("onboarding.initialize") == "default"
```

- [ ] **Step 2: Run integration tests**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/test_workers/test_rq_integration.py -v`
Expected: PASS (3 tests)

- [ ] **Step 3: Run all tests**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/ -v`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/test_workers/test_rq_integration.py
git commit -m "feat: add RQ integration tests"
```

---

### Task 14: Final Verification and Cleanup

- [ ] **Step 1: Run linter**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m ruff check src/ tests/ workers/`

- [ ] **Step 2: Run type checker**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m mypy src/draftly/app/workers/ src/draftly/app/composition/ src/draftly/app/api/routes/jobs.py`

- [ ] **Step 3: Run full test suite**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -m pytest tests/ -v --tb=short`

- [ ] **Step 4: Verify no broken imports**

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && python -c "from draftly.app.lifecycle import create_application; print('OK')"`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete RQ integration — lint, typecheck, tests pass"
```
