# Stale-Run Recovery & Bounded Dashboard List Query — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `GET /api/workflows` from timing out by (a) automatically failing runs stuck in `running` (recovery sweep at RQ worker boot + scheduled cron) and (b) bounding the dashboard list query so it never accumulates unbounded `workflow_events` IN-lists.

**Architecture:** The runner's only exit path is `_finish_result` (`src/draftly/workflows/runner.py:476-554`), which never runs when a worker dies mid-run, a node blocks on sync I/O, or the single shared dispatch loop is wedged. We add a best-effort, idempotent sweep that finds `jobs` rows still `running` past a threshold with no terminal `workflow_result` envelope in `workflow_events` (the runner appends that envelope *before* marking anything terminal), marks the `events` row failed (the source of truth), reuses the existing `reconcile_run()` to align the `jobs`/`github_workflows` read models, and broadcasts `workflow:changed` so the dashboard list refreshes. The sweep runs once at RQ worker boot and every 10 minutes via rq-scheduler. Separately, `list_github_workflows_record` gets a `LIMIT` on the `github_workflows` fetch so the `ANY(...)` event/jobs queries never exceed a bounded run-id set.

**Tech Stack:** Python 3.11, asyncpg (`DatabaseClient`), RQ + rq-scheduler (Redis), structlog, pytest (asyncio auto mode).

**Spec:** Root-cause analysis of the 9/9 `asyncpg.TimeoutError` on `GET /api/workflows` (30s `command_timeout` at `src/draftly/integrations/database/client.py:52`; timed-out query at `src/draftly/persistence/repositories/github.py:378`; org `org_3IfMDevV4Tg8DLD8Ljc0GG6c2GJ`, authly PR #1, actor `scenario-bot`). Stuck runs confirmed: 12+ `jobs` rows `running` since 9/7-9/8 (e.g. run `675B48BA`), `reconcile_stale_runs` is dead code, RQ `job_timeout=-1`, single shared event loop (`rq_dispatch.py:44-65`), strand timeouts ineffective against sync-blocking/worker death.

## Global Constraints

- Never write a `workflow_result`/terminal state when a terminal `workflow_result` envelope already exists in `workflow_events` for that run (idempotency, prevents clobbering a completed run).
- The `events` row is the source of truth; read-model rows (`jobs`, `github_workflows`) must be aligned through the existing `reconcile_run()` where possible.
- Recovery sweep must be best-effort: it never raises, individual failures are logged and skipped, cold/missing DB must not block worker boot.
- Dashboard list must stay bounded: the `github_workflows` fetch gets `ORDER BY created_at DESC LIMIT $2`; the derived `run_ids` list must never exceed the limit.
- All tests use plain `async def` (pytest `asyncio_mode = "auto"` in `pyproject.toml:84`). No test annotations/markers needed.
- No new dependencies.

## File Structure

- Create: `src/draftly/workflows/documentation/stale_reconcile_workflow.py` — scheduled-task workflow that wraps the sweep.
- Create: `tests/persistence/test_jobs_stuck.py` — jobs store `list_stuck` + repo passthrough tests.
- Modify: `src/draftly/integrations/database/jobs_store.py` — add `list_stuck(started_before, status, limit)`.
- Modify: `src/draftly/persistence/repositories/jobs.py` — add `list_stuck(...)` passthrough.
- Modify: `src/draftly/integrations/database/workflow_events_store.py` — add `terminal_run_ids(run_ids)`.
- Modify: `src/draftly/persistence/repositories/workflow_events.py` — add `terminal_run_ids(...)` passthrough.
- Modify: `src/draftly/workflows/documentation/reconciliation.py` — add `mark_stale_runs_failed()`, `reconcile_stale_on_boot()`, `_default_stale_after()`, `_set_read_models_failed()`.
- Modify: `src/draftly/app/composition/workflows.py` — register `stale_run_reconcile` workflow.
- Modify: `src/draftly/app/composition/workers.py` — `TASK_REGISTRY` + `SCHEDULED_JOBS` entries.
- Modify: `workers/rq_worker.py` — run boot sweep after handlers register.
- Modify: `src/draftly/persistence/repositories/github.py` — bind the list query.
- Modify tests: `tests/persistence/test_workflow_events_store.py`, `tests/workflows/test_reconciliation.py`, `tests/persistence/test_github_workflows_meta.py`, `tests/test_workers/test_rq_scheduler.py`.

---

### Task 1: Jobs — `list_stuck` on store + repository

**Files:**
- Modify: `src/draftly/integrations/database/jobs_store.py` (append method after `list_active`)
- Modify: `src/draftly/persistence/repositories/jobs.py`
- Test: Create `tests/persistence/test_jobs_stuck.py`

**Interfaces:**
- Produces:
  - `DatabaseJobsStore.list_stuck(*, started_before: datetime, status: str = "running", limit: int = 500) -> list[dict[str, Any]]` — each row `{"run_id": str, "org_id": str, "started_at": datetime | None}`.
  - `JobRepositoryImpl.list_stuck(*, started_before, status="running", limit=500) -> list[dict[str, Any]]` passthrough.
  - Consumed by Task 3's `mark_stale_runs_failed`.

- [ ] **Step 1: Write the failing store test**

Create `tests/persistence/test_jobs_stuck.py`:

```python
"""DatabaseJobsStore.list_stuck — find long-running 'running' rows."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from draftly.integrations.database.jobs_store import DatabaseJobsStore


class _FakeClient:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, tuple]] = []

    async def fetch_all(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append((query, args))
        return self.rows


async def test_list_stuck_queries_running_before_cutoff() -> None:
    client = _FakeClient(
        [{"run_id": "r-1", "org_id": "o-1", "started_at": "2026-01-01T00:00:00Z"}]
    )
    store = DatabaseJobsStore(client=client)

    rows = await store.list_stuck(
        started_before=datetime(2026, 1, 2, tzinfo=UTC),
        status="running",
        limit=50,
    )

    assert len(rows) == 1
    assert rows[0]["run_id"] == "r-1"
    assert rows[0]["org_id"] == "o-1"
    sql, params = client.calls[0]
    assert "status = $2" in sql
    assert "started_at < $1" in sql
    assert "LIMIT $3" in sql
    assert params == (datetime(2026, 1, 2, tzinfo=UTC), "running", 50)


async def test_repo_list_stuck_passthrough() -> None:
    client = _FakeClient(
        [{"run_id": "r-2", "org_id": "o-1", "started_at": "2026-01-01T00:00:00Z"}]
    )
    from draftly.persistence.repositories.jobs import JobRepositoryImpl

    repo = JobRepositoryImpl(store=DatabaseJobsStore(client=client))

    rows = await repo.list_stuck(
        started_before=datetime(2026, 1, 2, tzinfo=UTC),
        status="running",
        limit=10,
    )

    assert rows[0]["run_id"] == "r-2"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/persistence/test_jobs_stuck.py -v`
Expected: FAIL with `AttributeError: 'DatabaseJobsStore' object has no attribute 'list_stuck'`

- [ ] **Step 3: Implement `list_stuck` on the store**

In `src/draftly/integrations/database/jobs_store.py`, after `list_active`:

```python
    async def list_stuck(
        self,
        *,
        started_before: datetime,
        status: str = "running",
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Rows still in a non-terminal status whose start predates the cutoff.

        Used by the stale-run recovery sweep to find runs a worker died on
        (the runner never ran ``_finish_result``, so the row stayed in-flight).
        """
        rows = await self.client.fetch_all(
            """
            SELECT run_id, org_id, started_at
            FROM jobs
            WHERE status = $2
              AND started_at IS NOT NULL
              AND started_at < $1
            ORDER BY started_at ASC
            LIMIT $3
            """,
            started_before,
            status,
            limit,
        )

        out: list[dict[str, Any]] = []
        for row in rows:
            out.append(
                {
                    "run_id": str(row["run_id"]),
                    "org_id": str(row.get("org_id") or ""),
                    "started_at": row.get("started_at"),
                }
            )
        return out
```

(`datetime` is already imported in the file; add it to the `datetime` import if missing — the file currently imports `from typing import Any` and `from uuid import uuid4`, so add `from datetime import datetime`.)

- [ ] **Step 4: Add the repository passthrough**

In `src/draftly/persistence/repositories/jobs.py`, after `list_active`:

```python
    async def list_stuck(
        self,
        *,
        started_before: Any,
        status: str = "running",
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        return await self.store.list_stuck(
            started_before=started_before,
            status=status,
            limit=limit,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/persistence/test_jobs_stuck.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add tests/persistence/test_jobs_stuck.py src/draftly/integrations/database/jobs_store.py src/draftly/persistence/repositories/jobs.py
git commit -m "feat: add jobs.list_stuck for stale-run recovery sweep"
```

---

### Task 2: Workflow events — `terminal_run_ids`

**Files:**
- Modify: `src/draftly/integrations/database/workflow_events_store.py`
- Modify: `src/draftly/persistence/repositories/workflow_events.py`
- Test: `tests/persistence/test_workflow_events_store.py`

**Interfaces:**
- Produces:
  - `WorkflowEventsStore.terminal_run_ids(run_ids: list[str]) -> set[str]` — distinct run_ids that have a terminal `workflow_result` envelope.
  - `WorkflowEventRepositoryImpl.terminal_run_ids(run_ids: list[str]) -> set[str]` passthrough.
  - Consumed by Task 3's `mark_stale_runs_failed`.

- [ ] **Step 1: Write the failing test**

Append to `tests/persistence/test_workflow_events_store.py`:

```python
class _TerminalFakeClient:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, tuple]] = []

    async def fetch_all(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append((query, args))
        return self.rows


async def test_terminal_run_ids_returns_only_runs_with_workflow_result() -> None:
    client = _TerminalFakeClient(
        [
            {"run_id": "r-1"},
            {"run_id": "r-3"},
        ]
    )
    store = WorkflowEventsStore(client=client)

    result = await store.terminal_run_ids(["r-1", "r-2", "r-3"])

    assert result == {"r-1", "r-3"}
    sql, params = client.calls[0]
    assert "type = 'workflow_result'" in sql
    assert "ANY($1::TEXT[])" in sql
    assert params == (["r-1", "r-2", "r-3"],)


async def test_repo_terminal_run_ids_passthrough() -> None:
    from draftly.persistence.repositories.workflow_events import (
        WorkflowEventRepositoryImpl,
    )

    client = _TerminalFakeClient([{"run_id": "r-1"}])
    repo = WorkflowEventRepositoryImpl(store=WorkflowEventsStore(client=client))

    assert await repo.terminal_run_ids(["r-1"]) == {"r-1"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/persistence/test_workflow_events_store.py -v`
Expected: FAIL with `AttributeError: 'WorkflowEventsStore' object has no attribute 'terminal_run_ids'`

- [ ] **Step 3: Implement `terminal_run_ids` on the store**

In `src/draftly/integrations/database/workflow_events_store.py`, after `list_after`:

```python
    async def terminal_run_ids(self, run_ids: list[str]) -> set[str]:
        """Distinct run_ids that already have a terminal ``workflow_result`` envelope."""
        if not run_ids:
            return set()
        rows = await self.client.fetch_all(
            """
            SELECT DISTINCT run_id
            FROM workflow_events
            WHERE run_id = ANY($1::TEXT[]) AND type = 'workflow_result'
            """,
            list(run_ids),
        )
        return {str(row["run_id"]) for row in rows}
```

- [ ] **Step 4: Add the repository passthrough**

In `src/draftly/persistence/repositories/workflow_events.py`:

```python
    async def terminal_run_ids(self, run_ids: list[str]) -> set[str]:
        return await self.store.terminal_run_ids(run_ids)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/persistence/test_workflow_events_store.py -v`
Expected: PASS (3 existing + 2 new)

- [ ] **Step 6: Commit**

```bash
git add tests/persistence/test_workflow_events_store.py src/draftly/integrations/database/workflow_events_store.py src/draftly/persistence/repositories/workflow_events.py
git commit -m "feat: add workflow_events.terminal_run_ids for staleness guard"
```

---

### Task 3: Recovery sweep — `mark_stale_runs_failed` + boot helper

**Files:**
- Modify: `src/draftly/workflows/documentation/reconciliation.py`
- Modify: `tests/workflows/test_reconciliation.py`

**Interfaces:**
- Consumes:
  - `jobs.list_stuck(*, started_before, status="running", limit) -> list[{"run_id", "org_id", "started_at"}]` (Task 1)
  - `workflow_events.terminal_run_ids(list[str]) -> set[str]` (Task 2)
  - `events.find_by_event_id(str) -> dict | None`, `events.mark_status(str, str) -> None` (existing)
  - `reconcile_run(context, run_id) -> str | None` (existing, same module)
  - `context.broadcaster.broadcast(org_id, event, payload)` (existing, optional)
- Produces:
  - `mark_stale_runs_failed(context: WorkflowContext, *, stale_after_seconds: int | None = None, limit: int = 200) -> int`
  - `reconcile_stale_on_boot(application: Any) -> int`
  - `_default_stale_after(context: WorkflowContext) -> int`
  - `_set_read_models_failed(context: WorkflowContext, run_id: str) -> None`
  - Consumed by Task 4 (workflow func, boot wiring).

- [ ] **Step 1: Write the failing sweep tests**

Append to `tests/workflows/test_reconciliation.py`. Extend the existing fakes and add new ones:

```python
@dataclass
class FakeEventsWithMark(FakeEvents):
    """FakeEvents + a mark_status recorder that flips the in-memory row."""

    marked: list[tuple[str, str]] = field(default_factory=list)

    async def mark_status(self, event_id: str, status: str) -> None:
        self.marked.append((event_id, status))
        self.rows[event_id] = status


@dataclass
class FakeWorkEvents:
    terminal: set[str] = field(default_factory=set)

    async def terminal_run_ids(self, run_ids: list[str]) -> set[str]:
        return self.terminal & set(run_ids)


@dataclass
class FakeJobsRepo:
    """The jobs repo in production has BOTH the sweep lister and the
    reconcile updater (JobRepositoryImpl::list_stuck + update_status). The
    fake mirrors that so reconcile_run can update the same object that
    produced the stuck candidates."""

    rows: list[dict] = field(default_factory=list)
    updates: list[dict] = field(default_factory=list)

    async def list_stuck(self, *, started_before, status="running", limit=500):
        return self.rows

    async def update_status(self, **kwargs):
        self.updates.append(
            {
                "run_id": kwargs.get("job_id") or kwargs.get("workflow_id"),
                "status": kwargs.get("status"),
            }
        )


@dataclass
class FakeBroadcaster:
    sent: list[tuple] = field(default_factory=list)

    async def broadcast(self, org_id, event, payload):
        self.sent.append((org_id, event, payload))


class FakeRepos:
    def __init__(self, events, jobs, workflows, work_events):
        self.events = events
        self.jobs = jobs
        self.github_workflows = workflows
        self.workflow_events = work_events


def make_sweep_context(events=None, jobs=None, workflows=None, work_events=None, broadcaster=None):
    repos = FakeRepos(
        events=events or FakeEvents(rows={}),
        jobs=jobs or FakeJobsRepo(),
        workflows=workflows or FakeReadModel(),
        work_events=work_events or FakeWorkEvents(),
    )
    return WorkflowContext(repositories=repos, broadcaster=broadcaster)
```

New tests (append after the existing ones, importing the new names from the module):

```python
async def test_sweep_fails_stuck_run_through_reconcile() -> None:
    events = FakeEventsWithMark(rows={"stuck-1": "running"})
    jobs = FakeJobsRepo(
        rows=[{"run_id": "stuck-1", "org_id": "org-a", "started_at": None}]
    )
    workflows = FakeReadModel()
    broadcaster = FakeBroadcaster()
    context = make_sweep_context(
        events=events, jobs=jobs, workflows=workflows, work_events=FakeWorkEvents(),
        broadcaster=broadcaster,
    )

    count = await mark_stale_runs_failed(context, stale_after_seconds=1)

    assert count == 1
    assert events.marked == [("stuck-1", "failed")]
    # events row is now terminal, so reconcile_run aligned the read models
    assert jobs.updates == [{"run_id": "stuck-1", "status": "failed"}]
    assert workflows.updates == [{"workflow_id": "stuck-1", "status": "failed"}]
    assert broadcaster.sent == [
        ("org-a", "workflow:changed", {"run_id": "stuck-1", "status": "failed", "kind": "sweep"})
    ]


async def test_sweep_skips_run_with_terminal_result() -> None:
    events = FakeEventsWithMark(rows={"done-1": "running"})
    jobs = FakeJobsRepo(
        rows=[{"run_id": "done-1", "org_id": "org-a", "started_at": None}]
    )
    workflows = FakeReadModel()
    context = make_sweep_context(
        events=events, jobs=jobs, workflows=workflows,
        work_events=FakeWorkEvents(terminal={"done-1"}),
    )

    count = await mark_stale_runs_failed(context, stale_after_seconds=1)

    assert count == 0
    assert events.marked == []
    assert jobs.updates == []
    assert workflows.updates == []


async def test_sweep_noop_when_no_stuck_rows() -> None:
    context = make_sweep_context(jobs=FakeJobsRepo(rows=[]))
    assert await mark_stale_runs_failed(context, stale_after_seconds=1) == 0


async def test_sweep_falls_back_when_events_row_missing() -> None:
    jobs = FakeJobsRepo(
        rows=[{"run_id": "r-1", "org_id": "org-a", "started_at": None}]
    )
    workflows = FakeReadModel()
    context = make_sweep_context(
        events=FakeEvents(rows={}),  # no events row → find_by_event_id → None
        jobs=jobs, workflows=workflows, work_events=FakeWorkEvents(),
    )

    count = await mark_stale_runs_failed(context, stale_after_seconds=1)

    assert count == 1
    assert jobs.updates == [{"run_id": "r-1", "status": "failed"}]
    assert workflows.updates == [{"workflow_id": "r-1", "status": "failed"}]


async def test_boot_helper_extracts_context_from_application() -> None:
    from types import SimpleNamespace

    jobs = FakeJobsRepo(
        rows=[{"run_id": "r-1", "org_id": "org-a", "started_at": None}]
    )
    workflows = FakeReadModel()
    context = make_sweep_context(jobs=jobs, workflows=workflows)
    app = SimpleNamespace(workflows=SimpleNamespace(context=context))

    assert await reconcile_stale_on_boot(app) == 1
    assert jobs.updates == [{"run_id": "r-1", "status": "failed"}]
```

Update the import at the top of the test file from:

```python
from draftly.workflows.documentation.reconciliation import (
    reconcile_run,
    reconcile_stale_runs,
)
```

to:

```python
from draftly.workflows.documentation.reconciliation import (
    mark_stale_runs_failed,
    reconcile_run,
    reconcile_stale_on_boot,
    reconcile_stale_runs,
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/workflows/test_reconciliation.py -v`
Expected: FAIL with `ImportError: cannot import name 'mark_stale_runs_failed'`

- [ ] **Step 3: Implement the sweep**

Add to `src/draftly/workflows/documentation/reconciliation.py`:

```python
from datetime import UTC, datetime, timedelta
from typing import Any

DEFAULT_STALE_AFTER_SECONDS = 3600


def _default_stale_after(context: WorkflowContext) -> int:
    """Sweep threshold: strand execution_timeout + margin, else 3600s."""
    config = getattr(context, "config", None)
    strands = getattr(config, "strands", None)
    timeout = getattr(strands, "execution_timeout", None)
    if isinstance(timeout, (int, float)) and timeout > 0:
        return max(DEFAULT_STALE_AFTER_SECONDS, int(timeout) + 600)
    return DEFAULT_STALE_AFTER_SECONDS


async def _set_read_models_failed(context: WorkflowContext, run_id: str) -> None:
    """Direct read-model alignment when no events row exists for the run."""
    repositories = getattr(context, "repositories", None)
    jobs = getattr(repositories, "jobs", None)
    if jobs is not None and getattr(jobs, "update_status", None) is not None:
        try:
            await jobs.update_status(job_id=run_id, status="failed")
        except Exception:
            logger.warning("sweep_job_status_failed", run_id=run_id, exc_info=True)
    workflows = getattr(repositories, "github_workflows", None)
    if workflows is not None and getattr(workflows, "update_status", None) is not None:
        try:
            await workflows.update_status(workflow_id=run_id, status="failed")
        except Exception:
            logger.warning("sweep_workflow_status_failed", run_id=run_id, exc_info=True)


async def mark_stale_runs_failed(
    context: WorkflowContext,
    *,
    stale_after_seconds: int | None = None,
    limit: int = 200,
) -> int:
    """Fail runs stuck in ``running`` past the threshold (best-effort recovery).

    A run is stuck when its jobs row is still ``running`` past the threshold
    AND the ``workflow_events`` log has no terminal ``workflow_result``
    envelope — meaning ``_finish_result`` never ran (worker death, wedged loop,
    sync-blocked node). The events row is marked failed first (source of
    truth), then ``reconcile_run()`` aligns the read models, then the
    dashboard is pushed a refresh. Idempotent: rerunning is a no-op once rows
    are terminal. Never raises.
    """
    repositories = getattr(context, "repositories", None)
    jobs = getattr(repositories, "jobs", None)
    lister = getattr(jobs, "list_stuck", None)
    if jobs is None or lister is None:
        logger.info("stale_sweep_skipped reason=no_jobs_lister")
        return 0

    stale_after = stale_after_seconds or _default_stale_after(context)
    cutoff = datetime.now(UTC) - timedelta(seconds=stale_after)
    rows = await lister(started_before=cutoff, status="running", limit=limit)

    run_ids = [str(r.get("run_id") or "") for r in rows if r.get("run_id")]
    if not run_ids:
        return 0

    work_events = getattr(repositories, "workflow_events", None)
    terminal_selector = getattr(work_events, "terminal_run_ids", None) if work_events is not None else None
    terminal: set[str] = set()
    if terminal_selector is not None:
        try:
            terminal = set(await terminal_selector(run_ids))
        except Exception:
            logger.warning("stale_sweep_terminal_lookup_failed", exc_info=True)

    events = getattr(repositories, "events", None)
    events_finder = getattr(events, "find_by_event_id", None)
    events_marker = getattr(events, "mark_status", None)
    broadcaster = getattr(getattr(context, "broadcaster", None), "broadcast", None)

    recovered = 0
    for row in rows:
        run_id = str(row.get("run_id") or "")
        if not run_id or run_id in terminal:
            continue
        # Re-check right before marking: the runner persists the terminal
        # workflow_result envelope BEFORE marking anything terminal, so this
        # closes the race where a run finished while the sweep ran.
        if terminal_selector is not None:
            try:
                if run_id in await terminal_selector([run_id]):
                    continue
            except Exception:
                logger.warning("stale_sweep_terminal_recheck_failed", run_id=run_id, exc_info=True)

        try:
            if events_finder is not None and events_marker is not None:
                existing = await events_finder(run_id)
                if isinstance(existing, dict):
                    await events_marker(run_id, "failed")
        except Exception:
            logger.warning("stale_sweep_event_mark_failed", run_id=run_id, exc_info=True)

        # events row now reads terminal 'failed' → reconcile_run aligns read
        # models; when no events row exists it returns None and we align directly.
        if await reconcile_run(context, run_id) is None:
            await _set_read_models_failed(context, run_id)

        org_id = str(row.get("org_id") or "")
        if broadcaster is not None and org_id:
            try:
                await broadcaster(
                    org_id, "workflow:changed",
                    {"run_id": run_id, "status": "failed", "kind": "sweep"},
                )
            except Exception:
                logger.warning("stale_sweep_broadcast_failed", run_id=run_id, exc_info=True)

        logger.info("stale_run_marked_failed", run_id=run_id, stale_after_seconds=stale_after)
        recovered += 1

    logger.info("stale_sweep_done", scanned=len(rows), recovered=recovered)
    return recovered


async def reconcile_stale_on_boot(application: Any) -> int:
    """Run the sweep at RQ worker boot using the composed context."""
    workflows = getattr(application, "workflows", None)
    context = getattr(workflows, "context", None)
    if context is None:
        return 0
    return await mark_stale_runs_failed(context)
```

Note: `reconcile_run` already has a terminal-status guard (`TERMINAL_STATUSES` includes `"failed"`), so it aligns the read models to `failed` once the events row is marked. The sweep's per-run re-check also protects the read models from being clobbered after a legitimate completion.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/workflows/test_reconciliation.py -v`
Expected: PASS (existing 4 + 5 new)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/workflows/documentation/reconciliation.py tests/workflows/test_reconciliation.py
git commit -m "feat: add mark_stale_runs_failed recovery sweep"
```

---

### Task 4: Wire the sweep — scheduled cron + worker boot

**Files:**
- Create: `src/draftly/workflows/documentation/stale_reconcile_workflow.py`
- Modify: `src/draftly/app/composition/workflows.py` (registry registration)
- Modify: `src/draftly/app/composition/workers.py` (`TASK_REGISTRY` + `SCHEDULED_JOBS`)
- Modify: `workers/rq_worker.py` (boot sweep)
- Modify: `tests/test_workers/test_rq_scheduler.py`

**Interfaces:**
- Consumes: `reconciliation.mark_stale_runs_failed`, `reconciliation.reconcile_stale_on_boot` (Task 3).
- Produces:
  - `stale_reconcile_workflow.run_stale_reconcile(context: WorkflowContext, **kwargs) -> int`
  - `TASK_REGISTRY["stale.run_reconcile"] = "stale_run_reconcile"`
  - `SCHEDULED_JOBS` entry `{id: "stale-run-reconcile", name: "stale.run_reconcile", schedule: "*/10 * * * *", arguments: {}}`

- [ ] **Step 1: Write the failing scheduler test**

Append to `tests/test_workers/test_rq_scheduler.py`:

```python
def test_scheduler_registers_stale_run_reconcile_cron() -> None:
    from draftly.app.composition.workers import SCHEDULED_JOBS

    entry = next(j for j in SCHEDULED_JOBS if j["name"] == "stale.run_reconcile")
    assert entry["schedule"] == "*/10 * * * *"

    fake = _FakeScheduler()
    handlers = {job["name"]: (lambda **kw: None) for job in SCHEDULED_JOBS}
    setup_rq_scheduler(scheduler=fake, task_handlers=handlers)

    record = next(r for r in fake.cron_calls if r["id"] == "stale-run-reconcile")
    assert record["kwargs"]["name"] == "stale.run_reconcile"
    assert record["schedule"] == "*/10 * * * *"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_workers/test_rq_scheduler.py -v`
Expected: FAIL with `StopIteration` (no `stale.run_reconcile` SCHEDULED_JOBS entry)

- [ ] **Step 3: Create the workflow function**

Create `src/draftly/workflows/documentation/stale_reconcile_workflow.py`:

```python
"""Scheduled stale-run recovery workflow (entry point for rq-scheduler)."""

from __future__ import annotations

from typing import Any

import structlog

from draftly.workflows.context import WorkflowContext
from draftly.workflows.documentation.reconciliation import mark_stale_runs_failed

logger = structlog.get_logger(__name__)


async def run_stale_reconcile(context: WorkflowContext, **kwargs: Any) -> int:
    """Fail runs stuck in ``running``; returns how many were recovered."""
    raw = kwargs.get("stale_after_seconds")
    stale_after = int(raw) if raw else None
    recovered = await mark_stale_runs_failed(context, stale_after_seconds=stale_after)
    logger.info("stale_reconcile_workflow_done", recovered=recovered)
    return recovered
```

- [ ] **Step 4: Register the workflow**

In `src/draftly/app/composition/workflows.py`, add the import alongside the other workflow imports (near line 66):

```python
    from draftly.workflows.documentation.stale_reconcile_workflow import (
        run_stale_reconcile,
    )
```

and register it (near line 142):

```python
    registry.register("stale_run_reconcile", run_stale_reconcile)
```

- [ ] **Step 5: Add TASK_REGISTRY + SCHEDULED_JOBS entries**

In `src/draftly/app/composition/workers.py`, add to `TASK_REGISTRY`:

```python
    "stale.run_reconcile": "stale_run_reconcile",
```

and to `SCHEDULED_JOBS`:

```python
    {
        "id": "stale-run-reconcile",
        "name": "stale.run_reconcile",
        "schedule": "*/10 * * * *",
        "arguments": {},
    },
```

- [ ] **Step 6: Wire the boot sweep in rq_worker**

In `workers/rq_worker.py`, add the import:

```python
from draftly.workflows.documentation.reconciliation import reconcile_stale_on_boot
```

and after `register_handlers(...)` (line 74):

```python
    # Recover runs orphaned by a previous worker death before accepting new
    # jobs. Best-effort: a cold/missing DB must not block worker boot.
    try:
        recovered = run_on_loop(reconcile_stale_on_boot(application))
        log.info("boot_stale_sweep_done", recovered=recovered)
    except Exception:
        log.exception("boot_stale_sweep_failed")
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pytest tests/test_workers/test_rq_scheduler.py -v`
Expected: PASS (3 tests). Also confirm the app composes:

Run: `python -c "from draftly.app.composition.workers import TASK_REGISTRY, SCHEDULED_JOBS; assert 'stale.run_reconcile' in TASK_REGISTRY; print('ok')"`
Expected: `ok`

- [ ] **Step 8: Commit**

```bash
git add src/draftly/workflows/documentation/stale_reconcile_workflow.py src/draftly/app/composition/workflows.py src/draftly/app/composition/workers.py workers/rq_worker.py tests/test_workers/test_rq_scheduler.py
git commit -m "feat: run stale-run recovery sweep on a cron and at worker boot"
```

---

### Task 5: Bound the dashboard list query

**Files:**
- Modify: `src/draftly/persistence/repositories/github.py` (`list_github_workflows_record`)
- Modify: `tests/persistence/test_github_workflows_meta.py`

**Interfaces:**
- Consumes: `DatabaseClient.fetch_all` (existing).
- Produces:
  - `list_github_workflows_record(*, org_id: str, db: DatabaseClient | None = None, limit: int = 100) -> list[dict[str, Any]]` — cross-file constant `_DASHBOARD_PAGE_SIZE = 100`.
  - The `github_workflows` query gains `ORDER BY created_at DESC LIMIT $2`; the derived `run_ids` is sliced to `limit` so the `ANY(...)` jobs/events queries never exceed the bound.

- [ ] **Step 1: Write the failing bounded-query test**

Append to `tests/persistence/test_github_workflows_meta.py`:

```python
async def test_list_workflows_bounds_github_query_and_run_ids() -> None:
    client = _FetchAllClient([[], [], [], []])
    rows = await list_github_workflows_record(org_id="o-1", db=client, limit=50)
    assert rows == []
    assert "LIMIT $2" in client.queries[0]
    assert client.executed[0][1] == ("o-1", 50)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/persistence/test_github_workflows_meta.py -v`
Expected: FAIL with `AssertionError` (`LIMIT $2` not in query, params `("o-1",)`)

- [ ] **Step 3: Implement the bound**

In `src/draftly/persistence/repositories/github.py`, near the top of the module add a module constant (after imports):

```python
_DASHBOARD_PAGE_SIZE = 100
```

Change the signature of `list_github_workflows_record`:

```python
async def list_github_workflows_record(
    *,
    org_id: str,
    db: DatabaseClient | None = None,
    limit: int = _DASHBOARD_PAGE_SIZE,
) -> list[dict[str, Any]]:
```

Change the `github_workflows` query (lines 347-353) to append the limit and pass it:

```python
    gw_rows = await db.fetch_all(
        """SELECT workflow_id, run_id, title, owner, repo, issue_number,
                  actor, event_type, status, created_at
           FROM github_workflows
           WHERE org_id = $1
           ORDER BY created_at DESC LIMIT $2""",
        org_id,
        limit,
    )
```

And bound the derived run_ids (line 359):

```python
    run_ids = [str(r["run_id"]) for r in gw_rows if r.get("run_id")][:limit]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/persistence/test_github_workflows_meta.py tests/api/test_workflows_list.py -v`
Expected: PASS (existing list tests still pass — default `limit=100` only changes the gw query's params, which the existing tests do not assert on; new test passes)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/persistence/repositories/github.py tests/persistence/test_github_workflows_meta.py
git commit -m "fix: bound dashboard workflow list query to prevent timeout"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `pytest -q`
Expected: all tests pass (no regressions).

- [ ] **Step 2: Confirm the sweep is reachable end-to-end**

Run: `python -c "from draftly.app.composition.workers import SCHEDULED_JOBS, TASK_REGISTRY, build_task_runner; from draftly.workflows.documentation.reconciliation import mark_stale_runs_failed, reconcile_stale_on_boot; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Update the graph (AGENTS.md convention)**

Run: `graphify update .`

- [ ] **Step 4: Document the fix**

Append a short note to `docs/superpowers/plans/` or the changelog describing the sweep schedule and the list bound (one paragraph).

## Verification of production behavior (post-deploy)

1. Deploy, confirm `boot_stale_sweep_done recovered=...` in worker logs at startup.
2. Confirm rq-scheduler lists the job: `rq-scheduler --host <redis> --port 6379` shows `stale-run-reconcile` with cron `*/10 * * * *`.
3. On the dashboard, previously-wedged runs (e.g. `675B48BA`, org `org_3IfMDevV4Tg8DLD8Ljc0GG6c2GJ`) now show `failed`; `GET /api/workflows` returns in well under 30s.
4. Re-trigger a PR event; the run completes normally and the sweep leaves its `workflow_result` terminal row untouched.

## Risks / Notes

- **Race window:** a run completing while the sweep runs is guarded by the per-run `terminal_run_ids` re-check immediately before marking (the runner persists the `workflow_result` envelope before terminalizing anything). Residual risk is minimal and the sweep is best-effort.
- **Multi-worker deployments:** an age-based sweep can, in rare cases, fail a run that another live worker is still processing past the threshold. Mitigated by requiring BOTH the age threshold AND no terminal `workflow_result`; deployment currently uses one worker process.
- **Bounded list:** the dashboard now shows the most recent 100 runs per org. Full pagination is intentionally out of scope (this incident is about performance, not UX).
- **Out of scope:** making strands `execution_timeout` enforceable against sync-blocking nodes, RQ `job_timeout` changes, SSE architecture changes.

## Self-Review

- **Spec coverage:** both agreed fixes are covered — (a) recovery sweep (Tasks 1-4, boot + cron), (b) bounded list query (Task 5). General context: Task 3 covers idempotency guard; Task 4 covers self-heal schedule; Task 5 covers the 30s timeout.
- **Placeholder scan:** no TBD/TODO; every code step contains real code; no references to undefined symbols.
- **Type consistency:** `list_stuck` (Task 1) → `mark_stale_runs_failed` (Task 3); `terminal_run_ids` (Task 2) → Task 3; `mark_stale_runs_failed`/`reconcile_stale_on_boot` (Task 3) → Task 4; `list_github_workflows_record(limit=...)` (Task 5) matches the route's keyword call. Names are identical across tasks.