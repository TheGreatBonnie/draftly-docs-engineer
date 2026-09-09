# Dynamic Overview Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded overview data in `draftly-agent-ui` with an authenticated, organization-scoped overview snapshot assembled by `draftly-agent-backend`, while preserving the existing Clerk greeting, layout, navigation, and range selector.

**Architecture:** `draftly-agent-backend` exposes one read-optimized `GET /api/overview` endpoint backed by a service that aggregates existing organization-scoped repositories into a stable response contract. `draftly-agent-ui` fetches that contract through its authenticated API client; `OverviewPage` owns range and request state, and presentational cards receive typed props. A live-events provider invalidates the overview after relevant dashboard events while polling remains the fallback.

**Tech Stack:** Backend Python/FastAPI with Clerk JWT authentication and existing repositories; frontend Next.js 16, React 19, TypeScript, Clerk, existing `api/client.ts`, SSE, and interval refresh; backend route/service tests plus frontend Node helper tests.

**Spec:** Approved brainstorming design documented in this file under `## Spec`.

## Global Constraints

- Preserve organization isolation at every repository call and never trust an organization identifier from query parameters or request JSON.
- Reuse existing repository methods and route helpers where possible; do not add a second persistence model or a frontend mock data layer.
- Keep `/api/health` and existing dashboard routes behavior-compatible.
- Do not introduce a new runtime dependency for data fetching or charting.
- Do not change the visual layout or navigation hierarchy except where loading/error states are required.

---

## Spec

### Backend endpoint

Add an authenticated endpoint:

```text
GET /api/overview?days=1|7|14|30
Authorization: Bearer <Clerk token>
```

`days` defaults to `14` and must be one of `1`, `7`, `14`, or `30`; invalid values return HTTP 422 through FastAPI validation. The endpoint must use `org_id` from `get_verified_token`, never a client-supplied organization ID.

Return this JSON shape:

```ts
type OverviewSnapshot = {
  summary: {
    documentation_total: number;
    active_workflows: number;
    running_workflows: number;
    scheduled_workflows: number;
    pending_reviews: number;
    average_evaluation_score: number | null;
  };
  attention: {
    pending_reviews: number;
    high_risk_reviews: number;
    failed_evaluations: number;
    integration_issues: number;
    stale_documentation: number;
  };
  system: {
    agents_online: number;
    agents_total: number;
    data_sources_connected: number;
    data_sources_total: number;
    evaluations_status: "Running" | "Idle" | "Failed" | "Unknown";
    scheduler_status: "Healthy" | "Idle" | "Unavailable";
  };
  recent_changes: Array<{
    id: string;
    title: string;
    detail: string;
    timestamp: string | null;
    status: string;
    href: string;
  }>;
  active_workflows: Array<{
    id: string;
    name: string;
    repository: string;
    status: string;
    timestamp: string | null;
    href: string;
  }>;
  evaluation: {
    average_score: number | null;
    trend: number | null;
    dimensions: Array<{
      name: string;
      value: number;
    }>;
  };
  activity: Array<{
    date: string;
    created: number;
    updated: number;
    reviewed: number;
    published: number;
  }>;
};
```

All timestamps are UTC ISO-8601 strings. Empty datasets use zero counts, empty arrays, and `null` scores/trends rather than fabricated values.

Aggregation rules:

- Documentation comes from `DocumentRepository.list_by_org(org_id, limit=1000)`. `documentation_total` is the number of returned organization records. Stale documentation is the count of records with `stale == true`; status conversion must reuse the existing `derive_status` logic. Recent changes are the five most recently updated records, with `href` set to `/documentation/{document_id}`.
- Workflows come from `list_github_workflows_record(org_id, db)`. Normalize status case-insensitively. `running` is `running` or `started`; `scheduled` is `scheduled`, `queued`, or `pending`; `active_workflows` is running plus scheduled; terminal statuses are excluded. Return at most five active workflows, ordered by newest timestamp.
- Pending reviews come from `ReviewsRepository.list_reviews(status="pending", org_id=org_id, limit=200)`. High-risk reviews are pending records whose detail has `risk` equal to `high` or `critical`, or whose structured evaluation score is below `80` after percentage normalization. Records without either signal are not high risk.
- Evaluations come from `EvaluationRepository.search(org_id, evaluation_type=None, limit=100)`. Normalize scores in the inclusive range `0..1` to percentages by multiplying by 100; leave percentage scores unchanged; clamp final values to `0..100`. `average_score` is the mean of scored records. `trend` compares the latest half of scored records with the previous half and is `null` when fewer than two scored records exist. Dimensions are grouped from `metrics.granular[*].metric` and averaged using the same score normalization. Failed evaluations count records whose normalized status is `failed`.
- Integration health is collected through existing organization-scoped GitHub installations, Slack installations, and Discord status helpers. There are three possible data sources. Each successful connected source increments `data_sources_connected`; a failed, disconnected, or unavailable source increments `integration_issues`. One integration failure must not fail the entire overview response.
- `agents_total` is the length of the existing agent catalog. Reuse the existing agent status-building helper used by `GET /api/agents`; `agents_online` counts catalog entries whose current status is not `failed`. If agent telemetry is unavailable, return the catalog count for both values and keep the endpoint usable.
- Scheduler status is `Healthy` when the organization-scoped active-job query succeeds, `Idle` when it succeeds with no active jobs, and `Unavailable` when the query fails. Update the jobs repository query to accept an optional `org_id` and filter by it so the overview cannot expose another organization’s active jobs. Existing callers without an organization filter must retain their current behavior.
- Evaluation status is `Running` if any recent evaluation is running or queued, `Failed` if the newest evaluation is failed and none are running, `Idle` if there are evaluation records but none are active, and `Unknown` when no records exist.
- Activity is bucketed by UTC calendar day for the requested number of days, oldest first. Documentation `created_at` events increment `created`; later `updated_at` events increment `updated`; review records with a decision/completion timestamp increment `reviewed`; documentation records whose derived status is `published` increment `published` on their update day. Always return one zero-filled point per day so the chart has stable x-axis spacing.

### Frontend behavior

- Add a typed overview API module and hook. The hook maps `ChartRange` to `days`, requests `/overview?days={days}` with `apiFetch`, refreshes when the range changes, and exposes `{ data, error, isLoading, isRefreshing, refresh }`.
- Add a live-events context/provider compatible with `useLiveRefresh`. Subscribe to the existing dashboard SSE stream for `workflow_changed`, `review_changed`, `documentation_changed`, and `evaluation_changed`; increment a version when one arrives. Wrap the authenticated dashboard layout with the provider. Keep the existing 30-second polling fallback and retain the last successful snapshot when a refresh fails.
- `OverviewPage` maps the selected range to the hook, displays a layout-preserving skeleton before the first response, shows a non-blocking error state with a retry action after a failed initial request, and passes the snapshot to every dynamic card.
- Convert `WorkspaceSummary`, `AttentionPanel`, `SystemPulse`, `RecentChanges`, `EvaluationResults`, `ActiveWorkflows`, and `ActivityChart` from imports of `components/overview/data.ts` to typed props. `IntegrationPromo` remains static because it is a call-to-action rather than a backend metric.
- Keep the existing Clerk greeting (`user?.firstName || "there"`) and page actions unchanged.
- Format timestamps and score/trend values in the frontend. A missing score renders `—`; a missing trend renders no trend badge. Preserve existing route targets and use the backend `href` for recent changes/workflows.
- Remove `components/overview/data.ts` only after all imports are gone. Do not leave fallback fake business data in the production components.

## File Structure

Expected files to add or change:

```text
draftly-agent-backend/src/draftly/app/api/app.py
draftly-agent-backend/src/draftly/app/api/routes/__init__.py
draftly-agent-backend/src/draftly/app/api/routes/overview.py                 (new)
draftly-agent-backend/src/draftly/app/services/overview.py                   (new)
draftly-agent-backend/src/draftly/app/api/routes/agents.py
draftly-agent-backend/src/draftly/persistence/repositories/jobs.py
draftly-agent-backend/src/draftly/integrations/database/jobs_store.py
draftly-agent-backend/src/draftly/app/api/routes/observability.py
draftly-agent-backend/tests/api/test_overview_routes.py                      (new)
draftly-agent-backend/tests/unit/app/test_overview_service.py                (new)
draftly-agent-backend/tests/api/test_observability_routes.py

draftly-agent-ui/api/overview.ts                                             (new)
draftly-agent-ui/hooks/use-overview.ts                                       (new)
draftly-agent-ui/hooks/use-live-refresh.ts
draftly-agent-ui/components/live-events/live-events-provider.tsx             (new)
draftly-agent-ui/app/(dashboard)/layout.tsx
draftly-agent-ui/components/overview/overview-page.tsx
draftly-agent-ui/components/overview/overview-cards.tsx
draftly-agent-ui/components/overview/attention-panel.tsx
draftly-agent-ui/components/overview/activity-chart.tsx
draftly-agent-ui/components/overview/data.ts                               (delete)
draftly-agent-ui/lib/overview.ts                                             (new; pure format/range helpers)
draftly-agent-ui/lib/overview.test.ts                                        (new)
```

## Implementation Tasks

### Task 1: Establish the backend overview contract and route

**Files:**

- Create: `draftly-agent-backend/src/draftly/app/api/routes/overview.py`
- Create: `draftly-agent-backend/src/draftly/app/services/overview.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/__init__.py`

**Interfaces:**

- Consumes: `get_verified_token`, the application repository/database container, and the repository/helper interfaces listed in the Spec.
- Produces: `GET /api/overview?days=...` and `build_overview_snapshot(application, org_id: str, days: int) -> dict[str, Any]`, returning the `OverviewSnapshot` shape.

Implementation shape:

```python
@router.get("", response_model=OverviewResponse)
async def get_overview(
    request: Request,
    days: Literal[1, 7, 14, 30] = 14,
    token: dict[str, Any] = Depends(get_verified_token),
) -> OverviewResponse:
    application = request.app.state.draftly
    return await build_overview_snapshot(application, token["org_id"], days)
```

The service should expose small pure helpers for score normalization, status classification, risk detection, and day-bucket construction; the route should contain no aggregation logic.

- [ ] Add `OverviewSnapshot`-equivalent Pydantic response models in `draftly-agent-backend/src/draftly/app/api/routes/overview.py`, including constrained `days` validation and nullable score fields.
- [ ] Add `draftly-agent-backend/src/draftly/app/services/overview.py` with `async def build_overview_snapshot(application, org_id: str, days: int) -> dict[str, Any]`. Keep aggregation and normalization helpers private and deterministic so they can be unit-tested without starting FastAPI.
- [ ] Implement the aggregation rules in the Spec, including UTC zero-filled activity buckets, score normalization, high-risk review detection, status normalization, and per-integration failure isolation.
- [ ] Add `router = APIRouter(prefix="/overview", tags=["overview"], dependencies=[Depends(get_verified_token)])` and a `GET /` handler that passes the verified token’s `org_id` and the application database/repository container to `build_overview_snapshot`.
- [ ] Register the router in `draftly-agent-backend/src/draftly/app/api/app.py` under the existing `/api` prefix and export it from `draftly-agent-backend/src/draftly/app/api/routes/__init__.py`.

### Task 2: Make shared backend sources organization-safe and reusable

**Files:**

- Modify: `draftly-agent-backend/src/draftly/app/api/routes/agents.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/jobs.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/jobs_store.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/observability.py`

**Interfaces:**

- Consumes: existing agent catalog/telemetry, job repository calls, and organization IDs extracted from Clerk tokens.
- Produces: a reusable agent-summary helper and `list_active(org_id: str | None = None)` behavior with organization filtering when an ID is provided.

Implementation shape:

```python
async def list_active(self, org_id: str | None = None) -> list[dict[str, Any]]:
    if org_id is None:
        return await self._store.list_active()
    return await self._store.list_active(org_id=org_id)
```

The SQL store must bind `org_id` as a query parameter and keep the existing no-argument query path for non-user-scoped workers.

- [ ] Extract the agent-summary construction currently embedded in `draftly-agent-backend/src/draftly/app/api/routes/agents.py` into a reusable public helper, preserving the existing `/api/agents` response exactly; call the helper from both the agents route and overview service.
- [ ] Change `DatabaseJobsStore.list_active` and `JobRepositoryImpl.list_active` in the jobs persistence modules to accept `org_id: str | None = None`. Add `AND org_id = $1` when the value is supplied and preserve the unfiltered query for existing internal callers.
- [ ] Update `draftly-agent-backend/src/draftly/app/api/routes/observability.py` to pass the verified organization ID to the active-job repository call where the route is user-facing.
- [ ] Add narrowly scoped adapters in the overview service for GitHub, Slack, and Discord installation/status reads. Catch exceptions per adapter, mark only that source unavailable, and include the count in `integration_issues`.

### Task 3: Add backend contract and aggregation tests

**Files:**

- Create: `draftly-agent-backend/tests/unit/app/test_overview_service.py`
- Create: `draftly-agent-backend/tests/api/test_overview_routes.py`
- Modify: `draftly-agent-backend/tests/api/test_observability_routes.py`
- Modify: `draftly-agent-backend/tests/unit/persistence/test_jobs_store_sql.py`

**Interfaces:**

- Consumes: the service function, `GET /api/overview`, and the organization-filtered jobs method from Tasks 1–2.
- Produces: regression coverage for the response contract, aggregation rules, authentication scoping, partial integration failures, and job isolation.

Test shape:

```python
async def test_overview_is_scoped_to_verified_org(app, client, token_for_org_a):
    response = await client.get(
        "/api/overview?days=14",
        headers={"Authorization": f"Bearer {token_for_org_a}"},
    )
    assert response.status_code == 200
    assert response.json()["summary"]["documentation_total"] == 1
```

Use the existing test dependency overrides and fake repositories rather than a live database or external integration credentials.

- [ ] Add `draftly-agent-backend/tests/unit/app/test_overview_service.py` with fixtures for empty organization data, mixed document statuses, active/terminal workflows, pending/high-risk reviews, `0..1` and percentage evaluation scores, granular metrics, activity bucketing, and one failing integration adapter.
- [ ] Add `draftly-agent-backend/tests/api/test_overview_routes.py` using the repository’s existing authenticated route fixture. Verify the bearer token’s `org_id` is used, `days` accepts only `1/7/14/30`, the exact response keys are returned, and an empty organization never receives another organization’s data.
- [ ] Extend the existing observability/jobs tests to verify `list_active(org_id="org-a")` excludes jobs owned by `org-b` while the legacy unfiltered call remains compatible.

### Task 4: Add the typed frontend API and live-refresh plumbing

**Files:**

- Create: `draftly-agent-ui/api/overview.ts`
- Create: `draftly-agent-ui/hooks/use-overview.ts`
- Create: `draftly-agent-ui/components/live-events/live-events-provider.tsx`
- Modify: `draftly-agent-ui/hooks/use-live-refresh.ts`
- Modify: `draftly-agent-ui/app/(dashboard)/layout.tsx`

**Interfaces:**

- Consumes: `apiFetch`, `ChartRange`, `use-dashboard-events.ts`, and the backend `OverviewSnapshot` response.
- Produces: `OverviewDays`, `OverviewSnapshot`, `getOverview(days: OverviewDays)`, `useOverview(range: ChartRange)`, and `useLiveEventVersion()`.

Implementation shape:

```ts
export type OverviewDays = 1 | 7 | 14 | 30;

export async function getOverview(days: OverviewDays) {
  return apiFetch<OverviewSnapshot>(`/overview?days=${days}`);
}

export function useOverview(range: ChartRange) {
  const days = rangeToDays(range);
  return useLiveRefresh(() => getOverview(days), OVERVIEW_EVENTS, 30_000);
}
```

The provider owns only the SSE version counter; it must not own overview data or duplicate Clerk token management.

- [ ] Add `draftly-agent-ui/api/overview.ts` containing the TypeScript interfaces matching the backend response and `getOverview(days: OverviewDays): Promise<OverviewSnapshot>`. Use `apiFetch` so Clerk’s bearer token and 401 handling remain centralized.
- [ ] Add `draftly-agent-ui/components/live-events/live-events-provider.tsx` with a context that exposes the current event version and `useLiveEventVersion()`. Connect it to the existing dashboard ticket/SSE flow used by `use-dashboard-events.ts`; close the stream on unmount and tolerate ticket/SSE errors.
- [ ] Wrap the authenticated shell in `draftly-agent-ui/app/(dashboard)/layout.tsx` with the provider without moving `auth.protect()` or changing the Clerk token setter.
- [ ] Update `draftly-agent-ui/hooks/use-live-refresh.ts` to import the provider from its new location, accept the overview event names, refresh on event-version changes, and keep interval polling as a fallback.
- [ ] Add `draftly-agent-ui/hooks/use-overview.ts` with `useOverview(range: ChartRange)`. Map `Today`, `Last 7 days`, `Last 14 days`, and `Last 30 days` to `1`, `7`, `14`, and `30`; request the snapshot on mount/range change; preserve the last snapshot during background refresh; and expose retryable errors.

### Task 5: Convert overview components to dynamic props

**Files:**

- Create: `draftly-agent-ui/lib/overview.ts`
- Modify: `draftly-agent-ui/components/overview/overview-page.tsx`
- Modify: `draftly-agent-ui/components/overview/overview-cards.tsx`
- Modify: `draftly-agent-ui/components/overview/attention-panel.tsx`
- Modify: `draftly-agent-ui/components/overview/activity-chart.tsx`
- Delete: `draftly-agent-ui/components/overview/data.ts`

**Interfaces:**

- Consumes: `OverviewSnapshot` from `api/overview.ts`, `useOverview`, and the existing card/layout primitives.
- Produces: prop-driven overview components and pure formatting/range helpers with no hardcoded business data imports.

Component shape:

```tsx
export function WorkspaceSummary({ summary }: { summary: OverviewSnapshot["summary"] }) {
  // Render summary.documentation_total, summary.active_workflows, and the other
  // response values using the existing MetricCard layout.
}

export function ActivityChart({
  activity,
  range,
  onRangeChange,
}: ActivityChartProps) {
  // Render activity directly; do not import chartDataForRange or overview/data.
}
```

- [ ] Add `draftly-agent-ui/lib/overview.ts` with pure helpers for range-to-days conversion, percentage formatting, trend formatting, timestamp-to-relative-time formatting, backend status-to-card-tone mapping, and activity label formatting.
- [ ] Refactor `draftly-agent-ui/components/overview/overview-page.tsx` to call `useOverview`, remove local fake-data dependencies, pass each response section to its card, and add loading/error rendering that keeps the existing responsive grid.
- [ ] Refactor `draftly-agent-ui/components/overview/overview-cards.tsx` so `WorkspaceSummary`, `SystemPulse`, `RecentChanges`, `EvaluationResults`, and `ActiveWorkflows` accept the typed response sections. Preserve existing icons and layout, but derive values, statuses, links, and trend badges from props.
- [ ] Refactor `draftly-agent-ui/components/overview/attention-panel.tsx` to accept `OverviewAttention`, derive item values from backend data, and keep the existing empty-state behavior when all counts are zero.
- [ ] Refactor `draftly-agent-ui/components/overview/activity-chart.tsx` to accept backend `activity` points and the selected range instead of calling `chartDataForRange` from `lib/dashboard-state`. Use the backend’s date labels and zero-filled points; retain the existing range menu and chart legend.
- [ ] Delete `draftly-agent-ui/components/overview/data.ts` after `rg` confirms there are no imports or references. Keep `IntegrationPromo` static and do not use it as a source for dashboard metrics.

### Task 6: Add frontend helper tests and perform focused verification

**Files:**

- Create: `draftly-agent-ui/lib/overview.test.ts`
- Verify: all files changed by Tasks 1–5, plus the graphify output after implementation.

**Interfaces:**

- Consumes: the pure helpers from `lib/overview.ts` and the route/component wiring from the earlier tasks.
- Produces: executable frontend helper coverage and documented verification evidence for the implementation.

Verification commands:

```bash
cd draftly-agent-backend && make test && make lint && make typecheck
cd ../draftly-agent-ui && pnpm test && pnpm exec tsc --noEmit && pnpm build
```

- [ ] Add `draftly-agent-ui/lib/overview.test.ts` using the existing Node test setup. Cover all four range mappings, null score/trend formatting, relative timestamps, status tone mapping, and zero-filled activity labels.
- [ ] Run `make test` from `draftly-agent-backend` (equivalent to `uv run pytest -q`), then run `make lint` and `make typecheck` for the changed backend modules.
- [ ] Run `pnpm test` from `draftly-agent-ui`, then run `pnpm exec tsc --noEmit` and `pnpm build` to catch incorrect props, missing imports, and provider wiring.
- [ ] Inspect the final diff for accidental hardcoded business values, confirm the dashboard layout still has `AuthTokenSetter` and `auth.protect()`, and verify the backend route is registered exactly once.
- [ ] Run `graphify update .` from the workspace root after implementation changes so the repository knowledge graph reflects the new route, service, hooks, and component relationships.

## Acceptance Criteria

- Authenticated users see organization-specific overview counts and lists from the backend; two organizations cannot see each other’s documents, reviews, workflows, evaluations, or active jobs.
- Changing the range updates the activity request and chart without changing the page layout.
- A relevant dashboard event refreshes the snapshot, and the page still updates within the polling interval when SSE is unavailable.
- Initial loading and refresh failures are visible but do not replace a previously successful snapshot with fake data.
- No production overview component imports the deleted hardcoded data module.
- The existing Clerk greeting, sidebar/navbar identity display, dashboard protection, and navigation links remain intact.
- Backend and frontend verification commands complete successfully with the new contract covered by tests.
