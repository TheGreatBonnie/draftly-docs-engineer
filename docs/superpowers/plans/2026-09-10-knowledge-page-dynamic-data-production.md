# Knowledge Page Dynamic Data and Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static data in draftly-agent-ui Knowledge overview, list, detail, source, graph, topic, and embedding surfaces with authenticated organization-scoped data from draftly-agent-backend, while keeping unsupported data honest and the read path production-ready.

**Architecture:** Stabilize a typed FastAPI Knowledge read model behind a repository/service boundary, then consume it through the existing authenticated Next.js request client and small client-side hooks. Ship the overview/list/detail vertical slice first; add source provenance, graph, topics, and embedding coverage as explicit read models instead of deriving or fabricating dashboard values in React.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, asyncpg/CockroachDB-compatible SQL, existing backend Redis/model dependencies, Next.js 16.3.4, React 19, TypeScript, Tailwind CSS, Node’s built-in test runner, and the existing Clerk token flow.

**Spec:** docs/superpowers/plans/2026-08-31-knowledge-page-live-data.md is the original Knowledge-page design baseline. This plan supersedes its assumptions where the current checkout already contains partial implementation or where production readiness requires stronger contracts.

## Global Constraints

- Keep backend and UI changes in their own repositories; the umbrella repository contains documentation only.
- Add read APIs only. Do not add Knowledge mutations, source-import actions, or fabricated fallback data in this work.
- Every backend read requires a non-empty org_id from the verified Clerk token; a missing organization must return 400 or 403, never an unscoped query.
- Every list, stats, search, detail, provenance, relation, graph, topic, and embedding query must be organization-scoped in SQL or an equivalent repository boundary.
- Preserve the frontend API path through draftly-agent-ui/api/client.ts; browser requests use /api and the existing Clerk token injection.
- Use Pydantic response models on backend routes and matching TypeScript types in draftly-agent-ui/api/knowledge.ts.
- Return ISO-8601 timestamps. Format relative timestamps only in the UI.
- Never return memory_embeddings.embedding; search responses may include only the scalar similarity.
- Do not use memory_sources as proof that an integration is connected. It is provenance evidence; connection health belongs to integration/configuration data.
- Do not expose raw prompts, secrets, provider credentials, authorization headers, or unrestricted memory metadata.
- Bound every client-controlled limit, query string, and cursor. Use deterministic ordering for stable pagination.
- Do not add a runtime dependency for this migration. The existing request client and Node test runner remain the integration pattern.
- The existing app/(dashboard)/knowledge/[section]/page.tsx owns all one-segment subroutes; the detail route must use a non-conflicting path such as /knowledge/item/[id].
- After application-code changes, run graphify update . once from each modified repository before the final verification claim.

## Current Checkout Findings

- draftly-agent-ui/api/knowledge.ts already defines list/stats/search/detail wrappers, but the Knowledge pages do not consume them.
- draftly-agent-ui/hooks/use-knowledge.ts already performs a list/stats fetch, but it lacks abort handling, independent loading states, query/status inputs, and detail support.
- draftly-agent-ui/app/(dashboard)/knowledge/page.tsx still hardcodes metric cards, graph nodes, recent rows, source cards, topics, and source percentages.
- draftly-agent-ui/app/(dashboard)/knowledge/[section]/page.tsx still imports docs and knowledgeTopics from lib/mock-data.ts and renders all subroutes from local arrays.
- draftly-agent-backend/src/draftly/app/api/routes/knowledge.py is registered at /api/knowledge and has list/stats/search/detail handlers, but it returns untyped dictionaries, loads all records for stats, permits a missing token organization to reach unscoped repository methods, and passes org_id to link/feedback stores whose SQL currently ignores it.
- DatabaseMemoryStore.list_namespace() already accepts org_id, but its row projection omits metadata, so topic/read-model work cannot use persisted topic metadata without a projection change.
- VectorSearch.search() already filters active rows and returns a scalar similarity, but its unscoped branch must not be reachable from authenticated API routes.
- The UI package uses node --experimental-strip-types --test tests/*.test.ts; do not assume Vitest or Testing Library is installed.

## File Structure

Backend, under draftly-agent-backend:

- Create src/draftly/app/api/knowledge_schemas.py for Pydantic response models and bounded query enums/types.
- Create src/draftly/persistence/repositories/knowledge.py for organization-scoped Knowledge reads and composition of memory, provenance, relation, and embedding queries.
- Modify src/draftly/app/api/routes/knowledge.py to keep handlers thin and authenticated.
- Modify src/draftly/app/dependencies.py to construct one shared Knowledge repository from the existing database client and one shared EmbeddingService.
- Modify src/draftly/integrations/database/memory_store.py and src/draftly/persistence/repositories/memory.py to preserve org filtering and expose safe internal metadata.
- Modify src/draftly/integrations/database/memory_links_store.py and memory_feedback_store.py to enforce org filtering in SQL.
- Create src/draftly/persistence/migrations/057_knowledge_read_indexes.sql for additive read-path indexes (054-056 already exist in this checkout).
- Create or modify tests/api/test_knowledge_routes.py, tests/persistence/test_knowledge_repository.py, tests/persistence/test_knowledge_read_scope.py, and tests/persistence/test_knowledge_read_migrations.py.

UI, under draftly-agent-ui:

- Modify api/knowledge.ts for exact request parameters and response types.
- Create lib/knowledge-view-model.ts for safe display mapping and relative-time formatting.
- Replace hooks/use-knowledge.ts with abortable, retryable list/stats/search state.
- Create hooks/use-knowledge-detail.ts and hooks/use-knowledge-surfaces.ts.
- Create focused components under components/sections/knowledge/ for overview, list, detail, sources, graph, topics, and embeddings.
- Modify app/(dashboard)/knowledge/page.tsx and app/(dashboard)/knowledge/[section]/page.tsx to remove mock-data imports.
- Create app/(dashboard)/knowledge/item/[id]/page.tsx because [section] already occupies the one-segment route.
- Create tests/knowledge-api.test.ts, tests/knowledge-view-model.test.ts, and tests/knowledge-components.test.ts with Node-compatible contract/view-model assertions; use TypeScript/build verification for JSX compilation.
- Modify README.md to document the live API requirement and honest unsupported actions.

## Execution status

Implemented on inline feature branches:

- Backend `feat/knowledge-page-dynamic-data-backend`: commits `cd5706f` and `89c2c9d`.
- UI `feat/knowledge-page-dynamic-data`: commit `69b89a6`.
- Focused Knowledge verification: backend 16 passed; UI 40 passed, TypeScript and Ruff passed.
- UI production verification: `npx next build --webpack` passed and emitted `/knowledge/item/[id]`.
- Full backend regression: 1,649 passed; existing live/database-dependent failures remain documented in the handoff because they are outside Knowledge.
- Authenticated live API verification remains a deployment step requiring a configured Clerk organization and database; no credentials or live mutation were assumed.

---

### Task 1: Establish the backend Knowledge read contract and shared dependency

Files:

- Create: draftly-agent-backend/src/draftly/app/api/knowledge_schemas.py
- Create: draftly-agent-backend/src/draftly/persistence/repositories/knowledge.py
- Modify: draftly-agent-backend/src/draftly/app/dependencies.py
- Modify: draftly-agent-backend/src/draftly/integrations/database/memory_store.py
- Modify: draftly-agent-backend/src/draftly/persistence/repositories/memory.py
- Test: draftly-agent-backend/tests/persistence/test_knowledge_repository.py

Interfaces:

- Produce Pydantic models KnowledgeStatus, KnowledgeListItem, KnowledgePage, KnowledgeStats, KnowledgeSource, KnowledgeLink, KnowledgeFeedback, KnowledgeDetail, KnowledgeSourceSummary, KnowledgeGraphNode, KnowledgeGraphEdge, KnowledgeGraph, KnowledgeTopic, and KnowledgeEmbeddingStats.
- Produce repository methods list_page(org_id, status, limit, cursor), stats(org_id), search(org_id, query, limit), detail(org_id, item_id), source_summaries(org_id), graph(org_id, limit_nodes, limit_edges), topics(org_id, limit), and embedding_stats(org_id). The repository constructor accepts both the shared DatabaseClient and shared EmbeddingService.
- Repository methods return plain dictionaries/lists; route serialization is owned by Pydantic models.

- [ ] Step 1: Write failing schema and repository contract tests

Add tests that import the new models/repository and assert:

~~~python
def test_knowledge_list_item_rejects_unknown_status() -> None:
    with pytest.raises(ValidationError):
        KnowledgeListItem(
            id="item-1",
            entity="Fact",
            description=None,
            status="connected",
            importance=0.5,
            confidence=0.5,
            created_at=None,
            updated_at=None,
            namespace="knowledge",
            memory_type="knowledge",
        )


def test_knowledge_repository_requires_org_id() -> None:
    with pytest.raises(ValueError, match="org_id"):
        KnowledgeRepository(client=FakeDatabaseClient())._require_org_id("")
~~~

- [ ] Step 2: Run the focused tests and verify the contract fails

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_knowledge_repository.py -v
~~~

Expected: FAIL because the schemas and repository boundary do not yet exist.

- [ ] Step 3: Add strict response models

Use extra="forbid" on API models and represent timestamps as datetime | None so FastAPI emits ISO-8601 values. The core list contract is:

~~~python
class KnowledgeStatus(StrEnum):
    VERIFIED = "verified"
    NEEDS_VERIFICATION = "needs-verification"
    STALE = "stale"


class KnowledgeListItem(BaseModel):
    id: str
    entity: str | None
    description: str | None
    status: KnowledgeStatus
    importance: float | None
    confidence: float | None
    created_at: datetime | None
    updated_at: datetime | None
    namespace: str
    memory_type: str


class KnowledgePage(BaseModel):
    items: list[KnowledgeListItem]
    total: int
    next_cursor: str | None


class KnowledgeStats(BaseModel):
    total: int
    verified: int
    needs_verification: int
    stale: int
~~~

Detail/source/relation/graph/topic/embedding models must contain only fields the UI renders. Do not include content in list rows or any embedding vector.

- [ ] Step 4: Create the repository boundary and organization guard

Implement the repository with a constructor accepting the shared DatabaseClient and a private guard:

~~~python
class KnowledgeRepository:
    def __init__(self, *, client: DatabaseClient, embedder: EmbeddingService) -> None:
        self.client = client
        self.embedder = embedder

    @staticmethod
    def _require_org_id(org_id: str) -> str:
        value = org_id.strip()
        if not value:
            raise ValueError("org_id is required for Knowledge reads")
        return value
~~~

Keep SQL in this repository or existing database stores, not in FastAPI handlers. Use keyset pagination ordered by updated_at DESC, id DESC; encode the last updated_at/id pair as an opaque URL-safe cursor. Use the existing memory namespace constant and map database status through one derive_status() helper.

- [ ] Step 5: Preserve metadata in memory read projections without exposing it directly

Extend the internal memory projection with metadata and, where needed, source_type/source_id. The repository may use metadata.get("topic") or metadata.get("topics") for topic aggregation, but response models must select only safe display fields. Keep default unscoped memory methods for internal non-HTTP callers; the Knowledge repository must always pass org_id.

- [ ] Step 6: Wire one shared repository into application dependencies

Add embeddings: EmbeddingService and knowledge: KnowledgeRepository to ApplicationDependencies, construct the embedder once during build_dependencies(), pass it into KnowledgeRepository(client=integrations.database, embedder=embeddings), and expose both through request.app.state.draftly.dependencies. Do not instantiate a new DatabaseClient, EmbeddingService, or provenance store per request.

- [ ] Step 7: Run repository tests, typecheck, and commit

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_knowledge_repository.py -q
uv run ruff check src/draftly/app/api/knowledge_schemas.py src/draftly/persistence/repositories/knowledge.py src/draftly/app/dependencies.py
uv run mypy src/draftly/app/api/knowledge_schemas.py src/draftly/persistence/repositories/knowledge.py
~~~

Commit in draftly-agent-backend:

~~~bash
git add src/draftly/app/api/knowledge_schemas.py src/draftly/persistence/repositories/knowledge.py src/draftly/app/dependencies.py src/draftly/integrations/database/memory_store.py src/draftly/persistence/repositories/memory.py tests/persistence/test_knowledge_repository.py
git commit -m "feat: establish typed knowledge read boundary"
~~~

### Task 2: Harden and complete the core backend endpoints

Files:

- Modify: draftly-agent-backend/src/draftly/app/api/routes/knowledge.py
- Modify: draftly-agent-backend/src/draftly/integrations/database/memory_links_store.py
- Modify: draftly-agent-backend/src/draftly/integrations/database/memory_feedback_store.py
- Create: draftly-agent-backend/src/draftly/persistence/migrations/057_knowledge_read_indexes.sql
- Modify: draftly-agent-backend/tests/api/test_knowledge_routes.py
- Test: draftly-agent-backend/tests/persistence/test_knowledge_read_migrations.py

Interfaces:

- Produce authenticated GET /api/knowledge, /api/knowledge/stats, /api/knowledge/search, and /api/knowledge/{item_id}.
- List query: status: KnowledgeStatus | None, limit: int = 25 bounded to 1..100, cursor: str | None.
- Search query: q: str, limit: int = 20 bounded to 1..50; reject blank or overlong queries with 400. The response is { query, items, total } where total is the number of returned matches.
- Detail response includes sources, related, and feedback, each already organization-filtered.

- [ ] Step 1: Add failing route tests for production invariants

Extend tests/api/test_knowledge_routes.py with tests for missing org claims, foreign-org detail, stable pagination, invalid limits, response fields, and related-data filtering:

~~~python
def test_missing_org_id_is_rejected() -> None:
    client = TestClient(make_app(token={}))
    response = client.get("/knowledge")
    assert response.status_code in (400, 403)


def test_list_has_bounded_page_shape() -> None:
    response = TestClient(make_app()).get("/knowledge", params={"limit": 101})
    assert response.status_code == 422


def test_detail_does_not_return_embedding() -> None:
    body = TestClient(make_app()).get(f"/knowledge/{ITEM['id']}").json()
    assert "embedding" not in body


def test_detail_passes_org_id_to_all_related_reads() -> None:
    assert fake_sources.org_ids == ["org-1"]
    assert fake_links.org_ids == ["org-1"]
    assert fake_feedback.org_ids == ["org-1"]
~~~

- [ ] Step 2: Run route tests to establish the failing baseline

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/api/test_knowledge_routes.py -v
~~~

Expected: failures for missing-org rejection, pagination/validation, and the new response contract.

- [ ] Step 3: Make route handlers thin and org-closed

Use the verified token only to obtain the organization and reject an empty value before calling the repository:

~~~python
def _org_id(token: dict[str, Any]) -> str:
    org_id = str(token.get("org_id") or "").strip()
    if not org_id:
        raise HTTPException(status_code=400, detail="No organization selected")
    return org_id
~~~

Each handler calls the shared KnowledgeRepository, declares response_model, and converts missing detail records to 404. Route order must remain literal /stats and /search before /{item_id}.

- [ ] Step 4: Use real aggregates and bounded search

Implement stats() with COUNT(*) FILTER over memory_items scoped by org_id and namespace, rather than loading every row into Python. Keep the status mapping identical between stats and list/detail. Search must use the shared embedding dependency, cap query length at 300 characters, cap result count at 50, and return only the similarity scalar.

- [ ] Step 5: Fix relation and feedback SQL scoping

Update both stores so the supplied org_id is part of the query predicate:

~~~sql
WHERE org_id = $1
  AND memory_item_id = $2
~~~

For links, apply org_id = $1 together with (source_memory_id = $2 OR target_memory_id = $2). Preserve existing method signatures and add tests proving a foreign organization’s row is excluded.

- [ ] Step 6: Add read-path indexes

Create 057_knowledge_read_indexes.sql with idempotent additive indexes:

~~~sql
CREATE INDEX IF NOT EXISTS idx_memory_items_knowledge_page
    ON memory_items (org_id, namespace, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_memory_links_org_source_target
    ON memory_links (org_id, source_memory_id, target_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_sources_org_item_created
    ON memory_sources (org_id, memory_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_org_item_created
    ON memory_feedback (org_id, memory_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_org_item
    ON memory_embeddings (org_id, memory_item_id);
~~~

- [ ] Step 7: Run backend verification and commit

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/api/test_knowledge_routes.py tests/persistence/test_knowledge_read_migrations.py -q
uv run ruff check src/draftly/app/api/routes/knowledge.py src/draftly/integrations/database/memory_links_store.py src/draftly/integrations/database/memory_feedback_store.py
uv run mypy src/draftly/app/api/routes/knowledge.py
git diff --check
~~~

Commit:

~~~bash
git add src/draftly/app/api/routes/knowledge.py src/draftly/integrations/database/memory_links_store.py src/draftly/integrations/database/memory_feedback_store.py src/draftly/persistence/migrations/057_knowledge_read_indexes.sql tests/api/test_knowledge_routes.py tests/persistence/test_knowledge_read_scope.py tests/persistence/test_knowledge_read_migrations.py
git commit -m "feat: harden organization-scoped knowledge reads"
~~~

### Task 3: Replace the UI API/hook seam with production-safe client state

Files:

- Modify: draftly-agent-ui/api/knowledge.ts
- Modify: draftly-agent-ui/hooks/use-knowledge.ts
- Create: draftly-agent-ui/hooks/use-knowledge-detail.ts
- Create: draftly-agent-ui/hooks/use-knowledge-surfaces.ts
- Create: draftly-agent-ui/lib/knowledge-view-model.ts
- Test: draftly-agent-ui/tests/knowledge-api.test.ts
- Test: draftly-agent-ui/tests/knowledge-view-model.test.ts

Interfaces:

- listKnowledge({ status, limit, cursor }) returns KnowledgePage.
- searchKnowledge(query, limit) returns { query, items, total }.
- getKnowledgeDetail(id) returns KnowledgeDetail.
- useKnowledge(options) returns { items, total, nextCursor, stats, loading, statsLoading, error, statsError, reload, loadMore, search }.
- useKnowledgeDetail(id) returns { item, loading, error, reload }.

- [ ] Step 1: Add failing API wrapper tests

Using the existing setApiToken() and fake fetch pattern, assert that list options are URL-encoded, search query/limit are bounded by the wrapper, and detail IDs are encoded:

~~~typescript
test("knowledge API wrappers build stable encoded URLs", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  setApiToken("test-token");
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ items: [], total: 0, next_cursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await listKnowledge({ status: "verified", limit: 25, cursor: "opaque/cursor" });
    await searchKnowledge("oauth tokens", 20);
    await getKnowledgeDetail("item/one");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calls[0], /\/api\/knowledge\?/);
  assert.match(calls[0], /status=verified/);
  assert.match(calls[0], /cursor=opaque%2Fcursor/);
  assert.match(calls[1], /q=oauth\+tokens/);
  assert.equal(calls[2], "/api/knowledge/item%2Fone");
});
~~~

- [ ] Step 2: Run the UI tests and verify failure

Run:

~~~bash
cd draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
~~~

Expected: FAIL because the current wrapper signatures and hook return shape do not match the production contract.

- [ ] Step 3: Implement typed wrappers and pure view-model helpers

Keep all fetches routed through request(). Add pure functions for displayKnowledgeTitle(item), displayKnowledgeDescription(item), formatKnowledgeTime(value, now), sourceLabel(source), and statusLabel(status). Missing values must render "Not available" or an explicit empty-state message, never a made-up value.

- [ ] Step 4: Add abortable, retryable hooks

Pass an AbortSignal through RequestInit, abort on effect cleanup, retain previous data while reloading, and keep list/stats failures independent. A reload must clear errors and set only the affected request to loading. Search results must be keyed by query and must not overwrite a newer query response.

- [ ] Step 5: Run UI verification and commit

Run:

~~~bash
cd draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
npx tsc --noEmit
git diff --check
~~~

Commit:

~~~bash
git add api/knowledge.ts hooks/use-knowledge.ts hooks/use-knowledge-detail.ts hooks/use-knowledge-surfaces.ts lib/knowledge-view-model.ts tests/knowledge-api.test.ts tests/knowledge-view-model.test.ts
git commit -m "feat(ui): add typed knowledge read hooks"
~~~

### Task 4: Ship the overview/list/detail vertical slice

Files:

- Create: draftly-agent-ui/components/sections/knowledge/knowledge-overview.tsx
- Create: draftly-agent-ui/components/sections/knowledge/knowledge-list.tsx
- Create: draftly-agent-ui/components/sections/knowledge/knowledge-detail.tsx
- Modify: draftly-agent-ui/app/(dashboard)/knowledge/page.tsx
- Modify: draftly-agent-ui/app/(dashboard)/knowledge/[section]/page.tsx
- Create: draftly-agent-ui/app/(dashboard)/knowledge/item/[id]/page.tsx
- Test: draftly-agent-ui/tests/knowledge-components.test.ts

Interfaces:

- KnowledgeOverviewPage consumes useKnowledge() and renders real stats plus recent list items.
- KnowledgeListPage accepts optional initial status and renders paginated/search results.
- KnowledgeDetailPage accepts { id: string } and renders one KnowledgeDetail.

- [ ] Step 1: Add failing rendering/view tests

Test loading, list success, stats success, empty result, list error with retry, detail 404, and stale-data view-model states using Node-compatible pure assertions. Assert that a fixture title/entity and real timestamp are selected and strings such as 1,248, 324, Authly, or 12 min ago are not default data. JSX compilation and route wiring are verified by npx tsc --noEmit and npm run build.

- [ ] Step 2: Run the focused UI tests to verify failure

Run:

~~~bash
cd draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
~~~

Expected: FAIL because the new components/routes do not exist.

- [ ] Step 3: Extract the overview controller from the static page

Replace hardcoded metric values with backend stats. Use defensible cards: total Knowledge items, verified, needs verification, and stale. The recent table must use items, order supplied by the API, and link to /knowledge/item/{id}. Render "No Knowledge items found." when empty and an actionable retry state when the request fails.

- [ ] Step 4: Replace the static document/list subroute

For /knowledge/documents, render KnowledgeListPage. Add controlled status filters, a submit-on-Enter search action using searchKnowledge, bounded pagination, encoded links, and relative timestamps. Remove the docs import from this route.

- [ ] Step 5: Add the conflict-free detail route

Create /knowledge/item/[id]/page.tsx and render KnowledgeDetailPage. Show entity/content, status, confidence, importance, created/updated dates, sources, relations, and feedback. Empty arrays must display explicit messages such as "No source evidence recorded yet." and "No relationships recorded yet.".

- [ ] Step 6: Remove static overview/list data and no-op actions

Delete the static graph/source/topic/percentage panels from the first vertical slice or replace them with honest placeholders until their read models are available. The Add source and Import source buttons must be disabled with a visible "Source import is not available yet" explanation or removed; they must not look functional while doing nothing.

- [ ] Step 7: Run UI tests/build and commit

Run:

~~~bash
cd draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
npx tsc --noEmit
npm run build
~~~

Commit:

~~~bash
git add "app/(dashboard)/knowledge/page.tsx" "app/(dashboard)/knowledge/[section]/page.tsx" "app/(dashboard)/knowledge/item/[id]/page.tsx" components/sections/knowledge tests/knowledge-components.test.ts
git commit -m "feat(ui): render knowledge overview and detail from live data"
~~~

### Task 5: Add dynamic provenance/source summaries

Files:

- Modify: draftly-agent-backend/src/draftly/app/api/routes/knowledge.py
- Modify: draftly-agent-backend/src/draftly/persistence/repositories/knowledge.py
- Modify: draftly-agent-backend/src/draftly/app/api/knowledge_schemas.py
- Modify: draftly-agent-backend/tests/api/test_knowledge_routes.py
- Modify: draftly-agent-ui/api/knowledge.ts
- Modify: draftly-agent-ui/hooks/use-knowledge-surfaces.ts
- Create: draftly-agent-ui/components/sections/knowledge/knowledge-sources.tsx
- Modify: draftly-agent-ui/app/(dashboard)/knowledge/[section]/page.tsx
- Test: draftly-agent-ui/tests/knowledge-sources.test.ts

Interfaces:

- GET /api/knowledge/sources returns KnowledgeSourceSummary[] with source_type, repository, item_count, last_seen_at, and evidence_count.
- The UI labels the page Source evidence and statuses as Observed/No evidence; it does not claim integration connectivity.

- [ ] Step 1: Add failing backend source-summary tests

Assert organization filtering, deterministic ordering by item_count DESC, source_type ASC, and zero-result behavior. Include two organizations with the same source_type and assert that only the token organization is returned.

- [ ] Step 2: Implement a grouped source query

Group memory_sources by org_id, source_type, and repository, joining only to memory_items in the Knowledge namespace. Return counts and MAX(created_at) without returning evidence bodies by default. Keep individual evidence in detail only.

- [ ] Step 3: Wire the API wrapper/hook and render source cards

Replace the static provider array and hardcoded indexed-item counts. Use a provider icon fallback based on source_type, render "No source evidence has been recorded." when empty, and show last-seen relative time from last_seen_at.

- [ ] Step 4: Run tests and commit

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/api/test_knowledge_routes.py -q
uv run ruff check src/draftly/app/api/routes/knowledge.py src/draftly/persistence/repositories/knowledge.py
cd ../draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
npx tsc --noEmit
git diff --check
~~~

Commit backend and UI changes separately with feat(api): add Knowledge source summaries and feat(ui): render Knowledge source evidence.

### Task 6: Add dynamic graph and topic surfaces without fabricating taxonomy

Files:

- Modify: draftly-agent-backend/src/draftly/app/api/knowledge_schemas.py
- Modify: draftly-agent-backend/src/draftly/persistence/repositories/knowledge.py
- Modify: draftly-agent-backend/src/draftly/app/api/routes/knowledge.py
- Modify: draftly-agent-backend/tests/api/test_knowledge_routes.py
- Create: draftly-agent-ui/components/sections/knowledge/knowledge-graph.tsx
- Create: draftly-agent-ui/components/sections/knowledge/knowledge-topics.tsx
- Modify: draftly-agent-ui/api/knowledge.ts
- Modify: draftly-agent-ui/hooks/use-knowledge-surfaces.ts
- Modify: draftly-agent-ui/app/(dashboard)/knowledge/[section]/page.tsx
- Test: draftly-agent-ui/tests/knowledge-graph-topics.test.ts

Interfaces:

- GET /api/knowledge/graph?limit_nodes=100&limit_edges=200 returns { nodes, edges }, with node id, label, status, memory_type, and edge source, target, relationship, confidence.
- GET /api/knowledge/topics?limit=20 returns { items: [{ name, item_count, verified_count, stale_count }] } from persisted topic metadata only.

- [ ] Step 1: Add failing graph/topic contract tests

Test that graph nodes and edges are organization-scoped, limits are bounded, edge endpoints are present in the node set, and topic counts do not include rows from another organization. Test that missing topic metadata yields an empty list rather than keyword-generated labels.

- [ ] Step 2: Implement graph reads with bounded joins

Select the newest/highest-importance Knowledge items as nodes, then select matching organization-scoped links as edges. Do not issue one query per edge. If a link points to an item outside the selected node set, omit the edge from the bounded response.

- [ ] Step 3: Implement topic aggregation from a documented metadata shape

Use the persisted shape metadata.topics: string[]; normalize whitespace, discard empty strings, and aggregate counts in SQL or a bounded repository result. Do not infer topics from content in a request handler. Add a separate pipeline task only if the product later requires writing taxonomy metadata.

- [ ] Step 4: Render accessible graph/topic UI

Use a deterministic SVG/radial layout without a new graph dependency. Provide a semantic table/list fallback for keyboard and screen-reader users. Render an honest empty state when no links/topics exist. Remove the static coordinates, labels, legend, and coverage percentages.

- [ ] Step 5: Run focused tests, build, and commit

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/api/test_knowledge_routes.py -q
cd ../draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
npx tsc --noEmit
npm run build
git diff --check
~~~

Commit backend and UI changes separately.

### Task 7: Add safe embedding coverage instead of exposing vectors

Files:

- Modify: draftly-agent-backend/src/draftly/app/api/knowledge_schemas.py
- Modify: draftly-agent-backend/src/draftly/persistence/repositories/knowledge.py
- Modify: draftly-agent-backend/src/draftly/app/api/routes/knowledge.py
- Modify: draftly-agent-backend/tests/api/test_knowledge_routes.py
- Create: draftly-agent-ui/components/sections/knowledge/knowledge-embeddings.tsx
- Modify: draftly-agent-ui/api/knowledge.ts
- Modify: draftly-agent-ui/hooks/use-knowledge-surfaces.ts
- Modify: draftly-agent-ui/app/(dashboard)/knowledge/[section]/page.tsx
- Test: draftly-agent-ui/tests/knowledge-embeddings.test.ts

Interfaces:

- GET /api/knowledge/embeddings returns KnowledgeEmbeddingStats with total_items, embedded_items, coverage_percent, models, and last_embedded_at.

- [ ] Step 1: Add failing backend tests

Assert that counts are restricted to memory_items.namespace = Knowledge and the token organization, that missing embeddings reduce coverage, and that the serialized response contains no embedding key.

- [ ] Step 2: Implement aggregate coverage query

Use COUNT(DISTINCT mi.id) and COUNT(DISTINCT me.memory_item_id) over an organization-scoped join. Return model names and the newest embedding timestamp only. Do not select vector columns.

- [ ] Step 3: Render coverage UI

Replace the static explanatory panel with real coverage metrics, model labels, and an explicit empty state. Do not render fake vector samples or a chart whose values are not backed by a read API.

- [ ] Step 4: Run tests and commit

Run:

~~~bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/api/test_knowledge_routes.py -q
cd ../draftly-agent-ui
npm test -- --test-name-pattern="knowledge"
npx tsc --noEmit
npm run build
~~~

Commit both repositories separately.

### Task 8: Production verification, documentation, and graph refresh

Files:

- Modify: draftly-agent-ui/README.md
- Modify: draftly-agent-backend/docs/api/routes.md
- Modify: draftly-agent-ui/tests/knowledge-components.test.ts
- Modify: draftly-agent-backend/tests/api/test_knowledge_routes.py

- [ ] Step 1: Run complete offline backend verification

From draftly-agent-backend:

~~~bash
DRAFTLY_LIVE=0 uv run pytest -m "not integration"
uv run ruff check .
uv run ruff format --check .
uv run mypy src
~~~

- [ ] Step 2: Run complete UI verification

From draftly-agent-ui:

~~~bash
npm test
npx tsc --noEmit
npm run build
~~~

Manually verify /knowledge, /knowledge/documents, /knowledge/sources, /knowledge/graph, /knowledge/topics, /knowledge/embeddings, and /knowledge/item/{id} with a populated organization, an empty organization, a backend outage, an expired Clerk token, a foreign item ID, and a long/blank search query.

- [ ] Step 3: Verify live API behavior with an authenticated organization

Run the backend and UI through their normal API rewrite. Confirm:

~~~bash
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/knowledge?limit=25
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/knowledge/stats
curl -H "Authorization: Bearer <token>" 'http://localhost:8000/api/knowledge/search?q=oauth&limit=10'
~~~

Check that totals match direct organization-scoped database counts, no response contains an embedding vector, foreign IDs return 404, and source/link/feedback records cannot cross organization boundaries.

- [ ] Step 4: Update docs and remove stale claims

Document that Knowledge reads require a running backend, Clerk token with active org_id, and populated memory tables. State that source cards represent provenance evidence, graph/topics may be empty when the pipeline has not emitted relations/taxonomy, and source import remains unsupported unless separately wired.

- [ ] Step 5: Refresh both knowledge graphs

Run once from each modified repository:

~~~bash
cd draftly-agent-backend
graphify update .
cd ../draftly-agent-ui
graphify update .
~~~

- [ ] Step 6: Perform final diff and status review

Run git diff --check and git status --short in both repositories. Confirm no mock Knowledge imports remain in the dashboard routes:

~~~bash
cd draftly-agent-ui
rg -n 'from "@/lib/mock-data"|knowledgeTopics|1,248|324|GitHub 42%|Authly' "app/(dashboard)/knowledge" components/sections/knowledge
~~~

The command must return no Knowledge-page data fixtures. Existing unrelated mock data elsewhere in the UI may remain for its own migration.
