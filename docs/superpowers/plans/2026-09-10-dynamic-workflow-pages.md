# Dynamic Workflow Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static workflows list, workflow detail, workflow run detail, subpages, templates, and configuration actions with organization-scoped production data backed by durable workflow definitions, templates, runs, steps, events, reviews, evaluations, and artifacts.

**Architecture:** Separate reusable workflow definitions from workflow run instances. Add canonical backend resources for definitions, templates, and runs while retaining `github_workflows`, `agent_runs`, `agent_steps`, `workflow_events`, reviews, evaluations, and delivery records as provider/audit compatibility stores during migration. The Next.js route family consumes typed frontend view models through `request()`, `useLiveRefresh()`, and `useWorkflowEvents()`; every runtime value comes from the backend or SSE.

**Tech Stack:** FastAPI, Python 3.11, Pydantic, CockroachDB/PostgreSQL-compatible SQL, Redis/RQ, structlog, pytest, Next.js 16 App Router, React 19, TypeScript, Tailwind, Clerk bearer tokens, Node’s built-in test runner, and the existing dashboard SSE transport.

**Spec:** `docs/superpowers/specs/2026-09-10-dynamic-workflow-pages-design.md`

## Global Constraints

- Keep workflow definitions, workflow templates, and workflow runs as separate resources and separate status enums.
- Derive every organization ID from the verified Clerk token; never trust an organization ID from a request body or query string.
- Keep all list endpoints cursor-paginated, deterministically ordered, indexed, and bounded to a maximum page size of 200.
- Validate trigger, condition, agent, repository, evaluation, review, and delivery configuration with Pydantic before persistence.
- Never persist provider credentials, model keys, raw sensitive webhook payloads, or unredacted run input/output in display-facing JSON.
- Keep existing `github_workflows` and `/api/workflows/{run_id}/events` behavior available through compatibility aliases until all clients migrate.
- Use idempotency keys for manual run creation and preserve existing webhook idempotency behavior.
- Treat `pending_review` as a run status and `paused` as a definition lifecycle status; never infer one from the other.
- Do not add a new frontend dependency; use the existing `request`, `useLiveRefresh`, `useWorkflowEvents`, Node test runner, and dashboard SSE provider.
- Remove all `lib/mock-data.ts` imports from the workflow route family before enabling the production pages.
- Backend and frontend are separate git repositories; implementation commits touch only files in their owning repository.

## File Structure

Backend:

- Create: `draftly-agent-backend/src/draftly/persistence/migrations/049_workflow_definitions.sql` — definition schema, lifecycle constraints, and organization indexes.
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/050_workflow_templates.sql` — system and organization template schema.
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/051_workflow_runs.sql` — canonical run schema, idempotency constraint, and run indexes.
- Create: `draftly-agent-backend/src/draftly/app/api/workflow_schemas.py` — Pydantic request/response models and safe configuration validation.
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/workflows.py` — definition/template/run repositories and aggregation queries.
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflows.py` — definition list/detail/mutation routes and compatibility run-list route.
- Create: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py` — canonical run detail, steps, artifacts, review/evaluation, lifecycle, manual-run, and SSE routes.
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py` — register the canonical workflow-run router.
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py` — wire workflow repositories into application dependencies.
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py` — resolve a persisted definition’s `workflow_key` and configuration into the composed runtime registry.
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py` — create/update canonical run rows and preserve existing telemetry/event writes.
- Create: `draftly-agent-backend/scripts/backfill_workflow_resources.py` — idempotent definition/run backfill with counters and dry-run mode.
- Create: `draftly-agent-backend/tests/persistence/test_workflow_resources.py` — repository, migration, redaction, and idempotency tests.
- Create: `draftly-agent-backend/tests/api/test_workflow_definitions.py` — definition/template CRUD, permissions, pagination, and summary tests.
- Create: `draftly-agent-backend/tests/api/test_workflow_runs.py` — run detail, actions, aggregation, authorization, and compatibility tests.
- Modify: `draftly-agent-backend/tests/api/test_workflows_list.py` — assert the compatibility response and canonical definition contract.
- Modify: `draftly-agent-backend/tests/persistence/test_github_workflows_meta.py` — assert provider-to-canonical run linkage.

Frontend:

- Modify: `draftly-agent-ui/api/observability.ts` — replace the unused run-shaped workflow type with typed definition/template/run API wrappers.
- Create: `draftly-agent-ui/api/workflows.ts` — workflow-specific endpoint methods and request payload types.
- Create: `draftly-agent-ui/lib/workflow-view-model.ts` — normalization, status/tone mapping, stage labels, filtering, sorting, and safe formatting.
- Create: `draftly-agent-ui/hooks/use-workflows.ts` — definitions list/summary hook with SSE refresh and polling fallback.
- Create: `draftly-agent-ui/hooks/use-workflow-detail.ts` — definition detail and definition-run list hooks.
- Create: `draftly-agent-ui/hooks/use-workflow-run.ts` — run detail, persisted steps, optional related records, and live-event merge.
- Create: `draftly-agent-ui/components/sections/workflows/workflows-page.tsx` — dynamic definitions list and summary cards.
- Create: `draftly-agent-ui/components/sections/workflows/workflows-subpage.tsx` — active, paused, drafts, and templates views.
- Create: `draftly-agent-ui/components/sections/workflows/workflow-detail-page.tsx` — dynamic definition detail and recent runs.
- Create: `draftly-agent-ui/components/sections/workflows/workflow-run-detail-page.tsx` — dynamic run timeline and related records.
- Create: `draftly-agent-ui/components/sections/workflows/workflow-form.tsx` — shared create/edit form and validation state.
- Modify: `draftly-agent-ui/components/sections/workflows/index.ts` — export the focused workflow components.
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/page.tsx` — render `WorkflowsPage`.
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/[id]/page.tsx` — render `WorkflowDetailPage`.
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/[id]/runs/[runId]/page.tsx` — render `WorkflowRunDetailPage`.
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/active/page.tsx`, `paused/page.tsx`, `drafts/page.tsx`, and `templates/page.tsx` — render the dynamic subpage with its resource mode.
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/new/page.tsx` — use the shared form and create endpoint.
- Create: `draftly-agent-ui/tests/workflow-view-model.test.ts` — pure normalization/filter/sort/stage tests.
- Create: `draftly-agent-ui/tests/workflow-api.test.ts` — URL, payload, and canonical ID tests with mocked fetch.

---

### Task 1: Add canonical workflow resource schemas and database tables

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/049_workflow_definitions.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/050_workflow_templates.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/051_workflow_runs.sql`
- Create: `draftly-agent-backend/src/draftly/app/api/workflow_schemas.py`
- Create: `draftly-agent-backend/tests/persistence/test_workflow_resources.py`

**Interfaces:**
- Produces `WorkflowDefinitionCreate`, `WorkflowDefinitionPatch`, `WorkflowDefinitionResponse`, `WorkflowTemplateResponse`, `WorkflowRunResponse`, `WorkflowListResponse`, and `WorkflowRunListResponse` Pydantic models.
- Produces the `workflow_definitions`, `workflow_templates`, and `workflow_runs` tables consumed by Tasks 2–5.

- [ ] **Step 1: Write failing schema tests**

Test that valid configuration accepts the supported workflow keys and status values, invalid status/configuration is rejected, secrets are rejected from configuration JSON, and optional display fields accept `None`.

```python
def test_definition_request_rejects_provider_secret() -> None:
    with pytest.raises(ValidationError):
        WorkflowDefinitionCreate(
            name="PR docs",
            slug="pr-docs",
            workflow_key="github_pr",
            trigger_config={"event": "pull_request.opened"},
            delivery_config={"github_token": "secret"},
        )
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd draftly-agent-backend && uv run pytest tests/persistence/test_workflow_resources.py -q`

Expected: FAIL because the schema module and migrations do not exist.

- [ ] **Step 3: Add Pydantic schemas with explicit enums and redaction validation**

Define `DefinitionStatus = Literal["active", "paused", "draft", "archived"]` and `RunStatus = Literal["queued", "running", "pending_review", "completed", "failed", "cancelled", "skipped"]`. Define request models with `extra="forbid"` for top-level fields, validated JSON dictionaries for configuration, and a recursive key check that rejects values under keys containing `token`, `secret`, `password`, `api_key`, or `private_key`.

- [ ] **Step 4: Create the definition/template migrations**

Create organization-scoped tables with composite uniqueness for `(org_id, slug)`, explicit status `CHECK` constraints, JSONB defaults, foreign keys, timestamps, and indexes for `(org_id, status, updated_at DESC)` and `(org_id, workflow_key, updated_at DESC)`. Create template uniqueness for system templates and organization-owned templates without allowing an organization to claim a system slug.

- [ ] **Step 5: Create the run migration**

Create `workflow_runs` with `id`, `definition_id`, `org_id`, source/event metadata, safe display metadata, status, stage state, redacted input/output, error, timestamps, and a partial unique index on `(org_id, source, source_event_id)` where `source_event_id IS NOT NULL`. Add indexes for `(org_id, created_at DESC)`, `(org_id, status, created_at DESC)`, and `(definition_id, created_at DESC)`.

- [ ] **Step 6: Run tests and commit the schema layer**

Run: `cd draftly-agent-backend && uv run pytest tests/persistence/test_workflow_resources.py -q`

Expected: PASS.

Commit: `git add src/draftly/persistence/migrations/049_workflow_definitions.sql src/draftly/persistence/migrations/050_workflow_templates.sql src/draftly/persistence/migrations/051_workflow_runs.sql src/draftly/app/api/workflow_schemas.py tests/persistence/test_workflow_resources.py && git commit -m "feat: add canonical workflow resource schemas"`

### Task 2: Implement organization-scoped repositories, summaries, and cursors

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Modify: `draftly-agent-backend/tests/persistence/test_workflow_resources.py`

**Interfaces:**
- `WorkflowDefinitionsRepository.list(*, org_id, status=None, workflow_key=None, limit=50, cursor=None) -> tuple[list[dict[str, Any]], int, str | None]`.
- `WorkflowDefinitionsRepository.get(*, org_id, workflow_id) -> dict[str, Any] | None`.
- `WorkflowDefinitionsRepository.create(*, org_id, created_by, payload) -> dict[str, Any]`.
- `WorkflowDefinitionsRepository.update(*, org_id, workflow_id, payload) -> dict[str, Any] | None`.
- `WorkflowDefinitionsRepository.set_status(*, org_id, workflow_id, status) -> dict[str, Any] | None`.
- `WorkflowTemplatesRepository.list/get/create/instantiate` with the same organization isolation rules.
- `WorkflowRunsRepository.get(*, org_id, run_id)`, `list_for_definition(...)`, `list_steps(...)`, `list_artifacts(...)`, and `find_by_idempotency(...)`.
- `WorkflowDefinitionsRepository.summary(*, org_id, days=30) -> dict[str, Any]`.

- [ ] **Step 1: Write repository isolation, cursor, and summary tests**

Use a fake database client to assert every definition/run query includes `org_id`, every query binds a bounded limit, cursors encode the last `(updated_at, id)` tuple, and summaries count all matching rows rather than only the current page. Assert that a run from another organization returns `None`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cd draftly-agent-backend && uv run pytest tests/persistence/test_workflow_resources.py -q`

Expected: FAIL because the repositories are not implemented.

- [ ] **Step 3: Implement deterministic cursor encoding and decoding**

Encode the last sort tuple as URL-safe base64 JSON. Reject malformed cursors with a typed repository error. Order definitions by `updated_at DESC, id DESC`; order runs by `created_at DESC, id DESC`. Apply `max(1, min(limit, 200))` before binding SQL parameters.

- [ ] **Step 4: Implement organization-scoped definition/template repository methods**

Use explicit `WHERE org_id = $1` clauses for organization-owned data. For templates, return system templates plus the current organization’s templates. On create/update, map unique and check-constraint violations to domain errors consumed by the API layer.

- [ ] **Step 5: Implement run repository methods and related-record aggregation**

Read canonical `workflow_runs` first, then join/lookup `agent_runs`, `agent_steps`, `workflow_events`, reviews, evaluations, delivery, and content records by the same organization and run ID. Return `None` for optional missing records and preserve ordered steps by sequence.

- [ ] **Step 6: Implement global definition/run summaries**

Return definition counts by lifecycle status and 30-day run aggregates: total runs, active runs, successful runs, failed runs, pending reviews, success rate, and average completed duration. Compute aggregates in SQL over the requested time window, not from the paginated result.

- [ ] **Step 7: Run tests and commit**

Run: `cd draftly-agent-backend && uv run pytest tests/persistence/test_workflow_resources.py -q`

Expected: PASS.

Commit: `git add src/draftly/persistence/repositories/workflows.py src/draftly/app/dependencies.py tests/persistence/test_workflow_resources.py && git commit -m "feat: add workflow resource repositories"`

### Task 3: Add definitions and templates API routes with permissions

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflows.py`
- Create: `draftly-agent-backend/src/draftly/app/api/routes/workflow_templates.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`
- Create: `draftly-agent-backend/tests/api/test_workflow_definitions.py`

**Interfaces:**
- `GET /api/workflows?status=&workflow_key=&limit=&cursor=&days=` returns `{items, summary, total, next_cursor}`.
- `POST /api/workflows` creates a draft definition.
- `GET /api/workflows/{workflow_id}` returns a definition detail plus recent runs.
- `PATCH /api/workflows/{workflow_id}` updates editable configuration and increments `version`.
- `POST /api/workflows/{workflow_id}/pause` and `/resume` change definition lifecycle status.
- `GET /api/workflow-templates`, `GET /api/workflow-templates/{template_id}`, `POST /api/workflow-templates`, and `POST /api/workflow-templates/{template_id}/instantiate` expose templates.

- [ ] **Step 1: Write failing route tests**

Cover organization isolation, role checks, invalid configuration, cursor bounds, summary shape, unknown IDs, system-template visibility, organization-template visibility, and draft creation from a template.

```python
def test_definition_cannot_be_read_across_organizations(client, definitions_repo) -> None:
    definitions_repo.get.return_value = None
    response = client.get("/workflows/foreign-id")
    assert response.status_code == 404
```

- [ ] **Step 2: Run route tests and verify they fail**

Run: `cd draftly-agent-backend && uv run pytest tests/api/test_workflow_definitions.py -q`

Expected: FAIL because canonical routes and permission checks do not exist.

- [ ] **Step 3: Add route dependencies and role enforcement**

Use `get_verified_token` for every route. Add a role helper that allows reads to authenticated organization members, definition creation/update/template instantiation to editors/admins, and pause/resume to editors/admins. Return `403` for insufficient role and `404` for IDs outside the organization to avoid resource enumeration.

- [ ] **Step 4: Implement definition list/detail/mutation routes**

Parse query filters through typed parameters, call repository methods with the token organization, and return the documented envelope. Reject edits to `archived` definitions. Allow a draft to become active only after configuration validation succeeds.

- [ ] **Step 5: Implement template routes**

Return system templates plus organization-owned templates. Instantiate by copying validated defaults into a new draft definition with the caller as `created_by`; never mutate the template record. Reject instantiation of a template owned by another organization.

- [ ] **Step 6: Add compatibility behavior for the current run-shaped list**

Move the existing run list implementation behind `GET /api/workflow-runs` and keep `GET /api/workflows/runs` as a deprecated alias. Do not silently change the meaning of the new `GET /api/workflows` definition response for existing clients without an explicit migration flag.

- [ ] **Step 7: Run tests and commit**

Run: `cd draftly-agent-backend && uv run pytest tests/api/test_workflow_definitions.py tests/api/test_workflows_list.py -q`

Expected: PASS.

Commit: `git add src/draftly/app/api/routes/workflows.py src/draftly/app/api/routes/workflow_templates.py src/draftly/app/api/app.py tests/api/test_workflow_definitions.py tests/api/test_workflows_list.py && git commit -m "feat: expose workflow definitions and templates API"`

### Task 4: Create and reconcile canonical workflow runs

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Create: `draftly-agent-backend/scripts/backfill_workflow_resources.py`
- Modify: `draftly-agent-backend/tests/persistence/test_workflow_resources.py`
- Modify: `draftly-agent-backend/tests/persistence/test_github_workflows_meta.py`

**Interfaces:**
- `WorkflowRunsRepository.start_or_get_idempotent(*, org_id, definition_id, source, source_event_id, title, metadata) -> dict[str, Any]`.
- `WorkflowRunsRepository.update_state(*, org_id, run_id, status, current_stage=None, stage_states=None, error=None, output=None) -> None`.
- `scripts/backfill_workflow_resources.py --dry-run|--apply --org-id ...` reports created, skipped, reconciled, and failed counts.

- [ ] **Step 1: Write failing lifecycle and backfill tests**

Assert that a webhook/manual event creates one canonical run, duplicate source/idempotency keys reuse it, runner terminal state updates both canonical and compatibility rows, and historical GitHub/agent rows backfill to the same run ID without duplicate definitions.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd draftly-agent-backend && uv run pytest tests/persistence/test_workflow_resources.py tests/persistence/test_github_workflows_meta.py -q`

Expected: FAIL because runner writes do not populate `workflow_runs`.

- [ ] **Step 3: Resolve definitions at dispatch time**

Add a runtime resolver that loads an active definition by `workflow_key` and trigger/repository scope. Preserve the existing composed registry for execution, but pass the selected definition ID and sanitized configuration into `WorkflowState` and invocation metadata.

- [ ] **Step 4: Persist canonical run start and terminal transitions**

Create the run before dispatch, set `queued` then `running`, persist stage transitions, and finish with `completed`, `failed`, `pending_review`, `cancelled`, or `skipped`. Continue writing `agent_runs`, `agent_steps`, `workflow_events`, `github_workflows`, and jobs for compatibility. Ensure terminal updates are idempotent and cannot overwrite a different terminal state.

- [ ] **Step 5: Implement reconciliation and backfill**

Create definitions for configured runtime workflows, map historical provider rows to definitions by provider/event key, create canonical runs for missing audit rows, and reconcile status from terminal workflow events before jobs/provider status. The script must support dry-run output, organization filtering, repeat execution, and per-record failure logging.

- [ ] **Step 6: Run tests and commit**

Run: `cd draftly-agent-backend && uv run pytest tests/persistence/test_workflow_resources.py tests/persistence/test_github_workflows_meta.py tests/workflows -q`

Expected: PASS.

Commit: `git add src/draftly/workflows/runner.py src/draftly/app/composition/workflows.py scripts/backfill_workflow_resources.py tests/persistence/test_workflow_resources.py tests/persistence/test_github_workflows_meta.py && git commit -m "feat: persist canonical workflow runs"`

### Task 5: Add canonical run APIs, actions, aggregation, and SSE aliases

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`
- Create: `draftly-agent-backend/tests/api/test_workflow_runs.py`

**Interfaces:**
- `GET /api/workflow-runs/{run_id}` returns definition summary, run metadata, stage state, safe input/output summaries, ordered steps, and optional review/evaluation/artifact references.
- `GET /api/workflow-runs/{run_id}/steps`, `/artifacts`, `/review`, and `/evaluations` return organization-scoped related records.
- `POST /api/workflows/{workflow_id}/runs` accepts a validated trigger payload and `Idempotency-Key`, returning `202 {run_id, status, stream_ticket}`.
- `POST /api/workflow-runs/{run_id}/cancel` and `/retry` enforce permissions and state transitions.
- `POST /api/workflow-runs/{run_id}/stream-ticket` and `GET /api/workflow-runs/{run_id}/events` provide canonical SSE access.

- [ ] **Step 1: Write failing run API tests**

Cover full detail aggregation, unknown/cross-organization IDs, manual-run validation, duplicate idempotency keys, inactive definitions, cancellation/retry state rules, ticket ownership, compatibility aliases, and missing optional records.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd draftly-agent-backend && uv run pytest tests/api/test_workflow_runs.py tests/api/test_workflows_sse_starlette.py tests/api/test_workflows_stream.py -q`

Expected: FAIL because the canonical run router and action endpoints do not exist.

- [ ] **Step 3: Implement organization-scoped run detail and related-record routes**

Load the canonical run by `(org_id, run_id)`. Return `404` for another organization. Serialize safe fields only; return `review: null`, `evaluation: null`, and `artifacts: []` when no records exist. Use ordered persisted steps as the historical timeline.

- [ ] **Step 4: Implement manual run creation with idempotency**

Require an `Idempotency-Key` header, validate the definition is active, validate trigger scope and integration ownership, insert or reuse the canonical run, enqueue the composed workflow, and issue a stream ticket bound to the organization and run. Return the original response for a repeated key.

- [ ] **Step 5: Implement cancel/retry transitions**

Permit cancellation only from `queued` or `running`. Permit retry only from `failed`, `cancelled`, or `skipped`, create a new run linked to the original, and preserve the original terminal record. Broadcast `workflow:changed` after every successful transition.

- [ ] **Step 6: Refactor SSE into canonical and compatibility paths**

Share ticket issuance, organization binding, `Last-Event-ID` replay, single-use consumption, heartbeat, and `workflow_result` termination between `/workflow-runs/{run_id}/events` and the existing `/workflows/{run_id}/events`. Reject definition IDs passed to run-only endpoints.

- [ ] **Step 7: Run tests and commit**

Run: `cd draftly-agent-backend && uv run pytest tests/api/test_workflow_runs.py tests/api/test_workflows_sse_starlette.py tests/api/test_workflows_stream.py -q`

Expected: PASS.

Commit: `git add src/draftly/app/api/routes/workflow_runs.py src/draftly/app/api/routes/workflows.py src/draftly/app/api/app.py tests/api/test_workflow_runs.py && git commit -m "feat: expose canonical workflow run APIs"`

### Task 6: Add frontend API clients, types, and view models

**Files:**
- Create: `draftly-agent-ui/api/workflows.ts`
- Modify: `draftly-agent-ui/api/observability.ts`
- Create: `draftly-agent-ui/lib/workflow-view-model.ts`
- Create: `draftly-agent-ui/tests/workflow-view-model.test.ts`
- Create: `draftly-agent-ui/tests/workflow-api.test.ts`

**Interfaces:**
- `listWorkflowDefinitions(options) -> Promise<WorkflowListResponse>`.
- `getWorkflowDefinition(workflowId) -> Promise<WorkflowDefinitionDetail>`.
- `createWorkflow(payload)`, `updateWorkflow(workflowId, payload)`, `pauseWorkflow(workflowId)`, `resumeWorkflow(workflowId)`.
- `listWorkflowTemplates()`, `instantiateWorkflowTemplate(templateId, payload)`.
- `listWorkflowRuns(workflowId, options) -> Promise<WorkflowRunListResponse>`.
- `getWorkflowRun(runId) -> Promise<WorkflowRunDetail>`.
- `createWorkflowRun(workflowId, payload, idempotencyKey)`, `cancelWorkflowRun(runId)`, `retryWorkflowRun(runId)`.
- `toWorkflowDefinitionViewModel`, `toWorkflowRunViewModel`, `mergeWorkflowEvents`, `filterWorkflowItems`, and `sortWorkflowItems`.

- [ ] **Step 1: Write failing pure model and URL tests**

Test canonical URL encoding, definition/run response normalization, status tones, stage labels, ISO date formatting, millisecond duration formatting, cursor metadata, filtering, sorting, and duplicate SSE sequence removal.

```ts
test("uses canonical IDs instead of title slugs", () => {
  const item = toWorkflowRunViewModel({ run_id: "evt/42", title: "PR Docs", status: "pending_review" });
  assert.equal(workflowRunHref(item.runId), "/workflows/evt%2F42");
});
```

- [ ] **Step 2: Run frontend tests and verify they fail**

Run: `cd draftly-agent-ui && npm test`

Expected: FAIL because the workflow API and view-model modules do not exist.

- [ ] **Step 3: Define frontend response and request types**

Model definition statuses separately from run statuses. Include nullable fields for optional review/evaluation/artifact records and preserve `next_cursor`, `total`, and `summary`. Use `encodeURIComponent` for every path ID and `URLSearchParams` for every query.

- [ ] **Step 4: Implement API functions through `request()`**

Use `/api/workflows`, `/api/workflow-templates`, and `/api/workflow-runs` paths. Pass the manual-run idempotency key as a request header. Do not duplicate authentication, 401 handling, or base URL logic.

- [ ] **Step 5: Implement the view-model module**

Normalize backend values into display-safe models with explicit fallbacks: `—` for absent timestamps/durations, `Unknown` for absent metadata, `Unavailable` for missing optional records, and no fabricated counts. Keep static stage labels/icon choices in this presentation module only.

- [ ] **Step 6: Run tests and commit**

Run: `cd draftly-agent-ui && npm test`

Expected: PASS.

Commit: `git add api/workflows.ts api/observability.ts lib/workflow-view-model.ts tests/workflow-view-model.test.ts tests/workflow-api.test.ts && git commit -m "feat: add typed workflow API clients and view models"`

### Task 7: Add frontend live-data hooks and definition list/subpages

**Files:**
- Create: `draftly-agent-ui/hooks/use-workflows.ts`
- Create: `draftly-agent-ui/components/sections/workflows/workflows-page.tsx`
- Create: `draftly-agent-ui/components/sections/workflows/workflows-subpage.tsx`
- Modify: `draftly-agent-ui/components/sections/workflows/index.ts`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/active/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/paused/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/drafts/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/templates/page.tsx`

**Interfaces:**
- `useWorkflows(options?) -> { items, summary, total, nextCursor, error, isLoading, isRefreshing, refresh }`.
- `WorkflowsPage` renders live definition data and API-backed summary metrics.
- `WorkflowsSubpage` accepts `kind: "active" | "paused" | "drafts" | "templates"` and uses the corresponding definition/template query.

- [ ] **Step 1: Add hook tests for refresh behavior**

Test the hook’s fetcher contract with mocked `listWorkflowDefinitions`, verify the event types include `workflow:changed`, and verify refresh failures retain the last successful data.

- [ ] **Step 2: Implement `useWorkflows`**

Wrap `listWorkflowDefinitions` with `useLiveRefresh`, use the existing dashboard event provider, and retain a 30-second fallback interval. Memoize query options so filters do not create uncontrolled fetch loops.

- [ ] **Step 3: Implement the main workflows page**

Render API summary values in metric cards. Render definitions with backend name, description, lifecycle status, trigger summary, repository scope, updated time, and run summary. Link with definition IDs, not title slugs. Add search, status/type filters, deterministic client sorting, skeletons, retry state, empty state, and a non-blocking refresh indicator.

- [ ] **Step 4: Implement dynamic status subpages**

Use definition status filters for active, paused, and drafts. Fetch templates from `/api/workflow-templates` for the templates subpage. Render explicit empty states when a category has no records. Keep lifecycle badges separate from run badges.

- [ ] **Step 5: Remove workflow list mock imports**

Remove workflow imports from `lib/mock-data.ts` consumers in the route family. Do not leave static sidebar details, hardcoded metric values, or static template arrays in these components.

- [ ] **Step 6: Run frontend tests and commit**

Run: `cd draftly-agent-ui && npm test && npx tsc --noEmit`

Expected: PASS.

Commit: `git add hooks/use-workflows.ts components/sections/workflows components/sections/workflows/index.ts 'app/(dashboard)/workflows/page.tsx' 'app/(dashboard)/workflows/active/page.tsx' 'app/(dashboard)/workflows/paused/page.tsx' 'app/(dashboard)/workflows/drafts/page.tsx' 'app/(dashboard)/workflows/templates/page.tsx' && git commit -m "feat: render dynamic workflow definitions and subpages"`

### Task 8: Add dynamic workflow detail and configuration actions

**Files:**
- Create: `draftly-agent-ui/hooks/use-workflow-detail.ts`
- Create: `draftly-agent-ui/components/sections/workflows/workflow-detail-page.tsx`
- Create: `draftly-agent-ui/components/sections/workflows/workflow-form.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/[id]/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/new/page.tsx`
- Modify: `draftly-agent-ui/components/sections/workflows/index.ts`

**Interfaces:**
- `useWorkflowDetail(workflowId) -> { definition, recentRuns, error, isLoading, isRefreshing, refresh }`.
- `WorkflowForm` accepts `mode: "create" | "edit"`, optional initial definition, and `onSaved(definition)`.

- [ ] **Step 1: Write view-model tests for detail fields**

Assert that detail cards use trigger, agent, review, delivery, repository, version, timestamps, and status from the API, and render explicit unavailable values when configuration fields are empty.

- [ ] **Step 2: Implement `useWorkflowDetail`**

Fetch the definition detail and recent runs through `useLiveRefresh` with the dashboard workflow event set. Keep the last successful detail visible during refresh and expose retry behavior on initial failure.

- [ ] **Step 3: Implement the definition detail page**

Render the definition name/description, lifecycle status, trigger configuration, conditions, agents, repositories, review policy, evaluation policy, delivery policy, version, and recent canonical runs. Use `/workflows/{workflowId}/runs/{runId}` for run links. Hide configuration sections only when the API marks them unavailable; do not replace them with demo values.

- [ ] **Step 4: Implement pause/resume and edit actions**

Call the backend mutation endpoints, disable controls while pending, show API errors inline, refresh detail/list data after success, and prevent edits to archived definitions. Use accessible confirmation text for lifecycle changes.

- [ ] **Step 5: Implement the shared create/edit form**

Validate required name, slug, workflow key, trigger, and policy fields client-side, submit only typed configuration, surface backend validation errors, preserve server state after save, and support template-instantiated defaults. The new page creates a draft; activation remains an explicit action.

- [ ] **Step 6: Run tests and commit**

Run: `cd draftly-agent-ui && npm test && npx tsc --noEmit`

Expected: PASS.

Commit: `git add hooks/use-workflow-detail.ts components/sections/workflows/workflow-detail-page.tsx components/sections/workflows/workflow-form.tsx components/sections/workflows/index.ts 'app/(dashboard)/workflows/[id]/page.tsx' 'app/(dashboard)/workflows/new/page.tsx' && git commit -m "feat: render workflow detail and configuration actions"`

### Task 9: Add dynamic run detail, persisted steps, and live SSE state

**Files:**
- Create: `draftly-agent-ui/hooks/use-workflow-run.ts`
- Create: `draftly-agent-ui/components/sections/workflows/workflow-run-detail-page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/workflows/[id]/runs/[runId]/page.tsx`
- Modify: `draftly-agent-ui/components/sections/workflows/index.ts`
- Modify: `draftly-agent-ui/tests/workflow-view-model.test.ts`

**Interfaces:**
- `useWorkflowRun(runId) -> { run, steps, events, nodeStates, streamStatus, error, isLoading, isRefreshing, refresh }`.
- `mergePersistedStepsAndEvents(steps, events) -> WorkflowTimelineItem[]`.

- [ ] **Step 1: Write failing timeline merge tests**

Test persisted completed steps plus live events, duplicate sequence numbers, out-of-order replay, node start/stop status, tool progress, terminal workflow results, and missing steps.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd draftly-agent-ui && npm test`

Expected: FAIL because the run hook and merge function do not exist.

- [ ] **Step 3: Implement `useWorkflowRun`**

Fetch `/api/workflow-runs/{runId}` through `useLiveRefresh`. Connect `useWorkflowEvents(runId)` for queued/running/pending-review runs, merge frames by sequence, and stop relying on the legacy `useAgentRuns` hook for this route.

- [ ] **Step 4: Implement the run timeline**

Render actual node/tool names, statuses, durations, timestamps, current stage, error details, and terminal status. Use persisted steps for historical data and live frames for active updates. Display `pending_review`, `cancelled`, `failed`, `skipped`, and `completed` with distinct tones.

- [ ] **Step 5: Implement related-record panels**

Render backend-provided review, evaluation, artifact, input, output, and log records. For absent records, render explicit empty states. Never retain the static PR #142, evaluation score, artifact paths, or hardcoded timestamps.

- [ ] **Step 6: Implement cancel/retry controls**

Show actions only for permitted run states, call the canonical endpoints, refresh after success, and preserve the original run when retry creates a new run ID. Provide an accessible error message for rejected transitions.

- [ ] **Step 7: Run tests and commit**

Run: `cd draftly-agent-ui && npm test && npx tsc --noEmit`

Expected: PASS.

Commit: `git add hooks/use-workflow-run.ts components/sections/workflows/workflow-run-detail-page.tsx components/sections/workflows/index.ts 'app/(dashboard)/workflows/[id]/runs/[runId]/page.tsx' tests/workflow-view-model.test.ts && git commit -m "feat: render dynamic workflow run details"`

### Task 10: Add frontend contract coverage and remove duplicate workflow paths

**Files:**
- Modify: `draftly-agent-ui/api/observability.ts`
- Modify: `draftly-agent-ui/api/runs.ts`
- Modify: `draftly-agent-ui/hooks/use-agent-runs.ts`
- Modify: `draftly-agent-ui/README.md`
- Modify: `draftly-agent-ui/tests/workflow-api.test.ts`

**Interfaces:**
- The workflow route family uses `api/workflows.ts` and canonical run APIs exclusively.
- Existing agent observability consumers retain compatibility through explicit re-exports or unchanged run API types.

- [ ] **Step 1: Write failing import/contract checks**

Assert that workflow pages do not import `lib/mock-data.ts`, workflow links encode IDs, and the old run wrapper is not used by workflow components.

- [ ] **Step 2: Run the checks and verify the current code fails**

Run: `cd draftly-agent-ui && npm test`

Expected: FAIL because legacy workflow imports and route references remain in the current tree.

- [ ] **Step 3: Consolidate workflow API ownership**

Move workflow-specific types/functions out of the generic observability module into `api/workflows.ts`. Keep `api/observability.ts` for generic metrics/reviews/runs used by unrelated pages. Update `api/runs.ts` only where needed to preserve existing agent-run consumers.

- [ ] **Step 4: Update documentation and route inventory**

Document definition routes, template routes, canonical run routes, compatibility aliases, required Clerk/API setup, and the production data requirement. Remove claims that workflow pages are mock-driven.

- [ ] **Step 5: Run tests and commit**

Run: `cd draftly-agent-ui && npm test && npx tsc --noEmit`

Expected: PASS.

Commit: `git add api/observability.ts api/runs.ts hooks/use-agent-runs.ts README.md tests/workflow-api.test.ts && git commit -m "refactor: consolidate workflow API contracts"`

### Task 11: Add operational rollout, migration verification, and end-to-end checks

**Files:**
- Modify: `draftly-agent-backend/scripts/backfill_workflow_resources.py`
- Create: `draftly-agent-backend/tests/api/test_workflow_rollout.py`
- Modify: `draftly-agent-backend/docs/api/routes.md`
- Modify: `draftly-agent-ui/README.md`
- Create: `docs/superpowers/plans/2026-09-10-dynamic-workflow-pages-rollout.md`

**Interfaces:**
- Backfill reports machine-readable counts for definitions, templates, runs, reconciled records, and failures.
- Rollout documentation defines shadow comparison, feature flag, internal-organization enablement, rollback, and deprecation stages.

- [ ] **Step 1: Write rollout and migration verification tests**

Test dry-run does not write, repeated apply is idempotent, failed records are reported without aborting the batch, canonical and compatibility statuses agree after reconciliation, and feature-flag-disabled APIs remain available.

- [ ] **Step 2: Run focused rollout tests and verify they fail**

Run: `cd draftly-agent-backend && uv run pytest tests/api/test_workflow_rollout.py -q`

Expected: FAIL because the backfill counters and shadow-comparison hooks do not exist.

- [ ] **Step 3: Implement migration counters and shadow comparison**

Add structured counters, organization filters, dry-run mode, repeat-safe writes, and comparison output for definition counts, run counts, statuses, current stages, and terminal event presence. Exit non-zero only for configuration/database failures; record individual row failures for operator review.

- [ ] **Step 4: Document the production rollout and rollback**

Document migration order, required indexes, seed/template loading, API compatibility period, feature flag name, internal rollout, divergence thresholds, rollback to old readers, SSE alias lifetime, and deprecation criteria.

- [ ] **Step 5: Run backend verification**

Run: `cd draftly-agent-backend && uv run pytest tests/api tests/persistence tests/workflows -q && make lint && make typecheck`

Expected: PASS with no lint or type errors.

- [ ] **Step 6: Run frontend verification**

Run: `cd draftly-agent-ui && npm test && npm run lint && npx tsc --noEmit && npm run build`

Expected: PASS with no workflow mock imports and a successful production build.

- [ ] **Step 7: Perform authenticated manual smoke verification**

With the backend, Redis, database, Clerk token setup, and frontend API rewrite running:

1. Open `/workflows` in an organization with no definitions and verify the empty state.
2. Instantiate a system template and verify a draft appears only in the current organization.
3. Edit and activate the draft; verify its detail page reflects persisted configuration.
4. Start a manual run with a fixed idempotency key twice; verify exactly one run appears.
5. Open the run detail page while it is active; verify SSE stage updates and reconnect behavior.
6. Refresh after terminal completion; verify persisted steps, status, duration, and related records remain identical.
7. Open the same URLs with a second organization; verify every resource returns `404` or an empty organization-scoped list.
8. Pause the definition and verify a new manual run is rejected while historical runs remain unchanged.

- [ ] **Step 8: Commit rollout documentation**

Commit backend documentation and rollout artifacts in their owning repositories, then commit the root plan/rollout documentation in the docs repository.

## Completion Checklist

- [ ] Canonical definition, template, and run tables exist with constraints and indexes.
- [ ] Backfill/reconciliation is repeat-safe, observable, and tested.
- [ ] Definition and template CRUD/read APIs enforce organization and role boundaries.
- [ ] Run detail/action/SSE APIs expose safe, canonical run data and preserve compatibility aliases.
- [ ] Main workflows page, detail page, run detail page, status subpages, templates, and new/edit flows contain no static runtime data.
- [ ] Loading, refresh, empty, error, terminal, pending-review, cancellation, retry, and unavailable-record states are explicit.
- [ ] Manual runs are idempotent and appear through live refresh without a full page reload.
- [ ] Backend tests, lint, typecheck, frontend tests, lint, typecheck, and production build pass.
- [ ] Authenticated cross-organization and manual smoke checks pass before rollout.
