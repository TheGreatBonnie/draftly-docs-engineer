# Content production MVP

Draftly turns approved project evidence into reviewable blog, LinkedIn, and X
drafts. Supported sources are published GitHub releases, merged PRs marked
`content-relevant`, documentation sources, manual briefs, and feedback-loop
`ContentOpportunity` records.

Every package is organization-scoped and retains source evidence, feedback-gap
IDs, revisions, evaluation metadata, and reviewer decisions. Generation is
draft-only: the MVP has no publishing, scheduling, OAuth delivery, platform
retry, or analytics integration.

The lifecycle is:

1. Normalize a source with non-empty evidence.
2. Generate channel variants and evaluate groundedness, completeness,
   relevance, and channel fit.
3. Persist the package in `in_review`.
4. Approve, reject, or request changes. Changes create a new revision and must
   be evaluated again before approval.

Future publishing adapters must consume only approved packages and remain
separate from this workflow.
