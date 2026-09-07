# Remaining Workflow Evaluations — Implementation Plan

- **Date:** 2026-09-04
- **Approach:** A — extend the existing evaluation harness (no new graphs or loops)
- **Modes:** both deterministic sync (CI-safe) and live (real graph + LLM judges)
- **Status:** plan — no implementation authorized yet

## 1. Goal

Bring the four graph-backed evaluation gaps under the existing evaluation
framework (`evaluation_graph` + `run_dataset_sync` / `run_dataset_live` +
`scripts/run_evaluation.py`), reusing established evaluator and persistence
patterns:

1. `github_release` (`run_release_workflow`, documentation_graph)
2. `discord_support` parity (`run_discord_support`, support_graph)
3. `feedback_loop` incl. `prioritize_gaps` / `plan_knowledge_updates` (feedback_graph)
4. `memory_curation` (`run_memory_curation`, curator agent)

## 2. Non-goals (deferred P3, not designed here)

Standalone scheduled workflows with no agent graph to score:
`documentation_sync`, `documentation_audit`, `memory_maintenance` detail,
`onboarding_initialize`, `process_issue_feedback`, `resolve_support_thread`,
`record_post_run_memory`, `evaluate_support_answer` wiring. These need
bespoke deterministic harnesses and are tracked as follow-up work.

## 3. Background (current state)

- 3 golden datasets exist (`draftly-agent-backend/src/draftly/evaluation/datasets/`):
  `documentation.json` (`surface: pull_request`), `github_issues.json`
  (`surface: issue`), `support.json` (`surface: support`) — one case each.
- Live routing supports exactly 3 surfaces (`evaluation/online.py`
  `SURFACE_EVENT_TYPES`): `pull_request → pull_request.opened`,
  `issue → issues.opened`, `support → slack.message` (source hardcoded to `slack`).
- Evaluator suite (`evaluation/runner.py`): `ExpectedContains`,
  `ExpectedToolCalled`, `ExpectedAuthoringAction`, `ExpectedDelivered`,
  `NodeToolCalled`, plus 5 rubric LLM judges (groundedness, correctness,
  relevance, completeness, documentation_quality).
- Persistence labels via `SURFACE_TO_EVALUATION_TYPE`
  (`workflows/evaluation/documentation_evaluation.py`): pull_request →
  documentation, issue → github_issue, support → support.
- Entry point: `scripts/run_evaluation.py --live --datasets <file>`
  (live runs carry a ~600s inner budget per dataset; use single-case smoke
  files). Live graph runs use `dataset_timeout=1800.0`.
- Regression safety: `tests/evaluation/test_online.py`,
  `tests/evaluation/test_runner.py`, `tests/workflows/test_evaluation_loop.py`.

## 4. Architecture (no new graphs or loops)

Every new dataset flows the existing path:

```
scripts/run_evaluation.py --live --datasets <file>
  → run_evaluation_loop
    → evaluation_graph (load_datasets → run_experiments → persist_results)
      → run_dataset_sync  (sync mode, deterministic, CI-safe)
      → run_dataset_live via build_online_task(client)  (live mode)
    → persist summary with correct evaluation_type
```

New code is confined to: one dataset JSON per surface, one `build_event`
branch per new surface, 3–4 small deterministic evaluators, mapping entries,
README/docs updates. All `runner.py` changes are additive (no signature breaks).

## 5. Phase P0 — Release + Discord (lowest risk, same graphs as covered surfaces)

### 5.1 `github_release` → `release.json`

- Dataset `release.json`, list-wrapped, `surface: release`, `required_tools`
  mirroring `documentation.json` (context/research/impact).
- `online.py`: add `release → release.published` to `SURFACE_EVENT_TYPES`;
  add a `build_event` release branch emitting `{release: {tag, notes, diff,
  changed_files}}` with worktree grounding via `repo_dir`, adapting the PR
  worktree path (`build_worktree_pr`) where a scenario checkout exists.
- Reuse the full PR authoring evaluator suite: `ExpectedContains`,
  `ExpectedToolCalled`, `ExpectedAuthoringAction`, `ExpectedDelivered`,
  per-node `NodeToolCalled`, plus the 5 LLM judges on live runs.
- Cases (3):
  1. Minor release notes (update) — expects authored update + delivery receipt.
  2. Breaking major release (update/create) — expects migration content.
  3. No-doc-change release (`expected_action: none`) — catches eager authoring;
     must produce empty writer output.
- Mapping: `release → documentation` in `SURFACE_TO_EVALUATION_TYPE`.

### 5.2 `discord_support` parity → `discord.json`

- Dataset `discord.json`, `surface: discord`, threshold `0.45` (paraphrase
  surface, same as `support.json`).
- `online.py`: add `discord → discord.message`; generalize the support event
  branch from hardcoded `source: slack` to `metadata.source` (`slack`|`discord`)
  so both share grounding (repo_dir, evidence, cited-source content).
- Reuse support evaluators unchanged. Cases (2): thread reply, @-mention
  question — both grounded in `authly/docs/how-to/troubleshoot-errors.md`.
- Mapping: `discord → support` in `SURFACE_TO_EVALUATION_TYPE`.

## 6. Phase P1 — Feedback loop → `feedback.json`

- Dataset `feedback.json`, `surface: feedback`; each case carries a question
  list plus expected gaps (`{topic, count, action}`).
- New deterministic evaluators in `evaluation/runner.py`:
  `ExpectedGapDetected` (expected gap topic present), `ExpectedGapCount`
  (gap count equals on-topic question count, subject to the case's
  `gap_threshold`), `NoFalsePositiveGap`
  (scattered topics → no gap). Live run invokes `feedback_graph` through the
  online task with the case's `gap_threshold`.
- Cases (3):
  1. Three same-topic questions → exactly 1 gap with `count >= threshold`.
  2. Scattered unrelated questions → no gaps.
  3. Mixed severities → `prioritize_gaps` ordering (breaking × frequency above
     how-to) and `plan_knowledge_updates` plan shape (`key: gap:<topic>`).
- Mapping: `feedback → feedback` in `SURFACE_TO_EVALUATION_TYPE`.

## 7. Phase P2 — Memory curation → `memory_curation.json`

- Dataset `memory_curation.json`, `surface: memory`; each case is a candidate
  batch plus expected decisions (`approve` / `reject` / `merge` with reasons).
- New evaluator `ExpectedCurationDecision` (per-candidate decision match;
  duplicates rejected, low-confidence rejected, near-duplicates merged).
- Sync mode: stub curator returning canned decisions. Live mode: invoke
  `build_memory_curator` with the routed model (offline degrades to
  release-claim-for-retry, which the evaluator scores as a skip, not a pass).
- Mapping: `memory → memory` in `SURFACE_TO_EVALUATION_TYPE`.

## 8. Cross-cutting conventions (must hold for every phase)

- **Failure visibility:** task exceptions surface as failing rows with reasons
  via the parallel-array `report_rows` (never iterate `detailed_results` alone
  — the silent-zero lesson).
- **Budgets:** one smoke case per dataset for live runs (~600s inner budget);
  `dataset_timeout=1800.0` on live graph builds.
- **Evidence grounding:** every answer/authoring surface feeds real diff or doc
  content into `environment_state` so groundedness/correctness judges verify
  against source, not prose.
- **Docs:** README evaluation table + per-dataset `description`/`required_tools`
  kept accurate; each new surface gets a `scripts/run_evaluation.py --datasets
  ...` example.

## 9. Tests (per phase, before marking done)

- Dataset shape test (list-wrapped, surface, threshold, `required_tools`,
  `repo_dir`/`repository` metadata) — cf. `test_support_dataset_matches_live_shape`.
- `build_event` test per new surface (event type, payload keys, source preserved).
- Evaluator unit tests (pass/fail/skip branches, threshold override).
- One `FakeClient` online-task test (output/trajectory/env-state), incl.
  `node_timeout == 600.0` and unique `run_id` assertions.
- Regression: full `tests/evaluation/` + `tests/workflows/test_evaluation_loop.py`
  green; existing 3 datasets byte-identical in behavior.

## 10. Rollout order and acceptance

1. P0 release → P0 discord → P1 feedback → P2 memory curation.
2. Each phase lands sync + live + tests together (no sync-only strays, per the
   both-modes decision).
3. Acceptance per phase: `uv run pytest tests/evaluation tests/workflows`
   green; `scripts/run_evaluation.py` (sync) passes new dataset offline;
   `--live` smoke passes with keys (`DRAFTLY_LIVE=1`); persisted row carries the
   correct `evaluation_type`; dashboard shows the new evaluation kind.
4. P3 standalone workflows remain untracked by this plan — file a follow-up
   before claiming "all workflows evaluated."

## 11. HITL gate evaluation (cross-cutting dimension, ships with each phase)

The review gate is the delivery precondition for every authoring surface, so
it is evaluated as a dimension on new and existing datasets — not as a
separate harness. Sharpest case: P0 release with `expected_action: none` +
`review_policy: always` (must halt, must not author, must not deliver).

**Status quo (verified):** graph interrupt/resume is covered by
`tests/graph/test_review_gate.py` (interrupt before `deliver`, resume-approve
→ `COMPLETED` with `deliver` last, resume-reject → `RuntimeError`); the runner
persists interrupts and marks `pending_review`; `build_online_task` already
honors per-case `metadata.review_policy` (default `"never"`). **Gap:** the
online task returns `{output, trajectory, interactions, environment_state}`
with no `result.status` or interrupts, so the gate can only be noticed
incidentally today.

**Changes (additive only):**

1. **Dataset dimension:** HITL cases carry `metadata.review_policy` plus
   `metadata.expected_gate`: `"interrupt"` (always + authoring change → must
   halt before `deliver`), `"passthrough"` (never, or `risky` + low-risk
   change → must deliver), `"reject"` (interrupt, then resume with rejection
   → must cancel, no delivery, comment recorded).
2. **Task change:** return `status` (`COMPLETED`/`INTERRUPTED`/raised) plus
   `had_interrupt` and interrupt ids, and feed them into `environment_state`
   so deterministic evaluators and judges can read them.
3. **New evaluators** (`evaluation/runner.py`, cross-case style):
   `ExpectedInterrupt` (INTERRUPTED + `deliver` never ran + interrupt stored),
   `ExpectedPassthrough` (COMPLETED + delivery receipt),
   `ExpectedResumeApprove` / `ExpectedResumeReject` — two-step cases that run
   to interrupt, resume through `ReviewService.decide()`, and assert
   `DELIVERED` vs failed-with-comment. Resume cases run against
   `WorkflowRunner` outcomes (`PENDING_REVIEW` → terminal), not bare graph
   results.
4. **Sync mode (CI-safe):** stub graph returning canned `INTERRUPTED`/raise →
   assert the runner stores the interrupt and marks `pending_review`; stub
   resume both ways. No keys needed.
5. **Policy calibration matrix (unit/property):** `change_type` × `urgency` ×
   policy → reviewed-or-not, locking `should_review` /
   `resolve_review_policy`, including unknown-policy-defaults-to-`always`.

**Metrics to persist per run:** interrupt rate by policy, time-in-review
(`created_at` → `decided_at`), approval rate, rejection-comment capture, and
stale-review expiry (no orphaned `PENDING_REVIEW`); rejected output must show
a memory/feedback candidate enqueued per the changes-requested contract.

**Acceptance:** interrupt cases never reach `deliver`; approve always delivers;
reject never delivers and records the comment; `never` never interrupts;
expiry clears stale reviews. Live smoke stays single-case per the ~600s
budget. Each phase (P0→P2) lands its HITL cases together with its datasets —
no phaseless strays.

## 12. Risks

- Shared-harness regression (P0 touches `online.py` support branch) → mitigated
  by additive branches + existing regression tests + byte-identical behavior
  checks on the 3 current datasets.
- Live flake (LLM tool-choice variance) → keep at-least-one `NodeToolCalled`
  semantics; never assert exact tool sequences.
- Cost/time overrun on live runs → single-case smoke files default; full suites
  nightly only.
