# RQ Re-Enqueue for Review Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `POST /api/github/review/{run_id}` review-resume path off the synchronous FastAPI request cycle and onto the existing durable worker dispatch (RQ when `rq_enabled`, otherwise the in-process `TaskRunner` background-task fallback), exactly mirroring the GitHub webhook route.

**Architecture:** Extract a runtime-agnostic core resume function (`resume_review_from_runtime`) that takes concrete `repositories` + `runner` instead of `app_state`; add a worker workflow (`run_review_resume`) bound to the composed `WorkflowContext`; register it as task `review.resume` (TASK_REGISTRY + WorkflowRegistry + QUEUE_MAP); change the GitHub route to validate fast inline (store/pending/org/surface), then dispatch through `enqueue_job` or `background_tasks.add_task(worker.run_task, "review.resume", ...)`, returning 202 `{"status": "queued"}`. All resume logic (terminal-status verification, decision recording, `request_changes` restart) runs inside the one shared handler in the worker, which also swallows "not pending" as an idempotent no-op so RQ retries cannot double-resume a completed review.

**Tech Stack:** Python 3.11 (asyncio), FastAPI, RQ 2.x (JSONSerializer, Retry max=3), rq-scheduler, structlog, pytest (`asyncio_mode=auto`), ruff, mypy. All paths below are relative to the `draftly-agent-backend/` directory unless prefixed with `repo-root/`.

**Spec:** This plan encodes the agreed design from the "RQ re-enqueue" analysis (2026-09-11 conversation): dual-path dispatch mirroring the webhook, dispatcher/registry pattern (module-level importable `dispatch`, never a closure — see `rq_dispatch.py` docstring), and the "no result back to caller" response-contract trade-off (client polls run status instead of getting `workflow_status` in the POST response).

## Global Constraints

- TDD: write/run the failing test first (RED), then implement (GREEN), for every task. Never commit a task without its test.
- Do not add code comments unless the surrounding code styles require them; this codebase uses concise docstrings — keep them.
- Every task must end with a green test run; the full offline suite must remain green after each task:
  `cd draftly-agent-backend && .venv/bin/python -m pytest tests/ -q -m "not integration" -p no:cacheprovider`
- Lint/typecheck before committing: inside `draftly-agent-backend/`: `../../.../ruff` → run `.venv/bin/ruff check <files>`; mypy MUST be run from the `src/` directory (`../.venv/bin/mypy <module>`) because `mypy src` from the repo root fails with a pre-existing "Source file found twice" on unrelated files.
- RQ enqueues the module-level `dispatch` function by name with the task name in kwargs — never serialize a closure. Duplicate job-ids are NOT deduplicated by this RQ version; idempotency must live in the handler.
- Do not touch unrelated pre-existing modified files in the tree (`schemas.py`, `review/notifier.py`, and their tests are someone else's work-in-progress).

---

### Task 1: Extract runtime-agnostic core `resume_review_from_runtime`

Refactor `resume_review_decision` in `src/draftly/review/resume.py` so ALL resume logic lives in a new function that takes concrete `repositories` + `runner`, and keep `resume_review_decision` as a thin adapter that resolves `app_state` into those two values. The four existing callers (`github.py` route, `slack/app.py:200`, `discord.py:129`, `review/service.py:119` wrapper) must keep working unchanged against the adapter.

**Files:**
- Modify: `src/draftly/review/resume.py` (restructure `resume_review_decision`, add `resume_review_from_runtime`)
- Test: `tests/review/test_review_resume.py`

**Interfaces:**
- Consumes: existing `ReviewResumeError`, `_get`, `_coerce_payload`, `_load_event`, `ReviewDecision`, `ReviewService`.
- Produces: `async def resume_review_from_runtime(*, review_id: str, approved: bool | None, decision: Literal["approve","request_changes","reject"] | None, reviewer_id: str, comment: str, repositories: Any, runner: Any, org_id: str | None) -> WorkflowState` — same semantics/errors as today's `resume_review_decision`.
- `resume_review_decision` keeps its exact current signature (all TDD in later tasks relies on it).

- [ ] **Step 1: Write the failing tests**

Append to `tests/review/test_review_resume.py`:

```python
from draftly.review.resume import (
    ReviewResumeError,
    resume_review_decision,
    resume_review_from_runtime,
)


async def test_runtime_core_approval_resumes_via_repositories_and_runner():
    app_state = fake_app_state(workflow_status="delivered")
    state = await resume_review_from_runtime(
        review_id="review-1",
        approved=True,
        reviewer_id="user-1",
        comment="ship it",
        repositories=app_state.dependencies.repositories,
        runner=app_state.workflows.runner,
    )
    assert state.status.value == "delivered"
    runner = app_state.workflows.runner
    assert runner.calls[0]["interrupt_id"] == "int-1"
    assert runner.calls[0]["response"] == {"approved": True, "comment": "ship it"}
    assert app_state.dependencies.repositories.reviews.decisions[0]["decision"] == "approved"


async def test_runtime_core_requires_runner():
    app_state = fake_app_state(workflow_status="delivered")
    with pytest.raises(ReviewResumeError, match="Workflow runner unavailable"):
        await resume_review_from_runtime(
            review_id="review-1",
            approved=True,
            reviewer_id="user-1",
            comment="x",
            repositories=app_state.dependencies.repositories,
            runner=None,
        )


async def test_adapter_delegates_to_runtime_core():
    app_state = fake_app_state(workflow_status="delivered")
    reviews = app_state.dependencies.repositories.reviews
    core_state = await resume_review_from_runtime(
        review_id="review-1",
        approved=True,
        reviewer_id="user-1",
        comment="ship it",
        repositories=app_state.dependencies.repositories,
        runner=app_state.workflows.runner,
    )
    # record_decision sets the record to non-pending; restore status so the
    # adapter call exercises the same pending-review path.
    reviews.record.status = "pending"
    adapter_state = await resume_review_decision(
        review_id="review-1",
        approved=True,
        reviewer_id="user-1",
        comment="ship it",
        app_state=app_state,
    )
    assert core_state.status.value == "delivered"
    assert adapter_state.status.value == "delivered"
    assert len(reviews.decisions) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/review/test_review_resume.py -q`
Expected: FAIL with `ImportError: cannot import name 'resume_review_from_runtime'`.

- [ ] **Step 3: Implement the refactor**

In `src/draftly/review/resume.py`, insert below `_load_event` (keep `_resolve_app_state` at the bottom of the file):

```python
async def resume_review_from_runtime(
    *,
    review_id: str,
    approved: bool | None = None,
    decision: Literal["approve", "request_changes", "reject"] | None = None,
    reviewer_id: str,
    comment: str,
    repositories: Any,
    runner: Any,
    org_id: str | None = None,
) -> WorkflowState:
    """Resume or revise a paused workflow after a human review decision.

    Runtime-agnostic core: takes the concrete repositories and workflow
    runner instead of a composed app object so the same code path serves the
    inline API routes and the durable worker (see ``run_review_resume``).
    """
    if decision is None:
        if approved is None:
            raise ReviewResumeError("A review decision is required")
        decision = "approve" if approved else "reject"
    approved_value = decision == "approve"
    if decision == "request_changes" and not comment.strip():
        raise ReviewResumeError("Request changes requires a comment")

    reviews = getattr(repositories, "reviews", None)
    if reviews is None or getattr(reviews, "get_review", None) is None:
        raise ReviewResumeError("Reviews store unavailable")

    record = await reviews.get_review(review_id)
    if record is None or str(_get(record, "status", "")) != "pending":
        raise ReviewResumeError(f"Review {review_id} is not pending")
    if org_id and str(_get(record, "org_id") or "") != org_id:
        raise ReviewResumeError(f"Review {review_id} does not belong to the organization")

    run_id = str(_get(record, "thread_id") or "")
    surface = str(_get(record, "workflow") or "")
    if surface not in ("pull_request", "issue", "support"):
        raise ReviewResumeError(f"Workflow {surface!r} is not resumable")

    tool_args = _get(record, "tool_args") or {}
    metadata = _get(record, "metadata") or {}
    interrupt_id = tool_args.get("interrupt_id") if isinstance(tool_args, dict) else None
    if not interrupt_id:
        interrupt_id = metadata.get("interrupt_id") if isinstance(metadata, dict) else None
    if not interrupt_id:
        raise ReviewResumeError("Review has no interrupt to resume")

    events_repo = getattr(repositories, "events", None)
    event = await _load_event(events_repo, run_id)
    event["project_id"] = str(_get(record, "org_id") or "")
    event["org_id"] = event["project_id"]

    if decision == "request_changes":
        outcomes = getattr(repositories, "feedback_outcomes", None)
        service = ReviewService(repository=reviews, outcomes_repository=outcomes)
        result = await service.decide(
            ReviewDecision(
                review_id=review_id,
                reviewer_id=reviewer_id or "",
                approved=False,
                decision="request_changes",
                comment=comment.strip(),
            )
        )

        revision_event = dict(event)
        revision_event["event_id"] = str(uuid4())
        revision_event["review_policy"] = "always"
        revision_event["review_revision_of"] = review_id
        revision_event["review_feedback"] = {
            "decision": "needs_changes",
            "comment": comment.strip(),
        }
        marker = getattr(events_repo, "mark_status", None)
        if marker is not None:
            try:
                await marker(run_id, "needs_changes")
            except Exception:
                logger.warning(
                    "review_revision_original_event_mark_failed",
                    run_id=run_id,
                    exc_info=True,
                )
        if runner is None or getattr(runner, "run", None) is None:
            raise ReviewResumeError("Workflow runner unavailable")
        revised_state = await runner.run(revision_event)
        setattr(revised_state, "decision_outcome", result)
        setattr(revised_state, "review_revision_of", review_id)
        return revised_state

    if runner is None or getattr(runner, "resume_review", None) is None:
        raise ReviewResumeError("Workflow runner unavailable")

    from draftly.observability.metrics import metrics as _metrics

    _metrics.increment("draftly_review_decisions_total")

    try:
        state = await runner.resume_review(
            event=event,
            interrupt_id=interrupt_id,
            response={"approved": approved_value, "comment": comment or ""},
        )
    except Exception as exc:
        logger.warning(
            "review_resume_failed",
            review_id=review_id,
            run_id=run_id,
            exc_info=True,
        )
        raise ReviewResumeError(f"Resume failed for review {review_id}") from exc

    status = getattr(getattr(state, "status", None), "value", "")
    expected = "delivered" if approved_value else "failed"
    if status != expected:
        raise ReviewResumeError(
            f"Review did not reach expected status {expected!r} (status={status})"
        )

    outcomes = getattr(repositories, "feedback_outcomes", None)
    service = ReviewService(repository=reviews, outcomes_repository=outcomes)
    result = await service.decide(
        ReviewDecision(
            review_id=review_id,
            reviewer_id=reviewer_id or "",
            approved=approved_value,
            decision=decision,
            comment=comment or "",
        )
    )
    setattr(state, "decision_outcome", result)

    logger.info(
        "review_resumed",
        review_id=review_id,
        run_id=run_id,
        status=status,
        approved=approved_value,
        reviewer_id=reviewer_id,
    )
    return state
```

Replace the entire body of `resume_review_decision` (everything after its docstring, from `if decision is None:` through `return state`) with:

```python
    app_state = await _resolve_app_state(app_state)
    repositories = getattr(getattr(app_state, "dependencies", None), "repositories", None)
    runner = getattr(getattr(app_state, "workflows", None), "runner", None)
    return await resume_review_from_runtime(
        review_id=review_id,
        approved=approved,
        decision=decision,
        reviewer_id=reviewer_id,
        comment=comment,
        repositories=repositories,
        runner=runner,
        org_id=org_id,
    )
```

Note: `_resolve_app_state` already raises `ReviewResumeError("Runtime not started")` when the app_state has no workflow runner; error precedence for the blank-comment + dead-runtime edge case may change but no existing test depends on it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/review/test_review_resume.py -q`
Expected: PASS (all prior tests plus the three new ones — 15 total).

Also confirm the other inline callers still import fine:
Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/integration/test_slack_support_delivery.py tests/integration/test_discord_support_delivery.py -q -m "not integration" -p no:cacheprovider`
Expected: PASS (imports + non-integration subset).

- [ ] **Step 5: Commit**

```bash
git add src/draftly/review/resume.py tests/review/test_review_resume.py
git commit -m "refactor(review): extract runtime-agnostic resume core"
```

---

### Task 2: Add worker workflow `run_review_resume` with idempotent no-op

The worker handler that the RQ in-process task and the background-task fallback both run. It binds the composed `WorkflowContext` (which carries `repositories` and `runner`) to `resume_review_from_runtime`, and treats "not pending" as an already-handled success so an RQ retry after a partially-completed decision cannot re-resume a finished review.

**Files:**
- Modify: `src/draftly/review/resume.py`
- Test: `tests/review/test_review_resume.py`

**Interfaces:**
- Consumes: `resume_review_from_runtime` (Task 1), context shape `context.repositories`, `context.runner`.
- Produces: `async def run_review_resume(context: Any, **kwargs: Any) -> WorkflowState | None` — signature matches the registry/workflow convention `workflow_func(context, **kwargs)` used by `_wrap_workflow` in `app/composition/workers.py`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/review/test_review_resume.py`:

```python
from types import SimpleNamespace

from draftly.review.resume import run_review_resume


async def test_worker_workflow_resumes_approval_against_composed_context():
    app_state = fake_app_state(workflow_status="delivered")
    context = SimpleNamespace(
        repositories=app_state.dependencies.repositories,
        runner=app_state.workflows.runner,
    )
    state = await run_review_resume(
        context,
        review_id="review-1",
        approved=True,
        reviewer_id="user-1",
        comment="ship it",
        org_id="org-1",
    )
    assert state.status.value == "delivered"
    runner = app_state.workflows.runner
    assert runner.calls[0]["response"] == {"approved": True, "comment": "ship it"}
    assert app_state.dependencies.repositories.reviews.decisions[0]["decision"] == "approved"


async def test_worker_workflow_noops_when_review_already_decided():
    reviews = FakeReviews(_review_record(status="approved"))
    runner = FakeRunner("delivered")
    context = SimpleNamespace(
        repositories=SimpleNamespace(
            reviews=reviews,
            events=FakeEvents(
                {
                    "event_id": "run-1",
                    "event_type": "pull_request.merged",
                    "repository": "acme/api",
                    "source": "github",
                }
            ),
            feedback_outcomes=None,
        ),
        runner=runner,
    )
    result = await run_review_resume(
        context,
        review_id="review-1",
        approved=True,
        reviewer_id="user-1",
        comment="ship it",
        org_id="org-1",
    )
    assert result is None
    assert runner.calls == []
    assert reviews.decisions == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/review/test_review_resume.py -q`
Expected: FAIL with `ImportError: cannot import name 'run_review_resume'`.

- [ ] **Step 3: Implement**

Append to `src/draftly/review/resume.py` (after `resume_review_decision`, before `_resolve_app_state`):

```python
async def run_review_resume(
    context: Any,
    **kwargs: Any,
) -> WorkflowState | None:
    """Worker/registry workflow: resume a review against the composed context.

    Bound to the composed ``WorkflowContext`` by ``build_task_runner`` so the
    RQ worker and the in-process fallback run the same path as the API routes.
    A review that is no longer pending was already decided by a prior (possibly
    retried) attempt — treat it as a success so RQ's Retry policy cannot
    double-resume a finished review.
    """
    repositories = getattr(context, "repositories", None)
    runner = getattr(context, "runner", None)
    if repositories is None or runner is None:
        raise ReviewResumeError(
            "Workflow context is not composed (missing repositories/runner)"
        )
    try:
        return await resume_review_from_runtime(
            repositories=repositories,
            runner=runner,
            **kwargs,
        )
    except ReviewResumeError as exc:
        if "is not pending" in str(exc):
            logger.info(
                "review_resume_already_handled",
                review_id=kwargs.get("review_id", ""),
            )
            return None
        raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/review/test_review_resume.py -q`
Expected: PASS (17 total).

- [ ] **Step 5: Commit**

```bash
git add src/draftly/review/resume.py tests/review/test_review_resume.py
git commit -m "feat(review): add worker resume workflow with idempotent no-op"
```

---

### Task 3: Register `review.resume` task in the worker registry, queue map, and workflow registry

So `enqueue_job(..., task_name="review.resume", ...)` passes validation, `build_task_runner` registers a handler, and the workflow exists in the composed `WorkflowRegistry`.

**Files:**
- Modify: `src/draftly/app/composition/workers.py` (TASK_REGISTRY, line ~28 area)
- Modify: `src/draftly/app/composition/rq_jobs.py` (QUEUE_MAP, line ~45 area)
- Modify: `src/draftly/app/composition/workflows.py` (`build_workflows` local imports + `registry.register` list, lines ~130-240)
- Test: `tests/app/test_workers_register.py`

**Interfaces:**
- Consumes: `run_review_resume` (Task 2).
- Produces: `TASK_REGISTRY["review.resume"] == "review_resume"`, `get_queue_for_task("review.resume") == "webhooks"`, `WorkflowRegistry` name `"review_resume"`, and `build_task_runner(...).has_task("review.resume") is True`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/test_workers_register.py`:

```python
def test_review_resume_task_in_registry() -> None:
    from draftly.app.composition.workers import TASK_REGISTRY

    assert TASK_REGISTRY["review.resume"] == "review_resume"


def test_review_resume_task_buildable(monkeypatch: pytest.MonkeyPatch) -> None:
    """build_task_runner must register a handler for review.resume.

    build_task_runner iterates the FULL TASK_REGISTRY and raises ValueError if
    any workflow name is missing from the registry, so we patch TASK_REGISTRY
    down to just the review.resume entry to keep the test hermetic.
    """

    async def run_review_resume(context, **kwargs):
        return None

    import draftly.app.composition.workers as workers_mod

    monkeypatch.setattr(
        workers_mod,
        "TASK_REGISTRY",
        {"review.resume": "review_resume"},
    )

    workflows = ComposedWorkflows(
        registry={"review_resume": run_review_resume},
        context=MagicMock(),
    )
    dependencies = MagicMock()

    from draftly.app.composition.workers import build_task_runner

    runner = build_task_runner(workflows=workflows, dependencies=dependencies)
    assert runner.has_task("review.resume")


def test_review_resume_task_routes_to_webhooks_queue() -> None:
    from draftly.app.composition.rq_jobs import get_queue_for_task

    assert get_queue_for_task("review.resume") == "webhooks"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/app/test_workers_register.py -q`
Expected: FAIL — `KeyError: 'review.resume'` (or `assert None == 'review_resume'`).

- [ ] **Step 3: Implement**

In `src/draftly/app/composition/workers.py`, add the entry to `TASK_REGISTRY` (group with the enqueue tasks):

```python
    "github_feedback.enqueue": "github_feedback",
    "review.resume": "review_resume",
```

In `src/draftly/app/composition/rq_jobs.py`, add to `QUEUE_MAP` (with the other webhook-origin tasks):

```python
    "review.resume": "webhooks",
```

In `src/draftly/app/composition/workflows.py` `build_workflows`, add the import to the local import block (currently imports `run_memory_maintenance` through `run_stale_reconcile`):

```python
    from draftly.review.resume import run_review_resume
```

and register it with the other workflows:

```python
    registry.register("review_resume", run_review_resume)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/app/test_workers_register.py -q`
Expected: PASS (7 total).

Then run the review suite to confirm nothing regressed:
Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/review/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/app/composition/workers.py src/draftly/app/composition/rq_jobs.py src/draftly/app/composition/workflows.py tests/app/test_workers_register.py
git commit -m "feat(workers): register review.resume task for durable dispatch"
```

---

### Task 4: Dispatch the GitHub review route through the worker

Rewrite `resume_review` in `src/draftly/app/api/routes/github.py` (currently lines 503-588) to validate fast inline and then dispatch — RQ via `enqueue_job(...)`, otherwise `background_tasks.add_task(worker.run_task, "review.resume", ...)` — mirroring the webhook branch at lines 387-422. The route returns `202 {"status": "queued", ...}`; graph execution and decision recording happen in the shared `review.resume` handler (Task 2).

**Files:**
- Modify: `src/draftly/app/api/routes/github.py` (decorator + `resume_review` route, lines 503-588)
- Modify: `tests/api/test_routes_smoke.py` (`client` fixture lines 165-193 + `TestReviewResumeRoute` lines 238-357)
- Modify: `tests/api/test_github_review_resume_logs.py` (`review()` helper line 30 + replace `test_resume_route_logs_conflict` lines 90-119)

**Interfaces:**
- Consumes: `enqueue_job` (already imported at `github.py` top), `BackgroundTasks` (already imported), `TASK_REGISTRY`/`QUEUE_MAP` entries from Task 3, `settings.rq_enabled`, `app_state.rq_queues`, `app_state.task_handlers`, `app_state.worker` (TaskRunner with `review.resume`).
- Produces: route returns `202 {"status": "queued", "run_id": ..., "review_id": ..., "decision": <approve|request_changes|reject>, "rq_job_id": ...}`; `404` when no pending/org-mismatch; `409` when `workflow` is not resumable; `503` when the store or worker is unavailable. The `review.resume` handler is invoked with `review_id`, `approved`, `decision`, `reviewer_id`, `comment`, `org_id`.

- [ ] **Step 1: Write the failing tests**

Replace the `client` fixture's review-related wiring in `tests/api/test_routes_smoke.py`. After the four `Fake*` repositories are constructed (inside the existing fixture), replace the `state = SimpleNamespace(...)` block (lines 179-191) with:

```python
    from draftly.app.composition.workers import _wrap_workflow
    from draftly.app.workers.task_runner import TaskRunner
    from draftly.review.resume import run_review_resume

    repositories = SimpleNamespace(
        reviews=reviews,
        events=FakeEventsRepository(),
        documents=FakeDocumentsRepository(),
        evaluations=FakeEvaluationsRepository(),
        support=FakeSupportRepository(),
    )
    runner = FakeWorkflowRunner()
    worker = TaskRunner()
    worker.register(
        "review.resume",
        _wrap_workflow(
            run_review_resume,
            SimpleNamespace(repositories=repositories, runner=runner),
        ),
    )
    state = SimpleNamespace(
        dependencies=SimpleNamespace(repositories=repositories),
        workflows=SimpleNamespace(runner=runner),
        worker=worker,
        settings=SimpleNamespace(rq_enabled=False),
        rq_queues=None,
        task_handlers=None,
    )
```

Replace the entire `TestReviewResumeRoute` class body (lines 238-357) with:

```python
class TestReviewResumeRoute:
    def test_resume_unknown_run_404(self, client: TestClient) -> None:
        response = client.post(
            "/api/github/review/missing-run",
            json={
                "review_id": "rev-1",
                "reviewer_id": "u-1",
                "approved": True,
            },
        )
        assert response.status_code == 404

    def test_reject_records_decision_no_resume(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        response = client.post(
            "/api/github/review/run-1",
            json={
                "review_id": "rev-1",
                "reviewer_id": "u-1",
                "approved": False,
                "comment": "wrong approach",
            },
        )
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "queued"
        assert body["decision"] == "reject"
        state = client.app.state.draftly  # type: ignore[attr-defined]
        assert state.dependencies.repositories.reviews.decisions[0]["decision"] == "rejected"
        assert state.workflows.runner.calls[0]["response"]["approved"] is False

    def test_approve_resumes_graph(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        response = client.post(
            "/api/github/review/run-1",
            json={
                "review_id": "rev-1",
                "reviewer_id": "u-1",
                "approved": True,
                "comment": "ship it",
            },
        )
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "queued"
        assert body["run_id"] == "run-1"
        runner_call = client.app.state.draftly.workflows.runner.calls[0]  # type: ignore[attr-defined]
        assert runner_call["interrupt_id"] == "int-1"
        assert runner_call["response"]["approved"] is True
        assert runner_call["event"]["project_id"] == "org-1"

    def test_request_changes_restarts_agents_with_feedback(self, client: TestClient) -> None:
        response = client.post(
            "/api/github/review/run-1",
            json={
                "review_id": "rev-1",
                "reviewer_id": "u-1",
                "decision": "request_changes",
                "comment": "Add the migration example.",
            },
        )
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "queued"
        assert body["decision"] == "request_changes"
        runner = client.app.state.draftly.workflows.runner  # type: ignore[attr-defined]
        assert len(runner.run_calls) == 1
        revision_event = runner.run_calls[0]
        assert revision_event["review_feedback"]["decision"] == "needs_changes"
        assert revision_event["review_feedback"]["comment"] == "Add the migration example."
        decisions = client.app.state.draftly.dependencies.repositories.reviews.decisions  # type: ignore[attr-defined]
        assert decisions[0]["decision"] == "needs_changes"

    def test_approve_with_dashboard_body_without_review_id(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/api/github/review/run-1",
            json={
                "decision": "approve",
                "reviewer_id": "",
                "comment": "ship it",
            },
        )
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "queued"
        assert body["decision"] == "approve"
        runner_call = client.app.state.draftly.workflows.runner.calls[0]  # type: ignore[attr-defined]
        assert runner_call["response"]["approved"] is True

    def test_comment_null_accepted(self, client: TestClient) -> None:
        response = client.post(
            "/api/github/review/run-1",
            json={
                "decision": "reject",
                "reviewer_id": "u-1",
                "comment": None,
            },
        )
        assert response.status_code == 202
        assert response.json()["status"] == "queued"
        runner_call = client.app.state.draftly.workflows.runner.calls[0]  # type: ignore[attr-defined]
        assert runner_call["response"]["comment"] == ""

    def test_approve_non_resumable_surface_409(self, client: TestClient) -> None:
        state = client.app.state.draftly  # type: ignore[attr-defined]
        repo = state.dependencies.repositories.reviews
        repo.record.workflow = "unknown_surface"
        response = client.post(
            "/api/github/review/run-1",
            json={"review_id": "rev-1", "reviewer_id": "u-1", "approved": True},
        )
        assert response.status_code == 409
```

Note: `TestClient` (httpx-based) executes Starlette `BackgroundTasks` before `client.post(...)` returns, so the smoke tests can assert on runner/repository state immediately after the call.

In `tests/api/test_github_review_resume_logs.py`, update the `review()` helper (line 30) to carry the surface:

```python
def review(org_id="org-1", workflow="pull_request"):
    return SimpleNamespace(
        org_id=org_id,
        review_id="review-1",
        status="pending",
        workflow=workflow,
    )
```

and replace `test_resume_route_logs_conflict` (lines 90-119) with:

```python
def test_resume_route_logs_non_resumable_surface(monkeypatch):
    from structlog.testing import capture_logs

    async def get_pending(self, run_id):
        return review(workflow="unknown_surface")

    monkeypatch.setattr(ReviewService, "get_by_run_id", get_pending)
    client = make_app(reviews=object())

    with capture_logs() as logs:
        monkeypatch.setattr(
            github_routes, "logger", structlog.get_logger("test.review_resume_conflict")
        )
        resp = client.post(
            "/api/github/review/run-1",
            json={
                "approved": True,
                "review_id": "review-1",
                "reviewer_id": "user-1",
            },
        )

    assert resp.status_code == 409
    markers = [line for line in logs if line.get("event") == "review_resume_conflict"]
    assert len(markers) == 1
    assert markers[0]["run_id"] == "run-1"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_routes_smoke.py tests/api/test_github_review_resume_logs.py -q`
Expected: FAIL — review-route tests return `200` with the old synchronous response shape (or `AttributeError: 'SimpleNamespace' object has no attribute 'worker'` for the new fixture against the old route — either outcome is the RED signal).

- [ ] **Step 3: Implement the route**

Replace the `@router.post("/review/{run_id}")` decorator and the whole `resume_review` function (lines 503-588) in `src/draftly/app/api/routes/github.py` with:

```python
@router.post("/review/{run_id}", status_code=202)
async def resume_review(
    run_id: str,
    decision: ReviewDecision,
    request: Request,
    background_tasks: BackgroundTasks,
    token: dict = Depends(require_reviewer_role),
) -> dict[str, Any]:
    """Resume a graph after human review (plan §9.1).

    Validates the review fast inline, then dispatches the shared
    ``review.resume`` task through the durable worker path (RQ when enabled,
    otherwise the in-process background-task fallback) — identical to the
    webhook route. The worker runs the graph, verifies the terminal status,
    and only then records the decision; this route returns immediately with
    ``202 {"status": "queued"}``.
    """
    app_state = getattr(request.app.state, "draftly", None)
    if app_state is None:
        raise HTTPException(status_code=503, detail="Runtime not started")

    reviews_repo = getattr(getattr(app_state.dependencies, "repositories", None), "reviews", None)
    if reviews_repo is None:
        logger.warning("review_resume_store_unavailable", run_id=run_id)
        raise HTTPException(status_code=503, detail="Reviews store unavailable")

    from draftly.review.service import ReviewService

    outcomes_repo = getattr(
        getattr(app_state.dependencies, "repositories", None),
        "feedback_outcomes",
        None,
    )
    service = ReviewService(
        repository=reviews_repo,
        outcomes_repository=outcomes_repo,
    )
    pending = await service.get_by_run_id(run_id)
    if pending is None:
        logger.warning("review_resume_not_found", run_id=run_id)
        raise HTTPException(
            status_code=404,
            detail=f"No pending review for run {run_id}",
        )
    org_id = str(token.get("org_id") or "")
    if pending.org_id != org_id:
        logger.warning("review_resume_org_mismatch", run_id=run_id, org_id=org_id)
        raise HTTPException(status_code=404, detail=f"No pending review for run {run_id}")

    surface = str(getattr(pending, "workflow", "") or "")
    if surface not in ("pull_request", "issue", "support"):
        logger.warning("review_resume_conflict", run_id=run_id)
        raise HTTPException(
            status_code=409,
            detail=f"Workflow {surface!r} is not resumable",
        )

    decision_kind = decision.normalized_decision()
    dispatch_args = {
        "review_id": pending.review_id,
        "approved": decision.approved,
        "decision": decision_kind,
        "reviewer_id": str(token.get("user_id") or token.get("sub") or ""),
        "comment": decision.comment or "",
        "org_id": org_id,
    }

    settings = getattr(app_state, "settings", None)
    rq_enabled = bool(getattr(settings, "rq_enabled", False)) if settings else False
    rq_queues = getattr(app_state, "rq_queues", None)
    task_handlers = getattr(app_state, "task_handlers", None)

    job_id = ""
    if rq_enabled and rq_queues is not None and task_handlers is not None:
        job = enqueue_job(
            queues=rq_queues,
            task_handlers=task_handlers,
            task_name="review.resume",
            **dispatch_args,
        )
        job_id = str(getattr(job, "id", ""))
        logger.info(
            "review_resume_enqueued",
            task_name="review.resume",
            run_id=run_id,
            rq_job_id=job_id,
        )
    else:
        worker = getattr(app_state, "worker", None)
        if worker is None or getattr(worker, "run_task", None) is None:
            raise HTTPException(status_code=503, detail="Background worker is disabled")
        background_tasks.add_task(
            worker.run_task, "review.resume", **dispatch_args
        )
        logger.info(
            "review_resume_dispatch_inprocess",
            task_name="review.resume",
            run_id=run_id,
        )

    return {
        "status": "queued",
        "run_id": run_id,
        "review_id": pending.review_id,
        "decision": decision_kind,
        "rq_job_id": job_id,
    }
```

Note: `enqueue_job` at `rq_jobs.py:105-113` already validates the task against `TASK_REGISTRY` (Task 3) and requires a non-None handler in `task_handlers`; the in-process fallback relies on `build_task_runner` having registered `review.resume` (Task 3). The removed `from draftly.review.resume import ReviewResumeError, resume_review_decision` import block (old line 549) must be dropped — the route no longer calls the sync resume function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/api/test_routes_smoke.py tests/api/test_github_review_resume_logs.py -q`
Expected: PASS.

Then confirm the whole worker/review surface:
Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/app/ tests/review/ tests/api/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/app/api/routes/github.py tests/api/test_routes_smoke.py tests/api/test_github_review_resume_logs.py
git commit -m "feat(github): dispatch review resume through durable worker path"
```

---

### Task 5: Full-suite verification, lint, and typecheck

**Files:** none (verification only).

- [ ] **Step 1: Run the full offline suite**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/ -q -m "not integration" -p no:cacheprovider`
Expected: PASS. (Baseline before these tasks: 1767 passed, 2 skipped, 4 deselected.)

- [ ] **Step 2: Lint the touched files**

Run:
```bash
cd draftly-agent-backend && .venv/bin/ruff check \
  src/draftly/review/resume.py \
  src/draftly/app/composition/workers.py \
  src/draftly/app/composition/rq_jobs.py \
  src/draftly/app/composition/workflows.py \
  src/draftly/app/api/routes/github.py \
  tests/review/test_review_resume.py \
  tests/app/test_workers_register.py \
  tests/api/test_routes_smoke.py \
  tests/api/test_github_review_resume_logs.py
```
Expected: no findings.

- [ ] **Step 3: Typecheck (must run from `src/`)**

Run: `cd draftly-agent-backend/src && ../.venv/bin/mypy draftly/review/resume.py draftly/app/composition/workers.py draftly/app/api/routes/github.py`
Expected: `Success: no issues found in N source files`.

- [ ] **Step 4: Commit any lint cleanups, otherwise nothing to commit**

```bash
git status --short
```
Expected: only the intended files from Tasks 1-4 (plus the pre-existing unrelated modifications you must NOT stage). If ruff reformatted anything, commit it:
```bash
git add -u && git commit -m "style: lint fixes for review resume dispatch"
```
(Only run the second command if step 2 produced changes.)

---

## Self-Review

**Spec coverage:**
- Core extraction (runtime-agnostic `resume_review_from_runtime`) → Task 1.
- Worker handler bound to composed `WorkflowContext` + RQ-retry idempotency → Task 2.
- Registry wiring (`TASK_REGISTRY`, `QUEUE_MAP`, `WorkflowRegistry`) → Task 3.
- Route dual-path dispatch (RQ + in-process fallback) + 202 response contract + fast inline validation → Task 4.
- Full verification/lint/typecheck → Task 5.

**Placeholder scan:** every code step carries concrete code; every test run carries exact commands and expected outcomes; no "add error handling"/"similar to Task N" phrasing.

**Type consistency:** `resume_review_from_runtime(repositories=..., runner=...) -> WorkflowState` (Task 1) is consumed by `run_review_resume` (Task 2) and takes `context.repositories`/`context.runner`; `run_review_resume(context, **kwargs) -> WorkflowState | None` is the `_wrap_workflow` target; `TASK_REGISTRY["review.resume"] == "review_resume"`, `WorkflowRegistry` name `review_resume`, and `QUEUE_MAP["review.resume"] == "webhooks"` consistent across Task 3; the route's dispatch kwargs (`review_id`, `approved`, `decision`, `reviewer_id`, `comment`, `org_id`) match the core signature in all tasks.

**Known non-goals (out of scope, deliberately):**
- RQ job-id-based dedup: this RQ version does not reject/dedup duplicate `job_id`s, so idempotency is handled in the handler (Task 2) instead.
- Returning the graph result to the reviewer's client synchronously: the product decides to poll run status — the 202 contract is the point of this change.
- Updating the dashboard/polling client that currently consumes the old `workflow_status` response field — a follow-up outside this plan.