# Dynamic Workflow Pages Design

**Date:** 2026-09-10

**Status:** Proposed for implementation planning

## Goal

Make the Draftly workflows surface production-backed across the workflows list, workflow detail, workflow run detail, status subpages, templates, and workflow configuration actions. The UI must display organization-scoped persisted data, reconcile runtime state with durable run telemetry, refresh active runs through SSE with polling fallback, and never present fabricated workflow, run, evaluation, artifact, or metric values.

## Product decision

The product has two different concepts that the current prototype conflates:

- A workflow definition is a reusable automation configured by a user. It has a name, status, trigger, conditions, agents, repository scope, evaluation policy, review policy, delivery policy, versions, and optional template origin.
- A workflow run is one execution of a definition in response to a provider event or manual invocation. It has provider metadata, status, stages, steps, timestamps, errors, review state, evaluation state, outputs, and live stream events.

The workflows list and workflow detail routes represent definitions. The nested run route represents one execution. Existing `github_workflows` rows remain provider-specific compatibility/read-model records and must not become the definition table.

## Architecture

Introduce canonical backend resources for definitions, templates, and runs while retaining the existing audit/event infrastructure during migration:

```text
workflow_definitions
  ├── workflow_templates (optional system/user template source)
  └── workflow_runs
        ├── agent_runs / agent_steps (telemetry compatibility and detail)
        ├── workflow_events (durable SSE replay)
        ├── reviews
        ├── evaluations
        └── delivery/content records
```

`workflow_definitions` owns configuration and lifecycle status. `workflow_runs` is the organization-scoped authoritative run read model. Existing provider rows are linked by `run_id` and retain GitHub/Slack/Discord-specific fields. Existing event envelopes and stream-ticket security remain the transport contract for live execution, with a canonical workflow-run route added alongside the current compatibility route.

The frontend uses separate typed view models for `WorkflowDefinition`, `WorkflowRunSummary`, `WorkflowDefinitionDetail`, and `WorkflowRunDetail`. Components receive view models, not database-shaped records or tuple-based mock arrays.

## Backend data model

Add migrations for the following tables.

### `workflow_definitions`

Required fields:

- `id UUID` primary key.
- `org_id TEXT` foreign key to organizations, indexed.
- `slug TEXT` unique within an organization.
- `name TEXT` and nullable `description TEXT`.
- `status TEXT` constrained to `active`, `paused`, `draft`, or `archived`.
- `workflow_key TEXT` identifying the composed runtime workflow, such as `github_pr`, `github_issue`, `slack_support`, or `documentation_sync`.
- `trigger_config JSONB`, `condition_config JSONB`, `agent_config JSONB`, `repository_scope JSONB`, `evaluation_config JSONB`, `review_config JSONB`, and `delivery_config JSONB` with empty-object defaults.
- `version INT` with a positive default and an index on `(org_id, updated_at DESC)`.
- `created_by TEXT`, `created_at`, and `updated_at`.

All configuration JSON must be validated by Pydantic request models before persistence. Secrets and provider access tokens are never stored in these configuration fields.

### `workflow_templates`

Required fields:

- `id UUID` primary key.
- Nullable `org_id` for system templates versus organization-owned templates.
- Unique `slug`, `name`, `description`, `workflow_key`, and validated `defaults JSONB`.
- `is_system BOOLEAN`, `created_at`, and `updated_at`.

System templates are inserted by an idempotent migration/seed operation. User-created templates remain organization-scoped and deletable only by authorized administrators.

### `workflow_runs`

Required fields:

- `id TEXT` primary key and `definition_id UUID` foreign key.
- `org_id TEXT` foreign key to organizations, indexed.
- `source TEXT`, `event_type TEXT`, `source_event_id TEXT`, and nullable provider metadata JSON.
- `title TEXT`, nullable `repository TEXT`, nullable `actor TEXT`, and nullable `target JSONB`.
- `status TEXT` constrained to `queued`, `running`, `pending_review`, `completed`, `failed`, `cancelled`, or `skipped`.
- Nullable `current_stage TEXT`, `stage_states JSONB`, `input JSONB`, `output JSONB`, `error TEXT`.
- `started_at`, nullable `completed_at`, `created_at`, and `updated_at`.
- A unique idempotency constraint on `(org_id, source, source_event_id)` when `source_event_id` is non-null.

Run input/output payloads must be redacted before persistence. Large provider payloads remain in provider-specific storage or object storage; the run record stores only display-safe summaries and references.

Existing `agent_runs` and `agent_steps` remain readable during migration. Every new run writes a `workflow_runs` record and the existing audit rows with the same run ID. A reconciliation job backfills missing canonical rows for historical records and marks irreconcilable records with an explicit `legacy` source.

## API contract

All endpoints use the verified Clerk token and derive `org_id` from the token. Client-supplied organization IDs are ignored. Mutation endpoints require the appropriate organization role.

### Definitions and templates

```text
GET    /api/workflows?status=&workflow_key=&limit=&cursor=
POST   /api/workflows
GET    /api/workflows/{workflow_id}
PATCH  /api/workflows/{workflow_id}
POST   /api/workflows/{workflow_id}/pause
POST   /api/workflows/{workflow_id}/resume
POST   /api/workflows/{workflow_id}/runs
GET    /api/workflows/{workflow_id}/runs?status=&limit=&cursor=

GET    /api/workflow-templates?limit=&cursor=
POST   /api/workflow-templates
GET    /api/workflow-templates/{template_id}
POST   /api/workflow-templates/{template_id}/instantiate
```

`GET /api/workflows` returns `{items, summary, total, next_cursor}`. Summary fields include definition counts by lifecycle status and run aggregates for the requested reporting window. List queries have deterministic ordering and bounded limits.

### Runs and detail

```text
GET    /api/workflow-runs/{run_id}
GET    /api/workflow-runs/{run_id}/steps
GET    /api/workflow-runs/{run_id}/artifacts
GET    /api/workflow-runs/{run_id}/review
GET    /api/workflow-runs/{run_id}/evaluations
POST   /api/workflow-runs/{run_id}/cancel
POST   /api/workflow-runs/{run_id}/retry
POST   /api/workflow-runs/{run_id}/stream-ticket
GET    /api/workflow-runs/{run_id}/events?ticket=...
```

`GET /api/workflows/{workflow_id}` returns the definition plus computed metadata and recent runs. `GET /api/workflow-runs/{run_id}` returns the definition summary, run metadata, stage state, safe input/output summaries, review/evaluation/artifact references, and ordered steps. Missing optional records are represented as `null` or empty arrays, never demo values.

The current `/api/workflows/{run_id}/stream-ticket` and `/api/workflows/{run_id}/events` routes remain as compatibility aliases during rollout. They must enforce that the path ID is a run ID, not a definition ID, and must use the same single-use ticket and organization binding as the canonical run routes.

### Manual run and idempotency

`POST /api/workflows/{workflow_id}/runs` accepts a validated trigger payload and an `Idempotency-Key` header. It verifies that the definition is active, the caller can run it, and the requested repositories/integrations belong to the organization. It returns `202` with `{run_id, status, stream_ticket}`. Duplicate idempotency keys return the original run without starting a second execution.

## Frontend data flow

The Next.js route files remain thin. Client data containers use `request()` from `api/client.ts`, `useLiveRefresh()` for list/detail refresh, and `useWorkflowEvents()` for active run streams.

```text
/workflows
  useWorkflows → GET /api/workflows
              → dashboard workflow:changed event
              → 30-second polling fallback

/workflows/{workflowId}
  useWorkflowDetail → GET /api/workflows/{workflowId}
  useWorkflowRuns   → GET /api/workflows/{workflowId}/runs

/workflows/{workflowId}/runs/{runId}
  useWorkflowRun    → GET /api/workflow-runs/{runId}
  useWorkflowEvents → stream-ticket → SSE replay/live events
```

The frontend must use canonical IDs in links and API paths. Names and slugs are display/configuration fields only. Runtime status, stage states, timestamps, durations, and counters are normalized in one workflow view-model module.

## Component boundaries

Create focused workflow components under `draftly-agent-ui/components/sections/workflows/`:

- `workflows-page.tsx`: definition list, summary metrics, search/filter/sort, loading/error/empty states.
- `workflow-detail-page.tsx`: definition header, lifecycle controls, configuration summary, recent runs, and navigation to run details.
- `workflow-run-detail-page.tsx`: run header, live stage/timeline, step details, review/evaluation/artifact sections, cancellation/retry actions.
- `workflows-subpage.tsx`: active, paused, drafts, and templates views backed by the corresponding APIs.
- `workflow-view-model.ts`: response types, status/tone mappings, relative-time/duration formatting, stage labels, and safe fallbacks.
- `workflow-form.tsx`: shared create/edit validation and submit state for the new workflow route and edit action.

No workflow route or workflow component may import `lib/mock-data.ts` after migration. Static stage labels and icon mappings are presentation metadata and may remain in a dedicated workflow module; runtime values always come from the API or SSE event payload.

## Loading, error, and consistency behavior

- Initial requests render skeleton rows/cards without replacing existing data during refresh.
- A failed first request renders a retry action and an actionable API error; a failed refresh keeps the last successful data and shows a non-blocking refresh warning.
- Empty definitions, empty runs, absent artifacts, absent evaluations, and absent reviews each have explicit empty-state copy.
- Terminal runs stop the SSE connection on `workflow_result`; reconnects use a fresh single-use ticket and `Last-Event-ID` resume.
- The UI merges persisted steps with live events by sequence number and removes duplicate events.
- Status transitions use one normalized enum. `pending_review` is distinct from `paused`; a definition lifecycle status is never inferred from a run status.
- Dates and durations are formatted from ISO timestamps or milliseconds in the user’s locale. Backend-formatted strings are treated as fallback display values only.

## Security and operational requirements

- Every read and mutation checks organization ownership in the query or service layer.
- Definition mutations require admin/editor permissions; pause/resume/run/cancel/retry permissions are explicit and tested.
- Cursor pagination, maximum page sizes, bounded summary windows, and query indexes are mandatory for list endpoints.
- Request payloads and persisted run input/output are schema-validated and redacted.
- Run creation is idempotent and provider webhook processing remains idempotent.
- Backend logs include organization-safe request/run identifiers but never model credentials, access tokens, or raw sensitive payloads.
- Metrics cover endpoint latency, list query duration, stream-ticket failures, active runs, stale runs, terminal status counts, and definition mutation errors.
- Status reconciliation continues to align provider read models, jobs, canonical runs, and terminal workflow events after worker failures.

## Migration and rollout

1. Add tables, constraints, indexes, repository methods, and API contract tests without changing existing routes.
2. Backfill canonical definitions for configured system workflows and canonical runs for historical provider/audit rows. Record a migration version and expose counts for failed backfills.
3. Add the canonical APIs and compatibility aliases. Run both old and new read models in shadow comparison for representative organizations.
4. Wire the frontend to canonical definitions/runs behind a configuration flag, then enable it for internal organizations.
5. Compare list/detail counts, statuses, and terminal states between old and new read paths. Remove the flag only after the comparison has no unexplained divergence.
6. Deprecate the old run-shaped `GET /api/workflows` response after all clients use definition and run resources. Keep the SSE compatibility aliases until the next API deprecation window.

## Testing and acceptance criteria

Backend tests must cover migrations, repository queries, organization isolation, role checks, schema validation, cursor bounds, summary correctness, idempotent manual runs, run/detail aggregation, redaction, compatibility aliases, SSE tickets, and terminal/reconnect behavior.

Frontend tests must cover view-model normalization, lifecycle/status filtering, pagination, search, stage merging, live-event deduplication, loading/error/empty rendering decisions, and canonical URL construction. The workflow route family must have no imports from `lib/mock-data.ts`.

Acceptance requires:

- A new organization with no workflows sees truthful empty states and can create a workflow from a template.
- A configured organization sees only its own definitions, runs, metrics, reviews, evaluations, and artifacts.
- A manual run creates exactly one durable run for one idempotency key and appears in the list without a page reload.
- Active runs update stage/timeline state through SSE and recover after refresh or reconnect.
- Completed, failed, pending-review, cancelled, and skipped runs display distinct truthful states.
- Definition pause/resume changes future execution eligibility without rewriting historical run status.
- `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, and the targeted/full backend test suite pass before rollout.
