# PR Workflow Error Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PR workflow degrade gracefully instead of aborting delivery when a requesty 402 disables the sole review-capable provider, Slack search uses the wrong token, local git tools run under github grounding, or an idempotency check stops delivery.

**Architecture:** Four independent, localized fixes (A–D). A adds a deterministic no-op grader when the reviewer model is unavailable (the rubric grader is enrichment-only; the deterministic gate stays the pass/fail signal) and registers non-requesty review/grade models so failover has a real candidate. B resolves the per-team/org installation bot token before calling Slack `search.messages`. C gates the writer tool list on the run's grounding mode so local git/fs tools never appear under github grounding. D stamps a deterministic `idempotency_key` before the policy check.

**Tech Stack:** Python 3.11, Strands Agents, pytest (pytest-asyncio), httpx.

**Spec:** `docs/superpowers/specs/2026-09-12-pr-workflow-error-hardening-design.md`

## Global Constraints

- Tests: `pytest draftly-agent-backend/tests/<path> -v` from the repository root.
- No new env vars; new model IDs resolve from new optional env names with stable defaults (`_resolve_model_id("X", default="...")`).
- Preserve existing guardrails: `EvaluatorNode`/`ChangelogEvaluatorNode` never see `None`; the builders now return a no-op grader instead.
- No breaking changes to `ToolRegistry`'s public field names.
- Run `graphify update .` (from repo root) at the end.

---

## Task 1: Deterministic no-op rubric grader + node acceptance

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/rubric_grader.py`
- Test: `draftly-agent-backend/tests/nodes/test_evaluator.py` (append)

**Ruling (pre-flight, ledger):** the evaluator node contracts stay untouched — `EvaluatorNode(rubric_grader=None)` must STILL raise `TypeError` (`TestRubricGraderRequired.test_constructor_requires_a_grader` enforces it). The degrade fix is confined to the grader builders, which are the only wiring path (`documentation_graph.py:155-158`, `issue_graph.py:89`, `support_graph.py:121` all call `build_docs_rubric_grader(grader_model, ...)` / `build_changelog_rubric_grader(grader_model)` with `grader_model` possibly `None` when the review role routes offline).

**Interfaces:**
- Consumes: `StrandsRubricGrader`, `RubricGrade`, `OutputEvaluator`, `EvaluatorNode`, `ChangelogEvaluatorNode`
- Produces: `DeterministicRubricGrader(RubricGrader)`; `build_docs_rubric_grader` / `build_changelog_rubric_grader` return it when `model is None`

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-backend/tests/nodes/test_evaluator.py`:

```python
from draftly.orchestration.nodes.changelog_evaluate import ChangelogEvaluatorNode
from draftly.orchestration.nodes.rubric_grader import (
    DeterministicRubricGrader,
    RubricGrade,
    build_changelog_rubric_grader,
    build_docs_rubric_grader,
)


def _task_block() -> list[dict]:
    return [{"text": "Original Task: task"}]


@pytest.mark.asyncio
async def test_deterministic_grader_returns_empty_grade():
    grade = await DeterministicRubricGrader().grade(draft="draft", evidence=[])
    assert grade == RubricGrade()


@pytest.mark.asyncio
async def test_build_docs_rubric_grader_returns_noop_when_model_none():
    grader = build_docs_rubric_grader(None, rubric="the rubric")
    assert isinstance(grader, DeterministicRubricGrader)
    assert await grader.grade(draft="x", evidence=[]) == RubricGrade()


@pytest.mark.asyncio
async def test_build_changelog_grader_returns_noop_when_model_none():
    grader = build_changelog_rubric_grader(None)
    assert isinstance(grader, DeterministicRubricGrader)


@pytest.mark.asyncio
async def test_evaluator_node_completes_with_noop_grader():
    node = EvaluatorNode(rubric_grader=DeterministicRubricGrader())
    result = await node.invoke_async(task=_task_block())
    assert result.status.name == "COMPLETED"


@pytest.mark.asyncio
async def test_changelog_node_completes_with_noop_grader():
    node = ChangelogEvaluatorNode(rubric_grader=DeterministicRubricGrader())
    result = await node.invoke_async(task=_task_block())
    assert result.status.name == "COMPLETED"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest draftly-agent-backend/tests/nodes/test_evaluator.py -v`
Expected: FAIL — `ImportError` (`DeterministicRubricGrader` missing). The existing `test_constructor_requires_a_grader` still passes (contract unchanged).

- [ ] **Step 3: Implement the no-op grader**

In `draftly-agent-backend/src/draftly/orchestration/nodes/rubric_grader.py`:

Insert `DeterministicRubricGrader` after the `RubricGrader` protocol (after line 43), leaving `RubricGrade` and `StrandsRubricGrader` unchanged:

```python
class DeterministicRubricGrader:
    """No-op grader that returns an empty grade instantly.

    Used when no LLM model is available (e.g. provider disabled by a
    402 payment failure).  The deterministic gate remains the pass/fail
    signal; this grader only exists so the evaluate nodes can always be
    wired to a real ``RubricGrader`` instance.
    """

    async def grade(self, *, draft: str, evidence: list[dict]) -> RubricGrade:
        return RubricGrade()
```

Replace `build_docs_rubric_grader` (lines 82-87):

```python
def build_docs_rubric_grader(model: Any, rubric: str) -> RubricGrader:
    """Build the docs-quality grader (groundedness + completeness judge).

    Degrades to a deterministic no-op grader when ``model`` is ``None``
    (e.g. the review provider is offline) so the evaluate node never
    crashes on a missing model.
    """
    if model is None:
        return DeterministicRubricGrader()
    return StrandsRubricGrader(
        OutputEvaluator(rubric=rubric, model=model),
        rubric=rubric,
    )
```

Replace `build_changelog_rubric_grader` (lines 90-95):

```python
def build_changelog_rubric_grader(model: Any) -> RubricGrader:
    """Build the changelog-quality grader (Keep a Changelog judge).

    Degrades to a deterministic no-op grader when ``model`` is ``None``.
    """
    if model is None:
        return DeterministicRubricGrader()
    return StrandsRubricGrader(
        OutputEvaluator(rubric=CHANGELOG_RUBRIC, model=model),
        rubric=CHANGELOG_RUBRIC,
    )
```

Keep `build_rubric_grader` and `evaluator_with_grader` unchanged.

- [ ] **Step 4: Do NOT touch the evaluator node contracts**

`EvaluatorNode` / `ChangelogEvaluatorNode` keep their mandatory-`rubric_grader` `TypeError` (pre-flight Ruling; existing test `test_constructor_requires_a_grader`). No edits to `evaluate.py` or `changelog_evaluate.py`.

- [ ] **Step 5: Run the tests**

Run: `pytest draftly-agent-backend/tests/nodes/test_evaluator.py -v`
Expected: All new tests PASS; existing tests (incl. `test_constructor_requires_a_grader`) still PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/nodes/rubric_grader.py \
        draftly-agent-backend/tests/nodes/test_evaluator.py
git commit -m "feat(grader): degrade to no-op rubric grader when provider offline"
```

---

## Task 2: Register orcarouter review/grade models + failover routing test

**Files:**
- Modify: `draftly-agent-backend/src/draftly/models/factory.py` (insert after `fast-orca-luna`, after line ~440)
- Test: `draftly-agent-backend/tests/unit/models/test_review_failover.py` (create)

**Interfaces:**
- Consumes: `ModelRegistry`, `ModelConfig`, `ProviderHealthRegistry`, `ModelRouter`, `RoutingPolicy`
- Produces: `review-orca` (provider `orcarouter`, `("verification", "tool_calling")`, priority 40) and `grader-orca` (provider `orcarouter`, `("evaluation", "tool_calling")`, priority 40)

- [ ] **Step 1: Write the failing tests**

Create `draftly-agent-backend/tests/unit/models/test_review_failover.py`:

```python
"""Non-requesty verification/evaluation models must exist so the reviewer
and rubric grader survive a requesty 402 payment failure."""

from unittest.mock import MagicMock

from draftly.models.config import ModelConfig
from draftly.models.factory import build_model_router
from draftly.models.health import ProviderHealthRegistry
from draftly.models.policies import RoutingPolicy
from draftly.models.registry import ModelRegistry
from draftly.models.router import ModelRouter


def test_factory_registers_review_and_grader_on_orca():
    router = build_model_router()
    models = {m.name: m for m in router.registry.list_models()}
    assert "review-orca" in models
    assert models["review-orca"].provider == "orcarouter"
    assert "verification" in models["review-orca"].capabilities
    assert "grader-orca" in models
    assert models["grader-orca"].provider == "orcarouter"
    assert "evaluation" in models["grader-orca"].capabilities


def _minimal_router() -> ModelRouter:
    reg = ModelRegistry()

    def provider(name: str) -> MagicMock:
        p = MagicMock()
        p.name = name
        p.create_model.side_effect = lambda config: f"MODEL-{config.provider}"
        return p

    reg.register_provider(provider("requesty"))
    reg.register_provider(provider("orcarouter"))

    for name, provider_name, caps, prio in (
        ("review-model", "requesty", ("verification", "tool_calling"), 30),
        ("stage-review", "requesty", ("verification", "tool_calling"), 50),
        ("review-orca", "orcarouter", ("verification", "tool_calling"), 40),
        ("grader-orca", "orcarouter", ("evaluation", "tool_calling"), 40),
    ):
        reg.register_model(
            ModelConfig(
                name=name,
                provider=provider_name,
                model_id=f"org/{name}",
                capabilities=caps,
                priority=prio,
            )
        )
    return ModelRouter(reg, ProviderHealthRegistry())


def test_review_fails_over_to_orca_when_requesty_disabled():
    router = _minimal_router()
    router.health.get("requesty").disable()
    model = router.resolve(
        RoutingPolicy(
            required_capabilities=("verification",),
            allow_fallback=True,
        )
    )
    assert model == "MODEL-orcarouter"


def test_grade_fails_over_to_orca_when_requesty_disabled():
    router = _minimal_router()
    router.health.get("requesty").disable()
    model = router.resolve(
        RoutingPolicy(
            required_capabilities=("evaluation",),
            allow_fallback=True,
        )
    )
    assert model == "MODEL-orcarouter"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest draftly-agent-backend/tests/unit/models/test_review_failover.py -v`
Expected: FAIL — `test_factory_registers_review_and_grader_on_orca` (no `review-orca` in registry) and `test_review_fails_over_to_orca_when_requesty_disabled` (resolve raises `APIStatusError` because there is no fallback yet).

- [ ] **Step 3: Register the models in the factory**

In `draftly-agent-backend/src/draftly/models/factory.py`, insert after the `fast-orca-luna` registration (after line ~440), before the Bedrock/Mantle section comment:

```python
    # Non-requesty verification/evaluation models so review and rubric
    # grading survive a requesty 402 (payment) disable. Priorities sit
    # below the requesty stage models so requesty is preferred while healthy.
    registry.register_model(
        ModelConfig(
            name="review-orca",
            provider="orcarouter",
            model_id=_resolve_model_id(
                "REVIEW_ORCA_MODEL",
                "ORCA_DEEPSEEK_V4_FLASH_MODEL",
                default="deepseek/deepseek-v4-flash",
            ),
            capabilities=(
                "verification",
                "tool_calling",
            ),
            priority=40,
        )
    )

    registry.register_model(
        ModelConfig(
            name="grader-orca",
            provider="orcarouter",
            model_id=_resolve_model_id(
                "GRADER_ORCA_MODEL",
                "ORCA_DEEPSEEK_V4_FLASH_MODEL",
                default="deepseek/deepseek-v4-flash",
            ),
            capabilities=(
                "evaluation",
                "tool_calling",
            ),
            priority=40,
        )
    )
```

- [ ] **Step 4: Run the tests**

Run: `pytest draftly-agent-backend/tests/unit/models/test_review_failover.py -v`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/models/factory.py \
        draftly-agent-backend/tests/unit/models/test_review_failover.py
git commit -m "feat(routing): register orcarouter review/grade models for 402 failover"
```

---

## Task 3: Slack search installation token

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/client.py:111-136`
- Modify: `draftly-agent-backend/src/draftly/tools/slack/search_messages.py`
- Test: `draftly-agent-backend/tests/unit/integrations/test_slack_search_token.py` (create)

**Interfaces:**
- Consumes: `SlackClient._resolve_installation_token`, `SlackClient._resolve_installation_for_org`, `current_support_runtime`
- Produces: `SlackClient.search_messages(..., org_id=..., team_id=...)` resolution; tool signature unchanged (org/team resolved from the support runtime)

- [ ] **Step 1: Write the failing tests**

Create `draftly-agent-backend/tests/unit/integrations/test_slack_search_token.py`:

```python
"""search.messages resolves the workspace installation bot token."""

import pytest

from draftly.integrations.slack.client import SlackClient


class _FakeInstallation:
    def __init__(self, bot_token: str) -> None:
        self.bot_token = bot_token


class _FakeStore:
    def __init__(self) -> None:
        self._by_team: dict[str, _FakeInstallation] = {}
        self._by_org: dict[str, _FakeInstallation] = {}

    async def async_get_by_team(self, team_id: str):
        return self._by_team.get(team_id)

    async def async_get_by_org(self, org_id: str):
        return self._by_org.get(org_id)


@pytest.mark.asyncio
async def test_search_uses_team_installation_token(monkeypatch):
    store = _FakeStore()
    store._by_team["T0123"] = _FakeInstallation("xoxb-team-bot")
    client = SlackClient(installation_store=store)

    captured: dict[str, str] = {}

    async def fake_request(method, endpoint, *, params=None, json=None):
        captured["endpoint"] = endpoint
        captured["auth"] = client._headers()["Authorization"]
        return {"ok": True, "messages": {"matches": []}}

    monkeypatch.setattr(client, "_request", fake_request)
    result = await client.search_messages("oauth", team_id="T0123")
    assert result == []
    assert captured["endpoint"] == "search.messages"
    assert captured["auth"] == "Bearer xoxb-team-bot"


@pytest.mark.asyncio
async def test_search_uses_org_installation_token(monkeypatch):
    store = _FakeStore()
    store._by_org["org-1"] = _FakeInstallation("xoxb-org-bot")
    client = SlackClient(installation_store=store)

    captured: dict[str, str] = {}

    async def fake_request(method, endpoint, *, params=None, json=None):
        captured["auth"] = client._headers()["Authorization"]
        return {"ok": True, "messages": {"matches": []}}

    monkeypatch.setattr(client, "_request", fake_request)
    await client.search_messages("oauth", org_id="org-1")
    assert captured["auth"] == "Bearer xoxb-org-bot"


@pytest.mark.asyncio
async def test_search_falls_back_to_resolved_token_when_no_team_or_org(monkeypatch):
    client = SlackClient()
    client.last_token = "xoxb-env-token"

    captured: dict[str, str] = {}

    async def fake_request(method, endpoint, *, params=None, json=None):
        captured["auth"] = client._headers()["Authorization"]
        return {"ok": True, "messages": {"matches": []}}

    monkeypatch.setattr(client, "_request", fake_request)
    result = await client.search_messages("oauth")
    assert result == []
    assert captured["auth"] == "Bearer xoxb-env-token"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest draftly-agent-backend/tests/unit/integrations/test_slack_search_token.py -v`
Expected: FAIL — `search_messages() got an unexpected keyword argument 'team_id'`.

- [ ] **Step 3: Update `SlackClient.search_messages`**

Replace lines 111-136 in `draftly-agent-backend/src/draftly/integrations/slack/client.py`:

```python
    async def search_messages(
        self,
        query: str,
        *,
        channel_id: str | None = None,
        limit: int = 20,
        org_id: str | None = None,
        team_id: str | None = None,
    ) -> list[dict[str, Any]]:

        if team_id:
            await self._resolve_installation_token(team_id)
        elif org_id:
            await self._resolve_installation_for_org(org_id)

        search_query = query

        if channel_id:
            search_query = f"{query} in:{channel_id}"

        data = await self._request(
            "GET",
            "search.messages",
            params={
                "query": search_query,
                "count": limit,
            },
        )

        return cast(
            list[dict[str, Any]],
            data.get("messages", {}).get("matches", []),
        )
```

- [ ] **Step 4: Update the `slack_search_messages` tool to resolve org/team at runtime**

Replace `draftly-agent-backend/src/draftly/tools/slack/search_messages.py`:

```python
from strands.tools import tool


@tool(name="slack_search_messages")
async def search_messages(
    query: str,
    channel_id: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search Slack messages, optionally scoped to a channel."""
    from draftly.integrations.slack.client import SlackClient
    from draftly.integrations.support.runtime import current_support_runtime

    runtime = current_support_runtime()
    org_id = getattr(runtime, "org_id", None) if runtime is not None else None
    team_id = (
        getattr(runtime, "platform_account_id", None) if runtime is not None else None
    )

    client = SlackClient()
    return await client.search_messages(
        query,
        channel_id=channel_id,
        limit=limit,
        org_id=org_id,
        team_id=team_id,
    )
```

- [ ] **Step 5: Run the tests**

Run: `pytest draftly-agent-backend/tests/unit/integrations/test_slack_search_token.py -v`
Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/integrations/slack/client.py \
        draftly-agent-backend/src/draftly/tools/slack/search_messages.py \
        draftly-agent-backend/tests/unit/integrations/test_slack_search_token.py
git commit -m "fix(slack): resolve installation bot token for search.messages"
```

---

## Task 4: Grounding-aware writer tool filter

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/composition/tools.py` (append `filter_grounded_tools`)
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py:264,292`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/issue_graph.py:150,157`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/support_graph.py:194,201`
- Test: `draftly-agent-backend/tests/tools/test_registry.py` (append)

**Interfaces:**
- Consumes: `current_grounding()` / `LOCAL` from `draftly.workflows.grounding`, `tool_name` from `draftly.orchestration.graphs.tool_scoping`
- Produces: `filter_grounded_tools(grounding, tools)`

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-backend/tests/tools/test_registry.py`:

```python
from draftly.app.composition.tools import build_tools, filter_grounded_tools
from draftly.orchestration.graphs.tool_scoping import scope_writer_tools


def _all_writer_tools():
    reg = build_tools()
    return scope_writer_tools(reg.documentation_engineer, reg.documentation)


def test_github_grounding_excludes_local_git_fs_tools():
    writer_tools = _all_writer_tools()
    names = {t.tool_name for t in writer_tools}
    github_names = {
        t.tool_name for t in filter_grounded_tools("github", writer_tools)
    }
    for local_name in (
        "read_file",
        "write_file",
        "list_directory",
        "file_exists",
        "git_status",
        "git_diff",
        "git_log",
    ):
        if local_name in names:
            assert local_name not in github_names


def test_local_grounding_keeps_local_fs_tools():
    writer_tools = _all_writer_tools()
    local_names = {
        t.tool_name for t in filter_grounded_tools("local", writer_tools)
    }
    assert local_names == {t.tool_name for t in writer_tools}


def test_filter_grounded_tools_defaults_to_current_grounding():
    writer_tools = _all_writer_tools()
    result = filter_grounded_tools(None, writer_tools)
    assert isinstance(result, list)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest draftly-agent-backend/tests/tools/test_registry.py -k grounding -v`
Expected: FAIL — `filter_grounded_tools` not defined.

- [ ] **Step 3: Implement `filter_grounded_tools`**

Append to the bottom of `draftly-agent-backend/src/draftly/app/composition/tools.py`:

```python
_LOCAL_ONLY_TOOL_NAMES = frozenset(
    {
        "read_file",
        "write_file",
        "list_directory",
        "file_exists",
        "git_status",
        "git_diff",
        "git_log",
    }
)


def filter_grounded_tools(grounding: str | None, tools: list[Any]) -> list[Any]:
    """Strip local-checkout-only tools when the run has no local checkout.

    ``grounding=None`` reads the run-level context var set by the workflow
    runner; callers that already know the mode can pass it directly.
    """
    from draftly.orchestration.graphs.tool_scoping import tool_name
    from draftly.workflows.grounding import LOCAL, current_grounding

    if grounding is None:
        grounding = current_grounding().get("mode") or LOCAL
    if grounding == LOCAL:
        return tools
    if not tools:
        return tools
    return [t for t in tools if tool_name(t) not in _LOCAL_ONLY_TOOL_NAMES]
```

- [ ] **Step 4: Apply the filter in `documentation_graph.py`**

Add the import near the top of `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py`:

```python
from draftly.app.composition.tools import filter_grounded_tools
```

Replace the writer tool assembly at line 264:

```python
    writer_tools = filter_grounded_tools(grounding, _scope_writer_tools(reg.documentation_engineer, reg.documentation))
```

Replace the writer tool assembly at line 292:

```python
        filter_grounded_tools(grounding, _scope_writer_tools(reg.documentation_engineer, reg.documentation)),
```

- [ ] **Step 5: Apply the filter in `issue_graph.py`**

Add the import near the top of `draftly-agent-backend/src/draftly/orchestration/graphs/issue_graph.py`:

```python
from draftly.app.composition.tools import filter_grounded_tools
```

Replace lines 150 and 157 with:

```python
        filter_grounded_tools(None, scope_writer_tools(reg.documentation_engineer, reg.documentation)),
```

- [ ] **Step 6: Apply the filter in `support_graph.py`**

Add the import near the top of `draftly-agent-backend/src/draftly/orchestration/graphs/support_graph.py`:

```python
from draftly.app.composition.tools import filter_grounded_tools
```

Replace lines 194 and 201 with:

```python
        filter_grounded_tools(None, scope_writer_tools(reg.documentation_engineer, reg.documentation)),
```

- [ ] **Step 7: Run the tests**

Run: `pytest draftly-agent-backend/tests/tools/test_registry.py -v`
Expected: All tests PASS, including the three new grounding tests.

- [ ] **Step 8: Commit**

```bash
git add draftly-agent-backend/src/draftly/app/composition/tools.py \
        draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py \
        draftly-agent-backend/src/draftly/orchestration/graphs/issue_graph.py \
        draftly-agent-backend/src/draftly/orchestration/graphs/support_graph.py \
        draftly-agent-backend/tests/tools/test_registry.py
git commit -m "fix(grounding): exclude local git/fs tools under github grounding"
```

---

## Task 5: Deterministic idempotency key injector

**Files:**
- Modify: `draftly-agent-backend/src/draftly/steering/handler.py` (`_handle_tool`, add `_stamp_idempotency_key`)
- Test: `draftly-agent-backend/tests/steering/test_handler.py` (append)

**Interfaces:**
- Consumes: `self.runtime.scope` (`run_id`, `org_id`), `self.policy.side_effect_tools`
- Produces: deterministic stamp on `tool_use["metadata"]["idempotency_key"]` before `evaluate_tool_async` runs (satisfies `_check_idempotency` at `policy.py:301`)

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-backend/tests/steering/test_handler.py`:

```python
import hashlib
import json

from draftly.steering.policy import FailureMode, Proceed, RolePolicy


class ProceedPolicy(RolePolicy):
    """Minimal DELIVERY policy that always allows the tool."""

    def __init__(self) -> None:
        super().__init__(
            role=AgentRole.DELIVERY,
            side_effecting=True,
            failure_mode=FailureMode.INTERRUPT,
        )
        self.side_effect_tools = frozenset({"create_comment"})

    async def evaluate_tool_async(self, **kwargs):
        return Proceed(reason="allowed")


_IDEM_RESERVED = {"name", "toolUseId", "tool_use_id", "metadata", "idempotency_key"}


def _idem_payload(tool_use: dict) -> str:
    args = {k: v for k, v in tool_use.items() if k not in _IDEM_RESERVED}
    return json.dumps(args, sort_keys=True, default=str)


async def test_idempotency_key_injected_on_side_effect_tool():
    runtime = build_runtime(role=AgentRole.DELIVERY)
    handler = DraftlySteeringHandler(runtime=runtime, policy=ProceedPolicy())

    tool_use = {
        "name": "create_comment",
        "destination_project": "project-1",
        "repo_dir": f"{CHECKOUT}/docs",
        "body": "excerpt",
    }
    action = await handler.steer_before_tool(agent=FakeAgent(), tool_use=tool_use)

    assert type(action).__name__ == "Proceed"
    key = (tool_use.get("metadata") or {}).get("idempotency_key")
    assert isinstance(key, str) and len(key) == 64

    expected = hashlib.sha256(
        f"org-1|run-1|create_comment|{_idem_payload(tool_use)}".encode("utf-8")
    ).hexdigest()
    assert key == expected


async def test_identical_calls_produce_deterministic_key():
    runtime = build_runtime(role=AgentRole.DELIVERY)
    handler = DraftlySteeringHandler(runtime=runtime, policy=ProceedPolicy())

    keys = []
    for _ in range(3):
        tool_use = {
            "name": "create_comment",
            "destination_project": "project-1",
            "repo_dir": f"{CHECKOUT}/docs",
            "body": "excerpt",
        }
        await handler.steer_before_tool(agent=FakeAgent(), tool_use=tool_use)
        keys.append((tool_use.get("metadata") or {}).get("idempotency_key"))
    assert len(set(keys)) == 1


async def test_differs_when_input_changes():
    runtime = build_runtime(role=AgentRole.DELIVERY)
    handler = DraftlySteeringHandler(runtime=runtime, policy=ProceedPolicy())

    keys = []
    for body in ("excerpt", "different body"):
        tool_use = {
            "name": "create_comment",
            "destination_project": "project-1",
            "repo_dir": f"{CHECKOUT}/docs",
            "body": body,
        }
        await handler.steer_before_tool(agent=FakeAgent(), tool_use=tool_use)
        keys.append((tool_use.get("metadata") or {}).get("idempotency_key"))
    assert keys[0] != keys[1]


async def test_read_only_tool_not_injected():
    runtime = build_runtime(role=AgentRole.WRITER)
    handler = DraftlySteeringHandler(runtime=runtime, policy=policy_for(AgentRole.WRITER))

    tool_use = {"name": "read_file", "path": f"{CHECKOUT}/docs/index.md"}
    await handler.steer_before_tool(agent=FakeAgent(), tool_use=tool_use)
    meta = tool_use.get("metadata") or {}
    assert "idempotency_key" not in meta
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest draftly-agent-backend/tests/steering/test_handler.py::test_idempotency_key_injected_on_side_effect_tool -v`
Expected: FAIL — no `idempotency_key` in metadata.

- [ ] **Step 3: Implement the idempotency injector**

In `draftly-agent-backend/src/draftly/steering/handler.py`, add the `hashlib` and `json` imports to the existing `import` block (do not duplicate names already imported).

Add the following method to `DraftlySteeringHandler` (before `_handle_tool`, around line 290):

```python
    _IDEM_RESERVED_KEYS = frozenset(
        {"name", "toolUseId", "tool_use_id", "metadata", "idempotency_key"}
    )

    def _stamp_idempotency_key(self, tool_use: dict) -> None:
        """Stamp a deterministic idempotency key on side-effecting tools.

        Keyed on ``org_id|run_id|tool_name|<sorted json args>`` so identical
        calls within a run collide and honest retries are deduplicated.
        Respects an already-present key.
        """
        tool_name = (tool_use or {}).get("name", "")
        if tool_name not in self.policy.side_effect_tools:
            return
        meta = dict((tool_use.get("metadata") or {}))
        if meta.get("idempotency_key"):
            return
        scope = self.runtime.scope
        run_id = getattr(scope, "run_id", None) or ""
        org_id = getattr(scope, "org_id", None) or ""
        args = {
            k: v
            for k, v in tool_use.items()
            if k not in self._IDEM_RESERVED_KEYS
        }
        payload = json.dumps(args, sort_keys=True, default=str)
        meta["idempotency_key"] = hashlib.sha256(
            f"{org_id}|{run_id}|{tool_name}|{payload}".encode("utf-8")
        ).hexdigest()
        tool_use["metadata"] = meta
```

Update `_handle_tool` so the stamp runs before policy evaluation (the first lines of the method, before the `try`):

```python
    async def _handle_tool(self, *, agent, tool_use, **kwargs):
        tool_use = dict(tool_use or {})
        tool_name = tool_use.get("name", "")
        tool_use_id = tool_use.get("toolUseId") or ""
        self._stamp_idempotency_key(tool_use)
        enforcement = self.runtime.config.enforcement_enabled
        # ... rest unchanged
```

- [ ] **Step 4: Run the tests**

Run: `pytest draftly-agent-backend/tests/steering/test_handler.py -v`
Expected: All tests PASS, including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/steering/handler.py \
        draftly-agent-backend/tests/steering/test_handler.py
git commit -m "fix(steering): auto-stamp deterministic idempotency key on delivery tools"
```

---

## Final verification

- [ ] **Run the full test suite for touched areas**

```bash
pytest \
  draftly-agent-backend/tests/nodes/test_evaluator.py \
  draftly-agent-backend/tests/unit/models/test_review_failover.py \
  draftly-agent-backend/tests/unit/integrations/test_slack_search_token.py \
  draftly-agent-backend/tests/tools/test_registry.py \
  draftly-agent-backend/tests/steering/test_handler.py \
  -v
```

Expected: All green.

- [ ] **Run lint/type checks (if available in this repo)**

```bash
cd draftly-agent-backend && ruff check src/ tests/ && pyright src/
```

- [ ] **Update the knowledge graph**

```bash
graphify update .
```