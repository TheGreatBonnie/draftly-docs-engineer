# Documentation Page Live Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded static data in the Draftly Documentation UI with live data from the NeonDB `documentation` table, served by the existing backend `/api/documentation` read routes (extended with org-scoped list/stats where needed).

**Architecture:** On the backend, add org-scoped read endpoints on the existing `documentation` router (mirroring the `knowledge` router pattern) that read from the `documentation` table via the existing `DocumentRepository`/`DocumentStore` (`list_by_org`, `get`, `baseline`). In the Next.js frontend, add an `api/documentation.ts` client (mirroring `api/knowledge.ts` from the completed knowledge-page work) and wire the six existing static components (`documentation.tsx`, `doc-list.tsx`, `doc-filters.tsx`, `documentation-detail.tsx`, `doc-article.tsx`, `doc-sidebar.tsx`) to fetch from it via the existing authenticated `request()` client and an effect-based hook.

**Tech Stack:** Python 3.11 + FastAPI + asyncpg (NeonDB) on backend; Next.js 16 + React 19 + TypeScript + vitest on frontend.

**Spec:** Session analysis of the NeonDB `documentation` table and the frontend documentation page static components (2026-08-31).

## Verified Live-DB Facts (2026-08-31, must be accepted at kickoff)

Queried the NeonDB `documentation` table via the `DATABASE_URL` in `draftly-agent-backend/.env`:

1. **20 rows total**, single org `org_3IfMDevV4Tg8DLD8Ljc0GG6c2GJ`, single repository `TheGreatBonnie/authly`, **all** rows `status='indexed'`, `document_type='general'`, `version=1`, all health flags (`stale`/`outdated`/`incomplete`/`broken_links`/`unsupported_claims`) = `false`, `commit_sha`=`NULL`, `last_verified_at`=`NULL`.
2. **There is no `slug` column** — identity is UUID `id` + `path`. The UI currently links via `slug`, so the detail route must resolve by `id` (or `path`).
3. `metadata` (jsonb) holds `{branch, source_url, chunk_count, section_count}` — e.g. `source_url = "https://github.com/TheGreatBonnie/authly/blob/master/docs/how-to/x.md"`. This is the real "Source / provenance" data.
4. The UI's status enum (`published`/`needs-review`/`needs-verification`/`stale`) **does not match** DB values (`indexed`, plus possible future `stale`/…). A mapping is required; today all 20 rows map to a single state.
5. `content` is real markdown with no renderer installed in the frontend (no `react-markdown` dep). Decide degrade path (plain-text `whitespace-pre-wrap` fallback) vs. adding a renderer (out of scope unless product approves).

## Global Constraints

- Only add **read** endpoints — no writes/mutations. (Docs are produced by the sync/index pipeline; this plan only surfaces them.)
- Mirror the existing `knowledge` router exactly: router with `prefix="/documentation"` (already exists), `tags`, `dependencies=[Depends(get_verified_token)]`; resolve repos via `request.app.state.draftly.dependencies.repositories.documents`; no new Python deps.
- Scope all reads by `org_id` from the verified token (JWT claim `token["org_id"]`). Note: the existing `GET /documentation` list and `GET /{document_id}` are **repository/id-scoped, not org-scoped** — extend them (or add org-scoped endpoints) so they cannot leak docs across orgs, matching the `knowledge`/`documentation.baseline` pattern.
- Reuse the existing `DocumentStore`/`DocumentRepository` (`list_by_org`, `get`, `list_documents`). Add minimal read methods only if a needed method is missing.
- Frontend: use the existing `request()` client from `api/client.ts` and a new `api/documentation.ts` module; **no new runtime deps** (so doc `content` rendering uses the existing `whitespace-pre-wrap`/`text` approach — no markdown lib).
- Frontend caution: this repo's Next.js 16 has breaking API changes vs. training data. Before writing frontend code, read the relevant guide in `draftly-agent-frontend/node_modules/next/dist/docs/` (see `draftly-agent-frontend/AGENTS.md`). Existing hook-test patterns use `renderHook`/`waitFor`/`act` from `@testing-library/react` in `draftly-agent-frontend/__tests__/hooks/*.test.tsx`.
- Status mapping (single backend helper): DB `status` → UI status. Proposal: `indexed` → `published`; `stale` → `stale`; anything else (`needs-review`/… if the pipeline later writes it) passes through; keep in one helper. **Confirm final mapping with product at kickoff** (all 20 rows are `indexed`, so today everything shows as one state — do not fabricate variety).
- Return ISO-8601 strings; format relative ("2 min ago") using the existing `lib/relative-time.ts` (reused from the knowledge-page work).
- Do NOT ship the mock numbers (127/114/8/5/3, "Showing 1-… of 127"). Stats/counts must come from real aggregates over `documentation` for the token's org.
- Keep the existing dark-mode/Sidebar/Topbar layout and the existing status badges; only swap data sources.
- **No commit of generated plan scaffolding unless implementation work is in progress** — follow the repo's normal commit-per-task flow during implementation, and do not amend earlier commits.
- `list_by_org` currently returns full `content` for every row. Acceptable at ~20 rows; if the corpus grows, add a lightweight list projection (exclude `content` from list/stats responses) before scaling. Non-blocking for this plan.
- Product note (honest degradation): the doc `content` rendering is a plain-text fallback (raw markdown syntax will be visible). Adding a markdown renderer (e.g. `react-markdown`) is explicitly **out of scope** to honor "no new runtime deps"; revisit with product separately.

---

### Task 1: Backend — org-scoped `documentation` read endpoints

**Files:**

- Modify: `draftly-agent-backend/src/draftly/app/api/routes/documentation.py`
- Test: `draftly-agent-backend/tests/api/test_documentation_routes.py` (new)

**Interfaces:**

- Consumes: `DocumentRepository` at `request.app.state.draftly.dependencies.repositories.documents`; exposes `list_by_org(*, org_id, limit)` → list of dicts, `get(document_id)` → dict|None, `find_by_repository(*, repository)`.
- Produces: org-scoped `GET /documentation` (list), `GET /documentation/stats` (counts), and an org-scoped `GET /documentation/{document_id}` detail.

The existing `list_documentation` requires a `repository` query param and is not org-scoped. Add a token-org list as the primary list path (so the UI can render "all docs for my org"), keep the repository filter optional.

- [ ] **Step 1: Write the failing route test**

Create `tests/api/test_documentation_routes.py` mirroring `tests/api/test_knowledge_routes.py`:

```python
"""Documentation read endpoints."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from draftly.app.api.auth import get_verified_token
from draftly.app.api.routes.documentation import router

DOC = {
    "id": "11111111-1111-1111-1111-111111111111",
    "org_id": "org-1",
    "repository": "acme/repo",
    "path": "docs/index.md",
    "title": "ACME Docs",
    "content": "# ACME\n\nHello world.",
    "document_type": "general",
    "version": 1,
    "status": "indexed",
    "metadata": {
        "branch": "master",
        "source_url": "https://github.com/acme/repo/blob/master/docs/index.md",
    },
    "stale": False,
    "outdated": False,
    "incomplete": False,
    "broken_links": False,
    "unsupported_claims": False,
    "created_at": "2026-08-29T12:00:00Z",
    "updated_at": "2026-08-30T12:00:00Z",
}


class FakeDocsRepo:
    def __init__(self, items: list[dict[str, Any]]):
        self._items = items

    async def list_by_org(self, *, org_id: str, limit: int = 1000) -> list[dict[str, Any]]:
        return [i for i in self._items if i.get("org_id") == org_id]

    async def get(self, document_id: str) -> dict[str, Any] | None:
        return next((i for i in self._items if i["id"] == document_id), None)


def make_app(items: list[dict[str, Any]] | None = None) -> FastAPI:
    repos = SimpleNamespace(documents=FakeDocsRepo(items or [DOC]))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-1"}
    app.state.draftly = SimpleNamespace(dependencies=SimpleNamespace(repositories=repos))
    return app


def test_list_documentation_is_scoped_to_org() -> None:
    foreign = {**DOC, "id": "33333333-3333-3333-3333-333333333333", "org_id": "org-2"}
    client = TestClient(make_app([DOC, foreign]))
    resp = client.get("/documentation")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert all(i["id"] != foreign["id"] for i in items)
    assert len(items) == 1


def test_stats_counts_by_status() -> None:
    stale = {**DOC, "id": "22222222-2222-2222-2222-222222222222", "status": "stale"}
    client = TestClient(make_app([DOC, stale]))
    resp = client.get("/documentation/stats")
    body = resp.json()
    assert body["total"] == 2
    assert body["by_status"]["published"] == 1  # "indexed" maps to "published"
    assert body["by_status"]["stale"] == 1


def test_get_unknown_returns_404() -> None:
    client = TestClient(make_app(items=[]))
    resp = client.get("/documentation/99999999-9999-9999-9999-999999999999")
    assert resp.status_code == 404


def test_get_is_scoped_to_org() -> None:
    foreign = {**DOC, "id": "44444444-4444-4444-4444-444444444444", "org_id": "org-2"}
    client = TestClient(make_app([DOC, foreign]))
    resp = client.get(f"/documentation/{foreign['id']}")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_routes.py -v` (from `draftly-agent-backend`)
Expected: FAIL (routes missing/not org-scoped → wrong status or 404).

- [ ] **Step 3: Replace `""` / `/{document_id}` handlers + add `/stats`**

In `documentation.py`, **replace** the existing `list_documentation` (`@router.get("")`) and `get_documentation` (`@router.get("/{document_id}")`) handlers with org-scoped versions, and add a `/stats` handler. Keep the literal routes (`/sync`, `/sync/{job_id}`, `/baseline`, `""`, `/stats`) declared **before** `/{document_id}` so the path param doesn't swallow them. Keep `repository` as an **optional** query filter so the documented `GET /api/documentation?repository=` contract (`docs/api/routes.md`) keeps working. Add a status mapping helper:

```python
from collections import Counter


def derive_status(db_status: str | None) -> str:
    """Map DB status to the UI status enum (indexed -> published)."""
    mapping = {
        "indexed": "published",
        "published": "published",
        "needs-review": "needs-review",
        "needs-verification": "needs-verification",
        "stale": "stale",
    }
    return mapping.get(db_status or "", db_status or "published")
```

Replace the existing list handler body:

```python
@router.get("")
async def list_documentation(
    request: Request,
    repository: str | None = None,
    status: str | None = None,
    limit: int = 1000,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """List documentation for the token org, optionally filtered by repo/status."""
    org_id = token.get("org_id")
    if not org_id:
        raise HTTPException(status_code=400, detail="No organization selected")
    docs = _documents(request)
    items = await docs.list_by_org(org_id=org_id, limit=min(limit, 1000))
    if repository:
        items = [i for i in items if i.get("repository") == repository]
    if status:
        items = [i for i in items if derive_status(i.get("status")) == status]
    return {"items": items}


@router.get("/stats")
async def documentation_stats(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Real aggregates for the documentation filter cards."""
    org_id = token.get("org_id")
    if not org_id:
        raise HTTPException(status_code=400, detail="No organization selected")
    docs = _documents(request)
    items = await docs.list_by_org(org_id=org_id, limit=1000)
    by_status = Counter(derive_status(i.get("status")) for i in items)
    return {
        "total": len(items),
        "by_status": dict(by_status),
        "stale": sum(1 for i in items if i.get("stale")),
        "outdated": sum(1 for i in items if i.get("outdated")),
        "incomplete": sum(1 for i in items if i.get("incomplete")),
        "broken_links": sum(1 for i in items if i.get("broken_links")),
        "unsupported_claims": sum(1 for i in items if i.get("unsupported_claims")),
    }
```

Constrain `/{document_id}` to the token's org (it currently is not):

```python
@router.get("/{document_id}")
async def get_documentation(
    document_id: str,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Fetch one document by id, scoped to the token org."""
    docs = _documents(request)
    document = await docs.get(document_id=document_id)
    org_id = token.get("org_id")
    if document is None or (org_id and document.get("org_id") != org_id):
        raise HTTPException(status_code=404, detail=f"Document {document_id} not found")
    return document
```

Note ordering: the existing `/{document_id}` route already lives at the end of the file; keep `""` and `/stats` declared before it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_routes.py -v`
Expected: All 4 tests PASS.

- [ ] **Step 5: Update the existing smoke-test repository fakes**

The existing `tests/api/test_routes_smoke.py::FakeDocumentsRepository` implements only `find_by_repository`/`get`, and its `get()` returns a record **without `org_id`**. After Task 1 the list/detail handlers call `list_by_org` and require an org match, so update the fake and the affected assertion in `TestDocumentationRoutes`:
- Add `async def list_by_org(self, *, org_id: str, limit: int = 1000): return [{"id": "doc-1", "org_id": org_id, "repository": "acme/api", "status": "indexed"}]`.
- Make `get` return `{"id": "doc-1", "org_id": "org-1", "content": "# hi"}` (must include `org_id` so the org-scoped detail passes).
- `test_list_documents` (which calls `GET /documentation?repository=acme/api`) still returns 200, but its fake must support `list_by_org` now; keep asserting `items[0]["id"] == "doc-1"`.

- [ ] **Step 6: Run existing docs smoke tests + lint**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/api/test_routes_smoke.py -v` and `uv run ruff check src/draftly/app/api/routes/documentation.py tests/api/test_documentation_routes.py`
Expected: PASS, no lint errors (E501 line-length = 100).

- [ ] **Step 7: Commit**

```bash
git add tests/api/test_documentation_routes.py src/draftly/app/api/routes/documentation.py tests/api/test_routes_smoke.py
git commit -m "feat(api): org-scoped documentation read endpoints"
```

---

### Task 2: Frontend — `api/documentation.ts` client + types

**Files:**

- Create: `draftly-agent-frontend/api/documentation.ts`
- Test: `draftly-agent-frontend/__tests__/api/documentation.test.ts`

**Interfaces:**

- Consumes: `request` from `@/api/client`.
- Produces: `listDocumentation({status?, limit?})` → `{ items: DocumentationRecord[] }`, `getDocumentationStats()` → `{total, by_status, stale, outdated, incomplete, broken_links, unsupported_claims}`, `getDocumentation(id)` → `DocumentationRecord`.

- [ ] **Step 1: Write the failing API-client test**

Create `__tests__/api/documentation.test.ts` mirroring `__tests__/api/knowledge.test.ts` (spying on `client.request`, asserting exact paths).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/api/documentation.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the client**

Create `api/documentation.ts`:

```ts
import { request } from "./client";

export type DocumentationStatus =
  | "published"
  | "needs-review"
  | "needs-verification"
  | "stale";

export interface DocumentationRecord {
  id: string;
  org_id: string | null;
  repository: string | null;
  path: string;
  title: string | null;
  content: string;
  document_type: string | null;
  version: number | null;
  commit_sha: string | null;
  source_hash: string | null;
  status: string | null; // DB status (e.g. "indexed")
  metadata: {
    branch?: string | null;
    source_url?: string | null;
    chunk_count?: number | null;
    section_count?: number | null;
  };
  stale: boolean;
  outdated: boolean;
  incomplete: boolean;
  broken_links: boolean;
  unsupported_claims: boolean;
  created_at: string | null;
  updated_at: string | null;
  last_committed_at: string | null;
  last_verified_at: string | null;
}

export interface DocumentationStats {
  total: number;
  by_status: Record<string, number>;
  stale: number;
  outdated: number;
  incomplete: number;
  broken_links: number;
  unsupported_claims: number;
}

export async function listDocumentation(opts?: {
  status?: DocumentationStatus;
  limit?: number;
}): Promise<{ items: DocumentationRecord[] }> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request(qs ? `/documentation?${qs}` : "/documentation");
}

export async function getDocumentationStats(): Promise<DocumentationStats> {
  return request("/documentation/stats");
}

export async function getDocumentation(
  id: string,
): Promise<DocumentationRecord> {
  return request(`/documentation/${encodeURIComponent(id)}`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run __tests__/api/documentation.test.ts` → PASS.

- [ ] **Step 5: Add a list hook**

Add `hooks/use-documentation.ts` mirroring `hooks/use-knowledge.ts`: fetches `listDocumentation()` + `getDocumentationStats()` on mount, exposes `{ items, stats, loading, error, reload }`. Avoid calling `setState` synchronously inside the effect body (repo lint `react-hooks/set-state-in-effect`).

- [ ] **Step 6: Add a hook test**

Create `__tests__/hooks/use-documentation.test.tsx` mirroring `__tests__/hooks/use-knowledge.test.tsx` (mock `@/api/documentation`; `renderHook`/`waitFor`).

- [ ] **Step 7: Run all new frontend tests + lint**

Run: `npx vitest run __tests__/api/documentation.test.ts __tests__/hooks/use-documentation.test.tsx` and `npm run lint`
Expected: PASS, no lint errors from these files.

- [ ] **Step 8: Commit**

```bash
git add api/documentation.ts hooks/use-documentation.ts \
  __tests__/api/documentation.test.ts __tests__/hooks/use-documentation.test.tsx
git commit -m "feat(ui): documentation API client and list hook"
```

---

### Task 3: Frontend — wire list + filters to live data

**Files:**

- Modify: `draftly-agent-frontend/components/documentation/documentation.tsx`
- Modify: `draftly-agent-frontend/components/documentation/doc-list.tsx`
- Modify: `draftly-agent-frontend/components/documentation/doc-filters.tsx`
- Test: `draftly-agent-frontend/tests/pages/documentation-home-page.test.tsx` (new home-page test; note `tests/pages/documentation-page.test.tsx` already exists and tests the onboarding step — do not reuse/overwrite it) + `__tests__/components/doc-list.test.tsx`, `__tests__/components/doc-filters.test.tsx`

**Interfaces:**

- Consumes: `useDocumentation` (Task 2), `DocumentationRecord`/`DocumentationStatus`/`DocumentationStats` from `@/api/documentation`, `relativeTime` from `@/lib/relative-time`.
- Produces: live list with real status badges, real updated_at (relative), real source (from `metadata.source_url`), and live filter counts.

- [ ] **Step 1: Write the failing render test**

Create `__tests__/components/doc-list.test.tsx` mirroring `__tests__/components/knowledge-list.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocList } from "@/components/documentation/doc-list";

const item = {
  id: "1",
  repository: "acme/repo",
  path: "docs/index.md",
  title: "ACME Docs",
  status: "indexed",
  updated_at: "2026-08-30T12:00:00Z",
  metadata: {
    source_url: "https://github.com/acme/repo/blob/master/docs/index.md",
  },
};

describe("DocList", () => {
  it("renders live rows", () => {
    // adapt to whatever DocList props your implementation declares
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/components/doc-list.test.tsx` → FAIL (interface not implemented yet).

- [ ] **Step 3: Rewrite `Documentation` to fetch live data**

Modify `components/documentation/documentation.tsx`:

- Remove `import { docRows } from "./data";`.
- Add `const { items, stats, loading, error } = useDocumentation();`.
- Pass the live list straight to `DocList` via its adapted prop type; **do not** keep or build a `docRows`-shaped projection (delete `data.tsx`/`docRows` entirely, per Task 3/4 cleanup). `DocList` maps DB fields itself: `title` (fallback to `path` basename), `status` → derived label (client twin of the backend helper), `updated_at` → `relativeTime`, source text `repository` + source icon derived from `metadata.source_url` (GitHub URL → GitHub icon; else a generic file icon from `lucide-react`).
- Replace `<DocList rows={docRows} />` with `<DocList rows={items} loading={loading} error={error} />`.
- Replace `<DocFilters ... />` so counts come from `stats.by_status` / `stats.total`, not the hardcoded `[127, 114, 8, 5, 3]`.
- Add a "Clear"/empty state and an error banner (reuse the pattern from `knowledge-list.tsx`).

- [ ] **Step 4: Adapt `DocList` to live rows**

Modify `components/documentation/doc-list.tsx`:

- Change props to `rows: DocumentationRecord[]; loading: boolean; error: string | null` (or a thin list-row projection) and import types from `@/api/documentation`.
- `key` and `href` use `row.id`: `href={`/documentation/${row.id}`}` (the DB has no `slug`).
- Derive `statusLabel` from DB status via a shared mapping (returns "Published" for `indexed`, etc.).
- `row.description` may be absent — gate rendering.
- Keep statusStyles map; add a case for `indexed` if needed.
- Add loading placeholder + empty state ("No documents found.") + error banner (reuse knowledge-list patterns).
- Remove the hardcoded "Showing 1-{rows.length} of 127"; render "Showing 1-{rows.length} of {rows.length}" or remove the footer count if total unknown (or pass `total` from stats).

- [ ] **Step 5: Adapt `DocFilters` to live counts**

Modify `components/documentation/doc-filters.tsx`:

- Accept `{ activeFilter, onFilterChange, counts: Record<string, number>, total: number }`.
- Build filter pills from `counts`/`total` instead of the hardcoded array. Map UI labels: "All Documents" → `total`, "Current" → `by_status.published ?? 0`, "Needs Verification" → `by_status['needs-verification'] ?? 0`, "Stale" → `by_status.stale ?? 0`, "Needs Review" → `by_status['needs-review'] ?? 0`.

- [ ] **Step 6: Add filter test**

Create `__tests__/components/doc-filters.test.tsx` asserting it renders counts passed in (not hardcoded ones).

- [ ] **Step 7: Update the home-page test**

Add `tests/pages/documentation-home-page.test.tsx` for the main `(app)/documentation` page: mock `@/api/documentation` and assert the list renders live items and counts, and that the hardcoded numbers ("of 127") no longer appear.

- [ ] **Step 8: Run all frontend tests + lint**

Run: `npx vitest run`, `npm run lint`, `npx tsc --noEmit` (confirm no new errors; pre-existing `tests/pages/initialize-page.test.tsx` errors are unrelated).
Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add components/documentation/documentation.tsx \
  components/documentation/doc-list.tsx components/documentation/doc-filters.tsx \
  __tests__/components/doc-list.test.tsx __tests__/components/doc-filters.test.tsx \
  tests/pages/documentation-home-page.test.tsx
git rm components/documentation/data.tsx
git commit -m "feat(ui): wire documentation list and filters to live API"
```

---

### Task 4: Frontend — wire detail page + article + sidebar to live data

**Context (verified against live DB, 2026-08-31):** every `documentation` row has `commit_sha=NULL`, `last_verified_at=NULL`, and all health flags `false`. `metadata.source_url` is present (GitHub blob URL). `content` is real markdown. The current `doc-article.tsx` renders **simulated hardcoded JSX** body; `doc-detail-data.ts` holds fake quality metrics / provenance / "PR #482" trigger that have **no DB equivalent** — do not fabricate them; render honest values or empty states.

**Files:**

- Create: `draftly-agent-frontend/lib/documentation-detail-view.ts` (view types + `mapDocumentationDetail`)
- Modify: `draftly-agent-frontend/components/documentation/documentation-detail.tsx`
- Modify: `draftly-agent-frontend/components/documentation/doc-article.tsx`
- Modify: `draftly-agent-frontend/components/documentation/doc-sidebar.tsx`
- Delete: `draftly-agent-frontend/components/documentation/doc-detail-data.ts`
- Test: `__tests__/lib/documentation-detail-view.test.ts`, `__tests__/components/doc-article.test.tsx`, `__tests__/components/doc-sidebar.test.tsx`

**Interfaces:**

- Consumes: `getDocumentation` and `DocumentationRecord` from `@/api/documentation` (Task 2); `relativeTime` from `@/lib/relative-time`.
- Produces: a client component that fetches live detail by `id` in an effect and renders via a pure view mapper. The server page `app/(app)/documentation/[slug]/page.tsx` stays a thin async wrapper passing only `id` — **do not fetch on the server** (`request()` depends on a client-set Clerk token and touches `window` on 401).

- [ ] **Step 1: Write the failing mapper test**

Create `__tests__/lib/documentation-detail-view.test.ts` with a `DocumentationRecord` fixture and `mapDocumentationDetail`, asserting: title maps to `title`/`path` basename, `category` maps from `document_type` (with a readable label), version from `version`, status/label from `status` via mapping, `lastUpdated` = `relativeTime(updated_at)`, `description` derived from `content` (first ~160 chars, no fabricated body), source/trigger uses `metadata.source_url` + `repository`, and honest empty values when `commit_sha`/`last_verified_at` are null.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/lib/documentation-detail-view.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the view mapper**

Create `lib/documentation-detail-view.ts`. Own the view types that `doc-article.tsx`/`doc-sidebar.tsx` consume and map the live API shape onto them, following the `knowledge-detail-view.ts` pattern. Keep a small `deriveDocStatus(status)` mapping (client twin of the backend helper) so status/badge logic lives in one place. Never fabricate quality metrics or provenance — when the DB has none, the sidebar renders a graceful "No data" state.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run __tests__/lib/documentation-detail-view.test.ts` → PASS.

- [ ] **Step 5: Fetch live detail in the detail component**

Rewrite `components/documentation/documentation-detail.tsx`:

- Remove `import { docDetails } from "./doc-detail-data";`.
- Add state `detail` + `status: "loading" | "error" | "ready"`; `useEffect` on `[id]`: `getDocumentation(id).then(mapDocumentationDetail)` → `ready`, `.catch` → `error`, with a `cancelled` guard.
- Keep Sidebar/Topbar/dark-mode layout; `subtitle` from `detail?.title`.
- Body: loading → "Loading…"; error → "Couldn't load document"; ready + detail → `<DocArticle doc={detail} />` + `<DocSidebar doc={detail} />`.

- [ ] **Step 6: Adapt `DocArticle` to the view shape + real content**

Modify `components/documentation/doc-article.tsx`:

- Change the type import to `@/lib/documentation-detail-view`'s view type (drop the `./doc-detail-data` import and the simulated body).
- Render header from view fields (`version`, `category`, `title`, `description`).
- Render the doc **body** from `view.content` as real content. Without a markdown renderer, render inside a `<div className="whitespace-pre-wrap font-mono text-xs text-slate-600 dark:text-slate-400">` block (plain-text fallback). If product approves a renderer later, swap this container. Add an empty state when `content` is empty.

- [ ] **Step 7: Adapt `DocSidebar` to the view shape + empty states**

Modify `components/documentation/doc-sidebar.tsx`:

- Change type import to the view type.
- "Document Status": derive `statusDot` + label from `view.status` (statusLabel) and `lastUpdated` (relative time from `updated_at`); show `last_committed_at`/`last_verified_at` if present, else "Not yet verified".
- "Quality Metrics": the DB has no DeepEval metrics here. Replace the fabricated bar chart with an honest health panel derived from the real flags — render pass/fail rows for `stale`, `outdated`, `incomplete`, `broken_links`, `unsupported_claims` (all currently false → all "Pass"); if a flag is true, show a warning. (Do not show percentage bars with fake values.)
- "Provenance Trail": derive from `metadata.source_url` (GitHub blob → one node "Source: repository @ branch", link to `source_url`) and `commit_sha` if present. Remove fabricated "PR #482 / Webhook / Workflow" nodes; render an empty state when there's no provenance data.

- [ ] **Step 8: Add render tests**

Create `__tests__/components/doc-article.test.tsx` (renders title, category, version, and real content text) and `__tests__/components/doc-sidebar.test.tsx` (renders status label, relative last-updated, honest health rows, and provenance source link). Include an empty-state case where provenance/metadata are absent.

- [ ] **Step 9: Update the page route to pass `id`**

The existing `app/(app)/documentation/[slug]/page.tsx` passes `slug`; rename the param slot to `[id]` (or keep `[slug]` as the folder but pass its value as `id`). Keep it a thin async wrapper: `return <DocumentationDetail id={id} />;`. Grep for `/documentation/${...}` links (in `doc-list.tsx`) to confirm they now point at `row.id`.

- [ ] **Step 10: Remove dead static data modules**

Delete `components/documentation/doc-detail-data.ts` and `components/documentation/data.tsx` (the list `docRows` module — now dead after Task 3). Then `grep` for `docDetails`, `doc-detail-data`, `docRows`, and `from "./data"` across `components/documentation` and `app/(app)/documentation` and confirm no remaining imports. If any other component imports them, adjust that import first.

- [ ] **Step 11: Run all frontend tests + lint**

Run (from `draftly-agent-frontend`): `npx vitest run`, `npm run lint`, `npx tsc --noEmit`.
Expected: all pass; no orphan imports.

- [ ] **Step 12: Commit**

```bash
git add lib/documentation-detail-view.ts __tests__/lib/documentation-detail-view.test.ts \
  __tests__/components/doc-article.test.tsx __tests__/components/doc-sidebar.test.tsx \
  components/documentation/documentation-detail.tsx components/documentation/doc-article.tsx \
  components/documentation/doc-sidebar.tsx 'app/(app)/documentation/[slug]/page.tsx'
git rm components/documentation/doc-detail-data.ts components/documentation/data.tsx
git commit -m "feat(ui): live documentation detail, article, and sidebar"
```

---

### Task 5: End-to-end verification

**Files:**

- Verify only (no new code unless a bug surfaces).

**Interfaces:** Rely on all prior tasks.

- [ ] **Step 1: Launch backend**

From `draftly-agent-backend`, run the app (check `pyproject.toml`/Makefile — `make run` → `uv run python main.py`). Confirm the org-scoped endpoints return real data from NeonDB:

```
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/documentation
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/documentation/stats
```

Expected (verified against live DB 2026-08-31): `items` length = 20 for the single org; `stats.total` = 20, `by_status = {"published": 20}` (all `indexed` mapped to `published`), health counters all 0.

- [ ] **Step 2: Launch frontend**

From `draftly-agent-frontend`, run the dev server. Navigate to the Documentation page. Confirm:

- The list shows the 20 real docs (e.g. "Getting started", "SDK overview", "API reference") with real `updated_at` relative times.
- Filter counts reflect the live data (e.g. All = 20, Published = 20; not 127/114/8/5/3).
- The pagination footer no longer reads "of 127".
- Clicking a row navigates to `/documentation/{id}` and the detail page renders title, real content, status, relative last-updated, and **honest** health/provenance panels (all flags false → all "Pass"; no fabricated DeepEval percentages or fake PR provenance).

- [ ] **Step 3: Backend + frontend tests and lint again**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_routes.py -v` (backend) and `npx vitest run` + `npm run lint` + `npx tsc --noEmit` (frontend).
Expected: all green.

- [ ] **Step 4: Commit any fixes**

If verification surfaced bugs, fix them in small commits (e.g. `fix(ui): ...`, `fix(api): ...`). Do not amend earlier commits.

---

## Self-Review

**Spec coverage:** The analysis identified the gap (static docs UI, no frontend API client, backend read route not org-scoped). Every element maps to a task:

- Org-scoped documentation read API (list/stats/detail) → Task 1
- Frontend API client + types + list hook → Task 2
- Frontend list/filters wiring → Task 3
- Frontend detail/article/sidebar wiring + content rendering → Task 4
- Verification against live NeonDB + route tests → Task 5

**Verified against the real codebase and live DB (2026-08-31):**

- `repositories.documents` is `draftly.persistence.repositories.documents.DocumentRepository`: `list_by_org(*, org_id, limit=1000)`, `get(document_id)`, `find_by_repository(*, repository)`. `DocumentStore._row_to_dict` returns `id`, `org_id`, `repository`, `path`, `title`, `content`, `document_type`, `version`, `commit_sha`, `source_hash`, `status`, `metadata`, health booleans, timestamps. ✓
- Existing `documentation.py` routes: `POST /sync`, `GET /sync/{job_id}`, `GET /baseline` (org-scoped), `GET ""` (repository-scoped, not org-scoped), `GET /{document_id}` (id-scoped, not org-scoped). Task 1 **replaces** the latter two with org-scoped versions (keeping `?repository=` as an optional filter) and adds `/stats`. ✓
- `get_verified_token` returns `org_id`. ✓
- Frontend: `request()` is the authed client; `api/knowledge.ts` (completed earlier) is the module + test pattern to mirror; `lib/relative-time.ts` exists and is reused; `hooks/use-knowledge.ts` + its test are the hook pattern; `knowledge-list.tsx` is the loading/error/empty-state pattern. ✓
- No markdown renderer in `draftly-agent-frontend/package.json` — Task 4 Step 6 renders `content` as pre-wrapped plain text (no new dependency). ✓
- E501/line-length = 100 checked across all plan code blocks. ✓

**Placeholder scan:** No TBD/TODO; all steps contain concrete code and commands.

**Type consistency:** Backend endpoint shapes (`DocumentationRecord`, `DocumentationStats`) are defined once in Task 2. Task 4 deliberately keeps `DocArticle`/`DocSidebar` untouched at the JSX level by adding a pure view mapper (`lib/documentation-detail-view.ts`) fed by a client fetch — resolving the shape mismatch between the API and the existing rich UI. `{items: ...}` envelope matches existing endpoints.

**Key data-driven findings (must be accepted at kickoff):**

1. **All 20 docs are `status='indexed'`** → under the proposed mapping they all render as "Published / Current". Do **not** fabricate `needs-review`/`needs-verification` variety.
2. **No `slug` column** → detail route is keyed by UUID `id` (or `path`). Update `doc-list.tsx` links and the `[slug]` route accordingly.
3. **Detail page fetches in a client effect** (Task 4), not server-side: `request()` relies on a client-set Clerk token and touches `window` on 401.
4. **`content` is markdown with no renderer** → plain-text fallback (product may later add `react-markdown`; that is out of scope here to honor "no new runtime deps").
5. **Quality metrics / PR provenance in the current static UI have no DB backing** → replaced with honest health flags + GitHub `metadata.source_url` provenance; blank/"no data" where none exists.

**Execution notes for the implementer:**

- Confirm the backend dev-run and lint commands from `pyproject.toml`/Makefile before Task 1 (`make test` → `uv run pytest -q`; `make lint` → `ruff check`).
- Confirm `@testing-library/react` `renderHook`/`waitFor` availability against existing hook tests (`__tests__/hooks/use-knowledge.test.tsx`) before Task 2; otherwise use the established pattern.
- The `next.config`/proxy must already route `/api/*` to the backend (it does for other API clients); verify once if needed.
- Heed `draftly-agent-frontend/AGENTS.md`: this repo's Next.js 16 has breaking changes vs. training data — read `node_modules/next/dist/docs/` before editing frontend code.
- The main `(app)/documentation` page has no existing home-page test (only the onboarding `tests/pages/documentation-page.test.tsx` doc-step test) — the new `tests/pages/documentation-home-page.test.tsx` is the first home-page test for the docs list.
