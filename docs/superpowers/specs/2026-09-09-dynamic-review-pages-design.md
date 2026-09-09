# Dynamic Review Pages Design

**Date:** 2026-09-09

**Status:** Approved direction; implementation plan pending review of this design.

## Goal

Make the Draftly review list, review detail page, review subpages, shared review components, counters, document viewer, and decision actions display organization-scoped backend data while preserving the existing visual design and providing truthful loading, empty, error, and unavailable-data states.

## Current State

The UI is a Next.js prototype. The main list page and detail page import `draftly-agent-ui/lib/mock-data.ts`. The review subpages and review navigation also use the same mock array. The review document component is already presentation-oriented and receives document content through props, but its caller supplies mock content. The review action component mutates local React state and does not call the backend.

The backend already exposes authenticated, organization-scoped read endpoints:

- `GET /api/reviews?status=&limit=` returns `{items: ReviewSummary[]}`.
- `GET /api/reviews/{review_id}` returns `{review: ReviewSummary}`.
- `GET /api/reviews/by-run/{run_id}` returns the pending review for a run.
- `POST /api/github/review/{run_id}` resumes the paused workflow and records an approve/reject decision.

The backend review response currently contains the durable review record, optional GitHub metadata, and the structured interrupt detail. The interrupt detail includes the proposed document payload, evaluation result, summary, and evidence count. It does not yet contain all data required by the existing design, such as original file content, evidence rows, direct GitHub URL, reliable risk/type metadata, evaluation count, or granular evaluation dimensions.

## Design Decisions

### 1. Backend owns the review read model; frontend owns rendering

The backend will preserve the existing raw review fields and add a derived `display` object to list and detail responses. This object is a stable read model for the existing UI design. It prevents list/detail pages from independently reconstructing titles, paths, scores, status labels, and links from loosely shaped workflow payloads.

The frontend will use typed API functions and a small adapter only for formatting concerns such as relative timestamps, percentage display, and semantic badge tones. It will not invent missing business values.

### 2. Review detail data is captured at the review boundary

The synchronous `ReviewGate.gate` callback must not perform database or network I/O. It will continue to collect graph-local information in the interrupt reason. The asynchronous workflow runner path that persists interrupts will enrich that reason before calling `ReviewsRepository.store_interrupt`.

The enrichment path will:

- retain the proposed file payload produced by the writer;
- copy structured evidence from the context/research graph results when available;
- copy the evaluation score, pass/fail state, reasons, and any truthful dimensions available from the evaluator;
- resolve the current organization-scoped documentation record by repository/path to capture `original_content` for an update;
- use an empty original body and an explicit availability flag when no prior document exists, which is correct for a newly created document or an unavailable baseline;
- retain source and GitHub identity from the normalized event and `github_workflows` record;
- never persist credentials, installation tokens, or unbounded raw event payloads.

This keeps the review page stable even if the source repository or current documentation changes after the review is created.

### 3. Existing design fields remain visible, but absent values are explicit

The UI will keep the existing layout and field labels. When the backend cannot provide a truthful value, the component will show `—`, `Unknown`, or an unavailable-state message rather than a fabricated value.

In particular, the five hardcoded evaluation bars will be replaced with backend-provided dimensions. The backend must not derive correctness or consistency scores from unrelated heuristics. If only overall score/reasons exist, the card will show the overall score and reasons while omitting unavailable dimension rows. A later evaluator enhancement can populate more dimensions without changing the UI contract.

### 4. Review decisions remain single-sourced

The frontend will call the existing `POST /api/github/review/{run_id}` route. It will not create a second decision route or directly mutate the reviews table. The backend continues to validate organization membership, reviewer role, pending status, workflow resumption, and terminal outcome through `resume_review_decision`.

The current backend has two decision outcomes: approved and rejected. The existing “Request changes” visual action cannot be sent as a distinct decision without changing the backend workflow contract. The implementation will either rename that action to match the existing reject semantics or add an explicit request-changes contract end-to-end. The recommended initial scope is to keep the current approve/reject behavior and avoid labeling rejection as “Needs changes.”

## Canonical API Contract

The existing raw fields remain backward compatible. Each item additionally exposes `display`:

```json
{
  "display": {
    "title": "OAuth authentication guide",
    "reference": "PR #142",
    "description": "Update authentication documentation based on the new implementation.",
    "repository": "acme/api",
    "files": [
      {
        "path": "docs/authentication.md",
        "action": "update",
        "original_content": "# OAuth authentication",
        "proposed_content": "# OAuth authentication\n\n## Refresh tokens",
        "original_content_available": true
      }
    ],
    "change_type": "documentation_update",
    "risk": "low",
    "evaluation": {
      "overall_score": 94.0,
      "dimensions": [],
      "reasons": ["Grounded in 3/3 sources"],
      "count": null
    },
    "evidence": [
      {
        "kind": "github",
        "title": "Pull request evidence",
        "detail": "PR #142",
        "url": "https://github.com/acme/api/pull/142",
        "reference_count": 3
      }
    ],
    "github_url": "https://github.com/acme/api/pull/142",
    "updated_at": "2026-09-09T10:24:00Z"
  }
}
```

The actual response must use nullable fields where data is unavailable. Scores are normalized to `0–100` in `display`; the raw evaluator score remains available in `detail` in its existing `0–1` form.

The list response will additionally expose:

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

`urgent` and `needs_changes` are derived only when the backend has corresponding evidence. A low score may contribute to `urgent`; a rejected review must not be counted as `needs_changes` unless the workflow explicitly records that decision.

## Backend Architecture

The backend implementation will be organized around these boundaries:

1. `review_gate.py` continues to build graph-local review reasons without I/O.
2. `workflows/runner.py` enriches interrupt data in its asynchronous `_store_interrupts` path.
3. `persistence/repositories/reviews.py` persists the structured detail and maps database rows safely.
4. `app/api/routes/reviews.py` maps raw records to the backward-compatible raw response plus the normalized `display` read model.
5. Existing `github.py` resume behavior remains the decision authority.

The enrichment must be organization-scoped for documentation lookup and must degrade gracefully when the documentation repository, GitHub workflow row, or optional source metadata is unavailable. Backend tests will cover both enriched and legacy records so old reviews remain renderable.

## Frontend Architecture

The UI will separate data fetching from presentation:

```text
ReviewListContainer ── useReviews ── listReviews ── GET /api/reviews
        │
        └── ReviewList / ReviewRow

ReviewDetailContainer ── useReview ── getReview ── GET /api/reviews/:id
        │
        ├── ReviewDocument
        └── ReviewActions ── decideReview ── POST /api/github/review/:run_id
```

The route files may remain server route wrappers for params and metadata, but data-fetching components will be client components because `api/client.ts` obtains the Clerk bearer token from the browser-side `AuthTokenSetter`.

The hooks will use the existing `useLiveRefresh` mechanism. Initial requests will show layout-preserving skeletons. Failed refreshes will retain the last successful data and expose a retry action. An initial failure will show an error state. Empty results will show an explicit empty state instead of falling back to mock rows.

Search and filters will be URL state where they are shareable. The backend `status` filter will be used for review subpages; repository, type, risk, score, and text filters can initially operate over the bounded response locally. Once list pagination is added, the backend will own search/filter/pagination parameters and the UI will stop assuming five rows or three pages.

The shared section navigation will receive dynamic counts. The current hardcoded counts in `section-tabs.tsx` will not remain in the production review path.

## Live Refresh

The dashboard already subscribes to organization-scoped dashboard SSE and the runner broadcasts `workflow:changed` during pending-review and terminal workflow transitions. Review hooks will refresh on those events and retain the existing fallback interval. After a decision, the action mutation will explicitly refresh the current detail and list data so the user does not wait for SSE or polling.

The frontend should not depend on the currently unused `review:completed` event name as the only refresh trigger. If a dedicated review-created/completed dashboard event is added, it must use the same organization-scoped broadcaster and remain an optimization rather than the only consistency mechanism.

## Error, Security, and Compatibility Requirements

- All reads remain scoped by the Clerk organization in the backend.
- Decision controls are available only for pending reviews and must surface reviewer-role failures.
- A review ID is used for reads; the associated `run_id` is used for decisions.
- Backend `404` and `409` responses are rendered as actionable UI states.
- Missing original content, evidence, dimensions, risk, or GitHub URL must be explicit, never replaced with mock values.
- Existing raw API fields remain available to avoid breaking current consumers.
- No API credentials or installation secrets may be placed in review detail, client state, or URLs.
- `lib/mock-data.ts` may remain for unrelated prototype pages during this change, but no review production route or review component may import it after migration.

## Testing Strategy

Backend tests:

- review display mapping for change-plan, answer, and content-variant documents;
- score normalization and nullable evaluation dimensions;
- evidence and original-content enrichment, including missing-baseline behavior;
- list counts, status filtering, pagination metadata, and organization isolation;
- compatibility for legacy rows with empty/null detail;
- approve/reject behavior and invalid request-changes semantics.

Frontend tests:

- pure raw-review-to-display adapter mappings;
- list/detail hooks with mocked API responses, refresh, error, and empty states;
- dynamic list metrics, filtering, counts, and pagination text;
- detail rendering of multiple files, missing original content, evidence, and evaluation dimensions;
- action submission with `run_id`, comment, disabled terminal states, success refresh, and `404`/`409` errors;
- route-level build/type checking and responsive/accessibility checks at existing UI breakpoints.

## Non-Goals

- Rebuilding the overall dashboard data architecture.
- Introducing React Query, SWR, or a new global store when the existing `useLiveRefresh` pattern is sufficient.
- Creating a second review-decision endpoint.
- Making unrelated prototype pages dynamic.
- Showing fabricated evaluation dimensions, risk values, evidence, or original content merely to fill the existing layout.
