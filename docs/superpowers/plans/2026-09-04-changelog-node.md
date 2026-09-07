# Changelog Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated changelog node to the documentation graph that generates Keep a Changelog v2.0.0 entries for every release event, with its own revision loop, delivered as a separate commit in the same PR as doc changes.

**Architecture:** A new `changelog` agent node and `changelog_evaluate` deterministic evaluator node are inserted between `evaluate` and `deliver`. The changelog node reads the existing `CHANGELOG.md`, generates a new version section from the release notes, and produces a `ChangelogEntry` schema. The evaluator verifies format (version header, ISO date, six categories). A new `none_and_release` routing condition ensures maintenance releases with `action: none` still get changelog entries. The delivery agent makes two commits (docs + changelog) on one branch.

**Tech Stack:** Python 3.11+, Pydantic v2, strands-agents 1.52.0, pytest/pytest-asyncio

**Spec:** This plan implements the design approved in the brainstorming session (Option B: dedicated changelog node between evaluate and deliver).

## Global Constraints

- strands-agents 1.52.0 requires unique agent instances per node (no duplicate executors)
- `EvaluatorNode` defaults to `max_iterations=2`; changelog evaluator follows same pattern
- Writer nodes are denied mutation tools (`write_file`, `create_branch`, etc.) — changelog agent follows same restriction
- `needs_revision_of(node_id)` must be scoped to the specific node to avoid firing both revise edges
- `max_node_executions=10` — adding 2 nodes (changelog + changelog_evaluate) increases worst-case from 11 to 15; raise to 15
- All dates use ISO 8601 (`YYYY-MM-DD`)
- Changelog format follows Keep a Changelog v2.0.0

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/draftly/agents/schemas.py` | Modify | Add `ChangelogEntry` schema |
| `src/draftly/agents/prompts.py` | Modify | Add `CHANGELOG_PROMPT`, `DELIVERY_PROMPT` update |
| `src/draftly/agents/documentation/changelog.py` | Create | Changelog agent factory |
| `src/draftly/orchestration/nodes/changelog_evaluate.py` | Create | Changelog format evaluator node |
| `src/draftly/orchestration/routing/conditions.py` | Modify | Add `none_and_release`, `generated_changelog`, `changelog_needs_revision`, `changelog_eval_passed` |
| `src/draftly/orchestration/graphs/documentation_graph.py` | Modify | Wire changelog nodes and edges |
| `src/draftly/evaluation/online.py` | Modify | Add `release` surface + `build_event` branch |
| `src/draftly/evaluation/datasets/release.json` | Create | 3 release evaluation cases |
| `src/draftly/workflows/evaluation/documentation_evaluation.py` | Modify | Add `"release": "documentation"` mapping |
| `authly-scenarios/*/CHANGELOG.md` | Create | Seed empty Keep a Changelog preambles |
| `tests/nodes/test_changelog_evaluate.py` | Create | Changelog evaluator unit tests |
| `tests/conditions/test_conditions.py` | Modify | Add tests for new conditions |
| `tests/graph/test_documentation_graph.py` | Modify | Add release event graph tests |
| `tests/graph/conftest.py` | Modify | Add `RELEASE_TASK` fixture and `ChangelogEntry` to stub |

---

### Task 1: ChangelogEntry Schema

**Files:**
- Modify: `src/draftly/agents/schemas.py:40-51`
- Test: `tests/unit/test_schemas.py` (or inline in existing test)

**Interfaces:**
- Consumes: nothing (foundation)
- Produces: `ChangelogEntry` Pydantic model used by changelog agent and evaluator

- [ ] **Step 1: Add ChangelogEntry to schemas.py**

Append after `DocChangePlan` (line 51):

```python
class ChangelogEntry(BaseModel):
    """A changelog entry for a single release version."""

    version: str = Field(description="Version tag, e.g. v2.0.0")
    date: str = Field(description="ISO 8601 date, e.g. 2026-09-04")
    entries: list[dict[str, str]] = Field(
        default_factory=list,
        description="[{category, text}] - category is Added/Changed/Deprecated/Removed/Fixed/Security",
    )
    raw_markdown: str = Field(
        description="The complete markdown section to prepend to CHANGELOG.md",
    )
```

- [ ] **Step 2: Verify schema imports cleanly**

Run: `cd draftly-agent-backend && python -c "from draftly.agents.schemas import ChangelogEntry; print(ChangelogEntry.model_fields.keys())"`
Expected: `dict_keys(['version', 'date', 'entries', 'raw_markdown'])`

- [ ] **Step 3: Commit**

```bash
git add src/draftly/agents/schemas.py
git commit -m "feat(schemas): add ChangelogEntry model for release changelog generation"
```

---

### Task 2: Routing Conditions

**Files:**
- Modify: `src/draftly/orchestration/routing/conditions.py`
- Modify: `tests/conditions/test_conditions.py`

**Interfaces:**
- Consumes: `GraphState` with `impact` result and task JSON
- Produces: four new condition functions used by graph wiring

- [ ] **Step 1: Write failing tests for new conditions**

Append to `tests/conditions/test_conditions.py`:

```python
from draftly.orchestration.routing.conditions import (
    none_and_release,
    generated_changelog,
    changelog_needs_revision,
    changelog_eval_passed,
)


def _changelog_result(version: str = "v1.0.0") -> MultiAgentResult:
    return MultiAgentResult(
        status=Status.COMPLETED,
        results={
            "changelog": NodeResult(
                result=agent_result({
                    "version": version,
                    "date": "2026-09-04",
                    "entries": [{"category": "Added", "text": "Feature X"}],
                    "raw_markdown": "## [v1.0.0] - 2026-09-04\n\n### Added\n- Feature X.",
                }),
            )
        },
    )


def _changelog_eval_result(passed: bool) -> MultiAgentResult:
    return MultiAgentResult(
        status=Status.COMPLETED,
        results={
            "changelog_evaluate": NodeResult(
                result=agent_result({"passed": passed, "score": 0.9 if passed else 0.3}),
            )
        },
    )


class TestNoneAndRelease:
    def test_none_with_release_event(self) -> None:
        state = _state_with_results({"impact": _impact_result("none")})
        state.task = json.dumps({"event_type": "release.published"})
        assert none_and_release(state)

    def test_none_with_pr_event_is_false(self) -> None:
        state = _state_with_results({"impact": _impact_result("none")})
        state.task = json.dumps({"event_type": "pull_request.merged"})
        assert not none_and_release(state)

    def test_update_with_release_event_is_false(self) -> None:
        state = _state_with_results({"impact": _impact_result("update")})
        state.task = json.dumps({"event_type": "release.published"})
        assert not none_and_release(state)

    def test_missing_impact_is_safe(self) -> None:
        state = GraphState(task=json.dumps({"event_type": "release.published"}))
        assert not none_and_release(state)


class TestGeneratedChangelog:
    def test_changelog_present(self) -> None:
        state = _state_with_results({"changelog": _changelog_result()})
        assert generated_changelog(state)

    def test_changelog_absent(self) -> None:
        state = _state_with_results({"update": _impact_result("update")})
        assert not generated_changelog(state)


class TestChangelogNeedsRevision:
    def test_changelog_eval_failed(self) -> None:
        state = _state_with_results({
            "changelog": _changelog_result(),
            "changelog_evaluate": _changelog_eval_result(False),
        })
        assert changelog_needs_revision(state)

    def test_changelog_eval_passed(self) -> None:
        state = _state_with_results({
            "changelog": _changelog_result(),
            "changelog_evaluate": _changelog_eval_result(True),
        })
        assert not changelog_needs_revision(state)

    def test_missing_changelog_eval_is_safe(self) -> None:
        state = GraphState()
        assert not changelog_needs_revision(state)


class TestChangelogEvalPassed:
    def test_passed(self) -> None:
        state = _state_with_results({
            "changelog_evaluate": _changelog_eval_result(True),
        })
        assert changelog_eval_passed(state)

    def test_failed(self) -> None:
        state = _state_with_results({
            "changelog_evaluate": _changelog_eval_result(False),
        })
        assert not changelog_eval_passed(state)

    def test_missing_is_safe(self) -> None:
        state = GraphState()
        assert not changelog_eval_passed(state)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/conditions/test_conditions.py -v -k "NoneAndRelease or GeneratedChangelog or ChangelogNeedsRevision or ChangelogEvalPassed"`
Expected: FAIL with ImportError (functions don't exist yet)

- [ ] **Step 3: Implement the four conditions**

Append to `src/draftly/orchestration/routing/conditions.py`:

```python
def none_and_release(state: GraphState) -> bool:
    """Impact chose 'none' but the event is a release — still need a changelog."""
    if "impact" not in state.results:
        return False
    data = safe_node_data(state, "impact")
    if data is None or data.get("action") != "none":
        return False
    task_data = json.loads(state.task) if isinstance(state.task, str) else {}
    return task_data.get("event_type", "").startswith("release")


def generated_changelog(state: GraphState) -> bool:
    """The changelog node has produced output."""
    return "changelog" in state.results


def changelog_needs_revision(state: GraphState) -> bool:
    """Changelog evaluator ran and the output did not pass."""
    if "changelog_evaluate" not in state.results:
        return False
    data = safe_node_data(state, "changelog_evaluate")
    if data is None or data["passed"]:
        return False
    return "changelog" in state.results


def changelog_eval_passed(state: GraphState) -> bool:
    """Changelog evaluator ran and the output passed."""
    if "changelog_evaluate" not in state.results:
        return False
    data = safe_node_data(state, "changelog_evaluate")
    return data is not None and data["passed"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && python -m pytest tests/conditions/test_conditions.py -v -k "NoneAndRelease or GeneratedChangelog or ChangelogNeedsRevision or ChangelogEvalPassed"`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/orchestration/routing/conditions.py tests/conditions/test_conditions.py
git commit -m "feat(conditions): add changelog routing conditions (none_and_release, generated_changelog, etc.)"
```

---

### Task 3: Changelog Prompt

**Files:**
- Modify: `src/draftly/agents/prompts.py`

**Interfaces:**
- Consumes: `ChangelogEntry` schema for output contract
- Produces: `CHANGELOG_PROMPT` constant used by changelog agent factory

- [ ] **Step 1: Add CHANGELOG_PROMPT**

Append to `src/draftly/agents/prompts.py` after `MEMORY_CURATOR_PROMPT` (at end of file, line 872):

```python
CHANGELOG_PROMPT = """You are a changelog editor. Given a release event and its notes,
produce a Keep a Changelog v2.0.0 entry for CHANGELOG.md.

## Steps

1. Read the existing CHANGELOG.md via read_file. If it doesn't exist, start with
   the standard preamble:
   ```
   # Changelog

   All notable changes to this project will be documented in this file.

   The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
   and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
   ```
2. Parse the release notes for: breaking changes, new features, deprecations,
   bug fixes, security patches.
3. Classify each change into one of six categories: Added, Changed, Deprecated,
   Removed, Fixed, Security.
4. Format the entry following Keep a Changelog v2.0.0:
   - Version header: `## [X.Y.Z] - YYYY-MM-DD`
   - Group changes under `### Category` headers
   - Mark breaking changes with `**Breaking:**` prefix
   - Use plain language, no jargon
   - One bullet per change item
5. Output a ChangelogEntry with the raw_markdown field containing the complete
   section to prepend below the preamble and above the first existing version.

## Rules

- Only include user-facing changes. Skip internal/CI/test/chore changes.
- If the release has no notable changes, output a minimal entry:
  `## [X.Y.Z] - YYYY-MM-DD\n\nMaintenance release with no user-facing changes.`
- Never duplicate an entry that already exists for this version in the existing
  CHANGELOG.md.
- If CHANGELOG.md already has this version, update it in place rather than
  adding a duplicate.
- The six categories are: Added, Changed, Deprecated, Removed, Fixed, Security.
  Do not invent new categories.
- Write plainly. Many readers are not native speakers.

Output contract:
{output_contract}
"""
```

- [ ] **Step 2: Verify prompt imports**

Run: `cd draftly-agent-backend && python -c "from draftly.agents.prompts import CHANGELOG_PROMPT; print(len(CHANGELOG_PROMPT))"`
Expected: prints a positive integer (prompt length)

- [ ] **Step 3: Commit**

```bash
git add src/draftly/agents/prompts.py
git commit -m "feat(prompts): add CHANGELOG_PROMPT for release changelog generation"
```

---

### Task 4: Changelog Agent Factory

**Files:**
- Create: `src/draftly/agents/documentation/changelog.py`
- Test: `tests/agents/test_changelog_agent.py`

**Interfaces:**
- Consumes: `model` (any strands Model), `tools` (scoped read-only tools), `CHANGELOG_PROMPT`, `ChangelogEntry`
- Produces: `build_changelog_agent(model, tools) -> Agent` function

- [ ] **Step 1: Write the agent factory**

Create `src/draftly/agents/documentation/changelog.py`:

```python
"""Documentation changelog agent (``changelog`` node)."""

from __future__ import annotations

from typing import Any

from strands import Agent

from draftly.agents.prompts import CHANGELOG_PROMPT, build_prompt
from draftly.agents.schemas import ChangelogEntry


def build_changelog_agent(
    model: Any,
    tools: list[Any],
) -> Agent:
    """Build the changelog generation agent.

    Same tool restrictions as the doc writer: read/analyze only, no mutation.
    """

    return Agent(
        name="changelog_writer",
        system_prompt=build_prompt(
            CHANGELOG_PROMPT,
            output_model=ChangelogEntry,
        ),
        model=model,
        tools=tools,
        structured_output_model=ChangelogEntry,
        description="Generates Keep a Changelog entries for release events.",
    )
```

- [ ] **Step 2: Write agent factory test**

Create `tests/agents/test_changelog_agent.py`:

```python
"""Changelog agent factory produces a valid Agent with correct constraints."""

from __future__ import annotations

from draftly.agents.documentation.changelog import build_changelog_agent
from draftly.agents.schemas import ChangelogEntry


def test_changelog_agent_uses_changelog_entry_schema() -> None:
    from tests.stub_model import StubModel

    model = StubModel(
        structured_outputs={
            ChangelogEntry: {
                "version": "v1.0.0",
                "date": "2026-09-04",
                "entries": [{"category": "Added", "text": "Feature X"}],
                "raw_markdown": "## [v1.0.0] - 2026-09-04\n\n### Added\n- Feature X.",
            }
        }
    )
    agent = build_changelog_agent(model, [])
    assert agent.name == "changelog_writer"
    assert agent.structured_output_model is ChangelogEntry


def test_changelog_agent_tools_are_scoped() -> None:
    """Changelog agent must not receive mutation tools."""
    from tests.stub_model import StubModel

    model = StubModel()
    # Pass empty tools list — agent should still build
    agent = build_changelog_agent(model, [])
    assert agent is not None
```

- [ ] **Step 3: Run test**

Run: `cd draftly-agent-backend && python -m pytest tests/agents/test_changelog_agent.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/draftly/agents/documentation/changelog.py tests/agents/test_changelog_agent.py
git commit -m "feat(agents): add changelog agent factory"
```

---

### Task 5: Changelog Evaluator Node

**Files:**
- Create: `src/draftly/orchestration/nodes/changelog_evaluate.py`
- Create: `tests/nodes/test_changelog_evaluate.py`

**Interfaces:**
- Consumes: `ChangelogEntry` output from changelog node (via `parse_node_input`)
- Produces: `MultiAgentResult` with `{passed, score, reasons, iteration}` payload

- [ ] **Step 1: Write failing tests**

Create `tests/nodes/test_changelog_evaluate.py`:

```python
"""ChangelogEvaluatorNode validates changelog format and content."""

from __future__ import annotations

import json

import pytest
from strands.agent.agent_result import AgentResult

from draftly.orchestration.nodes.base import parse_node_input
from draftly.orchestration.nodes.changelog_evaluate import (
    ChangelogEvaluatorNode,
    compute_changelog_quality,
)


def _changelog_blocks(
    raw_markdown: str,
    *,
    version: str = "v1.0.0",
    date: str = "2026-09-04",
) -> list[dict]:
    entry = {
        "version": version,
        "date": date,
        "entries": [{"category": "Added", "text": "Feature"}],
        "raw_markdown": raw_markdown,
    }
    return [
        {"text": "Original Task: task"},
        {"text": "\nInputs from previous nodes:"},
        {"text": "\nFrom changelog:"},
        {"text": f"  - changelog_writer: {json.dumps(entry)}"},
    ]


class TestComputeChangelogQuality:
    def test_valid_entry_passes(self) -> None:
        md = "## [v1.0.0] - 2026-09-04\n\n### Added\n- New OAuth support.\n"
        score, reasons = compute_changelog_quality(md)
        assert score >= 0.7
        assert any("format" in r.lower() or "valid" in r.lower() for r in reasons)

    def test_missing_version_header_fails(self) -> None:
        md = "### Added\n- New feature.\n"
        score, reasons = compute_changelog_quality(md)
        assert score < 0.7

    def test_missing_category_header_fails(self) -> None:
        md = "## [v1.0.0] - 2026-09-04\n\n- New feature.\n"
        score, reasons = compute_changelog_quality(md)
        assert score < 0.7

    def test_invalid_category_fails(self) -> None:
        md = "## [v1.0.0] - 2026-09-04\n\n### Improvements\n- Faster.\n"
        score, reasons = compute_changelog_quality(md)
        assert score < 0.7

    def test_non_iso_date_fails(self) -> None:
        md = "## [v1.0.0] - 09/04/2026\n\n### Added\n- Feature.\n"
        score, reasons = compute_changelog_quality(md)
        assert score < 0.7

    def test_empty_markdown_fails(self) -> None:
        score, reasons = compute_changelog_quality("")
        assert score == 0.0

    def test_breaking_change_marked(self) -> None:
        md = (
            "## [v2.0.0] - 2026-09-04\n\n"
            "### Changed\n"
            "- **Breaking:** Removed legacy API endpoint.\n"
        )
        score, reasons = compute_changelog_quality(md)
        assert score >= 0.7
        assert any("breaking" in r.lower() for r in reasons)


class TestChangelogEvaluatorNode:
    @pytest.mark.asyncio
    async def test_passing_entry(self) -> None:
        md = "## [v1.0.0] - 2026-09-04\n\n### Added\n- New OAuth support.\n"
        node = ChangelogEvaluatorNode()
        result = await node.invoke_async(_changelog_blocks(md))
        node_result = result.results["changelog_evaluate"].result
        assert isinstance(node_result, AgentResult)
        data = json.loads(node_result.message["content"][0]["text"])
        assert data["passed"] is True
        assert data["score"] >= 0.7
        assert data["iteration"] == 1

    @pytest.mark.asyncio
    async def test_failing_entry_then_cap(self) -> None:
        node = ChangelogEvaluatorNode(max_iterations=2)
        blocks = _changelog_blocks("bad format")

        first = await node.invoke_async(blocks)
        first_data = json.loads(
            first.results["changelog_evaluate"].result.message["content"][0]["text"]
        )
        assert first_data["passed"] is False

        second = await node.invoke_async(blocks)
        second_data = json.loads(
            second.results["changelog_evaluate"].result.message["content"][0]["text"]
        )
        assert second_data["passed"] is True  # iteration >= max_iterations
        assert second_data["iteration"] == 2

    @pytest.mark.asyncio
    async def test_empty_changelog_input(self) -> None:
        """No changelog node output → score 0, still completes."""
        blocks = [
            {"text": "Original Task: task"},
            {"text": "\nInputs from previous nodes:"},
        ]
        node = ChangelogEvaluatorNode()
        result = await node.invoke_async(blocks)
        data = json.loads(
            result.results["changelog_evaluate"].result.message["content"][0]["text"]
        )
        assert data["passed"] is False
        assert data["score"] == 0.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/nodes/test_changelog_evaluate.py -v`
Expected: FAIL with ImportError

- [ ] **Step 3: Implement ChangelogEvaluatorNode**

Create `src/draftly/orchestration/nodes/changelog_evaluate.py`:

```python
"""Deterministic quality gate for changelog entries."""

from __future__ import annotations

import json
import re
from typing import Any

from strands.multiagent.base import (
    MultiAgentBase,
    MultiAgentResult,
    NodeResult,
    Status,
)

from draftly.orchestration.nodes.base import agent_result, parse_node_input

_VALID_CATEGORIES = {"added", "changed", "deprecated", "removed", "fixed", "security"}
_VERSION_RE = re.compile(r"^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}", re.MULTILINE)
_CATEGORY_RE = re.compile(r"^### (\w+)", re.MULTILINE)
_ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_BREAKING_RE = re.compile(r"\*\*breaking\*\*", re.IGNORECASE)


def compute_changelog_quality(raw_markdown: str) -> tuple[float, list[str]]:
    """Score a changelog entry on format validity and content quality."""
    if not raw_markdown or not raw_markdown.strip():
        return 0.0, ["Empty changelog entry"]

    reasons: list[str] = []
    score = 0.0

    # Format checks (60%):
    # 1. Has version header matching ## [X.Y.Z] - YYYY-MM-DD (20%)
    has_version_header = bool(_VERSION_RE.search(raw_markdown))
    if has_version_header:
        score += 0.2
        reasons.append("Valid version header")
    else:
        reasons.append("Missing or malformed version header (expected: ## [X.Y.Z] - YYYY-MM-DD)")

    # 2. Has at least one valid category header (20%)
    category_matches = _CATEGORY_RE.findall(raw_markdown)
    valid_categories = [c for c in category_matches if c.lower() in _VALID_CATEGORIES]
    if valid_categories:
        score += 0.2
        reasons.append(f"Valid categories: {', '.join(valid_categories)}")
    else:
        reasons.append(f"No valid categories found (expected one of: {', '.join(_VALID_CATEGORIES)})")

    # 3. Date is ISO 8601 (10%)
    has_iso_date = bool(_ISO_DATE_RE.search(raw_markdown))
    if has_iso_date:
        score += 0.1
        reasons.append("ISO 8601 date present")
    else:
        reasons.append("Missing ISO 8601 date")

    # 4. No invalid categories (10%)
    invalid_categories = [c for c in category_matches if c.lower() not in _VALID_CATEGORIES]
    if not invalid_categories:
        score += 0.1
        reasons.append("No invalid categories")
    else:
        reasons.append(f"Invalid categories: {', '.join(invalid_categories)}")

    # Content checks (40%):
    # 5. Has at least one bullet item per category (20%)
    bullet_count = len(re.findall(r"^[-*] ", raw_markdown, re.MULTILINE))
    if bullet_count >= 1:
        score += 0.2
        reasons.append(f"{bullet_count} change item(s)")
    else:
        reasons.append("No change items found")

    # 6. Breaking changes marked with **Breaking:** (10%)
    has_breaking = bool(_BREAKING_RE.search(raw_markdown))
    if has_breaking:
        score += 0.1
        reasons.append("Breaking changes properly marked")
    elif "changed" in [c.lower() for c in valid_categories]:
        # Only penalize if there's a Changed category (breaking changes go there)
        reasons.append("Changed category present but no **Breaking:** marker")

    # 7. Adequate length (10%)
    length_score = min(len(raw_markdown) / 100, 1.0)
    score += length_score * 0.1
    if length_score > 0.5:
        reasons.append("Adequate detail level")

    return score, reasons


class ChangelogEvaluatorNode(MultiAgentBase):
    """Deterministic quality gate for changelog entries."""

    def __init__(
        self,
        name: str = "changelog_evaluate",
        max_iterations: int = 2,
    ) -> None:
        self.name = name
        self.iteration = 0
        self.max_iterations = max_iterations

    async def invoke_async(
        self,
        task: Any,
        invocation_state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> MultiAgentResult:
        self.iteration += 1

        deps = parse_node_input(task)
        changelog_data = deps.get("changelog", {})
        raw_markdown = changelog_data.get("raw_markdown", "")

        score, reasons = compute_changelog_quality(raw_markdown)
        passed = score >= 0.7 or self.iteration >= self.max_iterations

        if not reasons:
            reasons.append(f"Score {score:.2f} (threshold: 0.70)")

        return MultiAgentResult(
            status=Status.COMPLETED,
            results={
                self.name: NodeResult(
                    result=agent_result(
                        {
                            "passed": passed,
                            "score": score,
                            "reasons": reasons,
                            "iteration": self.iteration,
                        }
                    )
                )
            },
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && python -m pytest tests/nodes/test_changelog_evaluate.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/orchestration/nodes/changelog_evaluate.py tests/nodes/test_changelog_evaluate.py
git commit -m "feat(nodes): add ChangelogEvaluatorNode for changelog format validation"
```

---

### Task 6: Graph Wiring

**Files:**
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py`
- Modify: `tests/graph/test_documentation_graph.py`
- Modify: `tests/graph/conftest.py`

**Interfaces:**
- Consumes: `build_changelog_agent`, `ChangelogEvaluatorNode`, new conditions
- Produces: updated graph with changelog nodes wired between evaluate and deliver

- [ ] **Step 1: Add RELEASE_TASK and ChangelogEntry to conftest**

In `tests/graph/conftest.py`, add to imports:

```python
from draftly.agents.schemas import (
    AnswerDraft,
    ChangelogEntry,
    DeliveryReceipt,
    DocChangePlan,
    EventClassification,
    EvidenceBundle,
    ImpactAnalysis,
)
```

Add after `SUPPORT_TASK`:

```python
RELEASE_TASK = (
    '{"event_id": "r-123", "event_type": "release.published", '
    '"project_id": "proj-1", "repository": "TheGreatBonnie/authly", "actor": "dev", '
    '"release": {"tag_name": "v2.0.0", "name": "v2.0.0", "body": "Added OAuth support.", '
    '"html_url": "https://github.com/TheGreatBonnie/authly/releases/tag/v2.0.0"}}'
)
```

Add `ChangelogEntry` to the `stub_model()` structured_outputs:

```python
ChangelogEntry: {
    "version": "v2.0.0",
    "date": "2026-09-04",
    "entries": [{"category": "Added", "text": "OAuth support."}],
    "raw_markdown": "## [v2.0.0] - 2026-09-04\n\n### Added\n- OAuth support.\n",
},
```

- [ ] **Step 2: Write failing graph test for release event**

Append to `tests/graph/test_documentation_graph.py`:

```python
async def test_release_event_includes_changelog_in_order(model, tools, tmp_sessions) -> None:
    """Release event: classify → context → research → impact → update → evaluate
    → changelog → changelog_evaluate → deliver."""
    graph = build_graph_for_run(
        "e2e-release-1",
        surface="pull_request",  # releases route to pull_request surface
        tools_registry=tools,
        model=model,
        storage_dir=tmp_sessions,
    )

    result = await graph.invoke_async(
        RELEASE_TASK,
        invocation_state={"run_id": "e2e-release-1", "review_policy": "never"},
    )

    assert result.status == Status.COMPLETED
    order = [n.node_id for n in result.execution_order]
    # changelog and changelog_evaluate must appear after evaluate, before deliver
    eval_idx = order.index("evaluate")
    deliver_idx = order.index("deliver")
    assert "changelog" in order
    assert "changelog_evaluate" in order
    changelog_idx = order.index("changelog")
    changelog_eval_idx = order.index("changelog_evaluate")
    assert eval_idx < changelog_idx < changelog_eval_idx < deliver_idx


async def test_none_action_release_routs_to_changelog(model, tools, tmp_sessions) -> None:
    """action='none' on a release event skips writer but still runs changelog."""
    from draftly.agents.schemas import ImpactAnalysis

    model._structured_outputs[ImpactAnalysis] = {
        "action": "none",
        "affected_documents": [],
        "rationale": "maintenance release",
    }

    graph = build_graph_for_run(
        "e2e-release-none",
        surface="pull_request",
        tools_registry=tools,
        model=model,
        storage_dir=tmp_sessions,
    )

    result = await graph.invoke_async(
        RELEASE_TASK,
        invocation_state={"run_id": "e2e-release-none", "review_policy": "never"},
    )

    assert result.status == Status.COMPLETED
    order = [n.node_id for n in result.execution_order]
    assert "impact" in order
    # No writer nodes
    for node in ("answer", "update", "create", "evaluate"):
        assert node not in order
    # Changelog still runs
    assert "changelog" in order
    assert "changelog_evaluate" in order
    assert "deliver" in order
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd draftly-agent-backend && python -m pytest tests/graph/test_documentation_graph.py -v -k "release"`
Expected: FAIL (changelog nodes not wired yet)

- [ ] **Step 4: Wire changelog nodes into documentation_graph.py**

In `src/draftly/orchestration/graphs/documentation_graph.py`:

Add imports:

```python
from draftly.orchestration.routing.conditions import (
    changelog_eval_passed,
    changelog_needs_revision,
    eval_passed,
    generated,
    generated_changelog,
    is_valid_surface,
    needs_revision_of,
    none_and_release,
    route_to_answer,
    route_to_create,
    route_to_update,
)
```

After the imports, update `DEFAULT_MAX_NODE_EXECUTIONS`:

```python
DEFAULT_MAX_NODE_EXECUTIONS = 15  # raised from 10 for changelog nodes
```

Inside `build_documentation_graph`, after building the delivery agent, add:

```python
from draftly.agents.documentation.changelog import build_changelog_agent
from draftly.orchestration.nodes.changelog_evaluate import ChangelogEvaluatorNode

changelog_agent = build_changelog_agent(
    writer_model,
    _scope_writer_tools(reg.documentation_engineer, reg.documentation),
)
changelog_evaluator = ChangelogEvaluatorNode("changelog_evaluate", max_iterations=evaluator_max_iterations)
```

**IMPORTANT:** The existing `evaluate → deliver` edge (line 239) must be **removed**. Replace it with the changelog path below. The new edges are:

```python
    # Changelog generation (runs for every release event)
    builder.add_node(changelog_agent, "changelog")
    builder.add_node(changelog_evaluator, "changelog_evaluate")

    # Normal path: docs evaluated → changelog → changelog evaluated → deliver
    builder.add_edge("evaluate", "changelog", condition=eval_passed)
    builder.add_edge("changelog", "changelog_evaluate", condition=generated_changelog)

    # No-docs release path: impact none + release → changelog (skips writer/evaluate)
    builder.add_edge("impact", "changelog", condition=none_and_release)

    # Changelog revision loop
    builder.add_edge("changelog_evaluate", "changelog", condition=changelog_needs_revision)

    # Changelog passes → deliver
    builder.add_edge("changelog_evaluate", "deliver", condition=changelog_eval_passed)
```

The final graph layout becomes::

    classify → context → research(Swarm) → impact
      ├─(answer)─► answer ─┐
      ├─(update)─► update ─┤
      ├─(create)─► create ─┴─► evaluate ─(passed)──► changelog ─► changelog_evaluate ──► deliver
      │                                                    ▲              │
      │                                                    └──────────────┘
      └─(none_and_release)──────────────────────────────────► changelog ...

- [ ] **Step 5: Run graph tests**

Run: `cd draftly-agent-backend && python -m pytest tests/graph/test_documentation_graph.py -v`
Expected: all PASS (including new release tests)

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `cd draftly-agent-backend && python -m pytest tests/ -v --timeout=60`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/draftly/orchestration/graphs/documentation_graph.py tests/graph/test_documentation_graph.py tests/graph/conftest.py
git commit -m "feat(graph): wire changelog and changelog_evaluate nodes into documentation graph"
```

---

### Task 7: Delivery Two-Commit Support

**Files:**
- Modify: `src/draftly/agents/prompts.py` (DELIVERY_PROMPT update)
- Modify: `tests/graph/test_documentation_graph.py`

**Interfaces:**
- Consumes: `ChangelogEntry.raw_markdown` from changelog_evaluate output
- Produces: delivery agent makes two commits (docs + changelog) on one branch

- [ ] **Step 1: Update DELIVERY_PROMPT**

In `src/draftly/agents/prompts.py`, find `DELIVERY_PROMPT` (line 830) and replace it entirely. The existing prompt is short — replace with the version that includes changelog instructions:

```python
DELIVERY_PROMPT = """You deliver the final output: open a docs PR, post a reply, or send a
message, according to the surface. Respect repository rules and any human
review gates before delivering.

## Changelog deliveries

When you receive a changelog entry alongside a documentation plan, make TWO
commits on the same branch:

1. First commit: the documentation files from the DocChangePlan
   - Commit message: the DocChangePlan's commit_message
2. Second commit: the CHANGELOG.md file
   - Commit message: "docs(release): add <version> changelog entry"

Then open ONE pull request containing both commits. The PR title should
reference both the docs update and the changelog entry.

If you receive ONLY a changelog entry (no documentation plan), make one
commit with the CHANGELOG.md and open a PR.

Output contract:
{output_contract}

{repository_rules}

{human_review_policy}
"""
```

- [ ] **Step 2: Verify prompt compiles**

Run: `cd draftly-agent-backend && python -c "from draftly.agents.prompts import DELIVERY_PROMPT; print(len(DELIVERY_PROMPT))"`
Expected: prints a positive integer

- [ ] **Step 3: Commit**

```bash
git add src/draftly/agents/prompts.py
git commit -m "feat(prompts): update DELIVERY_PROMPT for two-commit changelog delivery"
```

---

### Task 8: Evaluation Dataset and Surface Mapping

**Files:**
- Create: `src/draftly/evaluation/datasets/release.json`
- Modify: `src/draftly/evaluation/online.py`
- Modify: `src/draftly/workflows/evaluation/documentation_evaluation.py`

**Interfaces:**
- Consumes: existing evaluation harness patterns (from `documentation.json`)
- Produces: `release.json` dataset, `release` surface in `SURFACE_EVENT_TYPES`, mapping in `SURFACE_TO_EVALUATION_TYPE`

- [ ] **Step 1: Create release.json dataset**

Create `src/draftly/evaluation/datasets/release.json`:

```json
[
  {
    "name": "release",
    "description": "Golden release-authoring cases: release.published events whose notes require changelog generation and optionally documentation updates",
    "surface": "release",
    "required_tools": {
      "context": [
        "read_file",
        "list_directory",
        "git_status",
        "git_diff",
        "file_exists"
      ],
      "research": [
        "read_file",
        "git_status",
        "git_log",
        "git_diff",
        "code_search",
        "file_exists"
      ],
      "impact": [
        "semantic_search",
        "keyword_search",
        "hybrid_search",
        "code_search",
        "ImpactAnalysis"
      ]
    },
    "cases": [
      {
        "name": "minor-release-update",
        "input": "Release v1.1.0: Added PKCE support for OAuth flows. Fixed token refresh race condition.",
        "expected_output": "Changelog entry with Added and Fixed sections. Documentation updated for PKCE.",
        "metadata": {
          "surface": "release",
          "event_type": "release.published",
          "repository": "TheGreatBonnie/authly",
          "project_id": "proj_demo",
          "org_id": "org_3IfMDevV4Tg8DLD8Ljc0GG6c2GJ",
          "repo_dir": "/Applications/Projects/hackathon/draftly-docs-engineer/authly-scenarios/002-pkce",
          "tag_name": "v1.1.0",
          "changed_files": [
            {
              "path": "src/authly/oauth.py",
              "change": "added PKCE code challenge/verifier support"
            }
          ],
          "evidence": [
            {
              "id": "docs/how-to/pkce",
              "topic": "pkce",
              "url": "authly/docs/how-to/pkce.md"
            }
          ],
          "expected_tools": ["read_file"],
          "expected_action": "update"
        }
      },
      {
        "name": "breaking-major-release",
        "input": "Release v2.0.0: BREAKING: Removed API key authentication. Migrate to OAuth. Added RBAC with organization scoping.",
        "expected_output": "Changelog entry with Changed (Breaking) and Added sections. Migration guide created.",
        "metadata": {
          "surface": "release",
          "event_type": "release.published",
          "repository": "TheGreatBonnie/authly",
          "project_id": "proj_demo",
          "org_id": "org_3IfMDevV4Tg8DLD8Ljc0GG6c2GJ",
          "repo_dir": "/Applications/Projects/hackathon/draftly-docs-engineer/authly-scenarios/003-api-key-deprecation",
          "tag_name": "v2.0.0",
          "changed_files": [
            {
              "path": "src/authly/auth.py",
              "change": "removed API key authentication"
            },
            {
              "path": "src/authly/permissions.py",
              "change": "added RBAC organization scoping"
            }
          ],
          "evidence": [
            {
              "id": "docs/topics/authentication",
              "topic": "authentication",
              "url": "authly/docs/topics/authentication.md"
            },
            {
              "id": "docs/how-to/rbac",
              "topic": "rbac",
              "url": "authly/docs/how-to/rbac.md"
            }
          ],
          "expected_tools": ["read_file"],
          "expected_action": "create"
        }
      },
      {
        "name": "maintenance-release-no-docs",
        "input": "Release v1.0.1: Fixed typo in error message. Updated dependency versions.",
        "expected_output": "Changelog entry with Fixed section only. No documentation changes.",
        "metadata": {
          "surface": "release",
          "event_type": "release.published",
          "repository": "TheGreatBonnie/authly",
          "project_id": "proj_demo",
          "org_id": "org_3IfMDevV4Tg8DLD8Ljc0GG6c2GJ",
          "repo_dir": "/Applications/Projects/hackathon/draftly-docs-engineer/authly-scenarios/001-oauth-login",
          "tag_name": "v1.0.1",
          "changed_files": [],
          "evidence": [],
          "expected_tools": ["read_file"],
          "expected_action": "none"
        }
      }
    ]
  }
]
```

- [ ] **Step 2: Add release surface to online.py**

In `src/draftly/evaluation/online.py`, update `SURFACE_EVENT_TYPES` (line 23-27):

```python
SURFACE_EVENT_TYPES = {
    "pull_request": "pull_request.opened",
    "issue": "issues.opened",
    "support": "slack.message",
    "release": "release.published",
}
```

Add a `release` branch in `build_event()` after the `support` branch (after line 280):

```python
    elif surface == "release":
        release = {
            "tag_name": metadata.get("tag_name", "v0.0.0"),
            "name": question,
            "body": question,
        }
        repo_dir = metadata.get("repo_dir")
        if repo_dir:
            release["repo_dir"] = repo_dir
        evidence = metadata.get("evidence") or []
        if evidence:
            release["evidence"] = list(evidence)
        changed_paths = metadata.get("changed_files") or []
        if changed_paths:
            release["changed_files"] = [
                f["path"] if isinstance(f, dict) else str(f) for f in changed_paths
            ]
        base["release"] = release
```

- [ ] **Step 3: Add release mapping to documentation_evaluation.py**

In `src/draftly/workflows/evaluation/documentation_evaluation.py`, update `SURFACE_TO_EVALUATION_TYPE` (line 38-43):

```python
SURFACE_TO_EVALUATION_TYPE = {
    "pull_request": "documentation",
    "documentation": "documentation",
    "issue": "github_issue",
    "support": "support",
    "release": "documentation",
}
```

- [ ] **Step 4: Verify dataset loads**

Run: `cd draftly-agent-backend && python -c "import json; d = json.load(open('src/draftly/evaluation/datasets/release.json')); print(len(d[0]['cases']), 'cases')"`
Expected: `3 cases`

- [ ] **Step 5: Commit**

```bash
git add src/draftly/evaluation/datasets/release.json src/draftly/evaluation/online.py src/draftly/workflows/evaluation/documentation_evaluation.py
git commit -m "feat(evaluation): add release dataset, surface mapping, and build_event branch"
```

---

### Task 9: Seed CHANGELOG.md in authly-scenarios

**Files:**
- Create: `authly-scenarios/001-oauth-login/CHANGELOG.md`
- Create: `authly-scenarios/002-pkce/CHANGELOG.md`
- Create: `authly-scenarios/003-api-key-deprecation/CHANGELOG.md`
- (repeat for all 10 scenarios)

**Interfaces:**
- Consumes: Keep a Changelog v2.0.0 format
- Produces: empty CHANGELOG.md files that the changelog agent can read and prepend to

- [ ] **Step 1: Create CHANGELOG.md in each scenario**

For each `authly-scenarios/00N-*/` directory, create `CHANGELOG.md` with:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
```

- [ ] **Step 2: Verify files exist**

Run: `ls authly-scenarios/*/CHANGELOG.md`
Expected: 10 files listed

- [ ] **Step 3: Commit**

```bash
git add authly-scenarios/*/CHANGELOG.md
git commit -m "feat(scenarios): seed CHANGELOG.md preambles in all authly-scenarios"
```

---

### Task 10: Integration Verification

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd draftly-agent-backend && python -m pytest tests/ -v --timeout=120`
Expected: all PASS

- [ ] **Step 2: Run sync evaluation with release dataset**

Run: `cd draftly-agent-backend && python scripts/run_evaluation.py --datasets src/draftly/evaluation/datasets/release.json`
Expected: completes without error, 3 cases scored

- [ ] **Step 3: Run linting/typecheck**

Run: `cd draftly-agent-backend && uv run ruff check src/draftly/ && uv run mypy src/draftly/agents/schemas.py src/draftly/agents/documentation/changelog.py src/draftly/orchestration/nodes/changelog_evaluate.py src/draftly/orchestration/routing/conditions.py`
Expected: no errors

- [ ] **Step 4: Final commit with any fixes**

```bash
git add -A
git commit -m "chore: changelog node integration fixes"
```
