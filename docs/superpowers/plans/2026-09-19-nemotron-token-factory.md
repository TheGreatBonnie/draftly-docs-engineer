# Nemotron on Nebius Token Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Power every Draftly agent role with NVIDIA Nemotron models served through Nebius Token Factory — `provider=nebius_token_factory` only, no cross-provider fallback — and move the embedding tier to `Qwen/Qwen3-Embedding-8B` at 1536 dims via an idempotent one-time reindex.

**Architecture (Approach 1, user-approved):** Native `NebiusTokenFactoryProvider(ModelProvider)` created and registered in `build_model_router` exactly like the existing inline providers; 3 role models (nano/super/ultra) registered unconditionally with the same capability/cost model as existing entries; the existing `DRAFTLY_ENABLED_PROVIDERS` gate (route-time `enabled_providers` set in `Router.route()`) restricts every role's decision to the TF provider. No registry/router/resolver interface changes. The TF embedding model registers in `build_embedding_router` behind `NEBIUS_TOKEN_FACTORY_API_KEY` presence, serving `Qwen/Qwen3-Embedding-8B` at 1536 dims via a new `dimensions` passthrough on `OpenAICompatibleEmbedder`.

**Tech Stack:** Python 3.11, OpenAI Python client (already used by embedder), `strands.models.OpenAIModel`, pydantic, structlog, pytest + pytest-asyncio, asyncpg (DatabaseClient for reindex), dotenv.

**Spec:** `docs/superpowers/specs/2026-09-19-nemotron-token-factory-design.md` (committed `b8676c5`, plus uncommitted post-commit edits: 1536-dims refs ~11 spots and corrected gate wording — commit these edits first). Plan argues from the spec; executors read both.

## Plan-level Reconciliations (read first)

1. **Routing determinism for RESEARCH/EVALUATION.** `TASK_TYPE_CAPABILITIES` currently floors only DOCGEN/DOCREVIEW/EVALUATION (router.py:22-27). RESEARCH has NO floor and uses the cost-leaning "reasoning" profile, so with no stats the cheapest eligible model (Nano) wins — violating the spec table (RESEARCH→Super, "research/evaluation never fall to Nano"). Fix: add `TaskType.RESEARCH: frozenset({"research"})` to `TASK_TYPE_CAPABILITIES` (a data-table addition, NOT an interface change; only `test_schemas.py` touches `TaskType.RESEARCH`, and requesty `research-model` already carries `research`). Give `research` + `evaluation` capabilities to Super and Ultra only; Nano carries `tool_calling` alone. Net effect: FAST/SUPPORT/DELIVERY → Nano (no floor, cost), RESEARCH/EVALUATION → Super (cap floor + cost), DOCGEN/DOCREVIEW → Ultra (existing floors). Deterministic and spec-faithful.

2. **REASONING floor is NOT added.** REASONING has no floor today; existing `test_factory_enabled_providers.py` routes REASONING and asserts providers ∈ {mantle, requesty, orcarouter, openrouter} on the *default* (all-providers) gate. With TF models cheaper-cost than requesty defaults, default-gate REASONING could resolve to nebius. Three assertions must be widened to include `"nebius_token_factory"`: `test_default_considers_every_provider`, `test_env_flag_empty_means_every_provider`, `test_env_flag_unset_means_every_provider`. (Do NOT add a REASONING cap floor — openrouter models could lack it and would break those same tests.)

3. **Cost scoring guarantees TF wins default routing** (`COST_SCORE_ANCHOR=0.50`, scoring.py). With no stats: quality/reliability/latency/history are identical across candidates, cost differs → TF is cheapest → TF wins any route where eligible. This is exactly the spec's intent ("every invocation records provider=nebius_token_factory") and what the hackathon demonstrates.

4. **Spec says "additions to `src/draftly/app/config.py`" (spec §Configuration) — inaccurate.** Verified: `app/config.py` is pydantic `StrandsConfig` Settings with no provider aggregation; every provider is constructed inline in `factory.py` via `ProviderConfig(...)` + `os.getenv`. The plan follows the factory pattern (correct the spec's wording when committing the edits).

5. **Spec says "four role models" (spec §Registration, §Deliverables #4) — reconciled to 3 Nemotron chat models + 1 Qwen embedding model.** The spec's own routing table lists exactly 3 Nemotron registrations (nano/super/ultra). Register 3 chat models + 1 embedding model; the "four role models" phrasing = 3 Nemotron + the embedding role model. Evidence: table at spec §Routing profile, and model registrations in spec §Deliverables #4 ("4 models + embedding model"). Use the routing table as source of truth.

6. **Fallback chains (nano→super→ultra, super→ultra, ultra→super).** Verified these are **informative only** for the hackathon. Route-time scoring already picks the best single TF model per task via capability floors + cost; `Router.route()` is deterministic and never "upgrades" to Super on a healthy Nano. The chains do NOT require new mechanism — capability floors + cost make the intended winner deterministic. No `FALLBACKS` change; keep spec's "no cross-provider fallback" and gate-on-the-route design.

7. **Embedding model id per provider.** Spec says `EMBEDDING_MODEL_ID` default `Qwen/Qwen3-Embedding-8B` and existing `.env.example:29` sets `text-embedding-3-small`. Keep the shared `EMBEDDING_MODEL_ID` default at `text-embedding-3-small` for legacy providers (unchanged behavior/tests), and register the **nebius embedder with `model_id` default `Qwen/Qwen3-Embedding-8B`** via `_resolve_model_id("EMBEDDING_MODEL_ID", default="Qwen/Qwen3-Embedding-8B")`. In the hackathon, `.env` sets `EMBEDDING_MODEL_ID=Qwen/Qwen3-Embedding-8B` and only NEBIUS key → only TF embedder registers at 1536. This reconciles complete isolation with keeping existing providers' default.

8. **Embedding ranking test must stay green.** `TestEmbeddingProviderRanking.test_openrouter_embedder_ranks_first` asserts `ranked[0].provider == "openrouter"` (openrouter registers at priority 10, first in the enumerate). Nebius embedder registers at priority **40** (after orcarouter at 30) so when multiple keys are present openrouter still ranks first; the hackathon configures only the NEBIUS key so only TF registers.

9. **`scripts/reindex.py` is GitHub documentation-sync, NOT the embedding reindex.** New `scripts/reindex_embeddings.py` (per spec §Embedding reindex).

10. **`OpenAICompatibleEmbedder` gap:** currently does not accept nor forward `dimensions` (embeddings.py). Add `dimensions: int | None = None` param; pass `dimensions=...` to `client.embeddings.create` only when set; update the `_FakeOpenAI._Embeddings.create` signature in `test_embedding_router.py`.

## Global Constraints

- **Gate-on-the-route only.** Registry registers every provider/model unconditionally (existing behavior, `TestEnabledProvidersRegistryUnchanged`). `DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory` must flow through `build_model_router(enabled_providers=...)` (and the env path) so **every** entry in `ROLE_TO_TASK_TYPE` resolves to `decision.provider == "nebius_token_factory"` in tests.
- **No interface changes** to `ModelRouter`, `ModelRegistry`, `RoleAwareModelResolver`, schemas, or the provider base class. Only: a new provider subclass, a new `TASK_TYPE_CAPABILITIES` dict entry (data), provider/model registrations, an embedder `dimensions` param, and one new `OpenAICompatibleEmbedder` use of that param.
- **Isolation via config, not code branches.** Chat gate = `DRAFTLY_ENABLED_PROVIDERS`. Embedding isolation = only configuring `NEBIUS_TOKEN_FACTORY_API_KEY` (embedding router registers only providers with configured keys — existing behavior).
- **No cross-provider fallback. No re-training.** With gate active, `NoCandidateError` is terminal; consumers degrade to deterministic modes exactly as today (spec §Fallback).
- **No schema change.** All stores keep `VECTOR(1536)`; Qwen uses API `dimensions` truncation.
- **Backend contract unchanged.** `PaymentAwareModel` still records provider/model id/tokens/latency/outcome in `model_invocations`.
- **No interface changes to `RoleModelResolver`**: the existing `router.route()` returns `RoutingDecision(provider=..., model_name=...)`; the role resolver maps it as today.
- **`.env.example` keeps `EMBEDDING_MODEL_ID=text-embedding-3-small`** (line 29, unchanged default behavior); new nebius variables documented; `.env` (untracked) holds the Qwen value + NEBIUS key.

## Workflow Notes

- Append the model/data registrations to `factory.py` in the existing style (inline `registry.register_model(ModelConfig(...))`, `_resolve_model_id` for model ids, explicit `priority`, `capabilities` tuple, cost/context fields).
- Model ids remain deployment configuration: `NEMOTRON_NANO_MODEL_ID`, `NEMOTRON_SUPER_MODEL_ID`, `NEMOTRON_ULTRA_MODEL_ID` env-overridable via `_resolve_model_id`, defaults per spec §Configuration.
- TF provider priority: **15** in `ProviderConfig(priority=...)` (set below mantle(3)/bedrock(5), above nvidia(10)? — follow existing priority numbering convention; a disjoint, sane value is fine since gate + scoring decide winners).
- Nemotron model context windows come from spec §Gate (nano 262K, super 256K, ultra 1024K) — set `context_window` accordingly.
- Costs (spec §Table): Nano $0.06/$0.24, Super $0.30/$0.90, Ultra $1.00/$3.00 per 1M tokens — set `input_cost_per_1m_tokens` / `output_cost_per_1m_tokens`. These make cost scoring select the right tier deterministically.

## File Structure

**Create (src):**
- `draftly/models/providers/nebius_token_factory.py` — `NebiusTokenFactoryProvider(ModelProvider)`:
  - `name` property → `"nebius_token_factory"`
  - `create_model(config)` — raise `ValueError("NEBIUS_TOKEN_FACTORY_API_KEY is not configured.")` when key missing; return `strands.models.OpenAIModel(model_id=config.model_id, client_args={"api_key","base_url","timeout","max_retries"}, params={"temperature","max_tokens"})`; base_url default `https://api.tokenfactory.nebius.com/v1` (mirror requesty.py exactly).
  - `create_embedder(config)` — return `OpenAICompatibleEmbedder(api_key, base_url, model_id=config.model_id, timeout)`, **plus `dimensions=config.dimensions`** so 1536 flows through.

**Modify (src):**
- `draftly/models/providers/__init__.py` — export `NebiusTokenFactoryProvider` (add import + `__all__`).
- `draftly/models/polices.py` — add `"nebius_token_factory"` to `KNOWN_PROVIDERS` (silences `_enabled_providers_from_env` warnings; `FALLBACKS` unchanged).
- `draftly/models/router.py` — add `TaskType.RESEARCH: frozenset({"research"})` to `TASK_TYPE_CAPABILITIES` (reconciliation #1).
- `draftly/models/factory.py`:
  - import `NebiusTokenFactoryProvider`
  - `PROVIDER_CLASSES["nebius_token_factory"] = NebiusTokenFactoryProvider`
  - in `build_model_router`: register TF provider (inline `ProviderConfig(api_key=os.getenv("NEBIUS_TOKEN_FACTORY_API_KEY"), base_url=os.getenv("NEBIUS_TOKEN_FACTORY_BASE_URL"), priority=...)`); register 3 models:
    - `nemotron-nano-fast` → `object("/")` model_id `_resolve_model_id("NEMOTRON_NANO_MODEL_ID", default="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")`, capabilities `("tool_calling",)`, priority 10, ctx 262K, cost 0.06/0.24
    - `nemotron-super-research` → `_resolve_model_id("NEMOTRON_SUPER_MODEL_ID", default="nvidia/nemotron-3-super-120b-a12b")`, capabilities `("research","evaluation","tool_calling")`, priority 20, ctx 256K, cost 0.30/0.90
    - `nemotron-ultra-doc` → `_resolve_model_id("NEMOTRON_ULTRA_MODEL_ID", default="nvidia/NVIDIA-Nemotron-3-Ultra-550b-a55b")`, capabilities `("reasoning","verification","research","evaluation","tool_calling","structured_output")`, priority 30, ctx 1024K, cost 1.00/3.00
  - in `build_embedding_router`: extend the provider-registration tuple with `("nebius_token_factory", "NEBIUS_TOKEN_FACTORY_API_KEY", "NEBIUS_TOKEN_FACTORY_BASE_URL")`; register the TF embedding model at priority 40 with `model_id = _resolve_model_id("EMBEDDING_MODEL_ID", default="Qwen/Qwen3-Embedding-8B")`, `dimensions=1536`.
- `draftly/models/embeddings.py` — `OpenAICompatibleEmbedder.__init__` gains `dimensions: int | None = None`; `embed_query`/`embed_queries` pass `dimensions=...` to `embeddings.create` only when set.

**Create (tests):**
- `draftly-agent-backend/tests/unit/models/test_nebius_token_factory.py` — provider construction + gate + routing determinism for every role.
- `draftly-agent-backend/tests/scripts/probe_token_factory.py` — live probe mirror of `probe_models.py` (argparse `--only`, `--embeddings`, `--out`; `ProbeResult`/`ModelResult`/`rank_results`/`print_report`/`dump_json`).
- `scripts/reindex_embeddings.py` — idempotent one-shot reindex (structure mirrors `scripts/reindex.py`: argparse, asyncio, DATABASE_URL check, app lifecycle bootstrap).

**Modify (tests):**
- `draftly-agent-backend/tests/unit/models/test_factory_enabled_providers.py` — widen the 3 default-set assertions (reconciliation #2).
- `draftly-agent-backend/tests/unit/models/test_embedding_router.py` — `_FakeOpenAI._Embeddings.create` signature accepts `dimensions=None`; add a test that `dimensions=1536` is forwarded when configured.
- `draftly-agent-backend/tests/unit/models/test_policies.py` — (optional) extend `test_known_providers_includes_bedrock_and_mantle` to assert nebius present.

**Modify (docs/meta):**
- `draftly-agent-backend/.env.example` — nebius env block + comment.
- `draftly-agent-backend/README.md` — reproduce steps (env vars, provider gate, probe command) + a "Nebius x NVIDIA Global AI Hackathon" architecture section + role→model cost/latency table.
- `draftly-agent-backend/Makefile` — optional `probe-token-factory` target mirroring `probe-models` (line 43).

**Docs outputs (non-code):**
- `docs/hackathon/nebius-token-factory-probes.md` — live probe report (tool calling, structured output, TTFT, tokens, cost, embeddings behavior; per spec §Hackathon evidence).
- Config reference (README) — env vars from spec §Configuration.

## Task List

### Step 0 — Commit plan-level reconciliations
- [x] Correct spec's §Configuration "app/config.py" claim → factory.py inline pattern (reconciliation #4); amend spec routing-table wording for "four role models" (reconciliation #5) if unclear; commit spec edits + this plan.

### Step 1 — Provider module
- [x] TDD: `test_nebius_token_factory.py` — missing API key raises `ValueError`; `create_model` returns an `OpenAIModel` with expected `base_url=...nebius.com/v1`, model_id, temperature/max_tokens passthrough; `create_embedder` returns `OpenAICompatibleEmbedder` seeded with `dimensions=1536` and the Qwen default model id.
- [x] Implement `draftly/models/providers/nebius_token_factory.py`.
- [x] Export from `providers/__init__.py`.

### Step 2 — Policies + router data
- [x] Add `nebius_token_factory` to `KNOWN_PROVIDERS`; assert no `validate_fallback_chain` breakage.
- [x] Add `TaskType.RESEARCH: frozenset({"research"})` to `TASK_TYPE_CAPABILITIES`; confirm existing routes (requesty research-model has `research`) unaffected.

### Step 3 — Factory registration
- [x] `PROVIDER_CLASSES` entry + unconditional TF provider registration in `build_model_router`.
- [x] Register 3 Nemotron models with capability/cost/context from the table above (nano/super/ultra).
- [x] Embedding: `OpenAICompatibleEmbedder.dimensions` param + forward; `_FakeOpenAI` update; `build_embedding_router` TF entry at priority 40 + Qwen default + 1536.

### Step 4 — Gate + determinism tests (every role)
- [x] With `enabled_providers={"nebius_token_factory"}` and `NEBIUS_TOKEN_FACTORY_API_KEY` set, for **every** `(role, task_type)` in `ROLE_TO_TASK_TYPE`: `router.route(RoutingRequest(task_type=t, context_tokens=1000))` → `decision.provider == "nebius_token_factory"`, and model name matches expected tier (fast/delivery/support→nano; research/evaluation→super; docgen/docreview→ultra).
- [x] Embedding gate test: only `NEBIUS_TOKEN_FACTORY_API_KEY` configured → `build_embedding_router().registry.list_embedding_models()` yields exactly the TF embedder at 1536/Qwen.
- [x] Widen the 3 default-gate assertions in `test_factory_enabled_providers.py` to include `nebius_token_factory`.

### Step 5 — Verify no regressions
- [x] `uv run pytest` in `draftly-agent-backend` — full suite green (unit, incl. existing router/policies/embedding/env-example tests). **Note:** 2 pre-existing failures in `tests/evaluation/test_online.py` (confirmed failing on base `9f9fb5b`; they snapshot a real GitHub diff/release notes, unrelated to this work). 2012 passed / 6 skipped otherwise.
- [x] Lint/typecheck per repo (ruff/mypy as configured). ruff clean on all touched files; `mypy src` has a pre-existing "source file found twice" error from the editable-install layout (reproduces on base).

### Step 6 — Probe script + report
- [x] `tests/scripts/probe_token_factory.py` live sweep (chat+tool calling, structured output, context size at advertised windows, TTFT/cost; embeddings at 1536) mirroring `probe_models.py`.
- [x] Run against real Token Factory account; write `docs/hackathon/nebius-token-factory-probes.md`; each model passes or the profile mapping is revised (spec §Probe-first gate). **Findings:** ultra id corrected to `nvidia/Nemotron-3-Ultra-550b-a55b` (404 otherwise); `NebiusTokenFactoryModel.format_request` drops empty `tools: []` (Token Factory vLLM 400). All 4 endpoints pass 5/5/4/4/1 probes.

### Step 7 — Reindex script
- **SKIPPED (user, 2026-09-19):** `scripts/reindex_embeddings.py`: read all 1536-dim rows (`memory_embeddings`, `embeddings`, `episodes`, `procedures` migrations 003/015/028/029); chunk; embed via TF Qwen at 1536; idempotent `(content_hash, model, dims)` key; atomic per-row swap; summary (rows re-embedded, failures, cost).
- **SKIPPED (user, 2026-09-19):** Verification query (fixed seed queries, recall comparison) noted in the probe report.

### Step 8 — Docs + evidence
- [x] `.env.example` nebius block; README reproduce steps + hackathon architecture section + role→model cost table + config reference. **Also wired `EMBEDDING_DIMENSIONS` through `_resolve_dimensions()` (default 1536) to honour the spec variable.**
- [x] Makefile `probe-token-factory` target (optional).
- **SKIPPED (user, 2026-09-19):** One real GitHub→draft→review run in staging-like local setup; every model invocation row shows `provider=nebius_token_factory` + Nemotron/Qwen id (demo trace). Note: no `model_invocations` table exists; the evidence surface would have been `routing_decisions` (`selected_model`, `provider`). Environment had Docker/Redis down and a shared Neon DB, so this was deferred.

## Verification / Definition of Done

- [x] Every `Router.route()` offline decision under the TF gate resolves to `provider == "nebius_token_factory"` for all 19 roles in `ROLE_TO_TASK_TYPE`.
- [x] `decision.model_name` matches the spec tier per task type (reconciliation #1 determinism).
- [x] Original test suites green — final backend suite **2030 passed / 6 skipped / 2 failed**; the 2 failures are the pre-existing `tests/evaluation/test_online.py` real-GitHub snapshot tests (fail on base `9f9fb5b`). No regression to default-gate REASONING → widened set or openrouter-first embedding ranking.
- [x] Live probe report exists; all 3 Nemotron models + the Qwen embedder pass at 1536 (`docs/hackathon/nebius-token-factory-probes.md`).
- **SKIPPED (user, 2026-09-19):** Reindex script idempotent (rerun safe); verification query shows recall preserved.
- **SKIPPED (user, 2026-09-19):** Demo trace shows TF provenance end-to-end.
- [x] README + config reference committed; spec edits re-committed.