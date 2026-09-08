# PR Run Skills & Prompts — Analysis Findings and Requirements

Date: 2026-09-08

## Purpose

The PR documentation workflow (`documentation_graph.py`) was run live against a
real PR webhook (`run B22CC5`), and the skills and prompts each node loads were
analyzed against how the run actually executes. This spec records the mapping
between PR-run graph nodes and the skills/prompts they load, plus six findings
that must be enhanced or hardened before the next run. It is the upstream spec
for `docs/superpowers/plans/2026-09-08-pr-run-skills-hardening.md`.

## Node → Agent → Skills/Prompts Map

| Node | Agent factory | Skills loaded | Primary prompt |
|------|---------------|---------------|----------------|
| `classify` | `build_classifier` | (none) | `CLASSIFIER_PROMPT` |
| `context` | `build_doc_context_agent` (MemoryGroundedNode) | `documentation-research`, `documentation-gap-detection` | `DOC_CONTEXT_PROMPT` |
| `research` | `build_doc_research_swarm` | local researcher: `github-pr-analysis`, `github-release-analysis`; docs/slack/discord researchers: `documentation-research`, `documentation-gap-detection`, `github-pr-analysis` | `DOC_RESEARCH_PROMPT` (docs researcher only) |
| `impact` | `build_impact_agent` | `documentation-gap-detection`, `documentation-audit` | `IMPACT_PROMPT` |
| `create`/`update` | `build_writer_agent` (×2) | `documentation-update`, `documentation-generation` | `WRITER_PROMPT` |
| `evaluate` | `EvaluatorNode` (deterministic gate) | (none) | n/a (`EVALUATION_RULES` rendered into reviewer) |
| `reviewer` | `build_reviewer` | `documentation-evaluation`, `documentation-audit` | `REVIEWER_PROMPT` + `EVALUATION_RULES` |
| `changelog` | `build_changelog_agent` | (none) | `CHANGELOG_PROMPT` |

Runtime shapes that matter: `EvidenceBundle.items: list[dict[str, Any]]`
(`schemas.py`), `ImpactAnalysis` (`action`, `affected_documents[]`,
`rationale`, `evidence[]`), deterministic gate weights coverage 0.4 /
completeness 0.3 / length 0.3 (`orchestration/nodes/evaluate.py`), reason
strings `Grounded in N/M sources`, `Covers K/M key topics`, `Adequate detail
level`, and the revise loop `evaluate → needs_revision_of → create/update`.

## Findings

### F1 — Evidence contract is untyped and `topic` never propagates

`EvidenceBundle.items` is `list[dict[str, Any]]`; the skills' "Output" sections
describe items only as "doc ids, paths, excerpts". Live context-agent output
carried `items` without `topic` (the run logged `evidence_items=6` with no
explicit topics), so the deterministic gate's completeness check fell back to
id-basename matching (`_evidence_topic`). A typed item contract lets the
structured-output tool validate the shape at the boundary and lets skills
reliably emit `topic`.

**Requirement:** type evidence items as `{id, url, topic, excerpt}` (unknown
keys preserved); coerce models → dicts at the evaluate node boundary; update
the Output sections of `documentation-research`, `documentation-gap-detection`,
and `github-pr-analysis` to the stated shape and to always populate `topic`.

### F2 — `github-pr-analysis` self-contradicts in LOCAL mode

`allowed-tools: get_pull_request get_diff get_files ...`, step 1 ("Fetch the
pull request with `get_pull_request`, then `get_diff` and `get_files`"), and
`pr-analysis-rules.md` ("**Fetch the diff** — never classify from title alone;
use `get_diff` and `get_files`") all instruct the GitHub API — but local /
offline runs have no such tools, and the local researcher's own system prompt
forbids them. Strands treats `allowed_tools` as metadata ("Experimental: not
yet enforced"), so the prose is what drives behavior, and it is wrong for
local grounding.

**Requirement:** make the skill mode-aware: add `references/local-mode.md`
(diff comes from task context; never call the GitHub API); detect mode from
the available toolset; align step 1 and `pr-analysis-rules.md`.

### F3 — Impact node loads the wrong skills

`build_impact_agent` loads `documentation-gap-detection` (support-recurrence
procedure) and `documentation-audit` (scheduled staleness audit). Its job is
the `update`/`create`/`answer`/`none` decision against a PR event — exactly
`github-pr-analysis`'s `documentation-impact.md`, plus `documentation-research`
for coverage work.

**Requirement:** impact loads `github-pr-analysis` + `documentation-research`;
drop `documentation-gap-detection` and `documentation-audit` there.

### F4 — Revision loop gives the writer no actionable feedback

`WRITER_PROMPT` has no revision-pass section; `EVALUATION_RULES` describes an
LLM judge ("revise with more citations") whose qualitative criteria do not
match the deterministic gate the graph actually runs (which returns
`{passed, score, reasons}` with `Grounded in N/M sources` / `Covers K/M key
topics` / `Adequate detail level`). A writer asked to revise has no map from a
failed reason to a concrete fix.

**Requirement:** add a "Revision pass" section to `WRITER_PROMPT` that reads the
evaluate reasons and maps each to an explicit fix; align
`EVALUATION_RULES`'s scoring and failure policy to the deterministic weights
(coverage 0.4 / completeness 0.3 / length 0.3) and reason vocabulary.

### F5 — Repo anchoring is only a prompt placeholder

`local_repo_note_for(repo_dir)` returns `""` when `repo_dir` is None, the
research swarm's local researcher hardcodes a generic `<local checkout path>`
(inline system prompt in `research_swarm.py`), and `build_doc_research_swarm`
does not accept `repo_dir` at all. Repo tools therefore run against the
container cwd (observed to be the Draftly repo during the run) rather than the
task's checkout.

**Requirement:** thread the resolved `repo_dir` into the swarm and the
local-researcher system prompt (concrete path, always pass `repo_dir=...`,
never operate outside that root); strengthen `LOCAL_REPO_NOTE` with the same
scoping and a "never cite unconfirmed paths" rule.

### F6 — Taxonomy drift, a dead prompt, and a support-centric skill

1. The event vocabulary lives in four places — `schemas.EventClassification`
   descriptions, `pr-analysis-rules.md`, `change-impact-rules.md`,
   `documentation-impact.md` — and they can drift. Single-source the
   vocabularies {surfaces, change types, urgencies, actions} and pin skills to
   them with a drift test.
2. `DOC_RESEARCH_PROMPT` is consumed by the standalone docs researcher but NOT
   by the documentation graph (which builds a swarm). Add a note so editors
   keep both in sync rather than assuming the graph path.
3. `documentation-gap-detection` is support-centric (recurrence counting,
   clusters); its steps 1–2 do not apply to PR events. Add an applicability
   note so PR runs skip recurrence and use the coverage/gap/action steps
   directly.

## Acceptance Criteria (mirrored by the implementation plan's tests)

- `EvidenceItem` model + evaluate coercion — unit tests in
  `tests/unit/agents/test_evidence_contract.py`, node test in
  `tests/nodes/test_evaluator.py`.
- Skill contract invariants — `tests/unit/agents/test_skill_contracts.py`
  (local-mode reference + mentions; impact-agent loaded skills).
- Prompt invariants — `tests/unit/agents/test_prompts.py` (revision block,
  deterministic weights).
- Repo anchoring — `tests/unit/agents/test_local_researcher_prompt.py`.
- Taxonomy drift — `tests/unit/agents/test_taxonomy_drift.py`.
- Full suite stays green: `1311 passed, 5 skipped` (excl. `test_online.py`);
  `test_online.py` `73 passed`, 1 pre-existing env failure
  (`test_build_online_task_env_state_carries_real_diff`).