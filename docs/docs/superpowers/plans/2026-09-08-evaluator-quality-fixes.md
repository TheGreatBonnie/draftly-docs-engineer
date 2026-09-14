# Evaluator Quality Fixes (github_pr.enqueue death-spiral)

Date: 2026-09-08
Branch: `development` (dirty — working tree has uncommitted changes; do not clobber)

## Problem

The `github_pr.enqueue` docs workflow surfaced `pr_workflow_done status=failed`.
Root cause (verified by reproduction): the deterministic evaluator
(`src/draftly/orchestration/nodes/evaluate.py`) rejects generated docs three
times (0.65 → 0.60 → 0.55) and then gets cut off by `max_node_executions=10`
before `deliver` runs. Three contributing failures:

1. **Blind loop.** The completeness reason only fires when it *passes*
   (`completeness > 0.7`). When it fails, the writer sees only
   "Score X.xx (threshold)". It has no concrete way to know *which* topics are
   missing, so revisions flail and the score drifts down.
2. **No escalation.** Even at `evaluator.max_iterations`, the node keeps
   returning `passed=False`, and `needs_revision_of()` routes back to the
   writer indefinitely. The run dies on the node budget instead of reaching
   the human `ReviewGate` (which the prompts' failure policy requires).
3. **Budget mismatch.** Config `max_node_executions=10` is below the worst-case
   path (4 upstream + 2×writer + 2×evaluate + changelog + changelog_evaluate +
   deliver = 11 with `evaluator_max_iterations=2`), so delivery never runs.

Plus an optional rubric grader (Option C) using the Strands Eval SDK.

## Approach

TDD: RED (failing test) → GREEN (minimal code) for each fix. Run
`tests/nodes/test_evaluator.py` (22 baseline tests, currently green) plus the
full suite after.

## Fix 1 — Failure-gated missing-topic feedback (evaluate.py)

- `compute_quality()`: when `completeness <= 0.7`, append a reason that lists
  the derived topic names not present in the draft, e.g.
  "Missing topics: oauth, changelog, models". Keep the success reason.
- Deterministic, unit-testable.

## Fix 2 — Honest/usable topic derivation (evaluate.py + prompts.py)

- `_evidence_topic()`: honor an explicit `topic`; keep basename fallback.
- Emit missing-topic names based on the *useful* topics only (skip empty /
  common basenames that were already excluded).
- Update `EVALUATION_RULES` prompt so the writer gets the richer, actionable
  reasons (the "Revision pass" reads `evaluate.reasons`).

## Fix 3 — Escalate to human review at max iterations (evaluate.py + routing)

- In `EvaluatorNode.invoke_async`, when `not passed` and
  `self.iteration >= self.max_iterations`, set `passed=True` and mark
  `escalated=True`, appending
  "Quality threshold not met after N evaluations; escalated to human review".
  This mirrors the existing waiver path so `needs_revision_of()` becomes false
  and the graph routes toward `deliver` → human `ReviewGate` with the eval
  payload.
- `needs_revision_of()` guard is satisfied by `passed=True` (no routing change
  strictly required, but add `escalated` to the payload and verify routing).

## Fix 4 — Reconcile node budget (config.py + context.py)

- Raise default `strands_max_node_executions` / `StrandsConfig.max_node_executions`
  from 10 → 15 (matches `DEFAULT_MAX_NODE_EXECUTIONS`) so the worst-case path
  (including escalation tail: changelog, changelog_evaluate, deliver) fits.
- Optionally forward `evaluator_max_iterations` through `graph_limits()` and
  add an env knob so ops can tune it without a code change.

## Option C — Pluggable rubric grader (new: scalar module + wiring)

- Add an injectable rubric grader (Strands Eval `OutputEvaluator`) that scores
  the draft against a rubric and returns rich reasons (naturally names missing
  topics). The deterministic gate remains the primary gate (cheap, reliable);
  the LLM grader is an optional adjunct enabled by config and injected via a
  callable so tests substitute a fake. Deterministic behavior is unit-tested
  against a fake grader; the real `OutputEvaluator` path is wired but not
  called in unit tests.

## Files touched

- `src/draftly/orchestration/nodes/evaluate.py` (Fixes 1, 2, 3, Option C)
- `src/draftly/agents/prompts.py` (Fix 2: EVALUATION_RULES / revision pass)
- `src/draftly/orchestration/routing/conditions.py` (Fix 3: verify `escalated`
  routing; add escalation-aware condition if needed)
- `src/draftly/app/config.py` + `src/draftly/workflows/context.py` (Fix 4)
- `tests/nodes/test_evaluator.py` (new tests for each fix)
- new tests for escalation/routing and rubric grader

## Verification

- `uv run pytest tests/nodes/test_evaluator.py` (and changelog sibling)
- full `uv run pytest`, typecheck (`uv run mypy .` if configured), lint
- `graphify update .` per AGENTS.md after code changes

## RESULT — 2026-09-08

### Fix 1 (done, GREEN)
`compute_quality()` now emits a failure-gated `Missing topics: a, b, c` reason
(naming uncovered topics) when `completeness <= 0.7`; the success reason is
unchanged. Tests:
`test_failed_completeness_names_missing_topics`,
`test_missing_topics_reason_omits_already_covered_topics`.

### Fix 2 (done, GREEN)
Writer revision prompt now instructs how to act on a `Missing topics: ...`
reason (author a real section per named topic). Test:
`test_writer_revision_acts_on_missing_topics_feedback`.

### Fix 3 (done, GREEN)
`EvaluatorNode` and the sibling `ChangelogEvaluatorNode` now set
`passed=True` + `escalated=True` when the revision budget
(`self.iteration >= self.max_iterations`) is exhausted while still failing,
appending "Quality threshold not met after N evaluations; escalated to human
review". This mirrors the existing waiver path: `needs_revision_of()` goes
False and the graph routes forward to `deliver` → human `ReviewGate` (as
`INTERRUPTED` → `PENDING_REVIEW`), instead of burning `max_node_executions`
and dying as `FAILED`. Routing invariant locked in
(`test_escalated_evaluator_routes_forward_not_to_revision`).

### Fix 4 (done, GREEN)
`StrandsConfig.max_node_executions` / `Settings.strands_max_node_executions`
default raised 10 → 15 (matches `DEFAULT_MAX_NODE_EXECUTIONS`), and
`evaluator_max_iterations` is now a tunable settings knob forwarded through
`WorkflowContext.graph_limits()`. Tests in
`tests/unit/app/test_evaluator_budget.py`.

### Option C (done, GREEN)
New `src/draftly/orchestration/nodes/rubric_grader.py`: `RubricGrade`,
`RubricGrader` protocol, `StrandsRubricGrader` (adapter over the Strands Eval
`OutputEvaluator`, reusing the project's existing rubric-judge machinery), and
`build_rubric_grader`. `EvaluatorNode` accepts an optional `rubric_grader`
callable called only on failing drafts; its reasons are appended with a
`[rubric] ` prefix. Off by default (gate stays deterministic); unit-tested
with fakes (enrichment, skip-on-pass, graceful failure, no-grader default).

### Verification results
- Targeted suites: 107 passed (nodes + conditions + prompt + budget).
- Full suite: `1427 passed, 1 failed, 5 skipped` — the single failure
  (`tests/evaluation/test_online.py::test_build_online_task_env_state_carries_real_diff`)
  is pre-existing & environment-dependent (requires the local
  `authly-scenarios/001-oauth-login` worktree, absent here); the test and its
  `online.py` path are already dirty in the working tree and unaffected by
  these changes.
- `ruff check`: clean on all touched files.
- `mypy` is currently BLOCKED project-wide by a pre-existing "Source file
  found twice under different module names" error (reproduces on an untouched
  file, `draftly_agent.py`); a scoped `mypy` run shows no new errors from my
  logic — only pre-existing `context.py` untyped-closure errors and the
  project's usual untyped `strands_evals` imports (same pattern as the
  existing `evaluation/evaluators/*` judges).

### Required grader (added 2026-09-08, done, GREEN)
Following user approval (brainstorming; "Advisory but always runs" +
"Both evaluators"), the rubric grader is now **mandatory production wiring**:

- `EvaluatorNode.__init__` and `ChangelogEvaluatorNode.__init__` require a
  `rubric_grader` (TypeError when missing or `None`); the `is not None`
  guard is dropped so the grader always runs on failed drafts.
- The `ChangelogEvaluatorNode` now grades failing changelog entries too,
  feeding `grade(draft=raw_markdown, evidence=<context|research deps>)`
  and appending deduped `[rubric] ...` reasons (try/except; LLM failure
  degrades, never crashes).
- `rubric_grader.py` gains `build_docs_rubric_grader`,
  `build_changelog_rubric_grader`, and a required (non-optional)
  `build_rubric_grader`/`evaluator_with_grader`; new `CHANGELOG_RUBRIC`.
- Grader model resolved via `resolve_model_for_role(model,
  "documentation_reviewer")` — role is fully routable
  (`ROLE_TO_TASK_TYPE` → `TaskType.DOCUMENTATION_REVIEW`;
  `ROLE_POLICIES` verification chain; 4096 output tokens).
- All builders wired: `documentation_graph.py` (docs + changelog
  evaluators), `support_graph.py`, `issue_graph.py`.
- Deterministic gates remain the pass/fail signal; the grader is advisory
  (enriches reasons on failures).

Tests (RED-first, all GREEN):
- `TestEvaluatorNode.__init__` requires grader (TypeError for missing/None).
- `tests/nodes/test_changelog_evaluate.py::TestChangelogRubricGraderRequired`
  + `TestChangelogRubricGrader` (reasons-enriched, skip-on-pass,
  failure-degrades).
- `tests/graph/test_documentation_graph.py::test_documentation_graph_wires_required_rubric_graders`.
- Remaining `EvaluatorNode()` constructions in `test_evaluator.py` moved to
  a `_NoopRubricGrader` so deterministic tests keep their exact assertions.
- `test_graph_role_resolution.py` EXPECTED_ROLES gained
  `documentation_reviewer` for all three graphs (support/issue now resolve it).

Verification: nodes+graph suites GREEN; full suite `1433 passed, 1 failed,
5 skipped` — the single failure remains the pre-existing environmental
`test_online.py` one. `ruff check` clean on all touched files.
