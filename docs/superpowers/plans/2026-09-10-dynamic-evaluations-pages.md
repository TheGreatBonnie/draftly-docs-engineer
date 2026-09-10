# Dynamic Evaluations Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static evaluation overview, run detail, test-case detail, datasets, evaluators, and trends screens in `draftly-agent-ui` with authenticated, organization-scoped data from `draftly-agent-backend`, including live run refresh and production-safe loading, error, pagination, and authorization behavior.

**Architecture:** Keep evaluation summary rows in `evaluations` for list and aggregate reads, and add an append-only `evaluation_case_results` table for detailed case/metric results, expected/actual output, evidence, and trace references. Expose a dedicated typed evaluations API, then consume it through focused UI hooks and the existing dashboard SSE version/fallback-refresh mechanism. The current `metrics.granular` JSONB remains readable for compatibility while new detail reads use child result records.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, CockroachDB migrations, async repositories, Redis Streams/SSE, Next.js 16 App Router, React 19, TypeScript, Tailwind CSS, Clerk authentication, Node test runner, Vitest, Testing Library, jsdom, and Playwright for the final browser flow.

**Spec:** User-approved dynamic evaluations design from the preceding conversation; supporting references are `docs/superpowers/plans/2026-09-02-evaluation-persistence-and-sse-live-lists.md`, `draftly-agent-backend/src/draftly/app/api/routes/evaluations.py`, and `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`.

## Global Constraints

- Evaluation scores use one canonical scale: `0` through `100` everywhere in API responses, TypeScript types, persistence, and rendered progress bars.
- Canonical evaluation statuses are lowercase `queued`, `running`, `passed`, `failed`, `cancelled`, and `skipped`; the UI maps them to display labels and badge tones.
- Every backend read and write is scoped by the verified Clerk `org_id`; detail reads return `404` for another organization’s records.
- UI API calls use `draftly-agent-ui/api/client.ts`, which attaches the Clerk token and handles expired sessions.
- The UI must not call the browser-oriented API client from a Server Component; route files remain thin wrappers and dynamic data is loaded by client page controllers.
- Preserve `workflow:changed` and `evaluation:created` as the only dashboard event names used for evaluation refresh.
- `GET /api/evaluations` returns summary rows only; detailed case output and evidence are fetched by run detail endpoints.
- Do not expose provider credentials, authorization headers, unrestricted prompts, private model reasoning, or unbounded raw tool payloads.
- Use cursor pagination for list/detail collections and enforce backend maximum page sizes.
- Remove only evaluation-related entries from `draftly-agent-ui/lib/mock-data.ts`.
- Every application-code task starts with a failing test and ends with focused tests, type checking, and a commit in the repository that owns the changed files.
- After all application changes, run `graphify update .` from `/Applications/Projects/hackathon/draftly-docs-engineer` before final verification.

## File Structure

### Backend (`draftly-agent-backend/`)

- Create `src/draftly/app/api/evaluation_schemas.py` for typed request/response models.
- Create `src/draftly/persistence/migrations/055_evaluation_case_results.sql` for detailed case results.
- Modify `src/draftly/persistence/repositories/evaluations.py` for run lookup, cursor list, detail, aggregates, catalog, and child-result persistence.
- Modify `src/draftly/integrations/database/evaluations_store.py` for detailed result queries and organization predicates.
- Modify `src/draftly/evaluation/runner.py` and `src/draftly/evaluation/online.py` for normalized safe detail rows.
- Modify `src/draftly/app/api/routes/evaluations.py` for list, detail, catalog, summary, cases, and run submission.
- Modify `src/draftly/workflows/evaluation/documentation_evaluation.py` for child-result persistence and idempotent event lifecycle.
- Create `src/draftly/integrations/database/evaluation_idempotency_store.py` for organization/key request deduplication.
- Create `src/draftly/persistence/migrations/056_evaluation_idempotency.sql` for idempotency records.
- Create or modify tests under `tests/api/`, `tests/evaluation/`, `tests/persistence/`, and `tests/workflows/` for the contracts above.

### UI (`draftly-agent-ui/`)

- Create `api/evaluations.ts` for canonical TypeScript types and request wrappers.
- Create `hooks/use-evaluations.ts`, `use-evaluation-summary.ts`, `use-evaluation-detail.ts`, and `use-evaluation-catalog.ts`.
- Create `lib/evaluation-view-model.ts` for pure status, score, date, duration, and row mapping functions.
- Create focused components under `components/sections/evaluations/` for the overview, cards, trend, metric breakdown, run table, run detail, case table, case detail, and subpages.
- Modify evaluation route wrappers and `components/sections/evaluations/index.ts`.
- Remove evaluation-only constants from `lib/mock-data.ts` after all imports are gone.
- Create API, view-model, and component tests under `tests/` and `components/sections/evaluations/__tests__/`.
- Modify `package.json`, `pnpm-lock.yaml`, and `package-lock.json`; create `vitest.config.mts` and `tests/setup.ts` for React component tests; keep the existing Node test runner for pure API/view-model tests.

---

### Task 1: Define the canonical evaluation API contract

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/evaluation_schemas.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/evaluations.py`
- Create: `draftly-agent-backend/tests/api/test_evaluation_schemas.py`

**Interfaces:**
- Produce `EvaluationRunSummary`, `EvaluationCaseResult`, `EvaluationRunDetail`, `EvaluationAggregateSummary`, `EvaluationCatalog`, `EvaluationDataset`, `EvaluationEvaluator`, `EvaluationRunRequest`, and `CursorPage` Pydantic models.
- `EvaluationRunSummary` fields: `id`, `run_id`, `name`, `evaluation_type`, `datasets`, `cases`, `passed`, `failed`, `score`, `status`, `started_at`, `completed_at`, `duration_ms`.
- `EvaluationCaseResult` fields: `id`, `run_id`, `evaluation_id`, `dataset`, `case_id`, `metric`, `threshold`, `score`, `passed`, `reason`, `input`, `expected_output`, `actual_output`, `evidence`, `trace_id`, `duration_ms`.
- `EvaluationAggregateSummary` fields: `window_days`, `average_score`, `total_runs`, `passed_runs`, `failed_runs`, `total_cases`, `pass_rate`, `trend`, and `by_metric`.
- `EvaluationRunRequest` fields: `datasets: list[str] | None`, `live: bool`, and `profile: str | None`.

- [ ] **Step 1: Write failing schema tests.**

Assert that scores accept `0`–`100` and reject values outside that range, statuses reject unknown values, timestamps serialize as ISO-8601 strings, optional output/evidence fields accept `null`, and request models reject unknown fields.

- [ ] **Step 2: Run the focused tests and verify failure.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_evaluation_schemas.py -q
```

Expected: FAIL because the dedicated evaluation schemas do not exist.

- [ ] **Step 3: Implement the Pydantic models.**

Use constrained numeric fields for scores and explicit `Literal` status values. Set `extra="forbid"` on request models and bounded dictionaries/lists on JSON response fields.

- [ ] **Step 4: Run schema tests and lint.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_evaluation_schemas.py -q
uv run ruff check src/draftly/app/api/evaluation_schemas.py src/draftly/app/api/routes/evaluations.py
```

Expected: PASS.

- [ ] **Step 5: Commit the contract.**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/evaluation_schemas.py src/draftly/app/api/routes/evaluations.py tests/api/test_evaluation_schemas.py
git commit -m "feat: define evaluation API contract"
```

### Task 2: Persist detailed case and metric results

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/055_evaluation_case_results.sql`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/evaluations_store.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/evaluations.py`
- Create: `draftly-agent-backend/tests/evaluation/test_evaluation_detail_persistence.py`
- Create: `draftly-agent-backend/tests/persistence/test_evaluation_case_results_migration.py`

**Interfaces:**
- Produce `EvaluationRepository.save_case_results(*, org_id, evaluation_id, run_id, results) -> list[dict[str, Any]]`.
- Produce `EvaluationRepository.get_by_run_id(*, org_id, run_id) -> dict[str, Any] | None`.
- Produce `EvaluationRepository.list_case_results(*, org_id, run_id, cursor, limit) -> tuple[list[dict[str, Any]], str | None]`.
- Each result contains dataset, case ID, metric, threshold, score, pass state, reason, input, expected output, actual output, evidence, trace ID, and duration.

- [ ] **Step 1: Write migration and repository contract tests first.**

Test that the migration is additive, creates `evaluation_case_results`, adds uniqueness on `(evaluation_id, dataset, case_id, metric)`, creates indexes for `(org_id, run_id)` and `(org_id, evaluation_id)`, and preserves existing `evaluations` columns. Test insert/list ordering, cursor bounds, duplicate upsert behavior, and cross-organization invisibility.

- [ ] **Step 2: Run tests to verify failure.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/evaluation/test_evaluation_detail_persistence.py tests/persistence/test_evaluation_case_results_migration.py -q
```

Expected: FAIL because the table and repository methods do not exist.

- [ ] **Step 3: Add the migration.**

Create an append-only table with UUID primary key, organization/evaluation/run identity, dataset/case/metric identity, score/threshold/pass fields, bounded JSONB evidence, nullable input/expected/actual text, trace ID, duration, and `created_at`. Add the uniqueness constraint and organization/run/evaluation indexes.

- [ ] **Step 4: Implement store and repository methods.**

Use `WHERE org_id = $1` in every list/detail query. Use `ON CONFLICT` only for the same evaluation record. Bound `limit` to `1..200` and return a stable cursor based on `(created_at, id)`.

- [ ] **Step 5: Run persistence tests and lint.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/evaluation/test_evaluation_detail_persistence.py tests/persistence/test_evaluation_case_results_migration.py -q
uv run ruff check src/draftly/integrations/database/evaluations_store.py src/draftly/persistence/repositories/evaluations.py
```

Expected: PASS.

- [ ] **Step 6: Commit persistence.**

```bash
cd draftly-agent-backend
git add src/draftly/persistence/migrations/055_evaluation_case_results.sql src/draftly/integrations/database/evaluations_store.py src/draftly/persistence/repositories/evaluations.py tests/evaluation/test_evaluation_detail_persistence.py tests/persistence/test_evaluation_case_results_migration.py
git commit -m "feat: persist evaluation case results"
```

### Task 3: Normalize runner output for detail pages

**Files:**
- Modify: `draftly-agent-backend/src/draftly/evaluation/runner.py`
- Modify: `draftly-agent-backend/src/draftly/evaluation/online.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`
- Create: `draftly-agent-backend/tests/evaluation/test_runner_detail_rows.py`
- Modify: `draftly-agent-backend/tests/workflows/test_evaluation_loop.py`

**Interfaces:**
- Produce `report_detail_rows(dataset_name: str, report: Any, *, cases: list[dict[str, Any]], run_id: str) -> list[dict[str, Any]]`.
- Missing actual output, evidence, or trace fields become `null`/`[]`; the serializer never invents UI content.

- [ ] **Step 1: Write failing normalization tests.**

Assert that rows preserve dataset/case/metric identity, threshold, score, reason, input, expected output, actual output, evidence, and trace fields. Assert that authorization headers and provider keys cannot survive serialization.

- [ ] **Step 2: Run tests to verify failure.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/evaluation/test_runner_detail_rows.py -q
```

Expected: FAIL because the normalized detail-row function does not exist.

- [ ] **Step 3: Implement the normalized row boundary.**

Build detail rows from the case definitions and report arrays already used by `report_rows`. For live output, take sanitized actual response/evidence produced by the online path; for deterministic runs, use deterministic runner output. Truncate text and evidence using the backend’s response-size limits before persistence.

- [ ] **Step 4: Persist rows in the evaluation workflow.**

After creating the summary row, call `save_case_results` with the same evaluation ID and run ID. If child persistence fails, preserve the summary status, log a structured error, and publish a detail-availability flag so the UI can show unavailable detail rather than fabricated data.

- [ ] **Step 5: Run runner/workflow tests and lint.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/evaluation/test_runner_detail_rows.py tests/workflows/test_evaluation_loop.py -q
uv run ruff check src/draftly/evaluation/runner.py src/draftly/evaluation/online.py src/draftly/workflows/evaluation/documentation_evaluation.py
```

Expected: PASS.

- [ ] **Step 6: Commit runner detail output.**

```bash
cd draftly-agent-backend
git add src/draftly/evaluation/runner.py src/draftly/evaluation/online.py src/draftly/workflows/evaluation/documentation_evaluation.py tests/evaluation/test_runner_detail_rows.py tests/workflows/test_evaluation_loop.py
git commit -m "feat: normalize evaluation detail results"
```

### Task 4: Implement backend evaluation reads, aggregates, and catalog

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/evaluations.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/evaluations_store.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/evaluations.py`
- Create: `draftly-agent-backend/tests/api/test_evaluation_aggregates.py`
- Modify: `draftly-agent-backend/tests/api/test_evaluations_routes.py`

**Interfaces:**
- `GET /api/evaluations?evaluation_type=&limit=&cursor=` returns `CursorPage[EvaluationRunSummary]`.
- `GET /api/evaluations/runs/{run_id}?cases_limit=&cases_cursor=` returns `EvaluationRunDetail`.
- `GET /api/evaluations/runs/{run_id}/cases?limit=&cursor=` returns `CursorPage[EvaluationCaseResult]`.
- `GET /api/evaluations/summary?days=1|7|14|30` returns `EvaluationAggregateSummary`.
- `GET /api/evaluations/catalog` returns `{datasets: EvaluationDataset[], evaluators: EvaluationEvaluator[]}`.
- Existing `GET /api/evaluations/{evaluation_id}` remains available and organization-scoped for compatibility.

- [ ] **Step 1: Add failing route and aggregation tests.**

Cover list ordering/pagination, filtering, unknown IDs, cross-organization IDs, detail aggregation, missing child records, empty windows, mixed statuses, zero-case runs, daily trend points, metric averages, dataset catalog serialization, and evaluator catalog serialization.

- [ ] **Step 2: Run focused tests to verify failure.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_evaluation_aggregates.py tests/api/test_evaluations_routes.py -q
```

Expected: FAIL because the new response models, routes, and repository queries are not implemented.

- [ ] **Step 3: Implement summary list and run-detail queries.**

Join evaluation summaries to organization-scoped jobs by `run_id` to derive a display name and queued/running state. Use summary-row `metrics.granular` only as a compatibility fallback when no child case results exist. Return cases, passed, failed, and score as numbers and calculate duration from persisted timestamps.

- [ ] **Step 4: Implement aggregate queries.**

Use `started_at` as the time-window field. Return `null` for average score and pass rate when the window has no completed runs. Group trend points by UTC calendar day and metric rows by normalized evaluator key; include `sample_count` for every metric row.

- [ ] **Step 5: Implement catalog serialization.**

Expose the packaged dataset definitions with name, description, surface, case count, and version metadata. Add one evaluator catalog function beside the canonical evaluator construction code and expose stable evaluator keys, display names, descriptions, thresholds, and versions.

- [ ] **Step 6: Run backend route tests and lint.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_evaluation_aggregates.py tests/api/test_evaluations_routes.py -q
uv run ruff check src/draftly/app/api/evaluation_schemas.py src/draftly/app/api/routes/evaluations.py src/draftly/persistence/repositories/evaluations.py src/draftly/integrations/database/evaluations_store.py
```

Expected: PASS.

- [ ] **Step 7: Commit backend reads.**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/evaluation_schemas.py src/draftly/app/api/routes/evaluations.py src/draftly/persistence/repositories/evaluations.py src/draftly/integrations/database/evaluations_store.py tests/api/test_evaluation_aggregates.py tests/api/test_evaluations_routes.py
git commit -m "feat: expose evaluation summaries and detail"
```

### Task 5: Make evaluation run submission and live events production-safe

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/evaluations.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/jobs_store.py`
- Create: `draftly-agent-backend/src/draftly/integrations/database/evaluation_idempotency_store.py`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/056_evaluation_idempotency.sql`
- Modify: `draftly-agent-backend/tests/api/test_evaluations_routes.py`
- Modify: `draftly-agent-backend/tests/workflows/test_evaluation_loop.py`
- Create: `draftly-agent-backend/tests/persistence/test_evaluation_idempotency_migration.py`

**Interfaces:**
- `POST /api/evaluations/run` accepts `EvaluationRunRequest` and requires an `Idempotency-Key` header.
- Successful submission returns HTTP `202` with `{run_id, status: "queued", stream_ticket}`.
- Repeating the same key for the same organization returns the original run response without a second job.
- Store idempotency records in `evaluation_run_idempotency` with a unique `(org_id, idempotency_key)` pair and a request-body hash.
- Dashboard events use `{run_id, evaluation_id, status, kind: "evaluation"}` and are emitted on queued, running, terminal, and persisted-summary transitions.

- [ ] **Step 1: Write failing migration, submission, and lifecycle tests.**

Assert the migration is additive and creates the unique organization/key constraint. Assert `202` behavior, body validation, idempotent duplicate requests, organization-bound keys, request-hash conflicts, missing worker behavior, status transitions, one terminal transition, `evaluation:created` only after summary persistence, and live event payload shape.

- [ ] **Step 2: Run tests to verify failure.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/persistence/test_evaluation_idempotency_migration.py tests/api/test_evaluations_routes.py tests/workflows/test_evaluation_loop.py -q
```

Expected: FAIL because the route currently runs synchronously and does not require idempotency.

- [ ] **Step 3: Add the idempotency migration.**

Create `evaluation_run_idempotency` with UUID primary key, organization ID, idempotency key, request hash, run ID, response JSONB, and created/expired timestamps. Add a unique constraint on `(org_id, idempotency_key)` and an index on `run_id`.

- [ ] **Step 4: Implement queued submission and idempotency.**

Persist the request key and request-body hash transactionally with the organization and run ID before enqueueing. Return the existing run when the same organization/key pair is retried, and reject reuse of a key with a different request body. Keep inline execution available only under the existing development/test setting; production returns `503` when no queue worker is available.

- [ ] **Step 5: Make workflow terminal writes idempotent.**

Guard status updates so a completed, failed, cancelled, or skipped run cannot be overwritten by a later retry or duplicate worker callback. Broadcast `workflow:changed` after each accepted transition and `evaluation:created` only when the summary row exists.

- [ ] **Step 6: Run route/workflow tests and lint.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/persistence/test_evaluation_idempotency_migration.py tests/api/test_evaluations_routes.py tests/workflows/test_evaluation_loop.py -q
uv run ruff check src/draftly/app/api/routes/evaluations.py src/draftly/workflows/evaluation/documentation_evaluation.py src/draftly/integrations/database/jobs_store.py
```

Expected: PASS.

- [ ] **Step 7: Commit the run lifecycle.**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/evaluations.py src/draftly/workflows/evaluation/documentation_evaluation.py src/draftly/integrations/database/jobs_store.py src/draftly/integrations/database/evaluation_idempotency_store.py src/draftly/persistence/migrations/056_evaluation_idempotency.sql tests/persistence/test_evaluation_idempotency_migration.py tests/api/test_evaluations_routes.py tests/workflows/test_evaluation_loop.py
git commit -m "feat: make evaluation runs asynchronous and idempotent"
```

### Task 6: Add the UI evaluation API, view models, and hooks

**Files:**
- Create: `draftly-agent-ui/api/evaluations.ts`
- Create: `draftly-agent-ui/hooks/use-evaluations.ts`
- Create: `draftly-agent-ui/hooks/use-evaluation-summary.ts`
- Create: `draftly-agent-ui/hooks/use-evaluation-detail.ts`
- Create: `draftly-agent-ui/hooks/use-evaluation-catalog.ts`
- Create: `draftly-agent-ui/lib/evaluation-view-model.ts`
- Create: `draftly-agent-ui/tests/evaluations-api.test.ts`
- Create: `draftly-agent-ui/tests/evaluations-view-model.test.ts`
- Modify: `draftly-agent-ui/package.json`, `draftly-agent-ui/pnpm-lock.yaml`, and `draftly-agent-ui/package-lock.json`
- Create: `draftly-agent-ui/vitest.config.mts`
- Create: `draftly-agent-ui/tests/setup.ts`

**Interfaces:**
- `listEvaluations(options) -> Promise<CursorPage<EvaluationRunSummary>>`.
- `getEvaluationRun(runId, options) -> Promise<EvaluationRunDetail>`.
- `listEvaluationCases(runId, options) -> Promise<CursorPage<EvaluationCaseResult>>`.
- `getEvaluationSummary(days) -> Promise<EvaluationAggregateSummary>`.
- `getEvaluationCatalog() -> Promise<EvaluationCatalog>`.
- `runEvaluation(payload, idempotencyKey) -> Promise<{run_id: string; status: "queued"; stream_ticket: string}>`.
- Each hook exposes `data`, `error`, `isLoading`, `isRefreshing`, `refresh`, and pagination controls where applicable.

- [ ] **Step 1: Write failing API/view-model tests.**

Assert URL encoding, query serialization, request method/body/idempotency headers, canonical score/status types, cursor handling, status badge mapping, duration formatting, ISO date formatting, safe metric grouping, and null/empty aggregate behavior.

- [ ] **Step 2: Run the focused tests to verify failure.**

Run:

```bash
cd draftly-agent-ui
npm test -- tests/evaluations-api.test.ts tests/evaluations-view-model.test.ts
```

Expected: FAIL because the evaluation module and view-model functions do not exist.

- [ ] **Step 3: Add the UI component test harness.**

Add `vitest`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, and `@testing-library/dom` as development dependencies. Configure `vitest.config.mts` with the React plugin, `jsdom` environment, `@` path alias, and `tests/setup.ts`. Add a `test:components` script that runs `vitest run` while leaving the existing `test` script for Node-based tests.

- [ ] **Step 4: Implement typed API wrappers and pure view models.**

Use `request()` from `api/client.ts`, encode IDs with `encodeURIComponent`, pass `cursor` and `limit` explicitly, and send `Idempotency-Key` from `runEvaluation`. Keep formatting functions pure and avoid tuple-indexed records.

- [ ] **Step 5: Implement hooks with live refresh.**

Use `useCallback` around each fetch function and `useLiveRefresh` with `evaluation:created` and `workflow:changed`. Preserve stale data during refresh, expose the last error, and stop loading only after the first response or error. Do not create one EventSource per hook; use the existing dashboard provider.

- [ ] **Step 6: Run tests and TypeScript validation.**

Run:

```bash
cd draftly-agent-ui
npm test -- tests/evaluations-api.test.ts tests/evaluations-view-model.test.ts
npm run test:components
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit UI data foundation.**

```bash
cd draftly-agent-ui
git add api/evaluations.ts hooks/use-evaluations.ts hooks/use-evaluation-summary.ts hooks/use-evaluation-detail.ts hooks/use-evaluation-catalog.ts lib/evaluation-view-model.ts package.json pnpm-lock.yaml package-lock.json vitest.config.mts tests/setup.ts tests/evaluations-api.test.ts tests/evaluations-view-model.test.ts
git commit -m "feat: add typed evaluation data hooks"
```

### Task 7: Replace the evaluation overview page

**Files:**
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-overview-page.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-summary-cards.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-score-trend.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-metric-breakdown.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-runs-table.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/page.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/__tests__/evaluation-overview-page.test.tsx`

**Interfaces:**
- `EvaluationOverviewPage` owns the selected window, run filter, run dialog, and refresh action.
- Presentational components accept typed API data only; they do not import `lib/mock-data.ts` or fetch directly.

- [ ] **Step 1: Write failing component tests.**

Render populated, loading, empty, error, refreshing, and failed-run states. Assert cards use API summary values, trend labels use server dates, metric rows use API values, table links use real `run_id`, and the run button disables while submitting.

- [ ] **Step 2: Run the tests to verify failure.**

Run:

```bash
cd draftly-agent-ui
npx vitest run components/sections/evaluations/__tests__/evaluation-overview-page.test.tsx
```

Expected: FAIL because the focused overview components do not exist and the route still renders static markup.

- [ ] **Step 3: Split the static overview into typed components.**

Move the chart, cards, metric breakdown, and table markup into focused files. Render a labeled empty state when fewer than two trend points exist, and render pagination controls when `next_cursor` is non-null.

- [ ] **Step 4: Implement run submission UI.**

Open a dialog with dataset/profile inputs from the catalog, submit through `runEvaluation`, show the queued run ID, refresh the list, and link to `/evaluations/runs/{run_id}`. Use a client-generated idempotency key for each deliberate submission.

- [ ] **Step 5: Replace the route and remove overview constants.**

Make `app/(dashboard)/evaluations/page.tsx` a thin wrapper that renders `EvaluationOverviewPage`. Delete the local `runs`, `trendSeries`, and metric arrays after the new components compile.

- [ ] **Step 6: Run component tests, typecheck, and build.**

Run:

```bash
cd draftly-agent-ui
npx vitest run components/sections/evaluations/__tests__/evaluation-overview-page.test.tsx
npx tsc --noEmit
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit the overview page.**

```bash
cd draftly-agent-ui
git add 'app/(dashboard)/evaluations/page.tsx' components/sections/evaluations/evaluation-overview-page.tsx components/sections/evaluations/evaluation-summary-cards.tsx components/sections/evaluations/evaluation-score-trend.tsx components/sections/evaluations/evaluation-metric-breakdown.tsx components/sections/evaluations/evaluation-runs-table.tsx components/sections/evaluations/__tests__/evaluation-overview-page.test.tsx
git commit -m "feat: render evaluations overview from API"
```

### Task 8: Replace run and case detail pages

**Files:**
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-detail-page.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-case-table.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/evaluation-case-detail-page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/runs/[runId]/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/test-cases/[caseId]/page.tsx`
- Create: `draftly-agent-ui/app/(dashboard)/evaluations/runs/[runId]/cases/[caseId]/page.tsx`
- Create: `draftly-agent-ui/components/sections/evaluations/__tests__/evaluation-detail-page.test.tsx`

**Interfaces:**
- Detail pages receive canonical `runId`/`caseId` route values and fetch data through hooks.
- Canonical case links use `/evaluations/runs/{run_id}/cases/{case_result_id}` so case IDs are never treated as globally unique.

- [ ] **Step 1: Write failing detail tests.**

Assert populated stats, metadata, case rows, expected/actual output, evidence, trace IDs, loading skeletons, API errors, explicit not-found UI, missing-detail UI, and links back to the correct run. Assert unknown IDs do not render the first available record.

- [ ] **Step 2: Run tests to verify failure.**

Run:

```bash
cd draftly-agent-ui
npx vitest run components/sections/evaluations/__tests__/evaluation-detail-page.test.tsx
```

Expected: FAIL because the routes still import static mock data.

- [ ] **Step 3: Implement the run detail controller and case table.**

Fetch the run detail by `runId`, render status-aware badges and stats, use server-provided datasets/evaluators, paginate case results, and show “Detailed results unavailable” when summary data exists without child details.

- [ ] **Step 4: Implement case detail.**

Fetch the selected case result by `(runId, caseId)`, render reason/score/threshold, sanitized evidence, expected output, actual output, and trace references. Render not-found state for missing or cross-organization results.

- [ ] **Step 5: Replace routes and remove fallbacks.**

Convert route files into thin wrappers. Remove imports from `lib/mock-data.ts`, remove `|| evaluationRuns[0]` and `|| evalCases[0]`, and update all links to use URL-encoded real IDs.

- [ ] **Step 6: Run detail tests, typecheck, and build.**

Run:

```bash
cd draftly-agent-ui
npx vitest run components/sections/evaluations/__tests__/evaluation-detail-page.test.tsx
npx tsc --noEmit
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit detail pages.**

```bash
cd draftly-agent-ui
git add 'app/(dashboard)/evaluations/runs/[runId]/page.tsx' 'app/(dashboard)/evaluations/test-cases/[caseId]/page.tsx' 'app/(dashboard)/evaluations/runs/[runId]/cases/[caseId]/page.tsx' components/sections/evaluations/evaluation-detail-page.tsx components/sections/evaluations/evaluation-case-table.tsx components/sections/evaluations/evaluation-case-detail-page.tsx components/sections/evaluations/__tests__/evaluation-detail-page.test.tsx
git commit -m "feat: render evaluation run details from API"
```

### Task 9: Replace evaluation subpages and remove evaluation mocks

**Files:**
- Create: `draftly-agent-ui/components/sections/evaluations/evaluations-subpage.tsx`
- Modify: `draftly-agent-ui/components/sections/evaluations/index.ts`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/runs/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/test-cases/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/datasets/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/evaluators/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/evaluations/trends/page.tsx`
- Modify: `draftly-agent-ui/lib/mock-data.ts`
- Create: `draftly-agent-ui/components/sections/evaluations/__tests__/evaluations-subpage.test.tsx`

**Interfaces:**
- `EvaluationsSubpage({kind: "runs" | "test-cases" | "datasets" | "evaluators" | "trends"})` consumes canonical hooks and catalog/summary response types.
- Runs use the paginated evaluation list; datasets/evaluators use the catalog; trends use the selected summary window; test cases link to real case-result routes or show a run-selection prompt when no run is selected.

- [ ] **Step 1: Write failing subpage tests.**

Assert that each kind renders backend data, loading/error/empty states, real links, catalog case counts, evaluator thresholds, and trend points. Assert the generic `section-subpage.tsx` is no longer imported by evaluation routes.

- [ ] **Step 2: Run tests to verify failure.**

Run:

```bash
cd draftly-agent-ui
npx vitest run components/sections/evaluations/__tests__/evaluations-subpage.test.tsx
```

Expected: FAIL because the subpage still uses static arrays from the generic mock component.

- [ ] **Step 3: Implement the focused dynamic subpage.**

Keep `section-subpage.tsx` intact for unrelated documentation/workflow screens. Move only evaluation rendering into the new focused controller and use `SectionTabs` for navigation.

- [ ] **Step 4: Update routes and remove evaluation mock records.**

Update `components/sections/evaluations/index.ts` exports and the five route wrappers. Delete evaluation-only `evaluationRuns` and `evalCases` values from `lib/mock-data.ts` after `rg` confirms no remaining imports.

- [ ] **Step 5: Run tests, typecheck, and mock-reference scan.**

Run:

```bash
cd draftly-agent-ui
npx vitest run components/sections/evaluations/__tests__/evaluations-subpage.test.tsx
npx tsc --noEmit
rg -n "evaluationRuns|evalCases|trendSeries|evalRuns|mock Strands" app components hooks api lib
```

Expected: focused tests and typecheck PASS; the final `rg` command returns no evaluation-page mock references.

- [ ] **Step 6: Commit subpages.**

```bash
cd draftly-agent-ui
git add 'app/(dashboard)/evaluations' components/sections/evaluations lib/mock-data.ts
git commit -m "feat: render evaluation subpages dynamically"
```

### Task 10: Full verification, migration validation, and documentation

**Files:**
- Modify: `draftly-agent-backend/docs/api/routes.md`
- Modify: `draftly-agent-backend/docs/architecture/evaluation.md`
- Modify: `draftly-agent-ui/README.md`

- [ ] **Step 1: Run backend focused regression tests.**

Run:

```bash
cd draftly-agent-backend
uv run pytest tests/api/test_evaluation_schemas.py tests/api/test_evaluation_aggregates.py tests/api/test_evaluations_routes.py tests/evaluation/test_evaluation_detail_persistence.py tests/evaluation/test_runner_detail_rows.py tests/workflows/test_evaluation_loop.py -q
uv run ruff check src/draftly/app/api/evaluation_schemas.py src/draftly/app/api/routes/evaluations.py src/draftly/evaluation/runner.py src/draftly/evaluation/online.py src/draftly/integrations/database/evaluations_store.py src/draftly/persistence/repositories/evaluations.py src/draftly/workflows/evaluation/documentation_evaluation.py
```

Expected: PASS.

- [ ] **Step 2: Run UI tests and production build checks.**

Run:

```bash
cd draftly-agent-ui
npm test
npx tsc --noEmit
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run a browser acceptance flow.**

With the backend, Redis, worker, and UI running, verify: authenticate with Clerk; open `/evaluations`; select each date window; observe API-backed cards/chart/table; submit a run; see a queued/running row; receive `workflow:changed`/`evaluation:created`; open run detail; open case detail; refresh the page; and verify an unknown ID shows not-found.

- [ ] **Step 4: Validate production behavior.**

Confirm the API returns `202` for a submitted run, duplicate idempotency keys do not create duplicate jobs, all list/detail queries include organization predicates, pagination works beyond one page, missing child detail is represented honestly, and no raw secrets or unrestricted model/tool payloads appear in responses.

- [ ] **Step 5: Update documentation.**

Document the new endpoints, request/response examples, score/status conventions, SSE refresh events, queue requirement, migration `055`, and the UI fallback behavior when SSE is unavailable.

- [ ] **Step 6: Refresh graphify and inspect the final diff.**

Run from the umbrella repository:

```bash
graphify update .
git status --short
git diff --check
```

Expected: graphify succeeds, `git diff --check` reports no whitespace errors, and only evaluation-related files are changed in each repository.

- [ ] **Step 7: Commit documentation and final verification.**

```bash
cd draftly-agent-backend
git add docs/api/routes.md docs/architecture/evaluation.md
git commit -m "docs: document dynamic evaluation APIs"

cd ../draftly-agent-ui
git add README.md
git commit -m "docs: document evaluation data flow"
```

## Compatibility decisions

- `GET /api/evaluations/{evaluation_id}` remains the evaluation-record lookup used by existing consumers; the UI run detail uses `/api/evaluations/runs/{run_id}` because its route and SSE lifecycle are keyed by `run_id`.
- Existing `metrics.granular` data remains readable for historical rows. Historical runs without `evaluation_case_results` show aggregate data and an explicit unavailable-detail state rather than fabricated expected/actual/evidence content.
- The generic `components/dashboard/section-subpage.tsx` continues serving unrelated static pages; only evaluation rendering moves to `components/sections/evaluations/`.
- The overview summary endpoint owns trend and metric aggregation so the browser does not infer history from a truncated list response.
