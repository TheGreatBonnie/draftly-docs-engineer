# Initialization Progress Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make onboarding initialization progress numbers accurate end-to-end, add a single overall progress bar, show an ETA hint, and smooth the LLM-heavy stage ticks so users see exactly how far the run has advanced at every moment.

**Architecture:** Coordinated backend + frontend changes.
- **(1) Backend:** `run_onboarding_initialize` emits a final `stage_progress {stage: "repository_ingestion", progress: 100}` right before completing the stage so the repository bar fills instead of capping at 92%.
- **(2) Backend (in-scope O2):** a new `overall_progress` event (payload `{progress: 0-100}`) is emitted centrally alongside every `stage_progress` and every `stage_change "completed"`, computed from a single weight table (`STAGE_WEIGHTS` next to `STAGES` in `initialize.py`) applied to each stage's latest reported % (100 once completed). The backend becomes the single source of truth for the aggregate; weights live once, next to the stage list.
- **(3) Frontend:** the page listens for `overall_progress` events (authoritative) and keeps a quadratic-weighted memo (`STAGE_WEIGHTS`, 0.35/0.35/0.15/0.075/0.075) as the fallback used only until the first aggregated event arrives (page mount, minimal replay). `InitializationProgress` renders one prominent overall bar above the task list from the effective value.
- **(4) Frontend (in-scope O1):** the page records `{at, value}` samples of the effective overall %, and the component extrudes an ETA ("~Xs left") from the slope via a pure, unit-tested helper.
- **(5) Backend (in-scope O3):** the fixed batch/sample emit cadence in `knowledge_construction` and `initial_evaluation` is replaced by a corpus-size-scaled tick interval (≤ `EMIT_TICK_BUDGET = 50` ticks per stage regardless of corpus size), so bars update in smooth steps while SSE volume stays bounded and the Redis stream cap (`MAX_STREAM_LEN = 1000`) is never threatened. This also bounds the number of `overall_progress` events, since one is emitted per `stage_progress`.

The two existing progress displays (left task-row bar, right "Progress" `processed/total` tile) are unchanged.

- **(6) Frontend task-list declutter (Tasks 8-10):** the four pre-completed preset rows (`Workspace created`, `GitHub connected`, `Repository indexed`, `Documentation discovered`) are removed from `InitializationProgress` so the task list shows ONLY the five manifest stages; the live `"N files processed"` subdetail moves from the `docs_discovered` preset onto the `repository_ingestion` stage row; the pre-event window (no manifest, no active stage) renders a shimmer skeleton built from the existing `.draftly-skeleton` utility instead of the preset rows; and the active TaskRow status-indicator dot spins via Tailwind's built-in `animate-spin` (same dotted-ring pattern as `github-connect.tsx:117`).

**Tech Stack:** Python 3.12 / asyncio / pytest on the backend; React 19 / Next 16 / TypeScript / Vitest / Testing Library on the frontend.

**Spec:** No separate spec file (bounded, converged in chat). Original approved scope: "Both end-to-end" + "Add overall progress bar" (frontend memo). User then directed that the three initially-deferred capabilities (ETA → O1, backend-computed aggregate → O2, scaled LLM emit rates → O3) become in-scope implementation tasks. They are Tasks 4-7 below.

## Global Constraints

- SSE schema: ONE new event type is added — `overall_progress` with `payload: {"progress": number}`. No existing event shape changes; `stage_progress` / `stage_change` payloads are untouched.
- Effective overall progress precedence: **`overall_progress` event value wins; the page memo (`STAGE_WEIGHTS`) is the fallback** until the first event arrives. On replay/resume, stored `overall_progress` events re-deliver in order, so the events-based source reconstructs correctly.
- The lifecycle sentinel `initialization_started` (backend `initialize.py:189`) is a keepalive stamp with no `completed` counterpart and is NOT a manifest stage. It must never influence stage tracking or the aggregate (`LIFECYCLE_STAGES` filter in `page.tsx` already excludes it from `stageHistory`; it is also absent from `STAGES` and from `STAGE_WEIGHTS`).
- Overall aggregate math: `overall = round(Σ w_stage × pct_stage)`, clamped `[0, 100]`; `pct_stage = 100` once completed (or its explicit final `stage_progress` 100), else the latest reported `stage_progress`, else 0.
- Backend tests run with: `uv run pytest <path> -q` from `draftly-agent-backend/`.
- Frontend tests run with: `npx vitest run <path>` from `draftly-agent-frontend/`.
- After code changes, run `graphify update .` from the repo root (AST-only, no API cost).
- `InitializationProgress` props stay optional extensions: `overallProgress?: number`, `overallTimeline?: { at: number; value: number }[]`. Existing component tests render without them and must keep passing unchanged (overall bar and ETA only render when provided).
- `overallProgress` is an integer 0-100. `Math.round` for display; no JS easing — the existing CSS `transition-[width] duration-300` handles smoothness.

---

### Task 1: Backend — repository_ingestion reaches 100% before completion

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py:233-246`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py` (new test; reuse the existing `mock_publisher` / `fake_repositories` fixtures at lines 283-303 and the `_stage_progress_events` helper at lines 683-691)

**Interfaces:**
- Consumes: `_emit_stage_progress(stage: str, progress: int)` (`initialize.py:145-150`) — publishes a `stage_progress` envelope, clamps to `[0, 100]`, and `await asyncio.sleep(0)`.
- Consumes: `_stage_complete(stage, stats)` (existing, near `initialize.py:243`).
- Produces: an additional `stage_progress` envelope with `payload = {"stage": "repository_ingestion", "progress": 100}`, published immediately before the stage's `stage_change "completed"`.

- [ ] **Step 1: Write the failing test**

Append to `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py` (after the existing `test_publishes_stage_progress_even_without_sync_callback`, which ends near line 665). Use the same nested-mock `run_onboarding_initialize` harness pattern as that test — `SyncService.sync` returns a `MagicMock` result with `document_count > 0` and `on_progress` never invoked:

```python
@pytest.mark.asyncio
async def test_repository_ingestion_emits_final_100_progress(mock_publisher, fake_repositories):
    """The repository_ingestion bar must fill to 100% before the stage completes.

    Regression: the stage topped out at 92% (or 0% when sync reported no
    progress) and then flipped straight to a check mark, so the active bar
    never visually completed.
    """
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

    repo_progress = _stage_progress_events(mock_publisher, "repository_ingestion")
    assert len(repo_progress) >= 2, (
        "Expected at least the flush emit plus a final 100 emit"
    )
    assert repo_progress[-1].payload["progress"] == 100, (
        f"Last repository_ingestion stage_progress must be 100, got "
        f"{repo_progress[-1].payload.get('progress')}"
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/workflows/test_onboarding_initialize.py::test_repository_ingestion_emits_final_100_progress -q` from `draftly-agent-backend/`

Expected: FAIL — the final `repository_ingestion` `stage_progress` is `0` (no sync callback → `_sync_total_files == 0`), not `100`.

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py`, inside `_run_stages()`, immediately before `await _stage_complete("repository_ingestion", ...)` (the line currently beginning at 243), add an unconditional final emit:

```python
        await _flush_progress()
        await _cancel_flusher()

        doc_count = _latest_progress.get("document_count", 0) if _latest_progress else 0
        if _sync_total_files > 0 and doc_count < _sync_total_files:
            await _emit_stage_progress("repository_ingestion", 92)

        # Close the repository_ingestion bar at 100 so the UI shows it fill
        # before the stage_change "completed" flips the row to a check mark.
        await _emit_stage_progress("repository_ingestion", 100)

        if sync_result.document_count == 0 and sync_result.failed_files:
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/workflows/test_onboarding_initialize.py -q` from `draftly-agent-backend/`

Expected: PASS — new test green; all existing initialization tests still pass.

- [ ] **Step 5: Run the full backend workflow + events suites to catch regressions**

Run: `uv run pytest tests/unit/workflows tests/events tests/api -q` from `draftly-agent-backend/`

Expected: PASS (no new failures; the added 100 emit is additive and clamped by `_emit_stage_progress`).

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py
git add draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py
git commit -m "fix(workflow): fill repository_ingestion progress bar to 100% before completion"
```

---

### Task 2: Frontend page (fallback) — derive `overallProgress` memo and pass it down

**Files:**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx` (add `STAGE_WEIGHTS` constant near `LIFECYCLE_STAGES`; add the `overallMemo` after the `activeStage` memo ~line 150; pass the prop at lines 392-400)
- Test: `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`

**Interfaces:**
- Consumes: `stageManifest: StageConfig[]`, `stageHistory: StageInfo[]`, `stageProgress: Record<string, number>` — all already in the component's memo scope.
- Produces: `overallProgress: number` (0-100, rounded) as the **effective pre-event fallback**, passed to `InitializationProgress` as the optional prop `overallProgress?: number`.

**Weights (single tunable constant; duration heuristic):**
| stage | weight |
|---|---|
| repository_ingestion | 0.35 |
| knowledge_construction | 0.35 |
| initial_evaluation | 0.15 |
| health_report | 0.075 |
| recommendations | 0.075 |

- [ ] **Step 1: Write the failing test**

Add to `draftly-agent-frontend/tests/pages/initialize-page.test.tsx` (the file already mocks `InitializationProgress` and captures its props into `progressProps.current`). NOTE: this fixture intentionally contains NO `overall_progress` event, so the memo must act as the fallback source:

```tsx
it("computes a weighted overallProgress from manifest + per-stage progress", async () => {
  vi.mocked(api.getInitializeStatus).mockResolvedValue(
    initStatus({ state: "INITIALIZING", run_id: "overall-run-id" })
  );
  vi.mocked(eventsHook.useWorkflowEvents).mockReturnValue({
    status: "live",
    events: [
      {
        type: "stage_manifest",
        run_id: "overall-run-id",
        seq: 2,
        ts: "2026-08-30T04:16:37+00:00",
        payload: {
          stages: [
            { id: "repository_ingestion", label: "Processing documentation", order: 0 },
            { id: "knowledge_construction", label: "Building knowledge base", order: 1 },
            { id: "initial_evaluation", label: "Running evaluation", order: 2 },
            { id: "health_report", label: "Calculating health", order: 3 },
            { id: "recommendations", label: "Preparing recommendations", order: 4 },
          ],
        },
      },
      {
        type: "stage_change",
        run_id: "overall-run-id",
        seq: 3,
        ts: "2026-08-30T04:16:41+00:00",
        payload: { stage: "repository_ingestion", status: "started" },
      },
      {
        type: "stage_progress",
        run_id: "overall-run-id",
        seq: 4,
        ts: "2026-08-30T04:16:42+00:00",
        payload: { stage: "repository_ingestion", progress: 60 },
      },
      {
        type: "stage_change",
        run_id: "overall-run-id",
        seq: 5,
        ts: "2026-08-30T04:16:45+00:00",
        payload: { stage: "repository_ingestion", status: "completed" },
      },
      {
        type: "stage_change",
        run_id: "overall-run-id",
        seq: 6,
        ts: "2026-08-30T04:16:46+00:00",
        payload: { stage: "knowledge_construction", status: "started" },
      },
      {
        type: "stage_progress",
        run_id: "overall-run-id",
        seq: 7,
        ts: "2026-08-30T04:16:48+00:00",
        payload: { stage: "knowledge_construction", progress: 40 },
      },
    ],
    nodeStates: {},
    text: "",
    reason: "",
  });

  render(<InitializePage />);

  // repo: completed -> contributes 100 * 0.35 = 35
  // knowledge_construction: 40 * 0.35 = 14
  // remaining stages untracked -> 0. Overall = round(35 + 14) = 49
  await waitFor(() => {
    expect(progressProps.current.overallProgress).toBe(49);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pages/initialize-page.test.tsx -t "overallProgress"` from `draftly-agent-frontend/`

Expected: FAIL — `progressProps.current.overallProgress` is `undefined` (the page does not pass this prop yet).

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`, directly after the `LIFECYCLE_STAGES` constant (line 47), add the weight map:

```tsx
// Duration-heuristic weights driving the overall progress bar (fallback until
// the backend's authoritative overall_progress events arrive). Sums to 1.0.
// Adjust these to reflect the relative wall-clock cost of each manifest stage.
const STAGE_WEIGHTS: Record<string, number> = {
  repository_ingestion: 0.35,
  knowledge_construction: 0.35,
  initial_evaluation: 0.15,
  health_report: 0.075,
  recommendations: 0.075,
};
```

Directly after the `activeStage` memo (ends ~line 150), add the aggregate memo:

```tsx
  // Overall progress (0-100): weighted sum over the manifest stages. This is
  // the fallback used only until the backend's authoritative overall_progress
  // event arrives. The lifecycle sentinel is excluded automatically (absent
  // from the manifest and from stageHistory). A stage contributes 100 once its
  // stage_change "completed" arrives, otherwise its latest stage_progress
  // value, otherwise 0.
  const overallMemo = useMemo(() => {
    if (stageManifest.length === 0) return 0;
    const completed = new Set(
      stageHistory
        .filter((info) => info.status === "completed")
        .map((info) => info.stage),
    );
    let total = 0;
    for (const stage of stageManifest) {
      const weight = STAGE_WEIGHTS[stage.id] ?? 0;
      const pct = completed.has(stage.id)
        ? 100
        : (stageProgress[stage.id] ?? 0);
      total += weight * pct;
    }
    return Math.round(total);
  }, [stageManifest, stageHistory, stageProgress]);
```

Pass the prop to `InitializationProgress` (lines 392-400) — `overallProgress` is bound to the effective source in Task 5; for now pass `overallProgress={overallMemo}`:

```tsx
            <InitializationProgress
              stageHistory={stageHistory}
              activeStage={activeStage}
              syncProgress={syncProgress}
              finalStats={finalStats}
              stageManifest={stageManifest}
              stageProgress={stageProgress}
              perStageProgress={perStageProgress}
              overallProgress={overallMemo}
            />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pages/initialize-page.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — new test green; all 14+ existing page tests still pass.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-frontend/app/'(onboarding)'/onboarding/initialize/page.tsx
git add draftly-agent-frontend/tests/pages/initialize-page.test.tsx
git commit -m "feat(onboarding): derive weighted overallProgress fallback on the initialize page"
```

---

### Task 3: Frontend component — render the overall progress bar

**Files:**
- Modify: `draftly-agent-frontend/components/onboarding/initialization-progress.tsx`
- Test: `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`

**Interfaces:**
- Consumes: optional props `overallProgress?: number` (and `overallTimeline?: { at: number; value: number }[]` added in Task 6).
- Produces: a `role="progressbar"` block at the top of the left task column, shown only when `overallProgress !== undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`:

```tsx
it("renders the overall progress bar with the reported percentage", () => {
  render(
    <InitializationProgress
      stageHistory={[stageStarted("repository_ingestion")]}
      activeStage={stageStarted("repository_ingestion")}
      syncProgress={null}
      finalStats={null}
      stageManifest={MANIFEST}
      stageProgress={{}}
      perStageProgress={{}}
      overallProgress={62}
    />,
  );

  expect(screen.getByText("Overall progress")).toBeInTheDocument();
  expect(screen.getByText("62%")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");
});

it("does not render the overall bar when overallProgress is not provided", () => {
  render(
    <InitializationProgress
      stageHistory={[]}
      activeStage={null}
      syncProgress={null}
      finalStats={null}
      stageManifest={MANIFEST}
      stageProgress={{}}
      perStageProgress={{}}
    />,
  );

  expect(screen.queryByText("Overall progress")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/components/initialization-progress.test.tsx` from `draftly-agent-frontend/`

Expected: FAIL — `InitializationProgress` does not accept `overallProgress` yet (TS excess-prop error), or `screen.getByText("Overall progress")` finds nothing.

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-frontend/components/onboarding/initialization-progress.tsx`:

Add `overallProgress?: number` to the component's props destructuring and type (the props type block near lines 402-410). Inside the left task column, above the `{effectiveTasks.map(...)}` block (the `return (` begins near line 454; insert right after the opening of the left-column `<div className="rounded-xl ...">` at line 457):

```tsx
        {overallProgress !== undefined && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={overallProgress}
            className="mb-2 border-b border-[#eef2f9] pb-3 pt-1">
            <div className="mb-1.5 flex items-center justify-between text-[11px]">
              <span className="font-semibold text-[#101a43]">
                Overall progress
              </span>
              <b className="tabular-nums text-[#52407a]">{overallProgress}%</b>
            </div>
            <i className="relative block h-1.5 flex-1 overflow-hidden rounded-[4px] bg-[#e6ddff] not-italic">
              <span
                className="absolute inset-y-0 left-0 rounded-[4px] bg-[#8a67ee] transition-[width] duration-300"
                style={{ width: `${overallProgress}%` }}
              />
            </i>
          </div>
        )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/components/initialization-progress.test.tsx tests/pages/initialize-page.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — both new tests green; all existing component and page tests unaffected (optional prop).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-frontend/components/onboarding/initialization-progress.tsx
git add draftly-agent-frontend/tests/components/initialization-progress.test.tsx
git commit -m "feat(onboarding): render overall initialization progress bar"
```

---

### Task 4: Backend (in-scope O2) — authoritative `overall_progress` event

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py` (module `STAGE_WEIGHTS` next to `STAGES` ~line 35; tracked-stages dict + `_emit_overall` closure + wiring into `_emit_stage_progress` / `_stage_complete`)
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`

**Interfaces:**
- Consumes: `STAGES` list, the existing nested `_emit_stage_progress`, `_stage_start`, and `_stage_complete` closures (all in `run_onboarding_initialize`'s scope), and the publisher (via the envelope helper already used for `stage_progress`).
- Produces: a new SSE event `overall_progress` with `payload = {"progress": int}` — the single source of truth for the aggregate. Emitted once per `stage_progress` and once per `stage_change "completed"`.

**Design:**
- Module constant after `STAGE_LABELS` (~line 34):
```python
# Duration-heuristic weights for the overall_progress aggregate. Sums to 1.0.
# This is the single source of truth; the frontend memo is only a fallback.
STAGE_WEIGHTS: dict[str, float] = {
    "repository_ingestion": 0.35,
    "knowledge_construction": 0.35,
    "initial_evaluation": 0.15,
    "health_report": 0.075,
    "recommendations": 0.075,
}
```
- Inside `run_onboarding_initialize`, add a nested tracked-stages dict + aggregate emitters:
```python
    _overall_parts: dict[str, int] = {}

    async def _emit_overall() -> None:
        # round() then clamp so a drifting float can never escape [0, 100]
        total = sum(
            STAGE_WEIGHTS.get(stage, 0) * _overall_parts.get(stage, 0)
            for stage in STAGES
        )
        progress = min(max(round(total), 0), 100)
        await _publish("overall_progress", {"progress": progress})

    async def _after_emitted_progress(stage: str, progress: int) -> None:
        _overall_parts[stage] = progress
        await _emit_overall()
```
- Wire: at the end of the existing `_emit_stage_progress(stage, progress)`, set `_overall_parts[stage] = progress` and `await _emit_overall()` (after the sleep). At the end of `_stage_complete(stage, stats)`, set `_overall_parts[stage] = 100` and `await _emit_overall()`. (`_stage_start` needs nothing — start percentages are emitted via explicit `_emit_stage_progress` calls, e.g. KC 10, IE 20, health 30, recs 15.)
- Note: emitting overall alongside each stage_progress doubles event count for LLM stages — acceptable because Task 7 caps stage_progress emissions per stage at the tick budget.

- [ ] **Step 1: Write the failing tests**

Add to `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`:

```python
def _overall_progress_events(mock_publisher) -> list:
    """Mirror _stage_progress_events: publish() is always called positionally."""
    return [
        c.args[0]
        for c in mock_publisher.publish.call_args_list
        if hasattr(c, "args")
        and hasattr(c.args[0], "type")
        and c.args[0].type == "overall_progress"
    ]


@pytest.mark.asyncio
async def test_emits_overall_progress_events(mock_publisher, fake_repositories):
    """The backend is the single source of truth for the overall aggregate."""
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

        with patch("draftly.documentation.sync_service.SyncService") as service_cls:
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

    overall = _overall_progress_events(mock_publisher)
    assert len(overall) >= 1
    assert overall[-1].payload["progress"] == 100, (
        "Overall must reach 100 when the last stage completes"
    )
    # overall must be monotonic non-decreasing across the run in this happy path
    values = [e.payload["progress"] for e in overall]
    assert values == sorted(values), f"overall_progress must be monotonic, got {values}"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/workflows/test_onboarding_initialize.py::test_emits_overall_progress_events -q` from `draftly-agent-backend/`

Expected: FAIL — no `overall_progress` events exist yet; the new test's `_overall_progress_events(...)` returns an empty list.

- [ ] **Step 3: Write minimal implementation**

Implement the constants, the `_overall_parts` / `_emit_overall()` / wiring described in **Design**. Mirror the exact envelope construction used by the existing `_emit_stage_progress` (same topic, run_id, seq-assignment path, ts, payload dict) — reuse that helper's publish call for consistency. Clamp with `min(max(round(total), 0), 100)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/unit/workflows/test_onboarding_initialize.py -q` from `draftly-agent-backend/`

Expected: PASS — new test green (overall reaches 100 at the end; monotonic in the happy path); all existing tests still pass.

- [ ] **Step 5: Run the full backend workflow suite**

Run: `uv run pytest tests/unit/workflows tests/events -q` from `draftly-agent-backend/`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py
git add draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py
git commit -m "feat(workflow): emit authoritative overall_progress events"
```

---

### Task 5: Frontend page — make `overall_progress` events authoritative (memo = fallback)

**Files:**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`
- Test: `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`

**Interfaces:**
- Consumes: `useWorkflowEvents` events array (has `type: "overall_progress"` items after Task 4 ships); the `overallMemo` from Task 2.
- Produces: `streamOverall: number | null` state; `overallProgress = streamOverall ?? overallMemo` passed into `InitializationProgress`.

- [ ] **Step 1: Write the failing test**

Add to `draftly-agent-frontend/tests/pages/initialize-page.test.tsx` — reuses the Task 2 fixture but adds an `overall_progress` event whose value differs from what the memo would compute (49), proving the event wins:

```tsx
it("prefers the backend overall_progress event over the memo fallback", async () => {
  vi.mocked(api.getInitializeStatus).mockResolvedValue(
    initStatus({ state: "INITIALIZING", run_id: "overall-auth-run-id" })
  );
  vi.mocked(eventsHook.useWorkflowEvents).mockReturnValue({
    status: "live",
    events: [
      {
        type: "stage_manifest",
        run_id: "overall-auth-run-id",
        seq: 2,
        ts: "2026-08-30T04:16:37+00:00",
        payload: {
          stages: [
            { id: "repository_ingestion", label: "Processing documentation", order: 0 },
            { id: "knowledge_construction", label: "Building knowledge base", order: 1 },
            { id: "initial_evaluation", label: "Running evaluation", order: 2 },
            { id: "health_report", label: "Calculating health", order: 3 },
            { id: "recommendations", label: "Preparing recommendations", order: 4 },
          ],
        },
      },
      {
        type: "stage_change",
        run_id: "overall-auth-run-id",
        seq: 3,
        ts: "2026-08-30T04:16:41+00:00",
        payload: { stage: "repository_ingestion", status: "started" },
      },
      {
        type: "stage_progress",
        run_id: "overall-auth-run-id",
        seq: 4,
        ts: "2026-08-30T04:16:42+00:00",
        payload: { stage: "repository_ingestion", progress: 60 },
      },
      {
        type: "overall_progress",
        run_id: "overall-auth-run-id",
        seq: 5,
        ts: "2026-08-30T04:16:42+00:00",
        payload: { progress: 55 },
      },
      {
        type: "stage_change",
        run_id: "overall-auth-run-id",
        seq: 6,
        ts: "2026-08-30T04:16:45+00:00",
        payload: { stage: "repository_ingestion", status: "completed" },
      },
    ],
    nodeStates: {},
    text: "",
    reason: "",
  });

  render(<InitializePage />);

  // The memo would compute 35 (repo only at 100*0.35), but the authoritative
  // event says 55 — the event must win.
  await waitFor(() => {
    expect(progressProps.current.overallProgress).toBe(55);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pages/initialize-page.test.tsx -t "overall_progress event"` from `draftly-agent-frontend/`

Expected: FAIL — without event handling, the page still passes the memo value (35), not 55.

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`:
- Add state near the existing `stageProgress` state (~line 65): `const [streamOverall, setStreamOverall] = useState<number | null>(null);`
- In the `[events]` effect (lines 177-196), add before the closing `})()`:
```tsx
        if (event.type === "overall_progress") {
          const progress = event.payload.progress as number;
          if (typeof progress === "number") {
            setStreamOverall(progress);
          }
        }
```
- After `overallMemo`, add the effective source:
```tsx
  // Authoritative aggregate from the backend; the memo fallback only covers
  // the window before the first overall_progress event arrives.
  const overallProgress = streamOverall ?? overallMemo;
```
- Change the prop passed to `InitializationProgress` from `overallProgress={overallMemo}` to `overallProgress={overallProgress}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pages/initialize-page.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — the event test now gets 55; the Task 2 fallback test (no event) still gets 49; all existing page tests pass.

- [ ] **Step 5: Typecheck the page**

Run: `npx tsc --noEmit` from `draftly-agent-frontend/`

Expected: same pre-existing baseline errors only; no new errors from `overall_progress`.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-frontend/app/'(onboarding)'/onboarding/initialize/page.tsx
git add draftly-agent-frontend/tests/pages/initialize-page.test.tsx
git commit -m "feat(onboarding): honor authoritative overall_progress events, keep memo fallback"
```

---

### Task 6: Frontend (in-scope O1) — ETA hint from the overall slope

**Files:**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx` (timeline sampling + prop pass)
- Modify: `draftly-agent-frontend/components/onboarding/initialization-progress.tsx` (ETA helper + hint UI)
- Test: `draftly-agent-frontend/tests/components/initialization-progress.test.tsx` (+ a module-level unit test of the helper)

**Interfaces:**
- Consumes: the effective `overallProgress`; samples recorded as `{ at: number; value: number }[]`.
- Produces: a pure exported helper `estimateRemainingSeconds(first, last, now): number | null` and a "~Xs left" / "~Xm Ys left" hint below the overall bar. Hidden until there is a real progressing slope and hidden at 100.

**Design (frontend-only, uses event timestamps via `Date.now()` when the effective value changes):**
- Page: keep a capped ref of recent samples and pass it down:
```tsx
  const overallTimelineRef = useRef<{ at: number; value: number }[]>([]);
  useEffect(() => {
    const now = Date.now();
    const arr = overallTimelineRef.current;
    const last = arr[arr.length - 1];
    if (!last || last.value !== overallProgress) {
      arr.push({ at: now, value: overallProgress });
      if (arr.length > 40) arr.shift();
      overallTimelineRef.current = arr;
    }
  }, [overallProgress]);
```
Then pass `overallTimeline={overallTimelineRef.current}` to `InitializationProgress`.
- Component helper (module scope, next to the component so it is unit-testable):
```tsx
export function estimateRemainingSeconds(
  first: { at: number; value: number },
  last: { at: number; value: number },
  now: number,
): number | null {
  const dt = last.at - first.at;
  const dv = last.value - first.value;
  if (dt <= 0 || dv <= 0) return null;         // no slope yet / moved backwards
  const remaining = ((100 - last.value) / (dv / dt)); // ms
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return Math.round(remaining / 1000);
}
```
- Component: when `overallTimeline` has ≥ 2 samples and `estimateRemainingSeconds(timeline[0], timeline[timeline.length - 1], Date.now())` returns a finite positive `n`, render below the bar (inside the left column, after the `role="progressbar"` block):
```tsx
        {remaining !== null && overallProgress < 100 && (
          <p className="mt-1 text-[11px] text-[#6b7294]">
            ≈ {formatDuration(remaining)} left
          </p>
        )}
```
  `formatDuration(n)` → `"3m 20s"` for ≥ 60 s, `"Xs"` otherwise (inline, tiny helper).

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`:

```tsx
describe("estimateRemainingSeconds", () => {
  it("extrapolates remaining time from the progress slope", () => {
    // 20% over 30s (10 -> 30), so 70% remains:
    // (100 - 30) / (20 / 30000) = 105_000 ms = 105s
    expect(
      estimateRemainingSeconds(
        { at: 1_000, value: 10 },
        { at: 31_000, value: 30 },
        31_000,
      ),
    ).toBe(105);
  });

  it("returns null when there is no forward slope", () => {
    expect(
      estimateRemainingSeconds(
        { at: 1_000, value: 40 },
        { at: 5_000, value: 40 },
        5_000,
      ),
    ).toBeNull();
  });
});

it("shows an ETA hint under the overall bar while progressing", () => {
  render(
    <InitializationProgress
      stageHistory={[stageStarted("repository_ingestion")]}
      activeStage={stageStarted("repository_ingestion")}
      syncProgress={null}
      finalStats={null}
      stageManifest={MANIFEST}
      stageProgress={{}}
      perStageProgress={{}}
      overallProgress={30}
      overallTimeline={[
        { at: 0, value: 5 },
        { at: 30_000, value: 30 },
      ]}
    />,
  );

  expect(screen.getByText(/left/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/components/initialization-progress.test.tsx` from `draftly-agent-frontend/`

Expected: FAIL — `estimateRemainingSeconds` is undefined (not exported) and no ETA text renders.

- [ ] **Step 3: Write minimal implementation**

Implement the **Design** above: page timeline sampling + prop, exported helper, `formatDuration`, ETA paragraph. Clamp/hide per the interfaces (no slope → hidden; 100 → hidden).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/components/initialization-progress.test.tsx tests/pages/initialize-page.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — helper unit test, ETA render test, and all existing tests green.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-frontend/app/'(onboarding)'/onboarding/initialize/page.tsx
git add draftly-agent-frontend/components/onboarding/initialization-progress.tsx
git add draftly-agent-frontend/tests/components/initialization-progress.test.tsx
git commit -m "feat(onboarding): show ETA hint derived from overall progress slope"
```

---

### Task 7: Backend (in-scope O3) — corpus-scaled emit cadence for LLM stages

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py` (the progress-callback cadence in `run_knowledge_construction` ~lines 505-525 and `run_initial_evaluation` ~lines 660-676)
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: the number of work units known up front in each runner (KC: the list of documents/chunks to embed; IE: the list of sampled documents), and the existing `on_progress` callback contract.
- Produces: a pure helper `tick_interval(total_units: int, budget: int = EMIT_TICK_BUDGET) -> int` and a bounded number of `on_progress` calls per stage (≤ `budget + 1`).

**Design:**
```python
# Cap on stage_progress events emitted per LLM-heavy stage regardless of corpus
# size. Protects SSE volume and keeps the Redis stream (MAX_STREAM_LEN) safe.
EMIT_TICK_BUDGET = 50


def tick_interval(total_units: int, budget: int = EMIT_TICK_BUDGET) -> int:
    """Number of work units between progress emits, so a stage emits <= budget
    ticks total (plus the final one), independent of corpus size."""
    if total_units <= 0:
        return 1
    # Integer ceiling (-(-n // b)) so stages.py needs no `import math`
    return max(1, -(-total_units // budget))
```
- KC runner: compute `emit_every = tick_interval(len(units))` before the loop; call `on_progress(...)` only when `processed % emit_every == 0` (mirroring today's batch boundary, but with the computed interval; keep the existing final emit). For a corpus of 10 units with budget 50, `emit_every = ceil(10/50) = 1` — every unit emits, ≤ 51 events, matching current behavior for small corpora.
- IE runner: same pattern with the sampled-documents count (`emit_every = tick_interval(len(sample))`), replacing the fixed "every 10 docs" threshold (lines ~671-675).
- If a runner cannot know its total up front, keep its current first-tick behavior but make the emit interval the computed value (document the assumption in a code comment). The final `stage_progress` 100 emits happen elsewhere (Task 1 / existing code) and are NOT part of the budget.

- [ ] **Step 1: Write the failing tests**

Add to `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`:

```python
def test_tick_interval_scales_to_budget():
    assert tick_interval(0) == 1
    assert tick_interval(1) == 1
    assert tick_interval(10, budget=50) == 1        # tiny corpus: every unit
    assert tick_interval(100, budget=50) == 2       # 50 ticks
    assert tick_interval(100_000, budget=50) == 2_000
    assert tick_interval(10_000_000, budget=50) == 200_000
    # Emit counts stay within budget + 1 for any corpus
    for total in (10, 100, 1_000, 100_000, 10_000_000):
        interval = tick_interval(total, budget=50)
        ticks = -(-total // interval)
        assert ticks <= 51, f"total={total} yields {ticks} ticks"
```

Plus an integration-style test that drives `run_knowledge_construction` (or `run_initial_evaluation`) against a synthetic corpus sized so that today's constant cadence would exceed the budget, stubbing the LLM/extraction dependency the same way existing stage tests do, and asserting:
```python
    assert call_count <= EMIT_TICK_BUDGET + 2  # + final emit + start
```
Locate the existing single-stage test harness in `test_onboarding_stages.py` and mirror it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/workflows/test_onboarding_stages.py -q` from `draftly-agent-backend/`

Expected: FAIL — `tick_interval` doesn't exist yet (imports error), and the integration test exceeds the budget under today's constant cadence.

- [ ] **Step 3: Write minimal implementation**

Implement `EMIT_TICK_BUDGET`, `tick_interval`, and wire both runners per **Design**. Keep the `on_progress` callback payload/semantics identical. Make sure the final per-stage emits (KC 100 at `initialize.py:262`, IE 100 at 274, and the overall-progress wiring from Task 4) are unaffected.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/unit/workflows/test_onboarding_stages.py tests/unit/workflows/test_onboarding_initialize.py -q` from `draftly-agent-backend/`

Expected: PASS — helper + integration tests green; initialize suite still green.

- [ ] **Step 5: Run the full backend workflow suite**

Run: `uv run pytest tests/unit/workflows tests/events -q` from `draftly-agent-backend/`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/stages.py
git add draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat(workflow): scale LLM stage progress emits to a fixed tick budget"
```

---

### Task 8: Frontend — remove preset task rows; move the "files processed" subdetail to repository_ingestion

**Files:**
- Modify: `draftly-agent-frontend/components/onboarding/initialization-progress.tsx` (delete `PRESET_TASKS` at lines 36-41 and the `isPreset?: boolean` field on `InitTask` at line 33; simplify `buildInitTasks` at lines 43-57 and the `TaskRow` map at lines 458-490)
- Test: `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`

**Interfaces:**
- Consumes: `stageManifest`, `stageHistory`, `activeStage`, `syncProgress` (unchanged props).
- Produces: a task list containing ONLY the manifest stages — no `Workspace created` / `GitHub connected` / `Repository indexed` / `Documentation discovered` preset rows. The `"N files processed"` subdetail (`syncProgress.document_count`) renders under the live `repository_ingestion` row instead of the removed `docs_discovered` preset.

- [ ] **Step 1: Write the failing test**

Append to `draftly-agent-frontend/tests/components/initialization-progress.test.tsx` (reuses the existing `MANIFEST` and `stageStarted` helpers):

```tsx
it("lists only the manifest stages and puts the file-count subdetail on the ingestion row", () => {
  render(
    <InitializationProgress
      stageHistory={[stageStarted("repository_ingestion")]}
      activeStage={stageStarted("repository_ingestion")}
      syncProgress={{ document_count: 12, chunk_count: 50 }}
      finalStats={null}
      stageManifest={MANIFEST}
      stageProgress={{ repository_ingestion: 42 }}
      perStageProgress={{}}
    />,
  );

  expect(screen.queryByText("Workspace created")).toBeNull();
  expect(screen.queryByText("Documentation discovered")).toBeNull();
  expect(screen.getByText("Processing documentation")).toBeInTheDocument();
  expect(screen.getByText("12 files processed")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/initialization-progress.test.tsx -t "only the manifest stages"` from `draftly-agent-frontend/`

Expected: FAIL — the preset rows still render (`queryByText("Workspace created")` finds it), and the subdetail still hangs off `docs_discovered`.

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-frontend/components/onboarding/initialization-progress.tsx`:
- Delete `PRESET_TASKS` (36-41) and the `isPreset?: boolean` field from `InitTask` (33).
- `buildInitTasks` (43-57) becomes manifest-only:
```tsx
function buildInitTasks(manifest: StageConfig[]): InitTask[] {
  return [...manifest]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ key: s.id, label: s.label, backendStage: s.id }));
}
```
- In the `TaskRow` map: delete `const isPresetDone = task.isPreset;` (459), set `done` to just the backend check (463), drop the `isPresetDone ? "Just now"` timestamp branch (476-477), and change the subdetail gate from `showSubdetail={task.key === "docs_discovered"}` to `showSubdetail={task.backendStage === "repository_ingestion"}` (482). Keep the `subdetail={syncProgress ? ... : undefined}` body.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/initialization-progress.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — new test green; all existing component tests still pass (the "manifest not arrived yet" resume-race test relies on the fallback task, not presets).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-frontend/components/onboarding/initialization-progress.tsx
git add draftly-agent-frontend/tests/components/initialization-progress.test.tsx
git commit -m "refactor(onboarding): drop preset task rows, move file-count subdetail to the ingestion stage"
```

---

### Task 9: Frontend — skeleton loading state for the pre-event window

**Files:**
- Modify: `draftly-agent-frontend/components/onboarding/initialization-progress.tsx` (left column, `effectiveTasks` render at lines 456-491)
- Test: `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`

**Interfaces:**
- Consumes: `effectiveTasks` (empty when the `stage_manifest` event hasn't arrived AND no active stage exists yet — the fallback at lines 430-443 excludes the resume-race case, so the skeleton only shows during the true pre-event window).
- Produces: a `role="status"` shimmer block in place of the task map, built from the existing `.draftly-skeleton` utility (globals.css:1105-1123; measured — vars `--surface-subtle`/`--radius-md` exist in both light and dark themes).

- [ ] **Step 1: Write the failing test**

Append to `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`:

```tsx
it("renders a skeleton loading state before the manifest or any stage arrives", () => {
  render(
    <InitializationProgress
      stageHistory={[]}
      activeStage={null}
      syncProgress={null}
      finalStats={null}
      stageManifest={[]}
      stageProgress={{}}
      perStageProgress={{}}
    />,
  );

  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.queryByText("Processing documentation")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/initialization-progress.test.tsx -t "skeleton loading"` from `draftly-agent-frontend/`

Expected: FAIL — the left card is empty (no presets anymore, no manifest, no active stage), so `getByRole("status")` throws.

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-frontend/components/onboarding/initialization-progress.tsx`, wrap the map (456-491) so the empty window renders skeleton rows shaped like a `TaskRow` (`grid-cols-[30px_1fr_auto]`, `py-[11px]`):

```tsx
        {effectiveTasks.length === 0 ? (
          <div
            role="status"
            aria-label="Loading workspace state"
            className="space-y-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="grid grid-cols-[30px_1fr_auto] items-center gap-x-3 py-[11px]">
                <div className="draftly-skeleton mx-auto size-[18px]" />
                <div className="draftly-skeleton h-4 w-2/3 max-w-[220px]" />
              </div>
            ))}
          </div>
        ) : (
          effectiveTasks.map(/* existing TaskRow map, unchanged */)
        )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/initialization-progress.test.tsx tests/pages/initialize-page.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — skeleton test green; no task-labels leak into the loading state; page tests unaffected (component is mocked there).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-frontend/components/onboarding/initialization-progress.tsx
git add draftly-agent-frontend/tests/components/initialization-progress.test.tsx
git commit -m "feat(onboarding): skeleton loading state for the init task list during the pre-event window"
```

---

### Task 10: Frontend — animate the active TaskRow status indicator dot

**Files:**
- Modify: `draftly-agent-frontend/components/onboarding/initialization-progress.tsx` (status indicator span at lines 550-559)
- Test: `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`

**Interfaces:**
- Consumes: the `active` branch of the TaskRow status-dot `className`.
- Produces: the active dotted ring spins via Tailwind's built-in `animate-spin` (a built-in v4 utility — `globals.css` untouched). The `done` green check circle and `pending` hollow dot stay static.

- [ ] **Step 1: Write the failing test**

Append to `draftly-agent-frontend/tests/components/initialization-progress.test.tsx`:

```tsx
it("spins the active stage's status indicator dot", () => {
  const { container } = render(
    <InitializationProgress
      stageHistory={[stageStarted("repository_ingestion")]}
      activeStage={stageStarted("repository_ingestion")}
      syncProgress={null}
      finalStats={null}
      stageManifest={MANIFEST}
      stageProgress={{ repository_ingestion: 42 }}
      perStageProgress={{}}
    />,
  );

  expect(container.querySelector(".animate-spin")).not.toBeNull();
});

it("does not spin completed or pending status dots", () => {
  const { container } = render(
    <InitializationProgress
      stageHistory={[
        {
          stage: "repository_ingestion",
          status: "completed",
          ts: new Date().toISOString(),
        },
      ]}
      activeStage={null}
      syncProgress={null}
      finalStats={null}
      stageManifest={MANIFEST}
      stageProgress={{ repository_ingestion: 100 }}
      perStageProgress={{}}
    />,
  );

  expect(container.querySelector(".animate-spin")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/components/initialization-progress.test.tsx -t "indicator dot"` from `draftly-agent-frontend/`

Expected: FAIL — the active dot's `className` has no `animate-spin`, so the first test's `querySelector(".animate-spin")` is null.

- [ ] **Step 3: Write minimal implementation**

Add `animate-spin` to the `active` branch of the status indicator span (`initialization-progress.tsx:554-555`):

```tsx
          active &&
            "mx-auto size-[18px] animate-spin rounded-full border-2 border-dotted border-[#814ef0]",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/components/initialization-progress.test.tsx tests/pages/initialize-page.test.tsx` from `draftly-agent-frontend/`

Expected: PASS — both new tests green; the completed test's `toBeNull()` confirms no spin leak to done/pending rows.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-frontend/components/onboarding/initialization-progress.tsx
git add draftly-agent-frontend/tests/components/initialization-progress.test.tsx
git commit -m "feat(onboarding): spin the active task status indicator dot"
```

---

### Task 11: Full verification + graph update

**Files:**
- None (verification only).

- [ ] **Step 1: Run the full backend suite**

Run: `uv run pytest -q` from `draftly-agent-backend/`

Expected: PASS (no new failures).

- [ ] **Step 2: Run the full frontend suite**

Run: `npx vitest run` from `draftly-agent-frontend/`

Expected: PASS — 95+ tests across 22+ files (new `overallProgress`, `overall_progress` event, ETA, preset-removal, skeleton-loading, and status-dot-spin tests included).

- [ ] **Step 3: Typecheck + lint the changed frontend files**

Run from `draftly-agent-frontend/`:
```bash
npx eslint "components/onboarding/initialization-progress.tsx" "app/(onboarding)/onboarding/initialize/page.tsx"
npx tsc --noEmit
```

Expected: eslint clean for both files (the page may still show the pre-existing `react-hooks/exhaustive-deps` warning at the re-mint effect — accept it, it predates this work). `tsc --noEmit` reports the same pre-existing errors only (test mocks omitting `reason`/`resumed`) and NO new errors.

- [ ] **Step 4: Live sanity check (manual)**

Start backend + frontend, run onboarding against a small repo, and confirm in the UI:
- `repository_ingestion` bar fills 0 → 92 → 100 before flipping to the green check.
- The overall bar reflects the backend's authoritative number, reaches 100 only after `recommendations` completes (just before redirect to `/onboarding/complete`), and never stalls at a fixed % during gaps between stages.
- ETA hint appears once a forward slope exists, is labeled "≈", and disappears at 100.
- LLM stages tick in smooth, steady increments even on a large corpus (no burst of dozens of messages per second in the devtools network tab).

- [ ] **Step 5: Update the knowledge graph**

Run: `graphify update .` from the repo root

Expected: `graph.json` / `GRAPH_REPORT.md` rebuilt (dirty graph files are expected; not a failure).

- [ ] **Step 6: Commit any stragglers**

```bash
git status --short
git add -A
git commit -m "chore: post-implementation graph update"
```
(Only if Step 5 produced changes.)

---

## Previously-deferred capabilities — now in scope (summary)

| Capability | Task | Where |
|---|---|---|
| ETA / time estimate | 6 | Frontend (`estimateRemainingSeconds` + hint UI) |
| Backend-computed aggregate (single source of truth) | 4 + 5 | New `overall_progress` SSE event (backend), consumed by the page with the memo as fallback |
| Finer LLM batch emit rates, bounded by corpus size | 7 | `tick_interval` + `EMIT_TICK_BUDGET = 50` in `stages.py` |

Rationale for each inclusion: O1 converts "is it stuck?" into "≈1m 20s left"; O2 makes the aggregate factual and replay-safe across all clients (weights live once, next to `STAGES`); O3 makes bars smooth while protecting `MAX_STREAM_LEN = 1000` — and it also bounds the overall_progress event rate added in Task 4.