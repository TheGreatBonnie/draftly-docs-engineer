# Dynamic Review Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the review pages’ mock data and local action state with organization-scoped backend data while preserving the existing list/detail design, document viewer, counters, evidence, evaluation, and decision UI.

**Architecture:** Extend the existing backend review response with a backward-compatible `display` read model and enrich persisted review detail at the asynchronous workflow-runner boundary. Add typed frontend hooks around the already-existing `/reviews` API, keep pages as client data containers with presentational rows/cards, and keep approval/rejection routed through the existing `/github/review/{run_id}` resume endpoint.

**Tech Stack:** FastAPI/Python 3.11, CockroachDB, existing Draftly review/workflow repositories, Next.js 16 App Router, React 19, TypeScript, Tailwind, Clerk bearer tokens, existing dashboard SSE plus `useLiveRefresh`.

**Spec:** `docs/superpowers/specs/2026-09-09-dynamic-review-pages-design.md`

## Global Constraints

- Preserve the existing raw review API fields and add `display`; do not break current consumers.
- Keep all backend reads organization-scoped through the verified Clerk token.
- Do not perform database or network I/O inside synchronous `ReviewGate.gate`; enrich in the async runner persistence path.
- Do not create a second decision endpoint; use `POST /api/github/review/{run_id}` and the shared resume service.
- Do not fabricate original content, evidence, risk, evaluation dimensions, or “needs changes” decisions; render `—`, `Unknown`, or an unavailable message when absent.
- Use `request()` from `draftly-agent-ui/api/client.ts` for browser API calls so Clerk authentication and 401 handling remain centralized.
- Use the existing `useLiveRefresh`/dashboard SSE mechanism and retain its fallback interval.
- Do not remove `lib/mock-data.ts` until all review routes/components no longer import it; unrelated prototype pages may continue using it.
- Backend and frontend are separate git repositories; each implementation task commits only files in its repository.

---

### Task 1: Lock the backend display contract with failing tests

**Files:**
- Modify: `draftly-agent-backend/tests/api/test_reviews_routes.py`
- Create: `draftly-agent-backend/tests/api/test_review_display.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/reviews.py`

**Interfaces:**
- Consumes: `ReviewRecord`, existing `review_to_dict()`, existing GitHub enrichment, and `detail` JSON.
- Produces: `build_review_display(record: ReviewRecord, raw: dict[str, Any]) -> dict[str, Any]` and a `display` object on both list items and detail responses.

- [ ] **Step 1: Add representative display fixtures and assertions**

Create records covering a documentation change plan, a new document, a support answer, and a legacy record with no detail. Assert that `display` contains nullable-safe values for `title`, `reference`, `description`, `repository`, `files`, `change_type`, `risk`, `evaluation`, `evidence`, `github_url`, and `updated_at`.

```python
def test_display_maps_change_plan_fields() -> None:
    row = record(
        detail={
            "summary": "Updated widgets guide",
            "classification": {"change_type": "update", "urgency": "medium"},
            "evaluation": {
                "score": 0.94,
                "passed": True,
                "reasons": ["Grounded in 3/3 sources"],
            },
            "evidence": [{"id": "docs/widgets.md", "topic": "widgets"}],
            "document": {
                "kind": "change_plan",
                "repository": "acme/api",
                "files": [{
                    "path": "docs/widgets.md",
                    "action": "update",
                    "content": "# Widgets",
                    "original_content": "# Old widgets",
                    "original_content_available": True,
                }],
            },
        }
    )
    display = build_review_display(row, {"pr": {"trigger_label": "PR #42"}})
    assert display["title"] == "Updated widgets guide"
    assert display["reference"] == "PR #42"
    assert display["repository"] == "acme/api"
    assert display["files"][0]["original_content"] == "# Old widgets"
    assert display["evaluation"]["overall_score"] == 94.0
```

- [ ] **Step 2: Run the focused backend tests and verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_reviews_routes.py tests/api/test_review_display.py -q`

Expected: FAIL because `build_review_display` and the response `display` field do not exist yet.

- [ ] **Step 3: Define the backend display shapes and mapping rules**

In `routes/reviews.py`, add typed Pydantic response models or typed helper structures for:

```python
ReviewDisplayFile = {
    "path": str,
    "action": str | None,
    "original_content": str | None,
    "proposed_content": str | None,
    "original_content_available": bool,
}

ReviewDisplay = {
    "title": str | None,
    "reference": str | None,
    "description": str | None,
    "repository": str | None,
    "files": list[ReviewDisplayFile],
    "change_type": str | None,
    "risk": str | None,
    "evaluation": {
        "overall_score": float | None,
        "dimensions": list[dict[str, Any]],
        "reasons": list[str],
        "count": int | None,
    },
    "evidence": list[dict[str, Any]],
    "github_url": str | None,
    "updated_at": str | None,
}
```

Implement the title fallback in this order: document title, GitHub PR title, document summary, action description, first file path, then `None`. Normalize evaluation scores from `0–1` to `0–100`, preserve dimension rows only when present, and derive `updated_at` from `decided_at` or `created_at`.

- [ ] **Step 4: Attach `display` to list/detail responses without changing raw fields**

Call `build_review_display()` from `review_to_dict_enriched()` after `pr` enrichment and set `base["display"]`. Add assertions to existing route tests that list and detail responses still include `id`, `run_id`, `status`, `detail`, and `pr` alongside `display`.

- [ ] **Step 5: Run the focused backend tests and commit**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_reviews_routes.py tests/api/test_review_display.py -q`

Expected: PASS.

Commit in the backend repository: `git add src/draftly/app/api/routes/reviews.py tests/api/test_reviews_routes.py tests/api/test_review_display.py && git commit -m "feat: expose dynamic review display data"`

---

### Task 2: Persist complete review detail at the async interrupt boundary

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/hooks/review_gate.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/reviews.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/documents.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/database/document_store.py`
- Modify: `draftly-agent-backend/tests/graph/test_review_gate.py`
- Modify: `draftly-agent-backend/tests/persistence/test_reviews_detail.py`
- Create: `draftly-agent-backend/tests/workflows/test_review_detail_enrichment.py`

**Interfaces:**
- Consumes: graph-local `classification`, `context`/`research` evidence, `evaluate` output, normalized workflow event, and proposed document files.
- Produces: `_enrich_review_reason(reason: Any, state: WorkflowState) -> dict[str, Any]` in `WorkflowRunner`, with persisted `detail` containing evidence, classification, and document metadata.

- [ ] **Step 1: Add failing persistence assertions for evidence/classification**

Extend the review-gate tests to assert that an interrupt reason includes `classification` and structured `evidence` when graph state contains them. Extend persistence tests to assert those fields survive JSON serialization in `detail`.

```python
assert reason["classification"]["urgency"] == "high"
assert reason["evidence"][0]["id"] == "src/auth/oauth.py:10"
assert detail["document"]["files"][0]["content"] == "# Widgets"
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/graph/test_review_gate.py tests/persistence/test_reviews_detail.py tests/workflows/test_review_detail_enrichment.py -q`

Expected: FAIL because the gate reason and runner enrichment do not yet include the new fields.

- [ ] **Step 3: Collect graph-local evidence and classification in `ReviewGate`**

Add a synchronous helper that reads `safe_node_data()` from the `context` and `research` graph nodes, accepts either `evidence` or `items`, retains dictionary evidence items, and returns an empty list for legacy/freeform payloads. Add the already-resolved classification to the interrupt reason:

```python
reason={
    "run_id": state.get("run_id"),
    "summary": summary,
    "evaluation": evaluation,
    "evidence_count": state.get("evidence_count", 0),
    "evidence": _collect_evidence(event.source),
    "classification": classification,
    "document": document or None,
}
```

- [ ] **Step 4: Enrich original file content in the async runner path**

Implement `_enrich_review_reason()` near `_store_interrupts()`. It must clone the reason, inspect `document.files`, and for each file with `action == "update"` query an organization-scoped document lookup. If no existing document is found, set `original_content` to `None` and `original_content_available` to `False`; for `create`, use the same unavailable state. Catch lookup failures per file, log them, and continue persisting the proposed review.

Add a repository/store method with exact signatures so repository/path lookup cannot cross tenants:

```python
async def get_by_org_repository_path(
    self, *, org_id: str, repository: str, path: str
) -> dict[str, Any] | None:
```

Use `state.event["project_id"]` as `org_id`, the document’s `repository`, and each file path. Call enrichment before `reviews.store_interrupt()` in `_store_interrupts()`; do not add awaitable work to `ReviewGate.gate()`.

- [ ] **Step 5: Make `_reason_detail()` retain enriched fields safely**

Update `ReviewsRepository._reason_detail()` to preserve `classification`, `evidence`, and the enriched document fields while keeping legacy non-dict reasons mapped to `{}`. Ensure JSONB serialization accepts empty/null values and `_row_to_record()` still handles JSON strings, dicts, and nulls.

- [ ] **Step 6: Run backend detail tests and commit**

Run: `cd draftly-agent-backend && python -m pytest tests/graph/test_review_gate.py tests/persistence/test_reviews_detail.py tests/workflows/test_review_detail_enrichment.py -q`

Expected: PASS.

Commit in the backend repository: `git add src/draftly/orchestration/hooks/review_gate.py src/draftly/workflows/runner.py src/draftly/persistence/repositories/reviews.py src/draftly/persistence/repositories/documents.py src/draftly/integrations/database/document_store.py tests/graph/test_review_gate.py tests/persistence/test_reviews_detail.py tests/workflows/test_review_detail_enrichment.py && git commit -m "feat: persist complete review detail"`

---

### Task 3: Add dynamic list metadata and truthful status/count semantics

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/reviews.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/reviews.py`
- Modify: `draftly-agent-backend/tests/api/test_reviews_routes.py`
- Create: `draftly-agent-backend/tests/persistence/test_review_counts.py`

**Interfaces:**
- Consumes: organization-scoped review records and `display` values.
- Produces: `list_reviews(..., cursor: str | None = None) -> {items, total, counts, next_cursor}` with bounded pages and deterministic ordering.

- [ ] **Step 1: Add failing tests for counts, filtering, and pagination metadata**

Assert that counts are calculated for the full organization, `status` filters only items, terminal statuses are lowercase API values, low-score reviews can contribute to `urgent`, and `needs_changes` is zero unless the record explicitly contains that decision/status. Assert that a page returns `total` and an opaque `next_cursor` when more rows remain.

- [ ] **Step 2: Run the route tests and verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_reviews_routes.py tests/persistence/test_review_counts.py -q`

Expected: FAIL because the route currently returns only `items` and the repository has no count/cursor contract.

- [ ] **Step 3: Implement organization-scoped counts and deterministic cursor pagination**

Add repository methods that count by `org_id` and derive urgent from persisted display evidence (high/critical risk or normalized score below 80). Keep `needs_changes` at zero for records that only contain approve/reject/expired semantics. Order rows by `(created_at, id)` and encode the last tuple as an opaque cursor. Enforce `1 <= limit <= 200`.

- [ ] **Step 4: Extend the route response while retaining compatibility**

Accept `cursor` in `GET /api/reviews`, call the list and count methods with the verified organization ID, and return:

```json
{
  "items": [],
  "total": 0,
  "counts": {
    "pending": 0,
    "urgent": 0,
    "approved": 0,
    "needs_changes": 0,
    "rejected": 0
  },
  "next_cursor": null
}
```

- [ ] **Step 5: Run route/persistence tests and commit**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_reviews_routes.py tests/persistence/test_review_counts.py -q`

Expected: PASS.

Commit in the backend repository: `git add src/draftly/persistence/repositories/reviews.py src/draftly/app/api/routes/reviews.py tests/api/test_reviews_routes.py tests/persistence/test_review_counts.py && git commit -m "feat: add review counts and pagination"`

---

### Task 4: Add frontend review types, normalization, and hooks

**Files:**
- Modify: `draftly-agent-ui/api/observability.ts`
- Create: `draftly-agent-ui/lib/reviews.ts`
- Create: `draftly-agent-ui/hooks/use-reviews.ts`
- Create: `draftly-agent-ui/hooks/use-review.ts`
- Create: `draftly-agent-ui/tests/reviews.test.ts`

**Interfaces:**
- Consumes: backend `ReviewSummary`, optional `display`, `listReviews()`, `getReview()`, and `useLiveRefresh()`.
- Produces: `ReviewDisplay`, `ReviewListResponse`, `toReviewViewModel(review)`, `useReviews(options?)`, and `useReview(reviewId)`.

- [ ] **Step 1: Write failing adapter tests**

Test the exact fallback rules for a fully enriched change plan, a new document, a legacy raw record, a score of `0.94`, a score of `94`, null evaluation, lowercase statuses, and multiple files.

```ts
const view = toReviewViewModel(rawReview);
assert.equal(view.score, 94);
assert.equal(view.files[0].proposedContent, "# Widgets");
assert.equal(view.originalContentAvailable, true);
```

- [ ] **Step 2: Run frontend tests and verify they fail**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern=reviews`

Expected: FAIL because the view-model types and adapter do not exist.

- [ ] **Step 3: Extend API types without removing raw fields**

Add TypeScript types for display files, evaluation dimensions, evidence items, display metadata, list counts, and optional pagination. Update `listReviews()` to accept `{ status?: string; limit?: number; cursor?: string }` while preserving existing positional-call compatibility or update all current callers in the same task.

- [ ] **Step 4: Implement the pure adapter**

Create `toReviewViewModel(review: ReviewSummary): ReviewViewModel` with these rules:

- use backend `display` when present;
- fall back to `detail.document`, `detail.summary`, `action_description`, `pr`, and raw timestamps for legacy records;
- normalize score to a bounded `0–100` number or `null`;
- preserve all backend files/evidence/dimensions;
- convert backend status to display labels only at the UI boundary;
- return `null` for unavailable risk, original content, GitHub URL, or evaluation count.

- [ ] **Step 5: Implement `useReviews()` and `useReview()`**

`useReviews({ status, cursor })` should call `listReviews()` through `useLiveRefresh` with `workflow:changed` and `review:completed` event names. `useReview(reviewId)` should call `getReview(reviewId)` with the same refresh behavior. Both hooks expose `{ data, error, isLoading, isRefreshing, refresh }` and retain the last successful data during refresh failures.

- [ ] **Step 6: Run tests and commit**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern=reviews`

Expected: PASS.

Commit in the frontend repository: `git add api/observability.ts lib/reviews.ts hooks/use-reviews.ts hooks/use-review.ts tests/reviews.test.ts && git commit -m "feat: add review data hooks and view model"`

---

### Task 5: Convert the reviews list and route-backed subpages

**Files:**
- Create: `draftly-agent-ui/components/sections/reviews/reviews-page.tsx`
- Create: `draftly-agent-ui/components/sections/reviews/reviews-subpage.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/reviews/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/reviews/pending/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/reviews/approved/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/reviews/rejected/page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/reviews/needs-attention/page.tsx`
- Modify: `draftly-agent-ui/components/sections/reviews/index.ts`
- Modify: `draftly-agent-ui/components/dashboard/section-subpage.tsx`
- Modify: `draftly-agent-ui/components/dashboard/section-tabs.tsx`
- Create: `draftly-agent-ui/components/sections/reviews/reviews-page.test.tsx`

**Interfaces:**
- Consumes: `useReviews()`, `ReviewViewModel`, dynamic counts, and existing dashboard primitives.
- Produces: client `ReviewsPage` and `ReviewsSubpage` containers that render no mock business data and preserve the existing visual layout.

- [ ] **Step 1: Add failing rendering tests**

Render a mocked API response and assert the real title, repository, file path, score, risk, status, dynamic metric counts, result count, empty state, and retry state. Assert that no fallback row appears when `items` is empty.

- [ ] **Step 2: Run the focused frontend test and verify it fails**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern='ReviewsPage|ReviewsSubpage'`

Expected: FAIL because the new client containers do not exist.

- [ ] **Step 3: Move the existing list markup into `ReviewsPage` and bind it to `useReviews()`**

Keep `ReviewRow`, badges, icons, column layout, page header, and filter controls visually unchanged. Replace the mock map with adapted API items. Bind search to local/URL state, derive repository/type/risk/score filters from real items, and render dynamic loading/error/empty states using existing primitives. Show `isRefreshing` without clearing current rows.

- [ ] **Step 4: Make metric cards dynamic**

Use backend `counts` for Pending, Urgent, Approved, Rejected, and Needs changes. If `needs_changes` is unavailable, show `—` and explanatory copy rather than treating rejected records as returned revisions. Remove literal values `12`, `4`, `47`, `3`, and `8`.

- [ ] **Step 5: Replace fake pagination with API pagination**

Render `total`, the current item interval, previous cursor state, and `next_cursor`. Disable previous/next controls appropriately. Do not display hardcoded “1 to 5 of 12” or pages `1`, `2`, and `3`.

- [ ] **Step 6: Convert subpages and navigation counts**

Implement `ReviewsSubpage({ kind })` as a client component using `useReviews({ status })` for pending/approved/rejected and local derived filtering for needs-attention. Remove the old mock `ReviewsSubpage` from `section-subpage.tsx` and its `reviews` import; leave `lib/mock-data.ts` available only to unrelated prototype pages until all review imports are gone. Change `SectionTabs` to accept optional dynamic review counts while preserving its route behavior.

- [ ] **Step 7: Run focused tests, type-check, and commit**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern='ReviewsPage|ReviewsSubpage' && npx tsc --noEmit`

Expected: PASS with no review page import of `lib/mock-data.ts`.

Commit in the frontend repository: `git add 'app/(dashboard)/reviews' components/sections/reviews components/dashboard/section-subpage.tsx components/dashboard/section-tabs.tsx components/sections/reviews/reviews-page.test.tsx && git commit -m "feat: render dynamic review lists"`

---

### Task 6: Convert review detail, document files, evidence, and evaluation

**Files:**
- Create: `draftly-agent-ui/components/sections/reviews/review-detail-page.tsx`
- Modify: `draftly-agent-ui/app/(dashboard)/reviews/[id]/page.tsx`
- Modify: `draftly-agent-ui/components/dashboard/review-document.tsx`
- Create: `draftly-agent-ui/components/sections/reviews/review-detail-page.test.tsx`

**Interfaces:**
- Consumes: `useReview(id)`, `ReviewViewModel`, `display.files`, `display.evidence`, and `display.evaluation`.
- Produces: a client detail container that renders real review metadata and passes real files/content into `ReviewDocument`.

- [ ] **Step 1: Add failing detail tests**

Assert that the detail page renders backend title/reference/status/description/repository, all file paths, proposed content, original-content availability, evaluation score/reasons/dimensions, evidence rows, created/decided timestamps, GitHub link, loading skeleton, 404/empty state, and retryable fetch error.

- [ ] **Step 2: Run the focused detail test and verify it fails**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern=ReviewDetail`

Expected: FAIL because the client detail container and dynamic file/evidence rendering do not exist.

- [ ] **Step 3: Convert the route into a params wrapper and fetch detail client-side**

Resolve `{ id }` in the existing route page, render `<ReviewDetailPage id={id} />`, and move the current JSX into the client component. Replace the mock lookup and `notFound()` decision with hook state: backend 404 maps to the existing not-found route/state, while transport failures expose retry.

- [ ] **Step 4: Replace every static detail field**

Remove the hardcoded timestamp, evidence array, evaluation values, and mock document fields. Render:

- reference from `display.reference`;
- repository/path/type/risk from `display`;
- evaluation score, reasons, and only returned dimensions;
- evidence title/detail/count/url from `display.evidence`;
- `—` or a clear unavailable message for absent data.

- [ ] **Step 5: Support multiple proposed files in `ReviewDocument`**

Extend the component props to accept `files: ReviewDisplayFile[]`, keep the rendered/diff/source tabs, and add a compact file selector when there is more than one file. Selecting a file recomputes the diff from that file’s original/proposed content. For a missing original body, show the proposed document and an explicit “Original content unavailable” message instead of presenting an empty diff as authoritative.

- [ ] **Step 6: Run tests and commit**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern=ReviewDetail && npx tsc --noEmit`

Expected: PASS.

Commit in the frontend repository: `git add 'app/(dashboard)/reviews/[id]/page.tsx' components/sections/reviews components/dashboard/review-document.tsx components/sections/reviews/review-detail-page.test.tsx && git commit -m "feat: render dynamic review details"`

---

### Task 7: Wire approve/reject actions and decision history

**Files:**
- Modify: `draftly-agent-ui/components/dashboard/review-actions.tsx`
- Modify: `draftly-agent-ui/components/sections/reviews/review-detail-page.tsx`
- Modify: `draftly-agent-ui/api/github.ts`
- Create: `draftly-agent-ui/components/dashboard/review-actions.test.tsx`

**Interfaces:**
- Consumes: `ReviewViewModel.id`, `ReviewViewModel.runId`, `ReviewViewModel.status`, `decideReview(runId, approved, comment)`, and detail/list refresh callbacks.
- Produces: real approve/reject controls with comment submission, pending-only availability, mutation/error state, and backend decision history.

- [ ] **Step 1: Add failing action tests**

Assert that clicking approve calls `decideReview(review.runId, true, comment)`, clicking reject calls it with `false`, the comment is submitted, buttons disable during the request, terminal reviews have no active controls, and `404`/`409` errors are shown without changing the displayed status.

- [ ] **Step 2: Run the action test and verify it fails**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern=ReviewActions`

Expected: FAIL because the component currently has no props, no API call, and only local mock status.

- [ ] **Step 3: Replace local state with the existing decision API**

Change `ReviewActions` to accept `runId`, `status`, and `onDecisionSaved`, and render the comment textarea plus `Approve`, `Request changes`, and `Reject` buttons inside the right-column decision card. Call `decideReview()` with an explicit decision value, require a comment for `request_changes`, show pending/error state, and invoke refresh callbacks after success. The backend persists `needs_changes`, starts a fresh agent run carrying the reviewer feedback, and forces that run through a new review gate.

- [ ] **Step 4: Remove duplicate independent action state**

Remove the actionable control group from the detail toolbar. Put one `ReviewActions` instance in the right-column Review decision card. For terminal reviews, show backend-driven decision status, comment, and reviewer/decision metadata when available; for pending reviews, show the live controls in the card.

- [ ] **Step 5: Refresh detail/list data after success**

Call the detail hook’s `refresh()` after a successful decision. Use the existing dashboard event refresh for the list, and expose a callback from the detail container if the list is mounted in a shared client boundary. The detail must immediately show the new terminal status and decision comment.

- [ ] **Step 6: Run tests and commit**

Run: `cd draftly-agent-ui && npm test -- --test-name-pattern=ReviewActions && npx tsc --noEmit`

Expected: PASS.

Commit in the frontend repository: `git add components/dashboard/review-actions.tsx components/dashboard/review-actions.test.tsx components/sections/reviews/review-detail-page.tsx api/github.ts && git commit -m "feat: persist review decisions from dashboard"`

---

### Task 8: Complete live refresh, compatibility cleanup, and verification

**Files:**
- Modify: `draftly-agent-ui/components/live-events/live-events-provider.tsx`
- Modify: `draftly-agent-ui/hooks/use-live-refresh.ts` only if required by tests
- Modify: `draftly-agent-ui/README.md`
- Create: `draftly-agent-ui/tests/review-live-refresh.test.ts`
- Modify: `draftly-agent-backend/tests/api/test_reviews_routes.py` only for final contract coverage

**Interfaces:**
- Consumes: `useReviews`, `useReview`, dashboard SSE event names, backend workflow lifecycle broadcasts, and the final `display`/counts contract.
- Produces: live review list/detail refresh behavior, documentation of the integrated backend requirement, and a clean no-mock review path.

- [ ] **Step 1: Add a live-refresh test**

Mock the dashboard event version and assert that a `workflow:changed` transition causes list/detail hooks to refetch while retaining the previous successful data during a failed refresh.

- [ ] **Step 2: Verify event compatibility**

Confirm that the backend runner broadcasts `workflow:changed` for pending-review and terminal transitions. Keep `review:completed` as an optional event name, but do not make it the only trigger because the current backend does not emit the colon-form event consistently.

- [ ] **Step 3: Remove remaining review mock imports and literals**

Run:

```bash
cd draftly-agent-ui
rg -n "lib/mock-data|\breviews\b|Showing 1 to 5 of 12|Current mock state|mock review data|Correctness.*98|GitHub PR #142" app components hooks api lib --glob '*.ts' --glob '*.tsx'
```

Expected: no review production route/component imports the mock review array, no mock action copy remains, and no hardcoded review business metrics remain. Unrelated prototype-page matches may remain outside the review feature.

- [ ] **Step 4: Update UI integration notes**

Update `draftly-agent-ui/README.md` to state that review routes require the running Draftly backend, Clerk token setup, and the `API_URL` rewrite. Remove the statement that review actions are local-only.

- [ ] **Step 5: Run final backend verification**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/api/test_reviews_routes.py tests/api/test_review_display.py tests/persistence/test_reviews_detail.py tests/persistence/test_review_counts.py tests/graph/test_review_gate.py tests/workflows/test_review_detail_enrichment.py -q
```

Expected: PASS.

- [ ] **Step 6: Run final frontend verification**

Run:

```bash
cd draftly-agent-ui
npm test
npx tsc --noEmit
npm run build
```

Expected: PASS with no TypeScript errors and a production build that contains the dynamic review routes.

- [ ] **Step 7: Commit final frontend/backend documentation and cleanup**

Commit frontend changes with: `git add README.md components/live-events tests/review-live-refresh.test.ts && git commit -m "test: verify dynamic review refresh"`

Commit any final backend test-only changes in the backend repository with: `git add tests && git commit -m "test: cover review display contract"`

---

## Execution Notes

Implement Tasks 1–3 in `draftly-agent-backend` before Tasks 4–8 in `draftly-agent-ui`, because the frontend types and fixtures depend on the backend response contract. Use a separate worktree for implementation if the executor is not already isolated. Do not run `graphify update .` for the plan-only change; run it after application code is modified, once per modified repository, before the final verification claim.
