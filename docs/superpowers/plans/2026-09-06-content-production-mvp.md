# Content Production MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Extend Draftly from documentation engineering into a trusted, reviewable content-production workflow that turns GitHub changes, project documentation, manual briefs, and feedback gaps into blog posts, LinkedIn posts, and X posts.

**Architecture:** Add a content domain and workflow graph that reuses Draftly’s existing memory retrieval, agent orchestration, evaluation, workflow events, and human-review infrastructure. The first release generates and persists drafts only; publishing, scheduling, and analytics integrations are explicitly excluded.

**Tech Stack:** Python, FastAPI, Pydantic, existing workflow runner, Strands graph orchestration, PostgreSQL/CockroachDB persistence, existing memory/evaluation/review services, Redis workflow events.

**Spec:** This plan is self-contained; no separate design document is required.

## Global Constraints

- Source material must come from project documentation, indexed repository content, GitHub pull requests, and GitHub releases.
- Feedback gaps may be used as content sources through the `ContentOpportunity` handoff defined by the feedback-loop wiring plan.
- Generated claims must be grounded in retrieved project evidence.
- Supported outputs are `blog`, `linkedin`, and `x`.
- Content must remain in Draftly until a human reviewer approves it.
- No external publishing or scheduling is included in this MVP.
- Approved content is an internal Draftly artifact; it is not considered published.
- All content data and API responses must be organization-scoped.
- Existing documentation workflows, review policies, memory services, and workflow event contracts must remain backward-compatible.
- Content generation must be idempotent for repeated source events and feedback-gap dispatch retries.
- Reviewer changes must trigger revision, re-evaluation, and another review gate before approval.

---

### Task 1: Define the content domain contract

**Files:**
- Create: `draftly-agent-backend/src/draftly/content/models.py`
- Create: `draftly-agent-backend/src/draftly/content/service.py`
- Create: `draftly-agent-backend/src/draftly/content/source_adapters.py`
- Test: `draftly-agent-backend/tests/content/test_models.py`

**Interfaces:**

```python
class ContentChannel(str, Enum):
    BLOG = "blog"
    LINKEDIN = "linkedin"
    X = "x"


class ContentPackageStatus(str, Enum):
    DRAFT = "draft"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    REJECTED = "rejected"


class ContentRequest(BaseModel):
    org_id: str
    repository_id: str
    source_event_id: str
    source_event_type: Literal["pull_request", "release", "documentation", "manual_brief", "feedback_gap"]
    source_title: str
    source_summary: str
    source_feedback_ids: list[str] = []
    source_gap_id: str | None = None
    source_evidence: list[dict[str, str]] = []
    requested_channels: list[ContentChannel]
    audience: str = "developers and users"
    tone: str = "clear, practical, trustworthy"


class ContentRevision(BaseModel):
    id: str
    package_id: str
    revision_number: int
    reason: Literal["initial", "request_changes", "regeneration"]
    reviewer_comment: str | None
    created_by_run_id: str
    created_at: datetime


class ContentVariant(BaseModel):
    id: str
    package_id: str
    channel: ContentChannel
    title: str | None
    body: str
    status: ContentPackageStatus
    evidence: list[dict[str, str]]
    evaluation: dict[str, Any] | None = None
    revision_id: str


class ContentPackage(BaseModel):
    id: str
    org_id: str
    repository_id: str
    source_event_id: str
    status: ContentPackageStatus
    brief: dict[str, Any]
    variants: list[ContentVariant]
    workflow_run_id: str
    source_evidence: list[dict[str, str]]
    revisions: list[ContentRevision]
```

- Add service methods:
  - `create_package(request: ContentRequest) -> ContentPackage`
  - `get_package(org_id: str, package_id: str) -> ContentPackage | None`
  - `list_packages(org_id: str, status: ContentPackageStatus | None = None) -> list[ContentPackage]`
  - `update_status(org_id: str, package_id: str, status: ContentPackageStatus) -> ContentPackage`
  - `create_revision(org_id: str, package_id: str, reviewer_comment: str | None) -> ContentRevision`
  - `record_review(org_id: str, package_id: str, decision: str, comment: str | None) -> ContentPackage`

- Add source adapters:
  - `from_github_event(org_id: str, event: dict[str, Any]) -> ContentRequest`
  - `from_documentation_source(org_id: str, source: dict[str, Any]) -> ContentRequest`
  - `from_manual_brief(org_id: str, brief: dict[str, Any]) -> ContentRequest`
  - `from_content_opportunity(org_id: str, opportunity: ContentOpportunity) -> ContentRequest`

- Validate that:
  - at least one channel is requested;
  - `source_event_id`, `repository_id`, and `org_id` are non-empty;
  - X content stays within the configured maximum length;
  - each variant retains evidence references.
  - `feedback_gap` requests include both `source_gap_id` and at least one source feedback id;
  - `source_evidence` is non-empty before generation begins;
  - revision numbers increase monotonically per package.

- [x] Add model validation tests.
- [x] Run model tests and verify they pass.
- [x] Implement the models and service contract.
- [x] Implement source adapters for GitHub, documentation, manual brief, and `ContentOpportunity` inputs.
- [x] Add model tests for source provenance, revision numbering, and feedback-gap requirements.
- [x] Run the tests and verify they pass.

---

### Task 2: Add durable content persistence

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/042_content_packages.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/content.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Test: `draftly-agent-backend/tests/persistence/test_content_repository.py`

**Database contract:**

Create:

- `content_packages`
  - `id`
  - `org_id`
  - `repository_id`
  - `source_event_id`
  - `source_event_type`
  - `status`
  - `brief_json`
  - `workflow_run_id`
  - `created_at`
  - `updated_at`

- `content_variants`
  - `id`
  - `package_id`
  - `channel`
  - `title`
  - `body`
  - `status`
  - `evidence_json`
  - `evaluation_json`
  - `revision_id`
  - `created_at`
  - `updated_at`

- `content_revisions`
  - `id`
  - `package_id`
  - `revision_number`
  - `reason`
  - `reviewer_comment`
  - `created_by_run_id`
  - `created_at`

- `content_review_events`
  - `id`
  - `package_id`
  - `revision_id`
  - `decision`
  - `comment`
  - `reviewer_id`
  - `created_at`

Add:

- unique constraint on `(org_id, source_event_id, channel)`;
- foreign key from variants to packages;
- indexes on `(org_id, status)` and `(org_id, created_at)`;
- unique constraint on `(package_id, revision_number)`;
- unique idempotency key for `(org_id, source_event_type, source_event_id, channel)`;
- organization predicates to every repository query.

**Repository interface:**

```python
class ContentRepository:
    async def create_package(self, package: ContentPackage) -> ContentPackage: ...
    async def get_package(self, org_id: str, package_id: str) -> ContentPackage | None: ...
    async def list_packages(
        self,
        org_id: str,
        status: ContentPackageStatus | None = None,
    ) -> list[ContentPackage]: ...
    async def update_package_status(
        self,
        org_id: str,
        package_id: str,
        status: ContentPackageStatus,
    ) -> ContentPackage: ...
    async def upsert_variant(self, variant: ContentVariant) -> ContentVariant: ...
    async def create_revision(self, revision: ContentRevision) -> ContentRevision: ...
    async def append_review_event(self, event: dict[str, Any]) -> None: ...
```

- [x] Write repository tests for creation, listing, status changes, idempotency, and cross-organization isolation.
- [x] Write repository tests for revision history, reviewer events, provenance, and feedback-gap traceability.
- [x] Run the repository tests and verify they pass.
- [x] Add the migration and repository implementation.
- [x] Wire `ContentRepository` into dependency construction.
- [x] Run the persistence test suite.

---

### Task 3: Build the content-generation workflow graph

**Files:**
- Create: `draftly-agent-backend/src/draftly/orchestration/graphs/content_graph.py`
- Create: `draftly-agent-backend/src/draftly/workflows/content/content_generation.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Test: `draftly-agent-backend/tests/graph/test_content_graph.py`

**Workflow:**

```text
source normalization
        ↓
project-memory research
        ↓
content brief
        ↓
blog draft
        ↓
LinkedIn/X adaptations
        ↓
evaluation
        ↓
persist draft package
        ↓
human review
```

**Graph nodes:**

- `NormalizeSourceNode`
  - Converts GitHub, documentation, manual-brief, or feedback-gap payloads into `ContentRequest`.
- `ResearchProjectNode`
  - Retrieves relevant documentation, changed files, release notes, and memory evidence.
- `BuildBriefNode`
  - Produces audience, message, key claims, title options, and call-to-action.
- `WriteBlogNode`
  - Produces a structured blog draft with title, summary, body, evidence, and metadata.
- `AdaptSocialNode`
  - Produces LinkedIn and X variants from the approved blog draft.
- `EvaluateContentNode`
  - Runs deterministic and model-based content checks.
- `PersistContentNode`
  - Writes the package and variants using `ContentRepository`.
- `ReviewGateNode`
  - Uses the existing review policy and transitions the package to `in_review`.
- `RevisionNode`
  - Applies reviewer feedback, creates a new revision, and routes the package back through evaluation before review.

**Workflow function:**

```python
async def run_content_generation(
    context: WorkflowContext,
    *,
    source_event: dict[str, Any],
    requested_channels: list[str] | None = None,
    audience: str = "developers and users",
    tone: str = "clear, practical, trustworthy",
    reviewer_feedback: str | None = None,
) -> WorkflowState:
    ...
```

Register the workflow as `content_generation`.

- [x] Add graph coverage for valid release, PR, documentation, manual, and feedback-gap inputs.
- [x] Add graph coverage for missing evidence, unsupported channels, and evaluation failures.
- [x] Add revision and retry safety coverage at the workflow boundary.
- [x] Implement the graph with typed node inputs and outputs.
- [x] Register the workflow in the composition layer.
- [x] Verify workflow events use the existing runner/publisher boundary.
- [x] Verify failed nodes produce a failed state and never transition the package to `approved`.
- [x] Run focused content workflow tests.

---

### Task 4: Add content-specific agents, prompts, and tools

**Files:**
- Create: `draftly-agent-backend/src/draftly/agents/content/strategist.py`
- Create: `draftly-agent-backend/src/draftly/agents/content/blog_writer.py`
- Create: `draftly-agent-backend/src/draftly/agents/content/social_adapter.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/agents.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/tools.py`
- Test: `draftly-agent-backend/tests/agents/test_content_agents.py`

**Agent responsibilities:**

- `ContentStrategist`
  - Converts researched source material into a concise, evidence-backed content brief.
- `BlogWriter`
  - Writes a complete long-form draft without inventing unsupported product behavior.
- `SocialAdapter`
  - Produces channel-specific variants while preserving claims and links.

**Prompt requirements:**

- Every factual claim must map to an evidence item.
- Unknown information must be marked as unknown instead of guessed.
- The blog must distinguish announcement, explanation, and tutorial content.
- LinkedIn must be professional and explanatory.
- X must be concise, readable, and thread-capable.
- Agents must not publish, call external publishing APIs, or bypass review.
- Agents must preserve source feedback IDs and gap IDs in the generated package metadata.
- Revision agents must address reviewer feedback without discarding valid evidence or silently changing unrelated variants.

**Tools:**

Reuse existing memory search, repository/code search, documentation search, and GitHub source retrieval tools. Add a content formatting tool only if existing Markdown utilities cannot enforce the required channel constraints.

- [x] Add agent contract tests using fixed research fixtures.
- [x] Verify all generated outputs contain evidence references.
- [x] Verify channel-specific length and formatting constraints.
- [x] Register the agents and tool groups.
- [x] Run the agent tests.

---

### Task 5: Add evaluation for content quality

**Files:**
- Create: `draftly-agent-backend/src/draftly/evaluation/evaluators/content_quality.py`
- Create: `draftly-agent-backend/src/draftly/evaluation/datasets/content.json`
- Modify: `draftly-agent-backend/src/draftly/evaluation/service.py`
- Test: `draftly-agent-backend/tests/evaluation/test_content_quality.py`

Evaluate groundedness, source evidence coverage, audience relevance, clarity, blog structure, LinkedIn formatting, X length/readability, absence of unsupported promises, and consistency across variants.

Deterministic approval thresholds are:

- `groundedness >= 0.90`;
- `completeness >= 0.80`;
- `relevance >= 0.80`;
- `channel_fit >= 0.80`;
- no blocking issues.

If the evaluator is unavailable, the package remains `in_review` or `draft` and cannot become `approved`.

The evaluator returns:

```python
{
    "passed": bool,
    "scores": {
        "groundedness": float,
        "completeness": float,
        "relevance": float,
        "channel_fit": float,
    },
    "issues": list[str],
}
```

A failed evaluation prevents transition to `approved` and remains visible in the package.

- [x] Add passing and failing evaluator fixtures.
- [x] Register the evaluator at the content workflow evaluation boundary.
- [x] Add the content dataset.
- [x] Add evaluator tests for threshold boundaries, unavailable evaluation, and failed-variant behavior.
- [x] Run content evaluator tests.

---

### Task 6: Add content review and API routes

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/routes/content.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`
- Test: `draftly-agent-backend/tests/api/test_content_routes.py`

**Endpoints:**

```text
POST /content/generate
GET  /content
GET  /content/{package_id}
POST /content/{package_id}/review
GET  /content/{package_id}/revisions
```

`POST /content/generate` accepts source details, requested channels, audience, tone, and an idempotency key. It returns `202 Accepted` with `{job_id, package_id, status}`. Review accepts `approve`, `request_changes`, or `reject` plus an optional comment. `request_changes` requires a comment and creates a new revision.

Rules:

- all routes require authenticated organization context;
- users may only access packages belonging to their organization;
- approval requires evaluation completion;
- `request_changes` persists reviewer identity/comment, creates a new revision, and reopens the workflow with reviewer feedback;
- `reject` permanently marks the package rejected;
- approval is blocked if any requested variant has a blocking evaluation issue;
- repeated generation requests with the same idempotency key return the existing job/package;
- workflow retries do not duplicate packages or variants;
- no route publishes externally.

- [x] Implement organization-scoped API behavior for generation, listing, retrieval, approval, changes requested, and rejection.
- [x] Implement `202 Accepted`, idempotent generation, revision listing, reviewer identity, required change comments, and approval blocking.
- [x] Wire the router into the FastAPI application.
- [x] Run backend API and content workflow tests.

---

### Task 7: Connect GitHub release and pull-request events

**Files:**
- Modify: `draftly-agent-backend/src/draftly/events/github/release.py`
- Modify: `draftly-agent-backend/src/draftly/events/github/pull_request.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/events.py`
- Test: `draftly-agent-backend/tests/events/test_content_triggers.py`

Trigger content generation for published GitHub releases, merged pull requests explicitly marked as content-relevant, feedback-loop `ContentOpportunity` jobs, and manual API requests. Documentation-source requests are accepted through the API. Do not generate content for every opened, synchronized, or closed PR.

Use this idempotency key:

```text
org_id + repository_id + source_event_type + source_event_id + channel
```

- [x] Add event normalization tests.
- [x] Add tests confirming irrelevant PR actions do not trigger generation.
- [x] Make duplicate webhook delivery idempotent through source identity constraints.
- [x] Preserve `gap_id` and feedback IDs through feedback-gap dispatch.
- [x] Preserve evidence references for documentation and manual sources.
- [x] Connect normalized events to `content_generation`.
- [x] Run event and webhook tests.

---

### Task 8: Add frontend content review experience

**Files:**
- Create: `draftly-agent-frontend/app/(app)/content/page.tsx`
- Create: `draftly-agent-frontend/components/content/content-package-view.tsx`
- Create: `draftly-agent-frontend/api/content.ts`
- Test: `draftly-agent-frontend/tests/content/content-page.test.tsx`

Provide a content-package list, status/source filters, side-by-side blog/LinkedIn/X variants, evidence references, evaluation scores/issues, approve/request-changes/reject controls, and visible workflow progress/failure states.

Show revision history, reviewer comments, source feedback/gap provenance, and whether a package is draft, in review, blocked by evaluation, approved, or rejected.

Do not add publish or scheduling controls in this MVP.

- [x] Add API client tests.
- [x] Add component coverage for package rendering and review states.
- [x] Surface revision/provenance/evaluation metadata and request-changes controls.
- [x] Use accessible labels, buttons, status, and list semantics for review actions and variants.
- [x] Run focused frontend tests and type checks.

---

### Task 9: Add observability, documentation, and rollout checks

**Files:**
- Modify: `draftly-agent-backend/README.enhanced.md`
- Create: `draftly-agent-backend/docs/content-production.md`
- Modify: `draftly-agent-backend/src/draftly/observability/workflow_logging.py`
- Test: `draftly-agent-backend/tests/observability/test_content_logging.py`

Log structured events for workflow start, source normalization, evidence retrieval, variant generation, evaluation, review request, review decision, and failure. Include `run_id`, `org_id`, `workflow`, `content_package_id`, `source_event_id`, `channel`, and `status`. Do not log full generated content or private repository content.

Document supported source events, channels, review behavior, evaluation behavior, known limitations, and the absence of publishing integrations.

Document the future publishing boundary: publishing adapters, scheduling, OAuth/token storage, delivery retries, platform-specific failures, and analytics ingestion are separate follow-up work and must consume only approved packages.

- [x] Add structured logging tests.
- [x] Add documentation examples.
- [x] Run backend tests, frontend tests, type checks, and lint checks.
- [x] Run `graphify update .` after implementation.
- [x] Verify the synthetic GitHub release path through generated review-ready content.
- [x] Verify the feedback-gap path through `ContentOpportunity` dispatch, generated variants, revision persistence, re-evaluation metadata, and review approval boundary.

## Acceptance Criteria

- A published release can generate a blog, LinkedIn variant, and X variant.
- A feedback gap can generate a traceable content package through the `ContentOpportunity` contract.
- Documentation and manual sources can generate content when they provide valid evidence.
- All variants are grounded in retrieved project evidence.
- Generated content is persisted and organization-scoped.
- Evaluation failures prevent approval.
- Reviewers can approve, request changes with a persisted revision, or reject content.
- Duplicate GitHub events do not create duplicate packages.
- Duplicate feedback-gap or API requests do not create duplicate packages or variants.
- Workflow progress and failures are observable.
- No external publishing occurs.
- Approved packages retain source, evidence, revision, evaluation, and reviewer provenance.
- Existing documentation, support, GitHub, memory, and evaluation workflows continue passing their test suites.

## Explicit Assumptions and Defaults

- The first release is drafting-first and does not publish externally.
- GitHub releases are the primary trigger; merged pull requests are secondary.
- Feedback gaps, documentation sources, and manual briefs are supported secondary inputs.
- The initial channels are blog, LinkedIn, and X.
- Existing Draftly memory and review infrastructure is reused rather than replaced.
- Content packages are stored separately from documentation records.
- Human review remains enabled by default.
- Migration `042_content_packages.sql` is reserved for this feature; if another migration claims that number before implementation, it must be renumbered while preserving migration order.
- Publishing, scheduling, platform OAuth, delivery retries, and analytics ingestion are explicitly deferred until after the approved-draft pipeline is stable.
