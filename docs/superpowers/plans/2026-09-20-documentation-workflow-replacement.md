# Durable Documentation Workflow Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely replace the documentation graph's shared writer/reviewer/evaluator feedback loop with a durable, page-scoped workflow that evaluates immutable artifacts, revises only implicated pages, survives worker restarts, and exposes page results to reviewers and workflow operators.

**Architecture:** The top-level Strands Graph keeps intake, research, impact analysis, changelog, approval, and delivery, but documentation generation becomes one `DocumentationWorkflowNode`. That node delegates to a Draftly-owned database-backed DAG executor whose tasks are page writes, page evaluations, and final cross-page reviews; no Strands Graph feedback edge remains in the documentation path. The existing generic `EvaluatorNode` remains for support and issue graphs, while the documentation graph's answer branch receives a dedicated `AnswerQualityNode`.

**Tech Stack:** Python 3.11, Strands Agents SDK 1.52, Pydantic v2, asyncpg-style `DatabaseClient`, PostgreSQL/CockroachDB-compatible SQL, pytest, FastAPI, Next.js/React/TypeScript, Node test runner, Tailwind CSS.

**Spec:** `docs/page-level-eval.md`, `docs/agents-execution-methods.md`, `docs/system-design.md`, plus the approved hard-cutover design from the planning conversation.

## Global Constraints

- This is a hard replacement: do not add a feature flag, shadow execution, batch-evaluation fallback, or legacy documentation-loop branch.
- Keep the generic `EvaluatorNode` unchanged for support and issue graphs; remove it only from `documentation_graph.py`.
- Use normalized repository-relative paths as `page_id`; reject absolute paths and paths containing `..` segments.
- Persist every evaluation against immutable `(artifact_id, version, content_hash)` identity and reject stale results.
- `quality_score >= 0.70` is the blocking page gate. Citation coverage, topic completeness, and detail remain individually visible metrics.
- Permit three automated page evaluations. Infrastructure retries do not increment the quality attempt.
- Missing or unusable evidence escalates immediately; it never passes and never invokes batch evaluation.
- Never generate a changelog or deliver when any required page lacks a sealed accepted artifact.
- Existing historical runs remain readable. New page-level response fields are additive, and full Markdown content must not appear in evaluation API payloads.
- Use TDD for every task: write a failing focused test, run it, implement the smallest complete behavior, rerun the focused tests, then commit.
- Preserve unrelated worktree changes. Run `graphify update .` from the repository root after implementation.

---

## File Structure

- `draftly-agent-backend/src/draftly/orchestration/page_workflow/models.py` — immutable artifact, metric, evaluation, task, and workflow-result contracts.
- `draftly-agent-backend/src/draftly/orchestration/page_workflow/repository.py` — page state, evaluation, and durable task persistence.
- `draftly-agent-backend/src/draftly/orchestration/page_workflow/executor.py` — leases, dependency scheduling, retry, resume, concurrency, and deadlock detection.
- `draftly-agent-backend/src/draftly/orchestration/page_workflow/handlers.py` — isolated writer, evaluator, and cross-page review handlers.
- `draftly-agent-backend/src/draftly/orchestration/page_workflow/node.py` — Strands-compatible `DocumentationWorkflowNode` and resume entrypoint.
- `draftly-agent-backend/src/draftly/orchestration/nodes/answer_quality.py` — answer-only compatibility quality gate.
- `draftly-agent-backend/src/draftly/persistence/migrations/060_documentation_page_workflow.sql` — artifact identity, page state, evaluations, and workflow tasks.
- `draftly-agent-ui/components/sections/workflows/page-evaluation-panel.tsx` — shared page-result presentation used by run and review details.

---

### Task 1: Define page-workflow contracts and artifact identity schema

**Files:**
- Create: `draftly-agent-backend/src/draftly/orchestration/page_workflow/__init__.py`
- Create: `draftly-agent-backend/src/draftly/orchestration/page_workflow/models.py`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/060_documentation_page_workflow.sql`
- Test: `draftly-agent-backend/tests/unit/orchestration/page_workflow/test_models.py`
- Test: `draftly-agent-backend/tests/persistence/test_documentation_page_workflow_migration.py`

**Interfaces:**
- Produces: `PageStatus`, `TaskStatus`, `MetricResult`, `DocumentArtifact`, `PageEvaluationResult`, `RevisionTask`, `CrossPageCorrection`, `CrossPageReviewResult`, `DocumentationWorkflowResult`, and `normalize_page_id(path: str) -> str`.
- Produces database tables consumed by Task 2: `documentation_page_states`, `documentation_page_evaluations`, and `documentation_workflow_tasks`.

- [ ] **Step 1: Write failing contract tests**

Create tests that assert path normalization, immutable artifact identity, blocking metric behavior, and aggregate pass semantics:

```python
from draftly.orchestration.page_workflow.models import (
    DocumentArtifact,
    DocumentationWorkflowResult,
    MetricResult,
    PageEvaluationResult,
    PageStatus,
    normalize_page_id,
)


def test_normalize_page_id_rejects_escape() -> None:
    assert normalize_page_id("./docs/oauth.md") == "docs/oauth.md"
    for path in ("/etc/passwd", "../README.md", "docs/../../secret"):
        try:
            normalize_page_id(path)
        except ValueError:
            continue
        raise AssertionError(f"accepted unsafe page path: {path}")


def test_workflow_passes_only_when_every_page_passes() -> None:
    artifact = DocumentArtifact(
        page_id="docs/oauth.md",
        path="docs/oauth.md",
        artifact_id="artifact-1",
        version=1,
        content_hash="a" * 64,
        action="update",
        status="sealed",
        content="# OAuth\n\nCurrent behavior.",
    )
    evaluation = PageEvaluationResult(
        page_id=artifact.page_id,
        artifact_id=artifact.artifact_id,
        version=artifact.version,
        content_hash=artifact.content_hash,
        attempt=1,
        status=PageStatus.PASSED,
        score=0.9,
        metrics=[MetricResult(name="quality_score", score=0.9, threshold=0.7, passed=True, blocking=True, reason="passed")],
        revision_feedback=[],
    )
    result = DocumentationWorkflowResult.from_pages([evaluation])
    assert result.passed is True
    assert result.failed_page_ids == []
    assert result.escalated_page_ids == []
```

- [ ] **Step 2: Run the contract tests and confirm the missing-module failure**

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/orchestration/page_workflow/test_models.py`

Expected: FAIL with `ModuleNotFoundError: draftly.orchestration.page_workflow`.

- [ ] **Step 3: Implement the typed contracts**

Use string enums for persisted status values:

```python
class PageStatus(StrEnum):
    PENDING = "pending"
    WRITING = "writing"
    EVALUATING = "evaluating"
    REVISING = "revising"
    PASSED = "passed"
    AWAITING_HUMAN_REVIEW = "awaiting_human_review"
    FAILED = "failed"


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DocumentArtifact(BaseModel):
    model_config = ConfigDict(frozen=True)
    page_id: str
    path: str
    artifact_id: str
    version: int = Field(ge=1)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    action: str
    status: Literal["sealed"] = "sealed"
    content: str = Field(exclude=True, repr=False)


class MetricResult(BaseModel):
    name: str
    score: float = Field(ge=0.0, le=1.0)
    threshold: float = Field(ge=0.0, le=1.0)
    passed: bool
    blocking: bool
    reason: str
```

Define `PageEvaluationResult` with the exact artifact identity, `attempt`, `status`, `score`, `metrics`, and `revision_feedback`. Define `DocumentationWorkflowResult.from_pages()` so `passed` is true only when every page status is `passed`; `ready_for_review` is true when each page is either passed or explicitly escalated.

- [ ] **Step 4: Write and verify the migration test**

The test must read migration 060 and assert the following columns and constraints exist. Implement the migration with this shape:

```sql
ALTER TABLE draft_revisions ADD COLUMN IF NOT EXISTS version INTEGER;
ALTER TABLE draft_revisions ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_revisions_run_path_version
    ON draft_revisions (run_id, path, version) WHERE version IS NOT NULL;

CREATE TABLE IF NOT EXISTS documentation_page_states (
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    path TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'pending','writing','evaluating','revising','passed',
        'awaiting_human_review','failed'
    )),
    latest_artifact_id TEXT REFERENCES draft_revisions(id),
    latest_version INTEGER NOT NULL DEFAULT 0 CHECK (latest_version >= 0),
    next_version INTEGER NOT NULL DEFAULT 1 CHECK (next_version >= 1),
    evaluation_attempt INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_attempt >= 0),
    escalation_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, page_id)
);

CREATE TABLE IF NOT EXISTS documentation_page_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES draft_revisions(id),
    version INTEGER NOT NULL CHECK (version >= 1),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    status TEXT NOT NULL CHECK (status IN ('passed','revision_required','awaiting_human_review')),
    score DOUBLE PRECISION NOT NULL CHECK (score >= 0 AND score <= 1),
    metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
    revision_feedback JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS documentation_workflow_tasks (
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN ('write','evaluate','cross_page_review')),
    page_id TEXT,
    artifact_version INTEGER,
    dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
    infrastructure_retries INTEGER NOT NULL DEFAULT 0 CHECK (infrastructure_retries BETWEEN 0 AND 1),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    input_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_data JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_documentation_tasks_ready
    ON documentation_workflow_tasks (run_id, status, lease_expires_at);
```

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/orchestration/page_workflow/test_models.py tests/persistence/test_documentation_page_workflow_migration.py`

Expected: PASS.

- [ ] **Step 5: Commit the contracts and schema**

```bash
git add draftly-agent-backend/src/draftly/orchestration/page_workflow draftly-agent-backend/src/draftly/persistence/migrations/060_documentation_page_workflow.sql draftly-agent-backend/tests/unit/orchestration/page_workflow/test_models.py draftly-agent-backend/tests/persistence/test_documentation_page_workflow_migration.py
git commit -m "feat: define durable documentation page workflow"
```

---

### Task 2: Make draft artifacts versioned and persist page workflow state

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/drafts.py`
- Create: `draftly-agent-backend/src/draftly/orchestration/page_workflow/repository.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Test: `draftly-agent-backend/tests/unit/persistence/test_draft_repository.py`
- Create: `draftly-agent-backend/tests/unit/orchestration/page_workflow/test_repository.py`

**Interfaces:**
- Produces: `DraftRevision.version`, `DraftRevision.content_hash`, `DraftFile.artifact_id`, `DraftFile.version`, and `DraftFile.content_hash`.
- Produces: `PageWorkflowRepository.create_pages`, `reserve_next_version`, `enqueue_task`, `claim_ready_tasks`, `complete_task`, `retry_or_fail_task`, `record_artifact`, `record_evaluation`, `get_page_states`, and `reset_expired_leases`.

- [ ] **Step 1: Add failing repository tests**

Cover concurrent version allocation, SHA-256 finalization, newest-per-path lookup, stale artifact rejection, atomic ready-task claims, and expired lease recovery. The key assertions are:

```python
first_version = await pages.reserve_next_version(run_id="run-1", page_id="docs/a.md")
second_version = await pages.reserve_next_version(run_id="run-1", page_id="docs/a.md")
first = await drafts.create_revision(run_id="run-1", org_id="org-1", generation=1, path="docs/a.md", action="update", version=first_version)
second = await drafts.create_revision(run_id="run-1", org_id="org-1", generation=2, path="docs/a.md", action="update", version=second_version)
assert (first.version, second.version) == (1, 2)

await drafts.append_chunk(first.id, "alpha")
sealed = await drafts.finalize(first.id)
assert sealed.content_hash == hashlib.sha256(b"alpha").hexdigest()

with pytest.raises(StaleArtifactError):
    await pages.record_evaluation(stale_result)
```

- [ ] **Step 2: Run focused tests and verify missing fields/repository failures**

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/persistence/test_draft_repository.py tests/unit/orchestration/page_workflow/test_repository.py`

Expected: FAIL because artifact versions, hashes, and `PageWorkflowRepository` do not exist.

- [ ] **Step 3: Implement transactional artifact identity**

Reserve versions atomically through the page-state row using `UPDATE documentation_page_states SET next_version = next_version + 1 WHERE run_id = $1 AND page_id = $2 RETURNING next_version - 1 AS version`. Pass that value to the new optional `version` parameter on `DraftRepository.create_revision`, and calculate the digest from assembled content during `finalize`. Update the dataclasses and all read methods to return identity metadata. `get_latest` and `get_path_latest` must order by `version DESC NULLS LAST, generation DESC` so historical rows remain readable.

Use conditional state promotion so late completions cannot replace a newer artifact:

```sql
UPDATE documentation_page_states
   SET latest_artifact_id = $3,
       latest_version = $4,
       status = 'evaluating',
       updated_at = now()
 WHERE run_id = $1
   AND page_id = $2
   AND latest_version < $4
```

Require exactly one updated row; otherwise raise `StaleArtifactError`.

- [ ] **Step 4: Implement durable task claiming and completion**

`claim_ready_tasks` must select pending tasks whose dependency IDs all identify completed tasks, lock them with `FOR UPDATE SKIP LOCKED`, and assign `lease_owner` plus `lease_expires_at`. `retry_or_fail_task` returns a first infrastructure failure to pending and marks the second failed. `record_evaluation` verifies current artifact ID, version, and hash in the same transaction before inserting the immutable result.

- [ ] **Step 5: Wire the repository through application dependencies and rerun tests**

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/persistence/test_draft_repository.py tests/unit/orchestration/page_workflow/test_repository.py tests/composition/test_workflows_composition.py`

Expected: PASS.

- [ ] **Step 6: Commit persistence behavior**

```bash
git add draftly-agent-backend/src/draftly/persistence/repositories/drafts.py draftly-agent-backend/src/draftly/orchestration/page_workflow/repository.py draftly-agent-backend/src/draftly/app/dependencies.py draftly-agent-backend/tests/unit/persistence/test_draft_repository.py draftly-agent-backend/tests/unit/orchestration/page_workflow/test_repository.py draftly-agent-backend/tests/composition/test_workflows_composition.py
git commit -m "feat: persist page artifacts and workflow tasks"
```

---

### Task 3: Build the durable bounded DAG executor

**Files:**
- Create: `draftly-agent-backend/src/draftly/orchestration/page_workflow/executor.py`
- Create: `draftly-agent-backend/tests/unit/orchestration/page_workflow/test_executor.py`
- Modify: `draftly-agent-backend/src/draftly/app/config.py`
- Create: `draftly-agent-backend/tests/app/test_documentation_workflow_config.py`

**Interfaces:**
- Consumes: Task 2 `PageWorkflowRepository` task methods.
- Produces: `TaskHandler = Callable[[WorkflowTask], Awaitable[dict[str, Any]]]`, `PageWorkflowExecutor.run(run_id: str, org_id: str) -> ExecutorResult`, and `DeadlockedWorkflowError`.
- Adds settings: `documentation_write_concurrency=3`, `documentation_evaluation_concurrency=3`, and `documentation_task_lease_seconds=300`.

- [ ] **Step 1: Write failing executor tests**

Test that independent writes overlap, evaluations wait for their writes, the configured concurrency is never exceeded, a handler failure retries once, expired tasks resume, completed tasks are not repeated, and an unsatisfied dependency raises `DeadlockedWorkflowError` containing the blocked task IDs.

```python
result = await executor.run(run_id="run-1", org_id="org-1")
assert result.completed_task_ids == {
    "write:docs/a.md:1",
    "write:docs/b.md:1",
    "evaluate:docs/a.md:1",
    "evaluate:docs/b.md:1",
}
assert tracker.max_active["write"] == 2
assert tracker.started_at["evaluate:docs/a.md:1"] >= tracker.finished_at["write:docs/a.md:1"]
```

- [ ] **Step 2: Run executor tests and confirm the missing executor failure**

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/orchestration/page_workflow/test_executor.py`

Expected: FAIL with an import error for `page_workflow.executor`.

- [ ] **Step 3: Implement scheduling, leases, and retry**

Use separate semaphores for write and evaluation handlers. Repeatedly reset expired leases, claim ready tasks, execute a batch with `asyncio.gather(return_exceptions=True)`, and persist every outcome before claiming again. If no task is claimable and pending tasks remain, raise a deadlock with their IDs. A second infrastructure failure marks the task failed and terminates the workflow; quality failures are successful handler results that schedule revisions and therefore do not use infrastructure retry.

- [ ] **Step 4: Add validated settings and rerun tests**

Map environment variables `DOCUMENTATION_WRITE_CONCURRENCY`, `DOCUMENTATION_EVALUATION_CONCURRENCY`, and `DOCUMENTATION_TASK_LEASE_SECONDS` to positive integers. Run:

`cd draftly-agent-backend && uv run pytest -q tests/unit/orchestration/page_workflow/test_executor.py tests/app/test_documentation_workflow_config.py`

Expected: PASS.

- [ ] **Step 5: Commit the executor**

```bash
git add draftly-agent-backend/src/draftly/orchestration/page_workflow/executor.py draftly-agent-backend/src/draftly/app/config.py draftly-agent-backend/tests/unit/orchestration/page_workflow/test_executor.py draftly-agent-backend/tests/app/test_documentation_workflow_config.py
git commit -m "feat: execute durable page workflow tasks"
```

---

### Task 4: Implement isolated page writing, evaluation, and cross-page review

**Files:**
- Create: `draftly-agent-backend/src/draftly/orchestration/page_workflow/handlers.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/evaluate.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/review.py`
- Create: `draftly-agent-backend/tests/unit/orchestration/page_workflow/test_handlers.py`
- Modify: `draftly-agent-backend/tests/evaluation/test_documentation_quality.py`

**Interfaces:**
- Consumes: `WriterFactory`, `RubricGrader`, `DraftRepository`, Task 1 contracts, and Task 2 repositories.
- Produces: `PageWriterHandler`, `PageEvaluatorHandler`, `CrossPageReviewHandler`, `compute_page_metrics`, and `render_revision_prompt`.
- Reuses deterministic scoring helpers from `evaluate.py`; no documentation handler may instantiate `EvaluatorNode`.

- [ ] **Step 1: Write failing handler tests**

Cover these scenarios:

1. Initial writer receives exactly one page and only its evidence.
2. Revision writer receives the current artifact, failed metrics, evaluator feedback, and cross-page reviewer instructions.
3. Passing a page creates no revision task.
4. Failing attempt 1 creates `write:<page_id>:2` and its dependent evaluation.
5. Failing attempt 3 sets `awaiting_human_review` and creates no automatic write.
6. Missing evidence escalates on attempt 1 without calling the writer again.
7. Cross-page review starts only when every page has passed.
8. Cross-page corrections name known page IDs; unknown or absent IDs fail the handler.

The revision-prompt assertion must be explicit:

```python
prompt = render_revision_prompt(task, artifact, evaluation, reviewer_instructions=["Use one term consistently"])
assert "Current artifact (version 1)" in prompt
assert artifact.content in prompt
assert "quality_score: 0.55" in prompt
assert "Document the token refresh failure" in prompt
assert "Use one term consistently" in prompt
assert "docs/unrelated.md" not in prompt
```

- [ ] **Step 2: Run focused tests and confirm missing handlers**

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/orchestration/page_workflow/test_handlers.py tests/evaluation/test_documentation_quality.py`

Expected: FAIL because the page handlers and metric function do not exist.

- [ ] **Step 3: Extract reusable deterministic page metrics**

Move calculation, not orchestration state, into `compute_page_metrics(evidence, content) -> list[MetricResult]`. Emit `citation_coverage`, `topic_completeness`, `detail`, and blocking `quality_score`. Preserve the current weighted score and 0.70 threshold so CI evaluation and runtime evaluation agree.

- [ ] **Step 4: Implement the writer and evaluator handlers**

The writer creates a fresh agent for every task, writes through the existing draft tools, validates that the expected path has a sealed non-empty artifact, and records the artifact identity. The evaluator verifies identity, computes metrics, invokes the rubric grader for page-specific feedback, persists one result, and either marks the page passed, schedules the next version, or escalates.

Use task IDs with these exact formats:

```python
write_id = f"write:{page_id}:{next_version}"
evaluate_id = f"evaluate:{page_id}:{next_version}"
```

- [ ] **Step 5: Implement cross-page review as a terminal workflow task**

Build compact summaries from accepted artifacts, invoke the existing reviewer schema, reject corrections for unknown pages, and schedule only implicated page writes. A clean verdict completes the documentation workflow. Corrections consume the implicated page's next evaluation attempt.

- [ ] **Step 6: Run focused and regression tests**

Run: `cd draftly-agent-backend && uv run pytest -q tests/unit/orchestration/page_workflow/test_handlers.py tests/evaluation/test_documentation_quality.py tests/nodes/test_evaluator.py tests/unit/orchestration/test_review_node.py`

Expected: PASS, including existing support code that still imports evaluator helpers.

- [ ] **Step 7: Commit page handlers**

```bash
git add draftly-agent-backend/src/draftly/orchestration/page_workflow/handlers.py draftly-agent-backend/src/draftly/orchestration/nodes/evaluate.py draftly-agent-backend/src/draftly/orchestration/nodes/review.py draftly-agent-backend/tests/unit/orchestration/page_workflow/test_handlers.py draftly-agent-backend/tests/evaluation/test_documentation_quality.py draftly-agent-backend/tests/nodes/test_evaluator.py draftly-agent-backend/tests/unit/orchestration/test_review_node.py
git commit -m "feat: add page-scoped authoring and evaluation handlers"
```

---

### Task 5: Replace the documentation graph loop

**Files:**
- Create: `draftly-agent-backend/src/draftly/orchestration/page_workflow/node.py`
- Create: `draftly-agent-backend/src/draftly/orchestration/nodes/answer_quality.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/routing/conditions.py`
- Replace: `draftly-agent-backend/tests/graph/test_documentation_graph.py`
- Create: `draftly-agent-backend/tests/unit/orchestration/page_workflow/test_node.py`

**Interfaces:**
- Produces: `DocumentationWorkflowNode.invoke_async(task: Any, invocation_state: dict[str, Any] | None = None, **kwargs: Any) -> MultiAgentResult` with result key `document` and a serialized `DocumentationWorkflowResult`.
- Produces: `DocumentationWorkflowNode.resume(run_id, decision, comment) -> DocumentationWorkflowResult` for Task 6.
- Produces: `AnswerQualityNode`, retaining answer score/reason/revision behavior without page artifacts.

- [ ] **Step 1: Write failing graph topology tests**

Assert the documentation graph contains one `DocumentationWorkflowNode`, does not contain a `ReviewNode` or documentation `EvaluatorNode`, and has no document feedback edge. Assert the answer branch uses `AnswerQualityNode`. Add an end-to-end scripted test in which two pages are written, one fails, only that page gets version 2, both pass, cross-page review runs once, and changelog receives the latest two artifacts.

```python
assert isinstance(graph.nodes["document"].executor, DocumentationWorkflowNode)
assert isinstance(graph.nodes["answer_evaluate"].executor, AnswerQualityNode)
assert "review" not in graph.nodes
assert all(not (edge.source.node_id == "document" and edge.target.node_id == "document") for edge in graph.edges)
```

- [ ] **Step 2: Run graph tests and verify the old topology fails assertions**

Run: `cd draftly-agent-backend && uv run pytest -q tests/graph/test_documentation_graph.py tests/unit/orchestration/page_workflow/test_node.py`

Expected: FAIL because the graph still installs fan-out, review, evaluator, and feedback edges.

- [ ] **Step 3: Implement `DocumentationWorkflowNode`**

Parse impact and research inputs, create initial page states and write/evaluate task pairs, run the executor until clean completion or escalation, and return a Strands `MultiAgentResult`. Re-entry for an existing run must resume persisted tasks rather than recreate them. Infrastructure failure returns `Status.FAILED`; page escalation returns `Status.COMPLETED` with `ready_for_review=True` and `passed=False`.

- [ ] **Step 4: Implement the dedicated answer quality node**

Extract only answer evaluation state from the generic evaluator: deterministic scoring, rubric feedback, and the existing bounded answer revision counter. It must not access draft artifacts, page tables, or documentation workflow tasks.

- [ ] **Step 5: Rewire and simplify the graph**

Use this documentation topology:

```text
impact -> document -> changelog -> changelog_evaluate -> deliver
impact -> answer -> answer_evaluate -> answer (bounded revision)
```

Keep existing context/research content-supply edges only where required for prompt construction, and gate changelog on `DocumentationWorkflowResult.passed`. Route escalated documentation results into the existing human review pause without adding a Graph feedback edge. Remove documentation-only `eval_ready`, `needs_revision_of("document")`, and `needs_correction` usage; delete a routing helper only if no other graph references it.

- [ ] **Step 6: Run graph and related surface regressions**

Run: `cd draftly-agent-backend && uv run pytest -q tests/graph/test_documentation_graph.py tests/unit/orchestration/page_workflow/test_node.py tests/unit/test_graph_role_resolution.py tests/graph/test_support_delivery_routing.py tests/conditions/test_conditions.py`

Expected: PASS.

- [ ] **Step 7: Commit the hard graph replacement**

```bash
git add draftly-agent-backend/src/draftly/orchestration/page_workflow/node.py draftly-agent-backend/src/draftly/orchestration/nodes/answer_quality.py draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py draftly-agent-backend/src/draftly/orchestration/routing/conditions.py draftly-agent-backend/tests/graph/test_documentation_graph.py draftly-agent-backend/tests/unit/orchestration/page_workflow/test_node.py
git commit -m "refactor: replace documentation writer evaluator loop"
```

---

### Task 6: Integrate escalation, resume, workflow events, and delivery safety

**Files:**
- Modify: `draftly-agent-backend/src/draftly/review/resume.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/page_workflow/node.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/routing/conditions.py`
- Create: `draftly-agent-backend/tests/workflows/test_documentation_page_resume.py`
- Modify: `draftly-agent-backend/tests/events/test_progress_events.py`

**Interfaces:**
- Consumes: `DocumentationWorkflowNode.resume` from Task 5 and existing review decisions `approve`, `request_changes`, and `reject`.
- Produces workflow event types: `documentation.task.claimed`, `documentation.page.written`, `documentation.page.evaluated`, `documentation.page.revision_scheduled`, `documentation.page.escalated`, and `documentation.workflow.resumed`.

- [ ] **Step 1: Write failing resume and delivery-gate tests**

Test the exact decision semantics:

- `approve`: mark escalated artifacts accepted and continue to changelog.
- `request_changes`: require a non-empty comment, schedule one human-guided revision for every escalated page, and pause again if it fails.
- `reject`: mark the workflow failed and ensure delivery never runs.
- A writer infrastructure failure or missing sealed artifact fails the workflow and never creates a changelog task.
- Duplicate resume calls with the same recorded decision are idempotent.

- [ ] **Step 2: Run focused tests and verify resume does not yet delegate**

Run: `cd draftly-agent-backend && uv run pytest -q tests/workflows/test_documentation_page_resume.py tests/events/test_progress_events.py`

Expected: FAIL because the current resume service resumes only the outer graph.

- [ ] **Step 3: Implement page-workflow decision handling**

When a run contains escalated page state, delegate to `DocumentationWorkflowNode.resume` before resuming the outer graph. Store a human-guided flag in task input so it does not alter the three automated-attempt records. Approval updates escalated page statuses to passed with an audit reason; request changes schedules the next version using the human comment; rejection marks pending tasks cancelled and the run failed.

- [ ] **Step 4: Publish persisted progress events**

Emit compact identifiers and status only; exclude Markdown and evidence bodies. Event payloads contain `run_id`, `task_id`, `page_id`, `artifact_version`, `attempt`, and `status` when applicable. Event publishing is best effort and must not change workflow outcome.

- [ ] **Step 5: Harden changelog and delivery predicates**

Require `passed is True`, no escalated or failed page IDs, and sealed latest artifacts for every planned page before changelog. Delivery must independently repeat the sealed-artifact check so a malformed upstream result cannot publish partial content.

- [ ] **Step 6: Rerun resume and delivery regressions**

Run: `cd draftly-agent-backend && uv run pytest -q tests/workflows/test_documentation_page_resume.py tests/events/test_progress_events.py tests/api/test_github_review_resume_logs.py tests/nodes/test_changelog_evaluate.py tests/unit/workflows/test_delivery_receipt_guards.py`

Expected: PASS.

- [ ] **Step 7: Commit escalation and safety behavior**

```bash
git add draftly-agent-backend/src/draftly/review/resume.py draftly-agent-backend/src/draftly/workflows/runner.py draftly-agent-backend/src/draftly/orchestration/page_workflow/node.py draftly-agent-backend/src/draftly/orchestration/routing/conditions.py draftly-agent-backend/tests/workflows/test_documentation_page_resume.py draftly-agent-backend/tests/events/test_progress_events.py
git commit -m "feat: resume escalated documentation pages safely"
```

---

### Task 7: Expose compact page results through review and workflow APIs

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/reviews.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/reviews.py`
- Modify: `draftly-agent-backend/tests/api/test_workflow_runs.py`
- Modify: `draftly-agent-backend/tests/api/test_review_display.py`

**Interfaces:**
- Produces additive `page_results` arrays on workflow-run detail and review-display responses.
- Each page item contains `page_id`, `path`, `status`, `version`, `attempts`, `score`, `failed_metrics`, `feedback`, and `escalation_reason`.

- [ ] **Step 1: Write failing API serialization and scoping tests**

Assert a mixed passed/escalated run serializes compact results in path order, omits artifact content and evidence, returns `page_results: []` for historical runs, and returns 404 when the caller's organization does not own the run or review.

```python
page = response.json()["page_results"][0]
assert set(page) == {
    "page_id", "path", "status", "version", "attempts", "score",
    "failed_metrics", "feedback", "escalation_reason",
}
assert "content" not in page
assert "evidence" not in page
```

- [ ] **Step 2: Run API tests and verify `page_results` is absent**

Run: `cd draftly-agent-backend && uv run pytest -q tests/api/test_workflow_runs.py tests/api/test_review_display.py`

Expected: FAIL on the missing response field.

- [ ] **Step 3: Add organization-scoped repository reads and response mapping**

Join page state to its latest immutable evaluation using both `run_id` and `latest_artifact_id`. Convert blocking failed metrics to their names and preserve evaluator feedback strings. Do not read `draft_chunks` for these endpoints.

- [ ] **Step 4: Rerun API tests**

Run: `cd draftly-agent-backend && uv run pytest -q tests/api/test_workflow_runs.py tests/api/test_review_display.py tests/api/test_reviews_routes.py`

Expected: PASS.

- [ ] **Step 5: Commit API exposure**

```bash
git add draftly-agent-backend/src/draftly/persistence/repositories/workflows.py draftly-agent-backend/src/draftly/persistence/repositories/reviews.py draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py draftly-agent-backend/src/draftly/app/api/routes/reviews.py draftly-agent-backend/tests/api/test_workflow_runs.py draftly-agent-backend/tests/api/test_review_display.py
git commit -m "feat: expose page evaluation results"
```

---

### Task 8: Display page evaluation and revision state in the dashboard

**Files:**
- Modify: `draftly-agent-ui/api/workflows.ts`
- Modify: `draftly-agent-ui/lib/reviews.ts`
- Create: `draftly-agent-ui/lib/page-evaluations.ts`
- Create: `draftly-agent-ui/components/sections/workflows/page-evaluation-panel.tsx`
- Modify: `draftly-agent-ui/components/sections/workflows/workflow-detail-page.tsx`
- Modify: `draftly-agent-ui/components/sections/reviews/review-detail-page.tsx`
- Modify: `draftly-agent-ui/tests/workflow-api.test.ts`
- Create: `draftly-agent-ui/tests/page-evaluations.test.ts`
- Modify: `draftly-agent-ui/tests/review-detail.test.ts`

**Interfaces:**
- Consumes the Task 7 `page_results` response.
- Produces `PageEvaluationSummary` and a reusable `PageEvaluationPanel({ pages })` component.

- [ ] **Step 1: Write failing API normalization and component tests**

Test legacy responses with no field, passed pages, pages awaiting review, failed metrics and feedback, loading/empty/unavailable states, keyboard-accessible detail expansion, and text labels independent of color.

```typescript
assert.deepEqual(normalizePageResults({}), []);
assert.match(rendered, /docs\/oauth\.md/);
assert.match(rendered, /Awaiting human review/);
assert.match(rendered, /Attempt 3/);
assert.match(rendered, /quality_score/);
```

- [ ] **Step 2: Run UI tests and verify missing types/component**

Run: `cd draftly-agent-ui && npm test`

Expected: FAIL because `PageEvaluationSummary` and `PageEvaluationPanel` do not exist.

- [ ] **Step 3: Add strict API types and normalization**

Define the page status union from Task 1 in `lib/page-evaluations.ts` and normalize unknown or missing arrays to `[]`. Export pure label, tone, and detail-row helpers so the Node test runner can verify every display state without a browser DOM. Preserve existing score/reason parsing for historical runs.

- [ ] **Step 4: Implement and place the shared panel**

Render path, explicit status text, version, attempts, score, failed metrics, feedback, and escalation reason. Put the panel below the overall evaluation on review details and after run progress on workflow details. Use existing `Card`, `Badge`, and disclosure styles; status meaning must remain understandable without color.

- [ ] **Step 5: Run UI verification**

Run:

```bash
cd draftly-agent-ui
npm test
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the dashboard changes**

```bash
git add draftly-agent-ui/api/workflows.ts draftly-agent-ui/lib/reviews.ts draftly-agent-ui/lib/page-evaluations.ts draftly-agent-ui/components/sections/workflows/page-evaluation-panel.tsx draftly-agent-ui/components/sections/workflows/workflow-detail-page.tsx draftly-agent-ui/components/sections/reviews/review-detail-page.tsx draftly-agent-ui/tests/workflow-api.test.ts draftly-agent-ui/tests/page-evaluations.test.ts draftly-agent-ui/tests/review-detail.test.ts
git commit -m "feat: show page evaluation status in dashboard"
```

---

### Task 9: Remove obsolete documentation-loop code and update architecture documentation

**Files:**
- Delete when reference search is empty: `draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py`
- Delete when reference search is empty: `draftly-agent-backend/src/draftly/orchestration/nodes/review.py`
- Delete: `draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py`
- Delete: `draftly-agent-backend/tests/unit/orchestration/test_review_node.py`
- Modify: `docs/page-level-eval.md`
- Modify: `docs/agents-execution-methods.md`
- Modify: `docs/system-design.md`

**Interfaces:**
- Removes documentation-only `FanOutWriterNode` and `ReviewNode` after Tasks 4-6 have moved their reusable helpers.
- Keeps `EvaluatorNode`, `ChangelogEvaluatorNode`, and rubric grader interfaces used by other surfaces.

- [ ] **Step 1: Prove obsolete symbols have no production consumers**

Run:

```bash
rg -n "FanOutWriterNode|ReviewNode|needs_correction|needs_revision_of\(\"document\"\)" draftly-agent-backend/src draftly-agent-backend/tests
```

Expected: matches only in the obsolete node files and tests. If a reusable helper remains referenced, move that helper into `page_workflow/handlers.py` before deletion and rerun the search.

- [ ] **Step 2: Delete obsolete nodes and tests**

Use `apply_patch` deletions. Do not delete `evaluate.py`, because issue and support graphs still import `EvaluatorNode`.

- [ ] **Step 3: Update all three design documents**

Document the final topology, artifact identity, per-page attempts, missing-evidence escalation, cross-page review placement, hard cutover, restart behavior, and the reason Draftly owns the DAG adapter instead of using `strands_tools.workflow`. Remove descriptions claiming the documentation graph has a writer/evaluator feedback edge or workflow-wide revision counter.

- [ ] **Step 4: Run reference and documentation checks**

Run:

```bash
rg -n "FanOutWriterNode|document → review → evaluation|entire batch revised" docs draftly-agent-backend/src
cd draftly-agent-backend && uv run pytest -q tests/graph/test_documentation_graph.py tests/unit/orchestration/page_workflow
```

Expected: the first command has no stale architectural claims outside historical plans; focused tests pass.

- [ ] **Step 5: Commit cleanup and documentation**

```bash
git add -A draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py draftly-agent-backend/src/draftly/orchestration/nodes/review.py draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py draftly-agent-backend/tests/unit/orchestration/test_review_node.py docs/page-level-eval.md docs/agents-execution-methods.md docs/system-design.md
git commit -m "docs: finalize durable documentation workflow replacement"
```

---

### Task 10: Verify the replacement and prepare the hard cutover

**Files:**
- Create: `draftly-agent-backend/scripts/check_documentation_cutover.py`
- Create: `draftly-agent-backend/tests/scripts/test_check_documentation_cutover.py`
- Create: `docs/documentation-workflow-cutover.md`

**Interfaces:**
- Produces a read-only cutover command that exits 0 only when no documentation workflow is in `queued`, `running`, `pending_review`, or `pending_intervention`.

- [ ] **Step 1: Write a failing cutover-check test**

Assert the script reports run IDs and statuses for nonterminal documentation runs, returns exit code 1 when any exist, and returns 0 when the result is empty. It must never update or cancel runs.

- [ ] **Step 2: Implement the read-only cutover check**

Query `workflow_runs` by documentation definition/surface and the four nonterminal statuses. Print a stable table suitable for an operator and return a nonzero exit status while rows remain.

- [ ] **Step 3: Run complete backend verification**

```bash
cd draftly-agent-backend
uv run pytest -q
uv run ruff check .
```

Expected: all tests pass and Ruff exits 0.

- [ ] **Step 4: Run complete UI verification**

```bash
cd draftly-agent-ui
npm test
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Perform the staging cutover rehearsal**

Follow this exact sequence:

1. Apply migration 060 while the old release is still serving.
2. Pause admission of new documentation runs.
3. Run `uv run python scripts/check_documentation_cutover.py`.
4. Resolve or cancel the listed runs outside the script and repeat until it exits 0.
5. Deploy the replacement backend and UI.
6. Run a two-page smoke workflow where one page requires a revision.
7. Confirm one revision, one evaluation per artifact, no passing-page rewrite, visible page results, successful approval, and complete delivery.
8. Reopen documentation-run admission.

Once step 8 admits the first new run, recovery is forward-only; do not redeploy the old loop against new page-workflow state.

- [ ] **Step 6: Refresh the code graph and inspect the diff**

```bash
cd ..
graphify update .
git status --short
git diff --check
```

Expected: graph update succeeds, `git diff --check` reports no whitespace errors, and only intended implementation, test, UI, documentation, migration, and graph files are changed.

- [ ] **Step 7: Commit verification tooling and runbook changes**

```bash
git add draftly-agent-backend/scripts/check_documentation_cutover.py draftly-agent-backend/tests/scripts/test_check_documentation_cutover.py docs/documentation-workflow-cutover.md
git commit -m "ops: add documentation workflow cutover gate"
```

---

## Acceptance Checklist

- [ ] Every new page has a stable page ID and immutable artifact ID, version, and SHA-256 hash.
- [ ] Every artifact is evaluated exactly once, and stale results are rejected.
- [ ] A failed page revises independently while passing sibling artifacts remain unchanged.
- [ ] Missing evidence and exhausted attempts pause for human review without being marked passed.
- [ ] Cross-page review runs only after page gates pass and targets named pages only.
- [ ] Restarting a worker resumes pending or expired leased tasks without repeating completed work.
- [ ] Changelog and delivery cannot consume incomplete, failed, or stale artifacts.
- [ ] The documentation graph contains no writer/evaluator or reviewer/writer feedback edge.
- [ ] Review and workflow-run pages show compact page status and evaluation details.
- [ ] Historical runs remain readable with an empty page-results list.
- [ ] Backend tests, Ruff, UI tests, UI lint, UI build, graph refresh, and diff checks all pass.
