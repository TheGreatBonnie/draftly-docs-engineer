# PR-Run Persistence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every persistence write on the GitHub PR-run path fail-open after the idempotency claim, write the terminal jobs row before the events row, reconcile the fanned-out read-model statuses (per-run on replay + a backfill sweep), and promote the live evaluation verdict into the first-class `evaluations` / `feedback_outcomes` stores (including the pause-time jobs row).

**Architecture:** Four bounded edits around `WorkflowRunner` terminal handling plus one new reconciliation module:
1. **G1** — `runner._mark` becomes fail-open; in `_finish_result` every branch moves `_persist_lifecycle(<terminal>)` before `_mark(<terminal>)` so the durable jobs row (with evaluation embedded) is written first.
2. **G3a** — new `workflows/documentation/reconciliation.py:reconcile_run` treats the `events` row as source of truth and aligns `jobs` + `github_workflows`; wired into the `DUPLICATE` replay branch of `run_pull_request_workflow`.
3. **G3b** — `EventRepository.list_recent_runs(limit)` + `reconcile_stale_runs(context, limit)` sweep + `scripts/reconcile_runs.py` CLI.
4. **E1/E2/E3** — new `runner._persist_evaluation_outcome` writes the gate verdict to `repositories.evaluations.create(...)` and `feedback_outcomes.save_outcome(org_id, "evaluation_gate", run_id, ...)` on `COMPLETED`/`FAILED`, and the `INTERRUPTED` branch carries the verdict in the pending lifecycle result.

**Tech Stack:** Python 3.11, asyncpg-backed stores, Strands (`MultiAgentResult`/`GraphResult`/`Status`), structlog, pytest-asyncio, ruff. No new dependencies, no new migrations.

**Spec:** `docs/superpowers/specs/pr-run-persistence-gaps.md`

## Global Constraints

- **TDD Iron Law:** no production change without a failing (or failing-to-import) test first.
- **No new dependencies.** No new SQL migrations (all tables exist).
- **Fail-open after claim:** no write on the live PR path may raise out of the workflow except the idempotency claim. New writes follow the existing pattern: `try/except` + `logger.<warning|exception>("..._failed", run_id=..., exc_info=True)`.
- **Terminal-first ordering:** `_persist_lifecycle(<terminal>, ...)` must complete before `_mark(<terminal>)` in every branch of `_finish_result`.
- **Existing tests must keep passing.** In particular `tests/workflows/test_phase5_runner_events.py` (`test_completed_marks_delivered` asserts `events.statuses`, `test_completed_persists_evaluation_details` asserts the jobs result, `test_interrupted_stores_and_pends`), `tests/workflows/test_runner_broadcast.py`, `tests/workflows/test_github_pr_workflow.py`, and `tests/workflow/test_runner_resume_logs.py`.
- **Org-scoping:** evaluation rows require `org_id` from `event["project_id"]`; skip the first-class evaluation write when it is missing, in tests, or when no verdict exists.
- **Commit policy:** this plan's steps include commits; if the executing session's operator has said "don't commit", skip the commit steps and note it.
- **Working dir for all commands:** `draftly-agent-backend/` (repo root is `/Applications/Projects/hackathon/draftly-docs-engineer`, backend is its `draftly-agent-backend` subdirectory). Use `.venv/bin/pytest` / `.venv/bin/python`. After the final task, run `graphify update .` from the repo root (AGENTS.md).
- **ruff clean** on every touched file: `ruff check <file> --fix` then re-run.

---

### Task 1: Gap G1 — fail-open events mark + terminal-first persistence ordering

**Why:** The terminal `events.mark_status` is the only non-fail-open write after the claim and runs **after** the delivery side effect. If it raises, RQ retries replay the *same* delivery, the claim then returns `False`, the runner returns `DUPLICATE`, and the run's rows stay at `running` — content delivered, every read-model lying. Worse, `_mark` currently runs **before** `_persist_lifecycle`, so a mark failure also silently drops the durable jobs terminal row (which embeds the evaluation). Making `_mark` fail-open and reordering to write the jobs row first guarantees a durable terminal record on every exit path. Every later task builds on this foundation.

**Files:**
- Modify: `src/draftly/workflows/runner.py:987-994` (`_mark` — fail-open)
- Modify: `src/draftly/workflows/runner.py:448-516` (`_finish_result` — reorder COMPLETED / FAILED / INTERRUPTED branches; Task 4 also edits the same region)
- Test: `tests/workflows/test_runner_terminal_persistence.py` (new)

**Interfaces:**
- Consumes: `WorkflowRunner`, `WorkflowContext`, `WorkflowState`, `draftly.workflows.runner` (existing). Test doubles reuse the phase-5 fakes shape (`FakeEventsRepo`, `FakeJobsRepo`, `FakeGitHubWorkflowsRepo`).
- Produces: `WorkflowRunner._mark` now swallows `events.mark_status` errors (logs `event_status_persist_failed`). Behavioral contract for later tasks: on `COMPLETED`/`FAILED`/`INTERRUPTED`, the last `jobs.update_status` call's index in the call log precedes the last `events.mark_status` call's index.
- Import contract for later tasks: the file must still build with `pytest` (no `datetime` needed here; Task 4 adds `from datetime import UTC, datetime`).

- [ ] **Step 1: Write the failing tests**

Create `tests/workflows/test_runner_terminal_persistence.py`:

```python
"""Runner terminal persistence: jobs/github_workflows go terminal before the
events row, and a failed events mark never aborts a delivered/failed run."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from strands.multiagent.base import MultiAgentResult, Status

from draftly.workflows.context import WorkflowContext
from draftly.workflows.runner import WorkflowRunner

PR_EVENT = {
    "event_id": "evt-1",
    "event_type": "pull_request.merged",
    "repository": "acme/api",
    "actor": "dev",
    "source": "github",
    "project_id": "org-1",
}

# A single shared list so ordering (jobs-before-events for the terminal write)
# is comparable across writers; the claim entry is inert to the assertion.
Timeline = list[tuple[str, str]]


@dataclass
class FakeEventsRepo:
    timeline: Timeline = field(default_factory=list)
    failing: bool = False

    async def try_claim(self, event_id, **kwargs):
        self.timeline.append(("claim", event_id))
        return True

    async def find_by_event_id(self, event_id):
        return {"event_id": event_id, "status": "running"}

    async def mark_status(self, event_id, status):
        if self.failing:
            raise RuntimeError("events db down")
        self.timeline.append(("events", status))


@dataclass
class FakeJobsRepo:
    timeline: Timeline = field(default_factory=list)

    async def update_status(self, **kwargs):
        self.timeline.append(("jobs", kwargs["status"]))


@dataclass
class FakeGitHubWorkflowsRepo:
    timeline: Timeline = field(default_factory=list)

    async def update_status(self, **kwargs):
        self.timeline.append(("workflows", kwargs["status"]))


class FakeGraph:
    def __init__(self, result):
        self.result = result

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        return self.result


def make_context(events: FakeEventsRepo | None = None) -> WorkflowContext:
    timeline: Timeline = []
    events = events or FakeEventsRepo(timeline=timeline)
    return WorkflowContext(
        repositories=type(
            "Repos", (), {
                "events": events,
                "jobs": FakeJobsRepo(timeline=timeline),
                "github_workflows": FakeGitHubWorkflowsRepo(timeline=timeline),
            }
        )()
    )


def completed_result() -> MultiAgentResult:
    return MultiAgentResult(status=Status.COMPLETED)


def failed_result() -> MultiAgentResult:
    result = MultiAgentResult(status=Status.FAILED)
    result.failed_nodes = 1
    result.execution_order = [SimpleNamespace(node_id="update", execution_status=Status.FAILED)]
    return result


async def run_result(result: MultiAgentResult, events: FakeEventsRepo | None = None):
    context = make_context(events=events)
    runner = WorkflowRunner(context, graph_factory=lambda run_id, surface: FakeGraph(result))
    state = await runner.run(dict(PR_EVENT))
    return state, context


def _terminal_index(timeline: Timeline, who: str, status: str) -> int:
    return next(i for i, (w, s) in enumerate(timeline) if w == who and s == status)


async def test_completed_writes_lifecycle_before_events_mark() -> None:
    status, context = await run_result(completed_result())

    assert status.status.value == "delivered"
    timeline = context.repositories.events.timeline
    assert _terminal_index(timeline, "jobs", "completed") < _terminal_index(timeline, "events", "completed")


async def test_failed_writes_lifecycle_before_events_mark() -> None:
    status, context = await run_result(failed_result())

    assert status.status.value == "failed"
    timeline = context.repositories.events.timeline
    assert _terminal_index(timeline, "jobs", "failed") < _terminal_index(timeline, "events", "failed")


async def test_events_mark_failure_does_not_abort_completed_run() -> None:
    status, context = await run_result(completed_result(), events=FakeEventsRepo(failing=True))

    assert status.status.value == "delivered"
    assert ("jobs", "completed") in context.repositories.jobs.timeline


async def test_events_mark_failure_does_not_abort_failed_run() -> None:
    status, context = await run_result(failed_result(), events=FakeEventsRepo(failing=True))

    assert status.status.value == "failed"
    assert ("jobs", "failed") in context.repositories.jobs.timeline
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/workflows/test_runner_terminal_persistence.py -v`
Expected: FAIL — `test_events_mark_failure_does_not_abort_completed_run` raises `RuntimeError("events db down")` out of `runner.run`; the ordering tests fail because the jobs terminal write happens after (or never before) the events mark.

- [ ] **Step 3: Make `_mark` fail-open**

In `src/draftly/workflows/runner.py`, replace `_mark` (lines 987-994):

```python
    async def _mark(self, event: dict[str, Any], status: str) -> None:
        events = self.context.events
        if events is None:
            return
        marker = getattr(events, "mark_status", None)
        if marker is None:
            return
        try:
            await marker(str(event.get("event_id")), status)
        except Exception:
            logger.warning(
                "event_status_persist_failed",
                event_id=str(event.get("event_id")),
                status=status,
                exc_info=True,
            )
```

- [ ] **Step 4: Reorder `_finish_result` so lifecycle runs before the mark**

In `src/draftly/workflows/runner.py` `_finish_result` (lines 448-515):

COMPLETED branch — change the block at lines 470-493 from `... persist delivery ...; _mark("completed"); _persist_lifecycle("completed", ...)` to terminal-first (ignore Task 4's evaluation helper for now):

```python
        if result.status == Status.COMPLETED:
            evaluation = self._node_payload(result, "evaluate")
            lifecycle_result: dict[str, Any] = {"status": "COMPLETED"}
            if evaluation:
                lifecycle_result["evaluation"] = evaluation
            await self._persist_document_changes(event, run_id, result)
            delivered_receipt = await self._persist_delivery_result(event, run_id, result)
            if delivered_receipt is not None:
                await self._resolve_support_thread(state, delivered_receipt)
            await self._persist_lifecycle(
                event,
                "completed",
                run_id=run_id,
                result=lifecycle_result,
            )
            await self._mark(event, "completed")
            await _post_run_memory(self.context, state, surface)
            await self._broadcast_lifecycle(
                org_id=str(event.get("project_id") or ""),
                run_id=run_id,
                status="completed",
                surface=surface,
            )
            return state.finish(WorkflowStatus.DELIVERED)
```

FAILED branch — change the block at lines 501-508 from `_mark("failed"); _persist_lifecycle(...)` to terminal-first:

```python
        failed = self._failed_node_ids(result)
        state.errors.extend(failed)
        evaluation = self._node_payload(result, "evaluate")
        lifecycle_result = {"status": "FAILED", "failed_nodes": failed}
        if evaluation:
            lifecycle_result["evaluation"] = evaluation
        await self._persist_lifecycle(
            event,
            "failed",
            run_id=run_id,
            error="; ".join(failed) or "workflow failed",
            result=lifecycle_result,
        )
        await self._mark(event, "failed")
        await self._broadcast_lifecycle(
            org_id=str(event.get("project_id") or ""),
            run_id=run_id,
            status="failed",
            surface=surface,
        )
        return state.finish(WorkflowStatus.FAILED)
```

INTERRUPTED branch — swap so `_persist_lifecycle("pending_review")` precedes `_mark("pending_review")` (the lifecycle `result=` argument is added here as in the current code; Task 4 enriches it with the evaluation):

```python
        if result.status == Status.INTERRUPTED:
            await self._store_interrupts(run_id, surface, result, state)
            await self._persist_lifecycle(event, "pending_review", run_id=run_id)
            await self._mark(event, "pending_review")
            await self._broadcast_lifecycle(
                org_id=str(event.get("project_id") or ""),
                run_id=run_id,
                status="pending_review",
                surface=surface,
            )
            await self._notify_reviewers(run_id)
            return state.finish(WorkflowStatus.PENDING_REVIEW)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/workflows/test_runner_terminal_persistence.py -v`
Expected: PASS (4 passed).

- [ ] **Step 6: Run the affected existing runner tests**

Run: `.venv/bin/pytest tests/workflows/test_phase5_runner_events.py tests/workflows/test_runner_broadcast.py tests/workflow/test_runner_resume_logs.py tests/workflow/test_runner_post_run_memory.py tests/workflow/test_runner_notify.py -q`
Expected: PASS. (Task 3 extends phase-5 fakes later; nothing here breaks.)

- [ ] **Step 7: ruff + commit**

```bash
ruff check src/draftly/workflows/runner.py tests/workflows/test_runner_terminal_persistence.py --fix
git add src/draftly/workflows/runner.py tests/workflows/test_runner_terminal_persistence.py
git commit -m "fix(runner): fail-open events mark; write lifecycle before events status"
```

---

### Task 2: Gap G3a — `reconcile_run` + wire into the PR replay branch

**Why:** Status is fanned out to four tables (`events.status`, `jobs.status`, `github_workflows.status`, `agent_runs.status`) with no reconciliation. A replayed event whose original run already finished stays at `running` forever, and pre-existing skew (events terminal, jobs `running`) is never healed — exactly the state G1's failure mode leaves behind. Treating the events row as the source of truth and aligning the read-models on `DUPLICATE` replays makes every replay self-healing and idempotent.

**Files:**
- Create: `src/draftly/workflows/documentation/reconciliation.py`
- Modify: `src/draftly/workflows/documentation/github_pr_workflow.py:56-62` (`DUPLICATE` branch)
- Test: `tests/workflows/test_reconciliation.py` (new)
- Test: `tests/workflows/test_github_pr_workflow.py` (add duplicate-replay reconcile test)

**Interfaces:**
- Consumes: `WorkflowContext` (its `.events` property returns `repositories.events`); duck-typed `find_by_event_id(event_id) -> dict | None` and `update_status(job_id=..., status=...)` / `update_status(workflow_id=..., status=...)`.
- Produces:
  - `reconciliation.reconcile_run(context, run_id) -> str | None` — returns the reconciled terminal status or `None` when there is nothing to align; never raises.
  - `reconciliation.terminal_statuses: frozenset[str]` — `{"completed", "failed", "pending_review", "skipped"}`.
  - Wire contract (consumed by Task 3): the sweep calls `reconcile_run` per recent event.

- [ ] **Step 1: Write the failing tests**

Create `tests/workflows/test_reconciliation.py`:

```python
"""Reconciliation: the events row is the source of truth for read-model statuses."""

from __future__ import annotations

from dataclasses import dataclass, field

from draftly.workflows.context import WorkflowContext
from draftly.workflows.documentation.reconciliation import (
    reconcile_run,
    reconcile_stale_runs,
)


@dataclass
class FakeEvents:
    rows: dict[str, str] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)

    async def find_by_event_id(self, event_id):
        status = self.rows.get(event_id)
        if status is None:
            return None
        return {"event_id": event_id, "status": status}

    async def list_recent_runs(self, *, limit=100):
        return [{"event_id": eid, "status": self.rows[eid]} for eid in self.order[:limit]]


@dataclass
class FakeReadModel:
    updates: list[dict] = field(default_factory=list)
    failing: bool = False

    async def update_status(self, **kwargs):
        if self.failing:
            raise RuntimeError("db down")
        self.updates.append(kwargs)


def make_context(events=None, jobs=None, workflows=None) -> WorkflowContext:
    return WorkflowContext(
        repositories=type(
            "Repos", (), {
                "events": events or FakeEvents(),
                "jobs": jobs or FakeReadModel(),
                "github_workflows": workflows or FakeReadModel(),
            }
        )()
    )


async def test_reconcile_aligns_jobs_and_workflows_from_terminal_event() -> None:
    context = make_context(events=FakeEvents(rows={"evt-1": "completed"}))

    status = await reconcile_run(context, "evt-1")

    assert status == "completed"
    assert context.repositories.jobs.updates == [{"job_id": "evt-1", "status": "completed"}]
    assert context.repositories.github_workflows.updates == [
        {"workflow_id": "evt-1", "status": "completed"}
    ]


async def test_reconcile_noop_for_inflight_or_missing_event() -> None:
    events = FakeEvents(rows={"evt-2": "running"})
    context = make_context(events=events)

    assert await reconcile_run(context, "evt-2") is None
    assert await reconcile_run(context, "evt-missing") is None
    assert context.repositories.jobs.updates == []
    assert context.repositories.github_workflows.updates == []


async def test_reconcile_best_effort_when_job_write_fails() -> None:
    context = make_context(
        events=FakeEvents(rows={"evt-1": "failed"}),
        jobs=FakeReadModel(failing=True),
    )

    status = await reconcile_run(context, "evt-1")

    assert status == "failed"
    assert context.repositories.github_workflows.updates == [
        {"workflow_id": "evt-1", "status": "failed"}
    ]


async def test_sweep_reconciles_only_terminal_recent_runs() -> None:
    events = FakeEvents(rows={"a": "completed", "b": "running", "c": "failed"}, order=["a", "b", "c"])
    context = make_context(events=events)

    count = await reconcile_stale_runs(context, limit=10)

    assert count == 2
    jobs = [u["job_id"] for u in context.repositories.jobs.updates]
    assert jobs == ["a", "c"]
```

Add to `tests/workflows/test_github_pr_workflow.py` (extend `make_context` plus one test):

```python
from dataclasses import dataclass, field

# --- add next to the existing fakes ------------------------------------
@dataclass
class FakeEventsRepo:
    rows: dict[str, str] = field(default_factory=dict)

    async def find_by_event_id(self, event_id):
        status = self.rows.get(event_id)
        if status is None:
            return None
        return {"event_id": event_id, "status": status}
```

Then extend `make_context` in that file to accept and expose events (note: `github_workflows.update_status` must be an `AsyncMock` so the reconcile call is awaitable):

```python
def make_context(**overrides: Any) -> WorkflowContext:
    jobs = MagicMock()
    jobs.update_status = AsyncMock()
    workflows = MagicMock()
    workflows.update_status = AsyncMock()
    return WorkflowContext(
        repositories=MagicMock(
            jobs=jobs,
            events=overrides.pop("events", None),
            github_workflows=workflows,
        ),
        **overrides,
    )
```

And add this test:

```python
async def test_duplicate_replay_reconciles_terminal_status() -> None:
    import draftly.workflows.documentation.github_pr_workflow as mod
    from draftly.workflows.documentation.github_pr_workflow import (
        run_pull_request_workflow,
    )

    context = make_context(events=FakeEventsRepo(rows={"ev-d": "completed"}))

    class DupRunner:
        def __init__(self, context, *, publisher=None):
            pass

        async def run(self, event):
            state = MagicMock()
            state.run_id = "ev-d"
            state.status = WorkflowStatus.DUPLICATE
            return state

    mod.WorkflowRunner = DupRunner
    await run_pull_request_workflow(context, {"event_id": "ev-d"}, run_id="ev-d")

    calls = context.repositories.jobs.update_status.await_args_list
    assert any(c.kwargs["status"] == "completed" for c in calls)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/workflows/test_reconciliation.py tests/workflows/test_github_pr_workflow.py -q`
Expected: FAIL with `ModuleNotFoundError: no module named 'draftly.workflows.documentation.reconciliation'` and the duplicate-replay test failing because the `DUPLICATE` branch does not reconcile.

- [ ] **Step 3: Create the reconciliation module**

Create `src/draftly/workflows/documentation/reconciliation.py`:

```python
"""Status reconciliation between the events row (source of truth) and the
jobs / github_workflows read-model rows.

Heals the fanned-out status skew on the PR path: an events terminal write
that succeeded while the jobs write failed, or a replayed event whose
original run already finished. Idempotent and best-effort by design.
"""

from __future__ import annotations

import structlog

from draftly.workflows.context import WorkflowContext

logger = structlog.get_logger(__name__)

TERMINAL_STATUSES = frozenset({"completed", "failed", "pending_review", "skipped"})


async def reconcile_run(context: WorkflowContext, run_id: str) -> str | None:
    """Align jobs + github_workflows to the events row's terminal status.

    Returns the reconciled status, or ``None`` when there is nothing to
    align (no events row, or the event is still in-flight). Never raises.
    """
    if not run_id:
        return None
    events = getattr(context, "events", None)
    finder = getattr(events, "find_by_event_id", None)
    if events is None or finder is None:
        return None
    row = await finder(run_id)
    if not isinstance(row, dict):
        return None
    status = str(row.get("status") or "")
    if status not in TERMINAL_STATUSES:
        return None
    repositories = getattr(context, "repositories", None)

    jobs = getattr(repositories, "jobs", None)
    job_updater = getattr(jobs, "update_status", None)
    if jobs is not None and job_updater is not None:
        try:
            await job_updater(job_id=run_id, status=status)
        except Exception:
            logger.warning(
                "reconcile_job_status_failed",
                run_id=run_id,
                status=status,
                exc_info=True,
            )

    workflows = getattr(repositories, "github_workflows", None)
    workflow_updater = getattr(workflows, "update_status", None)
    if workflows is not None and workflow_updater is not None:
        try:
            await workflow_updater(workflow_id=run_id, status=status)
        except Exception:
            logger.warning(
                "reconcile_workflow_status_failed",
                run_id=run_id,
                status=status,
                exc_info=True,
            )

    return status


async def reconcile_stale_runs(context: WorkflowContext, *, limit: int = 200) -> int:
    """Sweep recent events and align their read-model rows to terminal status.

    Returns the number of runs reconciled. Best-effort; individual failures
    are logged and skipped.
    """
    events = getattr(context, "events", None)
    lister = getattr(events, "list_recent_runs", None)
    if events is None or lister is None:
        return 0
    rows = await lister(limit=limit)
    reconciled = 0
    for row in rows or []:
        run_id = str((row or {}).get("event_id") or "")
        if await reconcile_run(context, run_id) is not None:
            reconciled += 1
    return reconciled
```

- [ ] **Step 4: Wire into the PR replay branch**

In `src/draftly/workflows/documentation/github_pr_workflow.py`, the `SKIPPED`/`DUPLICATE` branch (lines 58-62):

```python
    elif state.status in (WorkflowStatus.SKIPPED, WorkflowStatus.DUPLICATE):
        # A skip/duplicate (e.g. non-merged PR replayed or idempotency duplicate)
        # is not an error; leave the row as pending/running rather than marking
        # completed/failed so /workflows/{run_id}/events replay stays coherent.
        # On a DUPLICATE replay the original run may already be terminal in the
        # events row — reconcile the read-model rows so a replayed finished run
        # doesn't stay stuck at "running".
        if state.status == WorkflowStatus.DUPLICATE:
            from draftly.workflows.documentation.reconciliation import reconcile_run

            reconciled = await reconcile_run(context, run_id)
            if reconciled is not None:
                logger.info(
                    "pr_workflow_reconciled",
                    run_id=run_id,
                    status=reconciled,
                )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/workflows/test_reconciliation.py tests/workflows/test_github_pr_workflow.py -v`
Expected: PASS.

- [ ] **Step 6: ruff + commit**

```bash
ruff check src/draftly/workflows/documentation/reconciliation.py src/draftly/workflows/documentation/github_pr_workflow.py tests/workflows/test_reconciliation.py tests/workflows/test_github_pr_workflow.py --fix
git add src/draftly/workflows/documentation/reconciliation.py src/draftly/workflows/documentation/github_pr_workflow.py tests/workflows/test_reconciliation.py tests/workflows/test_github_pr_workflow.py
git commit -m "feat(workflows): reconcile read-model statuses from the events row"
```

---

### Task 3: Gap G3b — sweep backfill + `scripts/reconcile_runs.py`

**Why:** Task 2 only heals rows touched by a *future* replay. Rows already stuck at `running` from before the fix need an operational backfill path: `list_recent_runs` feeds a sweep that runs `reconcile_run` over the most-recent events, and `scripts/reconcile_runs.py` makes that sweep invocable manually or from cron without touching application code.

**Files:**
- Modify: `src/draftly/persistence/repositories/events.py` (add `list_recent_runs`)
- Create: `scripts/reconcile_runs.py`
- Test: `tests/persistence/test_events_list_recent_runs.py` (new; verified no existing events-repo test file)

**Interfaces:**
- Consumes: `EventRepository.database.fetch_all(sql, *params)` (existing pattern), `reconciliation.reconcile_stale_runs(context, limit=...)`.
- Produces: `EventRepository.list_recent_runs(*, limit: int = 100) -> Sequence[dict[str, Any]]` returning `[{"event_id": str, "status": str}]` for the most-recent events by `created_at DESC`. The sweep (Task 2) already calls it.

- [ ] **Step 1: Write the failing test**

Create `tests/persistence/test_events_list_recent_runs.py` (no existing events-repository test file exists in `tests/persistence/`; the runner's events fakes live in `tests/workflows/`, so this is a new file):

```python
"""EventRepository.list_recent_runs — reconciliation sweep input."""

from __future__ import annotations

from draftly.persistence.repositories.events import EventRepository


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows

    async def fetch_all(self, query, *params):
        return self._rows


async def test_list_recent_runs_returns_event_id_and_status() -> None:
    repo = EventRepository(database=_FakeDB(
        [{"event_id": "a", "status": "completed"}, {"event_id": "b", "status": "running"}]
    ))

    rows = await repo.list_recent_runs(limit=5)

    assert rows == [
        {"event_id": "a", "status": "completed"},
        {"event_id": "b", "status": "running"},
    ]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest tests/persistence/test_events_list_recent_runs.py -v`
Expected: FAIL with `AttributeError: 'EventRepository' object has no attribute 'list_recent_runs'`.

- [ ] **Step 3: Add `list_recent_runs`**

In `src/draftly/persistence/repositories/events.py`, inside `EventRepository`, after `mark_status` (end of class):

```python
    async def list_recent_runs(self, *, limit: int = 100) -> Sequence[dict[str, Any]]:
        """Recent claimed events with their status, for reconciliation sweeps."""
        query = """
        SELECT event_id, status
        FROM events
        ORDER BY created_at DESC
        LIMIT $1
        """

        rows = await self.database.fetch_all(query, limit)
        return [
            {"event_id": str(r["event_id"]), "status": str(r["status"])}
            for r in rows
        ]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/pytest tests/persistence/test_events_list_recent_runs.py -v`
Expected: PASS.

- [ ] **Step 5: Create the sweep CLI**

Create `scripts/reconcile_runs.py` (mirror `scripts/run_workflow.py`):

```python
#!/usr/bin/env python3
"""Reconcile stale PR-run read-model statuses (jobs, github_workflows) against
the events rows (source of truth). Heals runs left "running" after a failed
terminal events mark or a failed job-row write."""

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from draftly.app.config import get_settings
from draftly.app.lifecycle import create_application
from draftly.workflows.documentation.reconciliation import reconcile_stale_runs


async def main() -> int:
    parser = argparse.ArgumentParser(description="Reconcile stale PR-run statuses")
    parser.add_argument(
        "--limit",
        type=int,
        default=200,
        help="Most recent events to scan",
    )
    args = parser.parse_args()

    if not os.getenv("DATABASE_URL"):
        print("ERROR: DATABASE_URL not set")
        return 1

    application = create_application(settings=get_settings())
    await application.startup()
    try:
        assert application.workflows is not None
        context = application.workflows.context
        reconciled = await reconcile_stale_runs(context, limit=args.limit)
        print(f"Reconciled {reconciled} runs")
    finally:
        await application.shutdown()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

- [ ] **Step 6: Smoke-check the CLI against its fakes contract (no DB)**

Run: `.venv/bin/python -c "import ast; ast.parse(open('scripts/reconcile_runs.py').read())"`
Expected: exits 0 (syntax-valid). The script itself requires `DATABASE_URL` (skipped here).

- [ ] **Step 7: ruff + commit**

```bash
ruff check src/draftly/persistence/repositories/events.py scripts/reconcile_runs.py tests/persistence/test_events_list_recent_runs.py --fix
git add src/draftly/persistence/repositories/events.py scripts/reconcile_runs.py tests/persistence/test_events_list_recent_runs.py
git commit -m "feat(events): list recent runs + reconciliation sweep CLI"
```

---

### Task 4: Gaps E1/E2/E3 — first-class evaluation persistence + pause-time verdict

**Why:** The gate verdict currently lives only as JSONB embedded in `jobs.result["evaluation"]` (a single best-effort write = single point of failure) plus an opaque episodic record. Aggregating quality telemetry means parsing JSONB, and `evaluations`/`feedback_outcomes` are only ever written by the scheduled `evaluation_loop`, never by the live PR run — so a merged PR contributes no gate telemetry. Promoting the verdict to the first-class stores (both already wired into the app composition; `feedback_outcomes` is upsert-keyed by run, so it is idempotent) and embedding it in the paused-run jobs row closes the last durability gap.

**Files:**
- Modify: `src/draftly/workflows/runner.py` (imports — add `from datetime import UTC, datetime`; add `_persist_evaluation_outcome` method; extend COMPLETED / FAILED branches in `_finish_result` to call it; extend the INTERRUPTED branch to carry the evaluation in the pending lifecycle result)
- Test: `tests/workflows/test_runner_evaluation_persistence.py` (new)

**Interfaces:**
- Consumes: `_node_payload(result, "evaluate") -> dict` (runner.py:670) — payload keys `passed: bool`, `score: float`, `reasons: list[str]`, `iteration: int`; duck-typed `repositories.evaluations.create(**kwargs)` and `repositories.feedback_outcomes.save_outcome(org_id, source_type, source_id, outcome)` (both already composed at app/dependencies.py:297/315).
- Produces: `WorkflowRunner._persist_evaluation_outcome(event, run_id, evaluation) -> None` — writes the verdict to `evaluations` (`evaluation_type="evaluation_gate"`, `score` converted to 0-100, `passed`/`status` derived) and to `feedback_outcomes` (`source_type="evaluation_gate"`, `source_id=run_id`); fail-open; no-op when `evaluation` is empty or `org_id` is missing. PENDING_REVIEW sets `lifecycle_result["evaluation"]` when available.

- [ ] **Step 1: Write the failing tests**

Create `tests/workflows/test_runner_evaluation_persistence.py`:

```python
"""First-class evaluation persistence on the live PR path (gaps E1/E2/E3)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from strands.multiagent.base import MultiAgentResult, Status

from draftly.workflows.context import WorkflowContext
from draftly.workflows.runner import WorkflowRunner

PR_EVENT = {
    "event_id": "evt-1",
    "event_type": "pull_request.merged",
    "repository": "acme/api",
    "actor": "dev",
    "source": "github",
    "project_id": "org-1",
}

PASSING_EVAL = {"passed": True, "score": 0.91, "reasons": ["Grounded in 4/4 sources"], "iteration": 1}
FAILING_EVAL = {
    "passed": False,
    "score": 0.42,
    "reasons": ["Score 0.42 (threshold: 0.70)"],
    "iteration": 3,
}


@dataclass
class FakeEventsRepo:
    async def try_claim(self, event_id, **kwargs):
        return True

    async def find_by_event_id(self, event_id):
        return {"event_id": event_id, "status": "running"}

    async def mark_status(self, event_id, status):
        return None


@dataclass
class FakeJobsRepo:
    calls: list[dict] = field(default_factory=list)

    async def update_status(self, **kwargs):
        self.calls.append(kwargs)
        return kwargs


@dataclass
class FakeGitHubWorkflowsRepo:
    async def update_status(self, **kwargs):
        return kwargs


@dataclass
class FakeEvalsRepo:
    created: list[dict] = field(default_factory=list)
    failing: bool = False

    async def create(self, **kwargs):
        if self.failing:
            raise RuntimeError("evaluations db down")
        self.created.append(kwargs)
        return {"id": f"eval-{len(self.created)}"}


@dataclass
class FakeOutcomesRepo:
    saved: list[tuple] = field(default_factory=list)
    failing: bool = False

    async def save_outcome(self, org_id, source_type, source_id, outcome):
        if self.failing:
            raise RuntimeError("outcomes db down")
        self.saved.append((org_id, source_type, source_id, outcome))
        return "out-1"


def evaluate_node(payload: dict) -> SimpleNamespace:
    return SimpleNamespace(
        node_id="evaluate",
        result=SimpleNamespace(
            result=SimpleNamespace(
                results={
                    "evaluate": SimpleNamespace(
                        result=SimpleNamespace(
                            message={"content": [{"text": json.dumps(payload)}]}
                        )
                    )
                }
            )
        ),
    )


def completed_result(evaluation: dict | None = None) -> MultiAgentResult:
    result = MultiAgentResult(status=Status.COMPLETED)
    if evaluation:
        result.execution_order = [evaluate_node(evaluation)]
    return result


def failed_result(evaluation: dict) -> MultiAgentResult:
    result = MultiAgentResult(status=Status.FAILED)
    result.failed_nodes = 1
    result.execution_order = [
        SimpleNamespace(node_id="update", execution_status=Status.FAILED),
        evaluate_node(evaluation),
    ]
    return result


def interrupted_result(evaluation: dict) -> MultiAgentResult:
    result = MultiAgentResult(status=Status.INTERRUPTED)
    result.interrupts = [SimpleNamespace(id="int-1", reason={"summary": "doc-review"})]
    result.execution_order = [evaluate_node(evaluation)]
    return result


class FakeGraph:
    def __init__(self, result):
        self.result = result

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        return self.result


def make_context(evals: FakeEvalsRepo | None = None, outcomes: FakeOutcomesRepo | None = None) -> WorkflowContext:
    return WorkflowContext(
        repositories=type(
            "Repos", (), {
                "events": FakeEventsRepo(),
                "jobs": FakeJobsRepo(),
                "github_workflows": FakeGitHubWorkflowsRepo(),
                "evaluations": evals or FakeEvalsRepo(),
                "feedback_outcomes": outcomes or FakeOutcomesRepo(),
            }
        )()
    )


async def run_result(result: MultiAgentResult, context: WorkflowContext):
    runner = WorkflowRunner(context, graph_factory=lambda run_id, surface: FakeGraph(result))
    return await runner.run(dict(PR_EVENT))


async def test_completed_persists_evaluation_to_both_stores() -> None:
    context = make_context()
    state = await run_result(completed_result(PASSING_EVAL), context)

    assert state.status.value == "delivered"
    record = context.repositories.evaluations.created[0]
    assert record["evaluation_type"] == "evaluation_gate"
    assert record["run_id"] == "evt-1"
    assert record["org_id"] == "org-1"
    assert record["trace_id"] == "evt-1"
    assert record["passed"] is True
    assert record["status"] == "passed"
    assert record["score"] == 91.0
    org, source_type, source_id, outcome = context.repositories.feedback_outcomes.saved[0]
    assert (org, source_type, source_id) == ("org-1", "evaluation_gate", "evt-1")
    assert outcome["status"] == "passed"


async def test_failed_persists_evaluation_as_failed() -> None:
    context = make_context()
    state = await run_result(failed_result(FAILING_EVAL), context)

    assert state.status.value == "failed"
    record = context.repositories.evaluations.created[0]
    assert record["passed"] is False
    assert record["status"] == "failed"
    assert record["score"] == 42.0
    assert record["metrics"]["reasons"] == ["Score 0.42 (threshold: 0.70)"]
    assert context.repositories.feedback_outcomes.saved[0][3]["status"] == "failed"


async def test_pending_review_carries_evaluation_in_jobs_result() -> None:
    context = make_context()
    state = await run_result(interrupted_result(PASSING_EVAL), context)

    assert state.status.value == "pending_review"
    pending = context.repositories.jobs.calls[-1]
    assert pending["status"] == "pending_review"
    assert pending["result"]["evaluation"]["passed"] is True
    assert context.repositories.evaluations.created == []


async def test_evaluation_persist_failure_is_fail_open() -> None:
    context = make_context(evals=FakeEvalsRepo(failing=True))
    state = await run_result(completed_result(PASSING_EVAL), context)

    assert state.status.value == "delivered"
    org, source_type, source_id, outcome = context.repositories.feedback_outcomes.saved[0]
    assert (org, source_type, source_id) == ("org-1", "evaluation_gate", "evt-1")


async def test_no_evaluation_no_first_class_write() -> None:
    context = make_context()
    state = await run_result(completed_result(), context)

    assert state.status.value == "delivered"
    assert context.repositories.evaluations.created == []
    assert context.repositories.feedback_outcomes.saved == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/workflows/test_runner_evaluation_persistence.py -v`
Expected: FAIL — `test_pending_review_carries_evaluation_in_jobs_result` sees no `result` on the pending lifecycle call, and the completed/failed tests see no evaluations/outcomes writes.

- [ ] **Step 3: Add the `_persist_evaluation_outcome` helper**

In `src/draftly/workflows/runner.py`:

Add the import at the top (next to `import json`):

```python
from datetime import UTC, datetime
```

Add the helper method after `_persist_lifecycle` (after line 741):

```python
    async def _persist_evaluation_outcome(
        self,
        event: dict[str, Any],
        run_id: str,
        evaluation: dict[str, Any],
    ) -> None:
        """Write the live evaluation-gate verdict to the first-class stores.

        Mirrors the scheduled evaluation loop's persistence (evaluations
        table + feedback_outcomes) for the live PR path so gate telemetry is
        queryable per run instead of only embedded in jobs.result. Fail-open:
        a missing store must never fail the run.
        """
        if not evaluation:
            return
        org_id = str(event.get("project_id") or "") or None
        if not org_id:
            return
        repositories = getattr(self.context, "repositories", None)
        if repositories is None:
            return
        score = float(evaluation.get("score") or 0.0)
        passed = bool(evaluation.get("passed"))
        reasons = [str(r) for r in (evaluation.get("reasons") or [])]
        payload = {
            "passed": passed,
            "score": score,
            "reasons": reasons,
            "status": "passed" if passed else "failed",
        }

        outcomes = getattr(repositories, "feedback_outcomes", None)
        if outcomes is not None and getattr(outcomes, "save_outcome", None) is not None:
            try:
                await outcomes.save_outcome(org_id, "evaluation_gate", run_id, payload)
            except Exception:
                logger.exception("evaluation_outcome_persist_failed", run_id=run_id)

        evals = getattr(repositories, "evaluations", None)
        if evals is not None and getattr(evals, "create", None) is not None:
            try:
                now = datetime.now(UTC)
                await evals.create(
                    org_id=org_id,
                    evaluation_type="evaluation_gate",
                    run_id=run_id,
                    target_id=None,
                    score=round(score * 100.0, 2),
                    passed=passed,
                    status="passed" if passed else "failed",
                    metrics={"reasons": reasons},
                    failures=[{"reason": r} for r in reasons] if not passed else [],
                    trace_id=run_id,
                    started_at=now,
                    completed_at=now,
                )
            except Exception:
                logger.exception("evaluation_record_persist_failed", run_id=run_id)
```

- [ ] **Step 4: Call it from the terminal branches and carry the verdict at pause**

In `_finish_result`:

COMPLETED branch (it currently ends with the reordered block from Task 1): insert the helper call after `_persist_lifecycle("completed", ...)` and before `_mark(event, "completed")`:

```python
            await self._persist_lifecycle(
                event,
                "completed",
                run_id=run_id,
                result=lifecycle_result,
            )
            await self._persist_evaluation_outcome(event, run_id, evaluation)
            await self._mark(event, "completed")
```

FAILED branch — after `_persist_lifecycle("failed", ...)` and before `_mark(event, "failed")`:

```python
        await self._persist_lifecycle(
            event,
            "failed",
            run_id=run_id,
            error="; ".join(failed) or "workflow failed",
            result=lifecycle_result,
        )
        await self._persist_evaluation_outcome(event, run_id, evaluation)
        await self._mark(event, "failed")
```

INTERRUPTED branch — build the pause-time lifecycle result with the verdict; keep `_persist_lifecycle` before `_mark` (Task 1 ordering):

```python
        if result.status == Status.INTERRUPTED:
            await self._store_interrupts(run_id, surface, result, state)
            evaluation = self._node_payload(result, "evaluate")
            pending_result: dict[str, Any] = {"status": "PENDING_REVIEW"}
            if evaluation:
                pending_result["evaluation"] = evaluation
            await self._persist_lifecycle(
                event,
                "pending_review",
                run_id=run_id,
                result=pending_result,
            )
            await self._mark(event, "pending_review")
            await self._broadcast_lifecycle(
                org_id=str(event.get("project_id") or ""),
                run_id=run_id,
                status="pending_review",
                surface=surface,
            )
            await self._notify_reviewers(run_id)
            return state.finish(WorkflowStatus.PENDING_REVIEW)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/workflows/test_runner_evaluation_persistence.py tests/workflows/test_runner_terminal_persistence.py tests/workflows/test_phase5_runner_events.py -v`
Expected: PASS (5 new evaluation tests + 4 terminal tests + existing phase-5 tests). The phase-5 fakes have no `evaluations`/`feedback_outcomes` attributes, so the helper skips them (fail-open + `getattr` default).

- [ ] **Step 6: ruff + commit**

```bash
ruff check src/draftly/workflows/runner.py tests/workflows/test_runner_evaluation_persistence.py --fix
git add src/draftly/workflows/runner.py tests/workflows/test_runner_evaluation_persistence.py
git commit -m "feat(runner): persist evaluation-gate verdict to evaluations + feedback_outcomes; add verdict to pause-time jobs result"
```

---

### Task 5: Full verification

**Why:** Confirm the whole plan holds together: the new + directly affected tests pass under pytest, every touched file is ruff-clean, and the knowledge graph is refreshed so future sessions reason over the final code.

**Files:** none (verification only).

- [ ] **Step 1: Run the new + directly affected tests**

Run:
```bash
.venv/bin/pytest tests/workflows/test_runner_terminal_persistence.py \
  tests/workflows/test_runner_evaluation_persistence.py \
  tests/workflows/test_reconciliation.py \
  tests/workflows/test_github_pr_workflow.py \
  tests/persistence/test_events_list_recent_runs.py -q
```
Expected: PASS.

- [ ] **Step 2: Run the broad workflow/runner/persistence suites**

Run:
```bash
.venv/bin/pytest tests/workflows tests/workflow tests/persistence tests/events -q
```
Expected: PASS. (If any test exists under `tests/repositories` lacking coverage of the changed modules, PASS is still expected — note `tests/repositories` does not exist as a directory and must not be added to the command.)

- [ ] **Step 3: Run the full suite (excluding the environment-dependent online test)**

Run:
```bash
.venv/bin/pytest -q --ignore=tests/integration/test_online.py
```
Expected: PASS. Report the total passed/skipped count as evidence.

- [ ] **Step 4: ruff over all touched files**

Run:
```bash
ruff check src/draftly/workflows/runner.py \
  src/draftly/workflows/documentation/reconciliation.py \
  src/draftly/workflows/documentation/github_pr_workflow.py \
  src/draftly/persistence/repositories/events.py \
  scripts/reconcile_runs.py \
  tests/workflows/test_runner_terminal_persistence.py \
  tests/workflows/test_runner_evaluation_persistence.py \
  tests/workflows/test_reconciliation.py \
  tests/workflows/test_github_pr_workflow.py \
  tests/persistence/test_events_list_recent_runs.py
```
Expected: clean (no findings).

- [ ] **Step 5: Update the knowledge graph + commit**

From the repo root:
```bash
graphify update .
```
Then, from `draftly-agent-backend/`:
```bash
git add docs/superpowers/specs/pr-run-persistence-gaps.md
git commit -m "docs(spec): pr-run persistence gaps analysis"
```
(If the spec was already committed in a Task-0/plan-creation step, skip this commit.)

- [ ] **Step 6: Report**

Report to the operator: the four change areas, the verification counts (suite total, new-test count), and any skipped commits per the Global Constraints commit policy.