# Dynamic Documentation Pages and Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static documentation list, detail, edit, history, sync, and evaluation experiences with organization-scoped, durable data backed by `draftly-agent-backend`.

**Architecture:** Keep `documentation` as the GitHub-synced source snapshot. Add immutable `documentation_revisions` for Draftly-authored edits; expose typed APIs for drafts, history, sync jobs, and document-targeted evaluations. The Next.js UI fetches through the existing authenticated client and renders explicit loading, empty, conflict, and failure states. Publishing is excluded.

**Tech Stack:** Python 3.11, FastAPI, asyncpg, Neon/PostgreSQL, Redis/RQ, Next.js 16.3, React 19, TypeScript, Clerk JWTs, Vitest, Testing Library, `react-markdown`, and `remark-gfm`.

**Spec:** `docs/superpowers/plans/2026-08-31-documentation-page-live-data.md`, extended by the approved 2026-09-10 brainstorming decision to include edit/save, sync, history, and evaluations while excluding publish.

## Global Constraints

- Publishing is out of scope: no endpoint or UI action writes content to a GitHub default branch.
- `documentation` remains the indexed/source snapshot; manual saves create immutable Draftly revisions and do not overwrite it.
- Every read and mutation is scoped by `org_id` from the verified Clerk token; never trust an organization id from the browser.
- Documentation identity is UUID `id`; do not derive routing identity from title/path slugs.
- Use the existing `get_verified_token`, `request()`, RQ composition, repository patterns, and dashboard layout.
- Return ISO-8601 timestamps and typed JSON envelopes; define status mapping once and reuse it.
- Manual edits require optimistic concurrency and return HTTP 409 when the source or current draft changed.
- Sync uses the existing RQ path when enabled; the in-process fallback is development-only and observable.
- Use the already-installed Markdown dependencies; add no runtime dependency.
- Remove mock counts, fake quality scores, fake PR/history/provenance, and fallback-to-first-document behavior.
- Every action needs disabled/loading, success, empty, and actionable failure states.
- Keep Git/source history distinct from Draftly revision history; do not claim Git history unless fetched from GitHub.
- Tests must cover organization isolation, validation, conflicts, route ordering, action failures, empty data, and happy paths without live services.

## File Map

Backend:

- Create `draftly-agent-backend/src/draftly/persistence/migrations/054_documentation_revisions.sql`.
- Create `draftly-agent-backend/src/draftly/persistence/repositories/document_revisions.py`.
- Modify `draftly-agent-backend/src/draftly/integrations/database/document_store.py` and `persistence/repositories/documents.py`.
- Modify jobs/evaluation repositories and `app/api/routes/documentation.py`.
- Modify RQ composition only for durable targeted sync/evaluation dispatch.
- Add tests under `draftly-agent-backend/tests/api` and `tests/persistence`.

Frontend:

- Expand `api/documentation.ts` and the existing `api/observability.ts` evaluation client with document-target filters.
- Create focused documentation hooks and view models.
- Create focused components under `components/sections/documentation/`.
- Make documentation route files thin wrappers around those components.
- Remove documentation imports from `lib/mock-data.ts` and static documentation arrays in `section-subpage.tsx`.
- Add API, hook, mapper, component, and page tests under `draftly-agent-ui/tests`.

---

### Task 1: Add immutable Draftly document revisions

**Files:**

- Create: `draftly-agent-backend/src/draftly/persistence/migrations/054_documentation_revisions.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/document_revisions.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/documents.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/document_store.py`
- Test: `draftly-agent-backend/tests/persistence/test_document_revisions.py`

**Interfaces:**

- Consumes: organization-scoped `documentation` rows and their `source_hash`, `updated_at`, and `content`.
- Produces: `DocumentationRevision`, `RevisionPage`, `RevisionConflict`, `create_draft`, `list_revisions`, `get_revision`, and `restore_revision`.

- [ ] **Step 1: Write failing persistence tests**

Use a fake transaction-capable client and assert:

```python
revision = await repository.create_draft(
    document_id=DOC_ID,
    org_id="org-1",
    content="# Updated",
    title="Updated title",
    base_source_hash="sha-old",
    base_revision_id=None,
    created_by="user-1",
)
assert revision.revision_number == 1
assert revision.status == "draft"
assert revision.origin == "manual"
assert fake_db.documentation[DOC_ID]["draft_revision_id"] == revision.id

fake_db.documentation[DOC_ID]["source_hash"] = "sha-new"
with pytest.raises(RevisionConflict):
    await repository.create_draft(
        document_id=DOC_ID,
        org_id="org-1",
        content="# Stale",
        title=None,
        base_source_hash="sha-old",
        base_revision_id=None,
        created_by="user-1",
    )
assert fake_db.revisions == []

restored = await repository.restore_revision(
    document_id=DOC_ID,
    revision_id=OLD_REVISION_ID,
    org_id="org-1",
    created_by="user-1",
)
assert restored.origin == "restore"
assert fake_db.revisions[0]["status"] == "superseded"
```

Also test that foreign organization documents and revisions behave as not found.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_document_revisions.py -v
```

Expected: FAIL because the schema and repository do not exist.

- [ ] **Step 3: Add the migration**

Create the table and current-draft pointer:

```sql
CREATE TABLE IF NOT EXISTS documentation_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documentation(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    revision_number INT8 NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'restore')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'superseded', 'discarded')),
    title TEXT,
    content TEXT NOT NULL,
    base_source_hash TEXT,
    base_document_updated_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    UNIQUE (document_id, revision_number)
);

ALTER TABLE documentation
    ADD COLUMN IF NOT EXISTS draft_revision_id UUID
    REFERENCES documentation_revisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_doc_revisions_org_document
    ON documentation_revisions (org_id, document_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_doc_revisions_created
    ON documentation_revisions (org_id, created_at DESC);
```

Manual saves must leave the source row’s `content`, `source_hash`, `commit_sha`, and sync timestamps unchanged.

- [ ] **Step 4: Implement transactional revision persistence**

Implement these exact methods:

```python
class RevisionConflict(Exception):
    current_source_hash: str | None
    current_revision_id: str | None

@dataclass(frozen=True)
class DocumentationRevision:
    id: str
    document_id: str
    org_id: str
    revision_number: int
    origin: str
    status: str
    title: str | None
    content: str
    base_source_hash: str | None
    created_by: str
    created_at: datetime

@dataclass(frozen=True)
class RevisionPage:
    items: list[DocumentationRevision]
    total: int
    next_cursor: str | None

class DocumentRevisionRepository:
    async def create_draft(
        self, *, document_id: str, org_id: str, content: str,
        title: str | None, base_source_hash: str | None,
        base_revision_id: str | None, created_by: str
    ) -> DocumentationRevision:
        """Lock the document, validate the base, and insert the next draft."""

    async def list_revisions(
        self, *, document_id: str, org_id: str, limit: int,
        cursor: str | None = None
    ) -> RevisionPage:
        """Return revisions belonging to the document and organization."""

    async def get_revision(
        self, *, document_id: str, revision_id: str, org_id: str
    ) -> DocumentationRevision | None:
        """Return one organization-scoped revision or None."""

    async def restore_revision(
        self, *, document_id: str, revision_id: str,
        org_id: str, created_by: str
    ) -> DocumentationRevision:
        """Create a restore revision without mutating old history."""
```

The create/restore transaction locks the organization-scoped document, validates the base hash and revision id, marks the old draft superseded, inserts the new immutable row, and updates `documentation.draft_revision_id`. A conflict occurs before any insert.

- [ ] **Step 5: Add document repository composition and projections**

Add `get_for_org(document_id, org_id)` and `list_projection_by_org(org_id, repository, status, query, limit, cursor)` to `DocumentRepository`. List projections exclude `content` and include `has_draft`, `draft_revision_id`, and `updated_at`. Detail responses distinguish:

```json
{
  "source": {"content": "# Source", "source_hash": "sha-source", "commit_sha": null},
  "draft": {"id": "rev-2", "revision_number": 2, "content": "# Draft"},
  "effective": {"kind": "draft", "revision_id": "rev-2", "content": "# Draft"}
}
```

- [ ] **Step 6: Run focused tests, lint, and commit**

```bash
DRAFTLY_LIVE=0 uv run pytest tests/persistence/test_document_revisions.py -v
uv run ruff check src/draftly/persistence/repositories/document_revisions.py src/draftly/persistence/repositories/documents.py src/draftly/integrations/database/document_store.py
git add src/draftly/persistence/migrations/054_documentation_revisions.sql src/draftly/persistence/repositories/document_revisions.py src/draftly/persistence/repositories/documents.py src/draftly/integrations/database/document_store.py tests/persistence/test_document_revisions.py
git commit -m "feat(api): persist documentation revisions"
```

### Task 2: Harden documentation APIs for reads, save, history, and sync

**Files:**

- Modify: `draftly-agent-backend/src/draftly/app/api/routes/documentation.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/jobs.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/jobs_store.py`
- Test: `draftly-agent-backend/tests/api/test_documentation_routes.py`
- Test: `draftly-agent-backend/tests/api/test_routes_smoke.py`

**Interfaces:**

- Consumes: Task 1 repositories, jobs table, and verified Clerk token.
- Produces: org-scoped list/detail/stats/revisions/history/sync endpoints and `POST /documentation/{document_id}/revisions`.

- [ ] **Step 1: Write failing route tests**

```python
response = client.get("/documentation?limit=25")
assert response.status_code == 200
assert response.json()["total"] == 1
assert "content" not in response.json()["items"][0]

response = client.post(
    f"/documentation/{DOC_ID}/revisions",
    json={"content": "# Draft", "base_source_hash": "old-sha"},
)
assert response.status_code == 409
assert response.json()["detail"]["code"] == "DOCUMENT_CONFLICT"

response = client.get(f"/documentation/{DOC_ID}/history")
assert [item["kind"] for item in response.json()["items"]] == ["revision", "sync"]

response = foreign_client.get(f"/documentation/sync/{FOREIGN_JOB_ID}")
assert response.status_code == 404
```

Add tests for malformed IDs, missing org context, foreign documents/revisions, invalid lengths, and route ordering for `/stats`, `/sync/{job_id}`, and nested revision routes.

- [ ] **Step 2: Run tests to verify they fail**

```bash
DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_routes.py tests/api/test_routes_smoke.py -v
```

- [ ] **Step 3: Add validated request models and role boundaries**

```python
class SaveRevisionRequest(BaseModel):
    content: str = Field(min_length=1, max_length=1_000_000)
    title: str | None = Field(default=None, max_length=300)
    base_source_hash: str | None = Field(default=None, max_length=128)
    base_revision_id: str | None = Field(default=None, max_length=64)

def _org_id(token: dict[str, Any]) -> str:
    value = str(token.get("org_id") or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="No organization selected")
    return value
```

Reads/history/evaluation use the verified org. Save and sync use the existing `require_workflow_editor` dependency, accepting only `admin` and `editor`. Tests must prove a member cannot mutate another organization’s data.

- [ ] **Step 4: Replace list/detail handlers with projections**

Implement `GET /documentation` with optional `repository`, `status`, `query`, `limit`, and cursor filters. Cap limit at 200, query the org-scoped projection, and return `{items,total,next_cursor}`. Implement `GET /documentation/{document_id}` with `get_for_org`; return 404 for foreign documents. Keep `derive_status("indexed") == "published"` in one backend helper and use it for list, stats, and detail.

- [ ] **Step 5: Add revision and history routes before the ID route**

Declare these before `@router.get("/{document_id}")`:

```text
GET  /documentation/{document_id}/revisions
GET  /documentation/{document_id}/history
POST /documentation/{document_id}/revisions
POST /documentation/{document_id}/revisions/{revision_id}/restore
```

Map `RevisionConflict` to HTTP 409:

```json
{"detail":{"code":"DOCUMENT_CONFLICT","message":"The document changed while you were editing.","current_source_hash":"sha-current","current_revision_id":"rev-current"}}
```

History merges Draftly revisions with organization-scoped documentation sync jobs for the same repository, normalizes entries to `{id,kind,title,actor,status,created_at,metadata}`, and sorts newest first. The source history contains sync/job/commit metadata only; it does not imply old content is available.

- [ ] **Step 6: Make sync durable and scope its status**

Replace the API-local `asyncio.create_task` path with `enqueue_job` when RQ is configured. Persist the Postgres job row using the same run/RQ id, include repository/include/exclude in configuration, and preserve task result/error. Keep the in-process path only when RQ is disabled and log `documentation_sync_inprocess_fallback`.

Add `get_for_org(job_id, org_id)` and `list_documentation_syncs(org_id, repository, limit)` to the jobs repository/store. `GET /documentation/sync/{job_id}` must use `get_for_org` and return 404 for foreign jobs.

- [ ] **Step 7: Run tests, lint, and commit**

```bash
DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_routes.py tests/api/test_routes_smoke.py tests/persistence/test_document_revisions.py -v
uv run ruff check src/draftly/app/api/routes/documentation.py src/draftly/persistence/repositories/jobs.py src/draftly/integrations/database/jobs_store.py
git add src/draftly/app/api/routes/documentation.py src/draftly/persistence/repositories/jobs.py src/draftly/integrations/database/jobs_store.py tests/api/test_documentation_routes.py tests/api/test_routes_smoke.py
git commit -m "feat(api): add documentation revision and history endpoints"
```

### Task 3: Add document-targeted evaluations

**Files:**

- Modify: `draftly-agent-backend/src/draftly/app/api/routes/documentation.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/evaluations.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/evaluations.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/evaluations_store.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`
- Test: `draftly-agent-backend/tests/api/test_documentation_evaluations.py`

**Interfaces:**

- Consumes: the effective source/draft content from Task 1 and the existing deterministic/live evaluation runner.
- Produces: `POST /documentation/{document_id}/evaluate` and `GET /documentation/{document_id}/evaluations`, targeted to the document UUID.

- [ ] **Step 1: Write failing evaluation tests**

```python
response = client.post(f"/documentation/{DOC_ID}/evaluate", json={"live": False})
assert response.status_code == 202
assert response.json()["document_id"] == DOC_ID
assert response.json()["revision_id"] == DRAFT_REVISION_ID

response = client.get(f"/documentation/{DOC_ID}/evaluations?limit=10")
assert response.status_code == 200
assert response.json()["items"][0]["target_id"] == DOC_ID

assert client.get(f"/documentation/{FOREIGN_DOC_ID}/evaluations").status_code == 404
```

Cover no document, foreign revision, missing evaluator, queued failure, and nullable score/failure data.

- [ ] **Step 2: Run tests to verify they fail**

```bash
DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_evaluations.py -v
```

- [ ] **Step 3: Extend evaluation repository filters**

Add optional `target_type` and `target_id` parameters to the existing organization-scoped search method. Query `evaluations` with `org_id`, `target_type = 'documentation'`, and `target_id = document_id::uuid`; order by `COALESCE(completed_at, started_at, created_at) DESC`. Store the selected `revision_id` inside `metrics["revision_id"]` and preserve JSONB decoding.

- [ ] **Step 4: Implement the targeted action boundary**

Add:

```python
class EvaluateDocumentationRequest(BaseModel):
    revision_id: str | None = None
    live: bool = False
```

The route resolves the document under the token organization, selects the current draft when no revision is supplied, rejects a foreign/stale revision, and enqueues a durable evaluation task with `org_id`, `document_id`, `revision_id`, `content`, `title`, `live`, and `run_id`. The worker writes an evaluation row with `evaluation_type="documentation"`, `target_type="documentation"`, `target_id=document_id`, and `metrics.revision_id`. Never evaluate browser-supplied content.

- [ ] **Step 5: Add routes, run checks, and commit**

Declare evaluation routes before `/{document_id}`, return 202 with `{run_id,document_id,revision_id,status:"queued"}`, and return `{items,total,next_cursor}` for reads. Missing evaluation data remains nullable.

```bash
DRAFTLY_LIVE=0 uv run pytest tests/api/test_documentation_evaluations.py tests/api/test_documentation_routes.py -v
uv run ruff check src/draftly/app/api/routes/documentation.py src/draftly/app/api/routes/evaluations.py src/draftly/persistence/repositories/evaluations.py src/draftly/integrations/database/evaluations_store.py
git add src/draftly/app/api/routes/documentation.py src/draftly/app/api/routes/evaluations.py src/draftly/persistence/repositories/evaluations.py src/draftly/integrations/database/evaluations_store.py tests/api/test_documentation_evaluations.py
git commit -m "feat(api): target evaluations to documentation revisions"
```

### Task 4: Add frontend contracts, view models, and hooks

**Files:**

- Modify: `draftly-agent-ui/api/documentation.ts`
- Modify: `draftly-agent-ui/api/observability.ts`
- Modify: `draftly-agent-ui/hooks/use-documentation.ts`
- Create: `draftly-agent-ui/hooks/use-documentation-detail.ts`, `use-documentation-history.ts`, and `use-documentation-actions.ts`
- Create: `draftly-agent-ui/lib/documentation-status.ts` and `lib/documentation-view-model.ts`
- Test: `draftly-agent-ui/tests/documentation-api.test.ts`, `documentation-view-model.test.ts`, and `documentation-hooks.test.tsx`

**Interfaces:**

- Consumes: Task 2/3 backend envelopes and the current `request()` client.
- Produces: typed clients/hooks used by every documentation route; no documentation component imports `lib/mock-data.ts`.

- [ ] **Step 1: Write failing client/mapper tests**

```ts
await saveDocumentationRevision("doc-1", {
  content: "# Draft",
  base_source_hash: "sha-1",
});
expect(request).toHaveBeenCalledWith("/documentation/doc-1/revisions", {
  method: "POST",
  body: JSON.stringify({ content: "# Draft", base_source_hash: "sha-1" }),
});
expect(deriveDocumentationStatus("indexed").key).toBe("published");
expect(mapDocumentationDetail(record).effective.content).toBe(record.draft.content);
```

Test null timestamps, absent metadata, unknown statuses, source/draft selection, relative time, and 409 errors.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd draftly-agent-ui
pnpm exec vitest run tests/documentation-api.test.ts tests/documentation-view-model.test.ts tests/documentation-hooks.test.tsx
```

- [ ] **Step 3: Define frontend types and clients**

Add `DocumentationListItem` without `content`, `DocumentationDetail` with `source`, `draft`, and `effective`, `DocumentationRevision`, `DocumentationHistoryEntry`, and `DocumentationEvaluation`. Add clients for list/stats/detail, save/list/restore revisions, history, sync submission/status, evaluate, and list evaluations. Encode all IDs and preserve `ApiError.status`.

- [ ] **Step 4: Implement shared mapping**

`documentation-status.ts` maps `indexed -> published`, `stale -> stale`, and unknown values to a readable slate state. `documentation-view-model.ts` maps title/path/category/branch/source URL, effective content, health flags, revisions, evaluations, and relative timestamps. It must never generate fake scores, actors, PRs, or review dates.

- [ ] **Step 5: Implement hooks and action state**

```ts
useDocumentationDetail(id) // { detail, loading, error, reload }
useDocumentationHistory(id) // { entries, loading, error, reload }
useDocumentationActions(id) // { saveRevision, restoreRevision, sync, evaluate, pendingAction, error }
```

Use cancellation guards. Mutations clear errors, disable only the active action, preserve editor text on failure, map 409 to conflict state, and reload affected detail/history/evaluation data after success. List hooks support query/filter/cursor state.

- [ ] **Step 6: Run checks and commit**

```bash
pnpm exec vitest run tests/documentation-api.test.ts tests/documentation-view-model.test.ts tests/documentation-hooks.test.tsx
pnpm lint
pnpm exec tsc --noEmit
git add api/documentation.ts api/observability.ts hooks/use-documentation.ts hooks/use-documentation-detail.ts hooks/use-documentation-history.ts hooks/use-documentation-actions.ts lib/documentation-status.ts lib/documentation-view-model.ts tests/documentation-api.test.ts tests/documentation-view-model.test.ts tests/documentation-hooks.test.tsx
git commit -m "feat(ui): add documentation action clients and hooks"
```

### Task 5: Convert list, filters, sync, and documentation subpages

**Files:**

- Create: `draftly-agent-ui/components/sections/documentation/documentation-page.tsx`, `documentation-list.tsx`, and `documentation-sync-action.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/documentation/page.tsx`
- Modify: `draftly-agent-ui/components/dashboard/section-subpage.tsx` and `section-tabs.tsx`
- Test: `draftly-agent-ui/tests/documentation-page.test.tsx`, `documentation-list.test.tsx`, and `documentation-sync-action.test.tsx`

**Interfaces:**

- Consumes: Task 4 hooks/view models and existing dashboard primitives.
- Produces: live list rows/stats/filters and repository sync progress.

- [ ] **Step 1: Write failing render tests**

```tsx
render(<DocumentationPage />);
expect(await screen.findByText("ACME Docs")).toBeInTheDocument();
expect(screen.queryByText(/127/)).not.toBeInTheDocument();

render(<DocumentationList rows={[draftRow]} />);
expect(screen.getByRole("link", { name: /ACME Docs/i }))
  .toHaveAttribute("href", "/documentation/doc-uuid");
expect(screen.getByText("Draft")).toBeInTheDocument();
```

Test search/filter changes, empty/error/retry states, 202 sync submission, polling completion, and failed sync.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run tests/documentation-page.test.tsx tests/documentation-list.test.tsx tests/documentation-sync-action.test.tsx
```

- [ ] **Step 3: Move the list into a client component**

Keep the route as a thin wrapper. Compute metrics only from `stats.total`, `stats.by_status`, and health counters. Render skeletons, loaded empty state with clear filters, errors with retry while retaining old rows, and live cursor pagination. Remove the `docs` import and all static totals.

- [ ] **Step 4: Implement rows and filters**

Use the UUID link, title fallback to path basename, repository/source URL, real `updated_at`, status mapping, health flags, and `has_draft`. Serialize query/status/repository through component state; do not use array-index status logic.

- [ ] **Step 5: Implement sync progress**

Call `syncDocumentation`, show the returned job id, poll `getDocumentationSyncStatus` with bounded backoff until terminal, stop on unmount/completion/failure, and reload the list on completion. Display backend result/error; submitted is not completed.

- [ ] **Step 6: Convert subpages**

By repository groups live rows and links to `/documentation?repository=acme%2Frepo`. By topic uses `metadata.topic` only when supplied and otherwise shows a truthful unavailable state. Outdated filters real `stale/outdated` data. Recently updated uses API ordering. Remove all static documentation rows/counts.

- [ ] **Step 7: Run checks and commit**

```bash
pnpm exec vitest run tests/documentation-page.test.tsx tests/documentation-list.test.tsx tests/documentation-sync-action.test.tsx
pnpm lint
pnpm exec tsc --noEmit
git add components/sections/documentation 'app/(dashboard)/documentation/page.tsx' components/dashboard/section-subpage.tsx components/dashboard/section-tabs.tsx tests/documentation-page.test.tsx tests/documentation-list.test.tsx tests/documentation-sync-action.test.tsx
git commit -m "feat(ui): render documentation lists from live data"
```

### Task 6: Convert detail, history, and evaluation components

**Files:**

- Create: `draftly-agent-ui/components/sections/documentation/documentation-detail-page.tsx`, `documentation-article.tsx`, `documentation-sidebar.tsx`, `documentation-history.tsx`, and `documentation-evaluations.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/documentation/[slug]/page.tsx`
- Test: `draftly-agent-ui/tests/documentation-detail-page.test.tsx`, `documentation-history.test.tsx`, and `documentation-evaluations.test.tsx`

**Interfaces:**

- Consumes: detail/history/action hooks and Task 4 view models.
- Produces: live effective content, source/draft metadata, history, evaluations, and action controls.

- [ ] **Step 1: Write failing detail tests**

```tsx
render(<DocumentationDetailPage id="doc-1" />);
expect(await screen.findByRole("heading", { name: "Draft title" })).toBeInTheDocument();
expect(screen.getByText("# Draft")).toBeInTheDocument();
expect(screen.getByText("Draft")).toBeInTheDocument();
expect(screen.getByText("No evaluations yet")).toBeInTheDocument();
```

Test 404/retry, source URL links, health flags, restore confirmation, evaluation trigger, sync trigger, and empty provenance/history.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run tests/documentation-detail-page.test.tsx tests/documentation-history.test.tsx tests/documentation-evaluations.test.tsx
```

- [ ] **Step 3: Keep the route ID-based**

The physical `[slug]` folder remains for compatibility, but its value is passed as `id`. Do not fetch on the server because `request()` depends on a client-set Clerk token and uses `window` on 401.

- [ ] **Step 4: Implement article and sidebar**

Render effective Markdown with `react-markdown` and `remark-gfm`, with raw HTML disabled unless sanitized. Build the table of contents from headings. Render actual title/path/category/status/version/timestamps, source repository/branch/commit, health flags, draft marker, and source link. Show “Not available”/“No source provenance available” for null data. Remove fake percentages, PRs, names, next-review dates, and activity.

- [ ] **Step 5: Implement History and Evaluations tabs**

History renders revisions and sync entries separately, supports revision viewing and confirmation-based restore, and reloads detail/history after success. Evaluations renders actual scores/metrics/failures or “No evaluations yet,” and triggers a queued evaluation without leaving the page. Every tab has loading/empty/error/retry states.

- [ ] **Step 6: Run checks and commit**

```bash
pnpm exec vitest run tests/documentation-detail-page.test.tsx tests/documentation-history.test.tsx tests/documentation-evaluations.test.tsx
pnpm lint
pnpm exec tsc --noEmit
git add components/sections/documentation 'app/(dashboard)/documentation/[slug]/page.tsx' tests/documentation-detail-page.test.tsx tests/documentation-history.test.tsx tests/documentation-evaluations.test.tsx
git commit -m "feat(ui): render live documentation details and history"
```

### Task 7: Convert the edit page to durable revisions

**Files:**

- Create: `draftly-agent-ui/components/sections/documentation/documentation-edit-page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/documentation/[slug]/edit/page.tsx`
- Test: `draftly-agent-ui/tests/documentation-edit-page.test.tsx`

**Interfaces:**

- Consumes: detail/action hooks and Markdown preview.
- Produces: an ID-based editor that loads real content, saves immutable revisions, and recovers from conflicts.

- [ ] **Step 1: Write failing editor tests**

```tsx
render(<DocumentationEditPage id="doc-1" />);
const editor = await screen.findByRole("textbox", { name: /markdown/i });
await user.clear(editor);
await user.type(editor, "# New draft");
await user.click(screen.getByRole("button", { name: /save changes/i }));
expect(saveRevision).toHaveBeenCalledWith("doc-1", {
  content: "# New draft",
  title: "Source title",
  base_source_hash: "sha-1",
  base_revision_id: null,
});
```

Test empty-content validation, disabled save, retry after 500, preview rendering, unsaved-navigation warning, 404, and 409 conflict recovery.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run tests/documentation-edit-page.test.tsx
```

- [ ] **Step 3: Make the route data-driven**

Pass the route value as `id`. Remove static OAuth Markdown, static preview, fake insights, and fake evidence. Initialize the editor once from `detail.effective.content`, track dirty state, preserve text on failures, and use labeled accessible controls.

- [ ] **Step 4: Implement save and conflict recovery**

Call `saveDocumentationRevision` with content, effective title, `source.source_hash`, and current `draft.id`. On success clear dirty state and navigate to the detail UUID only after a valid response. On 409 keep local text and offer explicit reload-server or copy-local choices; never silently overwrite.

- [ ] **Step 5: Run checks and commit**

```bash
pnpm exec vitest run tests/documentation-edit-page.test.tsx
pnpm lint
pnpm exec tsc --noEmit
git add components/sections/documentation/documentation-edit-page.tsx 'app/(dashboard)/documentation/[slug]/edit/page.tsx' tests/documentation-edit-page.test.tsx
git commit -m "feat(ui): save documentation edits as revisions"
```

### Task 8: Production verification, rollout, and documentation

**Files:**

- Modify: `draftly-agent-backend/docs/api/routes.md`
- Modify: `draftly-agent-backend/docs/architecture/documentation-pipeline.md`
- Modify: `draftly-agent-ui/README.md`
- Test: `draftly-agent-backend/tests/api/test_documentation_routes.py`
- Test: `draftly-agent-ui/tests/documentation-production-contract.test.tsx`

- [ ] **Step 1: Document contracts and exclusions**

Document list/detail/stats, revisions, history, evaluate, evaluations, sync, and sync-status endpoints. State that saves are Draftly revisions, source content comes from GitHub sync, 409 requires reconciliation, and publishing is not provided.

- [ ] **Step 2: Add anti-mock contract tests**

```ts
expect(documentationSource).not.toContain("lib/mock-data");
expect(documentationSource).not.toMatch(/127|318|284|OAuth 2\.0 Integration/);
expect(detailSource).toContain("useDocumentationDetail");
expect(editSource).toContain("saveDocumentationRevision");
```

Also assert every documentation link uses an API UUID and foreign fixtures return 404.

- [ ] **Step 3: Run backend verification**

```bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 uv run pytest -q
uv run ruff check src tests
```

In a live environment, apply migration 054 and verify two organizations cannot see each other’s documents/revisions/jobs/evaluations; list excludes content; saves preserve source content; sync is 202 plus observable transitions; evaluations target the selected document/revision; stale saves return 409 without an extra revision.

- [ ] **Step 4: Run frontend verification**

```bash
cd draftly-agent-ui
pnpm exec vitest run
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

Manually verify authenticated list/search/filter, detail/source link, edit/preview/save, conflict recovery, history/restore, evaluation trigger/results, sync progress/failure/retry, mobile layout, keyboard navigation, and screen-reader labels.

- [ ] **Step 5: Refresh graphify and commit docs**

```bash
cd /Applications/Projects/hackathon/draftly-docs-engineer
graphify update .
git add draftly-agent-backend/docs/api/routes.md draftly-agent-backend/docs/architecture/documentation-pipeline.md draftly-agent-ui/README.md draftly-agent-backend/tests/api/test_documentation_routes.py draftly-agent-ui/tests/documentation-production-contract.test.tsx
git commit -m "docs: document dynamic documentation actions and rollout"
```

## Self-Review

**Coverage:** Tasks 1–2 cover dynamic reads, org isolation, revision persistence, save, history, and sync. Task 3 covers targeted evaluations. Tasks 4–7 cover typed UI data flow, list/detail/edit components, actions, conflict handling, and honest states. Task 8 covers rollout, accessibility, build/test verification, and graph refresh.

**Consistency:** The shared identifiers are `document_id`, `revision_id`, `org_id`, `base_source_hash`, and `created_by`. The UI keeps the `[slug]` folder only as a URL compatibility slot and always passes its value as UUID `id`. List responses are projections; detail responses distinguish source, draft, and effective content. Evaluation target identity is the document UUID and revision identity is explicit metadata. Literal and nested routes precede `/{document_id}`.

**Completion evidence:** backend tests/Ruff, frontend Vitest/lint/TypeScript/build, migration application, cross-organization checks, and an authenticated manual smoke test of list/detail/edit/history/evaluation/sync are required before claiming completion.
