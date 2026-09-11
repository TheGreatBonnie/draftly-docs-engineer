# Dynamic Integrations Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static integrations experience in `draftly-agent-ui` with a production-ready GitHub, Slack, and Discord management flow backed by organization-scoped data and real provider operations.

**Architecture:** Add an organization-scoped backend integrations façade that normalizes connection, health, and source data while delegating provider work to GitHub, Slack, and Discord adapters. Keep provider-specific OAuth/link endpoints for authorization, but route shared reads, refreshes, source updates, and disconnects through the façade. The UI consumes typed normalized responses through client hooks and keeps only provider presentation metadata static.

**Tech Stack:** FastAPI, Pydantic, asyncpg-backed repositories, GitHub/Slack/Discord HTTP APIs, Next.js 16, React 19, TypeScript, Clerk JWT auth, existing `useLiveRefresh` hook, Node test runner.

**Spec:** Approved architecture and requirements from the 2026-09-11 design review in this conversation; no separate spec file was requested.

## Global Constraints

- Scope is limited to GitHub, Slack, and Discord; do not add Notion, GitLab, Jira, webhooks, or other providers.
- “Sync now” refreshes provider connection health and the available repository/channel catalog; it does not re-index Slack or Discord message history.
- GitHub documentation re-indexing continues to use the existing asynchronous `POST /api/documentation/sync` workflow.
- Every read and mutation is scoped to the Clerk organization in the verified JWT.
- Provider access tokens and secrets never appear in API responses, browser state, logs, or UI error messages.
- Existing onboarding flows remain functional and reuse the same provider service methods where their behavior overlaps.
- Use the existing `request`, `ApiError`, `useLiveRefresh`, dashboard UI primitives, and project test commands.

---

## File Map

### Backend

- Create `draftly-agent-backend/src/draftly/persistence/migrations/058_integration_management.sql` for normalized source catalog and cached health records.
- Create `draftly-agent-backend/src/draftly/persistence/repositories/integration_sources.py` for organization/provider/source persistence.
- Create `draftly-agent-backend/src/draftly/integrations/management/models.py` for provider, health, source, summary, detail, and mutation schemas.
- Create `draftly-agent-backend/src/draftly/integrations/management/adapters.py` for the provider adapter protocol and GitHub, Slack, and Discord implementations.
- Create `draftly-agent-backend/src/draftly/app/services/integrations.py` for façade orchestration, authorization checks, refresh behavior, and response mapping.
- Create `draftly-agent-backend/src/draftly/app/api/routes/integrations.py` for normalized list/detail/refresh/source/disconnect routes.
- Modify `draftly-agent-backend/src/draftly/app/api/app.py` to register the new route.
- Modify `draftly-agent-backend/src/draftly/app/api/auth.py` only if a shared integration-management role dependency is needed.
- Modify `draftly-agent-backend/src/draftly/app/api/routes/github.py`, `slack.py`, and `discord.py` to enforce ownership/roles and delegate shared operations.
- Modify `draftly-agent-backend/src/draftly/persistence/repositories/github.py` and `slack.py` to make installation reads/deletes organization-scoped.
- Modify `draftly-agent-backend/src/draftly/integrations/slack/client.py`, `discord/client.py`, and GitHub integration code to expose provider catalog/health calls through adapters.
- Modify `draftly-agent-backend/src/draftly/app/config.py` with Discord OAuth code-grant settings required by the verified installation callback.
- Add backend tests under `draftly-agent-backend/tests/unit/app`, `tests/unit/persistence`, and `tests/test_api` for each contract and security boundary.

### Frontend

- Create `draftly-agent-ui/api/integrations.ts` for normalized API types and requests.
- Create `draftly-agent-ui/hooks/use-integrations.ts` and `draftly-agent-ui/hooks/use-integration.ts` for list/detail loading and refresh.
- Create `draftly-agent-ui/lib/integration-view-model.ts` for provider metadata, status labels, icon selection, source grouping, and safe formatting.
- Create `draftly-agent-ui/components/sections/integrations/integrations-page.tsx` for the dynamic list page.
- Create `draftly-agent-ui/components/sections/integrations/integration-detail-page.tsx` for provider detail and mutations.
- Create `draftly-agent-ui/components/sections/integrations/integration-source-selector.tsx` for controlled source selection and save behavior.
- Create `draftly-agent-ui/components/sections/integrations/integration-connect-actions.tsx` for provider authorization, callback handoff, and connection states.
- Modify `draftly-agent-ui/app/(dashboard)/integrations/page.tsx` to render the client list component.
- Modify `draftly-agent-ui/app/(dashboard)/integrations/[provider]/page.tsx` to validate the provider slug and render the client detail component.
- Modify `draftly-agent-ui/app/(dashboard)/integrations/add/page.tsx` to offer only the three real providers and launch their actual authorization flows.
- Add frontend API/view-model tests under `draftly-agent-ui/tests` and browser coverage under `draftly-agent-ui/e2e` if the existing browser harness is available.

## Backend Tasks

### Task 1: Add normalized integration persistence and schemas

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/058_integration_management.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/integration_sources.py`
- Create: `draftly-agent-backend/src/draftly/integrations/management/models.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Test: `draftly-agent-backend/tests/unit/persistence/test_integration_sources.py`
- Test: `draftly-agent-backend/tests/unit/app/test_integration_models.py`

**Interfaces:**
- Produces `IntegrationSourceRepository.list_catalog(org_id: str, provider: str) -> list[dict[str, Any]]`.
- Produces `IntegrationSourceRepository.upsert_catalog(org_id: str, provider: str, sources: list[dict[str, Any]]) -> list[dict[str, Any]]`.
- Produces `IntegrationSourceRepository.replace_enabled(org_id: str, provider: str, external_ids: list[str]) -> list[dict[str, Any]]`.
- Produces `IntegrationSourceRepository.clear_provider(org_id: str, provider: str) -> None`.
- Produces Pydantic models `IntegrationProvider`, `IntegrationHealth`, `IntegrationSource`, `IntegrationSummary`, `IntegrationDetail`, `IntegrationListResponse`, `UpdateSourcesRequest`, and `IntegrationRefreshResponse`.

- [ ] **Step 1: Write the failing migration/repository tests**

Test that catalog rows are unique per organization/provider/external ID, that `replace_enabled` cannot affect another organization, and that health records are keyed by organization/provider.

```python
async def test_replace_enabled_is_org_scoped(fake_db):
    repository = IntegrationSourceRepository(fake_db)
    await repository.replace_enabled("org-a", "slack", ["C1"])
    assert "org-a" in fake_db.last_query_params
    assert "slack" in fake_db.last_query_params
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/persistence/test_integration_sources.py tests/unit/app/test_integration_models.py -q`

Expected: FAIL because the repository, migration, and models do not exist.

- [ ] **Step 3: Add the migration**

Create `integration_sources` with `org_id`, `provider`, `external_id`, `source_type`, `name`, `enabled`, `metadata`, `last_seen_at`, `created_at`, and `updated_at`. Add a unique constraint on `(org_id, provider, external_id)` and indexes on `(org_id, provider)`.

Create `integration_health` with `(org_id, provider)` as the primary key, `status`, `message`, `last_checked_at`, `last_success_at`, and `metadata`.

Use provider constraints `github`, `slack`, and `discord`; use `ON DELETE CASCADE` to organizations.

- [ ] **Step 4: Implement repository methods and Pydantic models**

Use parameterized SQL for every query. `replace_enabled` must update only rows matching the supplied organization and provider, setting all catalog rows for that provider to `enabled = false` before enabling the requested catalog IDs. Reject IDs not present in that organization/provider catalog.

Use response fields with these shapes:

```python
class IntegrationSource(BaseModel):
    id: str
    external_id: str
    source_type: Literal["repository", "channel"]
    name: str
    enabled: bool
    status: Literal["available", "selected", "unavailable"]
    metadata: dict[str, Any] = {}

class IntegrationHealth(BaseModel):
    status: Literal["unknown", "healthy", "degraded", "error"]
    message: str | None = None
    last_checked_at: datetime | None = None
    last_success_at: datetime | None = None

class IntegrationSummary(BaseModel):
    provider: Literal["github", "slack", "discord"]
    name: str
    connected: bool
    health: IntegrationHealth
    account_id: str | None = None
    account_name: str | None = None
    connected_at: datetime | None = None
    source_count: int = 0
    enabled_source_count: int = 0
    capabilities: dict[str, bool]
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/persistence/test_integration_sources.py tests/unit/app/test_integration_models.py -q`

Expected: PASS.

- [ ] **Step 6: Commit the persistence boundary**

```bash
git add draftly-agent-backend/src/draftly/persistence/migrations/058_integration_management.sql draftly-agent-backend/src/draftly/persistence/repositories/integration_sources.py draftly-agent-backend/src/draftly/integrations/management/models.py draftly-agent-backend/src/draftly/app/dependencies.py draftly-agent-backend/tests/unit/persistence/test_integration_sources.py draftly-agent-backend/tests/unit/app/test_integration_models.py
git commit -m "feat: add integration management persistence contract"
```

### Task 2: Implement provider adapters and the integration service

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/management/adapters.py`
- Create: `draftly-agent-backend/src/draftly/app/services/integrations.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/client.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/discord/client.py`
- Test: `draftly-agent-backend/tests/unit/app/test_integrations_service.py`
- Test: `draftly-agent-backend/tests/unit/integrations/test_integration_adapters.py`

**Interfaces:**
- Produces `IntegrationService.list(org_id: str) -> IntegrationListResponse`.
- Produces `IntegrationService.get(org_id: str, provider: IntegrationProvider) -> IntegrationDetail`.
- Produces `IntegrationService.refresh(org_id: str, provider: IntegrationProvider) -> IntegrationRefreshResponse`.
- Produces `IntegrationService.update_sources(org_id: str, provider: IntegrationProvider, external_ids: list[str]) -> IntegrationDetail`.
- Produces `IntegrationService.disconnect(org_id: str, provider: IntegrationProvider) -> None`.
- Adapters implement `connection(org_id)`, `refresh(org_id)`, `catalog(org_id)`, `update_sources(org_id, external_ids)`, and `disconnect(org_id)` without returning secrets.

- [ ] **Step 1: Write service tests with fake provider adapters**

Cover disconnected providers, healthy/degraded/error health mapping, partial provider failures, source selection validation, and the rule that refresh does not enqueue documentation or message ingestion jobs.

```python
async def test_refresh_updates_catalog_without_ingestion(fake_service, adapter):
    result = await fake_service.refresh("org-a", "discord")
    assert result.detail.health.status == "healthy"
    adapter.message_backfill.assert_not_awaited()

async def test_source_update_rejects_unknown_external_id(fake_service):
    with pytest.raises(ValueError, match="not in provider catalog"):
        await fake_service.update_sources("org-a", "slack", ["unknown-channel"])
```

- [ ] **Step 2: Run the service tests to verify they fail**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_integrations_service.py tests/unit/integrations/test_integration_adapters.py -q`

Expected: FAIL because the service and adapters are not implemented.

- [ ] **Step 3: Implement the GitHub adapter**

Read installations only through `GitHubInstallationsRepository.list_by_org`. A connected GitHub source is a repository from the installation catalog. On refresh, fetch repositories using the installation token, upsert `integration_sources`, and map enabled repositories to the existing `repositories` configuration without deleting historical documentation.

Health checks must distinguish a missing installation, an invalid/revoked installation, an empty repository catalog, and a successful catalog fetch.

- [ ] **Step 4: Implement the Slack adapter**

Use the organization’s Slack installation, never the global list. Add a `SlackClient.list_channels` method that calls Slack’s conversations catalog with the installation’s bot token and returns stable channel ID/name/type metadata. Persist channel catalog rows in `integration_sources`; do not persist message bodies in this table.

Health checks must distinguish no installation, revoked token/API failure, and successful `conversations.list` access.

- [ ] **Step 5: Implement the Discord adapter**

Use the organization’s linked guild ID and the bot token to fetch guild metadata and text/announcement/forum channels. Reuse the existing channel type filter. Persist channel catalog rows and preserve the existing `discord_trigger_channels` configuration as the selected trigger-channel set.

Health checks must distinguish no guild, bot missing from guild, Discord API failure, and successful guild/catalog access.

- [ ] **Step 6: Implement normalized response mapping**

Keep provider labels, descriptions, icon keys, and capability flags in a backend registry. Return `connected = false` for an unlinked provider, `health.status = "unknown"` before its first refresh, and source counts from the catalog repository. Never use fabricated timestamps, item counts, or “healthy” values.

- [ ] **Step 7: Run the service tests to verify they pass**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_integrations_service.py tests/unit/integrations/test_integration_adapters.py -q`

Expected: PASS.

- [ ] **Step 8: Commit the provider/service boundary**

```bash
git add draftly-agent-backend/src/draftly/integrations/management/adapters.py draftly-agent-backend/src/draftly/app/services/integrations.py draftly-agent-backend/src/draftly/integrations/slack/client.py draftly-agent-backend/src/draftly/integrations/discord/client.py draftly-agent-backend/tests/unit/app/test_integrations_service.py draftly-agent-backend/tests/unit/integrations/test_integration_adapters.py
git commit -m "feat: add provider-backed integration service"
```

### Task 3: Expose normalized API routes and harden provider management security

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/routes/integrations.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/slack.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/discord.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/github.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/slack.py`
- Test: `draftly-agent-backend/tests/test_api/test_integrations_routes.py`
- Test: `draftly-agent-backend/tests/test_api/test_provider_management_scope.py`

**Interfaces:**
- `GET /api/integrations` → `IntegrationListResponse`.
- `GET /api/integrations/{provider}` → `IntegrationDetail`.
- `POST /api/integrations/{provider}/refresh` → `IntegrationRefreshResponse`.
- `PATCH /api/integrations/{provider}/sources` with `{ "external_ids": ["..."] }` → `IntegrationDetail`.
- `DELETE /api/integrations/{provider}` → `{ "status": "disconnected" }`.

- [ ] **Step 1: Write route and authorization tests**

Test valid provider validation, current-org-only reads, editor/admin access for refresh and source updates, admin-only disconnect, response shapes, and provider failure mapping to safe 4xx/5xx messages.

```python
async def test_slack_installations_are_current_org_scoped(client, fake_token):
    response = await client.get("/api/slack/installations", headers=fake_token("org-a"))
    assert response.json() == [{"team_id": "T-a"}]

async def test_disconnect_requires_admin(client, editor_token):
    response = await client.delete("/api/integrations/github", headers=editor_token)
    assert response.status_code == 403
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/test_api/test_integrations_routes.py tests/test_api/test_provider_management_scope.py -q`

Expected: FAIL because the façade routes and ownership protections are not present.

- [ ] **Step 3: Add and register the façade router**

Use `get_verified_token` for reads, `require_workflow_editor` for refresh/source updates, and `require_admin_role` for disconnect. Resolve `org_id` from the verified token and reject missing organization claims with HTTP 400. Restrict `{provider}` to the three literal provider values.

- [ ] **Step 4: Fix existing provider installation scope**

Change Slack installation listing to accept `org_id` and add `WHERE si.org_id = $1`. Change GitHub and Slack delete repository methods and routes to include `org_id` in their `WHERE` clauses. A delete for a record outside the current organization must return 404 or a no-op without revealing whether the record exists.

- [ ] **Step 5: Harden GitHub link/delete**

Require admin role for linking and deleting. Keep server-side validation through GitHub App API calls. Preserve the existing allowed return paths and setup callback behavior. After disconnect, clear only the current organization’s installation link/configuration and keep historical documents and workflow records.

- [ ] **Step 6: Harden Slack link/delete**

Require admin role for linking and deleting. Add a nonce `state` to the install URL, store it in a short-lived HttpOnly SameSite cookie, verify it with constant-time comparison in the OAuth callback, and clear it after use. The callback must redirect only to an allowlisted integrations path. The link route must verify that the team installation exists before binding it to the current organization.

- [ ] **Step 7: Add verified Discord installation callback**

Add `discord_client_secret` and `discord_redirect_uri` settings. Configure the Discord application for OAuth2 code grant. Generate a short-lived state cookie and an authorization URL using the bot scope, requested permissions, `response_type=code`, `redirect_uri`, and `integration_type=0`. Add `/api/discord/oauth/callback` to validate state, exchange the code server-side, read the returned guild ID, verify the bot can fetch that guild, and bind it to the current organization. Do not accept a browser-supplied guild ID as proof of installation.

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/test_api/test_integrations_routes.py tests/test_api/test_provider_management_scope.py -q`

Expected: PASS.

- [ ] **Step 9: Commit the API/security boundary**

```bash
git add draftly-agent-backend/src/draftly/app/api/routes/integrations.py draftly-agent-backend/src/draftly/app/api/app.py draftly-agent-backend/src/draftly/app/api/routes/github.py draftly-agent-backend/src/draftly/app/api/routes/slack.py draftly-agent-backend/src/draftly/app/api/routes/discord.py draftly-agent-backend/src/draftly/persistence/repositories/github.py draftly-agent-backend/src/draftly/persistence/repositories/slack.py draftly-agent-backend/src/draftly/app/config.py draftly-agent-backend/tests/test_api/test_integrations_routes.py draftly-agent-backend/tests/test_api/test_provider_management_scope.py
git commit -m "feat: expose secure integration management APIs"
```

### Task 4: Implement backend refresh/source semantics and operational documentation

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/services/integrations.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/integrations.py`
- Create: `draftly-agent-backend/docs/api/integrations.md`
- Test: `draftly-agent-backend/tests/unit/app/test_integration_refresh_semantics.py`

**Interfaces:**
- Refresh returns the updated detail in the same response; it does not create a job row.
- Source updates are replacement semantics: the submitted list is the complete enabled set for that provider.
- Discord source updates also update `organizations.discord_trigger_channels` through the organization-scoped repository method.

- [ ] **Step 1: Write refresh/source semantics tests**

Cover an empty catalog, stale catalog replacement, provider timeout, successful health timestamp, source disablement, and no message/document backfill.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_integration_refresh_semantics.py -q`

Expected: FAIL for the unimplemented refresh/source behavior.

- [ ] **Step 3: Implement refresh and source update behavior**

Use bounded provider HTTP timeouts, persist a safe error category/message, retain the last successful catalog on a failed refresh, and return `health.status = "degraded"` when the connection exists but catalog refresh fails. Use `last_success_at` only after a complete provider catalog fetch.

- [ ] **Step 4: Document the contract**

Document endpoint request/response examples, role requirements, provider-specific connect callbacks, refresh-only sync semantics, source ID rules, and safe error states in `docs/api/integrations.md`.

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_integration_refresh_semantics.py -q`

Expected: PASS.

- [ ] **Step 6: Commit refresh semantics and docs**

```bash
git add draftly-agent-backend/src/draftly/app/services/integrations.py draftly-agent-backend/src/draftly/app/api/routes/integrations.py draftly-agent-backend/docs/api/integrations.md draftly-agent-backend/tests/unit/app/test_integration_refresh_semantics.py
git commit -m "docs: define integration refresh and source behavior"
```

## Frontend Tasks

### Task 5: Add typed integration API clients and view models

**Files:**
- Create: `draftly-agent-ui/api/integrations.ts`
- Create: `draftly-agent-ui/hooks/use-integrations.ts`
- Create: `draftly-agent-ui/hooks/use-integration.ts`
- Create: `draftly-agent-ui/lib/integration-view-model.ts`
- Test: `draftly-agent-ui/tests/integrations-api.test.ts`
- Test: `draftly-agent-ui/tests/integration-view-model.test.ts`

**Interfaces:**
- `listIntegrations(): Promise<IntegrationListResponse>`.
- `getIntegration(provider: IntegrationProvider): Promise<IntegrationDetail>`.
- `refreshIntegration(provider): Promise<IntegrationRefreshResponse>`.
- `updateIntegrationSources(provider, externalIds): Promise<IntegrationDetail>`.
- `disconnectIntegration(provider): Promise<{ status: string }>`.
- `useIntegrations()` returns the existing `LiveRefreshState<IntegrationListResponse>` shape.
- `useIntegration(provider)` returns the existing `LiveRefreshState<IntegrationDetail>` shape.

- [ ] **Step 1: Write failing API/view-model tests**

Assert exact paths, methods, JSON bodies, provider validation, status labels, stable provider icons, and safe relative-time formatting for null timestamps.

```typescript
test("updates sources with replacement semantics", async () => {
  await updateIntegrationSources("discord", ["channel-1", "channel-2"]);
  assert.equal(calls[0].url, "/api/integrations/discord/sources");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    external_ids: ["channel-1", "channel-2"],
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `cd draftly-agent-ui && npm test -- tests/integrations-api.test.ts tests/integration-view-model.test.ts`

Expected: FAIL because the API module, hooks, and view model do not exist.

- [ ] **Step 3: Implement typed API functions and provider validation**

Use `request` from `api/client.ts`. Model only the three supported providers. Surface `ApiError` unchanged so components can show server-provided safe messages.

- [ ] **Step 4: Implement hooks using live refresh**

Use `useLiveRefresh` with the event key `integration:changed` and a 30-second fallback interval. The detail hook must re-fetch when the provider changes and must not retain a previous provider’s detail during the transition.

- [ ] **Step 5: Implement pure view-model helpers**

Keep static registry data limited to provider label, description, icon component, category, and capability labels. Derive connected/available groupings, status tone, source labels, and timestamps from API data.

- [ ] **Step 6: Run the focused tests to verify they pass**

Run: `cd draftly-agent-ui && npm test -- tests/integrations-api.test.ts tests/integration-view-model.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the frontend data boundary**

```bash
git add draftly-agent-ui/api/integrations.ts draftly-agent-ui/hooks/use-integrations.ts draftly-agent-ui/hooks/use-integration.ts draftly-agent-ui/lib/integration-view-model.ts draftly-agent-ui/tests/integrations-api.test.ts draftly-agent-ui/tests/integration-view-model.test.ts
git commit -m "feat: add typed integrations data layer"
```

### Task 6: Replace the integrations list page with dynamic provider cards

**Files:**
- Create: `draftly-agent-ui/components/sections/integrations/integrations-page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/integrations/page.tsx`
- Test: `draftly-agent-ui/tests/integrations-page-view-model.test.ts`

**Interfaces:**
- Consumes `useIntegrations()` and `integration-view-model.ts`.
- Renders exactly three provider cards in connected/available states.
- Emits navigation to `/integrations/github`, `/integrations/slack`, and `/integrations/discord`.

- [ ] **Step 1: Write failing list-state tests**

Cover initial skeleton, loaded connected/disconnected/degraded/error states, empty source counts, retry behavior, and no provider outside the three-provider registry.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd draftly-agent-ui && npm test -- tests/integrations-page-view-model.test.ts`

Expected: FAIL because the dynamic list component and state mapping do not exist.

- [ ] **Step 3: Implement the client list page**

Move the current page markup into the component, replace `integrations.slice(...)` with API-derived groups, replace hard-coded “Connected” badges with health/connection status, and make the Refresh button call the hook’s `refresh` function. Keep the ecosystem illustration limited to the three supported providers and hide disconnected providers from the connected visualization.

- [ ] **Step 4: Add loading/error/empty states**

Use accessible `aria-busy`, `role="alert"`, `role="status"`, and a retry button. Preserve already-loaded cards during a background refresh and show a non-blocking “Updating…” state.

- [ ] **Step 5: Remove list-page mock data usage**

Delete the import of `integrations` from `lib/mock-data.ts`. Do not delete unrelated mock data used by other pages in this task.

- [ ] **Step 6: Run the focused tests to verify they pass**

Run: `cd draftly-agent-ui && npm test -- tests/integrations-page-view-model.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the dynamic list page**

```bash
git add draftly-agent-ui/components/sections/integrations/integrations-page.tsx draftly-agent-ui/app/(dashboard)/integrations/page.tsx draftly-agent-ui/tests/integrations-page-view-model.test.ts
git commit -m "feat: render integrations from live data"
```

### Task 7: Build provider detail, source configuration, refresh, and disconnect actions

**Files:**
- Create: `draftly-agent-ui/components/sections/integrations/integration-detail-page.tsx`
- Create: `draftly-agent-ui/components/sections/integrations/integration-source-selector.tsx`
- Create: `draftly-agent-ui/components/sections/integrations/integration-connect-actions.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/integrations/[provider]/page.tsx`
- Test: `draftly-agent-ui/tests/integration-actions.test.ts`
- Test: `draftly-agent-ui/tests/integration-detail-view-model.test.ts`

**Interfaces:**
- `IntegrationSourceSelector` accepts `sources`, `disabled`, and `onSave(externalIds: string[])`.
- `IntegrationConnectActions` accepts `provider`, `detail`, `onChanged`, and `onError`.
- Detail actions call the typed API functions and refresh the detail/list data after success.

- [ ] **Step 1: Write failing action/view-model tests**

Cover connect URL selection, refresh button state, inline disconnect confirmation, source replacement payload, provider-specific source labels, callback query handling, and redirect after disconnect.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `cd draftly-agent-ui && npm test -- tests/integration-actions.test.ts tests/integration-detail-view-model.test.ts`

Expected: FAIL because the action components do not exist.

- [ ] **Step 3: Implement provider detail rendering**

Replace `integrationDetails` with `useIntegration(provider)`. Render actual account/workspace name, health status, last checked/successful timestamps, source counts, and source rows. Show “Not connected” and a connect action when the provider has no connection; never render fabricated “Authly”, dates, item counts, or healthy statuses.

- [ ] **Step 4: Implement source selector behavior**

Use controlled checkbox state keyed by `external_id`. Disable save while a request is in flight, show a saved/error status, and re-fetch the detail after success. For Discord, explain that selected channels are trigger channels; for Slack, selected channels are catalog sources; for GitHub, selected repositories are ingestion sources.

- [ ] **Step 5: Implement refresh-only sync**

Call `POST /api/integrations/{provider}/refresh`, preserve the existing detail while refreshing, show “Refreshing connection…” and update the source catalog/health response on success. Do not call `POST /api/documentation/sync` from this button.

- [ ] **Step 6: Implement disconnect confirmation and post-success navigation**

Require an inline confirmation before disconnect. Disable all actions during the request. After success, navigate to `/integrations`; on failure, keep the connection visible and show the safe error.

- [ ] **Step 7: Remove provider-page mock data usage**

Delete the `integrationDetails` import and fallback provider fabrication. Unknown provider slugs should render Next.js `notFound()` rather than inventing a provider.

- [ ] **Step 8: Run the focused tests to verify they pass**

Run: `cd draftly-agent-ui && npm test -- tests/integration-actions.test.ts tests/integration-detail-view-model.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the provider detail flow**

```bash
git add draftly-agent-ui/components/sections/integrations/integration-detail-page.tsx draftly-agent-ui/components/sections/integrations/integration-source-selector.tsx draftly-agent-ui/components/sections/integrations/integration-connect-actions.tsx draftly-agent-ui/app/(dashboard)/integrations/[provider]/page.tsx draftly-agent-ui/tests/integration-actions.test.ts draftly-agent-ui/tests/integration-detail-view-model.test.ts
git commit -m "feat: add integration configuration actions"
```

### Task 8: Replace the mock Add Integration wizard with real provider authorization

**Files:**
- Modify: `draftly-agent-ui/app/(dashboard)/integrations/add/page.tsx`
- Modify: `draftly-agent-ui/api/github.ts`
- Modify: `draftly-agent-ui/api/slack.ts`
- Modify: `draftly-agent-ui/api/discord.ts`
- Test: `draftly-agent-ui/tests/integration-connect-flow.test.ts`

**Interfaces:**
- GitHub connect launches `getInstallUrl("/integrations/github")`, consumes `installation_id`, then calls `linkGitHubInstallation`.
- Slack connect launches `getSlackInstallUrl`, consumes `team_id`, then calls `linkSlackInstallation`.
- Discord connect launches `getDiscordInviteUrl`, consumes the verified callback result, then refreshes `/integrations/discord`.

- [ ] **Step 1: Write failing connect-flow tests**

Assert that only GitHub, Slack, and Discord are shown, no mock source names or “mock authorization” copy remain, and each provider launches the correct API flow.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd draftly-agent-ui && npm test -- tests/integration-connect-flow.test.ts`

Expected: FAIL because the current page still renders Notion, Custom Webhook, fake sources, and fake sync progress.

- [ ] **Step 3: Implement real provider selection and authorization**

Use provider cards that navigate to each provider detail page or launch authorization directly. Keep callback handling in provider-specific client components so query parameters are consumed once and removed from the address bar.

- [ ] **Step 4: Implement callback handoffs**

GitHub reads `installation_id` and posts the verified numeric ID to `/github/link`. Slack reads `team_id` and posts it to `/slack/link`. Discord uses the server callback’s success redirect and performs a detail refresh; it must not accept a guild ID from the browser as proof.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `cd draftly-agent-ui && npm test -- tests/integration-connect-flow.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit real authorization flows**

```bash
git add draftly-agent-ui/app/(dashboard)/integrations/add/page.tsx draftly-agent-ui/api/github.ts draftly-agent-ui/api/slack.ts draftly-agent-ui/api/discord.ts draftly-agent-ui/tests/integration-connect-flow.test.ts
git commit -m "feat: connect integrations through provider OAuth flows"
```

## Verification and Handoff

### Task 9: Run full verification, update graphify, and review the implementation

**Files:**
- Modify: generated `draftly-agent-backend/graphify-out/*` and root `graphify-out/*` as produced by graphify.
- Test: all backend and frontend tests.

- [ ] **Step 1: Run backend focused integration tests**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/test_api/test_integrations_routes.py tests/test_api/test_provider_management_scope.py tests/unit/app/test_integrations_service.py tests/unit/app/test_integration_refresh_semantics.py tests/unit/persistence/test_integration_sources.py -q`

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run: `cd draftly-agent-ui && npm test`

Expected: PASS with all existing tests and new integration tests green.

- [ ] **Step 3: Build the frontend**

Run: `cd draftly-agent-ui && npm run build`

Expected: PASS with no TypeScript, route, or client/server boundary errors.

- [ ] **Step 4: Run the backend suite**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest -q`

Expected: PASS.

- [ ] **Step 5: Exercise provider flows in a configured environment**

Verify GitHub install/link/delete, Slack OAuth state/link/delete, and Discord code-grant install/link/delete with test organizations. Verify a user from organization A cannot list, update, refresh, or disconnect organization B’s installation. Verify provider outage produces a degraded/error card while preserving the last successful catalog.

- [ ] **Step 6: Update graphify after code changes**

Run from the workspace root: `graphify update .`

Expected: graphify completes and updates the graph to include the integrations façade, adapters, routes, repositories, and UI hooks.

- [ ] **Step 7: Review the diff for scope and secret safety**

Run: `git diff --check` and `git status --short`.

Confirm no provider token, client secret, fabricated integration data, unrelated provider work, or destructive migration is present.

- [ ] **Step 8: Request code review before merge**

Use the project’s code-review workflow after all tests and build verification pass. The review should specifically inspect tenant isolation, OAuth state validation, Discord guild proof, refresh-only semantics, and stale catalog behavior.

