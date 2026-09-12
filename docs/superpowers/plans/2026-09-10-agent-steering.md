# Draftly Agent Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, policy-driven Strands steering to every runtime AI agent in `draftly-agent-backend`, including dynamically created subagents and onboarding-stage agents.

**Architecture:** A centralized `build_draftly_agent()` helper installs one fresh role-aware `SteeringHandler` per application agent. `WorkflowContext` supplies a per-run `SteeringRuntime`; deterministic policy checks run before optional LLM judging, while the runner/repositories persist bounded attempts, steering audit, and human interventions. Existing `ReviewGate` remains separate from steering and continues to own final review.

**Tech Stack:** Python 3.11, Strands Agents 1.52.0, FastAPI, Pydantic v2, asyncpg/CockroachDB-compatible SQL migrations, Redis Streams/SSE, pytest, and structlog.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-steering-design.md`

## Global Constraints

- Every application-created Strands agent across every workflow surface receives exactly one fresh role-configured steering handler.
- Tool steering supports only the Strands actions `Proceed`, `Guide`, and `Interrupt`; model steering supports only `Proceed` and `Guide`.
- Deterministic authorization, tenant-scope, secret, destination, and side-effect checks run before any optional LLM judge.
- The internal LLM steering judge has no application tools/plugins and is never recursively steered.
- Automatic tool guides and model retries are bounded by durable counters: 2 tool guides per call, 2 model guides per turn, and 5 total guides per agent invocation.
- `pending_review` and `ReviewGate` remain distinct from `pending_intervention` and generalized steering responses.
- Steering audit and SSE payloads are redacted and bounded; never persist raw credentials, prompts, unrestricted repository content, or raw tool payloads.
- Human intervention responses are organization/project-authorized, idempotent, concurrency-safe, and resume the exact interrupt ID at most once.
- Side-effecting actions fail closed when policy, persistence, authorization, or judge safety is uncertain.
- Preserve existing agent factory signatures through optional keyword-only runtime arguments where compatibility is required; application graph code must pass a real runtime.
- Do not construct a Strands agent from an API request.
- Do not modify unrelated dirty changes in `draftly-agent-backend`; keep backend commits inside that nested repository and the plan document in the root repository.
- After modifying backend code, run `graphify update .` from `draftly-agent-backend` before final verification.

## File Structure

**Backend (`draftly-agent-backend/`):**

- Create `src/draftly/steering/decisions.py` — typed phases, roles, internal decisions, Strands action adapter, and policy errors.
- Create `src/draftly/steering/redaction.py` — bounded recursive redaction for audit, events, and judge context.
- Create `src/draftly/steering/policy.py` — versioned role policies, deterministic checks, limits, and failure matrix.
- Create `src/draftly/steering/context.py` — per-run `SteeringRuntime` and per-agent identity scopes.
- Create `src/draftly/steering/persistence.py` — repository protocols and transaction-facing steering sinks.
- Create `src/draftly/steering/handler.py` — Strands `SteeringHandler` adapter and optional isolated LLM judge integration.
- Create `src/draftly/persistence/migrations/057_agent_steering.sql` — intervention/attempt tables and the additive `pending_intervention` status constraint.
- Create `src/draftly/persistence/repositories/steering.py` — async repositories for attempts and interventions.
- Create `src/draftly/app/api/steering_schemas.py` — request/response models for interventions and steering events.
- Modify `src/draftly/app/config.py` — steering feature flags, limits, rollout, redaction, and judge settings.
- Modify `src/draftly/workflows/context.py` — carry steering runtime dependencies and expose per-agent runtime creation.
- Modify `src/draftly/app/composition/workflows.py` and `src/draftly/app/dependencies.py` — compose steering repositories/runtime dependencies.
- Modify `src/draftly/integrations/strands/graph.py` and graph builders under `src/draftly/orchestration/graphs/` — pass per-run and per-agent steering context.
- Modify all runtime agent factories under `src/draftly/agents/` — use the centralized constructor.
- Modify `src/draftly/workflows/onboarding/stages.py` — route pooled/per-call onboarding agents through the centralized constructor.
- Modify `src/draftly/workflows/runner.py` and `src/draftly/workflows/state.py` — persist/resume steering interventions and expose the new status.
- Modify `src/draftly/persistence/repositories/agent_runs.py` — write steering audit steps through the existing step contract.
- Modify `src/draftly/events/stream_envelope.py` — shape redacted `steering` envelopes.
- Modify `src/draftly/app/api/routes/workflow_runs.py`, create an intervention route module, and update route registration — expose authorized intervention responses and status.
- Modify API/run schemas and migration tests wherever `RunStatus` or workflow status literals are enumerated.
- Create/modify tests under `tests/steering/`, `tests/agents/`, `tests/graph/`, `tests/workflows/`, `tests/persistence/`, `tests/api/`, and `tests/events/` for unit, integration, restart, idempotency, and replay behavior.

**Runtime agent construction sites to migrate:**

- `src/draftly/agents/draftly_agent.py`
- `src/draftly/agents/shared/{classifier,context,delivery,github_delivery,memory_curator,research}.py`
- `src/draftly/agents/documentation/{analyzer,changelog,context,researcher,research_swarm,reviewer,writer}.py`
- `src/draftly/agents/github/{context,issue_analyzer,issue_researcher,issue_responder,research_swarm}.py`
- `src/draftly/agents/support/{answer_writer,question_analyzer,research_swarm,solution_researcher,support_reviewer}.py`
- `src/draftly/agents/content/{blog_writer,judge,social_adapter,strategist}.py`
- `src/draftly/agents/notify.py`
- `src/draftly/workflows/onboarding/stages.py` (`_llm_generate`, `_agent_pool`, and recommendation construction).

`tests/scripts/probe_models.py` and test doubles are not production runtime construction paths; leave them outside the enforcement allowlist, while preserving their tests.

---

### Task 1: Add steering domain contracts and configuration

**Files:**
- Create: `draftly-agent-backend/src/draftly/steering/__init__.py`
- Create: `draftly-agent-backend/src/draftly/steering/decisions.py`
- Create: `draftly-agent-backend/src/draftly/steering/context.py`
- Create: `draftly-agent-backend/src/draftly/steering/policy.py`
- Create: `draftly-agent-backend/src/draftly/steering/redaction.py`
- Modify: `draftly-agent-backend/src/draftly/app/config.py`
- Test: `draftly-agent-backend/tests/steering/test_contracts.py`
- Test: `draftly-agent-backend/tests/app/test_steering_config.py`

**Interfaces:**
- Consumes: existing `StrandsConfig`, `WorkflowContext` identity conventions, and Strands 1.52.0 action classes.
- Produces: `AgentRole`, `SteeringPhase`, `DecisionKind`, `SteeringDecision`, `SteeringLimits`, `SteeringRuntimeConfig`, `AgentIdentity`, `SteeringRuntime`, `RolePolicy`, and `redact_value()` for all later tasks.

- [ ] **Step 1: Write failing contract tests**

```python
def test_tool_decision_maps_to_strands_action():
    decision = SteeringDecision.guide(phase=SteeringPhase.BEFORE_TOOL, reason="narrow scope")
    action = decision.to_strands_action()
    assert type(action).__name__ == "Guide"
    assert action.reason == "narrow scope"


def test_model_interrupt_is_rejected():
    with pytest.raises(ValueError, match="model steering cannot interrupt"):
        SteeringDecision.interrupt(phase=SteeringPhase.AFTER_MODEL, reason="unsafe")


def test_redaction_is_bounded_and_removes_secret_keys():
    value = {"token": "secret", "nested": {"password": "pw", "ok": "x"}}
    assert redact_value(value, max_bytes=80) == {
        "token": "[REDACTED]",
        "nested": {"password": "[REDACTED]", "ok": "x"},
    }
```

Also test that `SteeringLimits` rejects negative values, `AgentIdentity` requires `run_id`, `agent_id`, `node_id`, and `role`, and `SteeringRuntime.for_agent()` returns a new identity scope without mutating the parent runtime.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_contracts.py tests/app/test_steering_config.py -v
```

Expected: FAIL because the steering package and configuration fields do not exist.

- [ ] **Step 3: Implement the typed contracts and settings**

Use `StrEnum` values for roles/phases and immutable dataclasses. `SteeringDecision.to_strands_action()` must map tool decisions to the imported Strands `Proceed`, `Guide`, or `Interrupt`, and reject `Interrupt` for `AFTER_MODEL`. Add these `StrandsConfig` fields with the stated defaults:

```python
steering_enabled: bool = False
steering_enforcement_enabled: bool = False
steering_policy_version: str = "v1"
steering_llm_enabled: bool = False
steering_tool_guides_per_call: int = 2
steering_model_guides_per_turn: int = 2
steering_total_guides_per_agent: int = 5
steering_judge_timeout_seconds: float = 10.0
steering_reason_max_chars: int = 1_000
steering_payload_max_bytes: int = 4 * 1024
```

Expose the same values through the existing `Settings.strands` property using the existing `strands_*` environment naming pattern. `SteeringRuntime.disabled()` must provide safe no-op sinks for offline tests.

- [ ] **Step 4: Run contract and configuration tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_contracts.py tests/app/test_steering_config.py tests/unit/models/test_config_fields.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the domain boundary**

```bash
cd draftly-agent-backend
git add src/draftly/steering src/draftly/app/config.py tests/steering/test_contracts.py tests/app/test_steering_config.py
git commit -m "feat: define agent steering contracts and config"
```

### Task 2: Implement role policies and deterministic checks

**Files:**
- Modify: `draftly-agent-backend/src/draftly/steering/policy.py`
- Modify: `draftly-agent-backend/src/draftly/steering/decisions.py`
- Test: `draftly-agent-backend/tests/steering/test_policy.py`

**Interfaces:**
- Consumes: Task 1 contracts and role/limit configuration.
- Produces: `policy_for(role: AgentRole) -> RolePolicy`, `RolePolicy.evaluate_tool(runtime: SteeringRuntime, tool_name: str, tool_use: Mapping[str, Any]) -> SteeringDecision`, `RolePolicy.evaluate_model(runtime: SteeringRuntime, message: Message, stop_reason: str) -> SteeringDecision`, and `PolicyViolation`/`SteeringFailure` exceptions.

- [ ] **Step 1: Write failing policy tests**

```python
def test_delivery_policy_interrupts_destination_mismatch(runtime, tool_use):
    decision = policy_for(AgentRole.DELIVERY).evaluate_tool(
        runtime=runtime, tool_name="create_comment",
        tool_use={**tool_use, "destination_project": "other-project"},
    )
    assert decision.kind is DecisionKind.INTERRUPT


def test_research_policy_guides_out_of_scope_read(runtime, tool_use):
    decision = policy_for(AgentRole.RESEARCH).evaluate_tool(
        runtime=runtime, tool_name="read_file",
        tool_use={**tool_use, "repo_dir": "/outside/checkout"},
    )
    assert decision.kind is DecisionKind.GUIDE


def test_guide_limit_exhaustion_is_fail_closed_for_delivery(runtime, tool_use):
    runtime.attempts.reserve_tool_guide = AsyncMock(return_value=False)
    decision = await policy_for(AgentRole.DELIVERY).evaluate_tool_async(
        runtime=runtime, tool_name="create_comment", tool_use=tool_use,
    )
    assert decision.kind is DecisionKind.INTERRUPT
```

Cover valid `Proceed`, invalid argument `Guide`, unsafe scope `Interrupt` for side-effecting roles, missing evidence, model `Guide`, judge-unavailable fallback, and each limit in the design matrix.

- [ ] **Step 2: Run policy tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_policy.py -v
```

Expected: FAIL because role policies and durable-attempt adapters are not implemented.

- [ ] **Step 3: Implement explicit versioned policies**

Define a `RolePolicy` with `side_effecting: bool`, `model_judge_enabled: bool`, `read_only_tool_names`, `required_evidence`, and `failure_mode`. Make `evaluate_tool_async()` run argument/scope/evidence checks before any judge callback. Use `DecisionKind.PROCEED`, `GUIDE`, or `INTERRUPT`; never return a model interrupt. The policy must call `runtime.attempts` before emitting an automatic guide and use the terminal action from the role’s failure mode when the limit is exhausted.

Keep tool names and scope checks data-driven but explicit. Delivery/notification/publishing tools must require destination and idempotency metadata; repository tools must require the runtime checkout root; support tools must require tenant/source scope.

- [ ] **Step 4: Run policy tests and existing role tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_policy.py tests/unit/agents/test_agents.py tests/agents/test_notify_agent.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit deterministic steering policy**

```bash
cd draftly-agent-backend
git add src/draftly/steering/decisions.py src/draftly/steering/policy.py tests/steering/test_policy.py
git commit -m "feat: add role-aware deterministic steering policies"
```

### Task 3: Add durable attempt and intervention persistence

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/057_agent_steering.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/steering.py`
- Modify: `draftly-agent-backend/src/draftly/steering/persistence.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Test: `draftly-agent-backend/tests/persistence/test_steering_migrations.py`
- Test: `draftly-agent-backend/tests/persistence/test_steering_repository.py`

**Interfaces:**
- Consumes: Task 1 identity/limit types and existing migration/repository patterns in `agent_runs.py`, `workflows.py`, and `reviews.py`.
- Produces: `SteeringAttemptsRepository.reserve(key: AttemptKey, limit: int) -> bool`, `SteeringInterventionsRepository.create_pending(record: InterventionRecord) -> InterventionRecord`, `claim_response(run_id: str, interrupt_id: str, org_id: str, idempotency_key: str, action: str, message: str | None) -> InterventionRecord`, `resolve(intervention_id: str, status: str) -> InterventionRecord`, `get_pending(run_id: str, interrupt_id: str, org_id: str) -> InterventionRecord | None`, and repository wiring on `RepositoryDependencies`.

- [ ] **Step 1: Write failing migration/repository tests**

```python
def test_steering_migration_defines_intervention_and_attempt_tables():
    sql = Path("src/draftly/persistence/migrations/057_agent_steering.sql").read_text()
    assert "workflow_interventions" in sql
    assert "steering_attempts" in sql
    assert "pending_intervention" in sql
    assert "UNIQUE (run_id, interrupt_id)" in sql


async def test_claim_response_is_idempotent_and_single_writer(repo):
    first = await repo.claim_response(
        run_id="run-1", interrupt_id="int-1", idempotency_key="req-1",
        action="approve", message="go",
    )
    second = await repo.claim_response(
        run_id="run-1", interrupt_id="int-1", idempotency_key="req-1",
        action="approve", message="go",
    )
    assert first.id == second.id
    assert second.status == "approved"
```

Test concurrent claims, mismatched interrupt IDs, already-resolved rows, expiry, organization scoping, and atomic attempt reservation at the configured limits.

- [ ] **Step 2: Run persistence tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/persistence/test_steering_migrations.py tests/persistence/test_steering_repository.py -v
```

Expected: FAIL because migration `057` and repository methods do not exist.

- [ ] **Step 3: Add the additive migration**

Create `057_agent_steering.sql` with:

```sql
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_status_check CHECK (
    status IN ('queued', 'running', 'pending_review', 'pending_intervention',
               'completed', 'failed', 'cancelled', 'skipped')
);

CREATE TABLE IF NOT EXISTS steering_attempts (
        run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    model_turn INTEGER NOT NULL DEFAULT 0,
    guide_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, agent_id, node_id, phase, tool_name, model_turn)
);

CREATE TABLE IF NOT EXISTS workflow_interventions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    interrupt_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    workflow_key TEXT,
    agent_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied',
        'guided', 'expired', 'cancelled')),
    reason JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT,
    resolver_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    UNIQUE (run_id, interrupt_id),
    UNIQUE (org_id, idempotency_key)
);
```

Add indexes on `(org_id, status, created_at DESC)` and `(run_id, status)`. Use the project’s existing migration loader conventions and avoid destructive data rewrites.

- [ ] **Step 4: Implement repositories and dependency wiring**

`reserve()` must use one SQL upsert/update transaction that increments `guide_count` only when the prior count is below the requested limit and returns a boolean reservation. `claim_response()` must lock the pending row, return the existing resolved row for the same idempotency key, and reject a different response after resolution. All queries include `org_id` or derive it from the authorized run lookup.

Expose repositories through `RepositoryDependencies`, and add a `SteeringPersistence` adapter implementing the protocols consumed by `SteeringRuntime`.

- [ ] **Step 5: Run migration/repository tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/persistence/test_steering_migrations.py tests/persistence/test_steering_repository.py tests/persistence/test_workflow_resources.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit durable steering storage**

```bash
cd draftly-agent-backend
git add src/draftly/persistence/migrations/057_agent_steering.sql src/draftly/persistence/repositories/steering.py src/draftly/steering/persistence.py src/draftly/app/dependencies.py tests/persistence/test_steering_migrations.py tests/persistence/test_steering_repository.py
git commit -m "feat: persist steering attempts and interventions"
```

### Task 4: Implement the Strands steering handler and audit adapter

**Files:**
- Create: `draftly-agent-backend/src/draftly/steering/handler.py`
- Modify: `draftly-agent-backend/src/draftly/steering/context.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/agent_runs.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/hooks/audit.py`
- Test: `draftly-agent-backend/tests/steering/test_handler.py`
- Test: `draftly-agent-backend/tests/orchestration/hooks/test_steering_audit.py`

**Interfaces:**
- Consumes: Tasks 1–3 policies, runtime, redaction, and persistence sinks; Strands `SteeringHandler` callback signatures.
- Produces: `DraftlySteeringHandler(runtime: SteeringRuntime, policy: RolePolicy, judge: Any | None = None)`, async `steer_before_tool(*, agent: Agent, tool_use: ToolUse, **kwargs) -> Proceed | Guide | Interrupt`, async `steer_after_model(*, agent: Agent, message: Message, stop_reason: str, **kwargs) -> Proceed | Guide`, and `record_decision(decision: SteeringDecision) -> None` behavior used by the constructor and runner.

- [ ] **Step 1: Write failing handler tests with fake agent/tool events**

```python
async def test_before_tool_guide_returns_strands_guide_and_audits(runtime, policy):
    handler = DraftlySteeringHandler(runtime=runtime, policy=policy)
    action = await handler.steer_before_tool(
        agent=FakeAgent(), tool_use={"name": "read_file", "path": "bad"},
    )
    assert type(action).__name__ == "Guide"
    runtime.audit.record_step.assert_awaited_once()


async def test_after_model_only_returns_proceed_or_guide(runtime, policy):
    handler = DraftlySteeringHandler(runtime=runtime, policy=policy)
    action = await handler.steer_after_model(
        agent=FakeAgent(), message={"role": "assistant", "content": "draft"},
        stop_reason="end_turn",
    )
    assert type(action).__name__ in {"Proceed", "Guide"}
```

Test policy exceptions, audit failure, guide-limit exhaustion, redaction, and interruption creation. Assert tool interrupts include a stable `interrupt_id` in the handler metadata/reason and call the intervention sink before returning the Strands `Interrupt`.

- [ ] **Step 2: Run handler tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_handler.py tests/orchestration/hooks/test_steering_audit.py -v
```

Expected: FAIL because `DraftlySteeringHandler` and the steering audit path do not exist.

- [ ] **Step 3: Implement handler callbacks around the public Strands contract**

Subclass `strands.vended_plugins.steering.SteeringHandler` (or the exact import path available in 1.52.0) and keep the public methods keyword-compatible:

```python
async def steer_before_tool(self, *, agent, tool_use, **kwargs):
    return await self._handle_tool(agent=agent, tool_use=tool_use, **kwargs)


async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
    return await self._handle_model(
        agent=agent, message=message, stop_reason=stop_reason, **kwargs,
    )
```

If the SDK invokes callbacks synchronously, provide synchronous wrappers that schedule/await the same runtime operation according to the installed signature; do not change the public return types. Deterministic policy runs first. An optional judge can only refine a safe deterministic `Proceed`/`Guide`; it cannot override a deterministic side-effect `Interrupt`.

For `Guide`, return Strands `Guide(reason=redacted_reason)`; for `Interrupt`, create the durable intervention before returning `Interrupt(reason=redacted_reason)`. Record every decision to `agent_steps` as `kind="steering"` with phase/action/role/rule/attempt metadata after redaction. Persistence errors fail closed for side-effecting roles.

- [ ] **Step 4: Add audit adapter and run focused tests**

Extend the existing `AgentRunsRepository.record_step` detail contract without changing legacy callers. Add a small audit helper that accepts `SteeringDecision` and writes bounded JSON. Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_handler.py tests/orchestration/hooks/test_steering_audit.py tests/workflows/test_audit_hook.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the Strands adapter**

```bash
cd draftly-agent-backend
git add src/draftly/steering/handler.py src/draftly/steering/context.py src/draftly/persistence/repositories/agent_runs.py src/draftly/orchestration/hooks/audit.py tests/steering/test_handler.py tests/orchestration/hooks/test_steering_audit.py
git commit -m "feat: integrate durable steering with Strands hooks"
```

### Task 5: Add the centralized agent constructor and migrate all factories

**Files:**
- Create: `draftly-agent-backend/src/draftly/agents/factory.py`
- Modify: every production factory listed in the File Structure section
- Modify: `draftly-agent-backend/src/draftly/agents/subagents.py` where factory kwargs are forwarded
- Test: `draftly-agent-backend/tests/steering/test_agent_factory.py`
- Modify: `draftly-agent-backend/tests/unit/agents/test_agents.py`

**Interfaces:**
- Consumes: `DraftlySteeringHandler`, `SteeringRuntime`, and existing factory options/plugins/tools.
- Produces: `build_draftly_agent(*, role, system_prompt, model, tools=(), plugins=(), runtime, agent_id, node_id, structured_output_model=None, interventions=(), **agent_options) -> Agent`.

- [ ] **Step 1: Write failing constructor and coverage tests**

```python
def test_constructor_preserves_plugins_and_adds_one_steering_handler(runtime):
    agent = build_draftly_agent(
        role=AgentRole.WRITER, system_prompt="write", model=StubModel(),
        plugins=[existing_plugin], runtime=runtime,
        agent_id="writer", node_id="write",
    )
    assert existing_plugin in agent.plugins
    assert sum(isinstance(p, DraftlySteeringHandler) for p in agent.plugins) == 1


def test_all_production_agent_sites_use_the_constructor():
    source_root = Path("src/draftly")
    offenders = []
    for path in source_root.rglob("*.py"):
        if path.name in {"factory.py", "handler.py"}:
            continue
        if "Agent(" in path.read_text() and "tests" not in str(path):
            offenders.append(str(path))
    assert offenders == []
```

The coverage test must explicitly allow only the isolated Strands LLM judge implementation if the installed package source is visible outside Draftly; no Draftly application module is exempt.

- [ ] **Step 2: Run constructor tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_agent_factory.py tests/unit/agents/test_agents.py -v
```

Expected: FAIL because the helper does not exist and direct construction remains.

- [ ] **Step 3: Implement the helper**

Build an agent-scoped runtime with `runtime.for_agent(agent_id=agent_id, node_id=node_id, role=role)`. Preserve all caller-provided `plugins`, `interventions`, structured output, session manager, callbacks, and limits. When `runtime.config.steering_enabled` is false, install a no-op handler that still satisfies the coverage invariant but never changes behavior. Do not mutate a constructed `Agent`; plugins must be present in the constructor call.

- [ ] **Step 4: Migrate registered factories and swarms**

Replace each direct Strands `Agent` construction in the listed production factory modules with `build_draftly_agent`. Add keyword-only `runtime=None`, `agent_id`, and `node_id` parameters where necessary, defaulting only to `SteeringRuntime.disabled()` for legacy unit callers. Forward runtime/identity through research swarm builders so local, GitHub, Slack, Discord, docs, support, and issue researchers all receive handlers.

Do not use `LLMSteeringHandler` for the application agents in this task; the isolated judge wiring is Task 8. Preserve the delivery factory’s existing `HumanInTheLoop` behavior and its `hitl=False` graph configuration.

- [ ] **Step 5: Migrate onboarding-stage agents**

Change `_llm_generate`, `_agent_pool`, and `run_recommendations` in `src/draftly/workflows/onboarding/stages.py` to accept and forward `SteeringRuntime`, `agent_id`, and `node_id`. Every pooled extraction/evaluation agent and the recommendation agent must use `build_draftly_agent`; pooled agents must receive distinct identities such as `onboarding-extraction-0` while sharing only the parent run runtime. Keep the current bounded pool/concurrency behavior.

- [ ] **Step 6: Run full construction coverage and factory tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_agent_factory.py tests/unit/agents/test_agents.py tests/agents tests/unit/agents tests/unit/workflows/test_onboarding_stages.py -q
```

Expected: PASS with no direct production `Agent` construction offenders and no changed structured-output/plugin behavior.

- [ ] **Step 7: Commit the construction migration**

```bash
cd draftly-agent-backend
git add src/draftly/agents src/draftly/workflows/onboarding/stages.py tests/steering/test_agent_factory.py tests/unit/agents/test_agents.py
git commit -m "feat: steer every Draftly agent through one constructor"
```

### Task 6: Wire per-run steering context through composition and graphs

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/context.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/strands/graph.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py` (`_default_graph_factory` runtime creation)
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/issue_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/support_graph.py`
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/content_graph.py`
- Test: `draftly-agent-backend/tests/steering/test_runtime_wiring.py`
- Test: `draftly-agent-backend/tests/graph/test_surface_graphs.py`

**Interfaces:**
- Consumes: Task 5 factory runtime parameters and existing `build_graph_for_run()`/`WorkflowContext` dependencies.
- Produces: `WorkflowContext.steering_runtime_factory`, `WorkflowContext.new_steering_runtime(run_id, surface, org_id, project_id, workflow_key) -> SteeringRuntime`, and graph calls that assign stable `(agent_id, node_id, role)` identities to every agent.

- [ ] **Step 1: Write failing wiring tests**

```python
def test_build_graph_for_run_passes_distinct_agent_runtime(
    monkeypatch, fake_context, fake_tools, fake_model, fake_agents,
):
    captured = {}

    def fake_builder(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setitem(graph_module._BUILDERS, "pull_request", fake_builder)
    runtime = fake_context.new_steering_runtime(
        "run-1", "pull_request", "org-1", "project-1", "docs",
    )
    graph_module.build_graph_for_run(
        run_id="run-1", surface="pull_request", tools_registry=fake_tools,
        model=fake_model, hooks=[], agents=fake_agents,
        steering_runtime=runtime,
    )
    assert captured["steering_runtime"] is runtime


def test_all_surface_graphs_keep_review_gate_and_steering(graph_builder_fixtures):
    for surface, fixture in graph_builder_fixtures.items():
        graph = fixture.build(surface=surface, steering_enabled=True)
        assert fixture.has_provider(graph, ReviewGate)
        assert fixture.application_agents_have_steering(graph)
```

Add the graph module import to the test module. Extend `tests/graph/conftest.py` with a concrete `graph_builder_fixtures` mapping whose `build`, `has_provider`, and `application_agents_have_steering` methods use the existing graph fixture arguments. The `build` method must call `build_graph_for_run()` with `run_id="test-run"`, the fixture’s `surface`, `tools_registry`, `model`, `hooks=[]`, `agents`, `storage_dir`, `audit_repo`, `memory`, `publisher`, `jobs_repo`, `grounding`, `repo_dir`, and `steering_runtime`. Its assertions should inspect the captured factory arguments rather than private Strands SDK internals.

- [ ] **Step 2: Run wiring tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_runtime_wiring.py tests/graph/test_surface_graphs.py -v
```

Expected: FAIL because graph construction does not create or forward a steering runtime.

- [ ] **Step 3: Compose a per-run runtime**

Extend `WorkflowContext` with a `steering_runtime_factory` field and an `agent_runtime(agent_id, node_id, role)` method. In `build_workflows`, compose the factory from repositories, audit repository, publisher, config, and session settings; do not create a run-bound runtime there because the run ID is not known yet. In `_default_graph_factory` inside `workflows/runner.py`, call `context.new_steering_runtime(run_id, surface, org_id, project_id, workflow_key)` and pass that runtime to `build_graph_for_run`. Do not create a global mutable runtime.

- [ ] **Step 4: Add stable graph identities**

For each graph builder, pass explicit identities matching node purpose, for example `documentation.writer`/`write`, `documentation.research.docs`/`research`, `support.answer_writer`/`answer`, `content.blog_writer`/`write`, and `delivery.github`/`deliver`. Swarm members receive stable member IDs. Evaluation agents receive `evaluation.<dimension>` IDs. Preserve `ReviewGate`, `RunAuditLogger`, session manager, graph limits, and existing delivery HITL arguments.

- [ ] **Step 5: Run graph/composition tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_runtime_wiring.py tests/graph/test_surface_graphs.py tests/graph/test_documentation_graph.py tests/graph/test_review_gate.py tests/composition/test_workflows_composition.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit runtime and graph wiring**

```bash
cd draftly-agent-backend
git add src/draftly/workflows/context.py src/draftly/app/composition/workflows.py src/draftly/app/dependencies.py src/draftly/integrations/strands/graph.py src/draftly/orchestration/graphs tests/steering/test_runtime_wiring.py tests/graph/test_surface_graphs.py
git commit -m "feat: wire steering runtime through every graph surface"
```

### Task 7: Add runner lifecycle, resume, and workflow status handling

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/state.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/workflow_schemas.py` or the exact module defining `RunStatus`
- Test: `draftly-agent-backend/tests/workflows/test_steering_intervention_resume.py`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_resume_preflight.py`
- Modify: `draftly-agent-backend/tests/api/test_workflow_runs.py`

**Interfaces:**
- Consumes: Tasks 3 and 6 intervention repository/runtime, existing `run()`, `resume_review()`, `_finish_result()`, `_store_interrupts()`, and session-resume preflight.
- Produces: `WorkflowStatus.PENDING_INTERVENTION`, `WorkflowRunner.resume_intervention(event: Mapping[str, Any], interrupt_id: str, response: Mapping[str, Any]) -> WorkflowState`, and atomic lifecycle transitions for steering interrupts.

- [ ] **Step 1: Write failing runner tests**

```python
async def test_steering_interrupt_enters_pending_intervention(runner, fake_graph):
    state = await runner.run(event_for("run-1"), graph_factory=fake_graph(interrupt=True))
    assert state.status is WorkflowStatus.PENDING_INTERVENTION
    assert await interventions.get_pending("run-1")


async def test_resume_intervention_uses_exact_interrupt_and_is_idempotent(runner):
    state = await runner.resume_intervention(
        event=event_for("run-1"), interrupt_id="steer-int-1",
        response={"action": "approve", "message": "validated"},
    )
    assert state.status in {WorkflowStatus.DELIVERED, WorkflowStatus.FAILED}
    graph_factory.assert_called_with_interrupt_response("steer-int-1", approved=True)
```

Test restartable/non-resumable sessions, stale workers, cancellation, expired interventions, concurrent response claims, and the unchanged `resume_review()` path.

- [ ] **Step 2: Run runner tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/workflows/test_steering_intervention_resume.py tests/unit/workflows/test_resume_preflight.py tests/api/test_workflow_runs.py -v
```

Expected: FAIL because the new status, transition, and resume method do not exist.

- [ ] **Step 3: Add status and lifecycle transitions**

Add `PENDING_INTERVENTION = "pending_intervention"` to `WorkflowStatus` and every Pydantic `RunStatus` literal/response model. Update `_finish_result()` to distinguish Strands `ReviewGate` interrupts from steering interrupts using the persisted intervention metadata. Steering sets `pending_intervention`; review remains `pending_review`.

- [ ] **Step 4: Implement `resume_intervention()`**

Load the canonical run/event with organization scope, verify the pending intervention’s exact `(run_id, interrupt_id)`, atomically claim its response, rebuild the same graph/session, and pass the Strands-compatible interrupt response. Reuse `_session_is_resumable()` and `_finish_result()` only after the response claim succeeds. Resolve the intervention after the resumed result is known; if resume fails, leave a typed failed/retryable state without permitting a second response to resume concurrently.

- [ ] **Step 5: Run lifecycle tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/workflows/test_steering_intervention_resume.py tests/unit/workflows/test_resume_preflight.py tests/api/test_workflow_runs.py tests/review/test_review_resume.py tests/integrations/test_review_interactions.py -q
```

Expected: PASS, including unchanged review resume behavior.

- [ ] **Step 6: Commit lifecycle/resume behavior**

```bash
cd draftly-agent-backend
git add src/draftly/workflows/state.py src/draftly/workflows/runner.py src/draftly/persistence/repositories/workflows.py src/draftly/app/api/workflow_schemas.py tests/workflows/test_steering_intervention_resume.py tests/unit/workflows/test_resume_preflight.py tests/api/test_workflow_runs.py
git commit -m "feat: resume durable steering interventions"
```

### Task 8: Add steering judge isolation, audit events, and SSE replay

**Files:**
- Modify: `draftly-agent-backend/src/draftly/steering/handler.py`
- Modify: `draftly-agent-backend/src/draftly/events/stream_envelope.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/events/redis_stream_bus.py` only if event serialization requires it
- Test: `draftly-agent-backend/tests/steering/test_llm_judge_isolation.py`
- Test: `draftly-agent-backend/tests/events/test_steering_events.py`
- Modify: `draftly-agent-backend/tests/api/test_workflows_sse_starlette.py`

**Interfaces:**
- Consumes: Tasks 1, 4, and 7; existing `StreamEnvelope`, `filter_graph_event`, Redis/database replay, and Strands `LLMSteeringHandler`/`LedgerProvider` APIs.
- Produces: redacted `StreamEnvelope` objects with `type="steering"` and an isolated structured judge path exposed as `build_isolated_judge(system_prompt, model)`.

- [ ] **Step 1: Write failing event/judge tests**

```python
def test_steering_event_contains_only_redacted_bounded_fields():
    decision = SteeringDecision.interrupt(
        phase=SteeringPhase.BEFORE_TOOL, reason="secret-token unsafe destination",
    )
    envelope = steering_envelope(decision, payload_max_bytes=4096)
    assert envelope.type == "steering"
    assert "secret-token" not in json.dumps(envelope.payload)
    assert len(json.dumps(envelope.payload).encode()) <= 4096


def test_llm_judge_has_no_tools_plugins_or_steering():
    judge = build_isolated_judge(system_prompt="judge", model=StubModel())
    assert judge.tools == []
    assert judge.plugins == []
    assert not any(isinstance(item, DraftlySteeringHandler) for item in judge.plugins)
```

Test event ordering, durable database replay, Redis replay, reconnect sequence deduplication, invalid judge schema, judge timeout, and deterministic interrupt precedence.

- [ ] **Step 2: Run event/judge tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_llm_judge_isolation.py tests/events/test_steering_events.py tests/api/test_workflows_sse_starlette.py -v
```

Expected: FAIL because steering envelopes and the isolated judge adapter do not exist.

- [ ] **Step 3: Implement isolated optional judge behavior**

Use `LLMSteeringHandler` only when `steering_llm_enabled` and the selected role policy permit it. Pass a dedicated system prompt, optional judge model, bounded timeout, and redacted ledger context. Construct the judge with `callback_handler=None`, no tools, no application plugins, and no recursive Draftly factory call. Validate the structured decision; on timeout/invalid output use the deterministic policy fallback.

- [ ] **Step 4: Add typed steering event shaping**

Extend `filter_graph_event` or the runner’s decision callback boundary to publish one redacted `steering` envelope per decision using the existing sequence allocator. Include `schema_version`, `phase`, `action`, `role`, safe agent/node/tool IDs, reason/rule source, attempt summary, and `interrupt_id` when present. Do not publish raw tool arguments or model messages.

- [ ] **Step 5: Run event and replay tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_llm_judge_isolation.py tests/events/test_steering_events.py tests/api/test_workflows_sse_starlette.py tests/events/test_redis_stream_bus.py tests/api/test_workflows_stream.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit judge/event streaming**

```bash
cd draftly-agent-backend
git add src/draftly/steering/handler.py src/draftly/events/stream_envelope.py src/draftly/workflows/runner.py src/draftly/events/redis_stream_bus.py tests/steering/test_llm_judge_isolation.py tests/events/test_steering_events.py tests/api/test_workflows_sse_starlette.py
git commit -m "feat: stream redacted steering decisions"
```

### Task 9: Expose the authorized intervention API

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/routes/interventions.py`
- Create: `draftly-agent-backend/src/draftly/app/api/steering_schemas.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/__init__.py` if required by registration
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py` for status/read integration
- Test: `draftly-agent-backend/tests/api/test_intervention_routes.py`

**Interfaces:**
- Consumes: Task 7 `WorkflowRunner.resume_intervention()`, Task 3 repository claim semantics, existing verified-token/org authorization helpers, and route conventions.
- Produces: `POST /api/workflow-runs/{run_id}/interventions/{interrupt_id}/respond` with `InterventionResponseRequest` and `InterventionResponse` models.

- [ ] **Step 1: Write failing API contract tests**

```python
async def test_respond_intervention_requires_authorized_org(client, pending_intervention):
    response = await client.post(
        f"/api/workflow-runs/{pending_intervention.run_id}/interventions/{pending_intervention.interrupt_id}/respond",
        json={"action": "approve", "message": "go", "idempotency_key": "req-1"},
        headers=org_headers("different-org"),
    )
    assert response.status_code == 404


async def test_duplicate_intervention_response_returns_existing_state(client, pending_intervention):
    payload = {"action": "approve", "idempotency_key": "req-1"}
    first = await client.post(intervention_url(pending_intervention), json=payload)
    second = await client.post(intervention_url(pending_intervention), json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()["intervention_id"] == second.json()["intervention_id"]
```

Test action validation (`approve`, `deny`, `guide`), message bounds/redaction, missing/expired/resolved IDs, project scope, authentication, and resume failure responses. Use existing route fixtures rather than provider credentials.

- [ ] **Step 2: Run API tests to verify they fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/api/test_intervention_routes.py -v
```

Expected: FAIL because the route and schemas do not exist.

- [ ] **Step 3: Implement schemas and route**

Define:

```python
class InterventionAction(StrEnum):
    APPROVE = "approve"
    DENY = "deny"
    GUIDE = "guide"


class InterventionResponseRequest(BaseModel):
    action: InterventionAction
    message: str | None = Field(default=None, max_length=1_000)
    idempotency_key: str = Field(min_length=1, max_length=128)
```

The route must obtain the verified caller identity, load the run/intervention under organization scope, claim the response atomically, invoke `resume_intervention()` exactly once for a newly claimed row, and return the persisted intervention/run status. A duplicate claim returns the existing outcome without invoking resume. Never return raw reason/tool arguments.

- [ ] **Step 4: Register route and run API tests**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/api/test_intervention_routes.py tests/api/test_workflow_runs.py tests/api/test_routes_smoke.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the intervention API**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/interventions.py src/draftly/app/api/steering_schemas.py src/draftly/app/api/app.py src/draftly/app/api/routes/__init__.py src/draftly/app/api/routes/workflow_runs.py tests/api/test_intervention_routes.py
git commit -m "feat: add authorized steering intervention responses"
```

### Task 10: Add observability, rollout flags, and production regression coverage

**Files:**
- Modify: `draftly-agent-backend/src/draftly/steering/handler.py`
- Modify: `draftly-agent-backend/src/draftly/observability/metrics.py`
- Modify: `draftly-agent-backend/src/draftly/app/config.py` if rollout validation needs tightening
- Create: `draftly-agent-backend/tests/steering/test_rollout_modes.py`
- Create: `draftly-agent-backend/tests/steering/test_agent_coverage.py`
- Modify: `draftly-agent-backend/tests/graph/test_session_restore.py`
- Modify: `draftly-agent-backend/tests/graph/test_evaluation_timeouts.py`
- Modify: `draftly-agent-backend/tests/graph/test_content_grounding_judge.py`
- Modify: `draftly-agent-backend/tests/unit/agents/test_skill_contracts.py`
- Modify: `draftly-agent-backend/README.md` only if runtime configuration documentation is maintained there

**Interfaces:**
- Consumes: all previous tasks and existing metrics/logging/test conventions.
- Produces: steering decision/retry/intervention/judge metrics, shadow/enforcement behavior, coverage guarantees, and documented deployment flags.

- [ ] **Step 1: Write failing rollout/coverage tests**

```python
async def test_shadow_mode_records_would_have_decision_without_canceling_tool(runtime):
    runtime.config.steering_enabled = True
    runtime.config.steering_enforcement_enabled = False
    action = await handler_for(runtime).steer_before_tool(
        agent=FakeAgent(), tool_use=unsafe_side_effect_tool()
    )
    assert type(action).__name__ == "Proceed"
    runtime.audit.record_step.assert_awaited()


def test_kill_switch_does_not_disable_review_gate():
    settings = Settings(strands_steering_enabled=False, strands_review_policy="always")
    assert settings.strands.review_policy == "always"
```

Add a source coverage test that enumerates all production `Agent` construction sites and asserts the allowlist remains empty after the migration. Add restart/resume, provider failure, unknown side-effect, cancellation race, judge timeout, and no-live-key tests.

- [ ] **Step 2: Run the regression tests to verify the new assertions fail**

Run:

```bash
cd draftly-agent-backend
python -m pytest tests/steering/test_rollout_modes.py tests/steering/test_agent_coverage.py tests/graph/test_session_restore.py tests/graph/test_evaluation_timeouts.py tests/graph/test_content_grounding_judge.py tests/unit/agents/test_skill_contracts.py -v
```

Expected: FAIL for missing metrics, rollout behavior, and coverage enforcement.

- [ ] **Step 3: Add metrics and rollout behavior**

Increment metrics for decision action/phase/role/surface, guide-limit exhaustion, interrupt creation/response/expiry, judge latency/fallback, persistence/publication failure, `pending_intervention`, resume success/failure, and side-effect reconciliation. In shadow mode, record the would-have action but return `Proceed`; in enforcement mode, use the policy action. The global kill switch disables judge/enforcement only and never bypasses authorization or `ReviewGate`.

- [ ] **Step 4: Run the complete backend test suite**

Run:

```bash
cd draftly-agent-backend
python -m pytest -q
```

Expected: PASS with no production credentials required for unit/integration fixtures. If an unrelated pre-existing test fails, record its exact failure and do not weaken steering assertions to mask it.

- [ ] **Step 5: Update the graph and inspect the final diff**

Run:

```bash
cd draftly-agent-backend
graphify update .
git diff --check HEAD~10..HEAD
git status --short
```

Confirm that graphify includes the steering package and all factory-to-handler paths, that no secrets or raw payloads are present in test fixtures/logging, and that unrelated dirty files were not staged.

- [ ] **Step 6: Commit rollout and verification coverage**

```bash
cd draftly-agent-backend
git add src/draftly/steering src/draftly/observability/metrics.py src/draftly/app/config.py tests/steering tests/graph/test_session_restore.py tests/graph/test_evaluation_timeouts.py tests/graph/test_content_grounding_judge.py tests/unit/agents/test_skill_contracts.py README.md
git commit -m "feat: add steering rollout controls and observability"
```

## Final verification checklist

- [ ] Run `rg -n "Agent\\(" src tests` and confirm every production source occurrence is inside the centralized helper or the explicitly isolated judge path; onboarding-stage agents are included.
- [ ] Run `python -m pytest -q` in `draftly-agent-backend`.
- [ ] Run `graphify update .` in `draftly-agent-backend` after the final code changes.
- [ ] Verify migration `057_agent_steering.sql` is discovered and applies cleanly against the project’s CockroachDB/Postgres-compatible migration test fixture.
- [ ] Verify `ReviewGate` still produces `pending_review` and the existing review endpoint still resumes review decisions.
- [ ] Verify a steering interrupt produces `pending_intervention`, a redacted durable `steering` SSE event, and exactly one resumable response.
- [ ] Verify the kill switch cannot bypass tenant authorization, side-effect checks, or final review.
- [ ] Run `git status --short` in both repositories and report unrelated pre-existing changes without staging them.

## Execution handoff

This plan is saved at `docs/superpowers/plans/2026-09-10-agent-steering.md`. Execute it from the `draftly-agent-backend` repository using `subagent-driven-development` (recommended for the ten independently reviewable tasks) or `executing-plans` with checkpoints. Create an isolated worktree before backend implementation, then implement one task at a time with the required failing-test, implementation, focused-test, and commit cycle.
