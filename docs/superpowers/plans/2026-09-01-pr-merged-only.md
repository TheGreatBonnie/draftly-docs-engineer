# PR-Merged-Only Documentation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documentation graph run **only** for merged GitHub pull requests. All other `pull_request.*` actions (opened, edited, closed-not-merged) are skipped before the idempotency claim and never touch the graph. Push and release events, which route to the same `pull_request` surface via a different event prefix, are **unaffected**.

**Architecture:** Three contained edits in the `draftly-agent-backend` event/runner/route layers. (1) `PullRequestProcessor.process()` is taught to label a `closed` + `merged=true` PR as `pull_request.merged` (a pure normalization fix — today it wrongly emits `pull_request.closed`). (2) `WorkflowRunner.run()` gains a prefix-scoped gate that returns `SKIPPED` for any `pull_request.*` event whose event_type does not end in `.merged`, positioned before the idempotency claim so skipped events leave no audit/duplicate record. (3) As defense-in-depth, the `POST /github/webhook` route adds an early merged-only gate on the _normalized_ event (Option B), so non-merged PRs are dropped at the edge before the runner is even enqueued. Tests are added first in the existing runner test module's style (fake repos + scripted graph, no DB/model).

**Important pre-existing fact (verified in this session):** The only merged-detection logic in the repo lives in `src/draftly/integrations/github/webhooks.py` (`GitHubWebhookHandler.parse`, lines 103-107), but that class is **dead/orphaned code** — it is not imported or called anywhere in `src/` or tests. The live webhook path is `routes/github.py` → `EventComposition.normalize_github` → `PullRequestProcessor`, which currently has **no** merged logic. There is nothing to "move"; the merged handling is implemented fresh in the live path.

**Tech Stack:** Python 3.11, pytest / pytest-asyncio, Pydantic. Tests use the existing `FakeEventsRepo`/`FakeGraph`/`make_context` fakes in `tests/workflows/test_phase5_runner_events.py`; no DB or model needed.

**Spec:** The design was agreed in chat (the brainstorming design + Option A, PR-events-scoped, plus a route-level defense-in-depth gate on the normalized event). No separate spec file exists; this plan argues from the agreed design. Key decision: the skip gate keys on the **event prefix** (`pull_request.*`) not the graph surface, so push/release (which share the `pull_request` surface) pass through unchanged.

## Global Constraints

- The primary merged-only gate lives in `WorkflowRunner.run()` — the single choke point for both the webhook path and any scheduled/replayed path.
- The `POST /github/webhook` route (`src/draftly/app/api/routes/github.py`) gains a route-level merged gate **as defense-in-depth only** (Task 3). It checks the _normalized_ event's `.merged` suffix (Option B), so there is one `.merged` source of truth (the `PullRequestProcessor` label), and the route does not re-implement raw `closed && merged` parsing.
- Do not modify or delete the orphaned `GitHubWebhookHandler` (`src/draftly/integrations/github/webhooks.py`) — it is dead code, not wired into runtime, and out of scope. Leave as-is.
- No comments in code unless they clarify non-obvious intent (the skip gates' "only merged PRs run" rationale warrants one short docstring/comment).
- Follow existing code style: `from __future__ import annotations`, structlog for logging, type hints on all signatures.
- `WorkflowStatus.SKIPPED` is the canonical early-return status (already used for unknown surfaces at `runner.py:123-124`).
- Tests must pass: `pytest tests/workflows/test_phase5_runner_events.py tests/events/github` (plus full backend suite before completion).

---

### Task 1: Normalize merged PRs to `pull_request.merged`

**Files:**

- Modify: `src/draftly/events/github/pull_request.py` (`process()`, lines 24-44)
- Test: `tests/events/github/test_pull_request_processor.py` (new file)

**Interfaces:**

- Consumes: `BaseProcessor._action(payload, default="updated")` (returns `action` string, lowercased/underscored — `base.py:54-56`); `payload["pull_request"]` dict.
- Produces: `ProcessedEvent` with:
  - `event_type` = `"pull_request.merged"` when `action == "closed"` and `payload["pull_request"]["merged"]` is truthy, else `"pull_request.{action}"`.
  - `pull_request["action"]` field set to the same (possibly `"merged"`) value.
  - `_derive_id(payload, pr, action)` receives the possibly-`"merged"` action (so its fallback id uses `merged`).

**Rationale:** Today `PullRequestProcessor` always emits `pull_request.{action}`, so a merged PR (GitHub sends `action="closed"` with `pull_request.merged=true`) is labeled `pull_request.closed`. Task 2 relies on `.merged` suffix detection, so this labeling fix must land first.

- [ ] **Step 1: Write the failing tests**

Create `tests/events/github/test_pull_request_processor.py`:

```python
from __future__ import annotations

from draftly.events.github.pull_request import PullRequestProcessor


def closed_pr_payload(*, merged: bool) -> dict:
    return {
        "action": "closed",
        "delivery_id": "d-merged",
        "repository": {"full_name": "acme/api"},
        "sender": {"login": "dev"},
        "pull_request": {
            "number": 7,
            "title": "Fix widget",
            "state": "closed",
            "merged": merged,
            "head": {"sha": "abc"},
            "base": {"ref": "main"},
        },
    }


async def test_closed_merged_emits_pull_request_merged() -> None:
    processor = PullRequestProcessor()
    event = await processor.process(closed_pr_payload(merged=True))
    assert event.event_type == "pull_request.merged"
    assert event.pull_request["action"] == "merged"


async def test_closed_not_merged_emits_pull_request_closed() -> None:
    processor = PullRequestProcessor()
    event = await processor.process(closed_pr_payload(merged=False))
    assert event.event_type == "pull_request.closed"
    assert event.pull_request["action"] == "closed"


async def test_opened_emits_pull_request_opened() -> None:
    processor = PullRequestProcessor()
    event = await processor.process(
        {
            "action": "opened",
            "repository": {"full_name": "acme/api"},
            "pull_request": {"number": 8, "head": {"sha": "x"}, "base": {"ref": "main"}},
        }
    )
    assert event.event_type == "pull_request.opened"
    assert event.pull_request["action"] == "opened"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/events/github/test_pull_request_processor.py -v`
Expected: `test_closed_merged_emits_pull_request_merged` FAILS (actual `event_type == "pull_request.closed"`); the other two PASS.

- [ ] **Step 3: Implement merged labeling**

Modify `src/draftly/events/github/pull_request.py`, inside `process()` right after line 27 (`action = self._action(payload, default="updated")`):

```python
        action = self._action(payload, default="updated")
        if action == "closed" and pr.get("merged"):
            action = "merged"
```

(`pr = payload.get("pull_request") or {}` is already bound at line 24.) No other line changes — the existing `ProcessedEvent(...)` at lines 29-44 now picks up `event_type=f"{self.event_type}.{action}"`, `pull_request={"action": action}` and `_derive_id(payload, pr, action)` automatically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/events/github/test_pull_request_processor.py -v`
Expected: all 3 PASS.

- [ ] **Step 5: Run existing normalize tests to guard against regressions**

Run: `pytest tests/workflows/test_phase5_runner_events.py -k "EventComposition or pr_payload" -v`
Expected: PASS (the existing `test_github_pr_payload_normalizes` still yields `pull_request.opened`; `TestEventComposition` group green). The runner-level gating is covered in Task 2.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/events/github/pull_request.py tests/events/github/test_pull_request_processor.py
git commit -m "fix(events): label merged PRs as pull_request.merged"
```

---

### Task 2: Skip non-merged PR events before the idempotency claim

**Files:**

- Modify: `src/draftly/workflows/runner.py` (`run()`, after line 125, before line 128)
- Test: `tests/workflows/test_phase5_runner_events.py` (extend with a new test class)

**Interfaces:**

- Consumes:
  - `WorkflowRunner.run(event: dict[str, Any]) -> WorkflowState` (`runner.py:116-137`).
  - `state.surface` is set at `runner.py:125` from `self.dispatcher.route(event)`.
  - `state.finish(WorkflowStatus.SKIPPED)` returns a finished `WorkflowState` (`runner.py:123-124` pattern).
  - `event["event_type"]` string, e.g. `"pull_request.opened"`, `"pull_request.merged"`, `"push.pushed"`, `"release.published"`.
- Produces: for `pull_request.*` events whose `event_type` does not end in `.merged`, an early return of `state.finish(WorkflowStatus.SKIPPED)` BEFORE `_claim` (so `context.events.claimed`/`statuses` stay empty and no duplicate/audit row is written). For all other events, no behavior change.

**Gate scoping (critical):** The gate tests the **event prefix** (`str(event.get("event_type") or "").split(".")[0]`) and requires it to be exactly `"pull_request"`. It must NOT gate on `state.surface`, because push/release events also resolve to the `pull_request` surface and must keep running. This is the regression behavior guarded by Step 4.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workflows/test_phase5_runner_events.py`, in the same file after `TestRunnerOutcomes` (uses existing `make_context`, `FakeGraph`, `completed_result`, and follows the `run_with` pattern at line 125 but with overridable event):

```python
class TestRunnerMergedOnlyGate:
    async def _run_event(self, event_type: str) -> tuple[WorkflowState, object]:
        from draftly.workflows.context import WorkflowContext
        from draftly.workflows.runner import WorkflowRunner

        context = make_context()
        graph = FakeGraph(completed_result())
        runner = WorkflowRunner(context, graph_factory=lambda r, s: graph)
        state = await runner.run(
            {"event_id": "evt-gate", "event_type": event_type, "source": "github"}
        )
        return state, context

    async def test_opened_pr_skips_before_claim(self) -> None:
        state, context = await self._run_event("pull_request.opened")
        assert state.status.value == "skipped"
        assert state.surface == "pull_request"
        # Idempotency claim never happened -> no audit/duplicate record.
        assert context.events.claimed == {}
        assert context.events.statuses == {}

    async def test_edited_pr_skips(self) -> None:
        state, _ = await self._run_event("pull_request.edited")
        assert state.status.value == "skipped"

    async def test_closed_not_merged_pr_skips(self) -> None:
        state, _ = await self._run_event("pull_request.closed")
        assert state.status.value == "skipped"

    async def test_merged_pr_runs_graph(self) -> None:
        state, context = await self._run_event("pull_request.merged")
        assert state.status.value == "delivered"
        assert context.events.statuses["evt-gate"] == "completed"

    async def test_push_and_release_not_skipped(self) -> None:
        # Guard: push/release share the pull_request surface but must keep running.
        for event_type in ("push.pushed", "release.published"):
            ctx = make_context()
            graph = FakeGraph(completed_result())
            runner = WorkflowRunner(
                ctx, graph_factory=lambda r, s: graph, dispatcher=EventDispatcher()
            )
            state = await runner.run(
                {"event_id": event_type, "event_type": event_type, "source": "github"}
            )
            assert state.status.value == "delivered", event_type
```

Note: `test_push_and_release_not_skipped` passes `EventDispatcher()` explicitly so `push.pushed`/`release.published` resolve to the `pull_request` surface (mirrors the routing test at `test_phase5_runner_events.py:220-230`); the runner's default dispatcher is already an `EventDispatcher()`, but being explicit avoids coupling after any default change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/workflows/test_phase5_runner_events.py -k "MergedOnlyGate" -v`
Expected: `test_opened_pr_skips_before_claim`, `test_edited_pr_skips`, `test_closed_not_merged_pr_skips` FAIL (the runner currently runs the graph, producing `delivered`). `test_merged_pr_runs_graph` and `test_push_and_release_not_skipped` PASS (no gate yet, so everything runs).

- [ ] **Step 3: Implement the merged-only skip gate**

Modify `src/draftly/workflows/runner.py`, `run()`. Insert the gate immediately after `state.surface = surface` (line 125) and before `# 1. Idempotency: claim the event before touching the graph.` (line 127):

```python
        state.surface = surface

        # Only merged PRs run the documentation graph; other PR actions skip
        # before the idempotency claim so they leave no audit/duplicate record.
        # Gate on the event prefix (not the surface) so push/release events that
        # share the "pull_request" surface still run.
        event_type = str(event.get("event_type") or "")
        if event_type.split(".")[0] == "pull_request" and not event_type.endswith(
            ".merged"
        ):
            return state.finish(WorkflowStatus.SKIPPED)

        # 1. Idempotency: claim the event before touching the graph.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/workflows/test_phase5_runner_events.py -v`
Expected: ALL tests pass, including the new `TestRunnerMergedOnlyGate` class (all 5) and the pre-existing `test_unknown_surface_skips_graph` (line 166) and `TestRunnerOutcomes` cases.

- [ ] **Step 5: Run the full runner + events + unit suites for regressions**

Run: `pytest tests/workflows tests/events tests/unit -q`
Expected: PASS. If any push/release or surface-routing test now behaves differently, the gate is either too broad (excludes push/release) or too narrow — check `event_type.split(".")[0]` logic against the failing test.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/workflows/runner.py tests/workflows/test_phase5_runner_events.py
git commit -m "feat(workflow): run documentation graph for merged PRs only"
```

---

### Task 3: Route-level merged gate on the webhook (defense-in-depth)

**Files:**

- Modify: `src/draftly/app/api/routes/github.py` (`github_webhook()`, after line 251 `event = await app_state.events.normalize_github(payload)`, before line 256 `background_tasks.add_task(...)`)
- Test: `tests/test_api/test_github_webhook.py` (new file, or extend existing API test file if one exists)

**Interfaces:**

- Consumes: the _normalized_ event dict from `app_state.events.normalize_github(payload)` (produced by `PullRequestProcessor` per Task 1); its `event_type` is `"pull_request.merged"` for merged PRs, `"pull_request.{action}"` otherwise.
- Produces: for `pull_request.*` events whose `event_type` does not end in `.merged`, an **early HTTP return** (`WebhookResponse(status="... skipped, not merged")`) BEFORE `background_tasks.add_task(...)` is called, so the runner is never enqueued for non-merged PRs. For all other events (including `push.*` / `release.*`, which share the `pull_request` surface), the existing behavior is unchanged.

**Rationale:** This is ephemeral/defense-in-depth — it drops non-merged PRs at the transport edge. It is intentionally secondary to the runner gate (Task 2); the runner gate remains authoritative for any entry path that bypasses this route. Gate on the normalized event (Option B), NOT on the raw payload, so the `.merged`-suffix decision has a single source of truth (the `PullRequestProcessor` label) rather than re-implementing `closed && merged` in the route.

- [ ] **Step 1: Write the failing tests**

The API tests in this repo call route functions directly with a `MagicMock` request (`request.app.state.draftly` stubbed) rather than a full `TestClient` — see `tests/test_api/test_jobs_rq.py:15-32`. Follow that convention.

Create `tests/test_api/test_github_webhook.py`:

```python
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


def _pr_event(event_type: str) -> dict:
    return {"event_type": event_type, "repository": "acme/api"}


async def test_non_merged_pr_not_enqueued() -> None:
    from draftly.app.api.routes.github import github_webhook

    request = MagicMock()
    events = MagicMock()
    events.normalize_github = AsyncMock(return_value=_pr_event("pull_request.opened"))
    runner = MagicMock()
    runner.run = AsyncMock()
    workflows = MagicMock()
    workflows.runner = runner
    request.app.state.draftly = MagicMock(events=events, workflows=workflows)

    # Bypass signature/body parsing: monkeypatch the header + parse path is
    # heavy, so drive the gate via the normalize step. Use the standalone
    # route body contract: pass a fabricated request whose body/headers are
    # satisfied by signing (see Step 4 for the full HTTP-level path).
    body = b"{}"
    request.body = AsyncMock(return_value=body)
    request.headers = {
        "X-Hub-Signature-256": "sha256=0000",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "d-1",
    }

    # Patch signature verification to accept (avoids needing the real secret).
    with pytest.MonkeyPatch.context() as mp:
        import draftly.app.api.routes.github as routes_mod

        mp.setattr(
            routes_mod, "verify_webhook_signature", lambda body, sig: True
        )
        result = await github_webhook(request=request, background_tasks=MagicMock())

    assert "skipped" in str(result)
    runner.run.assert_not_awaited()


async def test_merged_pr_enqueued() -> None:
    from draftly.app.api.routes.github import github_webhook

    request = MagicMock()
    events = MagicMock()
    events.normalize_github = AsyncMock(return_value=_pr_event("pull_request.merged"))
    runner = MagicMock()
    runner.run = AsyncMock()
    workflows = MagicMock()
    workflows.runner = runner
    request.app.state.draftly = MagicMock(events=events, workflows=workflows)
    request.body = AsyncMock(return_value=b"{}")
    request.headers = {
        "X-Hub-Signature-256": "sha256=0000",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "d-2",
    }

    bt = MagicMock()
    with pytest.MonkeyPatch.context() as mp:
        import draftly.app.api.routes.github as routes_mod

        mp.setattr(routes_mod, "verify_webhook_signature", lambda body, sig: True)
        result = await github_webhook(request=request, background_tasks=bt)

    assert result["accepted"] is True
    bt.add_task.assert_called_once()


async def test_push_and_release_not_blocked() -> None:
    from draftly.app.api.routes.github import github_webhook

    for event_type in ("push.pushed", "release.published"):
        request = MagicMock()
        events = MagicMock()
        events.normalize_github = AsyncMock(return_value=_pr_event(event_type))
        runner = MagicMock()
        runner.run = AsyncMock()
        workflows = MagicMock()
        workflows.runner = runner
        request.app.state.draftly = MagicMock(events=events, workflows=workflows)
        request.body = AsyncMock(return_value=b"{}")
        request.headers = {
            "X-Hub-Signature-256": "sha256=0000",
            "X-GitHub-Event": event_type.split(".")[0],
            "X-GitHub-Delivery": "d-3",
        }

        bt = MagicMock()
        with pytest.MonkeyPatch.context() as mp:
            import draftly.app.api.routes.github as routes_mod

            mp.setattr(routes_mod, "verify_webhook_signature", lambda body, sig: True)
            await github_webhook(request=request, background_tasks=bt)

        bt.add_task.assert_called_once(), event_type
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_api/test_github_webhook.py -v`
Expected: `test_non_merged_pr_not_enqueued` FAILS (today the non-merged `pull_request.opened` IS enqueued via `bt.add_task`), and `test_merged_pr_enqueued` / `test_push_and_release_not_blocked` PASS (today everything is enqueued). The `test_merged_pr_enqueued` PASS confirms the enqueue path works before the gate exists.

- [ ] **Step 3: Implement the route-level gate**

Modify `src/draftly/app/api/routes/github.py`, `github_webhook()`, after `event = await app_state.events.normalize_github(payload)` (line 251) and before `background_tasks.add_task(app_state.workflows.runner.run, event)` (line 256):

```python
    # Only merged PRs proceed to the runner; drop other PR actions at the
    # edge. Defense-in-depth — the runner gate (workflow/runner.py) is the
    # authoritative filter for all entry paths.
    if str(event.get("event_type", "")).startswith("pull_request.") and not str(
        event.get("event_type", "")
    ).endswith(".merged"):
        logger.info(
            "github_webhook_pr_skipped",
            event_type=event.get("event_type"),
            delivery_id=delivery_id,
        )
        return WebhookResponse(status=f"{event.get('event_type')} (skipped, not merged)")

    background_tasks.add_task(app_state.workflows.runner.run, event)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_api/test_github_webhook.py -v`
Expected: all 3 PASS — `pull_request.opened` not enqueued (skipped), `pull_request.merged` enqueued once, `push.pushed`/`release.published` enqueued (unchanged).

- [ ] **Step 5: Run the full suite for regressions**

Run: `pytest tests/test_api tests/workflows/test_phase5_runner_events.py -q`
Expected: PASS. No existing GitHub-route or runner test regressed.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/app/api/routes/github.py tests/test_api/test_github_webhook.py
git commit -m "feat(github): drop non-merged PR webhooks at the route edge"
```

---

### Task 4: Final verification

**Files:**

- None to modify.

**Interfaces:**

- Consumes: the combined behavior from Tasks 1, 2, and 3.

- [ ] **Step 1: Run the full backend test suite**

Run: `pytest -q`
Expected: PASS. No `TestEventComposition`, routing, or runner regression.

- [ ] **Step 2: Run lint/typecheck if the repo defines it**

Check `pyproject.toml` / Makefile for a configured linter (e.g. ruff, mypy) and run it on the three modified source files:
Run (if ruff configured): `ruff check src/draftly/events/github/pull_request.py src/draftly/workflows/runner.py src/draftly/app/api/routes/github.py`
Expected: clean (no new violations).

- [ ] **Step 3: Sanity-check the end-to-end label + gate via a quick scenario check**

Run: `python - <<'PY'
import asyncio
from draftly.events.github.pull_request import PullRequestProcessor
from draftly.events.types import EventType

async def main():
p = PullRequestProcessor()
merged = await p.process({
"action": "closed",
"repository": {"full_name": "acme/api"},
"pull_request": {"number": 1, "merged": True, "head": {"sha": "a"}, "base": {"ref": "main"}},
})
print(merged.event_type) # expect pull_request.merged
assert merged.event_type == f"{EventType.GITHUB_PULL_REQUEST.value}.merged"

asyncio.run(main())
PY`Expected: prints`pull_request.merged` and exits 0.

- [ ] **Step 4: Commit any lint/type fixes from Step 2**

Only if Step 2 produced changes. If none, skip.

```bash
git add -A
git commit -m "chore: lint/type fixes for merged-only PR gate"
```
