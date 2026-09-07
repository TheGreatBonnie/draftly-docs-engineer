# Fix Onboarding Initialization Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the dynamic stage mapping and animated progress bar so all 5 initialization stages display correct progress in the onboarding initialize page.

**Architecture:** Emit unconditional `stage_progress` events at every stage boundary (not gated behind `_latest_progress`), emit `stage_progress` for all 5 stages, and remove the redundant API pre-fetch for `stage_config`. The `activeStage` detection logic and `TaskRow` progress bar rendering are already correct — no frontend code changes needed beyond removing the race condition.

**Tech Stack:** Python (FastAPI backend, Redis Streams, NeonDB), TypeScript (Next.js 16, React 19, Tailwind CSS, vitest)

**Spec:** Analysis doc at `docs/superpowers/specs/2026-08-27-onboarding-progress-analysis.md` (inline in this plan's context)

## Global Constraints

- Backend: Python 3.11+, FastAPI, asyncpg, Redis Streams
- Frontend: Next.js 16.3.1, React 19.2.8, TypeScript, Tailwind CSS, vitest
- Backend tests: pytest + pytest-asyncio
- Frontend tests: vitest + @testing-library/react
- Never commit secrets or API keys
- Follow existing code conventions (no new comments unless asked)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py` | Modify | Emit `stage_progress` for all 5 stages |
| `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py` | Modify | Test that `stage_progress` events are emitted for every stage |
| `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx` | Modify | Remove API pre-fetch for stage_config |
| `draftly-agent-frontend/tests/pages/initialize-page.test.tsx` | Modify | Test stage_progress handling |
| `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` | No change | Keep `get_initialize_status` endpoint (other consumers may use it) |

---

### Task 1: Emit unconditional `stage_progress` for all stages in the backend workflow

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py:65-106`

**Interfaces:**
- Consumes: existing `_publish()` helper, `STAGES` list
- Produces: `stage_progress` events with `stage` and `progress` (0-100) for all 5 stages, emitted unconditionally at every stage boundary

**Root cause:** `_flush_progress` (line 91) gates `stage_progress` behind `if _latest_progress:`, which depends on `_on_sync_progress` being called during the sync. Fast syncs skip the callback → no `stage_progress` → 0% bar.

- [ ] **Step 1: Add a helper to emit stage progress unconditionally**

In `initialize.py`, add a new helper function `_emit_stage_progress` inside `run_onboarding_initialize` (after the existing `_flush_progress` definition, around line 106):

```python
    async def _emit_stage_progress(stage: str, progress: int) -> None:
        """Emit a stage_progress event for the given stage (unconditional)."""
        await _publish("stage_progress", {
            "stage": stage,
            "progress": min(max(progress, 0), 100),
        })
        await asyncio.sleep(0)
```

- [ ] **Step 2: Decouple `repository_ingestion` progress from `_flush_progress`**

The existing `_flush_progress` emits `stage_progress` for `repository_ingestion` but only when `_latest_progress` is non-empty. Replace the conditional guard with unconditional emission using the new helper.

Modify `_flush_progress` (lines 91-106) to always emit `stage_progress`:

```python
    async def _flush_progress() -> None:
        if _latest_progress:
            await _publish("tool_progress", {
                "name": "documentation_sync",
                **_latest_progress,
            })
        # Always emit stage_progress for repository_ingestion, even if
        # _on_sync_progress never fired (fast sync).
        doc_count = _latest_progress.get("document_count", 0) if _latest_progress else 0
        total = max(_sync_total_files, 1)
        progress = min(int((doc_count / total) * 92), 92) if _sync_total_files > 0 else 0
        await _emit_stage_progress("repository_ingestion", progress)
```

- [ ] **Step 3: Emit progress milestones for `knowledge_construction`**

After `_stage_start("knowledge_construction", ...)` at line 168, add progress emissions:

```python
        await _emit_stage_progress("knowledge_construction", 10)
        extraction = await run_knowledge_construction(
            context, org_id=org_id, publish=_publish,
        )
        await _emit_stage_progress("knowledge_construction", 100)
```

- [ ] **Step 4: Emit progress milestones for `initial_evaluation`**

```python
        await _emit_stage_progress("initial_evaluation", 20)
        eval_result = await run_initial_evaluation(context, org_id=org_id)
        await _emit_stage_progress("initial_evaluation", 100)
```

- [ ] **Step 5: Emit progress milestones for `health_report`**

```python
        await _emit_stage_progress("health_report", 30)
        health_result = run_health_report(...)
        await _emit_stage_progress("health_report", 100)
```

- [ ] **Step 6: Emit progress milestones for `recommendations`**

```python
        await _emit_stage_progress("recommendations", 15)
        recs = await run_recommendations(...)
        await _emit_stage_progress("recommendations", 100)
```

- [ ] **Step 7: Write the failing test**

In `test_onboarding_initialize.py`, add a new test:

```python
@pytest.mark.asyncio
async def test_publishes_stage_progress_for_all_stages(mock_publisher, fake_repositories):
    """Each stage should emit stage_progress events (not just repository_ingestion)."""
    from draftly.workflows.context import WorkflowContext

    context = WorkflowContext(
        repositories=fake_repositories,
        publisher=mock_publisher,
    )
    with patch(
        "draftly.integrations.github.app_auth.build_installation_client",
        new=AsyncMock(return_value=MagicMock()),
    ):
        fake_sync_result = MagicMock()
        fake_sync_result.document_count = 5
        fake_sync_result.chunk_count = 20
        fake_sync_result.failed_files = []
        fake_sync_result.baseline = None
        fake_sync_result.last_committed_dates = [datetime.now(UTC)]

        with patch(
            "draftly.documentation.sync_service.SyncService"
        ) as service_cls:
            service_cls.return_value.sync = AsyncMock(return_value=fake_sync_result)
            with patch(
                "draftly.workflows.onboarding.stages.run_knowledge_construction",
                new=AsyncMock(return_value=MagicMock(
                    knowledge_count=10, relationship_count=5,
                    candidate_count=3, failed_chunks=[],
                )),
            ):
                with patch(
                    "draftly.workflows.onboarding.stages.run_initial_evaluation",
                    new=AsyncMock(return_value=MagicMock(score=0.7, dimensions={})),
                ):
                    with patch(
                        "draftly.workflows.onboarding.stages.run_health_report",
                        return_value=MagicMock(score=0.6, dimensions={}),
                    ):
                        with patch(
                            "draftly.workflows.onboarding.stages.run_recommendations",
                            new=AsyncMock(return_value=[]),
                        ):
                            await run_onboarding_initialize(
                                context,
                                org_id="org_test123",
                                selected_repository={"full_name": "test/repo"},
                            )

    calls = mock_publisher.publish.call_args_list
    progress_events = [
        c.args[0]
        for c in calls
        if hasattr(c, "args")
        and hasattr(c.args[0], "type")
        and c.args[0].type == "stage_progress"
    ]
    stages_with_progress = {e.payload["stage"] for e in progress_events}
    expected_stages = {
        "repository_ingestion", "knowledge_construction",
        "initial_evaluation", "health_report", "recommendations",
    }
    assert expected_stages.issubset(stages_with_progress), (
        f"Missing stage_progress for stages: {expected_stages - stages_with_progress}"
    )
```

- [ ] **Step 8: Write a test for unconditional emission (fast sync scenario)**

In `test_onboarding_initialize.py`, add a test that verifies `stage_progress` is emitted even when the sync callback never fires:

```python
@pytest.mark.asyncio
async def test_publishes_stage_progress_even_without_sync_callback(mock_publisher, fake_repositories):
    """stage_progress for repository_ingestion must emit even if _on_sync_progress never fires."""
    from draftly.workflows.context import WorkflowContext

    context = WorkflowContext(
        repositories=fake_repositories,
        publisher=mock_publisher,
    )
    with patch(
        "draftly.integrations.github.app_auth.build_installation_client",
        new=AsyncMock(return_value=MagicMock()),
    ):
        fake_sync_result = MagicMock()
        fake_sync_result.document_count = 3
        fake_sync_result.chunk_count = 10
        fake_sync_result.failed_files = []
        fake_sync_result.baseline = None
        fake_sync_result.last_committed_dates = []

        with patch(
            "draftly.documentation.sync_service.SyncService"
        ) as service_cls:
            # Sync returns immediately — no progress callback fires
            service_cls.return_value.sync = AsyncMock(return_value=fake_sync_result)
            with patch(
                "draftly.workflows.onboarding.stages.run_knowledge_construction",
                new=AsyncMock(return_value=MagicMock(
                    knowledge_count=5, relationship_count=2,
                    candidate_count=1, failed_chunks=[],
                )),
            ):
                with patch(
                    "draftly.workflows.onboarding.stages.run_initial_evaluation",
                    new=AsyncMock(return_value=MagicMock(score=0.5, dimensions={})),
                ):
                    with patch(
                        "draftly.workflows.onboarding.stages.run_health_report",
                        return_value=MagicMock(score=0.4, dimensions={}),
                    ):
                        with patch(
                            "draftly.workflows.onboarding.stages.run_recommendations",
                            new=AsyncMock(return_value=[]),
                        ):
                            await run_onboarding_initialize(
                                context,
                                org_id="org_test123",
                                selected_repository={"full_name": "test/repo"},
                            )

    calls = mock_publisher.publish.call_args_list
    repo_progress = [
        c.args[0]
        for c in calls
        if hasattr(c, "args")
        and hasattr(c.args[0], "type")
        and c.args[0].type == "stage_progress"
        and c.args[0].payload.get("stage") == "repository_ingestion"
    ]
    assert len(repo_progress) >= 1, (
        "stage_progress for repository_ingestion must be emitted even without sync callback"
    )
```

- [ ] **Step 9: Run the tests to verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_onboarding_initialize.py::test_publishes_stage_progress_for_all_stages tests/unit/workflows/test_onboarding_initialize.py::test_publishes_stage_progress_even_without_sync_callback -v`
Expected: FAIL — stages 2-5 won't have `stage_progress` events, and `repository_ingestion` won't emit without callback.

- [ ] **Step 10: Run the tests to verify they pass after implementation**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: All tests PASS.

- [ ] **Step 11: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/workflows/onboarding/initialize.py tests/unit/workflows/test_onboarding_initialize.py
git commit -m "feat: emit unconditional stage_progress for all 5 initialization stages"
```

---

### Task 2: Remove the API pre-fetch race condition in the frontend

**Files:**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx:146-156`

**Interfaces:**
- Consumes: `stageManifest` from SSE `stage_manifest` event
- Produces: `stageManifest` state used by `InitializationProgress`

- [ ] **Step 1: Remove the `getInitializeStatus` API pre-fetch useEffect**

Delete the entire `useEffect` block at lines 146-156:

```typescript
  useEffect(() => {
    getInitializeStatus()
      .then((res) => {
        if (res.stage_config && Array.isArray(res.stage_config)) {
          setStageManifest(res.stage_config);
        }
      })
      .catch(() => {
        // SSE stage_manifest event will provide fallback
      });
  }, []);
```

- [ ] **Step 2: Remove the unused import**

Remove `getInitializeStatus` from the import at line 8:

```typescript
import { startInitialize, retryInitialize } from "@/api/onboarding";
```

- [ ] **Step 3: Remove the dead test and replace with a meaningful assertion**

In `initialize-page.test.tsx`, the existing test `expect(getInitializeStatus).not.toHaveBeenCalled()` (line 86-92) becomes meaningless after removing the import — it tests nothing useful. Remove that test entirely and replace it with a test that verifies `stageManifest` is populated exclusively via SSE:

```typescript
it("populates stageManifest only from SSE stage_manifest events", async () => {
  const events = [
    { type: "stage_manifest", runId: "r1", seq: 1, ts: "2026-01-01T00:00:00Z", payload: { stages: [{ id: "repository_ingestion", label: "Sync Docs" }] } },
  ];
  mockUseWorkflowEvents.mockReturnValue({ status: "live", events, nodeStates: {}, text: "" });
  await renderAndWait();
  expect(screen.getByText("Sync Docs")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run frontend tests**

Run: `cd draftly-agent-frontend && npx vitest run tests/pages/initialize-page.test.tsx`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd draftly-agent-frontend
git add app/\(onboarding\)/onboarding/initialize/page.tsx tests/pages/initialize-page.test.tsx
git commit -m "fix: remove API pre-fetch race condition for stage_config"
```

---

### Task 3: Add frontend test for stage_progress handling

**Files:**
- Modify: `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`

**Interfaces:**
- Consumes: `stageProgress` map populated from SSE `stage_progress` events
- Produces: Test confirming `InitializationProgress` renders correctly with multi-stage progress data

**Note:** The `activeStage` detection logic (lines 75-92 of `page.tsx`) and the `TaskRow` progress bar rendering (lines 276-362 of `initialization-progress.tsx`) are already correct. The root cause was the backend not emitting `stage_progress` for stages 2-5 (fixed in Task 1). No frontend code changes are needed — only a test to verify the event flow works end-to-end.

- [ ] **Step 1: Write the test for stage_progress handling**

In `initialize-page.test.tsx`, add a test that asserts the actual progress percentage is rendered (not just the page title):

```typescript
it("renders progress percentage from stage_progress events", async () => {
  const events = [
    { type: "stage_change", runId: "r1", seq: 1, ts: "2026-01-01T00:00:00Z", payload: { stage: "repository_ingestion", status: "started" } },
    { type: "stage_progress", runId: "r1", seq: 2, ts: "2026-01-01T00:00:01Z", payload: { stage: "repository_ingestion", progress: 50 } },
    { type: "stage_change", runId: "r1", seq: 3, ts: "2026-01-01T00:00:02Z", payload: { stage: "repository_ingestion", status: "completed" } },
    { type: "stage_change", runId: "r1", seq: 4, ts: "2026-01-01T00:00:03Z", payload: { stage: "knowledge_construction", status: "started" } },
    { type: "stage_progress", runId: "r1", seq: 5, ts: "2026-01-01T00:00:04Z", payload: { stage: "knowledge_construction", progress: 30 } },
  ];
  mockUseWorkflowEvents.mockReturnValue({ status: "live", events, nodeStates: {}, text: "" });
  await renderAndWait();
  expect(screen.getByText("50%")).toBeInTheDocument();
  expect(screen.getByText("30%")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run frontend tests**

Run: `cd draftly-agent-frontend && npx vitest run tests/pages/initialize-page.test.tsx`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
cd draftly-agent-frontend
git add tests/pages/initialize-page.test.tsx
git commit -m "test: add stage_progress handling test for multi-stage progress"
```

---

### Task 4: Verify end-to-end event flow

**Files:**
- No file changes — verification only

- [ ] **Step 1: Run all backend tests**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: All tests PASS, including the new `test_publishes_stage_progress_for_all_stages`.

- [ ] **Step 2: Run all frontend tests**

Run: `cd draftly-agent-frontend && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 3: Run frontend lint**

Run: `cd draftly-agent-frontend && npx eslint app/\(onboarding\)/onboarding/initialize/page.tsx components/onboarding/initialization-progress.tsx`
Expected: No lint errors.

- [ ] **Step 4: Verify the data flow manually**

Trace the event flow:
1. Backend `_emit_stage_progress("knowledge_construction", 10)` → `_publish("stage_progress", ...)` → `RedisStreamBus.publish()` → Redis Stream `draftly:stream:{run_id}`
2. SSE endpoint `_event_source()` → `bus.subscribe(run_id)` → `_format_envelope()` → `event: stage_progress\ndata: {...}\n\n`
3. Frontend `EventSource.addEventListener("stage_progress", ...)` → `apply()` → `setEvents()` → `useMemo` parses `stage_progress` events → `setStageProgress({ knowledge_construction: 10 })`
4. `InitializationProgress` receives `stageProgress={ knowledge_construction: 10 }` → `TaskRow` renders progress bar at 10%

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: complete onboarding initialization progress fix"
```

---

## Summary of Changes

| Problem | Fix | Files |
|---------|-----|-------|
| Progress 0% for ALL stages (including `repository_ingestion`) | Emit unconditional `stage_progress` at every stage boundary | `initialize.py` |
| `repository_ingestion` progress gated behind sync callback | Remove `if _latest_progress:` guard from `stage_progress` emission | `initialize.py` |
| API pre-fetch race condition | Remove `getInitializeStatus` useEffect | `page.tsx` |
| No test for multi-stage progress flow | Add frontend test for `stage_progress` handling | `initialize-page.test.tsx` |

## What's NOT Changed

- `get_initialize_status` API endpoint — kept for other consumers (dashboard, debugging)
- `stage_config` storage in NeonDB — still useful as a backup/reference
- Preset tasks in `InitializationProgress` — they're visual context, not functional
- Redis Stream bus implementation — working correctly
- SSE endpoint — working correctly, already forwards all event types
