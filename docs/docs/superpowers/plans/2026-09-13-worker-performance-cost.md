# Worker Performance and Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce normal documentation-worker model traffic by at least 60%, reach `pending_review` in a typical run within eight minutes, complete the writer stage within five minutes and the full automated pipeline (including delivery, excluding human gate wait) within fifteen minutes, eliminate raw agent chatter from logs, and preserve deterministic safety and human review.

**Architecture:** Keep the current documentation graph, but make expensive behavior conditional and revision work incremental. A default-off flag protects every behavior change while structured requirements, selective steering, capability-aware research, atomic draft batches, shared provider cooldowns, and per-stage telemetry replace the current retry-heavy path.

**Tech Stack:** Python 3.11+, Pydantic v2, Strands Agents/Graph/Swarm, asyncpg-style repositories, Redis, structlog, pytest/pytest-asyncio, Docker Compose, Graphify.

**Spec:** `docs/superpowers/specs/2026-09-13-worker-performance-cost-design.md`

## Global Constraints

- Preserve deterministic safety checks and the existing human review gate.
- All new persisted/schema fields are additive; existing run and draft records remain readable.
- Ship behind these default-off flags: `silent_agent_callbacks`, `selective_steering_judge`, `capability_aware_research`, `structured_evaluation_requirements`, `targeted_draft_revisions`, `batch_draft_tools`, `run_cost_summary`, `writer_middle_tier`, and `provider_warmup`. The composite `DRAFTLY_FASTPATH` enables `selective_steering_judge` + `capability_aware_research` + `batch_draft_tools` + `writer_middle_tier` + `provider_warmup` together for A/B and live demonstration.
- The writer tool loop routes through the `research` chain (`writer_middle_tier`); the plan step and sealed generation resolve to `reasoning` via per-call capability routing. Reverting this flag is the first rollback action on a quality regression.
- A best-effort one-token provider warm-up probe fires after impact (`provider_warmup`): non-blocking, 5-second timeout, never counted as a model attempt, and only against providers healthy for the target model.
- A normal run makes at most one optional LLM steering judgment per agent stage.
- Connector or provider failures add at most one failed attempt to a run.
- A normal run performs one writer generation; one targeted revision is the maximum before human escalation.
- Accepted draft files are immutable and inherited logically; a revision writes only files named in `revision_files`.
- Partial draft batches stay unsealed and invisible to evaluation, review, and delivery.
- Raw model reasoning, `Tool #N`, and default Strands callback output must not appear on worker stdout.
- Log summaries contain bounded metadata only; authored document bodies and full evaluator prompts never enter production logs.
- Before editing a currently dirty file, inspect `git diff -- <path>` and preserve the user's existing changes.
- Use `DRAFTLY_LIVE=0` for all automated tests in this plan.

---

## File Map

- `src/draftly/app/config.py`: owns the seven rollout flags and steering judge limit.
- `src/draftly/agents/factory.py`: disables Strands' printing callback unless a caller explicitly supplies one.
- `src/draftly/steering/judge_policy.py`: pure eligibility, cache-key, and per-stage budget logic for the optional LLM judge.
- `src/draftly/steering/context.py`, `policy.py`, and `handler.py`: carry run-scoped judge state, invoke the selector, and reduce routine log volume.
- `src/draftly/agents/schemas.py`: defines requirements, actionable evaluation results, and revision requests.
- `src/draftly/orchestration/nodes/requirement_evaluator.py`: performs deterministic per-file requirement checks.
- `src/draftly/orchestration/nodes/evaluate.py`: assembles drafts, uses hard checks for pass/fail, and treats rubric output as advisory.
- `src/draftly/persistence/repositories/drafts.py`: provides atomic batch sealing and effective-generation overlays.
- `src/draftly/tools/documentation/drafts.py`: exposes inspect/write/finalize batch tools to the writer.
- `src/draftly/agents/documentation/research_capabilities.py`: decides which researchers may run and tracks connector cooldowns.
- `src/draftly/agents/documentation/research_swarm.py`: builds only the eligible researchers with bounded handoffs.
- `src/draftly/models/health.py`, `redis_health.py`, and `router.py`: persist typed provider failures and suppress known-dead providers before model creation.
- `src/draftly/observability/run_cost.py`: derives bounded per-stage and per-run request/tool/token summaries.
- `src/draftly/workflows/runner.py`: publishes the final cost summary and fires the best-effort warm-up probe after the impact stage.
- `src/draftly/models/factory.py`: capability-aware tier selection so the writer tool loop uses the `research` chain while plan and sealed generation resolve to `reasoning`.
- `src/draftly/observability/warmup.py`: best-effort non-blocking provider warm-up probe.
- `src/draftly/orchestration/graphs/documentation_graph.py`: wires requirements, targeted revisions, conditional research, and batch tools behind flags.

### Task 1: Rollout Configuration and Silent Agent Callbacks

**Files:**
- Modify: `src/draftly/app/config.py:8-52,160-211`
- Modify: `src/draftly/agents/factory.py:52-98`
- Modify: `src/draftly/steering/context.py:16-34`
- Modify: `src/draftly/observability/logging.py:21-105`
- Modify: `tests/steering/test_agent_factory.py`
- Modify: `tests/unit/app/test_evaluator_budget.py`
- Modify: `tests/observability/test_logging.py`

**Interfaces:**
- Consumes: existing `StrandsConfig`, `Settings.strands`, and `build_draftly_agent`.
- Produces: seven boolean fields on `StrandsConfig`, `steering_judge_calls_per_stage: int`, and a silent-by-default `build_draftly_agent` that preserves explicit callback overrides.

- [ ] **Step 1: Write failing configuration and callback tests**

```python
def test_performance_flags_default_off() -> None:
    cfg = StrandsConfig()
    assert cfg.silent_agent_callbacks is False
    assert cfg.selective_steering_judge is False
    assert cfg.capability_aware_research is False
    assert cfg.structured_evaluation_requirements is False
    assert cfg.targeted_draft_revisions is False
    assert cfg.batch_draft_tools is False
    assert cfg.run_cost_summary is False
    assert cfg.steering_judge_calls_per_stage == 1


def test_factory_disables_default_printing_callback(monkeypatch) -> None:
    captured = {}
    monkeypatch.setattr(factory, "Agent", lambda **kwargs: captured.update(kwargs) or object())
    runtime = SteeringRuntime.disabled()
    runtime.config = replace(runtime.config, silent_agent_callbacks=True)
    factory.build_draftly_agent(
        role=AgentRole.RESEARCH,
        system_prompt="research",
        model=object(),
        runtime=runtime,
    )
    assert "callback_handler" in captured
    assert captured["callback_handler"] is None


def test_factory_preserves_explicit_callback(monkeypatch) -> None:
    captured = {}
    callback = object()
    monkeypatch.setattr(factory, "Agent", lambda **kwargs: captured.update(kwargs) or object())
    factory.build_draftly_agent(
        role=AgentRole.RESEARCH,
        system_prompt="research",
        model=object(),
        runtime=SteeringRuntime.disabled(),
        callback_handler=callback,
    )
    assert captured["callback_handler"] is callback


def test_production_renderer_is_json_without_ansi(capsys) -> None:
    configure_logging(Settings(environment="production", log_level="INFO"))
    structlog.get_logger("worker").info("safe_event", stage="writer")
    line = capsys.readouterr().err.strip()
    assert json.loads(line)["event"] == "safe_event"
    assert "\x1b[" not in line
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/steering/test_agent_factory.py tests/unit/app/test_evaluator_budget.py -q`

Expected: FAIL because the configuration fields do not exist and the factory omits `callback_handler`.

- [ ] **Step 3: Add the rollout fields and silent default**

Add to `StrandsConfig`, mirror them as `strands_*` fields on `Settings`, and forward them from `Settings.strands`. Mirror `silent_agent_callbacks` and `selective_steering_judge` into the frozen per-run `SteeringRuntimeConfig` so agent construction and policy evaluation do not read the environment:

```python
silent_agent_callbacks: bool = False
selective_steering_judge: bool = False
capability_aware_research: bool = False
structured_evaluation_requirements: bool = False
targeted_draft_revisions: bool = False
batch_draft_tools: bool = False
run_cost_summary: bool = False
steering_judge_calls_per_stage: int = Field(default=1, ge=0, le=3)
```

In `build_draftly_agent`, set the callback before constructing `Agent` only when the run snapshot enables it:

```python
agent_options.setdefault("agent_id", agent_id)
if runtime.config.silent_agent_callbacks:
    agent_options.setdefault("callback_handler", None)
return Agent(
    system_prompt=system_prompt,
    model=model,
    tools=tools,
    **agent_options,
)
```

Do not put this setting on `_IsolatedJudge`; it already passes `callback_handler=None` explicitly.

Keep `_build_formatter("production")` on `JSONRenderer` and add a regression assertion that the worker deployment passes `ENVIRONMENT=production`; development continues using `ConsoleRenderer`.

- [ ] **Step 4: Run the focused tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/steering/test_agent_factory.py tests/unit/app/test_evaluator_budget.py tests/observability/test_logging.py -q`

Expected: PASS.

- [ ] **Step 5: Commit the configuration boundary**

```bash
git add src/draftly/app/config.py src/draftly/agents/factory.py src/draftly/steering/context.py src/draftly/observability/logging.py tests/steering/test_agent_factory.py tests/unit/app/test_evaluator_budget.py tests/observability/test_logging.py
git commit -m "perf: add worker cost controls and silence agent callbacks"
```

### Task 2: Selective, Cached Steering Judge

**Files:**
- Create: `src/draftly/steering/judge_policy.py`
- Create: `tests/steering/test_judge_policy.py`
- Modify: `src/draftly/steering/context.py:16-145`
- Modify: `src/draftly/steering/policy.py:116-190,360-405`
- Modify: `src/draftly/steering/handler.py:322-430`
- Modify: `tests/steering/test_policy.py`
- Modify: `tests/steering/test_handler.py`

**Interfaces:**
- Consumes: `SteeringDecision`, `DecisionKind`, `SteeringRuntime.identity`, deterministic role policy output, and the Task 1 flag/limit.
- Produces: `should_invoke_llm_judge(decision, *, tool_name, stage) -> bool`, `judge_cache_key(decision, *, policy_version, tool_name) -> JudgeCacheKey`, and shared `JudgeState.reserve(stage, key) -> bool`.

- [ ] **Step 1: Write failing pure-policy tests**

```python
@pytest.mark.parametrize("tool_name", ["read_file", "code_search", "append_chunk", "finalize_draft"])
def test_routine_proceed_skips_judge(tool_name: str) -> None:
    decision = SteeringDecision.proceed(
        phase=SteeringPhase.BEFORE_TOOL,
        reason="allowed",
        role=AgentRole.RESEARCH,
        rule="research:read_only",
    )
    assert not should_invoke_llm_judge(decision, tool_name=tool_name, stage="research")


def test_side_effect_guide_is_eligible() -> None:
    decision = SteeringDecision.guide(
        phase=SteeringPhase.BEFORE_TOOL,
        reason="confirm destination",
        role=AgentRole.DELIVERY,
        rule="delivery:destination",
    )
    assert should_invoke_llm_judge(
        decision, tool_name="create_pull_request", stage="deliver"
    )


def test_budget_allows_one_unique_judgment_per_stage() -> None:
    state = JudgeState(max_calls_per_stage=1)
    assert state.reserve("writer", ("v1", "writer", "rule", "draft_write"))
    assert not state.reserve("writer", ("v1", "writer", "other", "draft_write"))
    assert not state.reserve("writer", ("v1", "writer", "rule", "draft_write"))
```

- [ ] **Step 2: Run the new test and confirm import failures**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/steering/test_judge_policy.py -q`

Expected: FAIL with `ModuleNotFoundError: draftly.steering.judge_policy`.

- [ ] **Step 3: Implement eligibility, normalized keys, and the run-scoped budget**

```python
ROUTINE_TOOLS = frozenset({
    "read_file", "list_directory", "code_search", "git_diff", "git_show",
    "semantic_search", "keyword_search", "hybrid_search",
    "start_draft", "append_chunk", "finalize_draft",
    "inspect_documents", "write_draft_batch", "finalize_draft_batch",
})
SIDE_EFFECT_TOOLS = frozenset({"create_pull_request", "create_commit", "post_comment"})


def should_invoke_llm_judge(
    decision: SteeringDecision, *, tool_name: str | None, stage: str
) -> bool:
    del stage
    if decision.kind is DecisionKind.INTERRUPT:
        return False
    if tool_name in ROUTINE_TOOLS and decision.kind is DecisionKind.PROCEED:
        return False
    return decision.kind is DecisionKind.GUIDE or tool_name in SIDE_EFFECT_TOOLS


JudgeCacheKey = tuple[str, str, str, str, str]


def judge_cache_key(
    decision: SteeringDecision, *, policy_version: str, tool_name: str | None
) -> JudgeCacheKey:
    category = "side_effect" if tool_name in SIDE_EFFECT_TOOLS else "policy_guidance"
    return (
        policy_version,
        decision.role.value if decision.role else "unknown",
        decision.phase.value,
        decision.rule or "unruled",
        category,
    )


@dataclass
class JudgeState:
    max_calls_per_stage: int = 1
    calls_by_stage: dict[str, int] = field(default_factory=dict)
    decisions: dict[JudgeCacheKey, SteeringDecision] = field(default_factory=dict)

    def reserve(self, stage: str, key: JudgeCacheKey) -> bool:
        if key in self.decisions:
            return False
        used = self.calls_by_stage.get(stage, 0)
        if used >= self.max_calls_per_stage:
            return False
        self.calls_by_stage[stage] = used + 1
        return True
```

Add `judge_state: JudgeState | None` to `SteeringRuntime`, instantiate it once in `from_context`, and preserve the same object in `for_agent` and `with_sinks` so the cap applies across agent instances in one stage.

- [ ] **Step 4: Gate `_refine` and prove deterministic checks still run on every call**

Change `RolePolicy._refine` to accept `stage`, compute the deterministic decision first, and only call the judge when all of these are true: the feature flag is on, a judge exists, eligibility is true, and `JudgeState.reserve(stage, key)` succeeds. Cache the returned decision in `JudgeState.decisions`; a cached result may be reused without a model call.

Add this behavior test:

```python
async def test_selective_judge_skips_routine_calls_but_keeps_policy_checks(runtime):
    judge = AsyncMock()
    policy = RolePolicy.for_role(AgentRole.WRITER)
    for _ in range(5):
        result = await policy.evaluate_tool_async(
            runtime=runtime,
            tool_name="append_chunk",
            tool_use={"name": "append_chunk", "draft_id": "d1", "content": "x"},
            judge=judge,
        )
        assert result.kind is DecisionKind.PROCEED
    judge.assert_not_awaited()
```

- [ ] **Step 5: Make routine decision logs debug-level and keep warnings/interventions at info**

In `record_decision`, choose a bound logger method without changing durable audit writes or SSE emission:

```python
log = logger.debug if (
    decision.kind is DecisionKind.PROCEED and decision_source == "deterministic"
) else logger.info
log("steering_decision", **bounded_fields)
```

Build `bounded_fields` with the existing identifiers, `reason[:reason_max_chars]`, and no `tool_use`, messages, prompt, or authored content.

- [ ] **Step 6: Run steering tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/steering/test_judge_policy.py tests/steering/test_policy.py tests/steering/test_handler.py tests/steering/test_llm_judge_isolation.py -q`

Expected: PASS, including exactly one judge await for two different eligible decisions in the same stage.

- [ ] **Step 7: Commit selective steering**

```bash
git add src/draftly/steering/judge_policy.py src/draftly/steering/context.py src/draftly/steering/policy.py src/draftly/steering/handler.py tests/steering/test_judge_policy.py tests/steering/test_policy.py tests/steering/test_handler.py
git commit -m "perf: judge only ambiguous steering decisions"
```

### Task 3: Structured Requirements and Deterministic Per-File Evaluation

**Files:**
- Modify: `src/draftly/agents/schemas.py:31-137`
- Modify: `src/draftly/agents/prompts.py`
- Create: `src/draftly/orchestration/nodes/requirement_evaluator.py`
- Create: `tests/nodes/test_requirement_evaluator.py`
- Modify: `tests/unit/agents/test_prompts.py`
- Modify: `tests/unit/agents/test_agents.py`

**Interfaces:**
- Consumes: `EvidenceItem`, impact-agent structured output, and draft files as `dict[path, content]`.
- Produces: `DocumentationRequirement`, additive `ImpactAnalysis.requirements`, expanded `EvaluationResult`, `RevisionRequest`, and `evaluate_requirements(requirements, drafts_by_path, *, sealed) -> EvaluationResult`.

- [ ] **Step 1: Write failing schema and evaluator tests**

```python
def test_requirement_result_names_only_actionable_missing_files() -> None:
    requirements = [
        DocumentationRequirement(
            id="oauth-config",
            description="Explain the OAuth environment variables",
            required_files=["docs/configuration.md"],
            signals=["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET"],
            evidence_ids=["src/settings.py:10-20"],
        )
    ]
    result = evaluate_requirements(
        requirements,
        {"docs/configuration.md": "Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET."},
        sealed=True,
        available_evidence_ids={"src/settings.py:10-20"},
    )
    assert result.passed is True
    assert result.missing_by_file == {}
    assert result.revision_files == []


def test_requirement_does_not_match_an_unrelated_large_topic_blob() -> None:
    requirement = DocumentationRequirement(
        id="requesty-failover",
        description="Describe provider failover",
        required_files=["docs/providers.md"],
        signals=["payment_required", "cooldown"],
        evidence_ids=["src/draftly/models/router.py:220-250"],
    )
    result = evaluate_requirements(
        [requirement],
        {"docs/providers.md": "This is a long provider overview without the required behavior."},
        sealed=True,
        available_evidence_ids={"src/draftly/models/router.py:220-250"},
    )
    assert result.passed is False
    assert result.missing_by_file == {
        "docs/providers.md": ["requesty-failover: payment_required, cooldown"]
    }
```

- [ ] **Step 2: Run the new tests and confirm missing-symbol failures**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/nodes/test_requirement_evaluator.py -q`

Expected: FAIL because the schema and evaluator module do not exist.

- [ ] **Step 3: Add the additive Pydantic contracts**

```python
class DocumentationRequirement(BaseModel):
    id: str
    description: str
    required_files: list[str] = Field(default_factory=list)
    signals: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)


class ImpactAnalysis(BaseModel):
    action: str = Field(description=_enum_description(DOCA_ACTIONS))
    affected_documents: list[str] = Field(default_factory=list)
    rationale: str = ""
    evidence: list[str] = Field(default_factory=list)
    requirements: list[DocumentationRequirement] = Field(default_factory=list)


class EvaluationResult(BaseModel):
    passed: bool = False
    score: float = 0.0
    reasons: list[str] = Field(default_factory=list)
    missing_by_file: dict[str, list[str]] = Field(default_factory=dict)
    revision_files: list[str] = Field(default_factory=list)
    escalated: bool = False
    disagreement: bool = False


class RevisionRequest(BaseModel):
    base_generation: int
    revision_files: list[str] = Field(default_factory=list)
    missing_by_file: dict[str, list[str]] = Field(default_factory=dict)
    accepted_draft_ids: list[str] = Field(default_factory=list)
```

- [ ] **Step 4: Implement exact, normalized signal checks**

```python
def _contains_signal(content: str, signal: str) -> bool:
    normalized_content = " ".join(content.casefold().split())
    normalized_signal = " ".join(signal.casefold().split())
    return bool(normalized_signal) and normalized_signal in normalized_content


def evaluate_requirements(
    requirements: list[DocumentationRequirement],
    drafts_by_path: dict[str, str],
    *,
    sealed: bool,
    available_evidence_ids: set[str],
) -> EvaluationResult:
    missing: dict[str, list[str]] = {}
    if not sealed:
        return EvaluationResult(
            passed=False,
            score=0.0,
            reasons=["draft batch is not sealed"],
            missing_by_file={"<batch>": ["seal every draft before evaluation"]},
            revision_files=[],
        )
    for requirement in requirements:
        unknown_evidence = sorted(set(requirement.evidence_ids) - available_evidence_ids)
        if unknown_evidence:
            missing.setdefault("<evidence>", []).append(
                f"{requirement.id}: unknown evidence {', '.join(unknown_evidence)}"
            )
        target_paths = requirement.required_files or list(drafts_by_path)
        if not requirement.required_files:
            combined = "\n".join(drafts_by_path.values())
            absent = [s for s in requirement.signals if not _contains_signal(combined, s)]
            if absent:
                missing.setdefault("<any-affected-document>", []).append(
                    f"{requirement.id}: {', '.join(absent)}"
                )
            continue
        for path in target_paths:
            content = drafts_by_path.get(path)
            absent = requirement.signals if content is None else [
                signal for signal in requirement.signals
                if not _contains_signal(content, signal)
            ]
            if content is None or absent:
                detail = "missing file" if content is None else ", ".join(absent)
                missing.setdefault(path, []).append(f"{requirement.id}: {detail}")
    revision_files = sorted(path for path in missing if not path.startswith("<"))
    total = max(sum(len(r.required_files) for r in requirements), 1)
    failed = sum(len(items) for items in missing.values())
    return EvaluationResult(
        passed=not missing,
        score=max(0.0, 1.0 - failed / total),
        reasons=[] if not missing else ["actionable requirement gaps remain"],
        missing_by_file=missing,
        revision_files=revision_files,
    )
```

- [ ] **Step 5: Update impact and writer prompts to use stable requirement IDs**

Before editing `prompts.py`, run `git diff -- src/draftly/agents/prompts.py`. Preserve its current uncommitted edits. Add prompt clauses that require the impact agent to emit one small, testable requirement per user-visible behavior, and require the writer to address the supplied `signals` in the named files. Explicitly forbid copying evidence topics wholesale into the document.

Add assertions:

```python
def test_impact_prompt_requests_structured_requirements() -> None:
    prompt = impact_system_prompt()
    assert "requirements" in prompt
    assert "stable requirement id" in prompt.lower()
    assert "signals" in prompt
```

- [ ] **Step 6: Run schema, prompt, and pure evaluator tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/nodes/test_requirement_evaluator.py tests/unit/agents/test_prompts.py tests/unit/agents/test_agents.py -q`

Expected: PASS.

- [ ] **Step 7: Commit structured requirements**

```bash
git add src/draftly/agents/schemas.py src/draftly/agents/prompts.py src/draftly/orchestration/nodes/requirement_evaluator.py tests/nodes/test_requirement_evaluator.py tests/unit/agents/test_prompts.py tests/unit/agents/test_agents.py
git commit -m "feat: evaluate documentation against structured requirements"
```

### Task 4: Replace the False-Failure Revision Loop

**Files:**
- Modify: `src/draftly/orchestration/nodes/evaluate.py:154-360`
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py:340-405`
- Modify: `src/draftly/orchestration/hooks/draft_generation.py:18-75`
- Modify: `src/draftly/agents/documentation/draft_scope.py:15-45`
- Modify: `src/draftly/persistence/repositories/drafts.py:20-250`
- Modify: `tests/nodes/test_evaluator.py`
- Modify: `tests/graph/test_documentation_graph.py`
- Modify: `tests/unit/orchestration/test_draft_generation_hook.py`
- Modify: `tests/unit/persistence/test_draft_repository.py`

**Interfaces:**
- Consumes: Task 3 `DocumentationRequirement`, `EvaluationResult`, and `RevisionRequest`.
- Produces: `DraftFile.id`, `DraftFile.generation`, `DraftRepository.get_effective_generation`, evaluator output containing an actionable revision request, and a graph route that permits one targeted retry before review.

- [ ] **Step 1: Write failing evaluator behavior tests**

```python
async def test_rubric_disagreement_without_actionable_file_skips_rewrite():
    grader = AsyncMock(return_value={"passed": True, "reasons": ["grounded prose"]})
    repo = FakeDraftRepo(files=[DraftFile(
        path="docs/configuration.md", action="update",
        content="Use OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.", content_size=52,
    )])
    node = EvaluatorNode(rubric_grader=grader, drafts_repo=repo, max_iterations=1)
    result = await node.invoke_async(
        task_with_unknown_evidence_requirement(), {"run_id": "run-1"}
    )
    output = result.results["evaluate"].result.structured_output
    assert output.passed is False
    assert output.disagreement is True
    assert output.revision_files == []


async def test_second_actionable_failure_escalates_instead_of_third_generation():
    node = EvaluatorNode(rubric_grader=AsyncMock(), drafts_repo=missing_signal_repo(), max_iterations=1)
    first = await node.invoke_async(task_with_requirements(), {"run_id": "run-1"})
    second = await node.invoke_async(task_with_requirements(), {"run_id": "run-1"})
    assert first.results["evaluate"].result.structured_output.revision_files == ["docs/configuration.md"]
    assert second.results["evaluate"].result.structured_output.escalated is True


async def test_effective_generation_overlays_only_revised_paths(repo):
    first_a = await repo.create_revision(
        run_id="r1", org_id="o1", generation=1, path="docs/a.md", action="update"
    )
    await repo.append_chunk(first_a.id, "A1")
    await repo.finalize(first_a.id)
    first_b = await repo.create_revision(
        run_id="r1", org_id="o1", generation=1, path="docs/b.md", action="update"
    )
    await repo.append_chunk(first_b.id, "B1")
    await repo.finalize(first_b.id)
    second_b = await repo.create_revision(
        run_id="r1", org_id="o1", generation=2, path="docs/b.md", action="update"
    )
    await repo.append_chunk(second_b.id, "B2")
    await repo.finalize(second_b.id)
    effective = await repo.get_effective_generation(run_id="r1", generation=2)
    assert {item.path: item.content for item in effective} == {
        "docs/a.md": "A1", "docs/b.md": "B2"
    }
```

- [ ] **Step 2: Run focused evaluator tests and confirm failures**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/nodes/test_evaluator.py -q`

Expected: FAIL because the current gate uses whole-topic substring scoring and allows more than one revision.

- [ ] **Step 3: Integrate requirement evaluation and make length advisory**

First add optional `id: str = ""` and `generation: int = 0` fields to `DraftFile`. Implement `get_effective_generation` with one query ordered by `path, generation DESC`, keeping the first sealed row for each path where `generation <= $2`, then assemble its chunks. Existing `get_latest` remains unchanged while the flag is off.

In `EvaluatorNode.invoke_async`:

```python
hard_result = evaluate_requirements(
    requirements,
    drafts_by_path,
    sealed=files_present,
    available_evidence_ids=available_evidence_ids,
)
rubric = (
    await self.rubric_grader.grade(
        evidence=evidence,
        draft=draft,
        deterministic_reasons=hard_result.reasons,
    )
    if not hard_result.passed
    else None
)
disagreement = bool(not hard_result.passed and rubric is not None and rubric.passed)
escalated = bool(self.iteration > self.max_iterations and not hard_result.passed)
result = hard_result.model_copy(update={
    "escalated": escalated,
    "disagreement": disagreement,
    "reasons": bounded_reasons(hard_result.reasons, rubric),
})
```

Keep source-ID validation, sealed-draft presence, required-file presence, signals, and internal metadata as hard checks. Remove length from the pass/fail score; record it only as `"draft_length_chars=<n>"`. Cap reasons at 10 entries and 240 characters each.

- [ ] **Step 4: Publish a revision request and route only actionable gaps back to the writer**

Store this object in the evaluator node result when `revision_files` is non-empty and this is the first evaluation:

```python
RevisionRequest(
    base_generation=current_generation,
    revision_files=result.revision_files,
    missing_by_file=result.missing_by_file,
    accepted_draft_ids=[
        draft.id for draft in effective_drafts
        if draft.path not in result.revision_files
    ],
)
```

Update graph edges so `evaluate -> update/create` occurs only for the first actionable failure. Route `passed`, `disagreement`, empty actionable gaps, and the second failure to the existing review gate. Do not bypass review or delivery checks.

- [ ] **Step 5: Carry the revision request into `DraftScope`**

```python
@dataclass(frozen=True)
class DraftScope:
    run_id: str
    org_id: str
    generation: int
    revision_files: Sequence[str] = ()
    accepted_draft_ids: Sequence[str] = ()
```

In `NextGenerationHook`, read the previous evaluator output from invocation state, publish these tuples for writer nodes, and leave both empty on the first generation. Add a test that generation 2 exposes only the failed path while the delivery node remains read-only.

- [ ] **Step 6: Run evaluator and graph tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/nodes/test_evaluator.py tests/graph/test_documentation_graph.py tests/unit/orchestration/test_draft_generation_hook.py tests/unit/persistence/test_draft_repository.py -q`

Expected: PASS, with one writer retry maximum and review still reachable.

- [ ] **Step 7: Commit the bounded revision loop**

```bash
git add src/draftly/orchestration/nodes/evaluate.py src/draftly/orchestration/graphs/documentation_graph.py src/draftly/orchestration/hooks/draft_generation.py src/draftly/agents/documentation/draft_scope.py src/draftly/persistence/repositories/drafts.py tests/nodes/test_evaluator.py tests/graph/test_documentation_graph.py tests/unit/orchestration/test_draft_generation_hook.py tests/unit/persistence/test_draft_repository.py
git commit -m "perf: replace full rewrites with one targeted revision"
```

### Task 5: Atomic Batch Draft Tools

**Files:**
- Modify: `src/draftly/persistence/repositories/drafts.py:20-280`
- Modify: `src/draftly/tools/documentation/drafts.py:1-260`
- Modify: `src/draftly/tools/documentation/__init__.py`
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py:150-250`
- Modify: `tests/unit/persistence/test_draft_repository.py`
- Modify: `tests/unit/tools/test_draft_tools.py`
- Modify: `tests/graph/test_documentation_graph.py`

**Interfaces:**
- Consumes: `DraftScope.revision_files`, Task 4 `DraftRepository.get_effective_generation`, existing draft revision/chunk tables, database transactions, and `RevisionRequest`.
- Produces: `DocumentSnapshot`, `DraftChange`, `DraftReceipt`, `FinalizedDraft`, `DraftRepository.create_batch`, `finalize_batch`, and three writer tools.

- [ ] **Step 1: Write failing repository tests for atomic visibility and overlay semantics**

```python
async def test_finalize_batch_is_all_or_nothing(repo):
    drafts = await repo.create_batch(
        run_id="r1", org_id="o1", generation=1,
        changes=[("docs/a.md", "update", "A"), ("docs/b.md", "update", "B")],
        idempotency_key="batch-1",
    )
    assert await repo.get_generation(run_id="r1", generation=1) == []
    await repo.finalize_batch([draft.id for draft in drafts])
    assert [f.path for f in await repo.get_generation(run_id="r1", generation=1)] == [
        "docs/a.md", "docs/b.md"
    ]


```

- [ ] **Step 2: Run repository tests and confirm missing-method failures**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/unit/persistence/test_draft_repository.py -q`

Expected: FAIL with missing `create_batch` and `finalize_batch`.

- [ ] **Step 3: Implement batch repository methods using one transaction per visibility change**

`create_batch` must validate unique normalized paths, enforce `DraftScope.revision_files` before calling the repository, reject more than `MAX_BATCH_FILES = 20`, reject combined UTF-8 content above `MAX_BATCH_BYTES = 1_048_576`, split each content value into chunks no larger than `MAX_CHUNK_BYTES`, and insert all revisions/chunks unsealed in one transaction. Derive stable draft IDs from the run and idempotency key so retries return the existing rows:

```python
draft_id = str(uuid5(NAMESPACE_URL, f"{run_id}:{generation}:{path}:{idempotency_key}"))
```

`finalize_batch(draft_ids)` must lock every row using a `SELECT` query with a `FOR UPDATE` clause, reject mixed run/generation values and missing/already-sealed members, calculate sizes, and update all rows to `sealed=TRUE, sealed_at=$now` in the same transaction. An exception must roll the transaction back.

- [ ] **Step 4: Add writer batch contracts and tools**

```python
class DocumentSnapshot(BaseModel):
    path: str
    exists: bool
    content: str = ""

class DraftChange(BaseModel):
    path: str
    action: str
    content: str

class DraftReceipt(BaseModel):
    draft_id: str
    path: str
    generation: int

class FinalizedDraft(BaseModel):
    draft_id: str
    path: str
    content_size: int
```

Expose these exact async tools:

```python
async def inspect_documents(paths: list[str]) -> list[DocumentSnapshot]:
    scope = require_draft_scope()
    files = await build_document_repository().get_many(
        org_id=scope.org_id, paths=paths
    )
    by_path = {item.path: item.content for item in files}
    return [
        DocumentSnapshot(path=path, exists=path in by_path, content=by_path.get(path, ""))
        for path in paths
    ]


async def write_draft_batch(changes: list[DraftChange]) -> list[DraftReceipt]:
    scope = require_draft_scope()
    enforce_revision_scope(scope, [change.path for change in changes])
    rows = await build_draft_repository().create_batch(
        run_id=scope.run_id,
        org_id=scope.org_id,
        generation=scope.generation,
        changes=changes,
        idempotency_key=require_idempotency_key(),
    )
    return [DraftReceipt(draft_id=row.id, path=row.path, generation=row.generation) for row in rows]


async def finalize_draft_batch(draft_ids: list[str]) -> list[FinalizedDraft]:
    rows = await build_draft_repository().finalize_batch(draft_ids)
    return [
        FinalizedDraft(draft_id=row.id, path=row.path, content_size=row.content_size)
        for row in rows
    ]
```

`inspect_documents` reads current stored documentation in one repository call. `write_draft_batch` rejects paths outside `DraftScope.revision_files` when that tuple is non-empty and uses the steering-supplied `metadata.idempotency_key`. `finalize_draft_batch` returns receipts only after the repository transaction commits.

- [ ] **Step 5: Register only batch tools when the flag is enabled**

In the documentation graph writer-tool list:

```python
draft_tools = (
    [inspect_documents, write_draft_batch, finalize_draft_batch]
    if config.batch_draft_tools
    else [start_draft, append_chunk, finalize_draft]
)
grounded_tools = filter_grounded_tools(
    tools_registry.writer_tools,
    grounding=grounding,
)
writer_tools = _dedupe(grounded_tools, draft_tools)
```

The evaluator, review gate, and delivery path must call `get_effective_generation` when `targeted_draft_revisions` is enabled and retain `get_latest` otherwise.

- [ ] **Step 6: Run draft and graph tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/unit/persistence/test_draft_repository.py tests/unit/tools/test_draft_tools.py tests/graph/test_documentation_graph.py -q`

Expected: PASS, including rollback on a missing batch member and idempotent retry returning the same draft IDs.

- [ ] **Step 7: Commit batch authoring**

```bash
git add src/draftly/persistence/repositories/drafts.py src/draftly/tools/documentation/drafts.py src/draftly/tools/documentation/__init__.py src/draftly/orchestration/graphs/documentation_graph.py tests/unit/persistence/test_draft_repository.py tests/unit/tools/test_draft_tools.py tests/graph/test_documentation_graph.py
git commit -m "perf: batch draft writes and overlay targeted revisions"
```

### Task 6: Capability-Aware, Bounded Research

**Files:**
- Create: `src/draftly/agents/documentation/research_capabilities.py`
- Create: `tests/unit/agents/test_research_capabilities.py`
- Modify: `src/draftly/agents/documentation/research_swarm.py:1-150`
- Modify: `src/draftly/workflows/grounding.py:15-55`
- Modify: `src/draftly/workflows/runner.py:266-315`
- Modify: `tests/unit/agents/test_doc_swarm_grounding.py`
- Modify: `tests/unit/workflows/test_runner_grounding.py`

**Interfaces:**
- Consumes: grounding mode, connector configuration/health, event source, and Task 1 capability flag.
- Produces: immutable `ResearchCapabilities`, `ResearchPlan`, `build_research_plan`, and `ConnectorHealth` with one-attempt-per-run suppression.

- [ ] **Step 1: Write failing research-plan tests**

```python
def test_github_pr_uses_repo_and_docs_but_skips_unhealthy_support_connectors():
    plan = build_research_plan(
        grounding="github",
        event_source="github",
        capabilities=ResearchCapabilities(
            repository=True, documentation=True,
            slack_search=False, discord_search=False,
        ),
        support_research_requested=False,
    )
    assert plan.researchers == ("github", "docs")
    assert plan.max_handoffs == 3


def test_support_event_includes_only_healthy_origin_connector():
    plan = build_research_plan(
        grounding="docs",
        event_source="slack",
        capabilities=ResearchCapabilities(
            repository=False, documentation=True,
            slack_search=True, discord_search=True,
        ),
        support_research_requested=True,
    )
    assert plan.researchers == ("docs", "slack")
```

- [ ] **Step 2: Run the tests and confirm the module is absent**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/unit/agents/test_research_capabilities.py -q`

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement deterministic planning and connector cooldown state**

```python
@dataclass(frozen=True)
class ResearchCapabilities:
    repository: bool
    documentation: bool
    slack_search: bool
    discord_search: bool

@dataclass(frozen=True)
class ResearchPlan:
    researchers: Sequence[str]
    max_handoffs: int = 3
    max_iterations: int = 6
    execution_timeout: float = 360.0
    node_timeout: float = 180.0

@dataclass
class ConnectorHealth:
    cooldown_seconds: float = 300.0
    unavailable_until: dict[str, float] = field(default_factory=dict)
    diagnosed_by_run: dict[str, set[str]] = field(default_factory=dict)

    def can_attempt(self, connector: str) -> bool:
        return time.monotonic() >= self.unavailable_until.get(connector, 0.0)

    def mark_unavailable(self, connector: str, reason: str, *, run_id: str) -> bool:
        if reason in {"authentication", "not_allowed_token_type", "payment_required"}:
            self.unavailable_until[connector] = time.monotonic() + self.cooldown_seconds
        diagnosed = self.diagnosed_by_run.setdefault(run_id, set())
        first_diagnostic = connector not in diagnosed
        diagnosed.add(connector)
        return first_diagnostic
```

`build_research_plan` must always include the grounded repository researcher for GitHub/local PR events and documentation search when available. Include Slack or Discord only when healthy and either it is the event origin or impact/context explicitly requests support history. Never include both support connectors merely because tools are registered.

Hold one `ConnectorHealth` instance in `WorkflowContext`, not in a single graph, so authentication/token-type failures suppress construction for later runs until cooldown expiry. The boolean returned by `mark_unavailable` controls the one diagnostic event per connector per run.

If repository capability is absent for a local/GitHub-grounded PR, or documentation search is absent, return a deterministic failed research node naming the missing mandatory capability and do not invoke impact. Optional Slack/Discord omissions continue without failure.

- [ ] **Step 4: Carry the plan through the existing grounding context**

Extend the dict stored by `set_grounding` with `event_source`, serialized capabilities, and `support_research_requested`. Keep `GraphFactory = Callable[[str, str], Any]` unchanged for injected test factories. In `_default_graph_factory`, reconstruct `ResearchCapabilities` from `current_grounding()` and pass it into `build_graph_for_run`.

- [ ] **Step 5: Build only selected agents and lower swarm limits**

Add `plan: ResearchPlan | None = None` as a keyword parameter to `build_doc_research_swarm` so agent construction occurs inside the selected-name branches. Do not construct Slack/Discord agents when omitted; merely omitting them from `agents` is insufficient if construction resolves a model or connector. Use `plan.max_handoffs`, `plan.max_iterations`, `plan.execution_timeout`, and `plan.node_timeout` in `Swarm`.

Add a test that mocks every researcher builder and asserts the Slack/Discord builders were never called for an ordinary GitHub PR.

- [ ] **Step 6: Run research and grounding tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/unit/agents/test_research_capabilities.py tests/unit/agents/test_doc_swarm_grounding.py tests/unit/workflows/test_runner_grounding.py -q`

Expected: PASS and no more than two researcher agents for the normal GitHub case.

- [ ] **Step 7: Commit conditional research**

```bash
git add src/draftly/agents/documentation/research_capabilities.py src/draftly/agents/documentation/research_swarm.py src/draftly/workflows/grounding.py src/draftly/workflows/runner.py tests/unit/agents/test_research_capabilities.py tests/unit/agents/test_doc_swarm_grounding.py tests/unit/workflows/test_runner_grounding.py
git commit -m "perf: skip unavailable and irrelevant research agents"
```

### Task 7: Shared Provider Failure Suppression

**Files:**
- Modify: `src/draftly/models/redis_health.py:1-40`
- Modify: `src/draftly/models/health.py:20-135`
- Modify: `src/draftly/models/router.py:160-275`
- Modify: `src/draftly/models/factory.py`
- Modify: `src/draftly/app/dependencies.py:605-615`
- Modify: `tests/models/test_redis_health.py`
- Modify: `tests/unit/models/test_router_payment_failure.py`
- Modify: `tests/unit/models/test_router_integration.py`
- Modify: `tests/unit/models/test_scoring.py`

**Interfaces:**
- Consumes: existing Redis client, provider failure classification, process-local `ProviderHealthRegistry`, and router fallback chain.
- Produces: `ProviderFailureState`, `RedisProviderHealth.mark_failure(provider, reason, cooldown_seconds)`, `get_failure(provider)`, and router preflight filtering shared by all workers.

- [ ] **Step 1: Write failing typed-health tests**

```python
def test_redis_health_preserves_reason_and_ttl(fake_redis):
    health = RedisProviderHealth(fake_redis, cooldown_seconds=300)
    health.mark_failure("requesty", reason="payment_required", cooldown_seconds=3600)
    state = health.get_failure("requesty")
    assert state.provider == "requesty"
    assert state.reason == "payment_required"
    assert state.retry_after_seconds > 0


async def test_second_resolve_skips_payment_failed_provider_across_router_instances(
    fake_redis, requesty_factory, bedrock_factory, policy
):
    shared = RedisProviderHealth(fake_redis)
    first = router_with_shared_health(
        shared, requesty_factory=requesty_factory, bedrock_factory=bedrock_factory
    )
    requesty_factory.side_effect = PaymentRequiredError("402 payment required")
    model = first.resolve(policy)
    assert model.provider == "bedrock"
    second = router_with_shared_health(
        shared, requesty_factory=requesty_factory, bedrock_factory=bedrock_factory
    )
    second.resolve(policy)
    requesty_factory.assert_called_once()


def test_fast_role_prefers_cheapest_equally_capable_model(stats_store):
    request = RoutingRequest(
        task_type=TaskType.FAST,
        required_capabilities=("tool_calling",),
        estimated_input_tokens=1000,
        estimated_output_tokens=100,
    )
    expensive = model(name="large", quality=0.90, input_cost=10.0, output_cost=30.0)
    cheap = model(name="small", quality=0.90, input_cost=0.60, output_cost=2.50)
    ranked = score_candidates(request, [expensive, cheap], get_profile(TaskType.FAST), stats_store)
    assert ranked[0][0].name == "small"
```

- [ ] **Step 2: Run health/router tests and confirm signature failures**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/models/test_redis_health.py tests/unit/models/test_router_payment_failure.py tests/unit/models/test_router_integration.py -q`

Expected: FAIL because Redis stores only the literal `failed` and the router does not consult it.

- [ ] **Step 3: Store bounded JSON failure state in Redis**

```python
@dataclass(frozen=True)
class ProviderFailureState:
    provider: str
    reason: str
    retry_after_seconds: int

def mark_failure(
    self, provider: str, *, reason: str, cooldown_seconds: float | None = None
) -> None:
    ttl = max(1, int(cooldown_seconds or self._cooldown))
    payload = json.dumps({"provider": provider, "reason": reason})
    self._client.set(f"{PREFIX}{provider}", payload, ex=ttl)
```

Use `ttl()` plus decoded JSON in `get_failure`. Keep `is_healthy` and `clear_failure` backward-compatible. Treat old `failed` values as reason `unknown`.

- [ ] **Step 4: Wire Redis health into router filtering and failure recording**

Allow `ModelRouter` to accept `shared_health: RedisProviderHealth | None`. Before `provider.create_model`, skip a candidate when `shared_health.is_healthy(provider)` is false. On payment/authentication, record a 3,600-second cooldown; on rate limit/unavailable, record 300 seconds. Clear transient failures on success, but do not clear payment/authentication failures until their TTL expires or an operator calls `clear_failure`.

Pass `get_provider_health(app_state)` through the model factory/composition path that constructs the worker router. If Redis is absent, retain the existing process-local behavior.

Keep classifier and notify mapped to `TaskType.FAST`; map the isolated steering judge to `TaskType.FAST` as well. Do not lower the quality floors for research, documentation generation/review, or delivery. The scoring test above proves the fast profile selects the lowest-cost candidate when capability, quality, and reliability are equal.

- [ ] **Step 5: Ensure failure detail is bounded in logs**

Replace full exception serialization with `error_type=type(exc).__name__`, `failure`, provider, model, and a scrubbed message capped at 240 characters. Never log response bodies or headers.

- [ ] **Step 6: Run provider tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/models/test_redis_health.py tests/unit/models/test_router_payment_failure.py tests/unit/models/test_router_integration.py tests/unit/models/test_scoring.py tests/app/test_lifecycle_redis.py -q`

Expected: PASS and the second router instance does not construct the failed provider.

- [ ] **Step 7: Commit shared health suppression**

```bash
git add src/draftly/models/redis_health.py src/draftly/models/health.py src/draftly/models/router.py src/draftly/models/factory.py src/draftly/app/dependencies.py tests/models/test_redis_health.py tests/unit/models/test_router_payment_failure.py tests/unit/models/test_router_integration.py tests/unit/models/test_scoring.py tests/app/test_lifecycle_redis.py
git commit -m "perf: share provider cooldowns across workers"
```

### Task 8: Bounded Run-Cost and Stage Telemetry

**Files:**
- Create: `src/draftly/observability/run_cost.py`
- Create: `tests/observability/test_run_cost.py`
- Modify: `src/draftly/workflows/runner.py:67-110,470-530`
- Modify: `src/draftly/orchestration/hooks/audit.py`
- Modify: `tests/metrics/test_agent_metrics.py`
- Modify: `tests/metrics/test_audit_metrics.py`

**Interfaces:**
- Consumes: graph `execution_order`, nested `AgentResult.metrics.accumulated_usage`, `tool_metrics.call_count/error_count`, routing decisions with provider/model/pricing, audit node durations, run latency, graph status, and Task 1 telemetry flag.
- Produces: `StageCostSummary`, `RunCostSummary`, `summarize_run_cost`, one bounded `workflow_stage_summary` per completed stage, one bounded `workflow_cost_summary` event, and counters/timings.

- [ ] **Step 1: Write failing summary tests**

```python
def test_summary_counts_actual_calls_not_unique_tool_names():
    result = graph_result(
        node("writer", usage=(1000, 200), tools={
            "read_file": metric(call_count=8, error_count=0),
            "append_chunk": metric(call_count=12, error_count=1),
        })
    )
    summary = summarize_run_cost(
        run_id="r1",
        graph_result=result,
        elapsed_ms=4000,
        status="pending_review",
        routing_decisions=[{
            "stage": "writer", "role": "writer", "provider": "bedrock",
            "model": "claude-haiku", "input_cost_per_1m_tokens": 0.60,
            "output_cost_per_1m_tokens": 2.50,
        }],
    )
    assert summary.model_requests >= 1
    assert summary.tool_calls == 20
    assert summary.tool_failures == 1
    assert summary.input_tokens == 1000
    assert summary.output_tokens == 200
    assert summary.estimated_cost_usd == pytest.approx(0.0011)
    assert summary.stages[0].stage == "writer"


def test_serialized_summary_contains_no_authored_content():
    result = graph_result(
        node_with_message(
            "writer",
            message="secret draft sentence",
            usage=(20, 5),
            tools={},
        )
    )
    payload = summarize_run_cost(
        run_id="r1", graph_result=result, elapsed_ms=50, status="pending_review",
        routing_decisions=[],
    ).model_dump()
    assert "secret draft sentence" not in json.dumps(payload)
```

- [ ] **Step 2: Run the tests and confirm the module is absent**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/observability/test_run_cost.py -q`

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement metadata-only summaries**

```python
class StageCostSummary(BaseModel):
    stage: str
    role: str = "unknown"
    provider: str = "unknown"
    model: str = "unknown"
    latency_ms: int = 0
    model_requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: float = 0.0
    tool_calls: int = 0
    tool_failures: int = 0
    steering_decisions: int = 0
    judge_calls: int = 0
    judge_cache_hits: int = 0
    judge_fallbacks: int = 0
    connector_omissions: int = 0
    provider_failovers: int = 0

class RunCostSummary(BaseModel):
    run_id: str
    status: str
    elapsed_ms: int
    model_requests: int
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float
    tool_calls: int
    tool_failures: int
    writer_generations: int
    stages: list[StageCostSummary]
```

For each node, use the sum of SDK cycle/request counters when exposed; otherwise count one request for an agent result with non-zero token usage. Sum `call_count`, not the number of keys in `tool_metrics`. Join routing decisions by stage to capture role/provider/model and call `draftly.models.pricing.estimate_cost` with actual stage token totals. Aggregate steering judge/cache/fallback counters, connector omissions, provider failovers, draft files/bytes, and revision counts from the bounded audit-step metadata. Do not traverse messages, tool inputs, structured outputs, draft bodies, rubric prompts, or exceptions.

- [ ] **Step 4: Publish the summary and metrics after graph completion**

Extend the audit hook's stage-completion callback to build and persist a bounded summary step through the existing `agent_runs` audit repository, then emit:

```python
logger.info("workflow_stage_summary", **stage_summary.model_dump())
```

After graph completion or a review pause, replace the narrow `extract_token_usage` call with `summarize_run_cost`, preserving existing token counters, persist the terminal summary in the same audit repository, and emit exactly one `logger.info("workflow_cost_summary", **summary.model_dump())` event. Ensure the `finally`/finish path also flushes a summary for failed and interrupted runs.

Record `draftly_model_requests_total`, `draftly_estimated_cost_usd_total`, `draftly_tool_calls_total`, `draftly_tool_failures_total`, `draftly_writer_generations_total`, `draftly_run_duration_ms`, and per-stage token/request counters. Do not use unbounded IDs, provider names, or model names as metric labels; those fields belong only in bounded structured logs/audit rows.

- [ ] **Step 5: Run telemetry tests**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/observability/test_run_cost.py tests/metrics/test_agent_metrics.py -q`

Expected: PASS with one summary per completed stage, one terminal summary, estimated cost derived from actual token totals, and unchanged legacy token totals.

- [ ] **Step 6: Commit run-cost telemetry**

```bash
git add src/draftly/observability/run_cost.py src/draftly/workflows/runner.py src/draftly/orchestration/hooks/audit.py tests/observability/test_run_cost.py tests/metrics/test_agent_metrics.py tests/metrics/test_audit_metrics.py
git commit -m "obs: add bounded worker cost summaries"
```

### Task 9: End-to-End Flag Wiring, Regression Tests, and Rollout Proof

**Files:**
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py:80-405`
- Modify: `src/draftly/integrations/strands/graph.py`
- Modify: `src/draftly/workflows/context.py`
- Modify: `tests/graph/test_documentation_graph.py`
- Create: `tests/workflows/test_worker_cost_regression.py`
- Modify: `.env.example:58-66`
- Modify: `docker-compose.redis.yml`
- Modify: `infra/aws/terraform/ecs.tf:70-85`
- Modify: `infra/aws/terraform/variables.tf`
- Modify: `docs/superpowers/specs/2026-09-13-worker-performance-cost-design.md`

**Interfaces:**
- Consumes: all Tasks 1-8 interfaces and existing workflow status/review behavior.
- Produces: a fully flag-gated optimized graph, an offline PR #17-shaped regression fixture, rollout instructions, and measurable acceptance assertions.

- [ ] **Step 1: Write failing optimized-run regression tests**

Build an offline fixture with ten affected docs, one unavailable Slack connector, one payment-disabled provider, and one missing requirement in one file. Use counting fake models and real graph routes:

```python
async def test_balanced_profile_bounds_cost_and_revision_scope(worker_harness):
    result = await worker_harness.run(
        event=pr17_shaped_event(),
        flags=all_performance_flags(True),
        slack_failure="not_allowed_token_type",
        disabled_provider="requesty",
        missing_requirement_file="docs/configuration.md",
    )
    assert result.status == "pending_review"
    assert result.writer_generations <= 2
    assert result.revised_files == ["docs/configuration.md"]
    assert all(count <= 1 for count in result.optional_judge_calls_by_stage.values())
    assert result.connector_failures <= 1
    assert result.provider_failures <= 1
    assert result.raw_stdout == ""
```

Also add a compatibility test with every flag false that asserts the current agent/tool topology and legacy evaluator path remain selected.

- [ ] **Step 2: Run the regression test and confirm graph wiring failures**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/workflows/test_worker_cost_regression.py -q`

Expected: FAIL until config reaches `build_graph_for_run` and each branch is selected by its own flag.

- [ ] **Step 3: Thread one immutable config snapshot through graph construction**

Pass `context.config.strands` into `build_graph_for_run` and `build_documentation_graph`. Do not read environment variables in agents, nodes, repositories, or tools. At each branch, select new behavior only when its corresponding flag is true:

```python
evaluator = EvaluatorNode(
    rubric_grader=rubric_grader,
    drafts_repo=drafts_repo,
    structured_requirements=config.structured_evaluation_requirements,
    targeted_revisions=config.targeted_draft_revisions,
    max_iterations=1 if config.targeted_draft_revisions else config.evaluator_max_iterations,
)
```

Assert invalid combinations at graph construction: `targeted_draft_revisions` requires `structured_evaluation_requirements`; `batch_draft_tools` requires `targeted_draft_revisions`. Raise `ValueError` naming both flags rather than silently mixing contracts.

- [ ] **Step 4: Add rollout profile and rollback notes**

Add these default-false names to `.env.example`, pass them through the `rq-worker` environment in `docker-compose.redis.yml`, and add corresponding boolean Terraform variables rendered with `tostring(var.worker_flag_name)` in the ECS worker environment. Add a “Rollout record” section to the spec with this exact order:

1. `STRANDS_RUN_COST_SUMMARY` and `STRANDS_SILENT_AGENT_CALLBACKS`.
2. `STRANDS_SELECTIVE_STEERING_JUDGE`.
3. `STRANDS_STRUCTURED_EVALUATION_REQUIREMENTS`.
4. `STRANDS_TARGETED_DRAFT_REVISIONS`.
5. `STRANDS_CAPABILITY_AWARE_RESEARCH`.
6. `STRANDS_BATCH_DRAFT_TOOLS`.
7. `STRANDS_PROVIDER_WARMUP` then `STRANDS_WRITER_MIDDLE_TIER` (warm-up first — it only removes latency; tier routing is the last latency lever enabled because it touches model selection).

The composite is `DRAFTLY_FASTPATH=true`, which enables steps 2, 5, 6, and the two step-7 flags together while leaving steps 1, 3, and 4 independently controllable.

For every step, rollback is setting that flag false and restarting workers; no data deletion or migration rollback is required.

- [ ] **Step 5: Run focused and full offline suites**

Run: `DRAFTLY_LIVE=0 uv run pytest tests/workflows/test_worker_cost_regression.py tests/graph/test_documentation_graph.py tests/nodes/test_evaluator.py tests/steering tests/models tests/unit/models -q`

Expected: PASS.

Run: `DRAFTLY_LIVE=0 uv run pytest -q`

Expected: PASS with no live network calls.

- [ ] **Step 6: Build the worker image and verify imports/configuration**

Run: `docker compose -f docker-compose.redis.yml -f docker-compose.realpr.yml build rq-worker`

Expected: exit code 0 and the worker image installs every new module.

Run: `docker compose -f docker-compose.redis.yml -f docker-compose.realpr.yml run --rm rq-worker python -c 'from draftly.app.config import Settings; c=Settings().strands; assert not c.selective_steering_judge; print("worker-config-ok")'`

Expected: prints `worker-config-ok` and exits 0.

- [ ] **Step 7: Update the knowledge graph**

Run: `graphify update .`

Expected: completes successfully and refreshes `graphify-out/` for the new modules and relationships. Review `git status --short`; stage only graph files changed by this implementation and do not discard pre-existing dirty graph output.

- [ ] **Step 8: Commit end-to-end wiring**

```bash
git add src/draftly/orchestration/graphs/documentation_graph.py src/draftly/integrations/strands/graph.py src/draftly/workflows/context.py tests/graph/test_documentation_graph.py tests/workflows/test_worker_cost_regression.py .env.example docker-compose.redis.yml infra/aws/terraform/ecs.tf infra/aws/terraform/variables.tf docs/superpowers/specs/2026-09-13-worker-performance-cost-design.md graphify-out
git commit -m "perf: wire balanced worker cost profile"
```

- [ ] **Step 9: Validate the live canary against the captured baseline**

Run one opt-in canary for a PR comparable to captured run `ed42b4f0-af37-11f1-9b9f-1f0c968485fe`. Query `worker_run_cost_summary` and compare it with the baseline: 68 writer tool calls, two writer generations begun, and more than 8 minutes before review.

The canary passes only when all are true:

- Model requests are at least 60% lower than the captured baseline count.
- Status reaches `pending_review` within 480,000 ms.
- A no-gap run has exactly one writer generation.
- Every stage has zero or one optional judge call.
- Each unhealthy connector/provider records no more than one failed attempt.
- Worker stdout contains no `Tool #`, `Let me`, or raw assistant reasoning lines.
- Evaluation/revision logs contain file paths and requirement IDs but no authored body content.
- The writer stage completes in ≤ five minutes and the full automated pipeline (including delivery, excluding human gate wait) completes within fifteen minutes, while `pending_review` still arrives within eight minutes.
- When `provider_warmup` is on, `draftly_writer_first_call_seconds` (impact-end to first writer event) shows no multi-minute cold-start gap.

If any check fails, turn off only the flag introduced at that rollout step, retain `run_cost_summary`, and use the emitted stage summary to identify the regression before continuing.

---

## Task: Writer Tier Routing (spec §9.1)

**Files:**
- Modify: `src/draftly/models/factory.py:628-668,680-770`
- Modify: `src/draftly/app/config.py:8-52,160-211` (`writer_middle_tier`, `DRAFTLY_FASTPATH`)
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py:272`
- Modify: `src/draftly/agents/documentation/writer.py` (capability-aware plan/finalize calls)
- Add: `tests/unit/models/test_writer_tier_routing.py`

**Interfaces:**
- Consumes: existing `resolve_model_for_role`, role policy tuples, and per-call `KNOWN_CAPABILITIES` routing.
- Produces: `writer_middle_tier: bool`; with it true, writer plan and sealed generation resolve to `reasoning` and the drafting tool loop resolves to the `research` chain.

- [ ] **Step 1: RED** — add `tests/unit/models/test_writer_tier_routing.py`: with `writer_middle_tier=false` the writer role resolves exactly as today; with `true`, the tool-loop capability resolves to the `research` chain while the plan/finalize capability resolves to `reasoning`. Expect FAIL (factory and config do not read the flag yet).
- [ ] **Step 2:** implement capability-aware selection in `factory.py` and add `writer_middle_tier` + composite `DRAFTLY_FASTPATH` to `config.py`.
- [ ] **Step 3:** wire the flag through `documentation_graph.py:272` `writer_model` construction; extend `tests/workflows/test_worker_cost_regression.py` so flag-false topology is unchanged.
- [ ] **Step 4:** run `DRAFTLY_LIVE=0 uv run pytest tests/unit/models/test_writer_tier_routing.py tests/graph/test_documentation_graph.py tests/workflows/test_worker_cost_regression.py -q` → PASS; then `DRAFTLY_LIVE=0 uv run pytest -q` → PASS.
- [ ] **Step 5:** benchmark with `scripts/bench_pipeline.py` (spec L1): writer stage must move toward ≤ five minutes without evaluate escalation on the benchmark PR. Quality regression reverts `writer_middle_tier` first.
- [ ] **Step 6:** run `graphify update .`, then commit.

## Task: Provider Warm-Up Probe (spec §9.2)

**Files:**
- Modify: `src/draftly/workflows/runner.py` (fire after impact stage completes)
- Modify: `src/draftly/app/config.py` (`provider_warmup`)
- Add: `src/draftly/observability/warmup.py`
- Add: `tests/unit/workflows/test_warmup_probe.py`

**Interfaces:**
- Consumes: resolved writer plan model/provider, health filter, run id.
- Produces: non-blocking 1-token completion with a 5-second timeout, never counted as a model attempt; counters `draftly_warmup_probe_started_total`, `draftly_warmup_probe_failed_total`.

- [ ] **Step 1: RED** — `tests/unit/workflows/test_warmup_probe.py`: probe fires after impact when `provider_warmup` is true; skips when the target provider is unhealthy or the flag is false; a probe timeout never blocks graph progress; probe attempts are excluded from telemetry. Expect FAIL (no module/hook).
- [ ] **Step 2:** implement `observability/warmup.py` and the runner hook after the impact step.
- [ ] **Step 3:** run `DRAFTLY_LIVE=0 uv run pytest tests/unit/workflows/test_warmup_probe.py -q` → PASS; then full suite → PASS.
- [ ] **Step 4:** canary benchmark: `draftly_writer_first_call_seconds` must show no multi-minute silent gap with the flag on; rollback is `provider_warmup=false`.
- [ ] **Step 5:** run `graphify update .`, then commit.

> All steps use `DRAFTLY_LIVE=0` for offline suites. Live canary runs are opt-in and recorded against the `ed42b4f0-af37-11f1-9b9f-1f0c968485fe` baseline.

## Task: Benchmark Harness (measurement gate for the latency lanes)

**Files:**
- Add: `scripts/bench_pipeline.py`
- Add: `bench/.gitkeep`

**Interfaces:**
- Consumes: RQ job trigger for the benchmark PR (authly `feat/001-oauth-login`), node latency from `worker_run_cost_summary` / `audit_step_end`, `/metrics` (`draftly_node_runtime_seconds`, `draftly_writer_first_call_seconds`, `draftly_steering_judge_*`).
- Produces: `bench/run-<id>.json` per-segment seconds (classify→impact, writer gap, writer, evaluate, changelog, automated total); `bench/compare.py` prints a baseline-vs-current diff.

- [ ] **Step 1:** implement `scripts/bench_pipeline.py` to re-trigger the benchmark PR, poll for `pending_review`/execution, pull per-segment durations, and write `bench/run-<id>.json`; add `bench/compare.py`.
- [ ] **Step 2:** capture `bench/run-baseline.json` from the current deployed worker (pre-lane baseline) and record it in the commit.
- [ ] **Step 3:** verify a dry pass: `DRAFTLY_LIVE=0 uv run python scripts/bench_pipeline.py --validate` exits 0 against a fixture; full suite remains green.
- [ ] **Step 4:** run `graphify update .`, then commit.
