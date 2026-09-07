# GitHub Feedback Loop Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect GitHub issue and pull-request feedback to tenant-scoped persistence, scheduled gap detection, downstream documentation work, and the future content-generation pipeline.

**Architecture:** Normalize GitHub comments and review signals into a shared `FeedbackItem` contract, persist them through a dedicated feedback repository with an idempotent source-event key, and make the scheduled feedback workflow read support plus GitHub signals for one organization at a time. Persist detected gap candidates, classify each gap as documentation work, content work, both, or pending review, and dispatch explicit downstream requests instead of treating graph output as delivery.

**Tech Stack:** Python, Pydantic, asyncpg repositories, Strands graphs, RQ task dispatch, pytest.

**Spec:** Existing feedback-loop behavior described in `draftly-agent-backend/docs/architecture/feedback-loop.md` and `draftly-agent-backend/docs/workflows/feedback-loop.md`, corrected for the GitHub wiring gaps identified in the workflow analysis.

## Global Constraints

- Every feedback signal must retain `org_id`, source platform, source event id, and source URL when available.
- Persistence must be idempotent for repeated GitHub webhook deliveries.
- Scheduled feedback scans must never combine feedback from different organizations.
- Existing Slack/Discord feedback behavior and manual `questions=` workflow calls must remain supported.
- Gap detection remains deterministic and must not require an LLM or provider credentials.
- A gap is not considered dispatched until a durable downstream job or gap record exists.
- Every gap must have an explicit outcome policy: `documentation`, `content`, `both`, or `pending`.
- Content handoffs must use a stable `ContentOpportunity` contract and must not bypass content evaluation or human review.
- Migration `042_content_packages.sql` is reserved by the content-production plan; this plan starts at migration `043`.
- Evaluation failures, human review decisions, and support/GitHub feedback are first-class signals, even when their downstream action is only persisted for later processing.

---

### Task 1: Define the persisted GitHub feedback contract

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/043_feedback_signals.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/feedback.py`
- Modify: `draftly-agent-backend/src/draftly/feedback/models.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/__init__.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Test: `draftly-agent-backend/tests/unit/persistence/test_feedback_repository.py`

**Interfaces:**
- `FeedbackItem` gains `org_id`, `source_event_id`, and `source_url` fields while retaining `platform`, `content`, `topic`, `category`, `sentiment`, and `source_message_id`.
- `FeedbackRepository.save_signal(item: FeedbackItem) -> FeedbackItem` performs an upsert keyed by `(org_id, platform, source_event_id)`.
- `FeedbackRepository.list_recent(org_id: str, platform: str | None = None, limit: int = 200) -> list[FeedbackItem]` returns only signals belonging to the requested organization.
- `RepositoryDependencies.feedback` exposes the repository to workflow composition.

- [ ] Write a failing repository test proving two saves with the same organization, platform, and source event produce one signal.
- [ ] Write a failing repository test proving `list_recent(org_id="org-a")` cannot return `org-b` rows.
- [ ] Run `pytest draftly-agent-backend/tests/unit/persistence/test_feedback_repository.py -v` and confirm the new tests fail because the table/repository interface does not exist.
- [ ] Add the migration with indexed organization/source columns and a uniqueness constraint for webhook idempotency.
- [ ] Implement the repository methods using the project’s async database store conventions.
- [ ] Register the repository in dependency construction and exports.
- [ ] Run the focused repository tests and confirm they pass.

### Task 2: Normalize GitHub feedback events

**Files:**
- Create: `draftly-agent-backend/src/draftly/events/github/issue_comment.py`
- Create: `draftly-agent-backend/src/draftly/events/github/pull_request_review.py`
- Create: `draftly-agent-backend/src/draftly/events/github/pull_request_review_comment.py`
- Modify: `draftly-agent-backend/src/draftly/events/types.py`
- Modify: `draftly-agent-backend/src/draftly/events/github/__init__.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/events.py`
- Test: `draftly-agent-backend/tests/events/github/test_feedback_processors.py`

**Interfaces:**
- Each processor implements `BaseProcessor.process(payload, event_id=...) -> ProcessedEvent`.
- Normalized events use these types: `issue_comment.created`, `pull_request_review.submitted`, and `pull_request_review_comment.created`.
- Each normalized event includes `project_id`, repository, actor, source, source event id, source URL, body text, issue/PR number, and review state when present.

- [ ] Write failing processor tests for issue comments, submitted reviews, and review comments.
- [ ] Write a failing test proving a GitHub issue payload is not mistaken for a pull-request review payload.
- [ ] Run the focused processor tests and confirm failure before implementation.
- [ ] Implement the three pure normalizers without database or workflow calls.
- [ ] Register processors in the event composition dispatcher in most-specific-before-generic order.
- [ ] Run the focused processor tests and confirm normalized payloads contain all feedback provenance fields.

### Task 3: Persist GitHub signals from webhook workflows

**Files:**
- Create: `draftly-agent-backend/src/draftly/workflows/github/feedback_ingestion.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/github/issue_feedback.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/github/issue_resolution.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/documentation/github_pr_workflow.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Test: `draftly-agent-backend/tests/workflows/test_github_feedback_ingestion.py`

**Interfaces:**
- `ingest_github_feedback(context: WorkflowContext, event: dict[str, Any]) -> WorkflowState` converts one normalized GitHub feedback event to `FeedbackItem`, calls `context.repositories.feedback.save_signal()`, and returns `DELIVERED` only after persistence succeeds.
- `process_issue_feedback()` delegates to `ingest_github_feedback()` instead of discarding `context`.
- Issue and PR workflows call ingestion for issue bodies, issue comments, review submissions, and review comments after webhook normalization; duplicate deliveries remain harmless through the repository upsert.

- [ ] Write a failing test proving issue feedback calls the feedback repository with `platform="github"`, organization, source event id, and issue URL.
- [ ] Write a failing test proving a repeated event does not invoke downstream dispatch twice.
- [ ] Write a failing test proving persistence errors return a failed workflow state and do not claim delivery.
- [ ] Run the focused ingestion tests and confirm failure before implementation.
- [ ] Implement the shared ingestion adapter and wire it into issue/PR workflow entry points.
- [ ] Register any dedicated workflow name only if the webhook path requires it; do not create a second uncalled registry entry.
- [ ] Run the focused ingestion tests and the existing GitHub workflow tests.

### Task 4: Make scheduled feedback scans tenant-safe and fix the topic contract

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/support.py`
- Modify: `draftly-agent-backend/src/draftly/feedback/service.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/feedback/documentation_feedback_loop.py`
- Modify: `draftly-agent-backend/src/draftly/feedback/models.py`
- Test: `draftly-agent-backend/tests/workflows/test_feedback_loop.py`
- Test: `draftly-agent-backend/tests/unit/feedback/test_service.py`

**Interfaces:**
- `SupportRepository.search_messages(..., org_id: str | None = None)` adds an organization predicate whenever `org_id` is supplied.
- `FeedbackService.collect_questions(org_id: str, platform: str | None = None, limit: int = 200)` combines tenant-scoped support rows and persisted GitHub signals, classifies them, and preserves `FeedbackItem.topic`.
- `_gather_questions(context, org_id=...)` passes the workflow’s organization id and serializes `item.topic`, never `item.topic_key`.
- `run_feedback_loop(..., org_id: str | None = None)` requires an organization for database-backed scans; manual `questions=` calls may omit it because their data is already explicit.

- [ ] Write a failing test for the `topic_key`/`topic` mismatch.
- [ ] Write a failing test proving a scan for one organization excludes another organization’s support and GitHub signals.
- [ ] Write a failing test proving manual questions still work without a repository organization lookup.
- [ ] Run focused feedback-loop tests and confirm failure before implementation.
- [ ] Add org filtering to support queries and merge the feedback repository source into `FeedbackService`.
- [ ] Fix serialization to use `FeedbackItem.topic` and retain source provenance in graph input.
- [ ] Make scheduled jobs pass an organization id or fan out once per configured organization; never run an unscoped global scan.
- [ ] Run focused service/workflow tests and the existing domain feedback tests.

### Task 5: Persist gap candidates and dispatch documentation or content work

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/044_documentation_gaps.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/documentation_gaps.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/feedback_graph.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/feedback/documentation_feedback_loop.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/feedback/knowledge_update.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workers.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/rq_jobs.py`
- Modify: `draftly-agent-backend/src/draftly/app/workers/rq_dispatch.py`
- Test: `draftly-agent-backend/tests/workflows/test_feedback_dispatch.py`

**Interfaces:**
- `DocumentationGapRepository.upsert_candidate(org_id: str, candidate: DocumentationGapCandidate) -> str` returns a durable gap id and deduplicates by organization/topic/status.
- `DocumentationGapRepository.mark_dispatched(gap_id: str, run_id: str) -> None` records downstream assignment.
- `DocumentationGapRepository.set_outcome(gap_id: str, outcome: Literal["documentation", "content", "both", "pending"]) -> None` records the selected downstream route.
- `run_feedback_loop()` extracts `enqueue.enqueued`, persists each candidate, applies the outcome policy, and dispatches documentation and/or content work containing `org_id`, `gap_id`, topic, sample questions, and source platforms.
- The dispatched job resolves to an existing documentation workflow only when repository context is present; otherwise it remains a durable pending gap rather than being falsely marked delivered.
- A content job is not considered complete until a durable content opportunity or content-generation job exists.

- [ ] Write a failing test proving graph output alone does not mark a gap dispatched.
- [ ] Write a failing test proving a persisted gap is dispatched once even when the scheduled task retries.
- [ ] Write a failing test proving the downstream payload contains organization, gap id, topic, samples, and source platforms.
- [ ] Run the focused dispatch tests and confirm failure before implementation.
- [ ] Add the gap table/repository with idempotent upsert and dispatch status.
- [ ] Implement extraction and persistence after successful graph completion.
- [ ] Implement the deterministic outcome policy using signal source, recurrence, topic scope, and configured organization preferences; default unresolved cases to `pending`.
- [ ] Add the task registration/handler needed to execute a documentation gap using an explicit repository context.
- [ ] Add separate dispatch records for documentation and content work so one failed route does not falsely complete the other.
- [ ] Mark each route dispatched only after its downstream job is accepted.
- [ ] Run focused dispatch tests and existing worker/RQ tests.

### Task 6: Integrate feedback gaps with the content pipeline

**Files:**
- Modify: `draftly-agent-backend/src/draftly/content/models.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/content/content_generation.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/documentation_gaps.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/feedback/documentation_feedback_loop.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/rq_jobs.py`
- Test: `draftly-agent-backend/tests/workflows/test_feedback_content_handoff.py`

**Interfaces:**

```python
class ContentOpportunity(BaseModel):
    org_id: str
    gap_id: str
    topic: str
    source_feedback_ids: list[str]
    recommended_channels: list[str]
    evidence: list[dict[str, str]]
    reason: str


async def dispatch_content_opportunity(
    context: WorkflowContext,
    opportunity: ContentOpportunity,
) -> str:
    """Persist and enqueue one content-generation request; return job id."""
```

- Extend the content request source contract to accept `feedback_gap` in addition to `pull_request` and `release`.
- Convert a selected content gap into a `ContentOpportunity` containing the originating feedback ids, sample questions, source platforms, and recommended channels.
- Dispatch the opportunity to `content_generation` without publishing externally.
- Preserve the gap id on the content package so later approval, evaluation, and feedback can be traced back to the original user signals.
- Content generation must retrieve project memory and source evidence before drafting; a gap topic alone is not sufficient grounding.

- [ ] Write a failing test proving a `content` gap produces one idempotent content opportunity.
- [ ] Write a failing test proving a `documentation`-only gap does not invoke `content_generation`.
- [ ] Write a failing test proving a `both` gap creates independently tracked documentation and content dispatch records.
- [ ] Write a failing test proving the content request preserves `org_id`, `gap_id`, feedback ids, evidence, and recommended channels.
- [ ] Update the content workflow input schema and dispatcher to accept `feedback_gap`.
- [ ] Implement content-opportunity persistence and dispatch after gap persistence succeeds.
- [ ] Mark the content route dispatched only after the content job is accepted.
- [ ] Run feedback, content workflow, and job idempotency tests.

### Task 7: Persist learning signals and define organization-scoped scheduling

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/feedback_outcomes.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/evaluation/documentation_evaluation.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/reviews.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workers.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/rq_jobs.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/feedback/knowledge_update.py`
- Test: `draftly-agent-backend/tests/workflows/test_feedback_learning.py`
- Test: `draftly-agent-backend/tests/workers/test_feedback_scheduling.py`

**Interfaces:**

- `FeedbackOutcomeRepository.save_outcome(org_id: str, source_type: str, source_id: str, outcome: dict[str, Any]) -> None` stores evaluation failures, reviewer decisions, documentation resolutions, and content resolutions.
- `FeedbackOutcomeRepository.list_unresolved(org_id: str, limit: int = 200) -> list[dict[str, Any]]` returns signals not yet incorporated into a gap or memory update.
- `build_feedback_scan_jobs() -> list[dict[str, Any]]` enumerates enabled organizations and creates one `support.gap_scan` job per organization with an explicit `org_id`.
- `plan_knowledge_updates()` receives resolved gaps and approved outcomes, producing memory candidates with source references rather than silently mutating memory.

- [ ] Write a failing test proving evaluation failure becomes a persisted feedback outcome.
- [ ] Write a failing test proving `request_changes` and `reject` review decisions become persisted outcomes.
- [ ] Write a failing test proving approved documentation/content resolves the originating gap and records the resolution target.
- [ ] Write a failing test proving scheduled jobs are organization-specific and do not create an unscoped scan.
- [ ] Implement outcome persistence and connect evaluation/HITL completion paths.
- [ ] Implement organization enumeration, per-organization job arguments, retry keys, and no-integration skip behavior.
- [ ] Connect resolved outcomes to `plan_knowledge_updates()` and memory-candidate review without bypassing existing curation gates.
- [ ] Run focused learning and scheduler tests.

### Task 8: End-to-end feedback verification and documentation

**Files:**
- Modify: `draftly-agent-backend/docs/workflows/feedback-loop.md`
- Modify: `draftly-agent-backend/docs/architecture/feedback-loop.md`
- Modify: `draftly-agent-backend/docs/workflows/content-production.md`
- Test: `draftly-agent-backend/tests/integration/test_github_feedback_loop.py`
- Test: `draftly-agent-backend/tests/integration/test_feedback_content_pipeline.py`
- Test: `draftly-agent-backend/tests/workflows/test_github_pr_workflow.py`
- Test: `draftly-agent-backend/tests/workflows/test_issue_workflow.py`

- [ ] Add an integration test covering normalized GitHub feedback → persistence → tenant-scoped scan → gap persistence → downstream dispatch.
- [ ] Add an integration test covering GitHub feedback → content opportunity → content-generation workflow → persisted blog/social drafts → human review state.
- [ ] Add a duplicate-delivery test covering webhook retry and scheduled-job retry.
- [ ] Add a negative test proving organization A cannot see organization B’s feedback or gaps.
- [ ] Add tests for documentation-only, content-only, both, and pending gap outcomes.
- [ ] Update workflow documentation with the actual GitHub event types, persistence contract, dispatch status, organization scheduling, outcome policy, and manual/scheduled invocation requirements.
- [ ] Update content documentation with `feedback_gap` as a source, provenance requirements, review behavior, and the no-publishing boundary.
- [ ] Verify migration order: `042_content_packages.sql`, `043_feedback_signals.sql`, and `044_documentation_gaps.sql`.
- [ ] Run the targeted feedback, GitHub, repository, content, and worker suites.
- [ ] Run the full backend suite with `.venv/bin/pytest -q`.
- [ ] Run `graphify update .` from the repository root.
- [ ] Run `git diff --check` on all changed backend files.

## Completion Criteria

- A GitHub issue comment, PR review, or PR review comment is normalized and persisted with organization and source provenance.
- Replayed webhook deliveries do not duplicate feedback signals.
- Scheduled feedback scans combine support and GitHub signals only within one organization.
- The topic field is consistently read as `FeedbackItem.topic`.
- Detected gaps have durable ids and dispatch status.
- Each gap has an explicit `documentation`, `content`, `both`, or `pending` outcome.
- Documentation work is dispatched through a registered, test-covered task or remains explicitly pending when repository context is missing.
- Content opportunities are persisted and dispatched through the content-generation workflow with gap provenance preserved.
- Evaluation failures and human review decisions are persisted as feedback outcomes.
- Resolved gaps can produce reviewable memory candidates without bypassing memory curation.
- Scheduled scans are created per organization and never execute against an unscoped global feedback set.
- Existing Slack/Discord, manual feedback graph, issue resolution, and PR workflow tests remain green.
