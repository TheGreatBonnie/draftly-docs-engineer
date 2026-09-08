# PR Run Skills & Prompts Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the six findings from the PR-run skills/prompts analysis: type the evidence contract, make `github-pr-analysis` local-mode aware, fix the impact node's skill loading, give the writer a revision-feedback pass, anchor the local researcher to the concrete `repo_dir`, and collapse taxonomy drift into one source.

**Architecture:** Six bounded changes across the PR-docs pipeline. Each is independently testable with unit/invariant tests that run fast offline (no model keys):
1. `EvidenceBundle.items` becomes `list[EvidenceItem]` (typed `id`/`url`/`topic`/`excerpt`) with dict → model coercion; `evaluate.py::_research_evidence` coerces item models back to dicts at the node boundary.
2. `github-pr-analysis` gets a `references/local-mode.md` and a mode-aware Steps section so it stops telling local-grounding runs to call the missing GitHub API.
3. `build_impact_agent` loads `github-pr-analysis` + `documentation-research` instead of `documentation-gap-detection` + `documentation-audit`.
4. `WRITER_PROMPT` gains a "Revision pass" block that maps `EvaluationResult.reasons` to concrete fixes; `EVALUATION_RULES` is aligned to the deterministic gate's weights (coverage 0.4 / completeness 0.3 / length 0.3).
5. `build_doc_research_swarm` gains a `repo_dir: str | None` keyword threaded into a new pure `_local_researcher_prompt(repo_dir)` system-prompt builder; `documentation_graph.py` passes the resolved `repo_dir`.
6. A `taxonomy.py` module becomes the single source for surface/change-type/urgency/action vocabularies used by `schemas.py` descriptions and the skills' markdown; a drift test pins the skills to it.

**Tech Stack:** Python 3.11, Pydantic v2, Strands (`Agent`, `Swarm`, `AgentSkills`, `Skill.from_file`/`from_content`), pytest (21 evaluator tests, 42 nodes tests, swarm-grounding tests, prompt-invariant tests), ruff.

**Spec:** `docs/superpowers/specs/pr-run-skills-analysis.md` (the six-findings analysis delivered in session). Strands reference: `strands.vended_plugins.skills.agent_skills`, `strands.vended_plugins.skills.skill` (skills are AgentSkills.io SKILL.md dirs; `allowed_tools` is metadata — "Experimental: not yet enforced", so consistency with the prompt is what keeps behavior correct), `strands.tools.structured_output.structured_output_tool` (structured output is a real tool named after the Pydantic model class).

## Global Constraints

- **TDD Iron Law:** no production change without a failing (or failing-to-compile) test first.
- **No new dependencies** — Pydantic and Strands only.
- **Existing tests must keep passing.** In particular: `tests/unit/agents/test_prompts.py::TestSchemaContract` asserts `schema_contract(EventClassification)` still contains `"breaking_change"` and `"pull_request"`; `TestRenderedPromptsCarryOutputContract` renders `WRITER_PROMPT`; swarm-grounding tests build the swarm with the CURRENT `build_doc_research_swarm` signature, so the new `repo_dir` kwarg MUST have a default (`None`).
- **Offline testability:** every new test must run without real model keys. Use `tests/stub_model.py::StubModel` and `build_tools()` from `src/draftly/app/composition/tools.py`.
- **No doc-only code changes skipped:** each behavior change needs a test; prompt/markdown content invariants are asserted directly on the rendered/buildable strings.
- **Working dir for all commands:** `draftly-agent-backend/` (repo root is `/Applications/Projects/hackathon/draftly-docs-engineer`, backend is its `draftly-agent-backend` subdirectory).

---

### Task 1: Evidence item contract — `EvidenceItem` + evaluate coercion + skill output contracts

**Files:**
- Modify: `src/draftly/agents/schemas.py:24-28` (add `EvidenceItem`, retype `EvidenceBundle.items`)
- Modify: `src/draftly/orchestration/nodes/evaluate.py:77-88` (`_research_evidence`)
- Modify: `src/draftly/skills/documentation-research/SKILL.md` (Output section)
- Modify: `src/draftly/skills/documentation-gap-detection/SKILL.md` (Output section)
- Modify: `src/draftly/skills/github-pr-analysis/SKILL.md` (Output section)
- Test: `tests/unit/agents/test_evidence_contract.py` (new)
- Test: `tests/nodes/test_evaluator.py` (new coercion test)

**Interfaces:**
- Consumes: `pydantic.BaseModel`/`Field` (already imported in schemas.py); Strands validates structured output against the Pydantic model class name.
- Produces: `draftly.agents.schemas.EvidenceItem` with fields `id: str = ""`, `url: str = ""`, `topic: str = ""`, `excerpt: str = ""`, and `model_config = ConfigDict(extra="allow")` (so unknown LLM-emitted keys survive round-trips). `EvidenceBundle.items: list[EvidenceItem] = Field(default_factory=list)`. Task 2..6 depend on `EvidenceItem` existing.

- [ ] **Step 1: Write the failing contract tests**

`tests/unit/agents/test_evidence_contract.py`:

```python
"""Evidence item contract: typed items that survive Pydantic validation."""

from __future__ import annotations

from draftly.agents.schemas import EvidenceBundle, EvidenceItem


def test_evidence_bundle_coerces_dict_items_to_evidence_item_models() -> None:
    bundle = EvidenceBundle(
        items=[{"id": "src/oauth.py", "topic": "OAuth", "excerpt": "..."}]
    )

    item = bundle.items[0]
    assert isinstance(item, EvidenceItem)
    assert item.id == "src/oauth.py"
    assert item.topic == "OAuth"


def test_evidence_item_defaults_are_empty_strings() -> None:
    item = EvidenceItem(content="snippet without id")

    assert item.id == ""
    assert item.url == ""
    assert item.topic == ""
    assert item.excerpt == ""


def test_evidence_item_preserves_unknown_fields() -> None:
    bundle = EvidenceBundle(items=[{"content": "legacy freeform dict", "score": 0.9}])

    payload = bundle.model_dump()
    dumped = payload["items"][0]
    assert dumped["content"] == "legacy freeform dict"
    assert dumped["score"] == 0.9
```

Append to `tests/nodes/test_evaluator.py`:

```python
def test_research_evidence_coerces_evidence_item_models() -> None:
    from draftly.agents.schemas import EvidenceItem
    from draftly.orchestration.nodes.evaluate import _research_evidence

    items = [EvidenceItem(id="src/oauth.py", topic="OAuth")]
    evidence = _research_evidence({"evidence": items})

    assert evidence == [{"id": "src/oauth.py", "topic": "OAuth", "url": "", "excerpt": ""}]
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pytest tests/unit/agents/test_evidence_contract.py tests/nodes/test_evaluator.py -k "evidence" -v`
Expected: FAIL — `ImportError: cannot import name 'EvidenceItem'` (and `_research_evidence` returns `[]` because models are not dicts).

- [ ] **Step 3: Implement schemas.py**

Replace `src/draftly/agents/schemas.py:24-28`:

```python
class EvidenceItem(BaseModel):
    """A single evidence item: what it points at and what it covers.

    LLM research output is validated as ``EvidenceItem`` (Strands builds a
    structured-output tool named after the model class). ``id``/``url`` hold
    the concrete source locator, ``topic`` the coverage topic the draft must
    address, and ``excerpt`` a short quote. Unknown keys survive validation
    so legacy freeform payloads keep working.
    """

    id: str = ""
    url: str = ""
    topic: str = ""
    excerpt: str = ""

    model_config = ConfigDict(extra="allow")


class EvidenceBundle(BaseModel):
    """Evidence collected by the context/research agents."""

    items: list[EvidenceItem] = Field(default_factory=list)
    summary: str = ""
```

Add to the imports at `src/draftly/agents/schemas.py:5-7`:

```python
from pydantic import BaseModel, ConfigDict, Field
```

- [ ] **Step 4: Implement the evaluate coercion**

Replace `src/draftly/orchestration/nodes/evaluate.py:88`:

```python
    normalized: list[dict] = []
    for item in evidence:
        if isinstance(item, dict):
            normalized.append(item)
        elif hasattr(item, "model_dump"):
            normalized.append(item.model_dump())
    return normalized
```

- [ ] **Step 5: Align the skill output contracts**

In `src/draftly/skills/documentation-research/SKILL.md`, replace the `## Output` paragraph with:

```markdown
## Output

An `EvidenceBundle` (`items[]`, `summary`). Each item MUST carry the shape
`{id, url, topic, excerpt}`: `id` is the concrete doc/code path, `url` the
page URL when one exists, `topic` is the short coverage topic the draft must
address (used by the coverage check), and `excerpt` a short supporting quote.
Populate `topic` for every item — the gate falls back to the id's basename
when it is empty, but an explicit topic matches prose reliably.
```

In `src/draftly/skills/documentation-gap-detection/SKILL.md`, replace the `## Output` paragraph with:

```markdown
## Output

`DocumentationGap`s (`topic`, `source`, `occurrences`, `severity`,
`sample_questions[]`, `related_paths[]`) with a recommended action
(create/update) per gap. When the caller renders gaps as evidence, each gap's
`related_paths[]` becomes the evidence `id`s and its `topic` carries over
verbatim.
```

In `src/draftly/skills/github-pr-analysis/SKILL.md`, replace the `## Output` section (lines 41-45) with:

```markdown
## Output

An `EventClassification` (`surface: "pull_request"`, `change_type`, `urgency`,
`reason`) plus an `ImpactAnalysis` (`action`, `affected_documents[]`,
`rationale`, `evidence[]`). Each `evidence[]` entry carries
`{id, url, topic, excerpt}` — give every entry a `topic` so the coverage gate
can match it against the authored prose.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pytest tests/unit/agents/test_evidence_contract.py tests/nodes/test_evaluator.py -k "evidence" -v`
Expected: PASS (contract tests + coercion test).

Run full node suite: `pytest tests/nodes -q`
Expected: PASS (existing 42 tests still green with the coercion change).

- [ ] **Step 7: Commit**

```bash
git add src/draftly/agents/schemas.py src/draftly/orchestration/nodes/evaluate.py src/draftly/skills/documentation-research/SKILL.md src/draftly/skills/documentation-gap-detection/SKILL.md src/draftly/skills/github-pr-analysis/SKILL.md tests/unit/agents/test_evidence_contract.py tests/nodes/test_evaluator.py
git commit -m "feat(evidence): type EvidenceBundle.items as EvidenceItem with dict coercion"
```

---

### Task 2: `github-pr-analysis` local-mode awareness

**Files:**
- Create: `src/draftly/skills/github-pr-analysis/references/local-mode.md`
- Modify: `src/draftly/skills/github-pr-analysis/SKILL.md:4-8,17-39` (mode hook, steps, guidelines; `metadata.references` 3→4)
- Modify: `src/draftly/skills/github-pr-analysis/references/pr-analysis-rules.md:1,19-21` (multi-mode intro + classification evidence clause)
- Test: `tests/unit/agents/test_skill_contracts.py` (new)

**Interfaces:**
- Consumes: Strands `Skill.from_file` behavior — frontmatter `allowed_tools` is metadata, NOT enforced ("Experimental: not yet enforced"), so the SKILL.md instructions are what drives behavior; `references/` become loadable resource files. `metadata.references` counts reference files.
- Produces: a guaranteed-to-exist `references/local-mode.md` and mode-aware instructions that later tasks (reviewer, writer) can rely on not contradicting local grounding.

- [ ] **Step 1: Add the local-mode reference and a guard test (RED)**

Create `src/draftly/skills/github-pr-analysis/references/local-mode.md`:

```markdown
# Local Mode (offline/harness runs)

This skill normally drives evidence collection from the GitHub API. In LOCAL
mode that API is absent — do NOT call `get_pull_request`, `get_diff`,
`get_files`, or any GitHub web tool: the network endpoint is unavailable and
calling it wastes turns on 401s.

WORKING MODE IS DETECTED BY YOUR TOOLSET: if the GitHub web tools are NOT in
your available tool list, you are in local mode.

## What to do instead

1. The PR title, body, diff hunks, and changed-file list are ALREADY in the
   task context. Start from those — never claim you lack the diff.
2. Confirm the changes against the local checkout with the repository tools
   you DO have (`code_search`, `read_file`, `list_directory`, `git_*`), always
   passing `repo_dir=<local checkout path>`.
3. Collect concrete evidence: file paths + line ranges under the checkout, and
   doc ids found via `semantic_search` / `keyword_search` / `hybrid_search`.

## Classification in local mode

- Skip nothing: classify with full effort exactly as in API mode, using the
  task-context diff instead of `get_diff`.
- `documentation_only` still means `none` — do not loop docs work onto itself.
- Never inspect source you cannot reach from the repo root the checkout
  exposes; if a path in the diff is unresolved, mark it in `rationale` rather
  than guessing.
```

Append to `tests/unit/agents/test_skill_contracts.py` (create the file):

```python
"""Contract invariants across the skills consumed by the PR docs graph."""

from __future__ import annotations

from pathlib import Path

from draftly.agents.prompts import load_skills

SKILLS_DIR = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "draftly"
    / "skills"
)


def _markdown(name: str) -> str:
    skill = load_skills(name)
    assert skill, f"skill {name} did not load"
    return skill[0].instructions
```

Then add:

```python
def test_pr_analysis_skill_has_local_mode_reference() -> None:
    reference = SKILLS_DIR / "github-pr-analysis" / "references" / "local-mode.md"
    assert reference.exists(), "references/local-mode.md is required (F2)"


def test_github_pr_analysis_mentions_local_mode() -> None:
    flat = " ".join(_markdown("github-pr-analysis").split())

    assert "local mode" in flat or "LOCAL mode" in flat
    assert "task context" in flat  # diff already provided in local mode
```

- [ ] **Step 2: Run the guard tests to verify they fail**

Run: `pytest tests/unit/agents/test_skill_contracts.py -v`
Expected: FAIL — `reference.exists()` False and the "local mode" invariant fails.

- [ ] **Step 3: Make SKILL.md mode-aware**

In `src/draftly/skills/github-pr-analysis/SKILL.md`, change the frontmatter `metadata.references: 3` → `4`, add after `allowed-tools` a mode hook, and replace the `## Steps` section (lines 17-29) with:

```markdown
## Mode

Working mode is detected by your toolset. If `get_pull_request` / `get_diff` /
`get_files` are in your available tools, you are in GITHUB (API) mode — fetch
from the API. If they are NOT, you are in LOCAL mode: the PR/diff/changed files
are already in the task context; confirm them against the checkout with repo
tools (`repo_dir=<local checkout path>`) and never call the GitHub API. Read
`references/local-mode.md` before researching in local mode.

## Steps

1. In GITHUB mode: fetch the pull request with `get_pull_request`, then
   `get_diff` and `get_files` to inspect the actual changes. In LOCAL mode:
   start from the diff hunks and changed-file list provided in the task
   context (see `references/local-mode.md`).
2. Classify the change type: `documentation_only`, `bug_fix`, `new_feature`,
   `api_change`, `breaking_change`, or `deprecation`.
3. Identify affected product areas and map each to the documentation that
   covers it (via `semantic_search` / `keyword_search` / `hybrid_search`).
4. Produce an `ImpactAnalysis`:
   - `update`: affected docs exist and must change.
   - `create`: docs are missing entirely.
   - `answer`: the PR is a question, not a docs change.
   - `none`: no documentation impact.
```

Add to `## Guidelines` (after line 37):

```markdown
- In LOCAL mode, never call GitHub web tools — the API is unavailable; use the
  task-context diff and repo tooling (see `references/local-mode.md`).
```

Add `references/local-mode.md` to `## References` (after the `pr-analysis-rules.md` line):

```markdown
- `references/local-mode.md` — offline/local grounding rules; read before researching when your toolset has no GitHub web tools
```

- [ ] **Step 4: Update `pr-analysis-rules.md` to be mode-aware**

In `src/draftly/skills/github-pr-analysis/references/pr-analysis-rules.md`, change line 1 header and the classification evidence item:

Paragraph 1 → append after the intro:

```markdown
These rules apply in both GITHUB (API) and LOCAL (offline) modes. In LOCAL mode
the diff comes from the task context, not `get_diff` — but the classification
rigor is identical.
```

Classification item 1 (line ~19) → replace:

```markdown
1. **Fetch/obtain the diff** — never classify from title alone. In GITHUB mode
   use `get_diff` and `get_files`; in LOCAL mode read the diff hunks and
   changed-file list already present in the task context, then confirm against
   the checkout (`references/local-mode.md`).
```

- [ ] **Step 5: Run guard tests to verify they pass**

Run: `pytest tests/unit/agents/test_skill_contracts.py::test_pr_analysis_skill_has_local_mode_reference tests/unit/agents/test_skill_contracts.py::test_github_pr_analysis_mentions_local_mode -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/skills/github-pr-analysis/
git add tests/unit/agents/test_skill_contracts.py
git commit -m "feat(skills): make github-pr-analysis mode-aware with references/local-mode.md"
```

---

### Task 3: Impact node loads the right skills

**Files:**
- Modify: `src/draftly/agents/documentation/analyzer.py:30-39` (`load_skills` tuple)
- Test: `tests/unit/agents/test_skill_contracts.py` (append class)

**Interfaces:**
- Consumes: `build_impact_agent(model, tools) -> Agent` (unchanged signature). Loaded skill names are inspected via the agent's plugin registry (`agent._plugin_registry._plugins`, key `agent_skills`) — verified against the installed Strands SDK.
- Produces: impact agent whose `AgentSkills` plugin loads exactly `{"github-pr-analysis", "documentation-research"}` — meaning it can decide `update`/`create`/`answer` (documentation-impact.md) and research coverage (documentation-research) instead of running the support-recurrence/audit procedures that don't apply to PR events.

- [ ] **Step 1: Write a failing test for the impact agent's loaded skills**

Append to `tests/unit/agents/test_skill_contracts.py`:

```python
def test_impact_agent_loads_pr_analysis_and_research_skills() -> None:
    from draftly.agents.documentation.analyzer import build_impact_agent
    from draftly.app.composition.tools import build_tools
    from tests.stub_model import StubModel

    tools = build_tools()
    agent = build_impact_agent(
        StubModel(), [tools.semantic_search, tools.keyword_search]
    )

    assert _loaded_skill_names(agent) == {
        "github-pr-analysis",
        "documentation-research",
    }


def _loaded_skill_names(agent: object) -> set[str]:
    from strands.vended_plugins.skills import AgentSkills

    registry = getattr(agent, "_plugin_registry", None)
    for plugin in getattr(registry, "_plugins", {}).values():
        if isinstance(plugin, AgentSkills):
            return {s.name for s in plugin.get_available_skills()}
    return set()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/unit/agents/test_skill_contracts.py::test_impact_agent_loads_pr_analysis_and_research_skills -v`
Expected: FAIL — currently `{"documentation-gap-detection", "documentation-audit"}`. (The helper reads `agent._plugin_registry._plugins["agent_skills"]` — verified against the installed Strands: `AgentSkills.get_available_skills()` returns the eager Skill list for `load_skills` instances.)

- [ ] **Step 3: Load the correct skills in analyzer.py**

In `src/draftly/agents/documentation/analyzer.py`, replace the `load_skills("documentation-gap-detection", "documentation-audit")` call with:

```python
                skills=load_skills(
                    "github-pr-analysis",
                    "documentation-research",
                )
```

- [ ] **Step 4: Run the test to verify it passes + no regressions**

Run: `pytest tests/unit/agents/test_skill_contracts.py::test_impact_agent_loads_pr_analysis_and_research_skills -v`
Expected: PASS.

Run: `pytest tests/unit/agents/test_prompts.py -q tests/unit/agents/test_doc_swarm_grounding.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/agents/documentation/analyzer.py tests/unit/agents/test_skill_contracts.py
git commit -m "fix(impact): load github-pr-analysis + documentation-research on the impact agent"
```

---

### Task 4: Writer revision feedback + evaluation-rule alignment

**Files:**
- Modify: `src/draftly/agents/prompts.py:594-715` (`WRITER_PROMPT` — add revision block before "Output contract")
- Modify: `src/draftly/agents/prompts.py:230-253` (`EVALUATION_RULES` — weights + taxonomy alignment)
- Test: `tests/unit/agents/test_prompts.py` (append to `TestGuardrailsPresent`)

**Interfaces:**
- Consumes: `EvaluationResult` fields (`passed`, `score`, `reasons`); deterministic gate weights from `src/draftly/orchestration/nodes/evaluate.py::compute_quality` (coverage 0.4, completeness 0.3, length 0.3) and its reason strings ("Grounded in X/Y sources", "Covers K/M key topics", "Adequate detail level").
- Produces: rendered `WRITER_PROMPT` that, when a revision is requested, instructs the writer to read `{evaluation_rules}` / evaluate reasons and fix each `"Grounded in ..."` / `"Covers ..."` failure; `EVALUATION_RULES` whose scoring section matches the deterministic gate exactly.

- [ ] **Step 1: Write the failing invariant tests**

In `tests/unit/agents/test_prompts.py`, append to `TestGuardrailsPresent`:

```python
    def test_writer_prompt_has_revision_feedback_block(self) -> None:
        rendered = build_prompt(WRITER_PROMPT, output_model=DocChangePlan)

        assert "Revision pass" in rendered
        assert "evaluate reasons" in rendered or "reasons" in rendered

    def test_writer_revision_handles_deterministic_gate_reasons(self) -> None:
        rendered = build_prompt(WRITER_PROMPT, output_model=DocChangePlan)
        flat = " ".join(rendered.split())

        assert "Grounded in" in flat
        assert "Covers" in flat
        assert "deterministic gate" in flat  # revision block's own invariant

    def test_evaluation_rules_match_deterministic_weights(self) -> None:
        rendered = build_prompt(REVIEWER_PROMPT, output_model=EvaluationResult,
                                evaluation_rules="evaluation_rules")

        assert "# Evaluation Rules" in rendered
        flat = " ".join(prompts.EVALUATION_RULES.split())
        assert "0.4" in flat
        assert "0.3" in flat
```

- [ ] **Step 2: Run these tests to verify they fail**

Run: `pytest tests/unit/agents/test_prompts.py -k "revision or deterministic_weights" -v`
Expected: FAIL — WRITER_PROMPT has no "Revision pass", and EVALUATION_RULES says "Quality (structure/style) 0.3" (no length-term 0.3 + coverage 0.4 both present as written).

- [ ] **Step 3: Add the revision block to WRITER_PROMPT**

In `src/draftly/agents/prompts.py`, insert the following section between the "### Completeness check" paragraph (ends at line ~703) and the `Output contract:` block (line 705):

```python
## Revision pass (when the evaluation requests a fix)

The task carries the evaluate result from the previous pass when this is a
revision. Read its `reasons` and fix EVERY failure it names before producing
the new plan:

- A reason like `Grounded in N/M sources`: the previous draft did not cite some
  of the evidence items supplied for the task. Add a `## References` section
  (or extend the existing one) that links EVERY evidence source id/url by its
  exact full path verbatim, and make the prose actually reference the covered
  topics.
- A reason like `Covers K/M key topics`: the previous draft skipped a coverage
  topic. For each topic named in the evidence, ensure a real section with
  concrete mechanics exists for it — referencing the area without covering it
  is incomplete.
- A reason about detail level: expand the thin page with exact symbols,
  parameters, and runnable steps from the diff/evidence.
- Never restate the old plan unchanged: the reasons describe exactly what the
  deterministic gate measured, so address each measured gap.
```

- [ ] **Step 4: Align EVALUATION_RULES with the deterministic gate**

In `src/draftly/agents/prompts.py`, replace the `## Scoring` block (lines 238-245) with:

```python
## Scoring

- Overall score is computed by a DETERMINISTIC gate (not judgement):
  - Coverage (evidence cited in draft) 0.4
  - Completeness (evidence topics covered) 0.3
  - Length/detail heuristic 0.3
- Each component ranges 0.0-1.0; overall = coverage*0.4 + completeness*0.3 +
  length*0.3.
- A draft passes at score >= 0.70.
- Gate reasons use exactly: `Grounded in N/M sources`, `Covers K/M key topics`,
  `Adequate detail level`.
```

And replace `## Failure Policy` bullets (lines 249-252) with:

```python
- **Not grounded** (`Grounded in N/M sources`) → re-author with every evidence
  id/url linked verbatim in a `## References` section.
- **Incomplete** (`Covers K/M key topics`) → author real sections for each
  missing topic.
- **Low detail** (missing `Adequate detail level`) → expand with exact
  symbols/parameters/steps.
- After 3 failed iterations, escalate to human review.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pytest tests/unit/agents/test_prompts.py -k "revision or deterministic_weights" -v`
Expected: PASS (all 3 new tests).

Then the full prompt suite: `pytest tests/unit/agents/test_prompts.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/agents/prompts.py tests/unit/agents/test_prompts.py
git commit -m "feat(prompts): writer revision-feedback pass + evaluation rules aligned to gate"
```

---

### Task 5: Anchor the local researcher to the concrete repo_dir

**Files:**
- Modify: `src/draftly/agents/documentation/research_swarm.py:28-44,47-54` (pure prompt builder + `repo_dir` kwarg)
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py:176-182` (pass `repo_dir`)
- Modify: `src/draftly/agents/prompts.py:54-70` (`LOCAL_REPO_NOTE` scoping clause)
- Test: `tests/unit/agents/test_skill_contracts.py` → new file `tests/unit/agents/test_local_researcher_prompt.py`

**Interfaces:**
- Consumes: `build_doc_research_swarm(model, tools, local_tools=None, *, github_tools=None, grounding="local") -> Swarm` — the added `repo_dir: str | None = None` keyword MUST default so existing callers/tests stay green. Uses `draftly.agents.prompts.local_repo_note_for`.
- Produces: `draftly.agents.documentation.research_swarm._local_researcher_prompt(repo_dir: str | None) -> str` (pure, testable) used by `_local_researcher`; the local-repo researcher system prompt carries the concrete checkout path and forbids GitHub API calls; the graph passes the resolved `repo_dir`.

- [ ] **Step 1: Write failing tests for the pure prompt builder**

Create `tests/unit/agents/test_local_researcher_prompt.py`:

```python
"""Local-repo researcher system prompt is repo_dir-anchored (F5)."""

from __future__ import annotations

from draftly.agents.documentation.research_swarm import (
    _local_researcher_prompt,
)


def test_local_researcher_prompt_injects_concrete_repo_dir() -> None:
    prompt = _local_researcher_prompt("/tmp/repos/authly/authly")

    assert "/tmp/repos/authly/authly" in prompt
    assert "repo_dir=" in prompt


def test_local_researcher_prompt_forbids_github_api() -> None:
    prompt = _local_researcher_prompt("/tmp/repos/authly/authly")

    assert "get_pull_request" in prompt
    assert "get_files" in prompt
    assert "get_diff" in prompt


def test_local_researcher_prompt_without_repo_dir_keeps_local_mode() -> None:
    prompt = _local_researcher_prompt(None)

    assert "get_diff" in prompt  # GitHub API still forbidden
    assert "task context" in prompt  # local-mode guidance retained
```

(The function does not exist yet, so Step 2's run fails on `ImportError` regardless of the assertion bodies.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/unit/agents/test_local_researcher_prompt.py -v`
Expected: FAIL — `ImportError` (function doesn't exist yet).

- [ ] **Step 3: Extract the pure prompt builder and thread repo_dir**

In `src/draftly/agents/documentation/research_swarm.py`, add after imports:

```python
from draftly.agents.prompts import local_repo_note_for
```

Replace the `_local_researcher` definition (lines 28-44) with:

```python
def _local_researcher_prompt(repo_dir: str | None) -> str:
    """System prompt for the local-repo researcher.

    Anchors the researcher to the concrete ``repo_dir`` when one is known so
    repo tools never silently operate on the wrong checkout (the container
    cwd). Keeps the GitHub-API prohibition hard-coded — offline harness runs
    have no usable API regardless of the checkout.
    """
    note = local_repo_note_for(repo_dir)
    if note:
        return (
            "You research the LOCAL repository checkout for evidence relevant "
            "to the event. The PR/diff/changed files are already provided in "
            "the task context; confirm them with the local repository tools "
            "(code_search, read_file, list_directory, git_*) by ALWAYS passing "
            f"repo_dir=<{repo_dir}>. Do NOT call GitHub web tools "
            "(get_pull_request, get_files, get_diff); never operate on files "
            "outside that checkout root. Collect concrete source ids (file "
            "paths + line numbers)."
        )
    return (
        "You research the LOCAL repository checkout for evidence relevant to "
        "the event. The PR/diff/changed files are already provided in the task "
        "context; confirm them with the local repository tools (code_search, "
        "read_file, list_directory, git_*). When a checkout path is known it "
        "is passed as repo_dir=<local checkout path> to the repo tools. Do NOT "
        "call GitHub web tools (get_pull_request, get_files, get_diff): the "
        "network API is unavailable. Collect concrete source ids (file paths "
        "+ line numbers)."
    )


def _local_researcher(model: Any, local_tools: list[Any], repo_dir: str | None) -> Agent:
    return Agent(
        name="local_repo_researcher",
        system_prompt=_local_researcher_prompt(repo_dir),
        model=model,
        tools=local_tools,
        plugins=[AgentSkills(skills=load_skills("github-pr-analysis", "github-release-analysis"))],
        description="Researches local repository evidence for the event.",
    )
```

Add `repo_dir: str | None = None` to `build_doc_research_swarm` (before `github_tools`, or as a keyword):

```python
def build_doc_research_swarm(
    model: Any,
    tools: Any,
    local_tools: list[Any] | None = None,
    *,
    repo_dir: str | None = None,
    github_tools: list[Any] | None = None,
    grounding: str = "local",
) -> Swarm:
```

and update the local branch (line 78):

```python
        local_agent = _local_researcher(model, local_tools or [], repo_dir)
```

- [ ] **Step 4: Pass repo_dir from the graph**

In `src/draftly/orchestration/graphs/documentation_graph.py`, replace the `research_swarm = research_builder(...)` call (lines 176-182) with:

```python
    research_swarm = research_builder(
        research_model,
        reg,
        local_tools=swarm_local_tools,
        github_tools=swarm_github_tools,
        grounding=grounding,
        repo_dir=repo_dir,
    )
```

- [ ] **Step 5: Strengthen the LOCAL_REPO_NOTE scoping clause**

In `src/draftly/agents/prompts.py`, replace the `LOCAL_REPO_NOTE` string (lines 54-59) with:

```python
LOCAL_REPO_NOTE = """The repository is available as a LOCAL checkout and the
PR/diff/changed files are already provided in the task context. Inspect code
and docs with the local repository tools (code_search, read_file,
list_directory, git_*), ALWAYS passing repo_dir=<local checkout path> so tools
act on the checkout that backs this task — never the ambient working
directory. Do NOT call get_pull_request / get_files / get_diff / GitHub web
tools: the network API is not available for this task. Never cite a file path
you have not confirmed exists under repo_dir."""
```

- [ ] **Step 6: Run the suite**

Run: `pytest tests/unit/agents/test_local_researcher_prompt.py -v`
Expected: PASS (3 tests).

Run swarm-grounding + prompt suites (signature default keeps them green):
```bash
pytest tests/unit/agents/test_doc_swarm_grounding.py tests/unit/agents/test_prompts.py -q
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/draftly/agents/documentation/research_swarm.py src/draftly/orchestration/graphs/documentation_graph.py src/draftly/agents/prompts.py tests/unit/agents/test_local_researcher_prompt.py
git commit -m "feat(research): anchor local researcher to concrete repo_dir"
```

---

### Task 6: Taxonomy single source + drift test + dead-path note + gap-detection applicability

**Files:**
- Create: `src/draftly/agents/taxonomy.py`
- Modify: `src/draftly/agents/schemas.py:10-21,31-37` (surface/change_type/action descriptions reference taxonomy constants)
- Modify: `src/draftly/agents/prompts.py:527` (`DOC_RESEARCH_PROMPT` dead-path note)
- Modify: `src/draftly/agents/documentation/researcher.py` (dead-path comment)
- Modify: `src/draftly/skills/documentation-gap-detection/SKILL.md` (PR-event applicability note; metadata.references unchanged)
- Test: `tests/unit/agents/test_taxonomy_drift.py` (new)

**Interfaces:**
- Consumes: nothing new (constants only).
- Produces: `draftly.agents.taxonomy` with `SURFACES`, `CHANGE_TYPES`, `URGENCY_LEVELS`, `DOCA_ACTIONS` (the four action vocabularies). `schemas.EventClassification` and `ImpactAnalysis` descriptions are built from it, so the drift test can iterate them.

- [ ] **Step 1: Write drifting tests (RED — module missing)**

Create `tests/unit/agents/test_taxonomy_drift.py`:

```python
"""Vocabulary single-sourcing: skills and schemas cannot drift (F6)."""

from __future__ import annotations

from pathlib import Path

from draftly.agents.taxonomy import CHANGE_TYPES, DOCA_ACTIONS, SURFACES

SKILLS_DIR = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "draftly"
    / "skills"
)


def test_pr_analysis_rules_table_covers_every_change_type() -> None:
    rules = (SKILLS_DIR / "github-pr-analysis" / "references" / "pr-analysis-rules.md").read_text()

    for change_type in CHANGE_TYPES:
        assert f"`{change_type}`" in rules, f"missing change type row: {change_type}"


def test_documentation_impact_rules_covers_every_action() -> None:
    rules = (SKILLS_DIR / "github-pr-analysis" / "references" / "documentation-impact.md").read_text()

    for action in DOCA_ACTIONS:
        assert f"`{action}`" in rules, f"missing action row: {action}"


def test_schema_surfaces_are_not_enumerated_twice() -> None:
    from draftly.agents.schemas import EventClassification

    description = EventClassification.model_fields["surface"].description or ""
    for surface in SURFACES:
        assert f'"{surface}"' in description
```

- [ ] **Step 2: Run the drift tests to verify they fail**

Run: `pytest tests/unit/agents/test_taxonomy_drift.py -v`
Expected: FAIL — `ModuleNotFoundError: draftly.agents.taxonomy`.

- [ ] **Step 3: Create taxonomy.py**

Create `src/draftly/agents/taxonomy.py`:

```python
"""Single source of truth for the documentation-agent vocabularies.

The PR classification, change-type, urgency, and action vocabularies live in
four places today (schema descriptions, pr-analysis-rules.md,
change-impact-rules.md, documentation-impact.md). These constants are the
canonical lists; tests/unit/agents/test_taxonomy_drift.py pins the prose to
them, and schemas.py builds its descriptions from them.
"""

from __future__ import annotations

SURFACES = ("pull_request", "issue", "support_question")

CHANGE_TYPES = (
    "documentation_only",
    "bug_fix",
    "new_feature",
    "api_change",
    "breaking_change",
    "deprecation",
    "question",
    "other",
)

URGENCY_LEVELS = ("low", "medium", "high")

DOCA_ACTIONS = ("answer", "update", "create", "none")
```

- [ ] **Step 4: Build schema descriptions from the constants**

In `src/draftly/agents/schemas.py`, change the imports to add:

```python
from draftly.agents.taxonomy import CHANGE_TYPES, DOCA_ACTIONS, SURFACES
```

and replace `EventClassification` (lines 10-21) and `ImpactAnalysis.action` (line 34) descriptions:

```python
class EventClassification(BaseModel):
    """Structured classifier output for an incoming surface event."""

    surface: str = Field(
        description=" | ".join(f'"{s}"' for s in SURFACES)
    )
    change_type: str = Field(
        description=" | ".join(f'"{c}"' for c in CHANGE_TYPES)
    )
    urgency: str = Field(description='"low" | "medium" | "high"')
    reason: str = Field(description="Short justification for the classification")
```

```python
    action: str = Field(description=" | ".join(f'"{a}"' for a in DOCA_ACTIONS))
```

- [ ] **Step 5: Run drift + schema tests to verify GREEN (and existing schema tests)**

Run: `pytest tests/unit/agents/test_taxonomy_drift.py tests/unit/agents/test_prompts.py -q`
Expected: PASS (drift tests pass; `test_lists_field_names`/`test_lists_enum_values_from_descriptions` still green because `"breaking_change"` and `"pull_request"` still appear in the rendered descriptions).

- [ ] **Step 6: Dead-path note + gap-detection applicability**

In `src/draftly/agents/prompts.py`, above `DOC_RESEARCH_PROMPT` (line 527) add:

```python
# NOTE: DOC_RESEARCH_PROMPT is used by the standalone docs researcher
# (documentation/researcher.py). The documentation GRAPH does not consume it —
# it builds the research swarm (agents/documentation/research_swarm.py), whose
# docs_researcher uses this same prompt. Keep both in sync when editing.
```

In `src/draftly/agents/documentation/researcher.py`, above the `build_doc_researcher` body, confirm a comment already explains its role; if not, add:

```python
# Standalone docs researcher used by the support flow and by the research
# swarm's docs_researcher. The documentation graph routes through the swarm.
```

In `src/draftly/skills/documentation-gap-detection/SKILL.md`, after the Purpose paragraph add:

```markdown
## Applicability

This skill's steps assume a support/feedback lookback (recurrence counts,
clusters). When invoked from a pull_request/release event there is no
support-feedback dataset — SKIP steps 1-2 (no recurrence counting) and apply
steps 3-5 (coverage check, gap decision, action) to the event's evidence
directly. The `github-pr-analysis` skill owns classification and action
decisions for PR events.
```

- [ ] **Step 7: Run the full targeted suite**

Run: `pytest tests/unit/agents tests/nodes -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/draftly/agents/taxonomy.py src/draftly/agents/schemas.py src/draftly/agents/prompts.py src/draftly/agents/documentation/researcher.py src/draftly/skills/documentation-gap-detection/SKILL.md tests/unit/agents/test_taxonomy_drift.py
git commit -m "feat(taxonomy): single-source vocabularies with drift tests"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run:
```bash
pytest -q --ignore=tests/evaluation/test_online.py
pytest tests/evaluation/test_online.py -q -x
ruff check src/draftly tests
```
Expected: PASS — baseline `1311 passed, 5 skipped` (excluding online) and `73 passed, 1 pre-existing env failure` (`test_build_online_task_env_state_carries_real_diff`, unrelated to this change set); ruff clean.

- [ ] **Step 2: Update the knowledge graph**

Run: `graphify update .` (from the repo root).

- [ ] **Step 3: Report and hand off the docker rerun**

Report the changes and verified counts. User-owned confirmation (unchanged from the evaluate-gate work):

```bash
docker compose -f docker-compose.redis.yml up -d --build rq-worker
# then POST scripts/pr_opened.json to the /pr webhook
```
Expected: worker log shows the PR workflow run completing with the hardened skills/prompts; evaluate verdict still `passed`.

- [ ] **Step 4: Commit any leftover docs changes**

```bash
git add docs/superpowers/plans/2026-09-08-pr-run-skills-hardening.md
git commit -m "docs: add PR run skills & prompts hardening plan"
```