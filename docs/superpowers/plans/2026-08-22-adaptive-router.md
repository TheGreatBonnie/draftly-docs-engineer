# Adaptive Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Draftly's capability-aware `ModelRouter` into an adaptive router that routes each task to the best eligible model using hard constraints plus deterministic profile-weighted scoring, learns from outcomes (DeepEval scores, human review approvals, invocation telemetry), and improves future selections.

**Architecture:** Approach A -- evolve the single `ModelRouter` (facade pattern). New modules carry the logic; `router.py` stays a facade. `route(RoutingRequest)` becomes the primary adaptive API; legacy `resolve(RoutingPolicy)` / `resolve_model()` / `resolve_capability()` keep their exact signatures (and resolve()'s invocation-time fallback loop) untouched. Models are resolved per-run via `RoleAwareModelResolver`, giving per-task routing.

**Tech Stack:** Python 3.12, dataclasses, asyncpg, PostgreSQL, pytest, pytest-asyncio

**Spec:** `docs/superpowers/specs/2026-08-22-adaptive-router-design.md`

## Global Constraints

- Python 3.12+, no new dependencies beyond existing `asyncpg`
- `RoutingRequest` is a frozen dataclass; `TaskType` is a `StrEnum`; an explicit `ROLE_TO_TASK_TYPE` map covers all nine real agent roles (none of them equal `TaskType` values except `research`)
- Constraint precedence (reference §33): provider enabled -> capabilities subset -> context_tokens <= context_window -> provider health -> model health -> quality floor (known quality only) -> estimated cost <= budget -> p95 latency <= budget
- Soft constraints (cost, latency) relax before hard ones when all candidates are eliminated
- EMA: `new = a*latest + (1-a)*prior`, a=0.05; tracks sample_count, mean, variance, success_rate, p50/p95 latency keyed by `task_type:model_name`
- Quality estimates enter scoring once samples >= 20; before that the profile's `quality_floor` is used as the conservative default, and floor violations eliminate candidates only when quality IS known
- RoutingProfile dimensions match the spec table exactly — `(quality, reliability, latency, cost, history)`:
  - support/fast: 0.25 / 0.15 / 0.35 / 0.25 / — , floor 0.80
  - documentation_generation: 0.40 / 0.25 / 0.10 / 0.10 / 0.15, floor 0.90
  - documentation_review/evaluation: 0.50 / 0.30 / 0.05 / 0.10 / 0.05, floor 0.93
  - delivery: 0.40 / 0.35 / 0.15 / 0.10 / — , floor 0.95
- Static priority is only the final tie-breaker (ascending `ModelConfig.priority`, not request priority)
- Legacy API keeps its exact signatures: `resolve(policy: RoutingPolicy) -> Model` (including its invocation-time fallback loop), `resolve_model()`, `resolve_capability()`; `route()` is additive
- `resolve_concrete_model()` unchanged for LLM-judge evaluators
- Persistence follows the existing store pattern (`DatabaseClient.fetch_all/fetch_one/execute`); routing repositories are wired into `RepositoryDependencies`
- Migration numbers 026/027 (024/025 are taken by the onboarding plan)
- Tests: `pytest tests/unit/models/ -x`, project lint/typecheck

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/draftly/models/schemas.py` | `TaskType` (StrEnum), `ROLE_TO_TASK_TYPE` map, `RoutingRequest` (frozen dataclass), `RoutingDecision` (frozen dataclass) |
| `src/draftly/models/profiles.py` | `RoutingProfile` (quality/reliability/latency/cost/history weights + floor), `ROUTING_PROFILES`, `get_profile()` |
| `src/draftly/models/constraints.py` | `ConstraintPipeline` -- ordered hard-constraint filtering (incl. quality floor) + soft-constraint relaxation |
| `src/draftly/models/scoring.py` | `score_candidates()` -- spec-dimension weighted scorer with ascending-priority tie-breaker |
| `src/draftly/models/pricing.py` | `estimate_cost()` with conservative sentinel for unpriced models |
| `src/draftly/models/performance.py` | `EMAStatsStore` (task-scoped keys), `ModelHealthRegistry` (per-model cooldown), latency tracking |
| `src/draftly/persistence/stores/routing.py` | `DatabaseRoutingStore`, `DatabasePerformanceStore` on the existing `DatabaseClient` pattern |
| `src/draftly/persistence/repositories/routing.py` | `RoutingRepository`, `PerformanceRepository` (incl. outcome recording + warm-start load) |
| `src/draftly/persistence/migrations/026_routing_decisions.sql` | Append-only audit table |
| `src/draftly/persistence/migrations/027_model_performance.sql` | Upserted aggregates keyed `(model_name, task_type)` |
| `tests/unit/models/test_config_fields.py` | ModelConfig routing-field tests |
| `tests/unit/models/test_schemas.py` | TaskType, role map, RoutingRequest, RoutingDecision tests |
| `tests/unit/models/test_profiles.py` | Profile defaults, normalization, floor tests |
| `tests/unit/models/test_constraints.py` | Constraint ordering, relaxation, quality-floor tests |
| `tests/unit/models/test_scoring.py` | Scorer math, tie-breaking, sample-gate tests |
| `tests/unit/models/test_pricing.py` | Cost estimation, sentinel tests |
| `tests/unit/models/test_performance.py` | EMA math, ModelHealthRegistry tests |
| `tests/unit/models/test_router_integration.py` | route -> decision -> outcome cycle; legacy resolve() preserved |
| `tests/unit/app/test_routing_composition.py` | RepositoryDependencies wiring checks |

### Modified Files

| File | Change |
|------|--------|
| `src/draftly/models/config.py` | Add `context_window`, `input_cost_per_1m_tokens`, `output_cost_per_1m_tokens` to `ModelConfig` |
| `src/draftly/models/factory.py` | Remove duplicate `fast-openrouter` (lines 337-369); populate routing metadata; pass stores to router |
| `src/draftly/models/policies.py` | Add `"bedrock"` and `"mantle"` to `KNOWN_PROVIDERS` and all `FALLBACKS` chains |
| `src/draftly/models/registry.py` | `register_model()` raises `ValueError` on duplicate model names |
| `src/draftly/models/router.py` | Add additive `route()`; keep `resolve(RoutingPolicy)` and friends intact; expose `stats_store` |
| `src/draftly/models/__init__.py` | Export new types: schemas, profiles, pricing, performance |
| `src/draftly/persistence/repositories/__init__.py` | Export routing repositories |
| `src/draftly/app/dependencies.py` | Wire routing/performance repositories into `RepositoryDependencies` |
| `src/draftly/integrations/strands/models.py` | Add `RoleAwareModelResolver` + `resolve_model_for_role()` helper |
| `src/draftly/integrations/strands/graph.py` | Thread optional resolver through graph builders |
| `src/draftly/integrations/strands/client.py` | Wrap router in resolver at client construction |
| `src/draftly/workflows/context.py` | Add `routing_decision` field |
| `src/draftly/workflows/runner.py` | Record routing outcome (success/latency) after invocation |
| `src/draftly/app/lifecycle.py` | Bind performance repository to shared stats store; warm-start at boot |
| `src/draftly/app/api/routes/github.py` | Pass resolver in `resume_review` graph build |

---
## Task 1: Remove duplicate fast-openrouter registration

**Files:**
- Modify: `src/draftly/models/factory.py:353-369` (delete duplicate block)

**Interfaces:**
- Consumes: none
- Produces: none (cleanup only)

- [ ] **Step 1: Verify the duplicate exists**

The factory registers `fast-openrouter` twice: lines 335-351 and lines 353-369 with identical config.

Run: `rg "fast-openrouter" src/draftly/models/factory.py`
Expected: 2 matches (lines 337 and 355)

- [ ] **Step 2: Delete the duplicate block**

Remove the second `registry.register_model(ModelConfig(name="fast-openrouter"...))` block at lines 353-369.

- [ ] **Step 3: Verify single registration remains**

Run: `rg "fast-openrouter" src/draftly/models/factory.py`
Expected: 1 match (line 337)

- [ ] **Step 4: Commit**

```bash
git add src/draftly/models/factory.py
git commit -m "fix: remove duplicate fast-openrouter model registration"
```

---
## Task 2: Add bedrock and mantle to KNOWN_PROVIDERS and FALLBACKS

**Files:**
- Modify: `src/draftly/models/policies.py:11,13-44`
- Create: `tests/unit/models/test_policies.py`

**Interfaces:**
- Consumes: none
- Produces: `KNOWN_PROVIDERS` includes `"bedrock"` and `"mantle"`; all `FALLBACKS` chains gain both providers in priority order

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/models/test_policies.py
"""Tests for routing policies."""

from draftly.models.policies import FALLBACKS, KNOWN_PROVIDERS


def test_known_providers_includes_bedrock_and_mantle():
    assert "bedrock" in KNOWN_PROVIDERS
    assert "mantle" in KNOWN_PROVIDERS


def test_fallbacks_chains_include_bedrock_and_mantle():
    for chain_key, chain in FALLBACKS.items():
        assert "bedrock" in chain, f"bedrock missing from {chain_key} chain"
        assert "mantle" in chain, f"mantle missing from {chain_key} chain"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/models/test_policies.py -v`
Expected: FAIL -- `AssertionError: bedrock not in chain`

- [ ] **Step 3: Implement the fix**

In `policies.py`, update `KNOWN_PROVIDERS` and all `FALLBACKS` chains to include `"bedrock"` and `"mantle"` in priority order (mantle=3, bedrock=5 from factory):

```python
KNOWN_PROVIDERS = frozenset({"openrouter", "nvidia", "requesty", "orcarouter", "bedrock", "mantle"})

FALLBACKS: dict[str, tuple[str, ...]] = {
    "reasoning": ("mantle", "bedrock", "nvidia", "requesty", "orcarouter", "openrouter"),
    "research": ("mantle", "bedrock", "nvidia", "requesty", "orcarouter", "openrouter"),
    "fast": ("mantle", "bedrock", "nvidia", "requesty", "orcarouter", "openrouter"),
    "verification": ("mantle", "bedrock", "nvidia", "requesty", "orcarouter", "openrouter"),
    "evaluation": ("mantle", "bedrock", "nvidia", "requesty", "orcarouter", "openrouter"),
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/unit/models/test_policies.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/policies.py tests/unit/models/test_policies.py
git commit -m "feat: add bedrock and mantle to KNOWN_PROVIDERS and FALLBACKS chains"
```

---

## Task 3: ModelRegistry rejects duplicate model names

**Files:**
- Modify: `src/draftly/models/registry.py:21-28`
- Create: `tests/unit/models/test_registry.py`

**Interfaces:**
- Consumes: `ModelConfig`
- Produces: `register_model()` raises `ValueError` on duplicate `model.name`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/models/test_registry.py
"""Tests for ModelRegistry."""

import pytest

from draftly.models.config import ModelConfig, ProviderConfig
from draftly.models.registry import ModelRegistry


@pytest.fixture()
def registry():
    reg = ModelRegistry()
    reg.register_provider(
        ProviderConfig(name="test-provider", api_key="k", base_url=None)
    )
    return reg


def test_register_model_raises_on_duplicate_name(registry):
    config = ModelConfig(name="dup", provider="test-provider", model_id="m1")
    registry.register_model(config)

    with pytest.raises(ValueError, match="Duplicate model name"):
        registry.register_model(
            ModelConfig(name="dup", provider="test-provider", model_id="m2")
        )


def test_register_model_allows_different_names(registry):
    registry.register_model(
        ModelConfig(name="a", provider="test-provider", model_id="m1")
    )
    registry.register_model(
        ModelConfig(name="b", provider="test-provider", model_id="m2")
    )
    assert len(registry.list_models()) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/models/test_registry.py -v`
Expected: FAIL -- second `register_model` silently overwrites

- [ ] **Step 3: Implement the fix**

In `registry.py`, update `register_model()`:

```python
def register_model(
    self,
    model: ModelConfig,
) -> None:
    if model.provider not in self._providers:
        raise ValueError(f"Provider '{model.provider}' must be registered before its models.")

    if model.name in self._models:
        raise ValueError(f"Duplicate model name: '{model.name}' is already registered.")

    self._models[model.name] = model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/unit/models/test_registry.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/registry.py tests/unit/models/test_registry.py
git commit -m "feat: reject duplicate model names in ModelRegistry.register_model()"
```
---

## Task 4: Extend ModelConfig with routing metadata

**Files:**
- Modify: `src/draftly/models/config.py`
- Modify: `src/draftly/models/factory.py` (populate flagship models)
- Create: `tests/unit/models/test_config_fields.py`

**Why:** the constraint pipeline needs `context_window`, pricing needs cost rates, and neither exists today (`ModelConfig` has only name/provider/model_id/capabilities/temperature/max_tokens/priority/enabled). Spec §Operational layer names exactly these optional fields. Adding defaulted fields to the frozen dataclass keeps every existing construction site valid.

**Interfaces:**
- Produces: `ModelConfig.context_window: int | None = None`, `input_cost_per_1m_tokens: float | None = None`, `output_cost_per_1m_tokens: float | None = None`

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_config_fields.py
"""Tests for ModelConfig routing metadata fields."""

from draftly.models.config import ModelConfig


def test_model_config_defaults_are_none():
    config = ModelConfig(name="m", provider="p", model_id="org/m")
    assert config.context_window is None
    assert config.input_cost_per_1m_tokens is None
    assert config.output_cost_per_1m_tokens is None


def test_model_config_accepts_routing_metadata():
    config = ModelConfig(
        name="m", provider="p", model_id="org/m",
        context_window=200000,
        input_cost_per_1m_tokens=3.0,
        output_cost_per_1m_tokens=15.0,
    )
    assert config.context_window == 200000
    assert config.input_cost_per_1m_tokens == 3.0


def test_existing_fields_unaffected():
    config = ModelConfig(
        name="m", provider="p", model_id="org/m",
        capabilities=("reasoning",), priority=10, enabled=True,
    )
    assert config.capabilities == ("reasoning",)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/models/test_config_fields.py -v`
Expected: FAIL -- `TypeError: unexpected keyword argument 'context_window'`

- [ ] **Step 3: Implement**

In `src/draftly/models/config.py`, append to `ModelConfig`:

```python
@dataclass(frozen=True)
class ModelConfig:
    name: str
    provider: str
    model_id: str

    capabilities: tuple[str, ...] = ()

    temperature: float = 0.0
    max_tokens: int | None = None

    priority: int = 100

    enabled: bool = True

    # Routing metadata (spec: operational layer). Optional; unpriced or
    # window-less models fall back to sentinel cost / conservative window.
    context_window: int | None = None
    input_cost_per_1m_tokens: float | None = None
    output_cost_per_1m_tokens: float | None = None
```

In `src/draftly/models/factory.py`, populate at least the two flagship reasoning registrations (mantle reasoning and bedrock reasoning) so the pipeline/scoring paths have real data:

```python
        registry.register_model(
            ModelConfig(
                name="reasoning-mantle-kimi-k2-5",
                ...
                context_window=256000,
                input_cost_per_1m_tokens=0.60,
                output_cost_per_1m_tokens=2.50,
            )
        )
```

> Adjust figures to current vendor pricing at implementation time. Remaining models intentionally keep `None`: unknown windows pass only small-context requests and unpriced models score via the conservative cost sentinel (Tasks 8/9).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && pytest tests/unit/models/test_config_fields.py tests/unit/models -x -q`
Expected: PASS (existing model tests unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/config.py src/draftly/models/factory.py tests/unit/models/test_config_fields.py
git commit -m "feat: add context_window and pricing metadata to ModelConfig"
```

---

## Task 5: Implement routing schemas (TaskType, RoutingRequest, RoutingDecision)

**Files:**
- Create: `src/draftly/models/schemas.py`
- Create: `tests/unit/models/test_schemas.py`

**Interfaces:**
- Consumes: none
- Produces: `TaskType` (StrEnum), `RoutingRequest` (frozen dataclass), `RoutingDecision` (frozen dataclass)

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_schemas.py
"""Tests for routing schemas."""

import pytest
from draftly.models.schemas import ROLE_TO_TASK_TYPE, RoutingDecision, RoutingRequest, TaskType


def test_task_type_values():
    assert TaskType.SUPPORT.value == "support"
    assert TaskType.FAST.value == "fast"
    assert TaskType.REASONING.value == "reasoning"
    assert TaskType.RESEARCH.value == "research"
    assert TaskType.DOCUMENTATION_GENERATION.value == "documentation_generation"
    assert TaskType.DOCUMENTATION_REVIEW.value == "documentation_review"
    assert TaskType.EVALUATION.value == "evaluation"
    assert TaskType.DELIVERY.value == "delivery"


def test_role_map_covers_all_nine_agent_roles():
    expected_roles = {
        "documentation_engineer", "documentation_reviewer", "github_intelligence",
        "support_engineer", "support_reviewer", "research", "deepeval",
        "github_delivery", "memory_curator",
    }
    assert set(ROLE_TO_TASK_TYPE) == expected_roles
    # Sensible mappings per reference §34 / existing role policies
    assert ROLE_TO_TASK_TYPE["documentation_engineer"] is TaskType.DOCUMENTATION_GENERATION
    assert ROLE_TO_TASK_TYPE["support_engineer"] is TaskType.SUPPORT
    assert ROLE_TO_TASK_TYPE["github_intelligence"] is TaskType.RESEARCH
    assert ROLE_TO_TASK_TYPE["deepeval"] is TaskType.EVALUATION
    assert ROLE_TO_TASK_TYPE["memory_curator"] is TaskType.FAST


def test_routing_request_is_frozen():
    req = RoutingRequest(task_type=TaskType.SUPPORT, context_tokens=500)
    with pytest.raises(AttributeError):
        req.context_tokens = 1000


def test_routing_request_defaults():
    req = RoutingRequest(task_type=TaskType.FAST, context_tokens=100)
    assert req.priority == 5
    assert req.cost_budget is None
    assert req.latency_budget_ms is None
    assert req.estimated_output_tokens == 1024
    assert req.metadata == {}


def test_routing_decision_is_frozen():
    dec = RoutingDecision(
        selected_model="a",
        provider="b",
        score=0.8,
        candidates_considered=5,
        profile="support",
    )
    with pytest.raises(AttributeError):
        dec.selected_model = "c"


def test_routing_decision_debugging_fields():
    dec = RoutingDecision(
        selected_model="a", provider="b", score=0.9,
        candidates_considered=3, profile="support",
        ranked=(("a", 0.9), ("c", 0.7)),
        reason_codes=("capability_match", "healthy_provider"),
        fallback_chain=("c",),
    )
    assert dec.ranked[1] == ("c", 0.7)
    assert "capability_match" in dec.reason_codes
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_schemas.py -v`
Expected: FAIL -- `ModuleNotFoundError`

- [ ] **Step 3: Implement schemas.py**

```python
# src/draftly/models/schemas.py
"""Core routing schemas."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class TaskType(StrEnum):
    """Routing task types (spec §Routing profiles)."""

    SUPPORT = "support"
    FAST = "fast"
    REASONING = "reasoning"
    RESEARCH = "research"
    DOCUMENTATION_GENERATION = "documentation_generation"
    DOCUMENTATION_REVIEW = "documentation_review"
    EVALUATION = "evaluation"
    DELIVERY = "delivery"


#: Explicit mapping from real agent roles to task types. Agent role names
#: do NOT match TaskType values (only ``research`` coincides), so this map
#: — not string identity — is the single source of truth.
ROLE_TO_TASK_TYPE: dict[str, TaskType] = {
    "documentation_engineer": TaskType.DOCUMENTATION_GENERATION,
    "documentation_reviewer": TaskType.DOCUMENTATION_REVIEW,
    "github_intelligence": TaskType.RESEARCH,
    "support_engineer": TaskType.SUPPORT,
    "support_reviewer": TaskType.DOCUMENTATION_REVIEW,
    "research": TaskType.RESEARCH,
    "deepeval": TaskType.EVALUATION,
    "github_delivery": TaskType.DELIVERY,
    "memory_curator": TaskType.FAST,
}


@dataclass(frozen=True)
class RoutingRequest:
    """Request to route a task to the best model."""

    task_type: TaskType
    context_tokens: int
    estimated_output_tokens: int = 1024
    priority: int = 5
    cost_budget: float | None = None
    latency_budget_ms: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RoutingDecision:
    """Immutable record of a routing decision (spec §Decision)."""

    selected_model: str
    provider: str
    score: float
    candidates_considered: int
    profile: str
    estimated_cost: float | None = None
    estimated_latency_ms: float | None = None
    rejected: dict[str, list[str]] | None = None
    ranked: tuple[tuple[str, float], ...] = ()
    reason_codes: tuple[str, ...] = ()
    fallback_chain: tuple[str, ...] = ()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_schemas.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/schemas.py tests/unit/models/test_schemas.py
git commit -m "feat: add routing schemas (TaskType, RoutingRequest, RoutingDecision)"
```

---

## Task 6: Implement routing profiles

**Files:**
- Create: `src/draftly/models/profiles.py`
- Create: `tests/unit/models/test_profiles.py`

**Interfaces:**
- Consumes: `TaskType` from schemas
- Produces: `RoutingProfile` dataclass, `ROUTING_PROFILES` dict, `get_profile()`

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_profiles.py
"""Tests for routing profiles."""

import pytest

from draftly.models.profiles import ROUTING_PROFILES, RoutingProfile, get_profile
from draftly.models.schemas import TaskType


def test_all_task_types_have_profiles():
    for task_type in TaskType:
        profile = get_profile(task_type)
        assert profile is not None, f"Missing profile for {task_type}"


def test_profile_weights_sum_to_one():
    for name, p in ROUTING_PROFILES.items():
        total = p.w_quality + p.w_reliability + p.w_latency + p.w_cost + p.w_history
        assert abs(total - 1.0) < 1e-6, f"{name} weights sum to {total}, expected 1.0"


def test_spec_table_values():
    # Spec §Routing profiles table — dimensions (quality, reliability, latency, cost, history)
    support = ROUTING_PROFILES["support"]
    assert (support.w_quality, support.w_reliability, support.w_latency,
            support.w_cost, support.w_history) == pytest.approx((0.25, 0.15, 0.35, 0.25, 0.0))

    gen = ROUTING_PROFILES["documentation_generation"]
    assert (gen.w_quality, gen.w_reliability, gen.w_latency,
            gen.w_cost, gen.w_history) == pytest.approx((0.40, 0.25, 0.10, 0.10, 0.15))

    review = ROUTING_PROFILES["documentation_review"]
    assert (review.w_quality, review.w_reliability, review.w_latency,
            review.w_cost, review.w_history) == pytest.approx((0.50, 0.30, 0.05, 0.10, 0.05))
    assert review.w_quality > review.w_cost * 3  # reviews are NOT cost-optimized


def test_quality_floors():
    assert ROUTING_PROFILES["support"].quality_floor == pytest.approx(0.80)
    assert ROUTING_PROFILES["fast"].quality_floor == pytest.approx(0.80)
    assert ROUTING_PROFILES["documentation_generation"].quality_floor == pytest.approx(0.90)
    assert ROUTING_PROFILES["reasoning"].quality_floor == pytest.approx(0.88)
    assert ROUTING_PROFILES["documentation_review"].quality_floor == pytest.approx(0.93)
    assert ROUTING_PROFILES["evaluation"].quality_floor == pytest.approx(0.93)
    assert ROUTING_PROFILES["delivery"].quality_floor == pytest.approx(0.95)


def test_get_profile_unknown_task_returns_default():
    profile = get_profile(TaskType.SUPPORT, default=ROUTING_PROFILES["fast"])
    assert profile.name == "fast"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_profiles.py -v`
Expected: FAIL -- `ModuleNotFoundError`

- [ ] **Step 3: Implement profiles.py**

```python
# src/draftly/models/profiles.py
"""Routing profiles with quality floors and scoring weights.

Dimensions follow the spec table exactly: quality, reliability, latency,
cost, history (task-scoped historical performance).
"""

from __future__ import annotations

from dataclasses import dataclass

from draftly.models.schemas import TaskType


@dataclass(frozen=True)
class RoutingProfile:
    """Immutable profile defining weight emphasis and quality floor."""

    name: str
    w_quality: float
    w_reliability: float
    w_latency: float
    w_cost: float
    w_history: float
    quality_floor: float

    def __post_init__(self) -> None:
        total = (
            self.w_quality + self.w_reliability + self.w_latency
            + self.w_cost + self.w_history
        )
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"Weights must sum to 1.0, got {total}")
        if not 0.0 <= self.quality_floor <= 1.0:
            raise ValueError(f"quality_floor must be 0-1, got {self.quality_floor}")


ROUTING_PROFILES: dict[str, RoutingProfile] = {
    "support": RoutingProfile(
        name="support", w_quality=0.25, w_reliability=0.15, w_latency=0.35,
        w_cost=0.25, w_history=0.0, quality_floor=0.80,
    ),
    "fast": RoutingProfile(
        name="fast", w_quality=0.25, w_reliability=0.15, w_latency=0.35,
        w_cost=0.25, w_history=0.0, quality_floor=0.80,
    ),
    "reasoning": RoutingProfile(
        # Derived row (spec table covers 4 workloads; reasoning/research are
        # quality-leaning per reference §34): quality HIGH, latency low.
        name="reasoning", w_quality=0.40, w_reliability=0.25, w_latency=0.15,
        w_cost=0.10, w_history=0.10, quality_floor=0.88,
    ),
    "documentation_generation": RoutingProfile(
        name="documentation_generation", w_quality=0.40, w_reliability=0.25,
        w_latency=0.10, w_cost=0.10, w_history=0.15, quality_floor=0.90,
    ),
    "documentation_review": RoutingProfile(
        name="documentation_review", w_quality=0.50, w_reliability=0.30,
        w_latency=0.05, w_cost=0.10, w_history=0.05, quality_floor=0.93,
    ),
    "evaluation": RoutingProfile(
        name="evaluation", w_quality=0.50, w_reliability=0.30,
        w_latency=0.05, w_cost=0.10, w_history=0.05, quality_floor=0.93,
    ),
    "delivery": RoutingProfile(
        name="delivery", w_quality=0.40, w_reliability=0.35, w_latency=0.15,
        w_cost=0.10, w_history=0.0, quality_floor=0.95,
    ),
}

_TASK_TYPE_PROFILES: dict[TaskType, RoutingProfile] = {
    TaskType.SUPPORT: ROUTING_PROFILES["support"],
    TaskType.FAST: ROUTING_PROFILES["fast"],
    TaskType.REASONING: ROUTING_PROFILES["reasoning"],
    TaskType.RESEARCH: ROUTING_PROFILES["reasoning"],
    TaskType.DOCUMENTATION_GENERATION: ROUTING_PROFILES["documentation_generation"],
    TaskType.DOCUMENTATION_REVIEW: ROUTING_PROFILES["documentation_review"],
    TaskType.EVALUATION: ROUTING_PROFILES["evaluation"],
    TaskType.DELIVERY: ROUTING_PROFILES["delivery"],
}


def get_profile(
    task_type: TaskType,
    default: RoutingProfile | None = None,
) -> RoutingProfile:
    """Return the routing profile for a task type."""
    return _TASK_TYPE_PROFILES.get(task_type, default or ROUTING_PROFILES["support"])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_profiles.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/profiles.py tests/unit/models/test_profiles.py
git commit -m "feat: add routing profiles with quality floors and scoring weights"
```

---
## Task 7: Implement constraint pipeline

**Files:**
- Create: `src/draftly/models/constraints.py`
- Create: `tests/unit/models/test_constraints.py`

**Interfaces:**
- Consumes: `RoutingRequest`, `ModelConfig`, `ProviderHealthRegistry`, `ModelHealthRegistry`, optional `EMAStatsStore`
- Produces: `ConstraintPipeline.filter_candidates()` — ordered hard constraints (reference §33), quality-floor gate on known data, soft cost/latency relaxation
- Uses ONLY real health APIs: `provider_health.get(p).available()` and `model_health.is_model_healthy(name)`

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_constraints.py
"""Tests for the constraint pipeline."""

import pytest

from draftly.models.config import ModelConfig
from draftly.models.constraints import ConstraintPipeline
from draftly.models.health import ProviderHealthRegistry
from draftly.models.performance import EMAStatsStore, ModelHealthRegistry
from draftly.models.schemas import RoutingRequest, TaskType


def _make_model(name, provider="openrouter", ctx_window=None, caps=("text",)):
    return ModelConfig(
        name=name,
        provider=provider,
        model_id=f"org/{name}",
        context_window=ctx_window,
        capabilities=caps,
    )


def _make_request(task_type=TaskType.SUPPORT, context_tokens=1000,
                  cost_budget=None, latency_budget_ms=None):
    return RoutingRequest(task_type=task_type, context_tokens=context_tokens,
                          estimated_output_tokens=500,
                          cost_budget=cost_budget, latency_budget_ms=latency_budget_ms)


def _filter(req, models, *, provider_health=None, model_health=None,
            enabled=("openrouter",), required_caps=None, stats_store=None):
    pipeline = ConstraintPipeline()
    return pipeline.filter_candidates(
        req, models,
        provider_health=provider_health or ProviderHealthRegistry(),
        model_health=model_health or ModelHealthRegistry(),
        enabled_providers=set(enabled),
        required_caps=required_caps,
        stats_store=stats_store,
    )


def test_provider_enabled_constraint():
    models = [_make_model("a"), _make_model("b", provider="unknown")]
    result = _filter(_make_request(), models)
    assert [m.name for m in result] == ["a"]


def test_context_window_constraint():
    # Declared window smaller than request -> excluded
    models = [_make_model("small", ctx_window=8192)]
    assert _filter(_make_request(context_tokens=200000), models) == []
    # Unknown window passes only small-context requests
    unknown = [_make_model("mystery", ctx_window=None)]
    assert len(_filter(_make_request(context_tokens=200000), unknown)) == 0
    assert len(_filter(_make_request(context_tokens=4000), unknown)) == 1


def test_capabilities_constraint():
    models = [_make_model("a", caps=("text",))]
    assert _filter(_make_request(), models, required_caps={"vision"}) == []


def test_provider_health_uses_real_registry():
    models = [_make_model("a")]
    provider_health = ProviderHealthRegistry()
    provider_health.get("openrouter").disable()
    assert _filter(_make_request(), models, provider_health=provider_health) == []


def test_model_cooldown_constraint():
    models = [_make_model("a")]
    model_health = ModelHealthRegistry(cooldown_seconds=60)
    model_health.mark_failure("a")
    assert _filter(_make_request(), models, model_health=model_health) == []


def test_quality_floor_eliminates_known_bad_models_only():
    models = [_make_model("weak"), _make_model("strong"), _make_model("novice")]
    store = EMAStatsStore()
    for _ in range(20):  # reach the >=20 sample gate
        store.record_quality("support", "weak", 0.70)
        store.record_quality("support", "strong", 0.95)
        # "novice" has no samples -> floor NOT applied to it
    result = _filter(_make_request(), models, stats_store=store)
    assert {m.name for m in result} == {"strong", "novice"}


def test_soft_cost_relaxation_keeps_candidates():
    models = [_make_model("pricey")]
    result = _filter(_make_request(cost_budget=0.000001), models)
    # Soft constraint relaxes rather than emptying the candidate set
    assert len(result) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_constraints.py -v`
Expected: FAIL -- `ModuleNotFoundError`

- [ ] **Step 3: Implement constraints.py**

```python
# src/draftly/models/constraints.py
"""Ordered hard-constraint filtering with soft-constraint relaxation.

Precedence (reference §33): provider enabled -> capabilities ->
context window -> provider health -> model health -> quality floor
(known data only) -> [soft] cost -> [soft] latency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from draftly.models.config import ModelConfig
    from draftly.models.health import ProviderHealthRegistry
    from draftly.models.performance import EMAStatsStore, ModelHealthRegistry
    from draftly.models.schemas import RoutingRequest

#: Requests at or below this size may use models whose context_window is
#: undeclared; larger requests require a declared window.
_UNKNOWN_WINDOW_FLOOR = 16_000


@dataclass
class ConstraintPipeline:
    """Filters candidates through ordered hard constraints, then relaxes soft ones."""

    _rejected: dict[str, list[str]] = field(default_factory=dict, init=False, repr=False)

    @property
    def rejected(self) -> dict[str, list[str]]:
        return dict(self._rejected)

    def filter_candidates(
        self,
        request: RoutingRequest,
        candidates: list[ModelConfig],
        *,
        provider_health: ProviderHealthRegistry,
        model_health: ModelHealthRegistry,
        enabled_providers: set[str],
        required_caps: set[str] | None = None,
        stats_store: EMAStatsStore | None = None,
    ) -> list[ModelConfig]:
        self._rejected = {"hard": [], "soft": []}
        remaining = list(candidates)

        remaining = self._filter_by_provider(remaining, enabled_providers)
        if required_caps:
            remaining = self._filter_by_capabilities(remaining, required_caps)
        remaining = self._filter_by_context_window(remaining, request.context_tokens)
        remaining = self._filter_by_provider_health(remaining, provider_health)
        remaining = self._filter_by_model_health(remaining, model_health)
        if stats_store is not None and remaining:
            remaining = self._filter_by_quality_floor(
                remaining, request.task_type.value, stats_store
            )

        if not remaining:
            return []

        # Soft 7: cost budget (relaxable) — estimated with the request's tokens
        if request.cost_budget is not None:
            soft = [
                m for m in remaining
                if (estimate_request_cost(m, request) or 0.0) <= request.cost_budget
            ]
            if soft:
                remaining = soft
            else:
                self._rejected["soft"].append("cost_budget")

        # Soft 8: latency budget (relaxable)
        if request.latency_budget_ms is not None and stats_store is not None:
            soft = [
                m for m in remaining
                if (stats_store.get_latency_p95(request.task_type.value, m.name) or 0.0)
                <= request.latency_budget_ms
            ]
            if soft:
                remaining = soft
            else:
                self._rejected["soft"].append("latency_budget")

        return remaining

    def _filter_by_provider(self, candidates, enabled):
        result = [m for m in candidates if m.provider in enabled]
        self._rejected["hard"].extend(
            f"provider_disabled:{m.name}" for m in candidates if m.provider not in enabled
        )
        return result

    def _filter_by_capabilities(self, candidates, required):
        result = [m for m in candidates if required.issubset(set(m.capabilities))]
        self._rejected["hard"].extend(
            f"missing_capability:{m.name}"
            for m in candidates if not required.issubset(set(m.capabilities))
        )
        return result

    def _filter_by_context_window(self, candidates, tokens):
        kept, rejected = [], []
        for m in candidates:
            if m.context_window is None:
                (kept if tokens <= _UNKNOWN_WINDOW_FLOOR else rejected).append(m)
            elif m.context_window >= tokens:
                kept.append(m)
            else:
                rejected.append(m)
        self._rejected["hard"].extend(f"context_window_exceeded:{m.name}" for m in rejected)
        return kept

    def _filter_by_provider_health(self, candidates, registry):
        result = [m for m in candidates if registry.get(m.provider).available()]
        self._rejected["hard"].extend(
            f"provider_unhealthy:{m.name}" for m in candidates
            if not registry.get(m.provider).available()
        )
        return result

    def _filter_by_model_health(self, candidates, registry):
        result = [m for m in candidates if registry.is_model_healthy(m.name)]
        self._rejected["hard"].extend(
            f"model_in_cooldown:{m.name}" for m in candidates
            if not registry.is_model_healthy(m.name)
        )
        return result

    def _filter_by_quality_floor(self, candidates, task_type, store):
        """Eliminate candidates whose KNOWN quality is below the profile floor.

        Unknown quality never eliminates (spec: gate on samples >= 20);
        enforcement for unknown models happens via conservative defaults
        in scoring instead.
        """
        from draftly.models.profiles import get_profile
        from draftly.models.schemas import TaskType

        floor = get_profile(TaskType(task_type)).quality_floor
        kept, rejected = [], []
        for m in candidates:
            quality = store.get_quality(task_type, m.name)
            if quality is not None and quality < floor:
                rejected.append(m)
            else:
                kept.append(m)
        self._rejected["hard"].extend(f"below_quality_floor:{m.name}" for m in rejected)
        return kept


def estimate_request_cost(model: ModelConfig, request: RoutingRequest) -> float | None:
    """Cost estimate using the request's token estimates."""
    from draftly.models.pricing import estimate_cost

    return estimate_cost(
        model,
        input_tokens=request.context_tokens,
        output_tokens=request.estimated_output_tokens,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_constraints.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/constraints.py tests/unit/models/test_constraints.py
git commit -m "feat: add constraint pipeline with hard filtering and soft relaxation"
```

---

## Task 8: Implement cost estimation

**Files:**
- Create: `src/draftly/models/pricing.py`
- Create: `tests/unit/models/test_pricing.py`

**Interfaces:**
- Consumes: `ModelConfig.input_cost_per_1m_tokens` / `output_cost_per_1m_tokens` (Task 4)
- Produces: `estimate_cost(model, input_tokens, output_tokens) -> float`; unpriced models return the conservative sentinel per spec

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_pricing.py
"""Tests for cost estimation."""

from draftly.models.config import ModelConfig
from draftly.models.pricing import UNPRICED_MODEL_COST, estimate_cost


def test_estimate_cost_with_pricing():
    model = ModelConfig(
        name="test", provider="openrouter", model_id="org/test",
        input_cost_per_1m_tokens=0.50,
        output_cost_per_1m_tokens=1.50,
    )
    cost = estimate_cost(model, input_tokens=1_000_000, output_tokens=500_000)
    expected = 0.50 * 1.0 + 1.50 * 0.5
    assert abs(cost - expected) < 1e-9


def test_unpriced_model_gets_conservative_sentinel():
    model = ModelConfig(name="test", provider="openrouter", model_id="org/test")
    cost = estimate_cost(model, input_tokens=1000, output_tokens=500)
    assert cost == UNPRICED_MODEL_COST


def test_partially_priced_model_uses_known_rates():
    model = ModelConfig(
        name="test", provider="openrouter", model_id="org/test",
        input_cost_per_1m_tokens=0.50,
    )
    # Missing output rate treated as 0 rather than triggering sentinel
    cost = estimate_cost(model, input_tokens=1_000_000, output_tokens=1)
    assert abs(cost - 0.50) < 1e-9
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_pricing.py -v`
Expected: FAIL -- `ModuleNotFoundError`

- [ ] **Step 3: Implement pricing.py**

```python
# src/draftly/models/pricing.py
"""Cost estimation from ModelConfig pricing metadata."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from draftly.models.config import ModelConfig

#: Conservative stand-in cost (USD for a typical request) applied to models
#: with no declared pricing, per spec "unpriced models get a conservative
#: sentinel cost". High enough that budget filters prefer priced peers.
UNPRICED_MODEL_COST = 0.50


def estimate_cost(
    model: ModelConfig,
    input_tokens: int = 0,
    output_tokens: int = 0,
) -> float | None:
    """Estimate USD cost for a request against this model."""
    if (
        model.input_cost_per_1m_tokens is None
        and model.output_cost_per_1m_tokens is None
    ):
        return UNPRICED_MODEL_COST

    input_rate = model.input_cost_per_1m_tokens or 0.0
    output_rate = model.output_cost_per_1m_tokens or 0.0
    return (input_rate * input_tokens + output_rate * output_tokens) / 1_000_000
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_pricing.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/pricing.py tests/unit/models/test_pricing.py
git commit -m "feat: add cost estimation with conservative unpriced sentinel"
```

---

## Task 9: Implement spec-dimension weighted scoring

**Files:**
- Create: `src/draftly/models/scoring.py`
- Create: `tests/unit/models/test_scoring.py`

**Interfaces:**
- Consumes: `RoutingRequest`, `RoutingProfile`, task-scoped `EMAStatsStore`
- Produces: `score_candidates()` sorted by weighted score desc, then candidate `priority` ASC (static priority is only the tie-breaker, reference §26)
- Quality gate: recorded quality counts only at samples >= 20; below that the profile floor is the conservative default

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_scoring.py
"""Tests for spec-dimension weighted scoring."""

import pytest

from draftly.models.config import ModelConfig
from draftly.models.performance import EMAStatsStore
from draftly.models.profiles import ROUTING_PROFILES
from draftly.models.schemas import RoutingRequest, TaskType
from draftly.models.scoring import score_candidates


def _make_model(name, provider="openrouter", priority=100):
    return ModelConfig(
        name=name, provider=provider, model_id=f"org/{name}",
        context_window=128000,
        input_cost_per_1m_tokens=0.50,
        output_cost_per_1m_tokens=1.50,
        priority=priority,
    )


def _request(task_type=TaskType.SUPPORT, **kw):
    return RoutingRequest(task_type=task_type, context_tokens=4000,
                          estimated_output_tokens=500, **kw)


def _store_with_quality(task_type, name, quality):
    store = EMAStatsStore()
    for _ in range(25):  # cross the >=20 sample gate
        store.record_quality(task_type, name, quality)
    return store


def test_scoring_returns_sorted_descending():
    models = [_make_model("a"), _make_model("b"), _make_model("c")]
    result = score_candidates(_request(), models, ROUTING_PROFILES["support"], EMAStatsStore())
    scores = [s for _, s in result]
    assert scores == sorted(scores, reverse=True)


def test_quality_used_only_after_sample_gate():
    # Below the gate: conservative default (= floor) drives quality
    cold_store = EMAStatsStore()
    cold_store.record_quality("support", "a", 0.99)  # 1 sample -> ignored
    req = _request()
    scored_cold = dict(score_candidates(req, [_make_model("a")],
                                        ROUTING_PROFILES["support"], cold_store))
    warm_store = _store_with_quality("support", "a", 0.99)
    scored_warm = dict(score_candidates(req, [_make_model("a")],
                                        ROUTING_PROFILES["support"], warm_store))
    assert scored_warm["a"] > scored_cold["a"]


def test_priority_breaks_score_ties_deterministically():
    low = _make_model("cheap-priority-1", priority=1)
    high = _make_model("lazy-priority-90", priority=90)
    store = EMAStatsStore()  # identical cold stats -> identical scores
    result = score_candidates(_request(), [high, low], ROUTING_PROFILES["support"], store)
    assert [m.name for m, _ in result] == ["cheap-priority-1", "lazy-priority-90"]


def test_history_weight_rewards_seasoned_models():
    fresh, seasoned = _make_model("fresh"), _make_model("seasoned")
    store = EMAStatsStore()
    for _ in range(120):
        store.record_outcome("support", "seasoned", success=True, latency_ms=900.0)
    scores = dict(score_candidates(_request(), [fresh, seasoned],
                                   ROUTING_PROFILES["support"], store))
    assert scores["seasoned"] > scores["fresh"]


def test_zero_candidates():
    assert score_candidates(_request(), [], ROUTING_PROFILES["support"], EMAStatsStore()) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_scoring.py -v`
Expected: FAIL -- `ModuleNotFoundError`

- [ ] **Step 3: Implement scoring.py**

```python
# src/draftly/models/scoring.py
"""Spec-dimension weighted scoring with static-priority tie-breaker."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from draftly.models.config import ModelConfig
    from draftly.models.performance import EMAStatsStore
    from draftly.models.profiles import RoutingProfile
    from draftly.models.schemas import RoutingRequest

#: Samples required before recorded quality enters scoring (spec).
MIN_QUALITY_SAMPLES = 20

#: USD-per-request anchor for normalizing cost scores; matches the
#: unpriced sentinel so unknown-cost models land near the bottom.
COST_SCORE_ANCHOR = 0.50

#: p95 latency (ms) that maps to a zero latency score.
LATENCY_SCORE_CEILING_MS = 30_000.0


def score_candidates(
    request: RoutingRequest,
    candidates: list[ModelConfig],
    profile: RoutingProfile,
    stats_store: EMAStatsStore,
) -> list[tuple[ModelConfig, float]]:
    """Return candidates sorted by weighted score desc, then priority asc."""
    if not candidates:
        return []

    scored = [(_score_single(request, m, profile, stats_store), m) for m in candidates]
    # Static priority is ONLY the final tie-breaker (reference §26):
    # ascending ModelConfig.priority, never the request's priority.
    scored.sort(key=lambda pair: (-pair[0], pair[1].priority))
    return [(model, round(score, 6)) for score, model in scored]


def _score_single(request, model, profile, store) -> float:
    task = request.task_type.value
    total = (
        profile.w_quality * _quality_score(request, model, profile, store)
        + profile.w_reliability * _reliability_score(task, model, store)
        + profile.w_latency * _latency_score(task, model, store)
        + profile.w_cost * _cost_score(request, model)
        + profile.w_history * _history_score(task, model, store)
    )
    return total


def _quality_score(request, model, profile, store) -> float:
    """Task-scoped quality; conservative default (= floor) until samples >= 20."""
    task = request.task_type.value
    quality = store.get_quality(task, model.name)
    if quality is not None and store.sample_count(task, model.name) >= MIN_QUALITY_SAMPLES:
        return quality
    return profile.quality_floor


def _reliability_score(task, model, store) -> float:
    rate = store.get_success_rate(task, model.name)
    return 0.95 if rate is None else rate


def _latency_score(task, model, store) -> float:
    p95 = store.get_latency_p95(task, model.name)
    if p95 is None:
        return 0.5
    return max(0.0, min(1.0, 1.0 - (p95 / LATENCY_SCORE_CEILING_MS)))


def _cost_score(request, model) -> float:
    from draftly.models.constraints import estimate_request_cost

    cost = estimate_request_cost(model, request) or 0.0
    return max(0.0, min(1.0, 1.0 - (cost / COST_SCORE_ANCHOR)))


def _history_score(task, model, store) -> float:
    """Confidence that grows with observed volume for THIS task type.

    Measures volume, not a second copy of quality: it breaks ties toward
    battle-tested models without double-counting the same signal.
    DeepEval-scored quality flows through `_quality_score` once outcome
    recording lands (Task 16); `approval_rate` joins via the reviews hook
    noted there.
    """
    count = store.sample_count(task, model.name)
    return min(1.0, count / 100.0)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_scoring.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/scoring.py tests/unit/models/test_scoring.py
git commit -m "feat: add spec-dimension weighted scoring with priority tie-break"
```

---

## Task 10: Implement EMA stats store and model health registry

**Files:**
- Create: `src/draftly/models/performance.py`
- Create: `tests/unit/models/test_performance.py`

**Interfaces:**
- Produces: task-scoped `EMAStatsStore` (keys `(task_type, model_name)` per reference §13), `ModelHealthRegistry`, `get_model_p95_latency()`
- Math: quality and success rate are true EMAs (alpha=0.05); mean/variance tracked; latency history bounded for percentiles

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_performance.py
"""Tests for task-scoped EMA stats and model health registry."""

import pytest

from draftly.models.performance import (
    EMAStatsStore,
    ModelHealthRegistry,
    get_model_p95_latency,
)


def test_ema_initializes_on_first_sample():
    store = EMAStatsStore(alpha=0.05)
    store.record_outcome("support", "model_a", success=True, latency_ms=100.0)
    stats = store.get_stats("support", "model_a")
    assert stats is not None
    assert stats.sample_count == 1
    assert stats.mean_latency_ms == 100.0


def test_ema_updates_incrementally():
    store = EMAStatsStore(alpha=0.05)
    store.record_outcome("support", "m", success=True, latency_ms=100.0)
    store.record_outcome("support", "m", success=True, latency_ms=200.0)
    stats = store.get_stats("support", "m")
    assert stats.sample_count == 2
    assert 100.0 < stats.mean_latency_ms < 200.0


def test_task_scoping_isolates_models_and_tasks():
    store = EMAStatsStore()
    store.record_outcome("support", "m", success=True, latency_ms=100.0)
    store.record_outcome("delivery", "m", success=False, latency_ms=900.0)
    assert store.get_stats("support", "m") is not None
    assert store.get_stats("delivery", "m") is not None
    assert store.get_stats("review", "m") is None


def test_quality_is_ema_not_plain_average():
    store = EMAStatsStore(alpha=0.05)
    for _ in range(20):
        store.record_quality("support", "m", 0.9)
    store.record_quality("support", "m", 0.5)  # outlier must move EMA only slightly
    q = store.get_quality("support", "m")
    assert q is not None
    assert q > 0.85  # a plain average would have dropped much lower
    assert q < 0.9


def test_sample_gate_counts_all_outcomes():
    store = EMAStatsStore()
    for _ in range(19):
        store.record_outcome("support", "m", success=True, latency_ms=100.0)
    assert not store.has_enough_samples("support", "m")
    store.record_quality("support", "m", 0.9)
    assert store.sample_count("support", "m") >= 20
    assert store.has_enough_samples("support", "m")


def test_success_rate_reflects_failures():
    store = EMAStatsStore()
    for _ in range(10):
        store.record_outcome("support", "m", success=True, latency_ms=100.0)
    store.record_outcome("support", "m", success=False, latency_ms=100.0)
    rate = store.get_success_rate("support", "m")
    assert rate is not None and rate < 1.0


def test_percentiles_from_bounded_history():
    store = EMAStatsStore()
    for i in range(300):  # exceeds any internal window; must not blow up
        store.record_outcome("support", "m", success=True, latency_ms=float(i))
    p95 = store.get_latency_p95("support", "m")
    assert p95 is not None and p95 > 0


def test_model_health_cooldown():
    registry = ModelHealthRegistry(cooldown_seconds=60)
    registry.mark_failure("m")
    assert not registry.is_model_healthy("m")
    registry.clear_failure("m")
    assert registry.is_model_healthy("m")


def test_get_model_p95_latency_requires_task_scope():
    store = EMAStatsStore()
    assert get_model_p95_latency("support", "unknown", store) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_performance.py -v`
Expected: FAIL -- `ModuleNotFoundError`

- [ ] **Step 3: Implement performance.py**

```python
# src/draftly/models/performance.py
"""Task-scoped EMA statistics and model-level health cooldowns."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

#: Bounded latency window for percentile estimates.
_LATENCY_WINDOW = 250


@dataclass
class TaskModelStats:
    """EMA aggregates for one (task_type, model_name) pair."""

    sample_count: int = 0
    mean_latency_ms: float = 0.0
    variance_latency_ms: float = 0.0
    success_rate: float = 1.0         # EMA of outcomes (1=success, 0=failure)
    quality_ema: float | None = None  # EMA of evaluation/quality scores
    p50_latency_ms: float = 0.0
    p95_latency_ms: float = 0.0
    _latencies: deque = field(default_factory=lambda: deque(maxlen=_LATENCY_WINDOW),
                              repr=False)


class EMAStatsStore:
    """In-memory live cache of per-task model performance.

    Keys are ``(task_type, model_name)`` pairs so routing learns that a
    model is good at documentation but mediocre at support (reference §13).
    """

    def __init__(self, alpha: float = 0.05) -> None:
        self._alpha = alpha
        self._stats: dict[tuple[str, str], TaskModelStats] = {}

    # -- recording -------------------------------------------------------

    def _entry(self, task_type: str, model_name: str) -> TaskModelStats:
        key = (task_type, model_name)
        if key not in self._stats:
            self._stats[key] = TaskModelStats()
        return self._stats[key]

    def record_outcome(
        self,
        task_type: str,
        model_name: str,
        *,
        success: bool,
        latency_ms: float,
    ) -> None:
        """Record one invocation outcome (latency + success flag)."""
        a = self._alpha
        stats = self._entry(task_type, model_name)
        stats.sample_count += 1
        if stats.sample_count == 1:
            stats.mean_latency_ms = latency_ms
            stats.variance_latency_ms = 0.0
        else:
            delta = latency_ms - stats.mean_latency_ms
            stats.mean_latency_ms += a * delta
            stats.variance_latency_ms += a * (delta * delta - stats.variance_latency_ms)
        stats.success_rate = a * (1.0 if success else 0.0) + (1 - a) * stats.success_rate
        stats._latencies.append(latency_ms)
        ordered = sorted(stats._latencies)
        n = len(ordered)
        stats.p50_latency_ms = ordered[n // 2]
        stats.p95_latency_ms = ordered[min(int(n * 0.95), n - 1)]

    def record_quality(self, task_type: str, model_name: str, quality: float) -> None:
        """Record an evaluation/quality observation as an EMA."""
        stats = self._entry(task_type, model_name)
        stats.sample_count += 1
        if stats.quality_ema is None:
            stats.quality_ema = quality
        else:
            stats.quality_ema = (
                self._alpha * quality + (1 - self._alpha) * stats.quality_ema
            )

    # -- reads ---------------------------------------------------------------

    def get_stats(self, task_type: str, model_name: str) -> TaskModelStats | None:
        return self._stats.get((task_type, model_name))

    def sample_count(self, task_type: str, model_name: str) -> int:
        stats = self.get_stats(task_type, model_name)
        return stats.sample_count if stats else 0

    def has_enough_samples(
        self, task_type: str, model_name: str, threshold: int = 20
    ) -> bool:
        return self.sample_count(task_type, model_name) >= threshold

    def get_quality(self, task_type: str, model_name: str) -> float | None:
        stats = self.get_stats(task_type, model_name)
        return stats.quality_ema if stats else None

    def get_success_rate(self, task_type: str, model_name: str) -> float | None:
        stats = self.get_stats(task_type, model_name)
        if stats and stats.sample_count > 0:
            return stats.success_rate
        return None

    def get_latency_p95(self, task_type: str, model_name: str) -> float | None:
        stats = self.get_stats(task_type, model_name)
        if stats and stats.p95_latency_ms > 0:
            return stats.p95_latency_ms
        return None


class ModelHealthRegistry:
    """Per-model cooldown after failures (complements ProviderHealthRegistry)."""

    def __init__(self, cooldown_seconds: float = 300.0) -> None:
        self._cooldown = cooldown_seconds
        self._failures: dict[str, float] = {}

    def mark_failure(self, model_name: str) -> None:
        self._failures[model_name] = time.time()

    def is_model_healthy(self, model_name: str) -> bool:
        if model_name not in self._failures:
            return True
        return (time.time() - self._failures[model_name]) >= self._cooldown

    def clear_failure(self, model_name: str) -> None:
        self._failures.pop(model_name, None)


def get_model_p95_latency(
    task_type: str,
    model_name: str,
    store: EMAStatsStore,
) -> float | None:
    return store.get_latency_p95(task_type, model_name)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_performance.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/performance.py tests/unit/models/test_performance.py
git commit -m "feat: add task-scoped EMA stats store and model health registry"
```

---

## Task 11: ModelRouter facade — additive route(), legacy intact

**Files:**
- Modify: `src/draftly/models/router.py`
- Create: `tests/unit/models/test_router_integration.py`

**Interfaces:**
- Consumes: `RoutingRequest`, `RoutingDecision`
- Produces: additive `route()` returning a fully-populated `RoutingDecision`; legacy methods NOT rewired

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/models/test_router_integration.py
"""Integration tests for the adaptive router facade."""

from unittest.mock import MagicMock

import pytest

from draftly.models.config import ModelConfig
from draftly.models.health import ProviderHealthRegistry
from draftly.models.policies import RoutingPolicy
from draftly.models.registry import ModelRegistry
from draftly.models.router import ModelRouter, NoCandidateError
from draftly.models.schemas import ROLE_TO_TASK_TYPE, RoutingRequest, TaskType


def _provider():
    provider = MagicMock()
    provider.name = "openrouter"
    provider.create_model.return_value = "CONCRETE-MODEL"
    return provider


def _registry(*models):
    reg = ModelRegistry()
    reg.register_provider(_provider())
    for m in models:
        reg.register_model(m)
    return reg


def _model(name, priority=100, ctx_window=128000):
    return ModelConfig(
        name=name, provider="openrouter", model_id=f"org/{name}",
        capabilities=("reasoning", "tool_calling", "structured_output"),
        context_window=ctx_window,
        input_cost_per_1m_tokens=0.5,
        output_cost_per_1m_tokens=1.5,
        priority=priority,
    )


@pytest.fixture()
def router():
    return ModelRouter(
        registry=_registry(
            _model("alpha", priority=1),
            _model("beta", priority=2),
            _model("stage-research", priority=3),
        ),
        health=ProviderHealthRegistry(),
    )


def test_route_returns_full_decision(router):
    request = RoutingRequest(task_type=TaskType.SUPPORT, context_tokens=4000,
                             estimated_output_tokens=500)
    decision = router.route(request)

    assert decision.selected_model in {"alpha", "beta"}
    assert decision.provider == "openrouter"
    assert 0.0 <= decision.score <= 1.0
    assert decision.candidates_considered == 3
    assert len(decision.ranked) == 3
    assert decision.reason_codes  # debugging info present (reference §27)
    assert decision.rejected is not None


def test_route_tie_breaks_by_static_priority(router):
    decision = router.route(
        RoutingRequest(task_type=TaskType.SUPPORT, context_tokens=1000)
    )
    # Cold stats => equal scores; ascending model priority wins (reference §26)
    assert decision.selected_model == "alpha"


def test_route_raises_no_candidate_when_everything_filtered():
    router = ModelRouter(registry=_registry(_model("a")), health=ProviderHealthRegistry())
    router._enabled_providers = set()  # nothing enabled
    with pytest.raises(NoCandidateError):
        router.route(RoutingRequest(task_type=TaskType.SUPPORT, context_tokens=10))


def test_role_capabilities_flow_through_route(router):
    caps = {"reasoning", "tool_calling"}
    request = RoutingRequest(task_type=ROLE_TO_TASK_TYPE["documentation_engineer"],
                             context_tokens=2000)
    decision = router.route(request, required_caps=caps)
    assert decision.profile == "documentation_generation"


def test_legacy_resolve_signature_and_return_unchanged(router):
    """resolve(RoutingPolicy) -> Model must keep working (dependencies.py)."""
    policy = RoutingPolicy(required_capabilities=("reasoning",), allow_fallback=True)
    result = router.resolve(policy)
    assert result == "CONCRETE-MODEL"  # provider.create_model output


def test_resolve_model_and_capability_still_work(router):
    assert router.resolve_model("stage-research") == "CONCRETE-MODEL"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/models/test_router_integration.py -v`
Expected: FAIL -- `route()` does not exist on ModelRouter

- [ ] **Step 3: Implement route() on ModelRouter**

In `router.py`, add `route()` alongside the existing methods (do not rewire the legacy ones):

```python
# src/draftly/models/router.py — ADDITIVE changes only.

from draftly.models.performance import EMAStatsStore, ModelHealthRegistry
from draftly.models.policies import KNOWN_PROVIDERS
from draftly.models.schemas import RoutingDecision, RoutingRequest

#: Capabilities each task type minimally requires (reference §34/§5).
TASK_TYPE_CAPABILITIES: dict[TaskType, frozenset[str]] = {
    TaskType.DOCUMENTATION_GENERATION: frozenset({"reasoning", "tool_calling", "structured_output"}),
    TaskType.DOCUMENTATION_REVIEW: frozenset({"verification"}),
    TaskType.EVALUATION: frozenset({"evaluation"}),
    # SUPPORT/FAST/REASONING/RESEARCH: no hard capability floor beyond text
}


class NoCandidateError(RuntimeError):
    """Raised when the constraint pipeline eliminates every candidate."""


class ModelRouter:
    def __init__(
        self,
        registry: ModelRegistry,
        health: ProviderHealthRegistry,
        *,
        enabled_providers: set[str] | None = None,
        stats_store: EMAStatsStore | None = None,
        model_health: ModelHealthRegistry | None = None,
    ) -> None:
        # Existing public attribute names preserved — resolve()/factory
        # call sites keep working untouched.
        self.registry = registry
        self.health = health
        self._enabled_providers = (
            set(enabled_providers) if enabled_providers else set(KNOWN_PROVIDERS)
        )
        self._stats_store = stats_store or EMAStatsStore()
        self._model_health = model_health or ModelHealthRegistry()

    @property
    def stats_store(self) -> EMAStatsStore:
        """Live stats cache (composition warm-starts this from PostgreSQL)."""
        return self._stats_store

    @property
    def model_health(self) -> ModelHealthRegistry:
        return self._model_health

    def route(
        self,
        request: RoutingRequest,
        *,
        required_caps: set[str] | None = None,
    ) -> RoutingDecision:
        """Adaptive routing API: constraints -> score -> decide.

        Additive to the legacy API; does NOT replace resolve().
        """
        from draftly.models.constraints import ConstraintPipeline
        from draftly.models.profiles import get_profile
        from draftly.models.scoring import score_candidates

        profile = get_profile(request.task_type)
        caps = required_caps
        if caps is None:
            caps = set(TASK_TYPE_CAPABILITIES.get(request.task_type, frozenset()))

        pipeline = ConstraintPipeline()
        filtered = pipeline.filter_candidates(
            request,
            self.registry.list_models(),
            provider_health=self.health,
            model_health=self._model_health,
            enabled_providers=self._enabled_providers,
            required_caps=caps or None,
            stats_store=self._stats_store,
        )

        if not filtered:
            raise NoCandidateError(
                f"No models available for {request.task_type.value}: "
                f"rejected={pipeline.rejected}"
            )

        scored = score_candidates(request, filtered, profile, self._stats_store)
        best_model, best_score = scored[0]

        reason_codes = ["profile_" + profile.name]
        if caps and caps.issubset(set(best_model.capabilities)):
            reason_codes.append("required_capabilities_match")
        if self.health.get(best_model.provider).available():
            reason_codes.append("healthy_provider")
        if best_model.input_cost_per_1m_tokens is not None:
            reason_codes.append("priced_model")
        if self._stats_store.has_enough_samples(request.task_type.value, best_model.name):
            reason_codes.append("known_task_performance")
        else:
            reason_codes.append("conservative_defaults")

        return RoutingDecision(
            selected_model=best_model.name,
            provider=best_model.provider,
            score=best_score,
            candidates_considered=len(scored),
            profile=profile.name,
            estimated_latency_ms=self._stats_store.get_latency_p95(
                request.task_type.value, best_model.name
            ),
            rejected=pipeline.rejected,
            ranked=tuple((m.name, s) for m, s in scored),
            reason_codes=tuple(reason_codes),
            fallback_chain=tuple(m.name for m, _ in scored[1:4]),
        )

    # resolve(), resolve_model(), resolve_capability() and all private
    # helpers stay EXACTLY as they are today — including the invocation-
    # time fallback loop inside resolve(). Do NOT rewire them through
    # route(): selection and fallback are separate concerns (reference
    # §19–20), and dependencies.py calls resolve(RoutingPolicy) at startup.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/models/test_router_integration.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/router.py tests/unit/models/test_router_integration.py
git commit -m "feat: add route() primary API to ModelRouter facade"
```

---
## Task 12: Wire stats/model-health stores into the factory

**Files:**
- Modify: `src/draftly/models/factory.py` (`build_model_router()` only)
- Modify: `src/draftly/models/__init__.py`

**Why:** `route()` needs the shared `EMAStatsStore` + `ModelHealthRegistry`. The signature gains OPTIONAL keyword-only stores so composition can share one live cache across the router and the performance repository; existing zero-argument callers (`app/dependencies.py:77`, `integrations/strands/models.py`) keep working unchanged.

- [ ] **Step 1: Update the factory tail**

```python
def build_model_router(
    *,
    stats_store: EMAStatsStore | None = None,
    model_health: ModelHealthRegistry | None = None,
) -> ModelRouter:
```

and replace the final `return ModelRouter(registry=registry, health=health)` with:

```python
    return ModelRouter(
        registry=registry,
        health=health,
        stats_store=stats_store or EMAStatsStore(),
        model_health=model_health or ModelHealthRegistry(),
    )
```

- [ ] **Step 2: Update __init__.py exports**

In `src/draftly/models/__init__.py`, add:

```python
from draftly.models.schemas import ROLE_TO_TASK_TYPE, RoutingDecision, RoutingRequest, TaskType
from draftly.models.profiles import ROUTING_PROFILES, RoutingProfile, get_profile
from draftly.models.pricing import estimate_cost
from draftly.models.performance import EMAStatsStore, ModelHealthRegistry
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `pytest tests/unit/models/ -x`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/draftly/models/factory.py src/draftly/models/__init__.py
git commit -m "feat: wire EMA stats and model-health registries into build_model_router"
```

---

## Task 13: Database stores for routing decisions and performance

**Files:**
- Create: `src/draftly/persistence/stores/routing.py`
- Create: `src/draftly/persistence/migrations/026_routing_decisions.sql`
- Create: `src/draftly/persistence/migrations/027_model_performance.sql`

**Why 026/027:** migrations `024_onboarding.sql` and `025_repositories.sql` are claimed by the onboarding plan — numbering must not collide.

**Pattern:** stores follow the existing `DatabaseClient` convention (`fetch_all`/`fetch_one`/`execute`) used by `DocumentStore` et al., NOT raw asyncpg pools.

- [ ] **Step 1: Create migration 026**

```sql
-- src/draftly/persistence/migrations/026_routing_decisions.sql
CREATE TABLE IF NOT EXISTS routing_decisions (
    id BIGSERIAL PRIMARY KEY,
    request_id TEXT NOT NULL,
    organization_id TEXT,
    task_type TEXT NOT NULL,
    selected_model TEXT NOT NULL,
    provider TEXT NOT NULL,
    score DOUBLE PRECISION NOT NULL,
    candidates_considered INTEGER NOT NULL,
    profile TEXT NOT NULL,
    reason_codes JSONB DEFAULT '[]'::JSONB,
    fallback_chain JSONB DEFAULT '[]'::JSONB,
    estimated_cost DOUBLE PRECISION,
    estimated_latency_ms DOUBLE PRECISION,
    actual_cost DOUBLE PRECISION,
    latency_ms DOUBLE PRECISION,
    success BOOLEAN,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_routing_decisions_task_type ON routing_decisions(task_type);
CREATE INDEX idx_routing_decisions_created_at ON routing_decisions(created_at);
```

- [ ] **Step 2: Create migration 027**

```sql
-- src/draftly/persistence/migrations/027_model_performance.sql
CREATE TABLE IF NOT EXISTS model_performance (
    id BIGSERIAL PRIMARY KEY,
    model_name TEXT NOT NULL,
    task_type TEXT NOT NULL,
    sample_count INTEGER DEFAULT 0,
    mean_latency_ms DOUBLE PRECISION DEFAULT 0.0,
    variance_latency_ms DOUBLE PRECISION DEFAULT 0.0,
    success_rate DOUBLE PRECISION DEFAULT 1.0,
    p50_latency_ms DOUBLE PRECISION DEFAULT 0.0,
    p95_latency_ms DOUBLE PRECISION DEFAULT 0.0,
    quality_ema DOUBLE PRECISION,
    approval_rate DOUBLE PRECISION,          -- human review signal (reference §16)
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(model_name, task_type)            -- per-task stats (reference §13)
);

CREATE INDEX idx_model_performance_lookup ON model_performance(task_type, model_name);
```

- [ ] **Step 3: Implement the stores**

```python
# src/draftly/persistence/stores/routing.py
"""Database stores for routing decisions and model performance."""

from __future__ import annotations

import json
from typing import Any

from draftly.integrations.database.client import DatabaseClient


class DatabaseRoutingStore:
    def __init__(self, client: DatabaseClient | None = None) -> None:
        self.client = client or DatabaseClient()

    async def record_decision(self, row: dict[str, Any]) -> None:
        await self.client.execute(
            """
            INSERT INTO routing_decisions (
                request_id, organization_id, task_type, selected_model, provider,
                score, candidates_considered, profile, reason_codes, fallback_chain,
                estimated_cost, estimated_latency_ms, actual_cost, latency_ms,
                success, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            """,
            row["request_id"],
            row.get("organization_id"),
            row["task_type"],
            row["selected_model"],
            row["provider"],
            row["score"],
            row["candidates_considered"],
            row["profile"],
            json.dumps(list(row.get("reason_codes") or [])),
            json.dumps(list(row.get("fallback_chain") or [])),
            row.get("estimated_cost"),
            row.get("estimated_latency_ms"),
            row.get("actual_cost"),
            row.get("latency_ms"),
            row.get("success"),
            json.dumps(row.get("metadata") or {}),
        )

    async def get_recent_decisions(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all(
            "SELECT * FROM routing_decisions ORDER BY created_at DESC LIMIT $1", limit
        )
        return [dict(row) for row in rows]


class DatabasePerformanceStore:
    def __init__(self, client: DatabaseClient | None = None) -> None:
        self.client = client or DatabaseClient()

    async def upsert_performance(self, row: dict[str, Any]) -> None:
        await self.client.execute(
            """
            INSERT INTO model_performance (
                model_name, task_type, sample_count, mean_latency_ms,
                variance_latency_ms, success_rate, p50_latency_ms,
                p95_latency_ms, quality_ema, approval_rate, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (model_name, task_type) DO UPDATE SET
                sample_count = EXCLUDED.sample_count,
                mean_latency_ms = EXCLUDED.mean_latency_ms,
                variance_latency_ms = EXCLUDED.variance_latency_ms,
                success_rate = EXCLUDED.success_rate,
                p50_latency_ms = EXCLUDED.p50_latency_ms,
                p95_latency_ms = EXCLUDED.p95_latency_ms,
                quality_ema = EXCLUDED.quality_ema,
                approval_rate = EXCLUDED.approval_rate,
                updated_at = NOW()
            """,
            row["model_name"], row["task_type"], row["sample_count"],
            row["mean_latency_ms"], row["variance_latency_ms"],
            row["success_rate"], row["p50_latency_ms"], row["p95_latency_ms"],
            row.get("quality_ema"), row.get("approval_rate"),
        )

    async def get_performance(self, task_type: str, model_name: str) -> dict[str, Any] | None:
        row = await self.client.fetch_one(
            "SELECT * FROM model_performance WHERE task_type = $1 AND model_name = $2",
            task_type, model_name,
        )
        return dict(row) if row else None

    async def get_all(self) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all("SELECT * FROM model_performance")
        return [dict(row) for row in rows]
```

- [ ] **Step 4: Commit**

```bash
git add src/draftly/persistence/stores/routing.py src/draftly/persistence/migrations/026_routing_decisions.sql src/draftly/persistence/migrations/027_model_performance.sql
git commit -m "feat: add routing decision and model performance persistence"
```

---

## Task 14: Repository layer for routing telemetry

**Files:**
- Create: `src/draftly/persistence/repositories/routing.py`
- Modify: `src/draftly/persistence/repositories/__init__.py`

**Interfaces:**
- `RoutingRepository.record_decision(...)` — append-only audit row
- `PerformanceRepository` — outcome recording that updates BOTH the live `EMAStatsStore` (next routing decision benefits immediately) and the PostgreSQL aggregate (durability); plus `warm_start()` / `flush()`

- [ ] **Step 1: Implement the repositories**

```python
# src/draftly/persistence/repositories/routing.py
"""Repository layer for routing decisions and model performance."""

from __future__ import annotations

from typing import Any

from draftly.models.performance import EMAStatsStore, TaskModelStats
from draftly.persistence.stores.routing import DatabasePerformanceStore, DatabaseRoutingStore


class RoutingRepository:
    def __init__(self, store: DatabaseRoutingStore) -> None:
        self._store = store

    async def record(self, decision_row: dict[str, Any]) -> None:
        await self._store.record_decision(decision_row)

    async def recent(self, limit: int = 100) -> list[dict[str, Any]]:
        return await self._store.get_recent_decisions(limit)


class PerformanceRepository:
    """Durability + warm-start bridge for the live EMA cache."""

    def __init__(self, store: DatabasePerformanceStore) -> None:
        self._store = store
        self._stats_store: EMAStatsStore | None = None

    def bind_stats_store(self, stats_store: EMAStatsStore) -> None:
        """Share the router's live cache (called once at composition)."""
        self._stats_store = stats_store

    async def record_outcome(
        self,
        *,
        task_type: str,
        model_name: str,
        success: bool,
        latency_ms: float,
    ) -> None:
        # 1. Live cache first: the very next route() call sees it.
        if self._stats_store is not None:
            self._stats_store.record_outcome(
                task_type, model_name, success=success, latency_ms=latency_ms
            )
        # 2. Durable aggregate.
        await self.flush_entry(task_type, model_name)

    async def flush_entry(self, task_type: str, model_name: str) -> None:
        if self._stats_store is None:
            return
        stats = self._stats_store.get_stats(task_type, model_name)
        if stats is None:
            return
        await self._store.upsert_performance({
            "model_name": model_name,
            "task_type": task_type,
            "sample_count": stats.sample_count,
            "mean_latency_ms": stats.mean_latency_ms,
            "variance_latency_ms": stats.variance_latency_ms,
            "success_rate": stats.success_rate,
            "p50_latency_ms": stats.p50_latency_ms,
            "p95_latency_ms": stats.p95_latency_ms,
            "quality_ema": stats.quality_ema,
            "approval_rate": None,
        })

    async def record_quality(
        self, *, task_type: str, model_name: str, quality: float
    ) -> None:
        if self._stats_store is not None:
            self._stats_store.record_quality(task_type, model_name, quality)
        await self.flush_entry(task_type, model_name)

    async def warm_start(self) -> None:
        """Load persisted aggregates into the live cache at boot."""
        if self._stats_store is None:
            return
        for row in await self._store.get_all():
            stats = TaskModelStats()
            stats.sample_count = row["sample_count"]
            stats.mean_latency_ms = row["mean_latency_ms"] or 0.0
            stats.variance_latency_ms = row["variance_latency_ms"] or 0.0
            stats.success_rate = row["success_rate"] if row["success_rate"] is not None else 1.0
            stats.p50_latency_ms = row["p50_latency_ms"] or 0.0
            stats.p95_latency_ms = row["p95_latency_ms"] or 0.0
            stats.quality_ema = row["quality_ema"]
            key = (row["task_type"], row["model_name"])
            self._stats_store._stats[key] = stats  # direct seed; EMA resumes from history
```

- [ ] **Step 2: Export from repositories package**

In `src/draftly/persistence/repositories/__init__.py`, add:

```python
from draftly.persistence.repositories.routing import PerformanceRepository, RoutingRepository
```

- [ ] **Step 3: Commit**

```bash
git add src/draftly/persistence/repositories/routing.py src/draftly/persistence/repositories/__init__.py
git commit -m "feat: add routing/performance repositories with warm start"
```

---

## Task 15: Wire routing repositories into composition

**Files:**
- Modify: `src/draftly/app/dependencies.py`
- Create: `tests/unit/app/test_routing_composition.py`

**Why:** without this task the stores/repositories are dead code — the same gap the onboarding plan hit. `ModelDependencies` also gains the shared `stats_store` so lifecycle can bind repositories to the router's live cache.

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/app/test_routing_composition.py
"""Composition wiring checks for routing telemetry."""

from __future__ import annotations

import inspect

from draftly.app.dependencies import ModelDependencies, RepositoryDependencies, build_repositories


def test_repository_dependencies_declares_routing_fields():
    params = inspect.signature(RepositoryDependencies.__init__).parameters
    assert "routing" in params
    assert "performance" in params


def test_model_dependencies_declares_stats_store():
    params = inspect.signature(ModelDependencies.__init__).parameters
    assert "stats_store" in params


def test_build_repositories_constructs_routing_repositories():
    src = inspect.getsource(build_repositories)
    assert "DatabaseRoutingStore(" in src
    assert "DatabasePerformanceStore(" in src
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/app/test_routing_composition.py -v`
Expected: FAIL (fields missing)

- [ ] **Step 3: Implement**

In `src/draftly/app/dependencies.py`:

```python
@dataclass(slots=True)
class ModelDependencies:
    fast: Any
    reasoning: Any
    research: Any
    review: Any
    rubric_grader: Any
    router: Any
    max_output_tokens: dict[str, int] | None = None
    stats_store: Any | None = None          # NEW: shared EMAStatsStore


@dataclass(slots=True)
class RepositoryDependencies:
    delivery: DeliveryRepository
    events: EventRepository
    memory: MemoryRepository
    documents: DocumentRepository
    evaluations: EvaluationRepository
    support: SupportRepository
    jobs: JobRepositoryImpl
    reviews: ReviewsRepository
    reviewers: ReviewersRepository
    routing: RoutingRepository              # NEW
    performance: PerformanceRepository      # NEW
```

In `build_models(settings)`, share one store with the factory:

```python
    from draftly.models.performance import EMAStatsStore

    stats_store = EMAStatsStore()
    router = build_model_router(stats_store=stats_store)
    ...
    return ModelDependencies(..., router=router, stats_store=stats_store)
```

In `build_repositories(database)`:

```python
    from draftly.persistence.stores.routing import DatabasePerformanceStore, DatabaseRoutingStore
    from draftly.persistence.repositories.routing import PerformanceRepository, RoutingRepository

    routing = RoutingRepository(store=DatabaseRoutingStore(client=database))
    performance = PerformanceRepository(store=DatabasePerformanceStore(client=database))
    ...
    return RepositoryDependencies(..., routing=routing, performance=performance)
```

- [ ] **Step 4: Bind + warm-start in lifecycle**

In `src/draftly/app/lifecycle.py`, inside startup after dependencies exist:

```python
        repositories = self.dependencies.repositories
        models = self.dependencies.models
        if getattr(models, "stats_store", None) is not None:
            repositories.performance.bind_stats_store(models.stats_store)
            try:
                await repositories.performance.warm_start()
            except Exception:  # cold DB must not block startup
                logger.warning("routing_warm_start_skipped")
```

Run: `cd draftly-agent-backend && python -m pytest tests/unit/app/test_routing_composition.py tests/unit -x -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/app/dependencies.py src/draftly/app/lifecycle.py tests/unit/app/test_routing_composition.py
git commit -m "feat: wire routing telemetry into composition and warm-start at boot"
```

---

## Task 16: Record routing decisions and outcomes in the workflow runner

**Files:**
- Modify: `src/draftly/workflows/context.py`
- Modify: `src/draftly/workflows/runner.py`
- Create: `tests/unit/workflows/test_routing_telemetry.py`

**Why:** telemetry must capture OUTCOMES (success, latency) — not just selections — because that is the dataset adaptive routing learns from (reference §29; spec signal taxonomy). The runner is the single choke point where every graph invocation completes.

- [ ] **Step 1: Add routing_decision to WorkflowContext**

In `src/draftly/workflows/context.py`:

```python
@dataclass
class WorkflowContext:
    repositories: Any = None
    memory: Any = None
    evaluation: Any = None
    feedback: Any = None
    config: Any = None
    tools: Any = None
    #: Concrete strands Model for graph agents (None ⇒ offline/test mode).
    model: Any = None
    hooks: list[Any] = field(default_factory=list)
    storage_dir: str = DEFAULT_SESSION_STORAGE_DIR
    audit_repo: Any = None
    #: RoutingDecision from the adaptive router when per-task routing ran.
    routing_decision: Any | None = None   # NEW
```

- [ ] **Step 2: Write the failing test**

```python
# tests/unit/workflows/test_routing_telemetry.py
"""Telemetry: outcomes recorded around graph invocation."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from draftly.models.schemas import RoutingDecision, RoutingRequest, TaskType
from draftly.workflows.context import WorkflowContext
from draftly.workflows.runner import WorkflowRunner


def _decision():
    return RoutingDecision(
        selected_model="alpha", provider="openrouter", score=0.9,
        candidates_considered=3, profile="support",
        reason_codes=("profile_support",), fallback_chain=("beta",),
    )


@pytest.mark.asyncio
async def test_outcome_recorded_on_success():
    decision = _decision()
    context = WorkflowContext(repositories=MagicMock())
    context.routing_decision = decision
    repositories = context.repositories
    repositories.performance = MagicMock()
    repositories.performance.record_outcome = AsyncMock(return_value=None)
    repositories.performance.flush_entry = AsyncMock(return_value=None)
    repositories.routing = MagicMock()
    repositories.routing.record = AsyncMock(return_value=None)

    runner = WorkflowRunner(context)
    runner.dispatcher.route = MagicMock(return_value=None)  # SKIPPED path exits early;
    # so drive the recording helper directly instead:
    await runner._record_routing_outcome(
        run_id="run-1", success=True, latency_ms=1234.0,
    )

    repositories.routing.record.assert_awaited_once()
    row = repositories.routing.record.await_args.args[0]
    assert row["selected_model"] == "alpha"
    assert row["task_type"] == "support"
    assert row["success"] is True
    assert row["latency_ms"] == 1234.0
    repositories.performance.record_outcome.assert_awaited_once_with(
        task_type="support", model_name="alpha", success=True, latency_ms=1234.0,
    )


@pytest.mark.asyncio
async def test_no_telemetry_without_decision():
    context = WorkflowContext(repositories=MagicMock())
    repositories = context.repositories
    repositories.routing = MagicMock()
    repositories.routing.record = AsyncMock()
    repositories.performance = MagicMock()

    runner = WorkflowRunner(context)
    await runner._record_routing_outcome(run_id="r", success=True, latency_ms=1.0)

    repositories.routing.record.assert_not_awaited()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_routing_telemetry.py -v`
Expected: FAIL (`AttributeError: ... _record_routing_outcome`)

- [ ] **Step 4: Implement in runner.py**

Add the helper + wire into `run()` around the invocation:

```python
    async def run(self, event: dict[str, Any]) -> WorkflowState:
        ...
        # 2. One session + one graph for this run's surface.
        graph = self._graph_factory(run_id, surface)

        # 3. Invoke ... (existing code)
        import time as _time
        started = _time.monotonic()
        result = await graph.invoke_async(
            json.dumps(event),
            invocation_state={...},   # unchanged
        )
        await self._record_routing_outcome(
            run_id=run_id,
            success=result.status == Status.COMPLETED,
            latency_ms=(_time.monotonic() - started) * 1000.0,
        )
        state.result = result
        ...

    async def _record_routing_outcome(
        self, *, run_id: str, success: bool, latency_ms: float
    ) -> None:
        """Best-effort telemetry: never fail the workflow over bookkeeping."""
        decision = getattr(self.context, "routing_decision", None)
        if decision is None:
            return
        try:
            repositories = getattr(self.context, "repositories", None)
            if repositories is None:
                return
            await repositories.routing.record({
                "request_id": run_id,
                "organization_id": None,
                "task_type": decision.profile,
                "selected_model": decision.selected_model,
                "provider": decision.provider,
                "score": decision.score,
                "candidates_considered": decision.candidates_considered,
                "profile": decision.profile,
                "reason_codes": list(decision.reason_codes),
                "fallback_chain": list(decision.fallback_chain),
                "estimated_cost": decision.estimated_cost,
                "estimated_latency_ms": decision.estimated_latency_ms,
                "latency_ms": latency_ms,
                "success": success,
            })
            await repositories.performance.record_outcome(
                task_type=decision.profile,
                model_name=decision.selected_model,
                success=success,
                latency_ms=latency_ms,
            )
        except Exception:
            logger.warning("routing_telemetry_failed", exc_info=True)
```

> The `reviews.py` human-approval hook (spec: strong signal) lands with the reviewer flow adoption — `ReviewsRepository.record_decision()` callers should call `performance.record_quality(...)` once approval data reaches this layer. Deferred deliberately rather than stubbed.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/workflows/context.py src/draftly/workflows/runner.py tests/unit/workflows/test_routing_telemetry.py
git commit -m "feat: record routing decisions and outcomes in workflow runner"
```

---

## Task 17: Per-task routing via RoleAwareModelResolver

**Files:**
- Modify: `src/draftly/integrations/strands/models.py`
- Modify: `src/draftly/integrations/strands/graph.py`
- Modify: `src/draftly/integrations/strands/client.py`
- Modify: `src/draftly/workflows/runner.py` (`_default_graph_factory`)
- Modify: `src/draftly/app/api/routes/github.py` (`resume_review`, line ~363)
- Create: `tests/unit/integrations/test_role_aware_resolver.py`

**Why:** today one shared `model` is passed to every node (`build_graph_for_run(run_id, surface, tools_registry, model, ...)`). Per-task routing means each agent role resolves its own concrete model through `route()` while graphs stay per-run.

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/integrations/test_role_aware_resolver.py
"""Role-aware per-task model resolution."""

from unittest.mock import MagicMock

import pytest

from draftly.integrations.strands.models import (
    RoleAwareModelResolver,
    resolve_model_for_role,
)


@pytest.fixture()
def router():
    from draftly.models.config import ModelConfig
    from draftly.models.health import ProviderHealthRegistry
    from draftly.models.registry import ModelRegistry
    from draftly.models.router import ModelRouter

    provider = MagicMock()
    provider.name = "openrouter"
    provider.create_model.side_effect = lambda cfg: f"MODEL<{cfg.name}>"

    reg = ModelRegistry()
    reg.register_provider(provider)
    reg.register_model(ModelConfig(
        name="writer-model", provider="openrouter", model_id="org/w",
        capabilities=("reasoning", "tool_calling", "structured_output"),
        priority=1,
    ))
    reg.register_model(ModelConfig(
        name="curator-model", provider="openrouter", model_id="org/c",
        priority=2,
    ))
    return ModelRouter(registry=reg, health=ProviderHealthRegistry())


def test_real_roles_map_through_route(router):
    """documentation_engineer must NOT fall back to SUPPORT."""
    resolver = RoleAwareModelResolver(router)
    model = resolver.for_role("documentation_engineer")
    assert model == "MODEL<writer-model>"


def test_memory_curator_resolves_fast_profile(router):
    resolver = RoleAwareModelResolver(router)
    assert resolver.for_role("memory_curator") == "MODEL<curator-model>"


def test_unknown_role_raises_not_silently_defaults(router):
    resolver = RoleAwareModelResolver(router)
    with pytest.raises(ValueError, match="Unknown role"):
        resolver.for_role("intern")


def test_helper_passthrough_non_resolver():
    assert resolve_model_for_role("PLAIN-MODEL", "support_engineer") == "PLAIN-MODEL"


def test_helper_resolves_via_resolver(router):
    assert resolve_model_for_role(
        RoleAwareModelResolver(router), "github_intelligence"
    ) == "MODEL<writer-model>"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/integrations/test_role_aware_resolver.py -v`
Expected: FAIL (`ImportError: cannot import name 'RoleAwareModelResolver'`)

- [ ] **Step 3: Implement**

Append to `src/draftly/integrations/strands/models.py`:

```python
class RoleAwareModelResolver:
    """Resolves a concrete Strands model PER AGENT ROLE via route()."""

    def __init__(self, router: Any) -> None:
        self._router = router

    def for_role(
        self,
        role: str,
        *,
        prompt_text: str | None = None,
        context_tokens: int | None = None,
    ) -> Any:
        from draftly.models.schemas import ROLE_TO_TASK_TYPE, RoutingRequest

        try:
            task_type = ROLE_TO_TASK_TYPE[role]
        except KeyError:
            raise ValueError(
                f"Unknown role '{role}'; add it to ROLE_TO_TASK_TYPE."
            ) from None

        tokens = context_tokens or _estimate_tokens(prompt_text)
        request = RoutingRequest(task_type=task_type, context_tokens=tokens)
        decision = self._router.route(request)

        config = self._router.registry.get_model(decision.selected_model)
        provider = self._router.registry.get_provider(decision.provider)
        return provider.create_model(config)


def _estimate_tokens(prompt_text: str | None) -> int:
    """~4 chars/token heuristic (spec: token estimates from prompt length)."""
    if not prompt_text:
        return 4096
    return max(1024, len(prompt_text) // 4)


def resolve_model_for_role(model_or_resolver: Any, role: str) -> Any:
    """Graph-builder helper: per-role model when a resolver is present,
    otherwise the shared model verbatim (legacy builders untouched)."""
    if hasattr(model_or_resolver, "for_role"):
        return model_or_resolver.for_role(role)
    return model_or_resolver
```

In `src/draftly/integrations/strands/graph.py`, re-export the helper next to `_BUILDERS`:

```python
from draftly.integrations.strands.models import resolve_model_for_role
```

In `src/draftly/integrations/strands/client.py` `__post_init__`, wrap routers once:

```python
        from draftly.models.router import ModelRouter

        if isinstance(self.model, ModelRouter):
            from draftly.integrations.strands.models import RoleAwareModelResolver
            self.model = RoleAwareModelResolver(self.model)
```

In `src/draftly/app/api/routes/github.py` `resume_review` (~line 363), no change needed if the graph is built via `StrandsClient.graph_for_run`; when built directly via `build_graph_for_run`, pass the wrapped resolver as `model=`.

Per-node adoption inside orchestration builders proceeds incrementally with the helper — e.g. in `build_documentation_graph`, the writer/reviewer node factories swap `model` for:

```python
        writer_model = resolve_model_for_role(model, "documentation_engineer")
        reviewer_model = resolve_model_for_role(model, "documentation_reviewer")
```

One builder at a time; non-resolver inputs behave exactly as before.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/integrations/test_role_aware_resolver.py tests/unit -x -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/integrations/strands/models.py src/draftly/integrations/strands/graph.py src/draftly/integrations/strands/client.py src/draftly/app/api/routes/github.py tests/unit/integrations/test_role_aware_resolver.py
git commit -m "feat: per-role adaptive model resolution for strands agents"
```

---

## Task 18: Full test pass and lint/typecheck

**Files:** (verification only)

**Interfaces:** none

- [ ] **Step 1: Run full model test suite**

Run: `pytest tests/unit/models/ -x -v`
Expected: ALL PASS

- [ ] **Step 2: Run full test suite**

Run: `pytest tests/unit/ -x`
Expected: ALL PASS

- [ ] **Step 3: Run project lint**

Run project lint command (check `Makefile`, `pyproject.toml`, or `package.json` for the correct command)
Expected: NO ERRORS

- [ ] **Step 4: Run project typecheck**

Run project typecheck command
Expected: NO ERRORS

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address lint and typecheck issues from adaptive router"
```

---
## Self-Review

- [ ] All `- [ ]` steps present; every Files: section lists concrete paths
- [ ] Profile dimensions match the spec table EXACTLY: (quality, reliability, latency, cost, history) with review = quality-heavy, NOT cost-heavy
- [ ] `ROLE_TO_TASK_TYPE` covers all nine real agent roles; unknown roles raise (no silent SUPPORT fallback)
- [ ] Legacy API untouched: `resolve(RoutingPolicy) -> Model` still used by `app/dependencies.py` at startup; fallback loop preserved (selection != fallback, reference §19–20)
- [ ] Constraint pipeline uses real APIs: `provider_health.get(p).available()` and `ModelHealthRegistry.is_model_healthy()`; no invented methods
- [ ] Quality floors enforced only on KNOWN quality; conservative default (= floor) applies until samples >= 20
- [ ] Tie-breaker sorts by candidate `ModelConfig.priority` ascending — never request priority
- [ ] Cost filter estimates with request tokens (`context_tokens` + `estimated_output_tokens`), unpriced sentinel applied
- [ ] EMA math: quality/success are true EMAs; variance tracked; latency history bounded
- [ ] Migrations numbered 026/027 (024/025 belong to the onboarding plan); `(model_name, task_type)` unique key per reference §13
- [ ] Stores follow the DatabaseClient pattern; repositories wired into RepositoryDependencies + lifecycle warm-start (no dead code)
- [ ] Telemetry records OUTCOMES (success, latency_ms) post-invocation, best-effort so it never breaks workflows
- [ ] Exploration/canary, contextual bandits, tenant-level policy: explicitly deferred (spec non-goals) — not silently missing
