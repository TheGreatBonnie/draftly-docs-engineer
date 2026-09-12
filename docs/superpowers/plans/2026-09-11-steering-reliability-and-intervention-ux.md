# Steering Reliability and Intervention UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backend steering limits, persistence, recovery, logging, and audit behavior correct, then expose a safe, accessible human-intervention experience in `draftly-agent-ui`.

**Architecture:** Keep the existing centralized `SteeringHandler` and `WorkflowRunner` design. Make the per-run `SteeringRuntimeConfig` the source of the effective guide limits, make intervention persistence a hard invariant whenever enforcement is enabled, and publish one typed safe intervention contract for both the run API and SSE stream. The frontend will consume that contract through the existing workflow-run hook and render steering separately from the existing `ReviewGate` review flow.

**Tech Stack:** Python 3.11, FastAPI, asyncpg/PostgreSQL, pytest/pytest-asyncio, structlog, Redis-backed SSE; Next.js 16, React 19, TypeScript, Tailwind, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-steering-design.md`

## Global Constraints

- Preserve the distinction between `pending_intervention` and `pending_review`; steering must not replace `ReviewGate`.
- Never expose raw prompts, credentials, authorization headers, cookies, repository contents, or unrestricted tool payloads in API responses, SSE events, audit records, browser logs, or UI.
- Automatic guide limits must remain effective after handler recreation, graph rebuild, process restart, and intervention resume.
- Side-effecting roles must fail closed before an external side effect when policy, persistence, authorization, or safety checks cannot be trusted.
- Intervention responses must remain organization-authorized, bounded, idempotent, and concurrency-safe.
- Every production-code change follows TDD: write a focused failing test, run it to confirm the expected failure, implement the smallest fix, run the focused test, then run the relevant regression suite.
- Do not require live model keys, NeonDB, Redis, or production credentials for unit and contract tests.

---

## Workstream A: Backend reliability and contract

### Task 1: Make configured guide budgets effective and enforce the total agent budget

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py:42-62`
- Modify: `draftly-agent-backend/src/draftly/steering/persistence.py:24-69`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/steering.py:90-145`
- Modify: `draftly-agent-backend/src/draftly/steering/policy.py:110-155,433-458`
- Test: `draftly-agent-backend/tests/persistence/test_steering_repository.py`
- Test: `draftly-agent-backend/tests/steering/test_policy.py`
- Test: `draftly-agent-backend/tests/steering/test_runtime_wiring.py`

**Interfaces:**
- Consumes: `SteeringRuntimeConfig.tool_guides_per_call`, `model_guides_per_turn`, and `total_guides_per_agent`.
- Produces: repository-backed reservations that atomically enforce both the scoped limit and the per-agent total limit.

- [ ] **Step 1: Write the failing persistence tests.** Add tests proving that a configured tool limit of `1` rejects the second reservation, a configured model limit of `1` rejects the second reservation, and a configured total limit of `2` rejects a third guide even when it would be on a different node/tool key.

- [ ] **Step 2: Run the focused tests and confirm they fail for the current behavior.**

  Run from `draftly-agent-backend`:

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_steering_repository.py tests/steering/test_policy.py tests/steering/test_runtime_wiring.py -q
  ```

  Expected failure: the composition still constructs `SteeringPersistence` with default limits, and no total-agent reservation exists.

- [ ] **Step 3: Thread one validated `SteeringLimits` snapshot into the persistence adapter.** Construct `SteeringLimits` from the run’s steering configuration in `_steering_runtime_factory`, pass it to `SteeringPersistence(limits=...)`, and ensure the snapshot is preserved when creating child runtimes.

- [ ] **Step 4: Add an atomic aggregate reservation.** Extend `SteeringAttemptsRepository` with a method that reserves the phase/tool or phase/model counter and the agent-total counter in one database transaction or one atomic SQL operation. Use a stable synthetic total-counter key such as `(run_id, agent_id, node_id='', phase='agent_total', tool_name='', model_turn=0)` so the existing migration remains compatible. If either scoped or total capacity is exhausted, neither counter may increase.

- [ ] **Step 5: Route both tool and model guide decisions through the aggregate reservation.** Preserve the existing terminal rules: side-effecting roles return `Interrupt` on exhaustion, read-only roles follow their typed failure mode, and model steering remains limited to `Proceed`/`Guide`.

- [ ] **Step 6: Run the focused tests again and then the complete steering suite.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_steering_repository.py tests/steering/test_policy.py tests/steering/test_runtime_wiring.py -q
  DRAFTLY_LIVE=0 uv run pytest tests/steering -q
  ```

- [ ] **Step 7: Commit the independently testable budget change.**

  ```bash
  git add src/draftly/app/composition/workflows.py src/draftly/steering/persistence.py src/draftly/persistence/repositories/steering.py src/draftly/steering/policy.py tests/persistence/test_steering_repository.py tests/steering/test_policy.py tests/steering/test_runtime_wiring.py
  git commit -m "fix: enforce configured steering guide budgets"
  ```

### Task 2: Fix intervention resolution and resume-state correctness

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/steering.py:260-283`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py:608-780`
- Test: `draftly-agent-backend/tests/persistence/test_steering_repository.py`
- Test: `draftly-agent-backend/tests/workflows/test_steering_intervention_resume.py`

**Interfaces:**
- Consumes: `SteeringInterventionsRepository.resolve()` and `WorkflowRunner.resume_intervention()`.
- Produces: a resolution method that returns the updated record and a resume path that distinguishes resolved, expired, conflicted, and failed-to-resume states.

- [ ] **Step 1: Write a failing repository test that makes `resolve()` return an updated `InterventionRecord`.** Configure the database test double to return rows only when the SQL includes `RETURNING`, and assert the returned record has the requested status, resolver, and timestamps.

- [ ] **Step 2: Run the repository test and confirm it fails because the current `UPDATE` has no `RETURNING` clause.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_steering_repository.py -q
  ```

- [ ] **Step 3: Add an explicit `RETURNING` projection matching `_SELECT`.** Keep the existing pending-row guard so resolving an already-resolved intervention still raises `InterventionNotFoundError`.

- [ ] **Step 4: Add resume tests for the real repository contract.** Cover expiry resolution, duplicate response replay, concurrent claim conflict, session loss after claim, and resume failure. Assert that the run receives a deterministic recovery status and that the intervention response does not claim successful resume when the session cannot be reconstructed.

- [ ] **Step 5: Run the focused persistence and resume suites.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_steering_repository.py tests/workflows/test_steering_intervention_resume.py -q
  ```

- [ ] **Step 6: Commit the resolution and resume fix.**

  ```bash
  git add src/draftly/persistence/repositories/steering.py src/draftly/workflows/runner.py tests/persistence/test_steering_repository.py tests/workflows/test_steering_intervention_resume.py
  git commit -m "fix: return resolved steering interventions reliably"
  ```

### Task 3: Enforce durable-intervention invariants for side-effecting roles

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py:37-62`
- Modify: `draftly-agent-backend/src/draftly/steering/handler.py:330-385`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py:1082-1113`
- Test: `draftly-agent-backend/tests/steering/test_handler.py`
- Test: `draftly-agent-backend/tests/steering/test_runtime_wiring.py`
- Test: `draftly-agent-backend/tests/workflows/test_steering_intervention_resume.py`

**Interfaces:**
- Consumes: enforcement configuration, intervention repository availability, and role `side_effecting` policy.
- Produces: either a durable pending intervention before returning `Interrupt`, or an explicit typed recovery failure; never an untracked pause.

- [ ] **Step 1: Write failing tests for missing and failing intervention persistence.** Assert that enforcement-enabled side-effecting runs fail startup/runtime validation when the intervention repository is absent, and that a repository write failure produces a typed recovery failure without an untracked `Interrupt`.

- [ ] **Step 2: Run the focused tests and confirm the current implementation returns an unpersisted interrupt or silently degrades.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/steering/test_handler.py tests/steering/test_runtime_wiring.py -q
  ```

- [ ] **Step 3: Validate required repositories during enforcement composition.** Keep shadow mode and steering-disabled offline behavior compatible, but reject an enforcement-enabled runtime that cannot provide intervention and attempt persistence. Include the surface, policy version, and repository availability in the configuration error.

- [ ] **Step 4: Make `_persist_intervention()` preserve the actual bounded decision reason.** Store redacted reason, rule, action, phase, role, policy version, and safe identity metadata. Do not store tool arguments or model content.

- [ ] **Step 5: Make persistence failures explicit.** For side-effecting roles, raise `SteeringFailure` and let the runner mark the run as recovery-required/failed with a safe operator-visible reason. For read-only roles, retain the documented typed fallback and emit an audit/metric outcome showing that the decision was not durably recorded.

- [ ] **Step 6: Add runner tests proving the lifecycle cannot become `pending_intervention` without a matching pending database row.** Preserve the existing rule that `ReviewGate` interruptions become `pending_review`.

- [ ] **Step 7: Run the handler, runner, API, and migration regression tests.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/steering tests/workflows/test_steering_intervention_resume.py tests/api/test_intervention_routes.py tests/api/test_workflow_runs.py tests/persistence/test_steering_migrations.py -q
  ```

- [ ] **Step 8: Commit the durability invariant.**

  ```bash
  git add src/draftly/app/composition/workflows.py src/draftly/steering/handler.py src/draftly/workflows/runner.py tests/steering/test_handler.py tests/steering/test_runtime_wiring.py tests/workflows/test_steering_intervention_resume.py
  git commit -m "fix: require durable steering interventions"
  ```

### Task 4: Complete structured logging, metrics, and audit details

**Files:**
- Modify: `draftly-agent-backend/src/draftly/steering/context.py:145-169`
- Modify: `draftly-agent-backend/src/draftly/steering/handler.py:305-328`
- Modify: `draftly-agent-backend/src/draftly/steering/persistence.py:119-160`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py:151-190,1082-1113`
- Modify or remove duplicate implementation: `draftly-agent-backend/src/draftly/orchestration/hooks/audit.py:292-340`
- Test: `draftly-agent-backend/tests/events/test_steering_events.py`
- Test: `draftly-agent-backend/tests/orchestration/hooks/test_steering_audit.py`
- Test: `draftly-agent-backend/tests/steering/test_handler.py`
- Test: `draftly-agent-backend/tests/workflows/test_runner_broadcast.py`

**Interfaces:**
- Consumes: typed steering decisions and per-run identity/configuration.
- Produces: safe decision logs, metrics, and `agent_steps` records with consistent fields and no silent event-sink failures.

- [ ] **Step 1: Write failing observability tests.** Cover a decision log/metric containing run, surface, role, agent, node, phase, action, rule, and tool identifiers; an event-sink failure incrementing a metric and emitting a structured warning; and an audit detail containing policy version, limit snapshot, attempt summary, and intervention correlation when available.

- [ ] **Step 2: Run the focused tests and verify the missing fields/silent exception path.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/events/test_steering_events.py tests/orchestration/hooks/test_steering_audit.py tests/steering/test_handler.py tests/workflows/test_runner_broadcast.py -q
  ```

- [ ] **Step 3: Add one structured `steering_decision` log at the handler boundary.** Log safe identifiers and bounded redacted reason/rule data only. Keep high-cardinality values out of metric labels if the project’s metrics backend does not support them; use the existing metric naming convention for counters.

- [ ] **Step 4: Replace the silent `except Exception: pass` in `SteeringRuntime.emit()`.** Increment `draftly_steering_event_sink_failures_total` and issue a warning with safe correlation fields, while continuing the run because event publication is best-effort after audit.

- [ ] **Step 5: Expand the active audit sink and converge the duplicate `SteeringAudit` implementation.** Ensure the active path records schema version, policy version, decision source, attempt/limit snapshot, outcome, and safe stream/intervention correlation. Preserve bounded redaction and keep `kind='steering'`.

- [ ] **Step 6: Run the complete backend steering and observability suites.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/steering tests/events/test_steering_events.py tests/orchestration/hooks/test_steering_audit.py tests/workflows/test_steering_intervention_resume.py -q
  ```

- [ ] **Step 7: Commit the observability changes.**

  ```bash
  git add src/draftly/steering/context.py src/draftly/steering/handler.py src/draftly/steering/persistence.py src/draftly/workflows/runner.py src/draftly/orchestration/hooks/audit.py tests/events/test_steering_events.py tests/orchestration/hooks/test_steering_audit.py tests/steering/test_handler.py tests/workflows/test_runner_broadcast.py
  git commit -m "chore: improve steering observability and audit context"
  ```

### Task 5: Publish a stable, safe intervention API contract

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/steering_schemas.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py:128-159`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/interventions.py`
- Test: `draftly-agent-backend/tests/api/test_workflow_runs.py`
- Test: `draftly-agent-backend/tests/api/test_intervention_routes.py`

**Interfaces:**
- Consumes: `InterventionRecord`, authenticated workflow-run access, and the existing response endpoint.
- Produces: typed pending-intervention data and a response contract usable by the UI after a reload, not only during SSE delivery.

- [ ] **Step 1: Write failing API contract tests.** Assert that `GET /workflow-runs/{run_id}` returns `pending_interventions` with `interrupt_id`, `status`, `phase`, `role`, `rule`, bounded `reason`, `agent_id`, `node_id`, `tool_name`, `created_at`, and `expires_at`; assert that no raw tool input appears. Add tests for unsupported action/phase combinations, oversized messages, organization mismatch, expired rows, duplicate idempotency keys, and concurrent responses.

- [ ] **Step 2: Run the API tests and confirm the current response omits the required fields and validation.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/api/test_workflow_runs.py tests/api/test_intervention_routes.py -q
  ```

- [ ] **Step 3: Define a typed `PendingInterventionSummary` response model.** Use the existing redaction/bounds rules and make the field optional for runs with no pending interventions. Include only safe display data.

- [ ] **Step 4: Map the stored reason and metadata into that response model.** Return timestamps in the API’s existing serialization format, and keep the response compatible with runs that predate steering.

- [ ] **Step 5: Enforce action/phase compatibility before claiming the row.** Keep `approve`, `deny`, and `guide` as the public actions; reject `guide` when the stored phase/interrupt contract does not permit it. Preserve the current authorization and idempotency behavior.

- [ ] **Step 6: Run the full backend API and steering regression suites.**

  ```bash
  DRAFTLY_LIVE=0 uv run pytest tests/api/test_workflow_runs.py tests/api/test_intervention_routes.py tests/steering tests/workflows/test_steering_intervention_resume.py -q
  ```

- [ ] **Step 7: Commit the contract change.**

  ```bash
  git add src/draftly/app/api/steering_schemas.py src/draftly/app/api/routes/workflow_runs.py src/draftly/app/api/routes/interventions.py tests/api/test_workflow_runs.py tests/api/test_intervention_routes.py
  git commit -m "feat: expose safe steering intervention details"
  ```

## Workstream B: Frontend steering display and response flow

### Task 6: Add typed API and SSE support for steering

**Files:**
- Modify: `draftly-agent-ui/api/workflows.ts:1-47,129-163`
- Modify: `draftly-agent-ui/hooks/use-workflow-events.ts:6-42,68-116`
- Modify: `draftly-agent-ui/hooks/use-workflow-run.ts:8-27`
- Test: `draftly-agent-ui/tests/workflow-api.test.ts`
- Test: `draftly-agent-ui/tests/workflow-view-model.test.ts`

**Interfaces:**
- Consumes: the backend `PendingInterventionSummary`, `POST /workflow-runs/{run_id}/interventions/{interrupt_id}/respond`, and typed `steering` SSE envelopes.
- Produces: `WorkflowRun.pending_interventions`, `RunStatus='pending_intervention'`, `respondToIntervention()`, and a separate `steeringEvents`/intervention state collection.

- [ ] **Step 1: Write failing TypeScript tests for the API wrapper and event model.** Assert that `respondToIntervention()` sends `action`, optional `message`, and an idempotency key; assert that a `steering` event is recognized without being converted into a node step; assert that `pending_intervention` is a valid run status.

- [ ] **Step 2: Run the focused frontend tests and confirm the current types/wrapper/event registry lack steering support.**

  ```bash
  pnpm test -- tests/workflow-api.test.ts tests/workflow-view-model.test.ts
  ```

- [ ] **Step 3: Add the frontend types.** Model the safe intervention fields returned by the backend and use an explicit action/result type for `approve`, `deny`, `guide`, `pending`, `approved`, `denied`, `guided`, `expired`, and `cancelled`.

- [ ] **Step 4: Add `respondToIntervention(runId, interruptId, payload, idempotencyKey)` to `api/workflows.ts`.** Use the existing `request()` and `ApiError` behavior; do not generate or log the message outside the request boundary.

- [ ] **Step 5: Register the named `steering` SSE listener.** Parse only the safe envelope, deduplicate by sequence as the existing hook does, append it to the event history, and keep it out of `mergedSteps`. When a steering interrupt arrives, refresh the persisted run so the UI obtains the durable intervention record.

- [ ] **Step 6: Run the frontend focused tests, typecheck, and full test suite.**

  ```bash
  pnpm test -- tests/workflow-api.test.ts tests/workflow-view-model.test.ts
  pnpm exec tsc --noEmit
  pnpm test
  ```

- [ ] **Step 7: Commit the frontend contract layer.**

  ```bash
  git add api/workflows.ts hooks/use-workflow-events.ts hooks/use-workflow-run.ts tests/workflow-api.test.ts tests/workflow-view-model.test.ts
  git commit -m "feat: add steering intervention API and stream types"
  ```

### Task 7: Build the accessible run-detail intervention panel

**Files:**
- Create: `draftly-agent-ui/components/sections/workflows/steering-intervention-panel.tsx`
- Create: `draftly-agent-ui/components/sections/workflows/steering-event-timeline.tsx`
- Modify: `draftly-agent-ui/components/sections/workflows/workflow-run-detail-page.tsx:1-56`
- Modify: `draftly-agent-ui/lib/workflow-view-model.ts` if status tone mapping needs an explicit `pending_intervention` style
- Test: `draftly-agent-ui/tests/workflow-view-model.test.ts`
- Test: `draftly-agent-ui/tests/steering-intervention.test.ts`

**Interfaces:**
- Consumes: `useWorkflowRun()` data, safe intervention details, steering events, and `respondToIntervention()`.
- Produces: a responsive panel with reason/context, approve/deny/guide actions, confirmation/error states, and a steering timeline distinct from execution steps.

- [ ] **Step 1: Write failing component/view-model tests.** Cover rendering for a pending intervention, absence for a normal run, safe display of role/node/tool/reason, action submission, disabled controls while submitting, 409/already-resolved response, expired intervention, and successful refresh after a response.

- [ ] **Step 2: Run the focused frontend tests and confirm the panel does not exist.**

  ```bash
  pnpm test -- tests/steering-intervention.test.ts tests/workflow-view-model.test.ts
  ```

- [ ] **Step 3: Implement the panel with explicit text labels and semantic controls.** Display “Pending intervention” as text plus an icon/state treatment; show reason, affected tool, node, role, phase, creation time, and expiry when available. Use a labeled textarea for optional guidance and separate buttons for Approve, Deny, and Guide.

- [ ] **Step 4: Implement response state transitions.** Generate one idempotency key per user submission, disable all actions while the request is in flight, display safe API errors, handle duplicate/replayed responses by showing the returned current status, and call `refresh()` after success. Do not optimistically mark the workflow completed.

- [ ] **Step 5: Add the steering event timeline.** Render decision action, rule, role, node/tool, bounded reason, and interrupt ID when present. Keep it visually and semantically separate from persisted execution steps and `ReviewGate` review history.

- [ ] **Step 6: Update the run-detail action area.** Treat `pending_intervention` as a deliberate paused state, not a generic cancellable run. Keep existing cancel/retry behavior for other statuses and preserve the existing loading, error, and empty states.

- [ ] **Step 7: Verify accessibility and responsive behavior.** Ensure labels are associated with inputs, buttons are keyboard reachable, focus moves to the panel when it appears, status changes use a live region, and the layout works at 320px, 768px, 1024px, and 1440px without relying on color alone.

- [ ] **Step 8: Run focused tests and typecheck.**

  ```bash
  pnpm test -- tests/steering-intervention.test.ts tests/workflow-view-model.test.ts
  pnpm exec tsc --noEmit
  ```

- [ ] **Step 9: Commit the run-detail UI.**

  ```bash
  git add components/sections/workflows/steering-intervention-panel.tsx components/sections/workflows/steering-event-timeline.tsx components/sections/workflows/workflow-run-detail-page.tsx lib/workflow-view-model.ts tests/steering-intervention.test.ts tests/workflow-view-model.test.ts
  git commit -m "feat: display and resolve steering interventions"
  ```

### Task 8: Add dashboard discoverability and production-safe frontend logging

**Files:**
- Modify: `draftly-agent-ui/components/overview/attention-panel.tsx`
- Modify: `draftly-agent-ui/components/live-events/live-events-provider.tsx`
- Modify: `draftly-agent-ui/hooks/use-workflow-events.ts:84-237`
- Modify: `draftly-agent-ui/api/workflows.ts` if a pending-run list helper is needed
- Test: `draftly-agent-ui/tests/overview.test.ts`
- Test: `draftly-agent-ui/tests/dashboard-state.test.ts`

**Interfaces:**
- Consumes: organization-scoped workflow runs filtered by `pending_intervention` and the existing `workflow:changed` dashboard event.
- Produces: a visible attention count/link and debug logging that is silent by default.

- [ ] **Step 1: Write failing dashboard tests.** Assert that pending interventions appear in the attention model, that a `workflow:changed` event causes the count to refresh, and that pending reviews remain a separate category.

- [ ] **Step 2: Run the focused tests and confirm pending interventions are absent from the attention panel.**

  ```bash
  pnpm test -- tests/overview.test.ts tests/dashboard-state.test.ts
  ```

- [ ] **Step 3: Add a pending-intervention attention item.** Link it to the relevant run detail page when a run is known; otherwise link to the filtered workflow-runs view. Use text/icon/status semantics in addition to color.

- [ ] **Step 4: Keep live refresh behavior bounded.** Reuse the existing refresh mechanism and do not add a second polling loop. Ensure a dashboard lifecycle update refreshes counts without opening a per-run SSE connection for every dashboard row.

- [ ] **Step 5: Gate or remove raw SSE `console.log` calls.** In production, do not log raw event payloads, guidance messages, ticket URLs, or browser `EventSource` errors. If development diagnostics are retained, guard them with an explicit debug flag and log only event type, sequence, run ID, and connection state.

- [ ] **Step 6: Run focused tests, full tests, typecheck, lint, and build.**

  ```bash
  pnpm test -- tests/overview.test.ts tests/dashboard-state.test.ts
  pnpm test
  pnpm exec tsc --noEmit
  pnpm lint
  pnpm build
  ```

- [ ] **Step 7: Commit dashboard and logging cleanup.**

  ```bash
  git add components/overview/attention-panel.tsx components/live-events/live-events-provider.tsx hooks/use-workflow-events.ts api/workflows.ts tests/overview.test.ts tests/dashboard-state.test.ts
  git commit -m "chore: surface pending interventions safely in the dashboard"
  ```

## Final integration and release verification

### Task 9: Verify the complete backend-to-frontend intervention flow

**Files:**
- Test: `draftly-agent-backend/tests/api/test_intervention_routes.py`
- Test: `draftly-agent-backend/tests/workflows/test_steering_intervention_resume.py`
- Test: `draftly-agent-backend/tests/events/test_steering_events.py`
- Test: `draftly-agent-ui/tests/steering-intervention.test.ts`
- Test: `draftly-agent-ui/tests/workflow-api.test.ts`

- [ ] **Step 1: Run the complete backend regression suite.**

  ```bash
  cd draftly-agent-backend
  DRAFTLY_LIVE=0 uv run pytest -q
  ```

- [ ] **Step 2: Run the complete frontend verification suite.**

  ```bash
  cd ../draftly-agent-ui
  pnpm test
  pnpm exec tsc --noEmit
  pnpm lint
  pnpm build
  ```

- [ ] **Step 3: Exercise the manual acceptance flow with a seeded pending intervention.** Confirm the sequence: steering event appears, run becomes `pending_intervention`, panel displays safe context, Approve/Deny/Guide submits once, duplicate submission returns current state, resume event/status refreshes, and the run never appears in the ReviewGate inbox.

- [ ] **Step 4: Exercise failure paths.** Confirm missing persistence cannot create an untracked pause, an expired intervention is clearly actionable only through the displayed recovery state, a lost session becomes recovery-required, and an SSE publication failure is logged/metriced without exposing sensitive payloads.

- [ ] **Step 5: Review rollout configuration.** Verify shadow mode remains non-enforcing, enforcement cannot start without required persistence, the LLM judge remains independently disabled/enabled, and the kill switch does not bypass existing authorization or `ReviewGate` protections.

- [ ] **Step 6: Run `graphify update .` from the repository root after code changes so the project graph reflects the new backend/frontend relationships.**

- [ ] **Step 7: Apply the verification-before-completion checklist and record the final test outputs before declaring the work complete.**

## Dependency order

1. Task 1: effective and bounded guide budgets.
2. Task 2: reliable intervention resolution and resume outcomes.
3. Task 3: durable-intervention invariant.
4. Task 4: complete logging and audit context.
5. Task 5: stable backend API contract.
6. Task 6: frontend types, API wrapper, and SSE ingestion.
7. Task 7: run-detail intervention UI.
8. Task 8: dashboard discoverability and logging cleanup.
9. Task 9: full integration verification.

The frontend workstream should not begin before Task 5’s response shape is agreed and covered by backend contract tests. Tasks 1–4 can be reviewed independently; Task 5 is the handoff boundary between backend and frontend.
