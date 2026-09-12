# Dynamic Agents Pages and Telemetry Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock-driven agents list and detail routes in `draftly-agent-ui` with authenticated, organization-scoped agent catalog, telemetry, history, and live per-run execution data from `draftly-agent-backend`.

**Architecture:** Agent definitions remain code-defined and immutable in a backend catalog next to the factory registry; no Strands agent instances are constructed by API requests, and no database-backed agent CRUD is introduced. Two additive migrations make run and step telemetry identify the participating agent and surface, after which backend read APIs expose summaries/detail/runs and the UI consumes them through typed hooks. Historical snapshots come from CockroachDB; the existing per-run Redis/SSE transport supplies live selected-run updates.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, CockroachDB migrations, async repository methods, Redis Streams/SSE, Next.js 16, React 19, TypeScript, Tailwind CSS, Clerk authentication, Vitest, Testing Library, and Playwright where available.

**Spec:** User-approved brainstorming scope in this conversation; this plan supersedes the older `docs/superpowers/plans/2026-09-01-agents-page-live-data.md` frontend assumptions and targets `draftly-agent-ui` directly.

## Global Constraints

- Agent definitions are code-defined metadata; do not add database-backed configurable-agent CRUD in this work.
- Never construct a Strands `Agent` or `Swarm` from an API request; the catalog contains display metadata and factory roles only.
- Every backend read must be organization-scoped from the verified Clerk token, including detail, history, aggregates, and steps.
- Preserve the existing authenticated API path: UI requests use `request()` from `draftly-agent-ui/api/client.ts`.
- Preserve the existing single-use SSE ticket and per-run SSE transport at `/api/workflows/{run_id}/stream-ticket` and `/api/workflows/{run_id}/events`.
- The agents list must not poll on a timer. It may perform an initial snapshot fetch and explicit user retry; live selected-run changes come from SSE.
- A workflow run may execute multiple agents. Do not model one `agent_name` as the sole owner of a run; identify agents on individual steps and aggregate runs by agent identity.
- Keep legacy telemetry readable. Existing rows without agent identity must render as `legacy`/`unknown`, never disappear silently.
- API response fields must be represented by Pydantic response models and matching TypeScript types; do not use tuple-indexed mock data.
- Do not expose provider credentials, raw authorization headers, secrets, or unrestricted prompts/tool configuration in agent responses.
- Keep backend and UI commits in their own repositories. The umbrella plan file is documentation only.
- After modifying application code, run `graphify update .` once from each modified repository before the final verification claim.
- Do not claim an agent is “live” unless the UI is connected to an active run stream; distinguish availability, last-run status, and stream connection state.

## File Structure

**Backend (`draftly-agent-backend/`):**

- Create `src/draftly/agents/catalog.py` — immutable `AgentDescriptor` metadata and the canonical catalog derived from active factory roles/node IDs.
- Create `src/draftly/app/api/agent_schemas.py` — Pydantic response models for catalog, aggregates, agent detail, run summaries, and pagination.
- Create `src/draftly/persistence/migrations/052_agent_run_surface.sql` — additive run-level surface/workflow metadata and organization/time indexes.
- Create `src/draftly/persistence/migrations/053_agent_step_identity.sql` — additive step-level agent/node identity columns and indexes.
- Modify `src/draftly/app/api/routes/agents.py` — replace duplicated route-local catalog metadata with catalog services and add detail/runs endpoints.
- Modify `src/draftly/app/api/routes/runs.py` — return the actual run contract and expose organization-safe initial step snapshots.
- Modify `src/draftly/persistence/repositories/agent_runs.py` — persist new identity fields and add aggregate/detail/runs queries.
- Modify `src/draftly/orchestration/hooks/audit.py` — include agent ID, surface, and node ID in new step rows and stream payloads.
- Modify graph builders under `src/draftly/orchestration/graphs/` — pass stable agent identity metadata into audit state/events where node IDs are ambiguous.
- Modify `src/draftly/workflows/runner.py` or its graph-event shaping boundary — ensure live SSE frames carry the same stable agent identity as persisted steps.
- Modify `src/draftly/app/api/app.py` and `src/draftly/app/api/routes/__init__.py` only if route registration changes are required.
- Create or modify `tests/agents/test_catalog.py` — catalog/registry consistency tests.
- Create or modify `tests/api/test_agents_routes.py` — response, authentication, organization isolation, detail, and pagination tests.
- Create or modify `tests/api/test_runs_routes.py` — run/step response contract and tenant isolation tests.
- Create `tests/persistence/test_agent_runs_queries.py` — repository query and legacy-row behavior tests.
- Create `tests/persistence/test_agent_telemetry_migrations.py` — migration presence, additive-column, and index contract tests.
- Create or modify `tests/orchestration/hooks/test_audit_detail.py` and `tests/orchestration/hooks/test_audit_stream.py` — identity propagation and SSE envelope tests.

**UI (`draftly-agent-ui/`):**

- Create `components/sections/agents/agents-page.tsx` — client page controller for catalog, filters, selection, and list/detail layout.
- Create `components/sections/agents/agent-list.tsx` — typed list/card/table rendering.
- Create `components/sections/agents/agent-detail-page.tsx` — route-level detail controller.
- Create `components/sections/agents/agent-detail.tsx` — typed detail presentation and selected-run timeline.
- Create `components/sections/agents/agent-filters.tsx` — controlled search/surface/status filters and derived counts.
- Create `components/sections/agents/agent-icons.tsx` — stable role/surface icon mapping with fallback.
- Create `hooks/use-agents.ts` — one-shot catalog fetch with abort, retry, loading, error, and stale-state handling.
- Replace `hooks/use-agent-runs.ts` — one-shot run snapshot plus selected-run SSE state, initial-step hydration, and sequence deduplication.
- Create `hooks/use-agent-detail.ts` — detail fetch keyed by stable agent ID.
- Create or modify `api/agents.ts`, `api/runs.ts`, and `api/types.ts` — exact typed backend contracts.
- Modify `app/(dashboard)/agents/page.tsx` and `app/(dashboard)/agents/[id]/page.tsx` — route wrappers into focused components.
- Modify `app/(dashboard)/agents/active/page.tsx` and `app/(dashboard)/agents/idle/page.tsx` — reuse the dynamic page with an initial filter.
- Modify `components/sections/agents/index.ts` — export the new agent components instead of the generic mock subpage.
- Modify `lib/mock-data.ts` only to remove the agent dataset after all imports are gone; retain unrelated mock data until its own migration.
- Modify `package.json`, lockfile, and add `vitest.config.mts`/test setup if needed — establish React component tests for this feature.
- Create `tests/agents-api.test.ts`, `tests/agents-view-model.test.ts`, and component tests under `components/sections/agents/__tests__/`.
- Update `README.md` — document the agent API, Clerk token requirement, SSE/Redis requirement, and honest unsupported actions.

---

### Task 1: Define the canonical backend agent catalog

**Files:**
- Create: `draftly-agent-backend/src/draftly/agents/catalog.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/agents.py` only if a registry/catalog consistency hook is needed
- Test: `draftly-agent-backend/tests/agents/test_catalog.py`

**Interfaces:**
- Consumes: active factory roles from `AgentRegistry`, graph node IDs from the documentation, issue, support, and content graph builders, and existing tool-group definitions.
- Produces: `AgentDescriptor`, `AGENT_CATALOG`, `get_agent_descriptor(agent_id)`, and `list_agent_descriptors()` used by API routes and telemetry mapping.

- [ ] **Step 1: Write failing catalog tests**

Test that every descriptor has a unique stable `id`, non-empty display name/description, valid surface, at least one node ID, and no duplicate tool names. Test that every user-visible graph agent role is represented and that the descriptor’s factory role exists on `AgentRegistry` when the role is factory-backed. Include content, changelog, reviewer, auditor, issue, support, documentation, and research composite entries that are actually registered or invoked.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/agents/test_catalog.py -v
```

Expected: FAIL because `draftly.agents.catalog` and its descriptor functions do not yet exist.

- [ ] **Step 3: Implement immutable descriptors**

Use a frozen dataclass with these fields:

```python
@dataclass(frozen=True, slots=True)
class AgentDescriptor:
    id: str
    role: str
    name: str
    description: str
    surface: str
    node_ids: tuple[str, ...]
    tool_keys: tuple[str, ...]
    kind: Literal["agent", "composite"] = "agent"
    factory_attr: str | None = None
```

Keep display metadata in this module, not in the API route. Use `role`/`id` as the URL key; never derive identity from display-name slugs. Expand tool keys through the existing tool registry helper or a shared pure formatter so the API does not maintain a second divergent tool list.

- [ ] **Step 4: Run catalog tests and the relevant registry tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/agents/test_catalog.py tests/unit/agents/test_agents.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the catalog boundary**

```bash
cd draftly-agent-backend
git add src/draftly/agents/catalog.py src/draftly/app/composition/agents.py tests/agents/test_catalog.py
git commit -m "feat: define canonical agent catalog metadata"
```

### Task 2: Add additive telemetry migrations

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/052_agent_run_surface.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/053_agent_step_identity.sql`
- Test: `draftly-agent-backend/tests/persistence/test_agent_telemetry_migrations.py`

**Interfaces:**
- Consumes: migration ordering through the backend migration loader and existing tables from migrations `023_agent_runs.sql` and `051_workflow_runs.sql`.
- Produces: nullable-compatible identity fields for existing rows and indexes used by agent summary/detail queries.

- [ ] **Step 1: Write migration contract tests**

Assert that migration `052` adds `surface`, `workflow_key`, and `definition_id` to `agent_runs`, and creates an organization/time index without dropping or rewriting existing columns. Assert that migration `053` adds `agent_id`, `node_id`, and `surface` to `agent_steps`, plus indexes for `(run_id, seq)` and agent/org aggregation through `agent_runs`.

- [ ] **Step 2: Run the migration tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/persistence/test_agent_telemetry_migrations.py -v
```

Expected: FAIL because migrations `052` and `053` do not exist.

- [ ] **Step 3: Create migration `052_agent_run_surface.sql`**

Use additive, repeatable statements:

```sql
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS workflow_key TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS definition_id UUID;

CREATE INDEX IF NOT EXISTS idx_agent_runs_org_started
    ON agent_runs (org_id, started_at DESC, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_org_surface_started
    ON agent_runs (org_id, surface, started_at DESC, run_id);
```

Do not guess historical surface values in SQL where `source` and `event_type` are ambiguous. Leave legacy rows with an empty surface and make the API label them as legacy/unknown until the application-level compatibility mapping can identify them safely.

- [ ] **Step 4: Create migration `053_agent_step_identity.sql`**

Use additive fields and indexes:

```sql
ALTER TABLE agent_steps ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE agent_steps ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE agent_steps ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_agent_steps_run_seq
    ON agent_steps (run_id, seq, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_steps_agent_run_seq
    ON agent_steps (agent_id, run_id, seq, created_at);
```

Keep `name` for backward compatibility and use `node_id` for the graph node identifier. Existing rows remain queryable with `agent_id IS NULL`.

- [ ] **Step 5: Run migration contract tests and SQL formatting checks**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/persistence/test_agent_telemetry_migrations.py -q
git diff --check
```

Expected: PASS with no whitespace errors. If the repository has a migration smoke command, run it against the disposable test database and verify both migrations are idempotent.

- [ ] **Step 6: Commit migrations separately**

```bash
cd draftly-agent-backend
git add src/draftly/persistence/migrations/052_agent_run_surface.sql src/draftly/persistence/migrations/053_agent_step_identity.sql tests/persistence/test_agent_telemetry_migrations.py
git commit -m "feat: add agent telemetry identity migrations"
```

### Task 3: Persist stable identity in audit telemetry and live envelopes

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/agent_runs.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/hooks/audit.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/issue_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/support_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/content_graph.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py` only at the event-shaping boundary
- Test: `draftly-agent-backend/tests/orchestration/hooks/test_audit_detail.py`
- Test: `draftly-agent-backend/tests/orchestration/hooks/test_audit_stream.py`
- Test: `draftly-agent-backend/tests/persistence/test_agent_runs_queries.py`

**Interfaces:**
- Consumes: `AgentDescriptor` mappings, graph node IDs, existing `RunAuditLogger`, `StreamEnvelope`, and per-run publisher.
- Produces: `record_step(..., agent_id, node_id, surface)`, persisted run `surface`, and live payloads containing `agent_id`, `node_id`, and `surface`.

- [ ] **Step 1: Write failing identity tests**

Cover:

```python
assert recorded_step["agent_id"] == "writer_agent"
assert recorded_step["node_id"] == "update"
assert recorded_step["surface"] == "documentation"
assert streamed.payload["agent_id"] == "writer_agent"
```

Also cover the collision where `impact` means different agents in documentation and issue graphs, and verify unknown nodes use `agent_id=None` rather than being assigned to the wrong agent.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/orchestration/hooks/test_audit_detail.py tests/orchestration/hooks/test_audit_stream.py tests/persistence/test_agent_runs_queries.py -q
```

Expected: FAIL because the repository and envelopes do not accept stable identity fields.

- [ ] **Step 3: Extend repository writes without breaking legacy callers**

Add optional keyword parameters to `start_run` and `record_step`. Write `surface`, `workflow_key`, and `definition_id` when present. Write `agent_id`, `node_id`, and step `surface` for new rows. Keep defaults compatible with tests and offline graphs.

- [ ] **Step 4: Thread graph identity into audit state**

Define a pure mapping from `(surface, node_id)` to `AgentDescriptor.id`. Graph builders must attach the mapping before node execution or include the stable ID in the invocation state. Do not infer identity from display names. For composite research swarms, use `research_swarm_factory` for the graph node and preserve child agent names in the event payload when Strands exposes them.

- [ ] **Step 5: Update audit persistence and live payloads**

Ensure `RunAuditLogger.node_end()` writes the stable fields in both the database step detail and `StreamEnvelope.payload`. Keep payloads compact and redact model/tool arguments. The existing runner publisher remains the source of live graph events; do not create a second dashboard transport and do not delay live frames until `run_end`.

- [ ] **Step 6: Run focused tests and existing audit tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/orchestration/hooks tests/workflows/test_audit_hook.py tests/persistence/test_agent_runs_queries.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit telemetry identity changes**

```bash
cd draftly-agent-backend
git add src/draftly/persistence/repositories/agent_runs.py src/draftly/orchestration/hooks/audit.py src/draftly/orchestration/graphs src/draftly/workflows/runner.py tests/orchestration/hooks tests/persistence/test_agent_runs_queries.py
git commit -m "feat: persist agent identity in run telemetry"
```

### Task 4: Add efficient, organization-scoped agent read queries

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/agent_runs.py`
- Test: `draftly-agent-backend/tests/persistence/test_agent_runs_queries.py`

**Interfaces:**
- Consumes: `AgentDescriptor`, `agent_runs`, `agent_steps`, and verified `org_id`.
- Produces:
  - `list_agent_summaries(*, org_id: str, surface: str | None = None, limit: int = 100) -> list[dict[str, Any]]`
  - `get_agent_detail(*, org_id: str, agent_id: str, window_days: int = 30) -> dict[str, Any] | None`
  - `list_agent_runs(*, org_id: str, agent_id: str, limit: int = 50, cursor: str | None = None) -> tuple[list[dict[str, Any]], str | None]`

- [ ] **Step 1: Write failing repository tests**

Use a fake database that records SQL and returns fixture rows. Assert summaries include zero-run agents, `availability`, `last_run_status`, `runs_7d`, `success_rate_7d`, `last_run_at`, `latest_run_id`, and `legacy_steps`. Assert all SQL includes the organization parameter. Assert detail for an unknown agent returns `None`, and run pagination returns a cursor only when more rows exist.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/persistence/test_agent_runs_queries.py -v
```

Expected: FAIL because the new repository methods do not exist.

- [ ] **Step 3: Implement one aggregate query for summaries**

Use a CTE that starts from the code catalog, left joins agent steps to agent runs by `run_id`, filters `agent_runs.org_id = $1`, and computes aggregates with conditional counts. A summary must still be returned for an agent with no telemetry. Do not issue one `list_steps()` query per catalog entry.

Use explicit status rules: an agent is `running` when its newest associated run is running; otherwise use the newest terminal run status; use `idle` when no run exists. Calculate success rate as completed associated steps/runs divided by terminal associated steps/runs, with `null` or a documented “no data” state when the denominator is zero.

- [ ] **Step 4: Implement detail and paginated agent-run queries**

Detail returns the descriptor, safe configuration metadata, aggregate metrics, the latest run, and recent history. `list_agent_runs` joins through `agent_steps.agent_id`, filters by organization, orders by `started_at DESC, run_id DESC`, and encodes both values in an opaque cursor. Never return another organization’s rows even when the `run_id` is known.

- [ ] **Step 5: Run query tests and static checks**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/persistence/test_agent_runs_queries.py tests/api/test_runs_routes.py -q
ruff check src/draftly/persistence/repositories/agent_runs.py tests/persistence/test_agent_runs_queries.py
```

Expected: PASS.

- [ ] **Step 6: Commit read-side repository support**

```bash
cd draftly-agent-backend
git add src/draftly/persistence/repositories/agent_runs.py tests/persistence/test_agent_runs_queries.py
git commit -m "feat: add efficient agent telemetry read queries"
```

### Task 5: Expose typed backend agent APIs

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/agent_schemas.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/agents.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/runs.py`
- Test: `draftly-agent-backend/tests/api/test_agents_routes.py`
- Test: `draftly-agent-backend/tests/api/test_runs_routes.py`

**Interfaces:**
- Consumes: repository methods from Task 4, `AgentDescriptor`, `get_verified_token`, and existing `/api/runs/{run_id}/steps` authorization.
- Produces:
  - `GET /api/agents?surface=<surface>&limit=<n>` → `AgentListResponse`
  - `GET /api/agents/{agent_id}` → `AgentDetailResponse`
  - `GET /api/agents/{agent_id}/runs?limit=<n>&cursor=<cursor>` → `AgentRunsResponse`
  - `GET /api/runs` → `RunListResponse` with fields that actually exist, not an invented `agent_name`.

- [ ] **Step 1: Define Pydantic response models**

Define models for `AgentSummary`, `AgentMetrics`, `AgentHistoryEntry`, `AgentDetail`, `RunSummary`, `RunStepSummary`, and cursor responses. Use explicit literals for statuses and `datetime` fields serialized as ISO-8601. Include `agent_id: str | None`, `node_id: str | None`, and `surface: str` on step summaries. Keep `model`, `prompt`, and configuration fields absent until a safe backend source exists.

- [ ] **Step 2: Expand failing route tests**

Test catalog response, detail response, unknown agent `404`, surface filter, limit bounds, opaque cursor, missing token `401`, cross-organization detail `404`, and legacy rows. Test that `/runs` returns no `agent_name` unless it is genuinely derived from a defined contract; the preferred field is `last_agent_id` or a list of associated agents.

- [ ] **Step 3: Run API tests to verify the new cases fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/api/test_agents_routes.py tests/api/test_runs_routes.py -v
```

Expected: new detail/schema/isolation tests fail before route implementation.

- [ ] **Step 4: Implement the routes**

Keep `APIRouter(prefix="/agents", tags=["agents"], dependencies=[Depends(get_verified_token)])`. Resolve `org_id` once from the verified token and pass it to every repository method. Return `404` for an unknown catalog ID or organization-inaccessible resource. Do not return raw database rows directly.

- [ ] **Step 5: Run API and auth tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/api/test_agents_routes.py tests/api/test_runs_routes.py tests/api/test_routes_smoke.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit the API contract**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/agent_schemas.py src/draftly/app/api/routes/agents.py src/draftly/app/api/routes/runs.py tests/api/test_agents_routes.py tests/api/test_runs_routes.py
git commit -m "feat: expose typed agent catalog and detail APIs"
```

### Task 6: Establish target UI API types and hooks

**Files:**
- Modify: `draftly-agent-ui/api/agents.ts`
- Modify: `draftly-agent-ui/api/runs.ts`
- Modify: `draftly-agent-ui/api/types.ts`
- Create: `draftly-agent-ui/hooks/use-agents.ts`
- Create: `draftly-agent-ui/hooks/use-agent-detail.ts`
- Replace: `draftly-agent-ui/hooks/use-agent-runs.ts`
- Test: `draftly-agent-ui/tests/agents-api.test.ts`
- Test: `draftly-agent-ui/tests/agents-view-model.test.ts`

**Interfaces:**
- Consumes: backend contracts from Task 5, `request()` from `api/client.ts`, and `useWorkflowEvents(runId)` for the selected run.
- Produces: typed `listAgents`, `getAgent`, `listAgentRuns`, `listRuns`, `getRunSteps`, and hooks with explicit loading/error/retry state.

- [ ] **Step 1: Add failing API and normalization tests**

Test that API wrappers use `/agents`, `/agents/{id}`, `/agents/{id}/runs`, `/runs`, and `/runs/{id}/steps`; test status labels, date formatting, `null` metrics, and unknown/legacy agent IDs. Test that the type model does not require a nonexistent `agent_name` on workflow runs.

- [ ] **Step 2: Run UI tests to verify they fail**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='agent'
```

Expected: FAIL because the target UI currently has no agent API/detail wrappers or component-test setup for the new cases.

- [ ] **Step 3: Update TypeScript contracts**

Use stable IDs and separate runtime state:

```ts
export interface AgentSummary {
  id: string;
  role: string;
  name: string;
  description: string;
  surface: string;
  tools: string[];
  availability: "enabled" | "disabled" | "unavailable";
  last_run_status: "idle" | "running" | "completed" | "failed";
  runs_7d: number;
  success_rate_7d: number | null;
  last_run_at: string | null;
  latest_run_id: string | null;
}
```

Define separate `AgentDetail`, `AgentRunSummary`, `RunStepSummary`, and `SseAgentEvent` types. Do not make display fields such as `model`, `version`, `temperature`, or `max_steps` mandatory until the backend supplies safe values.

- [ ] **Step 4: Implement hooks**

`useAgents` performs exactly one fetch per mount, uses an `AbortController`, preserves stale data during explicit retry, and exposes `retry()`. `useAgentDetail(id)` fetches only when `id` is present. `useAgentRuns(agentId?)` fetches the initial snapshot once, hydrates selected-run steps from `/runs/{id}/steps`, and calls `useWorkflowEvents(selectedRunId)` only for the selected run. Fold frames by `seq`, merge updates by `node_id`/`agent_id`, and close on `workflow_result`.

- [ ] **Step 5: Add React test infrastructure if required**

The target UI currently has a Node-only test script and no React Testing Library/Vitest setup. Add the smallest compatible dev dependencies and configure `vitest` with `jsdom`, path aliases, and a setup file. Do not copy tests from `draftly-agent-frontend` without copying the required test environment.

- [ ] **Step 6: Run hook/API tests and typecheck**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='agent'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit UI data boundaries**

```bash
cd draftly-agent-ui
git add api/agents.ts api/runs.ts api/types.ts hooks/use-agents.ts hooks/use-agent-detail.ts hooks/use-agent-runs.ts tests/agents-api.test.ts tests/agents-view-model.test.ts package.json pnpm-lock.yaml vitest.config.mts tests/setup.ts
git commit -m "feat: add typed agents data hooks"
```

### Task 7: Replace the static agents list page and components

**Files:**
- Modify: `draftly-agent-ui/app/(dashboard)/agents/page.tsx`
- Create: `draftly-agent-ui/components/sections/agents/agents-page.tsx`
- Create: `draftly-agent-ui/components/sections/agents/agent-list.tsx`
- Create: `draftly-agent-ui/components/sections/agents/agent-filters.tsx`
- Create: `draftly-agent-ui/components/sections/agents/agent-icons.tsx`
- Modify: `draftly-agent-ui/components/sections/agents/index.ts`
- Test: `draftly-agent-ui/components/sections/agents/__tests__/agents-page.test.tsx`
- Test: `draftly-agent-ui/components/sections/agents/__tests__/agent-list.test.tsx`

**Interfaces:**
- Consumes: `useAgents`, `useAgentRuns`, existing `PageHeader`, `MetricCard`, `Card`, `Badge`, `SearchBox`, `Tabs`, `SectionTabs`, and semantic theme tokens.
- Produces: a production-safe dynamic list page with typed cards/list rows, derived metrics, controlled filters, URL-safe agent links, loading/error/empty states, and selected-run activity.

- [ ] **Step 1: Write failing page/component tests**

Cover catalog rendering, metrics derived from response data, search by name/description/tool, surface/status filtering, empty state, retry action, accessible status labels, `/agents/{id}` links, and no hardcoded agent names/counts. Add a fake SSE stream test proving a selected run updates its timeline without another catalog/run fetch.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='AgentsPage|AgentList'
```

Expected: FAIL because the route still renders `lib/mock-data.ts` and the focused components do not exist.

- [ ] **Step 3: Move page orchestration into a client component**

Keep the route file as a thin wrapper that renders `AgentsPage`. The client controller should fetch catalog data once, preserve stale data during retry, derive active/running/completed/failed/idle counts, and pass typed objects to child components. Use `agent.id` for keys and links.

- [ ] **Step 4: Build the typed list and icon boundaries**

Render API objects directly. Use role/surface mapping for icons with a `Bot` fallback; never use array index to select icons or tones. Show availability separately from last-run state. Display “No runs yet” rather than a fabricated last-run time.

- [ ] **Step 5: Make filters controlled and accessible**

Wire `SearchBox` with `value`/`onChange`, implement surface and status controls, set `aria-label`/`aria-pressed` or tab semantics, and ensure counts derive from the fetched catalog. Use semantic color tokens where possible.

- [ ] **Step 6: Add honest metric cards**

Derive total agents, enabled agents, runs in the selected window, and success rate from the backend summary. Render `—` or “No data” when no denominator exists. Remove the hardcoded `8`, `24`, `1,248`, `98%`, and trend percentages.

- [ ] **Step 7: Run focused UI tests and typecheck**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='AgentsPage|AgentList'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit the dynamic list page**

```bash
cd draftly-agent-ui
git add 'app/(dashboard)/agents/page.tsx' components/sections/agents api hooks tests
git commit -m "feat: render agents list from live backend data"
```

### Task 8: Replace the static agent detail route

**Files:**
- Modify: `draftly-agent-ui/app/(dashboard)/agents/[id]/page.tsx`
- Create: `draftly-agent-ui/components/sections/agents/agent-detail-page.tsx`
- Create: `draftly-agent-ui/components/sections/agents/agent-detail.tsx`
- Test: `draftly-agent-ui/components/sections/agents/__tests__/agent-detail-page.test.tsx`

**Interfaces:**
- Consumes: `useAgentDetail(id)`, `useAgentRuns(id)`, `AgentDetail`, `AgentRunSummary`, `RunStepSummary`, and the existing per-run SSE hook.
- Produces: a URL-addressable detail page showing real metadata, tools, metrics, history, latest run, and live selected-run steps.

- [ ] **Step 1: Write failing detail tests**

Test successful detail rendering, unknown agent `404`/not-found state, loading/error/retry states, actual tools and metrics, legacy telemetry label, initial step hydration, live SSE frame updates, terminal status, and no fake model/version/temperature values.

- [ ] **Step 2: Run detail tests to verify they fail**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='AgentDetail'
```

Expected: FAIL because the route currently renders static documentation-agent content for every ID.

- [ ] **Step 3: Make the route pass the stable ID to the client detail controller**

Keep Next.js route params handling in the route wrapper and pass the exact `id` to `AgentDetailPage`. Do not title-case arbitrary IDs as a substitute for a backend response.

- [ ] **Step 4: Render only safe backend fields**

Display descriptor, surface, availability, last-run status, tools, metrics, recent history, and connected resources only when supplied by the API. Remove or disable Edit/Run actions unless their backend mutations exist; the page must not imply that a button works when it does not.

- [ ] **Step 5: Merge historical and live execution data**

Show initial database steps immediately, replace/update them by sequence number as SSE frames arrive, and mark the stream as connecting/live/closed/error. Handle stream ticket `404` as an unavailable/stale run, `403` as an authorization error, and terminal `workflow_result` as closed.

- [ ] **Step 6: Run detail tests and typecheck**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='AgentDetail'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit the detail route**

```bash
cd draftly-agent-ui
git add 'app/(dashboard)/agents/[id]/page.tsx' components/sections/agents/agent-detail-page.tsx components/sections/agents/agent-detail.tsx components/sections/agents/__tests__/agent-detail-page.test.tsx hooks api
git commit -m "feat: render dynamic agent detail and live runs"
```

### Task 9: Migrate agent subroutes and remove misleading mocks/actions

**Files:**
- Modify: `draftly-agent-ui/app/(dashboard)/agents/active/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/agents/idle/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/agents/templates/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/agents/new/page.tsx`
- Modify: `draftly-agent-ui/components/sections/agents/index.ts`
- Modify: `draftly-agent-ui/lib/mock-data.ts`
- Test: `draftly-agent-ui/components/sections/agents/__tests__/agent-subroutes.test.tsx`

**Interfaces:**
- Consumes: the dynamic `AgentsPage` with an optional initial status/surface filter.
- Produces: consistent route behavior without static agent cards or nonfunctional configuration promises.

- [ ] **Step 1: Write failing subroute tests**

Assert active and idle routes reuse live catalog data and apply their initial filter. Assert templates/new routes do not display fabricated agents or imply that agent creation/configuration is persisted. They may render an explicit “not available yet” state or be removed from navigation, consistent with product direction.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='AgentSubroutes'
```

Expected: FAIL because subroutes currently use generic mock-driven content and the new-agent flow is not backed by an API.

- [ ] **Step 3: Reuse the dynamic page for active/idle**

Pass `initialStatus="running"` and `initialStatus="idle"` respectively. Counts and visible rows must come from the same fetched catalog as the main page.

- [ ] **Step 4: Make unsupported routes honest**

Remove the “New agent” CTA from the list unless creation is implemented. For templates/new, either remove links and routes from navigation or render a deliberate, nonfunctional product-state screen with no fake data. Do not delete unrelated mock datasets.

- [ ] **Step 5: Remove only agent mock imports and data**

Run:

```bash
cd draftly-agent-ui
rg -n "from \"@/lib/mock-data\"|from \"@/components/dashboard/section-subpage\"|agents" app components lib --glob '!node_modules/**'
```

Delete only the `agents` export after the search confirms it is unused. Preserve other sections’ mocks for separate work.

- [ ] **Step 6: Run subroute tests and typecheck**

Run:

```bash
cd draftly-agent-ui
npm test -- --test-name-pattern='AgentSubroutes'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit subroute cleanup**

```bash
cd draftly-agent-ui
git add 'app/(dashboard)/agents' components/sections/agents lib/mock-data.ts tests
git commit -m "chore: remove misleading static agent routes"
```

### Task 10: Production verification, documentation, and graph refresh

**Files:**
- Modify: `draftly-agent-backend/README.md` or the appropriate API/deployment documentation
- Modify: `draftly-agent-ui/README.md`
- Test: backend and UI verification commands below

**Interfaces:**
- Consumes: all backend/UI changes from Tasks 1–9.
- Produces: verified migrations, API contract, tenant isolation, UI build, SSE behavior, and current graph indexes.

- [ ] **Step 1: Run backend focused suites**

```bash
cd draftly-agent-backend
python -m pytest tests/agents/test_catalog.py tests/api/test_agents_routes.py tests/api/test_runs_routes.py tests/persistence tests/orchestration/hooks -q
```

Expected: all focused tests pass.

- [ ] **Step 2: Run backend lint/type checks**

```bash
cd draftly-agent-backend
ruff check src/draftly/agents/catalog.py src/draftly/app/api src/draftly/persistence src/draftly/orchestration/hooks tests
python -m compileall -q src/draftly
```

Expected: no lint or compilation errors.

- [ ] **Step 3: Run UI tests and static checks**

```bash
cd draftly-agent-ui
npm test
npx tsc --noEmit
npm run build
```

Expected: all tests pass, typecheck passes, and the production build completes with no agent-route errors.

- [ ] **Step 4: Run manual API smoke checks**

With the backend and Redis running and a valid Clerk token available, verify:

```text
GET /api/agents                         -> 200, catalog and zero-run agents
GET /api/agents/{known-id}              -> 200, detail and metrics
GET /api/agents/{unknown-id}            -> 404
GET /api/agents/{known-id}/runs          -> 200, cursor contract
GET /api/runs/{run-id}/steps             -> 200, stable identity fields
POST /api/workflows/{run-id}/stream-ticket -> 200 only for an authorized run
GET /api/workflows/{run-id}/events       -> live frames, replay, terminal close
```

Verify an organization A token cannot retrieve organization B’s agent-associated runs or steps. Verify a run that has no `agent_steps.agent_id` renders as legacy rather than being incorrectly attributed.

- [ ] **Step 5: Run an end-to-end UI smoke check**

Open `/agents`, confirm real catalog data appears, filter/search it, open `/agents/{agent_id}`, select a run, and observe initial steps followed by SSE updates. Stop the backend and confirm the UI shows an actionable error/retry state rather than an empty successful page. Confirm no repeated `/agents` or `/runs` requests occur while the page is idle.

- [ ] **Step 6: Refresh graphify in both application repositories**

```bash
cd draftly-agent-backend
graphify update .

cd ../draftly-agent-ui
graphify update .
```

Inspect `git status` afterward and keep generated graph changes only in the repository where the project convention tracks them.

- [ ] **Step 7: Update documentation and run final diff checks**

Document the code-defined catalog decision, migration versions, API routes, Clerk requirements, Redis/SSE proxy requirements, and the absence of configurable-agent CRUD. Run:

```bash
cd draftly-agent-backend
git diff --check
git status --short

cd ../draftly-agent-ui
git diff --check
git status --short
```

Expected: no whitespace errors, no accidental secrets, and only intended files changed.

- [ ] **Step 8: Commit documentation/verification changes**

```bash
cd draftly-agent-backend
git add README.md docs src tests
git commit -m "docs: document dynamic agent observability"

cd ../draftly-agent-ui
git add README.md tests
git commit -m "docs: document dynamic agents pages"
```

## Acceptance Criteria

- `/agents` renders zero or more backend catalog entries and never imports the agent mock dataset.
- `/agents/{id}` renders the requested backend agent or a truthful not-found state; it does not reuse documentation-agent copy for every ID.
- Metrics, counts, status, tools, history, timestamps, and links are derived from typed API data.
- Active and idle subroutes reuse the same live data source.
- New run steps persist stable agent identity and surface values; ambiguous legacy rows remain visible as legacy.
- Agent list/detail/run APIs enforce organization isolation and bounded pagination.
- A selected run can hydrate from persisted steps and receive live SSE frames with sequence deduplication and terminal handling.
- The list performs no timer polling and does not silently turn backend failures into empty data.
- Database migrations `052` and `053` are additive and idempotent.
- Backend tests, UI tests, typecheck, lint/compile checks, production build, smoke checks, and graph refresh complete successfully.

## Out of Scope

- Database-backed agent creation, editing, deletion, or per-organization custom prompts.
- Exposing raw model configuration or provider credentials.
- Replacing the existing Redis/SSE transport with a new dashboard transport.
- Migrating unrelated mock-driven dashboard sections.
- Making every historical step retroactively attributable when the original telemetry did not persist enough identity to do so safely.
