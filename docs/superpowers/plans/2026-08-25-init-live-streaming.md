# Onboarding Init Live Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace polling-based init progress with real-time SSE streaming so the frontend shows live stage transitions during onboarding initialization.

**Architecture:** The onboarding init workflow (`run_onboarding_initialize`) publishes `StreamEnvelope` events at each stage boundary via `context.publisher` (the existing `_TeePublisher` → Redis + DB fallback). The POST `/onboarding/initialize` endpoint generates a `run_id` and one-use ticket, returning them immediately so the frontend can connect to the existing SSE endpoint (`GET /workflows/{run_id}/events`). The frontend swaps `setInterval` polling for the existing `useWorkflowEvents` hook.

**Tech Stack:** Python/FastAPI (backend), Next.js/React (frontend), Redis pub/sub, Server-Sent Events

**Spec:** N/A — design derived from spike investigation of existing infrastructure

## Global Constraints

- No git commits unless explicitly requested
- Backend suite must stay green (currently 625P/4S)
- Frontend vitest must stay green (currently 54/54)
- ruff clean on all touched Python files
- tsc clean on all touched TypeScript files
- `graphify update .` after code changes
- All changes uncommitted

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/draftly/workflows/onboarding/initialize.py` | Modify | Accept `run_id`, publish `StreamEnvelope` at each stage boundary and on completion/failure |
| `src/draftly/app/api/routes/onboarding.py` | Modify | Generate `run_id` + ticket in POST `/initialize`, return `{state, run_id, ticket}` immediately |
| `draftly-agent-frontend/hooks/use-workflow-events.ts` | Modify | Accept optional external ticket parameter (skip internal ticket fetch when provided) |
| `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx` | Modify | Swap `setInterval` polling for `useWorkflowEvents` SSE hook |
| `tests/unit/workflows/test_onboarding_initialize.py` | Modify | Add tests for event publishing (RED → GREEN) |
| `tests/api/test_onboarding_routes.py` | Modify | Add test for `run_id` + ticket in POST response (RED → GREEN) |

---

### Task 1: Publish StreamEnvelope events from init workflow

**Files:**
- Modify: `src/draftly/workflows/onboarding/initialize.py:27-107`
- Test: `tests/unit/workflows/test_onboarding_initialize.py`

**Interfaces:**
- Consumes: `context.publisher` (set by composition when `events_streaming_enabled=True`; `_TeePublisher` or `None`)
- Produces: `StreamEnvelope` instances published to `context.publisher` with types `stage_change` and `workflow_result`

- [ ] **Step 1: Write failing tests for event publishing**

Add to `tests/unit/workflows/test_onboarding_initialize.py`:

```python
import pytest
from unittest.mock import AsyncMock, MagicMock
from draftly.workflows.context import WorkflowContext
from draftly.workflows.onboarding.initialize import run_onboarding_initialize


@pytest.fixture
def mock_publisher():
    pub = AsyncMock()
    pub.publish = AsyncMock()
    return pub


@pytest.fixture
def fake_repositories():
    """Build a minimal repo bundle that satisfies run_onboarding_initialize."""
    repos = MagicMock()
    # github_installations.first_for_org returns an installation
    repos.github_installations = AsyncMock()
    repos.github_installations.first_for_org = AsyncMock(
        return_value={"installation_id": 12345}
    )
    # onboarding.get returns current state
    repos.onboarding = AsyncMock()
    repos.onboarding.get = AsyncMock(return_value=None)
    repos.onboarding.upsert = AsyncMock()
    repos.onboarding.mark_step = AsyncMock()
    return repos


@pytest.mark.asyncio
async def test_publishes_stage_change_events(mock_publisher, fake_repositories):
    """Each stage boundary should publish a stage_change envelope."""
    context = WorkflowContext(
        repositories=fake_repositories,
        publisher=mock_publisher,
    )
    # Mock the sync service to return valid results
    with pytest.MonkeyPatch.context() as m:
        fake_sync_result = MagicMock()
        fake_sync_result.document_count = 5
        fake_sync_result.chunk_count = 20
        fake_sync_result.failed_files = []
        fake_sync_result.baseline = None

        fake_sync = AsyncMock()
        fake_sync.sync = AsyncMock(return_value=fake_sync_result)
        m.setattr(
            "draftly.workflows.onboarding.initialize.SyncService",
            lambda **kw: fake_sync,
        )
        m.setattr(
            "draftly.workflows.onboarding.initialize.build_installation_client",
            AsyncMock(return_value=MagicMock()),
        )

        state = await run_onboarding_initialize(
            context,
            org_id="org_test123",
            selected_repository={
                "full_name": "test/repo",
                "doc_include": ["*.md"],
                "doc_exclude": [],
            },
        )

    # Should have published stage_change events + workflow_result
    calls = mock_publisher.publish.call_args_list
    stage_events = [
        c for c in calls
        if hasattr(c, "args") and hasattr(c.args[0], "type") and c.args[0].type == "stage_change"
    ]
    result_events = [
        c for c in calls
        if hasattr(c, "args") and hasattr(c.args[0], "type") and c.args[0].type == "workflow_result"
    ]
    assert len(stage_events) >= 5, f"Expected >=5 stage_change events, got {len(stage_events)}"
    assert len(result_events) == 1, f"Expected 1 workflow_result event, got {len(result_events)}"


@pytest.mark.asyncio
async def test_publishes_workflow_result_on_failure(mock_publisher, fake_repositories):
    """On exception, a workflow_result event with status=FAILED should be published."""
    context = WorkflowContext(
        repositories=fake_repositories,
        publisher=mock_publisher,
    )
    with pytest.MonkeyPatch.context() as m:
        # Make build_installation_client raise to trigger failure path
        m.setattr(
            "draftly.workflows.onboarding.initialize.build_installation_client",
            AsyncMock(side_effect=RuntimeError("auth failed")),
        )

        state = await run_onboarding_initialize(
            context,
            org_id="org_test123",
            selected_repository={"full_name": "test/repo"},
        )

    calls = mock_publisher.publish.call_args_list
    result_events = [
        c for c in calls
        if hasattr(c, "args") and hasattr(c.args[0], "type") and c.args[0].type == "workflow_result"
    ]
    assert len(result_events) == 1
    envelope = result_events[0].args[0]
    assert envelope.payload.get("status") == "FAILED"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: FAIL — `run_onboarding_initialize` doesn't accept `run_id` or publish events yet

- [ ] **Step 3: Implement event publishing in initialize.py**

Modify `src/draftly/workflows/onboarding/initialize.py`:

```python
async def run_onboarding_initialize(
    context: WorkflowContext,
    *,
    org_id: str,
    selected_repository: dict[str, Any] | None = None,
    run_id: str | None = None,
    **kwargs: Any,
) -> WorkflowState:
    del kwargs
    state = WorkflowState(run_id=run_id or f"onboarding-init-{org_id}")
    seq = 0

    async def _publish(envelope_type: str, payload: dict[str, Any]) -> None:
        nonlocal seq
        if context.publisher is None:
            return
        from draftly.events.stream_envelope import StreamEnvelope
        seq += 1
        await context.publisher.publish(StreamEnvelope(
            type=envelope_type,
            run_id=state.run_id,
            surface="onboarding",
            seq=seq,
            payload=payload,
        ))

    # ... (rest of function with _publish calls added after each _update_stage)
```

Add `_publish("stage_change", {"stage": stage})` after each `_update_stage()` call.
Add `_publish("workflow_result", {"status": "COMPLETED", ...})` before the return on success.
Add `_publish("workflow_result", {"status": "FAILED", "error": ...})` in the except block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: PASS

- [ ] **Step 5: Run full backend suite**

Run: `uv run pytest -q`
Expected: 625+ passed, 4 skipped

- [ ] **Step 6: Run ruff on touched files**

Run: `uv run ruff check src/draftly/workflows/onboarding/initialize.py`
Expected: All checks passed

---

### Task 2: Return run_id + ticket from POST /initialize

**Files:**
- Modify: `src/draftly/app/api/routes/onboarding.py:356-414`
- Test: `tests/api/test_onboarding_routes.py`

**Interfaces:**
- Consumes: `TicketStore` from `routes/workflows.py` (shared in-process store via `request.app.state.tickets`)
- Produces: POST `/onboarding/initialize` returns `{state: "INITIALIZING", run_id: "...", ticket: "..."}`

- [ ] **Step 1: Write failing test**

Add to `tests/api/test_onboarding_routes.py`:

```python
@pytest.mark.asyncio
async def test_initialize_returns_run_id_and_ticket(client, mock_deps):
    """POST /onboarding/initialize should return run_id and ticket for SSE."""
    mock_deps.repositories.onboarding.get = AsyncMock(
        return_value={"state": "PREFERENCES_CONFIGURED", "selected_repository": {"full_name": "t/r"}}
    )
    mock_deps.worker.task_runner.has_task = MagicMock(return_value=True)
    mock_deps.worker.run_task = AsyncMock(return_value=MagicMock(
        status=WorkflowStatus.DELIVERED,
        to_dict=lambda: {"document_count": 5},
        errors=[],
    ))

    resp = await client.post(
        "/api/onboarding/initialize",
        headers={"Authorization": "Bearer test_token"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "run_id" in body
    assert "ticket" in body
    assert body["state"] == "INITIALIZING"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_onboarding_routes.py::test_initialize_returns_run_id_and_ticket -v`
Expected: FAIL — response won't have `run_id` or `ticket`

- [ ] **Step 3: Implement run_id + ticket generation**

Modify `src/draftly/app/api/routes/onboarding.py`:

In `_execute_initialization`, accept `run_id` and publish the ticket before running the task:

```python
from draftly.app.api.routes.workflows import _tickets

async def _execute_initialization(
    repos, org_id: str, worker, selected_repository: dict | None
) -> dict[str, Any]:
    from uuid import uuid4
    run_id = f"onboarding-init-{org_id}-{uuid4().hex[:8]}"
    ticket = _tickets(request).issue(run_id, org_id=org_id)  # need request passed in

    await repos.onboarding.upsert(org_id, state="INITIALIZING", failure=None)
    try:
        raw = await worker.run_task(
            "onboarding.initialize",
            org_id=org_id,
            selected_repository=selected_repository,
            run_id=run_id,
        )
        # ... existing result handling ...
```

Update `start_initialization` to pass `request` to `_execute_initialization` and return `run_id`/`ticket`:

```python
@router.post("/initialize")
async def start_initialization(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = _org_id(token)
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    current_state = (current or {}).get("state", "NOT_STARTED")
    if current_state == "INITIALIZING":
        return {"state": "INITIALIZING"}
    if current_state != "PREFERENCES_CONFIGURED":
        raise HTTPException(status_code=409, detail=f"Cannot initialize from {current_state}")
    worker = _init_worker_guard(request)
    result = await _execute_initialization(repos, org_id, worker, _selected(current), request=request)
    return result
```

Update `_execute_initialization` signature to accept `request` and return `run_id`/`ticket`:

```python
async def _execute_initialization(
    repos, org_id: str, worker, selected_repository: dict | None, *, request: Request
) -> dict[str, Any]:
    from uuid import uuid4
    from draftly.app.api.routes.workflows import _tickets

    run_id = f"onboarding-init-{org_id}-{uuid4().hex[:8]}"
    ticket = _tickets(request).issue(run_id, org_id=org_id)

    await repos.onboarding.upsert(org_id, state="INITIALIZING", failure=None)
    try:
        raw = await worker.run_task(
            "onboarding.initialize",
            org_id=org_id,
            selected_repository=selected_repository,
            run_id=run_id,
        )
        # ... existing result handling unchanged ...
        return {"state": "INITIALIZING", "run_id": run_id, "ticket": ticket}
    except HTTPException:
        raise
    except Exception as exc:
        # ... existing error handling ...
```

Note: The response changes from `{state: "COMPLETED", ...}` to `{state: "INITIALIZING", run_id, ticket}` because the task now runs asynchronously from the frontend's perspective — the frontend connects to SSE for the result.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_onboarding_routes.py::test_initialize_returns_run_id_and_ticket -v`
Expected: PASS

- [ ] **Step 5: Run full backend suite + ruff**

Run: `uv run pytest -q && uv run ruff check src/draftly/app/api/routes/onboarding.py`
Expected: All green

---

### Task 3: Refactor useWorkflowEvents to accept external ticket

**Files:**
- Modify: `draftly-agent-frontend/hooks/use-workflow-events.ts`
- Test: add test or verify existing tests pass

**Interfaces:**
- Consumes: optional `ticket` parameter
- Produces: same `{ status, events, nodeStates, text }` return shape

- [ ] **Step 1: Modify useWorkflowEvents to accept optional ticket**

Change the function signature:

```typescript
export function useWorkflowEvents(
  runId: string | null,
  options?: { ticket?: string },
) {
```

In the useEffect, when `options?.ticket` is provided, skip the ticket fetch and use it directly:

```typescript
useEffect(() => {
  if (!runId) return;
  let cancelled = false;

  (async () => {
    setStatus("connecting");
    try {
      let ticket = options?.ticket;

      if (!ticket) {
        // Fetch ticket via the shared auth-injected client
        const { ticket: fetched } = await request<{ ticket: string }>(
          `/workflows/${encodeURIComponent(runId)}/stream-ticket`,
          { method: "POST" },
        );
        ticket = fetched;
      }

      if (cancelled || !ticket) return;

      const source = new EventSource(
        `/api/workflows/${encodeURIComponent(runId)}/events?ticket=${encodeURIComponent(ticket)}`,
      );
      // ... rest unchanged
    }
  })();
}, [runId, apply, options?.ticket]);
```

- [ ] **Step 2: Verify tsc clean**

Run: `npx tsc --noEmit` (in frontend dir)
Expected: No errors

- [ ] **Step 3: Run frontend tests**

Run: `npx vitest run` (in frontend dir)
Expected: 54/54 pass

---

### Task 4: Swap polling for SSE in initialize page

**Files:**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`
- Modify: `draftly-agent-frontend/api/onboarding.ts` (update `startInitialize` return type)

**Interfaces:**
- Consumes: `run_id` + `ticket` from POST response, `useWorkflowEvents` hook
- Produces: live stage rendering from SSE events

- [ ] **Step 1: Update startInitialize return type in api/onboarding.ts**

```typescript
export async function startInitialize(): Promise<{
  state: string;
  run_id?: string;
  ticket?: string;
  result?: Record<string, unknown>;
}> {
  return request("/onboarding/initialize", { method: "POST" });
}
```

- [ ] **Step 2: Update InitializeStatus type**

In `draftly-agent-frontend/lib/onboarding/types.ts`, add `run_id` and `ticket` to `InitializeStatus`:

```typescript
export interface InitializeStatus {
  state: string;
  stage?: string | null;
  failure?: { step: string; detail: string } | null;
  run_id?: string;
  ticket?: string;
}
```

- [ ] **Step 3: Rewrite initialize/page.tsx to use SSE**

Replace the polling `useEffect` with SSE via `useWorkflowEvents`:

```typescript
"use client";
import { useStepGuard } from "@/lib/onboarding/use-step-guard";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { InitializationProgress } from "@/components/onboarding/initialization-progress";
import { InitializationError } from "@/components/onboarding/initialization-error";
import { startInitialize, retryInitialize } from "@/api/onboarding";
import { useWorkflowEvents } from "@/hooks/use-workflow-events";

export default function InitializePage() {
  useStepGuard("initialize");
  const router = useRouter();
  const [runId, setRunId] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [isFailed, setIsFailed] = useState(false);
  const [failure, setFailure] = useState<{ step: string; detail: string } | null>(null);

  const { status, events } = useWorkflowEvents(runId, { ticket: ticket ?? undefined });

  // Process stream events to extract stage and completion
  useEffect(() => {
    for (const event of events) {
      if (event.type === "stage_change" && typeof event.payload.stage === "string") {
        setStage(event.payload.stage);
      }
      if (event.type === "workflow_result") {
        if (event.payload.status === "COMPLETED") {
          router.push("/onboarding/complete");
        } else {
          setIsFailed(true);
          setFailure({
            step: "initialize",
            detail: String(event.payload.error ?? "Initialization failed"),
          });
        }
      }
    }
  }, [events, router]);

  // Start initialization on mount
  useEffect(() => {
    if (runId) return; // already started
    startInitialize()
      .then((res) => {
        if (res.run_id && res.ticket) {
          setRunId(res.run_id);
          setTicket(res.ticket);
        } else {
          setStartError("Initialization did not start.");
        }
      })
      .catch(() => setStartError("We couldn't start initialization."));
  }, [runId]);

  // Fallback: if SSE disconnects without workflow_result, show error
  const showDisconnectedError = status === "error" && !isFailed && !startError;

  async function handleRetry() {
    setStartError(null);
    setIsFailed(false);
    setFailure(null);
    setRunId(null);
    setTicket(null);
    setStage(null);
    try {
      await retryInitialize();
    } catch {
      setStartError("Retry failed. Please try again.");
    }
  }

  return (
    <OnboardingShell currentStep="initialize">
      <h1 className="mb-[11px] mt-[clamp(24px,4vh,48px)] text-[clamp(24px,3.2vh,32px)] font-bold leading-[1.2] tracking-[-1.2px] text-[#101a43]">
        Initializing Draftly
      </h1>
      <p className="mb-[clamp(8px,1.8vh,24px)] text-[15px] leading-[1.55] text-[#53648e]">
        We&apos;re analyzing your repository and building the knowledge
        <br /> foundation. This may take a few minutes.
      </p>
      <div className="mt-6">
        {isFailed || showDisconnectedError || startError ? (
          <InitializationError
            failure={
              failure ??
              (startError
                ? { step: "initialize", detail: startError }
                : { step: "initialize", detail: "Lost contact with the server." })
            }
            onRetry={() => void handleRetry()}
          />
        ) : (
          <InitializationProgress stage={stage} />
        )}
      </div>
    </OnboardingShell>
  );
}
```

- [ ] **Step 4: Verify tsc clean**

Run: `npx tsc --noEmit` (in frontend dir)
Expected: No errors

- [ ] **Step 5: Run frontend tests**

Run: `npx vitest run` (in frontend dir)
Expected: All pass

- [ ] **Step 6: Run graphify update**

Run: `graphify update .` (in backend dir)
Expected: Graph updated

---

## End-to-End Verification

After all tasks:

1. Start Redis: `docker compose -f docker-compose.redis.yml up -d`
2. Add `EVENTS_STREAMING_ENABLED=true` to `.env`
3. Start backend: `uvicorn draftly.app.main:app --reload`
4. Start frontend: `npm run dev`
5. Navigate to onboarding flow, reach initialize step
6. Observe: stages update in real-time (no 3s polling delay)
7. Verify: DB `workflow_events` table has envelopes for the run
8. Verify: backend suite 625+P/4S, frontend vitest all pass, ruff/tsc clean
