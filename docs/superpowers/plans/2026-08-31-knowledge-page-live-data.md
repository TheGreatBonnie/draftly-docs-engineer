# Knowledge Page Live Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded static data in the Draftly Knowledge UI with live data from the NeonDB memory tables, served by a new backend `/api/knowledge` read API.

**Architecture:** Add a FastAPI `knowledge` router (mirroring the existing `observability`/`documentation` router patterns) that reads curated knowledge from the `memory_items` + `memory_embeddings` tables (with provenance from `memory_sources`, relations from `memory_links`, and audit from `memory_feedback`). Expose typed endpoints (`list`, `stats`, `search`, `detail`). In the Next.js frontend, add an `api/knowledge.ts` client (mirroring `api/observability.ts`) and wire the four existing static components (`knowledge.tsx`, `knowledge-stats.tsx`, `knowledge-list.tsx`, `knowledge-detail.tsx`) to fetch from it via the existing authenticated `request()` client and a small effect-based hook.

**Tech Stack:** Python 3.11 + FastAPI + asyncpg (NeonDB) on backend; Next.js 16 + React 19 + TypeScript + vitest on frontend.

**Spec:** Session analysis of the NeonDB schema and the frontend knowledge page static components.

## Global Constraints

- Only add **read** endpoints — no writes/mutations. (Knowledge is produced by the agent pipeline; this plan only surfaces it.)
- Mirror existing conventions exactly: router with `prefix="/knowledge"`, `tags=["knowledge"]`, `dependencies=[Depends(get_verified_token)]`; resolve repos via `request.app.state.draftly.dependencies.repositories...`; no new dependencies.
- Scope all queries by `org_id` from the verified token (JWT claim `token["org_id"]`), matching existing routes.
- Reuse the existing `DatabaseMemoryStore`, `VectorSearch`, `MemorySourcesStore`, `MemoryLinksStore`, `MemoryFeedbackStore`, and persistence `MemoryRepository`. Add minimal read methods to stores only where a needed method is missing.
- Frontend: use the existing `request()` client from `api/client.ts` and an `api/knowledge.ts` module; no new runtime deps.
- Frontend caution: the repo's Next.js 16 has breaking API changes vs. training data. Before writing frontend code, read the relevant guide in `draftly-agent-frontend/node_modules/next/dist/docs/` (see `draftly-agent-frontend/AGENTS.md`). Existing hook-test patterns use `renderHook`/`waitFor`/`act` from `@testing-library/react` in `draftly-agent-frontend/tests/lib/*.test.tsx`.
- Status mapping (verified / needs-verification / stale): `active` status + `confidence >= 0.5` → `verified`; `active` + `confidence < 0.5` → `needs-verification`; non-active status (`superseded`/`archived`) → `stale`. Keep in a single backend helper. (Threshold lowered from 0.7 by product decision 2026-08-31: all live knowledge items carry the default `confidence=0.5`, so `>=0.7` would show `verified=0`.)
- Return ISO-8601 strings; format relative ("2 min ago") on the frontend.
- Never return raw `embedding` vectors to the UI; for search, include only the `similarity` scalar.
- Do NOT ship the mock numbers. Stats must come from real `COUNT` aggregates.

---

### Task 1: Backend — add `knowledge` router module

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/routes/knowledge.py`
- Test: `draftly-agent-backend/tests/api/test_knowledge_routes.py`

**Interfaces:**
- Consumes: persistence `MemoryRepository` at `request.app.state.draftly.dependencies.repositories.memory`; it exposes `list_namespace(namespace=..., org_id=None)`, `semantic_search(namespace=..., embedding=..., limit=..., org_id=...)`, `get(memory_id=...)`.
  - **Requires a small change** (done in this task, Step 3a): add an optional `org_id` filter to `DatabaseMemoryStore.list_namespace` and thread it through `persistence/repositories/memory.py::MemoryRepository.list_namespace`. This matches the existing org-scoped pattern used by `documentation.py` and satisfies the Global Constraint to scope all reads by `org_id`. Without it, `list_namespace` returns knowledge across all orgs.
- Produces: `router` (`fastapi.APIRouter`, `prefix="/knowledge"`), helper `derive_status(record)`, endpoints `GET /knowledge` and `GET /knowledge/{item_id}`. Later tasks extend with `stats`/`search`/detail enrichment.

- [ ] **Step 1: Write the failing route test**

Create `tests/api/test_knowledge_routes.py` mirroring `tests/api/test_observability_routes.py`:

```python
"""Knowledge read endpoints."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from draftly.app.api.auth import get_verified_token
from draftly.app.api.routes.knowledge import router

ITEM = {
    "id": "11111111-1111-1111-1111-111111111111",
    "org_id": "org-1",
    "namespace": "knowledge",
    "memory_type": "knowledge",
    "content": "authly.tokens attribute provides access to TokenService",
    "summary": None,
    "status": "active",
    "importance": 0.5,
    "confidence": 0.9,
    "version": 1,
    "access_count": 3,
    "last_accessed_at": "2026-08-30T12:00:00Z",
    "created_at": "2026-08-29T12:00:00Z",
    "updated_at": "2026-08-30T12:00:00Z",
}

ITEM_LOW_CONF = {**ITEM, "id": "22222222-2222-2222-2222-222222222222", "confidence": 0.4}


class FakeMemoryRepo:
    def __init__(self, items: list[dict[str, Any]]):
        self._items = items

    async def list_namespace(
        self, *, namespace: str, org_id: str | None = None
    ) -> list[dict[str, Any]]:
        return [i for i in self._items if org_id is None or i.get("org_id") == org_id]

    async def get(self, memory_id: str) -> dict[str, Any] | None:
        return next((i for i in self._items if i["id"] == memory_id), None)


def make_app(items: list[dict[str, Any]] | None = None) -> FastAPI:
    repos = SimpleNamespace(memory=FakeMemoryRepo(items or [ITEM, ITEM_LOW_CONF]))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-1"}
    app.state.draftly = SimpleNamespace(dependencies=SimpleNamespace(repositories=repos))
    return app


def test_list_knowledge_maps_status() -> None:
    client = TestClient(make_app())
    resp = client.get("/knowledge")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 2
    by_id = {i["id"]: i for i in items}
    assert by_id[ITEM["id"]]["status"] == "verified"
    assert by_id[ITEM_LOW_CONF["id"]]["status"] == "needs-verification"


def test_list_is_scoped_to_org() -> None:
    # A foreign-org item must not leak into the token org's list.
    foreign = {**ITEM, "id": "33333333-3333-3333-3333-333333333333", "org_id": "org-2"}
    client = TestClient(make_app([ITEM, foreign]))
    resp = client.get("/knowledge")
    items = resp.json()["items"]
    assert all(i["id"] != foreign["id"] for i in items)
    assert len(items) == 1


def test_list_filters_by_status() -> None:
    client = TestClient(make_app())
    resp = client.get("/knowledge", params={"status": "verified"})
    body = resp.json()
    assert all(i["status"] == "verified" for i in body["items"])


def test_get_unknown_returns_404() -> None:
    client = TestClient(make_app(items=[]))
    resp = client.get("/knowledge/99999999-9999-9999-9999-999999999999")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py -v` (from `draftly-agent-backend`)
Expected: FAIL with `ModuleNotFoundError: No module named 'draftly.app.api.routes.knowledge'`

- [ ] **Step 3: Write minimal router implementation**

Create `src/draftly/app/api/routes/knowledge.py`:

```python
"""Knowledge read endpoints — surface curated memory_items to the UI."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from draftly.app.api.auth import get_verified_token
from draftly.memory.repository import MemoryNamespaces

router = APIRouter(
    prefix="/knowledge",
    tags=["knowledge"],
    dependencies=[Depends(get_verified_token)],
)

VERIFIED_THRESHOLD = 0.5


def derive_status(record: dict[str, Any]) -> str:
    """Map a memory record to a UI status (verified / needs-verification / stale)."""
    if record.get("status") not in ("active", None):
        return "stale"
    confidence = float(record.get("confidence", 0.0))
    return "verified" if confidence >= VERIFIED_THRESHOLD else "needs-verification"


def _memory_repo(request: Request) -> Any:
    repos = getattr(request.app.state.draftly.dependencies, "repositories", None)
    memory = getattr(repos, "memory", None) if repos else None
    if memory is None:
        raise HTTPException(status_code=503, detail="Memory store unavailable")
    return memory


def _to_list_item(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record["id"],
        "entity": record.get("summary") or record.get("content"),
        "description": record.get("summary"),
        "status": derive_status(record),
        "importance": record.get("importance"),
        "confidence": record.get("confidence"),
        "updated_at": record.get("updated_at"),
        "created_at": record.get("created_at"),
        "namespace": record.get("namespace"),
        "memory_type": record.get("memory_type"),
    }


@router.get("")
async def list_knowledge(
    request: Request,
    status: str | None = None,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """List curated knowledge items, optionally filtered by derived status."""
    memory = _memory_repo(request)
    records = await memory.list_namespace(
        namespace=MemoryNamespaces.KNOWLEDGE,
        org_id=token.get("org_id"),
    )
    items = [_to_list_item(r) for r in records]
    if status:
        items = [i for i in items if i["status"] == status]
    return {"items": items}


@router.get("/{item_id}")
async def get_knowledge_item(
    item_id: str,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Fetch one knowledge item plus its provenance and related entities."""
    memory = _memory_repo(request)
    record = await memory.get(memory_id=item_id)
    org_id = token.get("org_id")
    if (
        record is None
        or record.get("namespace") != MemoryNamespaces.KNOWLEDGE
        or (org_id and record.get("org_id") != org_id)
    ):
        raise HTTPException(status_code=404, detail=f"Knowledge {item_id} not found")
    return {
        "id": record["id"],
        "entity": record.get("summary") or record.get("content"),
        "description": record.get("content"),
        "status": derive_status(record),
        "importance": record.get("importance"),
        "confidence": record.get("confidence"),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
        "sources": [],   # populated in Task 3
        "related": [],
    }
```

Note: route ordering matters — `@router.get("")` (list) must be declared before `@router.get("/{item_id}")` so `/knowledge/stats` and `/knowledge/search` (added in Task 2) are not shadowed by the path param. The `""` list route and the literal `/stats`/`/search` routes all precede `/{item_id}`.

- [ ] **Step 3a: Add `org_id` filter to the memory list path**

The router calls `memory.list_namespace(namespace=..., org_id=...)`, but the persistence path does not yet accept `org_id`. Mirror the org-scoped pattern from `documentation.py` (which uses an org-scoped list method). Make these two small edits:

1. Modify `draftly-agent-backend/src/draftly/integrations/database/memory_store.py` — add an optional `org_id` to `list_namespace`:

```python
    async def list_namespace(
        self,
        *,
        namespace: str,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if org_id is not None:
            rows = await self.client.fetch_all(
                f"""
                SELECT {_MEMORY_COLUMNS}
                FROM memory_items
                WHERE namespace = $1 AND org_id = $2
                ORDER BY importance DESC
                """,
                namespace,
                org_id,
            )
        else:
            rows = await self.client.fetch_all(
                f"""
                SELECT {_MEMORY_COLUMNS}
                FROM memory_items
                WHERE namespace = $1
                ORDER BY importance DESC
                """,
                namespace,
            )
        return [self._row_to_memory(row) for row in rows]
```

2. Modify `draftly-agent-backend/src/draftly/persistence/repositories/memory.py` — thread `org_id` through `MemoryRepository.list_namespace`:

```python
    async def list_namespace(
        self,
        *,
        namespace: str,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        return await self.store.list_namespace(namespace=namespace, org_id=org_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py -v`
Expected: All 4 tests PASS (list statuses, org-scoping, status filter, 404).

- [ ] **Step 5: Register the router in the app**

Modify `src/draftly/app/api/app.py`: import `knowledge` in the `from draftly.app.api.routes import (...)` block and add `app.include_router(knowledge.router, prefix="/api")` after the `runs` include.

- [ ] **Step 6: Run route smoke + lint**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_routes_smoke.py -v` then the project lint command (check `pyproject.toml` for the exact command; likely `ruff check`).
Expected: PASS, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add tests/api/test_knowledge_routes.py src/draftly/app/api/routes/knowledge.py src/draftly/app/api/app.py \
  src/draftly/integrations/database/memory_store.py src/draftly/persistence/repositories/memory.py
git commit -m "feat(api): add knowledge read router"
```

---

### Task 2: Backend — stats endpoint + vector-search endpoint

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/knowledge.py`
- Test: `draftly-agent-backend/tests/api/test_knowledge_routes.py`

**Interfaces:**
- Consumes: `_memory_repo(request)`, `derive_status`, `_to_list_item` from Task 1; `MemoryRepository.semantic_search(...)`; `EmbeddingService` from `draftly.memory.embeddings`.
- Produces: `GET /knowledge/stats` → `{total, verified, needs_verification, stale}`; `GET /knowledge/search?q=&limit=` → `{query, items: [...]}` reusing `_to_list_item` plus a `similarity` score per item.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_knowledge_routes.py`:

```python
def test_stats_counts_by_derived_status() -> None:
    client = TestClient(make_app())
    resp = client.get("/knowledge/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["verified"] == 1
    assert body["needs_verification"] == 1
    assert body["stale"] == 0


class FakeSearchMemoryRepo(FakeMemoryRepo):
    def __init__(self, items, search_result):
        super().__init__(items)
        self._search_result = search_result

    async def semantic_search(self, *, namespace, embedding, limit, org_id=None):
        return self._search_result


def make_search_app() -> FastAPI:
    class FakeEmbedService:
        async def embed(self, text: str) -> list[float]:
            return [0.1, 0.2]

    repo = FakeSearchMemoryRepo([ITEM], [])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-1"}
    app.state.draftly = SimpleNamespace(
        dependencies=SimpleNamespace(repositories=SimpleNamespace(memory=repo)),
        embeddings=FakeEmbedService(),
    )
    return app


def test_search_returns_items() -> None:
    client = TestClient(make_search_app())
    resp = client.get("/knowledge/search", params={"q": "tokens"})
    assert resp.status_code == 200
    assert resp.json()["items"] == []


def test_search_requires_query() -> None:
    client = TestClient(make_search_app())
    resp = client.get("/knowledge/search", params={"q": "   "})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py -v`
Expected: FAIL — `GET /knowledge/stats` and `/knowledge/search` return 404 (routes not defined) or are shadowed by `/{item_id}`.

- [ ] **Step 3: Implement stats + search endpoints**

In `knowledge.py`, add imports and endpoints. Because `/stats` and `/search` are literal and `/{item_id}` is a path param, `/{item_id}` must be declared AFTER them in the file (route matching is by declaration order in FastAPI). Add:

```python
from draftly.memory.embeddings import EmbeddingService


def _embedder(request: Request) -> Any:
    draftly = getattr(request.app.state, "draftly", None)
    injected = getattr(draftly, "embeddings", None)
    return injected or EmbeddingService()


@router.get("/stats")
async def knowledge_stats(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Aggregate counts for the knowledge dashboard cards."""
    memory = _memory_repo(request)
    records = await memory.list_namespace(
        namespace=MemoryNamespaces.KNOWLEDGE,
        org_id=token.get("org_id"),
    )
    total = len(records)
    verified = sum(1 for r in records if derive_status(r) == "verified")
    needs = sum(1 for r in records if derive_status(r) == "needs-verification")
    stale = total - verified - needs
    return {
        "total": total,
        "verified": verified,
        "needs_verification": needs,
        "stale": stale,
    }


@router.get("/search")
async def search_knowledge(
    request: Request,
    q: str,
    limit: int = 20,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Semantic search over curated knowledge items."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Missing query parameter 'q'")
    memory = _memory_repo(request)
    embedder = _embedder(request)
    embedding = await embedder.embed(q)
    results = await memory.semantic_search(
        namespace=MemoryNamespaces.KNOWLEDGE,
        embedding=embedding,
        limit=max(1, min(limit, 100)),
        org_id=token.get("org_id"),
    )
    items = []
    for r in results:
        item = _to_list_item(r)
        item["similarity"] = r.get("similarity")
        items.append(item)
    return {"query": q, "items": items}
```

`memory.semantic_search` (persistence `MemoryRepository` → `VectorSearch`) already filters by `status='active'` and by `org_id` when provided, so search is org-scoped and excludes non-active items automatically.

- [ ] **Step 4: Ensure detail route declared last**

Move the `@router.get("/{item_id}")` block to the end of the file (after `/stats` and `/search`). Re-run the Task 1 list/404 tests to confirm `/{item_id}` still works and does not swallow `/stats`/`/search`.

- [ ] **Step 5: Run tests + lint + smoke**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py -v`, `DRAFTLY_LIVE=0 pytest tests/api/test_routes_smoke.py -v`, and the project lint command.
Expected: ALL PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add tests/api/test_knowledge_routes.py src/draftly/app/api/routes/knowledge.py
git commit -m "feat(api): knowledge stats and search endpoints"
```

---

### Task 3: Backend — provenance + relations read methods and detail population

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/database/memory_sources_store.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/memory_links_store.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/memory_feedback_store.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/knowledge.py`
- Test: `draftly-agent-backend/tests/api/test_knowledge_routes.py`

**Interfaces:**
- Consumes: `MemorySourcesStore`, `MemoryLinksStore`, `MemoryFeedbackStore`, `DatabaseClient.fetch_all`.
- Produces:
  - `MemorySourcesStore.list_by_memory(*, org_id, memory_item_id) -> list[dict]`
  - `MemoryLinksStore.list_by_memory(*, org_id, memory_item_id) -> list[dict]`
  - `MemoryFeedbackStore.list_by_memory(*, org_id, memory_item_id) -> list[dict]`
  - `GET /knowledge/{id}` returns populated `sources`, `related`, and `feedback`.

- [ ] **Step 1: Write failing test**

Append to `test_knowledge_routes.py`:

```python
def test_get_item_includes_sources_and_related() -> None:
    repo = FakeMemoryRepo([ITEM])

    class FakeSources:
        async def list_by_memory(self, *, org_id, memory_item_id):
            return [{"source_type": "spec", "source_url": "https://x", "evidence": "e"}]

    class FakeLinks:
        async def list_by_memory(self, *, org_id, memory_item_id):
            return [{"relationship": "related", "target_memory_id": "abc"}]

    class FakeFeedback:
        async def list_by_memory(self, *, org_id, memory_item_id):
            return [{"feedback_type": "verified", "score": 1.0, "source": "FactChecker Agent"}]

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-1"}
    app.state.draftly = SimpleNamespace(
        dependencies=SimpleNamespace(
            repositories=SimpleNamespace(
                memory=repo,
                memory_sources=FakeSources(),
                memory_links=FakeLinks(),
                memory_feedback=FakeFeedback(),
            )
        )
    )
    client = TestClient(app)
    resp = client.get(f"/knowledge/{ITEM['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sources"][0]["source_type"] == "spec"
    assert body["related"][0]["relationship"] == "related"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py::test_get_item_includes_sources_and_related -v`
Expected: FAIL (`sources` is `[]` / assertion error).

- [ ] **Step 3: Add `list_by_memory` methods to stores**

In `memory_sources_store.py`, add:

```python
    async def list_by_memory(
        self,
        *,
        org_id: str | None,
        memory_item_id: str,
    ) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all(
            """
            SELECT id, org_id, memory_item_id, source_type, source_id,
                   source_url, repository, commit_sha, evidence
            FROM memory_sources
            WHERE memory_item_id = $1
              AND ($2::text IS NULL OR org_id = $2::text)
            ORDER BY created_at ASC
            """,
            memory_item_id,
            org_id,
        )
        return [dict(r) for r in rows]
```

In `memory_links_store.py`, add:

```python
    async def list_by_memory(
        self,
        *,
        org_id: str | None,
        memory_item_id: str,
    ) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all(
            """
            SELECT id, org_id, source_memory_id, target_memory_id,
                   relationship, confidence, created_at
            FROM memory_links
            WHERE source_memory_id = $1 OR target_memory_id = $1
            ORDER BY created_at DESC
            """,
            memory_item_id,
        )
        return [dict(r) for r in rows]
```

In `memory_feedback_store.py`, add:

```python
    async def list_by_memory(
        self,
        *,
        org_id: str | None,
        memory_item_id: str,
    ) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all(
            """
            SELECT id, org_id, memory_item_id, feedback_type, source,
                   score, comment, created_at
            FROM memory_feedback
            WHERE memory_item_id = $1
            ORDER BY created_at DESC
            """,
            memory_item_id,
        )
        return [dict(r) for r in rows]
```

- [ ] **Step 4: Wire the detail endpoint**

In `knowledge.py`, update `get_knowledge_item` to resolve stores (allow test injection via `repositories`, fall back to real stores) and include sources/related/feedback:

```python
from draftly.integrations.database.memory_sources_store import MemorySourcesStore
from draftly.integrations.database.memory_links_store import MemoryLinksStore
from draftly.integrations.database.memory_feedback_store import MemoryFeedbackStore
```

Inside `get_knowledge_item`, after fetching `record`:

```python
    repos = request.app.state.draftly.dependencies.repositories
    sources_store = getattr(repos, "memory_sources", None) or MemorySourcesStore()
    links_store = getattr(repos, "memory_links", None) or MemoryLinksStore()
    feedback_store = getattr(repos, "memory_feedback", None) or MemoryFeedbackStore()

    org_id = token.get("org_id")
    sources = await sources_store.list_by_memory(org_id=org_id, memory_item_id=item_id)
    related = await links_store.list_by_memory(org_id=org_id, memory_item_id=item_id)
    feedback = await feedback_store.list_by_memory(org_id=org_id, memory_item_id=item_id)

    return {
        "id": record["id"],
        "entity": record.get("summary") or record.get("content"),
        "description": record.get("content"),
        "status": derive_status(record),
        "importance": record.get("importance"),
        "confidence": record.get("confidence"),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
        "sources": sources,
        "related": related,
        "feedback": feedback,
    }
```

The real store constructors each default to `DatabaseClient()` internally, so no client arg is needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py -v`
Expected: ALL PASS.

- [ ] **Step 6: Lint**

Run: the project lint command on the changed files.
Expected: no lint errors.

- [ ] **Step 7: Commit**

```bash
git add tests/api/test_knowledge_routes.py \
  src/draftly/integrations/database/memory_sources_store.py \
  src/draftly/integrations/database/memory_links_store.py \
  src/draftly/integrations/database/memory_feedback_store.py \
  src/draftly/app/api/routes/knowledge.py
git commit -m "feat(api): knowledge detail with provenance and relations"
```

---

### Task 4: Frontend — API client module + typed models

**Files:**
- Create: `draftly-agent-frontend/api/knowledge.ts`
- Test: `draftly-agent-frontend/__tests__/api/knowledge.test.ts`

**Interfaces:**
- Consumes: `request` from `@/api/client`.
- Produces: `KnowledgeStatus`, `KnowledgeListItem`, `KnowledgeStats`, `KnowledgeDetail`, `KnowledgeSource`, `KnowledgeLink`, `KnowledgeFeedback`, and functions `listKnowledge(status?)`, `getKnowledgeStats()`, `searchKnowledge(q, limit?)`, `getKnowledgeDetail(id)` — used by Tasks 5–6.

- [ ] **Step 1: Write failing test**

First, check `draftly-agent-frontend/__tests__/api/events.test.ts` for the exact `request` mocking convention. Then create `__tests__/api/knowledge.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { listKnowledge, getKnowledgeStats, searchKnowledge, getKnowledgeDetail } from "@/api/knowledge";
import * as client from "@/api/client";

describe("api/knowledge", () => {
  beforeAll(() => {
    vi.spyOn(client, "request").mockImplementation(
      async (path: string) => path as unknown as never
    );
  });
  afterEach(() => vi.clearAllMocks());

  it("listKnowledge hits /knowledge", async () => {
    await listKnowledge();
    expect(client.request).toHaveBeenCalledWith("/knowledge");
  });

  it("listKnowledge appends status filter", async () => {
    await listKnowledge("verified");
    expect(client.request).toHaveBeenCalledWith("/knowledge?status=verified");
  });

  it("getKnowledgeStats hits /knowledge/stats", async () => {
    await getKnowledgeStats();
    expect(client.request).toHaveBeenCalledWith("/knowledge/stats");
  });

  it("searchKnowledge hits /knowledge/search with q and limit", async () => {
    await searchKnowledge("tokens", 10);
    expect(client.request).toHaveBeenCalledWith("/knowledge/search?q=tokens&limit=10");
  });

  it("getKnowledgeDetail hits /knowledge/:id", async () => {
    await getKnowledgeDetail("abc");
    expect(client.request).toHaveBeenCalledWith("/knowledge/abc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `draftly-agent-frontend`): `npx vitest run __tests__/api/knowledge.test.ts`
Expected: FAIL — module `@/api/knowledge` does not exist.

- [ ] **Step 3: Implement the client module**

Create `api/knowledge.ts`:

```ts
import { request } from "./client";

export type KnowledgeStatus = "verified" | "needs-verification" | "stale";

export interface KnowledgeListItem {
  id: string;
  entity: string | null;
  description: string | null;
  status: KnowledgeStatus;
  importance: number | null;
  confidence: number | null;
  updated_at: string | null;
  created_at: string | null;
  namespace: string;
  memory_type: string;
  similarity?: number;
}

export interface KnowledgeStats {
  total: number;
  verified: number;
  needs_verification: number;
  stale: number;
}

export interface KnowledgeSource {
  id: string;
  source_type: string;
  source_url: string | null;
  repository: string | null;
  commit_sha: string | null;
  evidence: string | null;
}

export interface KnowledgeLink {
  id: string;
  relationship: string;
  source_memory_id: string;
  target_memory_id: string;
  confidence: number | null;
}

export interface KnowledgeFeedback {
  id: string;
  feedback_type: string;
  source: string | null;
  score: number | null;
  comment: string | null;
  created_at: string | null;
}

export interface KnowledgeDetail {
  id: string;
  entity: string | null;
  description: string | null;
  status: KnowledgeStatus;
  importance: number | null;
  confidence: number | null;
  created_at: string | null;
  updated_at: string | null;
  sources: KnowledgeSource[];
  related: KnowledgeLink[];
  feedback: KnowledgeFeedback[];
}

export async function listKnowledge(
  status?: KnowledgeStatus,
): Promise<{ items: KnowledgeListItem[] }> {
  return request(status ? `/knowledge?status=${status}` : "/knowledge");
}

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  return request("/knowledge/stats");
}

export async function searchKnowledge(
  q: string,
  limit = 20,
): Promise<{ query: string; items: KnowledgeListItem[] }> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return request(`/knowledge/search?${params.toString()}`);
}

export async function getKnowledgeDetail(
  id: string,
): Promise<KnowledgeDetail> {
  return request(`/knowledge/${encodeURIComponent(id)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/api/knowledge.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint` (from `draftly-agent-frontend`).
Expected: no lint errors.

- [ ] **Step 6: Commit**

```bash
git add api/knowledge.ts __tests__/api/knowledge.test.ts
git commit -m "feat(ui): knowledge API client module"
```

---

### Task 5: Frontend — wire stats + list to live data

**Files:**
- Create: `draftly-agent-frontend/hooks/use-knowledge.ts`
- Create: `draftly-agent-frontend/lib/relative-time.ts`
- Modify: `draftly-agent-frontend/components/knowledge/knowledge.tsx`
- Modify: `draftly-agent-frontend/components/knowledge/knowledge-stats.tsx`
- Modify: `draftly-agent-frontend/components/knowledge/knowledge-list.tsx`
- Test: `draftly-agent-frontend/__tests__/hooks/use-knowledge.test.tsx`, `__tests__/lib/relative-time.test.ts`, and a `KnowledgeList` render test

**Interfaces:**
- Consumes: `listKnowledge`, `getKnowledgeStats`, `searchKnowledge`, and types from `@/api/knowledge` (Task 4).
- Produces: `useKnowledge()` hook returning `{ items, stats, loading, error, reload }`; rewired `KnowledgeStats` and `KnowledgeList` accepting live props.

- [ ] **Step 1: Write failing hook test**

Check the existing `hooks/use-dashboard-events.ts` pattern first. Create `__tests__/hooks/use-knowledge.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useKnowledge } from "@/hooks/use-knowledge";
import * as api from "@/api/knowledge";

vi.mock("@/api/knowledge", () => ({
  listKnowledge: vi.fn(),
  getKnowledgeStats: vi.fn(),
  searchKnowledge: vi.fn(),
}));

const listKnowledge = api.listKnowledge as ReturnType<typeof vi.fn>;
const getKnowledgeStats = api.getKnowledgeStats as ReturnType<typeof vi.fn>;

beforeEach(() => {
  listKnowledge.mockResolvedValue({ items: [] });
  getKnowledgeStats.mockResolvedValue({ total: 0, verified: 0, needs_verification: 0, stale: 0 });
});

describe("useKnowledge", () => {
  it("loads items and stats on mount", async () => {
    const { result } = renderHook(() => useKnowledge());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listKnowledge).toHaveBeenCalled();
    expect(getKnowledgeStats).toHaveBeenCalled();
  });

  it("exposes items", async () => {
    listKnowledge.mockResolvedValue({
      items: [{
        id: "1", entity: "E", description: null, status: "verified" as const,
        importance: 0.5, confidence: 0.9, updated_at: null, created_at: null,
        namespace: "knowledge", memory_type: "knowledge",
      }],
    });
    const { result } = renderHook(() => useKnowledge());
    await waitFor(() => expect(result.current.items.length).toBe(1));
  });
});
```

Confirm `@testing-library/react` `renderHook` and `waitFor` are available (check existing hook tests); if not, use the established fetch/assert pattern from an existing hook test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/hooks/use-knowledge.test.tsx`
Expected: FAIL — module `@/hooks/use-knowledge` missing.

- [ ] **Step 3: Implement the hook**

Create `hooks/use-knowledge.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getKnowledgeStats,
  listKnowledge,
  type KnowledgeListItem,
  type KnowledgeStats,
} from "@/api/knowledge";

interface UseKnowledge {
  items: KnowledgeListItem[];
  stats: KnowledgeStats | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useKnowledge(): UseKnowledge {
  const [items, setItems] = useState<KnowledgeListItem[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listKnowledge(), getKnowledgeStats()])
      .then(([list, stat]) => {
        if (cancelled) return;
        setItems(list.items);
        setStats(stat);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load knowledge");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { items, stats, loading, error, reload };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/hooks/use-knowledge.test.tsx`
Expected: PASS.

- [ ] **Step 4a: Add `lib/relative-time.ts` (+ unit test)**

`knowledge-list.tsx` and the Task 6 detail mapper need to render `updated_at`/`created_at` as relative strings. Create `lib/relative-time.ts`:

```ts
export function relativeTime(iso: string | null, fallback = "Unknown"): string {
  if (!iso) return fallback;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return fallback;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}
```

Create `__tests__/lib/relative-time.test.ts` covering invalid/null, now, minutes, hours, days, and "Yesterday". Run `npx vitest run __tests__/lib/relative-time.test.ts` → PASS.

- [ ] **Step 5: Wire the page + child components**

Modify `components/knowledge/knowledge.tsx`:
- Remove `import { knowledgeRows } from "./data";`
- Import `useKnowledge`; add `const { items, stats, loading, error } = useKnowledge();`
- Replace `<KnowledgeStats />` with `<KnowledgeStats stats={stats} loading={loading} />`
- Replace `<KnowledgeList rows={knowledgeRows} />` with `<KnowledgeList rows={items} loading={loading} error={error} />`

Modify `components/knowledge/knowledge-stats.tsx`:
- Accept `{ stats: KnowledgeStats | null; loading: boolean }`.
- Render `stats?.total ?? "—"`, `stats?.verified ?? "—"`, `stats?.needs_verification ?? "—"`, `stats?.stale ?? "—"`.
- Remove `import { knowledgeStats } from "./data";`.

Modify `components/knowledge/knowledge-list.tsx`:
- Change props: `rows: KnowledgeListItem[]; loading: boolean; error: string | null`.
- `import type { KnowledgeListItem } from "@/api/knowledge";` (drop `./data` `KnowledgeRow`).
- Derive `statusLabel` from `row.status`: verified → "Verified", needs-verification → "Needs Verification", stale → "Stale".
- `key` and `href` use `row.id` (no `slug`; `href={`/knowledge/${row.id}`}`).
- Keep the existing `statusStyles` map (keys already match).
- Provenance column: rows have no provenance array; the `./data` icons are deleted. Render a minimal static label instead: `row.namespace === "knowledge" ? "Local knowledge" : row.namespace` (plain `<span>`, no icon).
- Last Updated: derive from `row.updated_at` using a small relative-time formatter (`"2 min ago"`, `"Yesterday"`, etc.). Add `lib/relative-time.ts` exporting `relativeTime(iso: string | null, fallback = "Unknown"): string`; reuse in the detail mapper (Task 6) and in `knowledge.tsx`'s search results.
- Description may be `null` (live data has no `summary`) — render `{row.description ?? ""}`.
- Handle `loading` (skeleton/placeholder) and `error` (error banner).

- [ ] **Step 6: Add a KnowledgeList render test**

Create `__tests__/components/knowledge-list.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KnowledgeList } from "@/components/knowledge/knowledge-list";

const item = {
  id: "1",
  entity: "TokenService",
  description: "authly tokens",
  status: "verified" as const,
  importance: 0.5,
  confidence: 0.9,
  updated_at: "2026-08-30T12:00:00Z",
  created_at: null,
  namespace: "knowledge",
  memory_type: "knowledge",
};

describe("KnowledgeList", () => {
  it("renders live items", () => {
    render(<KnowledgeList rows={[item]} loading={false} error={null} />);
    expect(screen.getByText("TokenService")).toBeTruthy();
  });
});
```

Run: `npx vitest run __tests__/components/knowledge-list.test.tsx` → PASS.

- [ ] **Step 7: Run all frontend tests + lint**

Run: `npx vitest run` and `npm run lint` (from `draftly-agent-frontend`).
Expected: pass (existing suite stays green).

- [ ] **Step 8: Commit**

```bash
git add hooks/use-knowledge.ts lib/relative-time.ts \
  __tests__/hooks/use-knowledge.test.tsx __tests__/lib/relative-time.test.ts \
  __tests__/components/knowledge-list.test.tsx \
  components/knowledge/knowledge.tsx components/knowledge/knowledge-stats.tsx \
  components/knowledge/knowledge-list.tsx
git commit -m "feat(ui): wire knowledge stats and list to live API"
```

---

### Task 6: Frontend — wire detail page + provenance + search

**Context (verified against live DB, 2026-08-31):** `memory_sources`, `memory_links`, and `memory_feedback` are all **empty**, and every knowledge `memory_items` row has NULL `summary`/`source_type`/`source_id`. So the detail endpoint's `sources`/`related`/`feedback` will be empty arrays for every item today. Do **not** fabricate data: the detail UI must render graceful empty states, and the mapper must tolerate empty arrays.

**Files:**
- Create: `draftly-agent-frontend/lib/knowledge-detail-view.ts` (view types + `mapKnowledgeDetail`)
- Modify: `draftly-agent-frontend/components/knowledge/knowledge-detail.tsx` (fetch live in a client effect)
- Modify: `draftly-agent-frontend/components/knowledge/knowledge-detail-content.tsx` (import types from the new lib; empty states)
- Modify: `draftly-agent-frontend/components/knowledge/knowledge-list.tsx` (empty-state row)
- Modify: `draftly-agent-frontend/components/knowledge/knowledge-search.tsx` and `components/knowledge/knowledge.tsx` (live search)
- Delete: `draftly-agent-frontend/components/knowledge/data.tsx`, `knowledge-detail-data.ts`
- Test: `draftly-agent-frontend/__tests__/lib/knowledge-detail-view.test.ts`, `__tests__/components/knowledge-detail-content.test.tsx`

**Interfaces:**
- Consumes: `getKnowledgeDetail`, `searchKnowledge`, and API types from `@/api/knowledge` (Task 4); `relativeTime` from `@/lib/relative-time` (Task 5).
- Produces: a client component that fetches live detail by `id` in an effect and renders the existing rich UI via a pure view mapper. The server page (`app/(app)/knowledge/[id]/page.tsx`) stays a thin async wrapper passing only `id` — **do not fetch on the server**: `request()` depends on a client-set Clerk token and touches `window` on 401, so server-side calls fail.

- [ ] **Step 1: Write the failing mapper test**

Create `__tests__/lib/knowledge-detail-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapKnowledgeDetail } from "@/lib/knowledge-detail-view";
import type { KnowledgeDetail } from "@/api/knowledge";

const fixture: KnowledgeDetail = {
  id: "abc",
  entity: "TokenService",
  description: null,
  status: "needs-verification",
  importance: 0.5,
  confidence: 0.5,
  created_at: null,
  updated_at: "2026-08-30T12:00:00Z",
  sources: [
    { id: "s1", source_type: "github", source_url: "https://github.com/x/pr/1", repository: "x", commit_sha: "abc123", evidence: "PR evidence" },
  ],
  related: [{ id: "l1", relationship: "related", source_memory_id: "abc", target_memory_id: "def", confidence: 0.5 }],
  feedback: [{ id: "f1", feedback_type: "flagged", source: "alex", score: 0.4, comment: "recheck", created_at: "2026-08-29T10:00:00Z" }],
};

describe("mapKnowledgeDetail", () => {
  it("maps scalar fields and status label", () => {
    const v = mapKnowledgeDetail(fixture);
    expect(v.entity).toBe("TokenService");
    expect(v.status).toBe("needs-verification");
    expect(v.statusLabel).toBe("Needs Verification");
  });

  it("maps first source to primary panel", () => {
    const v = mapKnowledgeDetail(fixture);
    expect(v.sources[0].type).toBe("primary");
    expect(v.sources[0].link).toBe("https://github.com/x/pr/1");
  });

  it("maps related links into a relationship group", () => {
    const v = mapKnowledgeDetail(fixture);
    expect(v.relationships[0].tags).toContain("def");
  });

  it("maps feedback into history rows", () => {
    const v = mapKnowledgeDetail(fixture);
    expect(v.history[0].event).toBe("flagged");
    expect(v.history[0].actor).toBe("alex");
  });

  it("tolerates empty provenance arrays", () => {
    const v = mapKnowledgeDetail({ ...fixture, sources: [], related: [], feedback: [] });
    expect(v.sources).toEqual([]);
    expect(v.history).toEqual([]);
    expect((v.relationships[0]?.tags ?? []).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/lib/knowledge-detail-view.test.ts`
Expected: FAIL — module `@/lib/knowledge-detail-view` missing.

- [ ] **Step 3: Implement the view mapper**

Create `lib/knowledge-detail-view.ts`. It owns the rich view types that `knowledge-detail-content.tsx` consumes and maps the live API shape onto them:

```ts
import type {
  KnowledgeDetail,
  KnowledgeFeedback,
  KnowledgeSource,
  KnowledgeStatus,
} from "@/api/knowledge";
import { relativeTime } from "./relative-time";

export interface SourcePanel {
  type: "primary" | "supporting";
  label: string;
  title: string;
  content: string;
  link?: string;
}

export interface LineageStep {
  label: string;
  sub: string;
  active?: boolean;
  highlight?: boolean;
}

export interface RelationshipGroup {
  heading: string;
  tags: string[];
}

export interface HistoryRow {
  date: string;
  event: string;
  eventVariant: "success" | "info" | "brand" | "warning";
  actor: string;
  details: string;
}

export interface KnowledgeDetailView {
  id: string;
  entity: string | null;
  tag: string;
  description: string | null;
  status: KnowledgeStatus;
  statusLabel: string;
  lastVerified: string;
  authority: string;
  sources: SourcePanel[];
  lineage: LineageStep[];
  relationships: RelationshipGroup[];
  history: HistoryRow[];
}

const STATUS_LABELS: Record<KnowledgeStatus, string> = {
  verified: "Verified",
  "needs-verification": "Needs Verification",
  stale: "Stale",
};

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function sourceLabel(source: KnowledgeSource): string {
  switch (source.source_type?.toLowerCase()) {
    case "github":
      return "Implementation (GitHub)";
    case "slack":
      return "Context (Slack)";
    case "discord":
      return "Context (Discord)";
    default:
      return source.source_type
        ? `Context (${source.source_type})`
        : "Supporting Source";
  }
}

function mapSource(source: KnowledgeSource, index: number): SourcePanel {
  if (index === 0) {
    return {
      type: "primary",
      label: "Primary Source Evidence",
      title: source.source_url ?? source.repository ?? source.source_type ?? "Source",
      content: source.evidence ?? source.source_type ?? "",
      link: source.source_url ?? undefined,
    };
  }
  return {
    type: "supporting",
    label: sourceLabel(source),
    title: source.repository ?? source.source_url ?? source.source_type ?? "Source",
    content: source.evidence ?? source.source_type ?? "",
    link: source.source_url ?? undefined,
  };
}

function mapHistory(feedback: KnowledgeFeedback[]): HistoryRow[] {
  return feedback.map((f) => ({
    date: relativeTime(f.created_at),
    event: f.feedback_type,
    eventVariant:
      f.feedback_type === "verified"
        ? "success"
        : f.feedback_type === "flagged"
          ? "warning"
          : f.feedback_type === "updated"
            ? "info"
            : "brand",
    actor: f.source ?? "reviewer",
    details:
      f.comment ?? (f.score !== null && f.score !== undefined ? `Score ${f.score}` : ""),
  }));
}

export function mapKnowledgeDetail(detail: KnowledgeDetail): KnowledgeDetailView {
  const authority =
    detail.confidence === null || detail.confidence === undefined
      ? "Unknown"
      : detail.confidence >= 0.9
        ? "High authority"
        : detail.confidence >= 0.7
          ? "Medium authority"
          : "Low authority";
  return {
    id: detail.id,
    entity: detail.entity,
    tag: "Knowledge",
    description: detail.description,
    status: detail.status,
    statusLabel: STATUS_LABELS[detail.status],
    lastVerified: relativeTime(detail.updated_at ?? detail.created_at),
    authority,
    sources: detail.sources.map(mapSource),
    lineage: [
      { label: "Memory", sub: "Source Material" },
      { label: "Knowledge Item", sub: "Current Entity", active: true },
      {
        label: STATUS_LABELS[detail.status],
        sub: "Status applied",
        highlight: detail.status === "verified",
      },
    ],
    relationships: [
      {
        heading: "Related Entities",
        tags: detail.related.map((r) =>
          shortId(r.target_memory_id === detail.id ? r.source_memory_id : r.target_memory_id),
        ),
      },
    ],
    history: mapHistory(detail.feedback),
  };
}
```

Note: `/knowledge` list pages link to detail by full UUID; `shortId` only affects the Relationships tags display.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/lib/knowledge-detail-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Make the detail page fetch live data (client-side)**

Keep `app/(app)/knowledge/[id]/page.tsx` unchanged (thin async wrapper passing `id`). Rewrite `components/knowledge/knowledge-detail.tsx`:

- Remove `import { knowledgeDetails } from "./knowledge-detail-data";`.
- Add state: `detail: KnowledgeDetailView | null`, `status: "loading" | "error" | "ready"`.
- `useEffect` on `[id]`: `getKnowledgeDetail(id).then((d) => { setDetail(mapKnowledgeDetail(d)); setStatus("ready"); }).catch(() => setStatus("error"))`, with a `cancelled` guard.
- Keep the existing Sidebar/Topbar/dark-mode layout; `subtitle` from `detail?.entity`.
- Body: while `loading` render "Loading…"; on `error` render "Couldn't load knowledge entry"; when `ready` and `detail` render `<KnowledgeDetailContent item={detail} />`.

- [ ] **Step 6: Adapt `knowledge-detail-content.tsx` to the view shape + empty states**

Change only the type import (drop the `./knowledge-detail-data` import):

```ts
import type {
  KnowledgeDetailView,
  LineageStep,
  RelationshipGroup,
  SourcePanel,
} from "@/lib/knowledge-detail-view";
```

and the component signature `export function KnowledgeDetailContent({ item }: { item: KnowledgeDetailView })`. The JSX (status badge, `item.statusLabel`, `item.entity`, `item.description`, sources grid, lineage, relationships, history table) is otherwise unchanged.

Add graceful empty states (backend arrays are empty in the current DB):
- In the sources column: `{primary.length === 0 && supporting.length === 0 && (<p className="text-sm text-slate-500">No source evidence recorded for this item yet.</p>)}` before the grid.
- In `Relationships`: when `groups.every((g) => g.tags.length === 0)` render `<p className="text-sm text-slate-500">No relationships recorded yet.</p>` instead of the tag pills.
- In the history table: when `item.history.length === 0` render a single `<tr><td colSpan={4} className="px-4 py-3 text-slate-500">No verification history yet.</td></tr>`.

- [ ] **Step 7: Add a detail-content render test**

Create `__tests__/components/knowledge-detail-content.test.tsx` using a `KnowledgeDetailView` fixture (ordered like the mapper output, not the API shape):

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KnowledgeDetailContent } from "@/components/knowledge/knowledge-detail-content";
import type { KnowledgeDetailView } from "@/lib/knowledge-detail-view";

const view: KnowledgeDetailView = {
  id: "1",
  entity: "TokenService",
  tag: "Knowledge",
  description: "authly tokens access",
  status: "verified",
  statusLabel: "Verified",
  lastVerified: "2 min ago",
  authority: "Medium authority",
  sources: [{ type: "primary", label: "Primary Source Evidence", title: "https://x", content: "RFC evidence", link: "https://x" }],
  lineage: [{ label: "Knowledge Item", sub: "Current Entity", active: true }],
  relationships: [{ heading: "Related Entities", tags: [] }],
  history: [],
};

describe("KnowledgeDetailContent", () => {
  it("renders entity, description, status, and the primary source", () => {
    render(<KnowledgeDetailContent item={view} />);
    expect(screen.getByText("TokenService")).toBeTruthy();
    expect(screen.getByText("authly tokens access")).toBeTruthy();
    expect(screen.getByText("RFC evidence")).toBeTruthy();
  });
});
```

Another test renders the empty state: `view.sources = []; view.history = []` and `expect(screen.getByText(/No source evidence recorded/)).toBeTruthy()` and `expect(screen.getByText(/No verification history/)).toBeTruthy()`.

Run: `npx vitest run __tests__/components/knowledge-detail-content.test.tsx` → PASS.

- [ ] **Step 8: Render real provenance/metadata in the list**

Update the `KnowledgeList` provenance column (from Task 5) to also show relative time reliably, and add an empty-state row: when `rows.length === 0 && !loading`, render `<div className="px-5 py-4 text-sm text-slate-500">No knowledge found.</div>`. Add a matching assertion to `__tests__/components/knowledge-list.test.tsx`.

- [ ] **Step 9: Wire search to `searchKnowledge`**

Modify `components/knowledge/knowledge-search.tsx` to accept `{ onSearch?: (q: string) => void; searching?: boolean }`. Keep the decorative suggestions, but make them buttons that call `onSearch(s)`. Submit on Enter triggers `onSearch(query)`.

In `components/knowledge/knowledge.tsx`:
- Add `searchResults: KnowledgeListItem[] | null` and `searching` state.
- `handleSearch(q)`: trim; if empty clear (`setSearchResults(null)`); else `setSearching(true); searchKnowledge(q).then((r) => setSearchResults(r.items)).finally(() => setSearching(false))`.
- Pass `<KnowledgeSearch onSearch={handleSearch} searching={searching} />`.
- Render `<KnowledgeList rows={searchResults ?? items} loading={loading || searching} error={error} />`.
- Add a "Clear search" button visible when `searchResults !== null`.

- [ ] **Step 10: Remove dead static data modules**

Delete `components/knowledge/data.tsx` and `components/knowledge/knowledge-detail-data.ts`. Then `grep` for `from "./data"` / `knowledge-detail-data` / `>/knowledge/`** slug references and `knowledgeRows` / `knowledgeStats` / `knowledgeDetails` across `components/knowledge` and `app/(app)/knowledge` and confirm no remaining imports. If any other component still imports them, adjust that import first.

- [ ] **Step 11: Run all frontend tests + lint**

Run (from `draftly-agent-frontend`): `npx vitest run`, `npm run lint`.
Expected: all pass; no orphan imports; typecheck clean (`npx tsc --noEmit` if configured).

- [ ] **Step 12: Commit**

```bash
git add lib/knowledge-detail-view.ts __tests__/lib/knowledge-detail-view.test.ts \
  __tests__/components/knowledge-detail-content.test.tsx \
  components/knowledge/knowledge-detail.tsx components/knowledge/knowledge-detail-content.tsx \
  components/knowledge/knowledge-list.tsx components/knowledge/knowledge-search.tsx \
  components/knowledge/knowledge.tsx
git rm components/knowledge/data.tsx components/knowledge/knowledge-detail-data.ts
git commit -m "feat(ui): live knowledge detail, provenance, and search"
```

---

### Task 7: End-to-end verification

**Files:**
- Verify only (no new code unless a bug surfaces).

**Interfaces:** Rely on all prior tasks.

- [ ] **Step 1: Launch backend**

From `draftly-agent-backend`, run the app (check `pyproject.toml`/Makefile for the dev command). Confirm `GET /api/knowledge/stats` returns real totals from NeonDB:
```
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/knowledge/stats
```
Expected (verified against live DB on 2026-08-31): knowledge namespace = 714 items, all `status='active'` with `confidence=0.5`. With the product-approved `>= 0.5` threshold that yields `{"total": 714, "verified": 714, "needs_verification": 0, "stale": 0}`. The absolute total ≠ 843 (843 includes `document_chunk`).

- [ ] **Step 2: Launch frontend**

From `draftly-agent-frontend`, run the dev server. Navigate to the Knowledge page. Confirm:
- Stat cards show real counts (not 12,842) — i.e. total 714, verified 714.
- The list shows real knowledge entities (e.g. "authly.tokens attribute provides access...").
- Clicking a row navigates to `/knowledge/{id}` and the detail page renders entity, description, status, and **honest empty states** for Sources ("No source evidence recorded yet"), Relationships, and Verification History — the provenance tables are currently empty in the DB, so blank panels are correct.
- Search returns live semantic results for a real query.

- [ ] **Step 3: Backend route tests + lint again**

Run: `DRAFTLY_LIVE=0 pytest tests/api/test_knowledge_routes.py -v` (backend) and `npx vitest run` + `npm run lint` (frontend).
Expected: all green.

- [ ] **Step 4: Commit any fixes**

If verification surfaced bugs, fix them in small commits (e.g. `fix(ui): ...`, `fix(api): ...`). Do not amend earlier commits.

---

## Self-Review

**Spec coverage:** The analysis identified the gap (static UI, no backend read API, no frontend wiring). Every element maps to a task:
- Backend read API (list/stats/search/detail) → Tasks 1–3
- Provenance/relations/audit for detail → Task 3
- Frontend API client + types → Task 4
- Frontend stats/list wiring → Task 5
- Frontend detail/provenance/search wiring → Task 6
- Verification against live NeonDB + route tests → Task 7

**Verified against the real codebase and live DB (2026-08-31):**
- `repositories.memory` is `draftly.persistence.repositories.memory.MemoryRepository`: `get(*, memory_id)`, `semantic_search(*, namespace, embedding, limit=10, org_id=None)`, `list_namespace(*, namespace)` (no `org_id` — added via Task 1 Step 3a to prevent cross-org leaks). `_row_to_memory` returns `org_id`, `namespace`, `summary`, `content`, `status`, `importance`, `confidence`, `created_at`, `updated_at`. ✓
- `VectorSearch.search` filters `status='active'` + optional `org_id` and returns a `similarity` scalar (never the embedding). ✓
- `get_verified_token` returns `org_id`. ✓ `EmbeddingService.embed(text) -> list[float]` exists; it is injected as `app.state.draftly.embeddings` in tests, defaults to a real instance in prod. ✓
- Task 3 SQL column names match the live `memory_sources`/`memory_links`/`memory_feedback` schemas. ✓
- Frontend: `request()` is the authed client; `api/observability.ts` is the module pattern; `renderHook`/`waitFor` are available (see `tests/lib/use-draft.test.tsx`). E501 (line length = 100) checked across all plan code blocks. ✓

**Placeholder scan:** No TBD/TODO; all steps contain concrete code and commands.

**Type consistency:** Backend endpoint shapes (`KnowledgeListItem`, `KnowledgeStats`, `KnowledgeDetail`, `KnowledgeSource`, `KnowledgeLink`, `KnowledgeFeedback`) are defined once in Task 4. Task 6 deliberately keeps `KnowledgeDetailContent` untouched by adding a pure view mapper (`lib/knowledge-detail-view.ts`) whose `KnowledgeDetailView` is fed by `mapKnowledgeDetail` from a client-side fetch — resolving the shape mismatch between the API and the existing rich UI. The `{items: ...}` envelope matches existing endpoints.

**Key data-driven findings (must be accepted at kickoff):**
1. `memory_sources`, `memory_links`, and `memory_feedback` are currently **empty**, and all knowledge `memory_items` have NULL `summary`/`source_type`/`source_id`. The detail page will show honest empty states; the backend endpoints remain useful once the agent pipeline starts writing provenance. Task 6 does not fabricate data.
2. **All 714 knowledge items have `confidence = 0.5`.** Product decision (2026-08-31): lower `VERIFIED_THRESHOLD` to `0.5` so the default-confidence items count as `verified` (stats: total 714, verified 714). `needs-verification`/`stale` will still appear correctly for any future item with `confidence < 0.5` or a non-`active` status.
3. Detail pages fetch in a **client** effect (Task 6 Step 5), not server-side: `request()` relies on a client-set Clerk token and touches `window` on 401, so server-side fetches would fail.
4. The DB total is 714 knowledge items (843 counts `document_chunk` too); Task 7 asserts the correct scope.

**Execution notes for the implementer:**
- Confirm the backend dev-run command and lint command from `pyproject.toml`/Makefile before Tasks 1–3.
- Confirm `@testing-library/react` `renderHook`/`waitFor` availability against existing hook tests before Task 5; otherwise use the established pattern.
- The `next.config`/proxy must already route `/api/*` to the backend (it does for other API clients); verify once if needed.
- Heed `draftly-agent-frontend/AGENTS.md`: this repo's Next.js 16 has breaking changes vs. training data — read `node_modules/next/dist/docs/` before editing frontend code.
