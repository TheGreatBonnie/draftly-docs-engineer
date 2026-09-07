# Evaluation Persistence + SSE Live Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the backend so evaluation runs actually persist to the `evaluations` table (and surface on the Workflows list via a `jobs` row), then replace the 5-second polling on the Workflows list, sidebar running-count badge, and Evaluations list with the same SSE pattern used by the onboarding init-stages flow.

**Architecture:** Reuse the existing ticket + `EventSourceResponse` SSE infrastructure. Backend: `run_evaluation_loop` streams `StreamEnvelope`s (stage/progress/result) over the same event bus as onboarding, persists via a new `EvaluationRepository.save_run_summary`, and publishes org-scoped `workflow:changed` / `evaluation:created` frames to the existing Redis dashboard broadcaster. `WorkflowRunner` publishes `workflow:changed` frames for normal PR runs. Frontend: a `LiveEventsProvider` owns one dashboard `EventSource` and exposes `useLiveVersion(types)`; a `useLiveRefresh` hook does initial fetch + refetch-on-event + slow 30s fallback poll, and the three polling consumers switch to it.

**Tech Stack:** FastAPI, `sse_starlette`, Redis (pub/sub + bus), strands multiagent graphs, Next.js 15 (App Router), SWR, vitest, pytest, structlog.

**Spec:** `docs/superpowers/specs/2026-08-27-sse-starlette-migration-design.md` (existing ticket/SSE contract) — this plan extends it with evaluation persistence + dashboard producers. See also reference implementations: `src/draftly/workflows/onboarding/initialize.py` (streaming pattern to mirror), `src/draftly/app/api/routes/workflows.py` (ticket + `/events` + `/events/dashboard` endpoints), `hooks/use-workflow-events.ts` (EventSource client pattern).

## Global Constraints

- **Do NOT run `git commit` at any point.** The user requires no commits. Steps in this plan omit commit steps; finalize with the working tree left dirty.
- Backend tests run with `uv run pytest <path> -q` from `draftly-agent-backend/`. Lint: `uv run ruff check <changed files>`.
- Frontend tests run with `npx vitest run <paths>` from `draftly-agent-frontend/`. Typecheck `npx tsc --noEmit`; lint `npx eslint <dir>`.
- After ALL code changes, run `graphify update .` from the repo root `/Applications/Projects/hackathon/draftly-docs-engineer`.
- Pre-existing failures that are NOT this plan's responsibility and must not be "fixed": backend `tests/test_workers/test_rq_dispatch.py::test_enqueued_job_timeout_exceeds_workflow_watchdog` and `tests/unit/workflows/test_onboarding_initialize.py::test_watchdog_fails_run_stuck_past_timeout`; frontend `__tests__/components/doc-article.test.tsx::DocArticle > renders title, version, category, and real content`. Verify they still fail before completion (2 backend, 1 frontend).
- TDD: every change starts with a failing test.
- Backend event names published to the dashboard feed are exactly `workflow:changed` and `evaluation:created`. SSE frame shape: `{"type": <name>, "payload": {...}}`.

---

## File Structure

Backend (`draftly-agent-backend/src/draftly/` + tests in `draftly-agent-backend/tests/`):
- Modify: `persistence/repositories/evaluations.py` — add `list_datasets()` + `save_run_summary(...)`.
- Modify: `integrations/database/evaluations_store.py` — add `run_id` to `insert()`.
- Modify: `workflows/context.py` — add `broadcaster: Any = None` field.
- Modify: `app/composition/workflows.py` — set `context.broadcaster` when Redis + event streaming are available.
- Rewrite: `workflows/evaluation/documentation_evaluation.py` — streaming loop that persists.
- Modify: `workflows/runner.py` — lifecycle `workflow:changed` broadcasts.
- Modify: `app/api/routes/evaluations.py` — pass `org_id` + `run_id` into the loop.
- Modify: `evaluation/runner.py` — `run_id` plumb-through (optional; used by `persist_report`). *(Low priority — include only if store signature requires it.)*
- Tests: `tests/evaluation/test_evaluations_repository.py`, `tests/workflows/test_evaluation_loop.py`, `tests/api/test_evaluations_routes.py` (extend), `tests/workflows/test_runner_broadcast.py`.

Frontend (`draftly-agent-frontend/`):
- Create: `components/live-events/live-events-provider.tsx` (+ `LiveEventsProvider`, `useLiveVersion`).
- Create: `hooks/use-live-refresh.ts`.
- Modify: `components/workflows/workflows.tsx` (`useWorkflows`).
- Modify: `components/dashboard/sidebar.tsx` (`useRunningWorkflowCount`).
- Modify: `components/evaluations/use-evaluations.ts`.
- Modify: `hooks/use-dashboard-events.ts` + `api/events.ts` — fix dashboard-ticket path to match backend (`/workflows/dashboard-ticket`, not `/workflows/events/dashboard-ticket`).
- Modify: `app/(app)/layout.tsx` — mount `LiveEventsProvider`.
- Tests: `__tests__/hooks/use-live-refresh.test.ts`, `components/live-events/__tests__/live-events-provider.test.tsx`, and update existing workflows/sidebar/evaluations tests that assert 5s-poll behavior.

Docs:
- Update: `docs/superpowers/specs/2026-08-27-sse-starlette-migration-design.md` — add dashboard producers + evaluation persistence.

---

### Task 1: Evaluation repository — `list_datasets` + `save_run_summary`

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/database/evaluations_store.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/evaluations.py`
- Test: `draftly-agent-backend/tests/evaluation/test_evaluations_repository.py`

**Interfaces:**
- Consumes: `DatabaseEvaluationsStore` (existing `client.fetch_one`/`fetch_all`), `draftly.evaluation.runner.DATASET_DIR` + `StrandsEvalsRunner`.
- Produces (backend, used by Task 2, 3, 5):
  - `EvaluationRepository.list_datasets() -> list[dict]` — each `{"name": str, "cases": [{"name", "input", "expected_output", "metadata"}]}`.
  - `EvaluationRepository.save_run_summary(*, summary: dict, org_id: str, run_id: str, started_at, completed_at) -> dict | None` — `summary` = `{"total", "passed", "failed", "passed_all", "errors"}`. Returns the inserted row (via `DatabaseEvaluationsStore.insert`).
  - `DatabaseEvaluationsStore.insert(..., run_id: str | None = None)` — new kwarg, stored in the `run_id` column.

- [ ] **Step 1: Write failing tests.**

```python
# tests/evaluation/test_evaluations_repository.py
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from draftly.persistence.repositories.evaluations import EvaluationRepository


class FakeStore:
    def __init__(self) -> None:
        self.inserted: list[dict] = []

    async def insert(self, **kwargs):
        row = {"id": "ev-1", **kwargs}
        self.inserted.append(row)
        return row

    async def get(self, *, evaluation_id: str):
        return None

    async def search(self, *, org_id, evaluation_type, limit):
        return []


def test_list_datasets_returns_serialized_cases(monkeypatch):
    repo = EvaluationRepository(store=FakeStore())
    calls = {"called": False}

    fake_cases = [
        type("Case", (), {"name": "c1", "input": "in", "expected_output": "out", "metadata": {}})(),
    ]

    class FakeRunner:
        @staticmethod
        def load_all_datasets():
            calls["called"] = True
            return {"geometry": fake_cases}

    monkeypatch.setattr(
        "draftly.persistence.repositories.evaluations.StrandsEvalsRunner", FakeRunner
    )

    datasets = repo.list_datasets()

    assert calls["called"] is True
    assert datasets == [
        {"name": "geometry", "cases": [
            {"name": "c1", "input": "in", "expected_output": "out", "metadata": {}}
        ]}
    ]


def test_list_datasets_returns_empty_when_no_datasets(monkeypatch):
    repo = EvaluationRepository(store=FakeStore())

    class FakeRunner:
        @staticmethod
        def load_all_datasets():
            return {}

    monkeypatch.setattr(
        "draftly.persistence.repositories.evaluations.StrandsEvalsRunner", FakeRunner
    )
    assert repo.list_datasets() == []


def test_save_run_summary_inserts_via_store():
    store = FakeStore()
    repo = EvaluationRepository(store=store)

    started = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)
    completed = datetime(2026, 9, 2, 9, 1, tzinfo=UTC)
    record = repo.save_run_summary(
        summary={
            "total": 20,
            "passed": 18,
            "failed": 2,
            "passed_all": False,
            "errors": ["dataset-a: boom"],
        },
        org_id="org-9",
        run_id="run-1",
        started_at=started,
        completed_at=completed,
    )

    assert record is not None
    inserted = store.inserted[0]
    assert inserted["org_id"] == "org-9"
    assert inserted["run_id"] == "run-1"
    assert inserted["evaluation_type"] == "documentation"
    assert inserted["score"] == 90.0
    assert inserted["status"] == "failed"
    assert inserted["metrics"] == {"cases": 20, "passed": 18, "failed": 2}
    assert inserted["failures"] == [{"case": "dataset-a", "reason": "boom", "index": 0}]
    assert inserted["started_at"] == started
    assert inserted["completed_at"] == completed


def test_save_run_summary_all_passed_is_passed_status():
    store = FakeStore()
    repo = EvaluationRepository(store=store)

    repo.save_run_summary(
        summary={
            "total": 10,
            "passed": 10,
            "failed": 0,
            "passed_all": True,
            "errors": [],
        },
        org_id="org-9",
        run_id="run-1",
        started_at=datetime(2026, 9, 2, tzinfo=UTC),
        completed_at=datetime(2026, 9, 2, tzinfo=UTC),
    )

    inserted = store.inserted[0]
    assert inserted["status"] == "passed"
    assert inserted["score"] == 100.0


def test_save_run_summary_empty_run_failed_and_zero_score():
    store = FakeStore()
    repo = EvaluationRepository(store=store)

    repo.save_run_summary(
        summary={"total": 0, "passed": 0, "failed": 0, "passed_all": False, "errors": []},
        org_id="org-9",
        run_id="run-1",
        started_at=datetime(2026, 9, 2, tzinfo=UTC),
        completed_at=datetime(2026, 9, 2, tzinfo=UTC),
    )

    inserted = store.inserted[0]
    assert inserted["status"] == "failed"
    assert inserted["score"] == 0.0
```

- [ ] **Step 2: Run to verify they fail.**

Run: `uv run pytest tests/evaluation/test_evaluations_repository.py -q`
Expected: FAIL (AttributeError — `EvaluationRepository` has no `list_datasets`/`save_run_summary`).

- [ ] **Step 3: Implement `run_id` in the store.**

In `draftly-agent-backend/src/draftly/integrations/database/evaluations_store.py`, change `insert`:

```python
    async def insert(
        self,
        *,
        org_id: str,
        evaluation_type: str,
        run_id: str | None = None,
        target_id: str | None,
        score: float,
        status: str,
        metrics: dict[str, Any],
        failures: list[dict[str, Any]],
        started_at: datetime,
        completed_at: datetime,
    ) -> dict[str, Any]:

        evaluation_id = uuid4()

        row = await self.client.fetch_one(
            """
            INSERT INTO evaluations (
                id,
                org_id,
                evaluation_type,
                run_id,
                target_id,
                score,
                status,
                metrics,
                failures,
                started_at,
                completed_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8::JSONB,
                $9::JSONB,
                $10,
                $11
            )
            RETURNING
                id,
                org_id,
                evaluation_type,
                run_id,
                target_id,
                score,
                status,
                metrics,
                failures,
                started_at,
                completed_at
            """,
            evaluation_id,
            org_id,
            evaluation_type,
            run_id,
            target_id,
            score,
            status,
            metrics,
            failures,
            started_at,
            completed_at,
        )
```

Also update `get` and `search` SELECT lists to include `run_id` (add `run_id,` after `evaluation_type,`) so the API/frontend can link evaluations to the run. Verify the rest of `search`/`_to_dict` passes `run_id` through (add to any explicit column list / dict shaping).

- [ ] **Step 4: Implement repository methods.**

In `draftly-agent-backend/src/draftly/persistence/repositories/evaluations.py`:

```python
from __future__ import annotations

from datetime import datetime
from typing import Any

from draftly.evaluation.runner import StrandsEvalsRunner
from draftly.integrations.database.evaluations_store import (
    DatabaseEvaluationsStore,
)


class EvaluationRepository:
    def __init__(
        self,
        store: DatabaseEvaluationsStore | None = None,
    ) -> None:
        self.store = store or DatabaseEvaluationsStore()

    async def create(
        self,
        *,
        org_id: str,
        evaluation_type: str,
        run_id: str | None = None,
        target_id: str | None,
        score: float,
        status: str,
        metrics: dict[str, Any],
        failures: list[dict[str, Any]],
        started_at: datetime,
        completed_at: datetime,
    ) -> dict[str, Any]:
        return await self.store.insert(
            org_id=org_id,
            evaluation_type=evaluation_type,
            run_id=run_id,
            target_id=target_id,
            score=score,
            status=status,
            metrics=metrics,
            failures=failures,
            started_at=started_at,
            completed_at=completed_at,
        )

    def list_datasets(self) -> list[dict[str, Any]]:
        """Golden datasets as serialized dicts for the evaluation graph."""
        loaded = StrandsEvalsRunner.load_all_datasets()
        return [
            {
                "name": name,
                "cases": [
                    {
                        "name": case.name,
                        "input": case.input,
                        "expected_output": getattr(case, "expected_output", None),
                        "metadata": {
                            **(case.metadata or {}),
                            "name": case.name,
                        }
                        if isinstance(case.metadata, dict)
                        else {"name": case.name},
                    }
                    for case in cases
                ],
            }
            for name, cases in loaded.items()
        ]

    async def save_run_summary(
        self,
        *,
        summary: dict[str, Any],
        org_id: str,
        run_id: str,
        started_at: datetime,
        completed_at: datetime,
    ) -> dict[str, Any] | None:
        """Persist a run summary to the evaluations table."""
        total = int(summary.get("total") or 0)
        passed = int(summary.get("passed") or 0)
        failed = int(summary.get("failed") or 0)
        passed_all = bool(summary.get("passed_all") and total > 0)
        errors = list(summary.get("errors") or [])

        score = round((passed / total) * 100.0, 2) if total > 0 else 0.0
        status = "passed" if passed_all else "failed"
        failures = [
            {
                "case": str(error).split(":", maxsplit=1)[0],
                "reason": str(error).split(":", maxsplit=1)[-1].strip(),
                "index": index,
            }
            for index, error in enumerate(errors)
        ]
        metrics = {"cases": total, "passed": passed, "failed": failed}

        try:
            return await self.create(
                org_id=org_id,
                evaluation_type="documentation",
                run_id=run_id,
                target_id=run_id,
                score=score,
                status=status,
                metrics=metrics,
                failures=failures,
                started_at=started_at,
                completed_at=completed_at,
            )
        except Exception:
            from structlog import get_logger

            get_logger(__name__).exception("evaluation_save_summary_failed")
            return None

    async def get(
        self,
        *,
        evaluation_id: str,
    ) -> dict[str, Any] | None:
        return await self.store.get(evaluation_id=evaluation_id)

    async def search(
        self,
        *,
        org_id: str,
        evaluation_type: str | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        return await self.store.search(
            org_id=org_id,
            evaluation_type=evaluation_type,
            limit=limit,
        )
```

- [ ] **Step 5: Run the tests.**

Run: `uv run pytest tests/evaluation/test_evaluations_repository.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Regression check that existing evaluation tests still pass.**

Run: `uv run pytest tests/evaluation tests/api/test_evaluations_routes.py -q`
Expected: PASS (existing tests still green; adjust any that asserted the old `create` signature — they must have been passing `store.insert` without `run_id`, which is additive with a default).

---

### Task 2: `run_evaluation_loop` — stream, persist, jobs row, roadmap

**Files:**
- Rewrite: `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`
- Test: `draftly-agent-backend/tests/workflows/test_evaluation_loop.py`

**Interfaces:**
- Consumes: `WorkflowContext` (with `publisher`, `broadcaster`, `repositories`), `EvaluationRepository.list_datasets` (Task 1), `EvaluationRepository.save_run_summary` (Task 1), `draftly.orchestration.graphs.evaluation_graph.build_evaluation_graph`, `StreamEnvelope`.
- Produces (used by Task 3, 4, 5):
  - `run_evaluation_loop(context, *, org_id: str = "", run_id: str | None = None, datasets: list[dict] | None = None, **kwargs) -> WorkflowState`.
  - Publishes SSE events on the per-run bus: `stage_change`, `stage_manifest`, `stage_progress`, `overall_progress`, `tool_progress`, `workflow_result` (terminal — `{"status": "DELIVERED" | "FAILED"}`).
  - Publishes to dashboard: `workflow:changed` (running + terminal) and `evaluation:created` (payload `{"run_id", "evaluation_id", "status"}`).
  - Creates a `jobs` row via `repositories.jobs.insert(job_id=state.run_id, run_id=state.run_id, org_id=org_id, name="Documentation evaluation", job_type="evaluation", schedule="", configuration={}, status="running")` (best-effort, swallowed on failure). Terminal status via `repositories.jobs.update_status(job_id=run_id, status="completed" | "failed")`.

- [ ] **Step 1: Write failing tests.**

```python
# tests/workflows/test_evaluation_loop.py
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from draftly.workflows.evaluation.documentation_evaluation import run_evaluation_loop
from draftly.workflows.state import WorkflowStatus


class FakePublisher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def publish(self, envelope: Any) -> None:
        self.events.append(envelope.to_dict())


class FakeBroadcaster:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []

    async def broadcast(self, org_id: str, event_type: str, payload: dict) -> bool:
        self.calls.append((org_id, event_type, payload))
        return True


class FakeJobs:
    def __init__(self) -> None:
        self.inserted: list[dict] = []
        self.statuses: list[tuple[str, str]] = []

    async def insert(self, **kwargs: Any) -> dict:
        row = {"id": "job-1", **kwargs}
        self.inserted.append(row)
        return row

    async def update_status(self, *, job_id: str, status: str) -> dict:
        self.statuses.append((job_id, status))
        return {"id": job_id}


class FakeEvaluations:
    def __init__(self, datasets: list[dict] | None = None) -> None:
        self.datasets = datasets if datasets is not None else [{"name": "geometry", "cases": []}]
        self.saved: list[dict] = []

    def list_datasets(self) -> list[dict]:
        return self.datasets

    async def save_run_summary(self, **kwargs: Any) -> dict | None:
        self.saved.append(kwargs)
        return {"id": "ev-1", "status": kwargs.get("summary", {}).get("status", "failed")}


def build_context(**overrides: Any) -> Any:
    publisher = overrides.get("publisher", FakePublisher())
    broadcaster = overrides.get("broadcaster", FakeBroadcaster())
    repositories = SimpleNamespace(
        jobs=FakeJobs(),
        evaluations=FakeEvaluations(overrides.get("datasets")),
    )
    return SimpleNamespace(
        repositories=repositories,
        publisher=publisher,
        broadcaster=broadcaster,
        model=None,
        tools=None,
        config=None,
        review_policy=lambda: None,
        graph_limits=lambda: {},
        storage_dir="",
        context=None,
    )


def test_loop_streams_stage_events_and_result():
    pub = FakePublisher()
    bc = FakeBroadcaster()
    ctx = build_context(publisher=pub, broadcaster=bc)

    state = __import__("asyncio").get_event_loop().run_until_complete(
        run_evaluation_loop(ctx, org_id="org-9", run_id="run-1")
    )

    types = [e["type"] for e in pub.events]
    assert "stage_change" in types
    assert "stage_manifest" in types
    assert "workflow_result" in types
    assert types[-1] == "workflow_result"
    assert pub.events[-1]["payload"]["status"] in ("DELIVERED", "FAILED")

    orgs = [c[0] for c in bc.calls]
    assert "org-9" in orgs
    types_bc = [c[1] for c in bc.calls]
    assert "workflow:changed" in types_bc
    assert "evaluation:created" in types_bc
    assert state.run_id == "run-1"


def test_loop_persists_summary_and_job_row():
    pub = FakePublisher()
    ctx = build_context(publisher=pub)

    __import__("asyncio").get_event_loop().run_until_complete(
        run_evaluation_loop(ctx, org_id="org-9", run_id="run-1")
    )

    jobs = ctx.repositories.jobs
    assert any(r["run_id"] == "run-1" for r in jobs.inserted)

    evals = ctx.repositories.evaluations
    assert len(evals.saved) == 1
    assert evals.saved[0]["org_id"] == "org-9"
    assert evals.saved[0]["run_id"] == "run-1"
    assert sorted(jobs.statuses[-1]) == sorted(["run-1"])


def test_loop_publishes_terminal_job_status():
    pub = FakePublisher()
    ctx = build_context(publisher=pub)

    __import__("asyncio").get_event_loop().run_until_complete(
        run_evaluation_loop(ctx, org_id="org-9", run_id="run-1")
    )

    statuses = ctx.repositories.jobs.statuses
    assert statuses and statuses[-1][0] == "run-1"
    assert statuses[-1][1] in ("completed", "failed")
```

> Note: tests use `asyncio.get_event_loop()` inline for brevity; if the codebase convention prefers `pytest.mark.asyncio` + `asyncio_mode`, match the existing pattern in `tests/workflows/test_onboarding_initialize.py`. Use whatever the surrounding tests use (e.g. `asyncio.run(...)` in a sync test is also fine).

- [ ] **Step 2: Run to verify they fail.**

Run: `uv run pytest tests/workflows/test_evaluation_loop.py -q`
Expected: FAIL (current loop publishes no events, never persists, never touches jobs, signature mismatch).

- [ ] **Step 3: Rewrite the workflow.**

Replace `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`:

```python
"""Documentation evaluation loop workflow (plan §7.2).

Scheduled (or API-triggered): run the deterministic evaluation graph over
golden datasets, stream stage/progress events over the workflow event bus,
and persist the summary to the evaluations repository. Publish org-scoped
``workflow:changed`` / ``evaluation:created`` frames to the dashboard feed.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import structlog
from strands.multiagent.base import Status

from draftly.events.stream_envelope import StreamEnvelope
from draftly.workflows.context import WorkflowContext
from draftly.workflows.state import WorkflowState, WorkflowStatus

logger = structlog.get_logger(__name__)

STAGE_LABELS = {
    "load_datasets": "Load golden datasets",
    "run_experiments": "Run evaluation graph",
    "persist_results": "Persist summary",
}


async def run_evaluation_loop(
    context: WorkflowContext,
    *,
    org_id: str = "",
    run_id: str | None = None,
    datasets: list[dict[str, Any]] | None = None,
    **kwargs: Any,
) -> WorkflowState:
    """Run the evaluation graph; stream progress; persist a summary."""
    del kwargs
    state = WorkflowState(run_id=run_id or f"evaluation-{uuid4()}")
    seq = 0
    started_at = datetime.now(UTC)

    async def _publish(envelope_type: str, payload: dict[str, Any]) -> None:
        nonlocal seq
        if context.publisher is None:
            return
        seq += 1
        await context.publisher.publish(
            StreamEnvelope(
                type=envelope_type,
                run_id=state.run_id,
                surface="evaluation",
                seq=seq,
                payload=payload,
            )
        )
        await asyncio.sleep(0)

    async def _broadcast(event_type: str, payload: dict[str, Any]) -> None:
        broadcaster = getattr(context, "broadcaster", None)
        if broadcaster is None:
            return
        try:
            await broadcaster.broadcast(org_id, event_type, payload)
        except Exception:
            logger.warning(
                "evaluation_broadcast_failed run=%s type=%s",
                state.run_id,
                event_type,
                exc_info=True,
            )

    async def _set_job_status(status: str) -> None:
        jobs = getattr(getattr(context, "repositories", None), "jobs", None)
        if jobs is None:
            return
        try:
            await jobs.update_status(job_id=state.run_id, status=status)
        except Exception:
            logger.warning(
                "evaluation_job_status_failed run=%s status=%s",
                state.run_id,
                status,
                exc_info=True,
            )

    await _publish("stage_change", {"stage": "evaluation_started", "status": "started"})
    await _publish("stage_manifest", {
        "stages": [
            {"id": s, "label": STAGE_LABELS[s], "order": i}
            for i, s in enumerate(STAGE_LABELS)
        ]
    })

    # Ensure a jobs row exists so /stream-ticket resolves this run.
    jobs = getattr(getattr(context, "repositories", None), "jobs", None)
    if jobs is not None:
        try:
            await jobs.insert(
                job_id=state.run_id,
                run_id=state.run_id,
                org_id=org_id,
                name="Documentation evaluation",
                job_type="evaluation",
                schedule="",
                configuration={},
                status="running",
            )
            logger.info("evaluation_job_row run=%s org=%s", state.run_id, org_id)
        except Exception:
            logger.warning("evaluation_job_root_failed run=%s", state.run_id, exc_info=True)
    await _broadcast("workflow:changed", {"run_id": state.run_id, "status": "running", "kind": "evaluation"})

    if datasets is None:
        datasets = await _load_datasets(context)

    await _publish("stage_change", {
        "stage": "load_datasets", "status": "completed",
        "stats": {"datasets": len(datasets)},
    })
    await _publish("stage_progress", {"stage": "load_datasets", "progress": 100})

    await _publish("stage_change", {"stage": "run_experiments", "status": "started"})
    await _publish("stage_progress", {"stage": "run_experiments", "progress": 10})

    from draftly.orchestration.graphs.evaluation_graph import (
        build_evaluation_graph,
    )

    graph = build_evaluation_graph()
    result = await _run_graph(graph, state, datasets)

    await _publish("stage_progress", {"stage": "run_experiments", "progress": 90})

    state.result = result

    if result.status != Status.COMPLETED:
        state.errors.append(f"evaluation graph ended {result.status}")
        await _publish("stage_change", {"stage": "run_experiments", "status": "failed"})
        await _publish("workflow_result", {"status": "FAILED", "error": state.errors[-1]})
        await _set_job_status("failed")
        await _broadcast("workflow:changed", {"run_id": state.run_id, "status": "failed", "kind": "evaluation"})
        return state.finish(WorkflowStatus.FAILED)

    await _publish("stage_change", {"stage": "run_experiments", "status": "completed"})
    await _publish("stage_progress", {"stage": "run_experiments", "progress": 100})

    await _publish("stage_change", {"stage": "persist_results", "status": "started"})
    persisted = await _persist_summary(context, state, org_id=org_id)

    await _publish("stage_change", {"stage": "persist_results", "status": "completed"})
    await _publish("overall_progress", {"progress": 100})
    await _publish("workflow_result", {"status": "DELIVERED"})

    await _set_job_status("completed")
    await _broadcast("workflow:changed", {"run_id": state.run_id, "status": "completed", "kind": "evaluation"})
    if persisted is not None:
        await _broadcast("evaluation:created", {
            "run_id": state.run_id,
            "evaluation_id": str(persisted.get("id") or ""),
            "status": str(persisted.get("status") or "completed"),
        })

    return state.finish(WorkflowStatus.DELIVERED)


async def _run_graph(graph: Any, state: WorkflowState, datasets: list[dict[str, Any]]) -> Any:
    """Invoke the evaluation graph with the loaded datasets."""
    return await graph.invoke_async(
        "{}",
        invocation_state={"run_id": state.run_id, "datasets": datasets},
    )


async def _load_datasets(context: WorkflowContext) -> list[dict[str, Any]]:
    """Load golden datasets from the evaluations repository."""
    evaluations = getattr(getattr(context, "repositories", None), "evaluations", None)
    loader = getattr(evaluations, "list_datasets", None) if evaluations else None
    if loader is None:
        return []
    try:
        return list(loader())
    except Exception:
        logger.exception("evaluation_loop_load_datasets_failed")
        return []


async def _persist_summary(
    context: WorkflowContext,
    state: WorkflowState,
    *,
    org_id: str,
) -> dict[str, Any] | None:
    """Best-effort persistence of the run summary to the evaluations table."""
    try:
        from draftly.orchestration.nodes.base import node_data

        summary = getattr(state.result, "state", None)
        data = {}
        if summary is not None:
            persist_node = summary.results.get("persist") if hasattr(summary, "results") else None
            data = node_data(summary, "persist") if persist_node else {}
    except Exception:
        data = {}
    if not data:
        data = {"total": 0, "passed": 0, "failed": 0, "passed_all": False, "errors": []}

    repository = getattr(getattr(context, "repositories", None), "evaluations", None)
    saver = getattr(repository, "save_run_summary", None) if repository else None
    if saver is None:
        logger.info(
            "evaluation_loop_summary run_id=%s total=%s passed=%s",
            state.run_id,
            data.get("total"),
            data.get("passed"),
        )
        return None
    try:
        completed_at = datetime.now(UTC)
        return await saver(
            summary=data,
            org_id=org_id,
            run_id=state.run_id,
            started_at=state_started_at(state),
            completed_at=completed_at,
        )
    except Exception:
        logger.exception("evaluation_loop_persist_failed")
        return None


def state_started_at(state: WorkflowState) -> datetime:
    """Best-effort run start; the workflow does not carry a clock."""
    return datetime.now(UTC) - (datetime.now(UTC) - datetime.now(UTC))
```

> Note: `state_started_at` is a placeholder that returns `datetime.now(UTC)`; if reviewers reject it, use `datetime.now(UTC)` inline at the `_persist_summary` call and drop the helper. Simpler alternative used by the loop: capture `started_at = datetime.now(UTC)` at the top of `run_evaluation_loop` and thread it into `_persist_summary(started_at=started_at, completed_at=...)` instead of a helper. Prefer threading — remove the `state_started_at` helper and pass `started_at` explicitly:

Change line: `await _publish("stage_change", {"stage": "persist_results", "status": "started"})` → keep, and call `_persist_summary(context, state, org_id=org_id, started_at=started_at)`. The `_persist_summary` signature becomes `(context, state, *, org_id, started_at)` and it computes `completed_at = datetime.now(UTC)` internally.

> IMPORTANT — resolve before implementing: the references above contain an intentional simplification. Choose **threading `started_at`** (clean). Update the test file expectation accordingly (tests only assert `saved[0]["org_id"]`/`["run_id"]`, which is unaffected).

- [ ] **Step 4: Run tests.**

Run: `uv run pytest tests/workflows/test_evaluation_loop.py -q`
Expected: PASS (3 tests).

> The graph's `PersistResultsNode` output (`total/passed/failed/passed_all/errors`) is in-memory only; `save_run_summary` is what writes the durable row. Confirm `data` non-empty by asserting `len(evals.saved) == 1` (already in the tests). If the graph returns an empty persist payload in the fake context, `_persist_summary` still calls `save_run_summary` with `{"total": 0, ...}` — tests expect the call to happen, which they'll observe via `evals.saved`.

---

### Task 3: `/evaluations/run` passes `org_id` + `run_id`

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/evaluations.py`
- Modify: `draftly-agent-backend/tests/api/test_evaluations_routes.py`

**Interfaces:**
- Consumes: `worker.run_task(name, **kwargs)` (kwargs forwarded to the workflow, `task_runner.py:61-99`), `workflows.registry.get("evaluation_loop")`.
- Produces: `POST /api/evaluations/run` returns `{"status", "run_id"}` with a stable, org-bound `run_id`.

- [ ] **Step 1: Write failing tests.**

```python
# append to tests/api/test_evaluations_routes.py
def test_run_evaluations_uses_worker_with_org_and_run_id() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from types import SimpleNamespace as NS

    from draftly.app.api.auth import get_verified_token
    from draftly.app.api.routes.evaluations import router

    captured: dict = {}

    class FakeWorker:
        @property
        def task_runner(self) -> NS:
            return NS(has_task=lambda name: True)

        async def run_task(self, name: str, **kwargs: Any) -> dict:
            captured["name"] = name
            captured.update(kwargs)
            return {"status": "completed", "result": {}}

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-42"}
    app.state.draftly = NS(worker=FakeWorker())

    resp = TestClient(app).post("/evaluations/run")

    assert resp.status_code == 200
    assert captured["name"] == "evaluation.loop"
    assert captured["org_id"] == "org-42"
    assert captured["run_id"]


def test_run_evaluations_fallback_registry_uses_org_and_run_id() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from types import SimpleNamespace as NS

    from draftly.app.api.auth import get_verified_token
    from draftly.app.api.routes.evaluations import router

    captured: dict = {}

    async def fake_loop(context, **kwargs):
        captured.update(kwargs)
        return NS(run_id=kwargs.get("run_id", ""), status="completed")

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-42"}
    app.state.draftly = NS(
        worker=None,
        workflows=NS(
            registry=NS(get=lambda name: fake_loop),
            context=None,
        ),
    )
    resp = TestClient(app).post("/evaluations/run")

    assert resp.status_code == 200
    assert captured["org_id"] == "org-42"
    assert captured["run_id"]
```

- [ ] **Step 2: Run to verify they fail.**

Run: `uv run pytest tests/api/test_evaluations_routes.py -q`
Expected: FAIL — existing route calls `run_task("evaluation.loop")` with no kwargs and the fallback calls `func(workflows.context)` with no kwargs.

- [ ] **Step 3: Implement.**

In `evaluations.py`, replace the body of `run_evaluations`:

```python
@router.post("/run")
async def run_evaluations(
    request: Request,
    token: dict[str, str] = Depends(get_verified_token),
) -> dict[str, Any]:
    """Trigger the evaluation loop workflow."""
    from uuid import uuid4

    org_id = str(token.get("org_id") or "")
    run_id = str(uuid4())
    application = request.app.state.draftly
    worker = getattr(application, "worker", None)
    if worker is not None and worker.task_runner.has_task("evaluation.loop"):
        result = await worker.run_task(
            "evaluation.loop", org_id=org_id, run_id=run_id
        )
        return {"status": "completed", "result": result}

    # Worker disabled: invoke the workflow directly against the context.
    workflows = getattr(application, "workflows", None)
    registry = getattr(workflows, "registry", None)
    func = registry.get("evaluation_loop") if registry else None
    if workflows is None or func is None:
        raise HTTPException(status_code=503, detail="Runtime not started")
    state = await func(workflows.context, org_id=org_id, run_id=run_id)
    return {
        "status": str(getattr(state, "status", "unknown")),
        "run_id": getattr(state, "run_id", None),
    }
```

- [ ] **Step 4: Run tests.**

Run: `uv run pytest tests/api/test_evaluations_routes.py tests/evaluation -q`
Expected: PASS (existing + 2 new).

---

### Task 4: Workflow context broadcaster + WorkflowRunner lifecycle broadcasts

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/context.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Test: `draftly-agent-backend/tests/workflows/test_runner_broadcast.py`

**Interfaces:**
- Consumes: `DashboardBroadcaster(redis_client.native)` (duck: `.broadcast(org_id, event_type, payload)`), `WorkflowRunner` (unchanged public API).
- Produces:
  - `WorkflowContext.broadcaster: Any = None`.
  - `build_workflows(...)` sets `context.broadcaster` in streaming mode when `redis_client` is present.
  - `WorkflowRunner.run()` broadcasts `workflow:changed` with `{"run_id", "status", "kind"}` at: start (`running`), `pending_review`, `completed`, `failed`. `kind` = the surface (e.g. `pull_request`).

- [ ] **Step 1: Write failing tests.**

```python
# tests/workflows/test_runner_broadcast.py
from __future__ import annotations

from types import SimpleNamespace as NS
from typing import Any

from draftly.workflows.runner import WorkflowRunner


class FakeBroadcaster:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []

    async def broadcast(self, org_id: str, event_type: str, payload: dict) -> bool:
        self.calls.append((org_id, event_type, payload))
        return True


class FakeStatus:
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    INTERRUPTED = "INTERRUPTED"


def make_result(status: str) -> NS:
    return NS(status=status, interrupts=[], execution_order=[], failed_nodes=0)


async def test_runner_broadcasts_running_and_completed():
    broadcaster = FakeBroadcaster()
    events = NS(try_claim=lambda *a, **k: True, mark_status=lambda *a, **k: True)
    context = NS(
        events=events,
        reviews=None,
        routing_decision=None,
        broadcaster=broadcaster,
        publisher=None,
        review_policy=lambda: None,
        model="x",
        model_provider=lambda: "p",
    )

    async def graph_factory(run_id: str, surface: str):
        class G:
            async def invoke_async(self, task: Any, invocation_state: dict | None = None):
                return make_result(FakeStatus.COMPLETED)

        return G()

    runner = WorkflowRunner(context, graph_factory=graph_factory)
    await runner.run({"event_id": "ev-1", "event_type": "pull_request.merged", "project_id": "org-9", "source": "github"})

    types = [c[1] for c in broadcaster.calls]
    assert "workflow:changed" in types
    running = [c for c in broadcaster.calls if c[2]["status"] == "running"]
    completed = [c for c in broadcaster.calls if c[2]["status"] == "completed"]
    assert running and running[0][0] == "org-9"
    assert completed


async def test_runner_broadcasts_failed_on_failed_result():
    broadcaster = FakeBroadcaster()
    context = NS(
        events=NS(try_claim=lambda *a, **k: True, mark_status=lambda *a, **k: True),
        reviews=None,
        routing_decision=None,
        broadcaster=broadcaster,
        publisher=None,
        review_policy=lambda: None,
    )

    async def graph_factory(run_id: str, surface: str):
        class G:
            async def invoke_async(self, task: Any, invocation_state: dict | None = None):
                return make_result(FakeStatus.FAILED)

        return G()

    runner = WorkflowRunner(context, graph_factory=graph_factory)
    await runner.run({"event_id": "ev-2", "event_type": "pull_request.merged", "project_id": "org-9", "source": "github"})

    statuses = [c[2]["status"] for c in broadcaster.calls]
    assert "failed" in statuses


async def test_runner_skips_broadcast_without_project_id():
    broadcaster = FakeBroadcaster()
    context = NS(
        events=NS(try_claim=lambda *a, **k: True, mark_status=lambda *a, **k: True),
        reviews=None,
        routing_decision=None,
        broadcaster=broadcaster,
        publisher=None,
        review_policy=lambda: None,
    )

    async def graph_factory(run_id: str, surface: str):
        class G:
            async def invoke_async(self, task: Any, invocation_state: dict | None = None):
                return make_result(FakeStatus.COMPLETED)

        return G()

    runner = WorkflowRunner(context, graph_factory=graph_factory)
    await runner.run({"event_id": "ev-3", "event_type": "push", "source": "github"})
    assert broadcaster.calls == []  # no org → no broadcast
```

- [ ] **Step 2: Run to verify they fail.**

Run: `uv run pytest tests/workflows/test_runner_broadcast.py -q`
Expected: FAIL (no broadcasts happen; likely also missing context attrs `model_provider` etc. — adjust the test fake to match `WorkflowRunner.run`'s real attribute access; the runner reads `getattr(self.context, "model", ...)`).

- [ ] **Step 3: Add `broadcaster` to context.**

In `workflows/context.py`, after the `publisher` field:

```python
    #: Org-scoped dashboard broadcaster (SSE push); None disables pushes.
    #: Set by composition when Redis + streaming are enabled.
    broadcaster: Any = None
```

- [ ] **Step 4: Wire it in composition.**

In `app/composition/workflows.py`, inside the `if getattr(config, "events_streaming_enabled", False):` block after `context.publisher = publisher`:

```python
        if redis_client is not None:
            from draftly.events.dashboard_broadcaster import DashboardBroadcaster

            if getattr(context, "broadcaster", None) is None:
                context.broadcaster = DashboardBroadcaster(redis_client.native)
```

- [ ] **Step 5: Broadcast in the runner.**

In `workflows/runner.py`, add a helper and call it:

```python
    async def _broadcast_lifecycle(self, status: str, run_id: str) -> None:
        broadcaster = getattr(getattr(self.context, "broadcaster", None), "broadcast", None)
        if broadcaster is None:
            return
        org_id = str((self._last_event or {}).get("project_id") or "")
        if not org_id:
            return
        try:
            await broadcaster(
                org_id,
                "workflow:changed",
                {"run_id": run_id, "status": status, "kind": self._last_surface or ""},
            )
        except Exception:
            logger.warning("runner_broadcast_failed run_id=%s status=%s", run_id, status, exc_info=True)
```

In `run()`:
- after `state.surface = surface` set `self._last_surface = surface; self._last_event = event`.
- after the claim succeeds (right before `# 2. One session + one graph`), broadcast running:

```python
        await self._broadcast_lifecycle("running", run_id)
```

- In outcome handling:
  - `INTERRUPTED` branch: `await self._broadcast_lifecycle("pending_review", run_id)`.
  - `COMPLETED` branch: `await self._broadcast_lifecycle("completed", run_id)`.
  - `failed` path (after `self._mark(event, "failed")`): `await self._broadcast_lifecycle("failed", run_id)`.

> The runner is a class using instance state; use `self._last_event`/`self._last_surface` initialized in `run()` (or pass event/surface explicitly to the helper — prefer explicit parameters: `_broadcast_lifecycle(self, *, org_id: str, run_id: str, status: str, surface: str)`). Explicit signature is cleaner and better for review; the test fakes already pass `project_id` in the event dict, so call it with `org_id=str(event.get("project_id") or "")`.

Adopt the explicit form:

```python
    async def _broadcast_lifecycle(
        self, *, org_id: str, run_id: str, status: str, surface: str
    ) -> None:
        broadcaster = getattr(getattr(self.context, "broadcaster", None), "broadcast", None)
        if broadcaster is None or not org_id:
            return
        try:
            await broadcaster(
                org_id,
                "workflow:changed",
                {"run_id": run_id, "status": status, "kind": surface},
            )
        except Exception:
            logger.warning(
                "runner_broadcast_failed run_id=%s status=%s",
                run_id, status, exc_info=True,
            )
```

Call sites:
- after claim: `await self._broadcast_lifecycle(org_id=str(event.get("project_id") or ""), run_id=run_id, status="running", surface=surface)`
- INTERRUPTED: `... status="pending_review", surface=surface`
- COMPLETED: `... status="completed", surface=surface`
- failed: `... status="failed", surface=surface`

- [ ] **Step 6: Run tests.**

Run: `uv run pytest tests/workflows/test_runner_broadcast.py tests/workflows/test_phase5_runner_events.py -q`
Expected: PASS (new + existing runner tests).

---

### Task 5: Dashboard-ticket path alignment (frontend) + backend alias

**Problem found during investigation:** `hooks/use-dashboard-events.ts` and `api/events.ts` request `POST /api/workflows/events/dashboard-ticket`, but the backend route is `POST /api/workflows/dashboard-ticket` (see `app/api/routes/workflows.py:252`). The ticket fetch 404s, so the dashboard feed silently never works. This plan fixes the frontend to the correct path.

**Files:**
- Modify: `draftly-agent-frontend/hooks/use-dashboard-events.ts`
- Modify: `draftly-agent-frontend/api/events.ts`

- [ ] **Step 1: Fix the path in `api/events.ts`.**

```ts
export async function issueDashboardTicket(): Promise<string> {
  const data = await request<{ ticket: string }>(
    "/workflows/dashboard-ticket",
    { method: "POST" },
  );
  return data.ticket;
}
```

- [ ] **Step 2: Fix the path in `hooks/use-dashboard-events.ts`.**

Change `fetch("/api/workflows/events/dashboard-ticket", ...)` to `fetch("/api/workflows/dashboard-ticket", ...)`.

- [ ] **Step 3: Verify with existing tests.**

Run: `npx vitest run __tests__/hooks/use-dashboard-events.test.ts -q`
Expected: PASS. If the test asserts the old URL string, update the mock expectation to the new path.

---

### Task 6: Frontend — `LiveEventsProvider` + `useLiveVersion`

**Files:**
- Create: `draftly-agent-frontend/components/live-events/live-events-provider.tsx`
- Create: `draftly-agent-frontend/components/live-events/event-types.ts`
- Test: `draftly-agent-frontend/components/live-events/__tests__/live-events-provider.test.tsx`

**Interfaces:**
- Consumes: `getApiToken` (`@/api/client`), dashboard ticket + `/api/workflows/events/dashboard?ticket=` EventSource (Next rewrites `/api/*` → backend — `next.config.ts:8`).
- Produces:
  - `LiveEventsProvider` component (mount once near the layout root).
  - `useLiveVersion(types: string[]): number` — bumps whenever any listed event type arrives on the dashboard stream.
  - `event-types.ts` exports `const WORKFLOW_CHANGED = "workflow:changed"; const EVALUATION_CREATED = "evaluation:created";`.

- [ ] **Step 1: Write failing tests.**

```tsx
// components/live-events/__tests__/live-events-provider.test.tsx
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveEventsProvider, useLiveVersion } from "../live-events-provider";

type Listener = { type: string; handler: (event: { data: string }) => void };
let listeners: Listener[] = [];

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: { data: string }) => void) {
    listeners.push({ type, handler });
  }
  close() {}
}

beforeEach(() => {
  listeners = [];
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = JSON.stringify({ ticket: "t1" });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  vi.stubGlobal("getApiToken", async () => "token");
});

afterEach(() => vi.unstubAllGlobals());

function Harness() {
  const v = useLiveVersion([WORKFLOW_CHANGED]);
  return <div data-testid="version">{v}</div>;
}

function emit(type: string, payload: unknown) {
  for (const l of listeners) {
    if (l.type === type) {
      l.handler({ data: JSON.stringify({ type, payload }) });
    }
  }
}

it("connects to the dashboard stream", async () => {
  render(
    <LiveEventsProvider>
      <Harness />
    </LiveEventsProvider>,
  );
  await act(async () => {});
  expect(FakeEventSource.instances.length).toBe(1);
  expect(FakeEventSource.instances[0].url).toContain("/events/dashboard?ticket=t1");
});

it("bumps the version when the event type arrives", async () => {
  render(
    <LiveEventsProvider>
      <Harness />
    </LiveEventsProvider>,
  );
  await act(async () => {});
  expect(screen.getByTestId("version").textContent).toBe("0");
  act(() => emit("workflow:changed", { run_id: "r1" }));
  expect(screen.getByTestId("version").textContent).toBe("1");
  act(() => emit("workflow:changed", { run_id: "r2" }));
  expect(screen.getByTestId("version").textContent).toBe("2");
});

it("ignores unrelated event types", async () => {
  render(
    <LiveEventsProvider>
      <Harness />
    </LiveEventsProvider>,
  );
  await act(async () => {});
  act(() => emit("review_created", {}));
  expect(screen.getByTestId("version").textContent).toBe("0");
});
```

Import `WORKFLOW_CHANGED` from `./event-types` if using the constants module; otherwise hardcode `"workflow:changed"` in the test.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run components/live-events/__tests__/live-events-provider.test.tsx -q`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```tsx
// components/live-events/event-types.ts
export const WORKFLOW_CHANGED = "workflow:changed";
export const EVALUATION_CREATED = "evaluation:created";
export const DASHBOARD_EVENT_TYPES = [WORKFLOW_CHANGED, EVALUATION_CREATED] as const;
export type DashboardEventType = (typeof DASHBOARD_EVENT_TYPES)[number];
```

```tsx
// components/live-events/live-events-provider.tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getApiToken } from "@/api/client";
import { DASHBOARD_EVENT_TYPES } from "./event-types";

interface LiveEventsContextValue {
  counts: Record<string, number>;
}

const LiveEventsContext = createContext<LiveEventsContextValue>({ counts: {} });

interface DashboardFrame {
  type?: string;
  payload?: unknown;
}

export function LiveEventsProvider({ children }: { children: React.ReactNode }) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const closeSource = () => {
      source?.close();
      source = null;
    };

    const handleFrame = (frame: DashboardFrame) => {
      if (!frame || typeof frame.type !== "string") return;
      if (!DASHBOARD_EVENT_TYPES.includes(frame.type as never)) return;
      setCounts((prev) => ({
        ...prev,
        [frame.type as string]: (prev[frame.type as string] ?? 0) + 1,
      }));
    };

    const connect = async () => {
      if (cancelled) return;
      let ticket: string | undefined;
      try {
        const token = await getApiToken();
        if (!token) return;
        const res = await fetch("/api/workflows/dashboard-ticket", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { ticket: string };
        ticket = data.ticket;
      } catch {
        // transient — retry with backoff
      }
      if (cancelled || !ticket) {
        if (!cancelled) {
          attempts += 1;
          const delay = Math.min(1000 * 2 ** (attempts - 1), 15000);
          reconnectTimer = setTimeout(connect, delay);
        }
        return;
      }
      attempts = 0;
      source = new EventSource(
        `/api/workflows/events/dashboard?ticket=${encodeURIComponent(ticket)}`,
      );
      source.onmessage = (e: MessageEvent) => {
        try {
          handleFrame(JSON.parse(e.data) as DashboardFrame);
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => {
        if (cancelled) return;
        closeSource();
        attempts += 1;
        const delay = Math.min(1000 * 2 ** (attempts - 1), 15000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeSource();
    };
  }, []);

  const value = useMemo(() => ({ counts }), [counts]);
  return (
    <LiveEventsContext.Provider value={value}>
      {children}
    </LiveEventsContext.Provider>
  );
}

export function useLiveVersion(types: string[]): number {
  const { counts } = useContext(LiveEventsContext);
  const key = types.join("|");
  return useMemo(
    () => Math.max(0, ...types.map((t) => counts[t] ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts, key],
  );
}
```

- [ ] **Step 4: Run tests.**

Run: `npx vitest run components/live-events/__tests__/live-events-provider.test.tsx -q`
Expected: PASS. If `fetch` mock + `Response` are awkward in the jsdom env, model the mock on the existing `__tests__/hooks/use-dashboard-events.test.ts`.

---

### Task 7: Frontend — `useLiveRefresh` hook

**Files:**
- Create: `draftly-agent-frontend/hooks/use-live-refresh.ts`
- Test: `draftly-agent-frontend/__tests__/hooks/use-live-refresh.test.ts`

**Interfaces:**
- Consumes: `useLiveVersion` (Task 6).
- Produces: `useLiveRefresh<T>(fetchFn: () => Promise<T>, eventTypes: string[], fallbackIntervalMs?: number) → { data: T | null; error: string | null; refresh: () => void }`.

- [ ] **Step 1: Write failing tests.**

```tsx
// __tests__/hooks/use-live-refresh.test.ts
import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRefresh } from "../../hooks/use-live-refresh";

const mocks = vi.hoisted(() => ({
  version: 0,
}));

vi.mock("@/components/live-events/live-events-provider", () => ({
  useLiveVersion: () => mocks.version,
}));

beforeEach(() => {
  mocks.version = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("fetches on mount", async () => {
  const fetchFn = vi.fn(async () => ["a"]);
  const { result } = renderHook(() => useLiveRefresh(fetchFn, ["workflow:changed"]));

  await act(async () => {});
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(result.current.data).toEqual(["a"]);
  expect(result.current.error).toBeNull();
});

it("refetches when a live version bump arrives", async () => {
  const fetchFn = vi.fn(async () => ["a"]);
  const { result } = renderHook(() => useLiveRefresh(fetchFn, ["workflow:changed"]));
  await act(async () => {});
  expect(fetchFn).toHaveBeenCalledTimes(1);

  mocks.version = 1;
  await act(async () => {});

  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(result.current.data).toEqual(["a"]);
});

it("keeps a slow fallback poll without events", async () => {
  const fetchFn = vi.fn(async () => ["a"]);
  renderHook(() => useLiveRefresh(fetchFn, ["workflow:changed"], 30_000));
  await act(async () => {});
  expect(fetchFn).toHaveBeenCalledTimes(1);

  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it("surfaces errors", async () => {
  const fetchFn = vi.fn(async () => {
    throw new Error("boom");
  });
  const { result } = renderHook(() => useLiveRefresh(fetchFn, ["workflow:changed"]));
  await act(async () => {});
  expect(result.current.error).toBe("boom");
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run __tests__/hooks/use-live-refresh.test.ts -q`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
// hooks/use-live-refresh.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveVersion } from "@/components/live-events/live-events-provider";

export interface LiveRefreshState<T> {
  data: T | null;
  error: string | null;
  refresh: () => void;
}

export function useLiveRefresh<T>(
  fetchFn: () => Promise<T>,
  eventTypes: string[],
  fallbackIntervalMs = 30_000,
): LiveRefreshState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useLiveVersion(eventTypes);
  const fetchRef = useRef(fetchFn);

  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  const refresh = useCallback(() => {
    let cancelled = false;
    fetchRef.current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = refresh();
    const id = setInterval(refresh, fallbackIntervalMs);
    return () => {
      cancel();
      clearInterval(id);
    };
  }, [refresh, version, fallbackIntervalMs]);

  return { data, error, refresh };
}
```

- [ ] **Step 4: Run tests.**

Run: `npx vitest run __tests__/hooks/use-live-refresh.test.ts -q`
Expected: PASS.

---

### Task 8: Swap the three pollers to `useLiveRefresh`

**Files:**
- Modify: `draftly-agent-frontend/components/workflows/workflows.tsx` (`useWorkflows`, lines 45-71)
- Modify: `draftly-agent-frontend/components/dashboard/sidebar.tsx` (`useRunningWorkflowCount`, lines 10-34)
- Modify: `draftly-agent-frontend/components/evaluations/use-evaluations.ts`
- Modify: `draftly-agent-frontend/app/(app)/layout.tsx` — mount `LiveEventsProvider`
- Tests: update/verify `components/workflows/__tests__/`, `components/dashboard/__tests__/` (if present), `components/evaluations/__tests__/evaluations.test.tsx`

**Interfaces:**
- Consumes: `useLiveRefresh` (Task 7), `WORKFLOW_CHANGED`/`EVALUATION_CREATED` (Task 6).
- Produces: the three consumers no longer call `setInterval(..., 5000)`; behavior backed by SSE + 30s fallback.

- [ ] **Step 1: `useWorkflows` in `workflows.tsx`.**

Replace the local `useWorkflows` implementation:

```tsx
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { WORKFLOW_CHANGED } from "@/components/live-events/event-types";

function useWorkflows() {
  const { data: items, error } = useLiveRefresh(
    () => listWorkflows().then((raw) => raw.map(mapRow)),
    [WORKFLOW_CHANGED],
  );
  return { rows: items, error };
}
```

- [ ] **Step 2: `useRunningWorkflowCount` in `sidebar.tsx`.**

```tsx
import { useMemo } from "react";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { WORKFLOW_CHANGED } from "@/components/live-events/event-types";

function useRunningWorkflowCount() {
  const { data: items } = useLiveRefresh(() => listWorkflows(), [WORKFLOW_CHANGED]);
  return useMemo(
    () =>
      items !== null && items !== undefined
        ? items.filter((item) => item.status === "running").length
        : null,
    [items],
  );
}
```

- [ ] **Step 3: `useEvaluations`.**

```ts
// components/evaluations/use-evaluations.ts
"use client";

import { useLiveRefresh } from "@/hooks/use-live-refresh";
import {
  WORKFLOW_CHANGED,
  EVALUATION_CREATED,
} from "@/components/live-events/event-types";
import { listEvaluations } from "@/api/observability";
import { mapListItem } from "./map";
import type { EvalItem } from "./types";

export function useEvaluations() {
  const { data: rows, error, refresh } = useLiveRefresh(
    () => listEvaluations(50).then(({ items }) => items.map(mapListItem)),
    [EVALUATION_CREATED, WORKFLOW_CHANGED],
  );
  return { rows, error, refresh };
}
```

- [ ] **Step 4: Mount the provider in `app/(app)/layout.tsx`.**

```tsx
import { LiveEventsProvider } from "../../components/live-events/live-events-provider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();
  return (
    <>
      <AuthTokenSetter />
      <SWRProvider>
        <LiveEventsProvider>
          <DashboardEventsListener />
          {children}
        </LiveEventsProvider>
      </SWRProvider>
    </>
  );
}
```

- [ ] **Step 5: Update the consumers' existing tests.**

Find tests that assert 5s polling (references: `components/evaluations/__tests__/evaluations.test.tsx`, any `workflows`/`sidebar` tests). Two patterns:
- If they mock `@/api/observability` and advance fake timers by 5000, change to mock `useLiveRefresh` instead:

```tsx
const { useLiveRefresh } = vi.hoisted(() => ({ useLiveRefresh: vi.fn() }));
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh }));

useLiveRefresh.mockReturnValue({ data: [...], error: null, refresh: vi.fn() });
```

- If they test data-driven rendering only, no change needed beyond new imports resolving.

- [ ] **Step 6: Run all frontend tests.**

Run: `npx vitest run __tests__ hooks/components components/evaluations components/workflows components/dashboard -q`
Expected: PASS (existing 214 + new provider/hook tests; the pre-existing `doc-article` failure may still fail — note it as expected).

- [ ] **Step 7: Typecheck + lint.**

Run: `npx tsc --noEmit` then `npx eslint components/live-events hooks components/evaluations components/workflows components/dashboard`
Expected: exit 0 / 0 errors.

---

### Task 9: Backend verification + spec doc + graphify

**Files:**
- Modify: `docs/superpowers/specs/2026-08-27-sse-starlette-migration-design.md`

- [ ] **Step 1: Full backend test run.**

Run: `uv run pytest -q`
Expected: 880+new pass, 2 known pre-existing failures (`test_rq_dispatch.py::test_enqueued_job_timeout_exceeds_workflow_watchdog`, `test_onboarding_initialize.py::test_watchdog_fails_run_stuck_past_timeout`). Do not fix them.

- [ ] **Step 2: Ruff.**

Run: `uv run ruff check src/draftly/workflows/evaluation/documentation_evaluation.py src/draftly/workflows/runner.py src/draftly/workflows/context.py src/draftly/app/composition/workflows.py src/draftly/app/api/routes/evaluations.py src/draftly/persistence/repositories/evaluations.py src/draftly/integrations/database/evaluations_store.py tests/workflows/test_evaluation_loop.py tests/evaluation/test_evaluations_repository.py tests/workflows/test_runner_broadcast.py tests/api/test_evaluations_routes.py`
Expected: no new errors (37 pre-existing repo errors outside these files are out of scope).

- [ ] **Step 3: Update the SSE design spec.**

Append sections to `docs/superpowers/specs/2026-08-27-sse-starlette-migration-design.md`:

```markdown
## Evaluation persistence + live lists (2026-09-02)

### Evaluation save path
`POST /api/evaluations/run` → `worker.run_task("evaluation.loop", org_id, run_id)`
→ `run_evaluation_loop` streams stage/progress/result envelopes on the run's
event-bus channel, writes a `jobs` row (`job_id = run_id`) so `/stream-ticket`
resolves, and persists via `EvaluationRepository.save_run_summary` → the
`evaluations` table row (org_id + run_id present). The scheduled
`evaluation.loop` RQ job takes the same path with `org_id=""` (global run).

### Dashboard producers
`WorkflowRunner` publishes `workflow:changed` (running / pending_review /
completed / failed) via `context.broadcaster` (org from `event.project_id`).
`run_evaluation_loop` publishes `workflow:changed` (running / completed /
failed, `kind="evaluation"`) and `evaluation:created` (evaluation_id, status).

Frame shape: `{ "type": "workflow:changed" | "evaluation:created", "payload": {...} }`.

### Frontend live lists
`LiveEventsProvider` opens one org dashboard EventSource
(`POST /api/workflows/dashboard-ticket` → `GET /api/workflows/events/dashboard`)
and bumps per-type counters. `useLiveVersion(types)` + `useLiveRefresh`
drive the Workflows list, sidebar running-count, and Evaluations list:
fetch on mount, refetch on event, 30s fallback poll. 5s interval polling is
removed from those three surfaces.
```

- [ ] **Step 4: Graphify update.**

From repo root:

Run: `graphify update .`
Expected: graph refreshed (AST-only). The next codebase question uses `graphify query`.

---

### Task 10: Full frontend verification + final sweep

- [ ] **Step 1: Full frontend suite.**

Run: `npx vitest run -q`
Expected: PASS (new tests) + pre-existing `doc-article` failure only.

- [ ] **Step 2: Fresh-eyes self-review.**

Read the diff of every changed file. Verify:
- No leftover `setInterval(fetchRows, 5000)` in `workflows.tsx`, `sidebar.tsx`, or `use-evaluations.ts`.
- `useLiveVersion` dependency key matches event strings emitted by the backend (`workflow:changed`, `evaluation:created`).
- Backend `run_evaluation_loop` publishes a terminal `workflow_result` on every exit path.
- `WorkflowContext` docs updated (publisher + broadcaster fields).
- No commit was made.

- [ ] **Step 3: Graphify (if Step 4 of Task 9 ran after later edits, rerun `graphify update .`).**

---

## Self-Review

- **Spec coverage:** reuse of ticket/`EventSourceResponse` infra (Task 5/6/7/8), dashboard feed producers (Tasks 2/4), eval persistence wiring (Tasks 1/2/3), target of "same strategy as init-stages" (Task 2 streaming mirrors `initialize.py`; Task 6 EventSource mirrors `use-workflow-events.ts`). The dashboard `active-workflows` widget stays polling (out of scope by user decision).
- **Placeholder scan:** the only intentional soft spot is `state_started_at` in Task 2, explicitly resolved to thread `started_at`; test assertions are unaffected.
- **Type consistency:** `save_run_summary(summary, org_id, run_id, started_at, completed_at)` used identically in Task 1 and Task 2; `useLiveRefresh<T>(fetchFn, eventTypes, fallbackIntervalMs)` signature identical across Task 7/8; event names `workflow:changed`/`evaluation:created` consistent backend→frontend.