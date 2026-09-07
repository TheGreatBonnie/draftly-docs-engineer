# Adaptive Router Design (Phases 1–3)

Date: 2026-08-22
Status: Approved (design reviewed in chat)
Scope: `draftly-agent-backend/src/draftly/models/` + graph model-resolution wiring

## Problem

`ModelRouter` is a capability-aware fallback router: it filters by
capability, orders candidates by static `(preferred, FALLBACKS chain,
priority)`, and returns the first healthy instantiation. Models are
resolved once at startup (`build_models()`), so every agent in every run
shares one concrete model regardless of task complexity, cost, or
latency needs.

## Goal

Route each task to the best eligible model using hard constraints plus
deterministic profile-weighted scoring, learn from outcomes (DeepEval
scores, human review approvals, invocation telemetry), and improve
future selections — without breaking existing agents or providers.

Non-goals (Phase 4+): exploration/canary traffic, contextual bandits,
org-level tenant policy overrides.

## Architecture decision

Evolve the single `ModelRouter` (Approach A). New modules carry the
logic; `router.py` stays a facade. `route(RoutingRequest)` becomes the
primary API; legacy `resolve()` / `resolve_model()` /
`resolve_capability()` delegate through it.

```
models/
├── router.py            # facade: route() primary, legacy methods delegate
├── schemas.py           # RoutingRequest, RoutingDecision, TaskType
├── constraints.py       # ordered hard-constraint pipeline
├── scoring.py           # profile-weighted deterministic scorer
├── profiles.py          # role/task_type → weights, quality floor, budgets
├── performance.py       # EMA stats store + PG write-through, ModelHealthRegistry
├── pricing.py           # cost estimation from ModelCost metadata
```

## Routing pipeline

1. **RoutingRequest** — frozen dataclass: role, task_type, prompt_tokens,
   expected_output_tokens, required_capabilities, complexity,
   reasoning_required, latency_budget_ms, cost_budget_usd,
   quality_requirement, context_tokens, workflow, request_id.
   `TaskType` is a StrEnum mapped 1:1 from today's roles.
2. **Constraints** (hard filters, §33 precedence): provider enabled →
   capabilities ⊆ model capabilities → context_tokens ≤ context_window
   → provider health available → model health available → estimated cost
   ≤ budget → p95 latency estimate ≤ budget. Soft constraints (cost,
   latency) relax before hard ones when all candidates are eliminated.
3. **Scoring** — `score = Σ wᵢ·sᵢ` over quality, reliability, latency,
   cost, task-history; weights from routing profiles; static priority is
   only the final tie-breaker.
4. **Decision** — RoutingDecision with selection, score, ranked
   candidates, reason_codes, fallback_chain.

### Routing profiles (defaults)

| Profile | quality | reliability | latency | cost | history | quality floor |
|---|---|---|---|---|---|---|
| support/fast | 0.25 | 0.15 | 0.35 | 0.25 | — | 0.80 |
| documentation_generation | 0.40 | 0.25 | 0.10 | 0.10 | 0.15 | 0.90 |
| documentation_review / evaluation | 0.50 | 0.30 | 0.05 | 0.10 | 0.05 | 0.93 |
| delivery | 0.40 | 0.35 | 0.15 | 0.10 | — | 0.95 |

## Operational layer

- **Pricing**: optional `input_cost_per_1m_tokens`,
  `output_cost_per_1m_tokens`, `context_window` on `ModelConfig`.
  Unpriced models get a conservative sentinel cost.
- **Model-level health**: `ModelHealthRegistry` keyed
  `(provider, model_name)`, same cooldown/threshold semantics as
  `ProviderHealthRegistry`. A healthy provider can host a failing model.
- **Latency tracking**: rolling p50/p95 per model from invocation
  outcomes.

## Adaptive layer

- **EMA store** keyed `(model, task_type, role, complexity_bucket,
  context_bucket)`: `new = α·latest + (1−α)·prior`, α=0.05; tracks
  sample_count, mean, variance, success_rate, p50/p95 latency.
- **PostgreSQL write-through** via existing DatabaseClient/repository
  pattern:
  - `routing_decisions` (append-only audit): request_id, organization_id,
    workflow, role, task_type, model, provider, complexity,
    context_tokens, selected_score, estimated_cost, actual_cost,
    latency_ms, success, fallback_used, created_at
  - `model_performance` (upserted aggregates): model, task_type, role,
    sample_count, quality_mean, quality_variance, success_rate,
    p50_latency, p95_latency, approval_rate, updated_at
- **Warm start**: boot loads `model_performance` aggregates into the
  in-memory EMA store. Router reads memory only; persistence is async
  and non-blocking for selection.
- **Feedback signals** (§17 weighting): strong = DeepEval score, human
  approval/rejection, production failure, tool failure; medium =
  retries, latency, timeout, provider error; weak = ignored for now.
  Hooks: invocation completion, `ReviewsRepository.record_decision`,
  evaluation workflow completion.
- Quality estimates enter scoring once samples ≥ threshold (default 20);
  before that, per-profile conservative defaults apply.

## Lazy migration

- New `RoleAwareModelResolver(router)` in
  `integrations/strands/models.py`: `.for_role(role)` builds a
  RoutingRequest (token estimates from prompt length, complexity from
  profile defaults) and returns a concrete Strands `Model`.
- `_resolve_runtime_model()` passes the resolver into graph builders;
  each agent factory call inside `build_documentation_graph` /
  `build_support_graph` resolves per role. Graphs build per-run
  (`build_graph_for_run`), giving per-task routing.
- Call sites updated: `app/api/routes/github.py`,
  `workflows/runner.py`, `integrations/strands/client.py`.
- `resolve_concrete_model()` unchanged for LLM-judge evaluators.

## Pre-work cleanup

- Remove duplicate `fast-openrouter` registration (factory.py).
- `ModelRegistry.register_model()` raises on duplicate names.
- FALLBACKS chains gain mantle/bedrock so those models become reachable
  as candidates.

## Testing

Unit (`tests/unit/models/`): constraint ordering/relaxation, EMA math,
weight normalization, tie-breaking, duplicate-registration rejection,
mantle/bedrock candidate regression. Integration: route → decision →
outcome-record cycle with stub providers. Commands: `pytest
tests/unit/models/ -x`, project lint/typecheck.

## Implementation order

Phase 0 cleanup → Phase 1 deterministic router (schemas, profiles,
constraints, scoring, facade) → Phase 2 operational (model health,
pricing, latency tracking) → Phase 3 adaptive (EMA store, PG schema +
repo, telemetry hooks, warm start) → lazy migration → full test pass.
