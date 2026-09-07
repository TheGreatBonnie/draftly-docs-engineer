# Implementation Plan: Replace SSE with Polling for Initialization Page

## Goal
Replace SSE-based event streaming with polling as the primary mechanism for the onboarding initialization page, with dynamic live stage mapping and animated progress matching the design file.

## Problem
- `useWorkflowEvents` SSE hook has a 60s idle timeout causing disconnections
- Stub stages (2-5) complete nearly instantly via `asyncio.sleep(0)`, so SSE stream closes before UI renders
- Dynamic stage mapping and animated progress are unreliable under SSE

## Approach
Poll `GET /onboarding/initialize/status` every 3 seconds. The backend already persists `init_stage` to the onboarding record. Frontend derives completed/active/pending status from the current stage string since stages always run in order.

---

## Step 1: Backend — Enhance Initialize Status Response

**File:** `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` (line 446-450)

Add `selected_repository` to the `GET /onboarding/initialize/status` response:

```python
return {
    "state": current.get("state"),
    "stage": _selected(current).get("init_stage"),
    "failure": failure,
    "selected_repository": _selected(current),  # NEW
}
```

**Verify:** `ruff check .` and `mypy src/`

---

## Step 2: Frontend — Update InitializeStatus Type

**File:** `draftly-agent-frontend/lib/onboarding/types.ts` (line 59-65)

Add `selected_repository` field:

```typescript
export interface InitializeStatus {
  state: OnboardingState;
  stage: string | null;
  failure: { step: string; detail: string } | null;
  run_id?: string;
  ticket?: string;
  selected_repository?: Record<string, unknown> | null;  // NEW
}
```

**Verify:** `npx tsc --noEmit`

---

## Step 3: Frontend — Rewrite page.tsx (SSE → Polling)

**File:** `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`

### Remove
- `useWorkflowEvents` import and `StreamEvent` type
- `runId` / `ticket` state
- `useWorkflowEvents(runId, ...)` call
- `stageHistory` useMemo (derived from events)
- `syncProgress` useMemo (derived from events)
- `activeStage` useMemo (derived from stageHistory)
- SSE `workflow_result` event handling useEffect
- SSE fallback useEffect (`getOnboardingStatus` on error)
- `startInitialize` call for run_id/ticket (keep for triggering init)

### Add
- Polling via `setInterval` every 3s calling `getInitializeStatus()`
- Derive `stageHistory` from polled `stage` string + `STAGES` order
- Derive `activeStage` from current polled stage
- Derive `syncProgress` from `selected_repository` in response
- Handle `COMPLETED` → redirect, `FAILED` → show error
- Consecutive failure counter → show disconnected error after 5 failures

### Polling Logic
```typescript
const STAGES = [
  "repository_ingestion",
  "knowledge_construction",
  "initial_evaluation",
  "health_report",
  "recommendations",
];

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_FAILURES = 5;

// Derive stage history from current stage string:
// - All stages before current in STAGES order → completed
// - Current stage → started (active)
// - All stages after → pending
```

### Flow
1. Page mounts → call `startInitialize()` to trigger workflow
2. Start polling `getInitializeStatus()` every 3s
3. Each poll: derive `stageHistory`, `activeStage`, `syncProgress` from response
4. If `state === "COMPLETED"` → set finalStats, redirect to `/onboarding/complete`
5. If `state === "FAILED"` → show error with failure detail
6. If poll fails 5 consecutive times → show disconnected error
7. On unmount → clear interval

**Verify:** `npx tsc --noEmit`

---

## Step 4: Frontend — Update InitializationProgress Component

**File:** `draftly-agent-frontend/components/onboarding/initialization-progress.tsx`

### Change Props
```typescript
// BEFORE
export function InitializationProgress({
  stageHistory,
  activeStage,
  syncProgress,
  finalStats,
}: {
  stageHistory: StageInfo[];
  activeStage: StageInfo | null;
  syncProgress: SyncProgress | null;
  finalStats: { document_count?: number; chunk_count?: number } | null;
})

// AFTER
export function InitializationProgress({
  currentStage,
  syncProgress,
  finalStats,
}: {
  currentStage: string | null;
  syncProgress: SyncProgress | null;
  finalStats: { document_count?: number; chunk_count?: number } | null;
})
```

### Internal Derivation
```typescript
const STAGES = [
  "repository_ingestion",
  "knowledge_construction",
  "initial_evaluation",
  "health_report",
  "recommendations",
];

// Derive completed/active/pending from currentStage
const completedStages = useMemo(() => {
  if (!currentStage) return new Set<string>();
  const idx = STAGES.indexOf(currentStage);
  return new Set(STAGES.slice(0, idx));
}, [currentStage]);

const activeTaskIndex = useMemo(() => {
  if (!currentStage) return -1;
  return INIT_TASKS.findIndex((t) => t.backendStage === currentStage);
}, [currentStage]);
```

### Keep
- `INIT_TASKS` mapping (unchanged)
- `useStageProgress` hook (unchanged)
- `KnowledgeGraphViz` component (unchanged)
- `StatsPanel` component (unchanged)
- `TaskRow` component (unchanged)

**Verify:** `npx tsc --noEmit`

---

## Step 5: Frontend — Update Tests

**File:** `draftly-agent-frontend/tests/pages/initialize-page.test.tsx`

### Remove
- `useWorkflowEvents` mock
- SSE-related tests (workflow_result, stage_change events, SSE error, SSE polling test)

### Add
- Polling test: calls `getInitializeStatus` on interval
- Stage update test: shows stage updates from polled responses
- Completion test: navigates to `/onboarding/complete` on `COMPLETED` state
- Failure test: shows error on `FAILED` state
- Disconnection test: shows disconnected error after N poll failures
- Cleanup test: clears interval on unmount

**Verify:** `npm test`

---

## Verification Checklist
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `ruff check .` — no lint errors (backend)
- [ ] `mypy src/` — no type errors (backend)
- [ ] `npm test` — all tests pass
- [ ] Manual: polling works, stages update dynamically, progress animates, completion redirects
