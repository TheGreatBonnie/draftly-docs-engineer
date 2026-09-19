# Draftly Nemotron on Nebius Token Factory — Design Specification

**Date:** 2026-09-19
**Status:** Approved design, pending written-spec review
**Target:** Nebius x NVIDIA Global AI Hackathon ("Best Apps and Agents" track), standalone implementation

## Summary

Draftly will be powered entirely by NVIDIA Nemotron models served through Nebius Token Factory, with Qwen3-Embedding-8B as the embedding tier. A new `nebius_token_factory` provider implements Draftly's existing `ModelProvider` abstraction, is registered into the existing model registry, and is the *only* admissible provider under the `DRAFTLY_ENABLED_PROVIDERS` gate. Role-to-model routing is capability-balanced: Nemotron Nano handles fast/everyday calls, Nemotron Super handles research and evaluation, and Nemotron Ultra handles documentation generation and review.

This spec is standalone: it covers the provider integration, provider gate, Nemotron routing profile, embedding switch to `Qwen/Qwen3-Embedding-8B` (dimension-truncated to 1024), a probe-first qualification gate, failure handling, reindex, testing, and hackathon evidence. It does not depend on the separate Nebius production-deployment spec.

## Goals

- Add a native `nebius_token_factory` provider that implements the existing `ModelProvider` abstraction.
- Power all Draftly agent roles with Nemotron models through Token Factory.
- Ensure every LLM invocation records `provider=nebius_token_factory` and a Nemotron or Qwen model id.
- Move the embedding tier to `Qwen/Qwen3-Embedding-8B` at 1024 dimensions with a one-time, idempotent corpus reindex.
- Qualify every model with live probes (tool calling, structured output, context size, latency, cost) before it becomes a routing default.
- Preserve Draftly's evidence grounding, evaluation loops, human review, and GitHub delivery.
- Produce demonstrable hackathon evidence: probe report, routing summary, README section, and an end-to-end run trace.

## Non-goals

- Changing the role-to-task-type mapping or role plumbing.
- Migrating pgvector column types or similarity-index configuration.
- Changing the model registry, router, or `RoleAwareModelResolver` interfaces.
- Cross-provider fallback of any kind.
- Fine-tuning or distillation of Nemotron models.
- Video script and submission copy for the hackathon (owned by the Nebius production-deployment cutover).

## Scope

### Provider module

New file `src/draftly/models/providers/nebius_token_factory.py`.

- Class `NebiusTokenFactoryProvider(ModelProvider)` with `name == "nebius_token_factory"`.
- `create_model(config)` — mirrors the `RequestyProvider` pattern:
  - requires `api_key` (raise/classify when missing)
  - returns `strands.models.OpenAIModel` with
    - `base_url="https://api.tokenfactory.nebius.com/v1"`
    - `api_key` from provider config (never logged)
    - `model` from `ModelConfig.model_id`
    - `temperature`/`max_tokens` passthrough from `ModelConfig`
- `create_embedder(config)` — an OpenAI-compatible embeddings client hitting `/v1/embeddings` with model `Qwen/Qwen3-Embedding-8B` and `dimensions=1024`.

### Configuration

Additions to `src/draftly/app/config.py`:

- A `ProviderConfig` for nebius: `api_key`, `base_url` (default the Token Factory endpoint), `enabled`, `priority`.
- Environment variables:
  - `NEBIUS_TOKEN_FACTORY_API_KEY`
  - `NEBIUS_TOKEN_FACTORY_BASE_URL`
  - `NEMOTRON_NANO_MODEL_ID` (default `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`)
  - `NEMOTRON_SUPER_MODEL_ID` (default `nvidia/nemotron-3-super-120b-a12b`)
  - `NEMOTRON_ULTRA_MODEL_ID` (default `nvidia/NVIDIA-Nemotron-3-Ultra-550b-a55b`)
  - `EMBEDDING_MODEL_ID` (default `Qwen/Qwen3-Embedding-8B`)
  - `EMBEDDING_DIMENSIONS` (default `1024`)
  - `DRAFTLY_ENABLED_PROVIDERS` (existing gate; set to `nebius_token_factory`)
- Model ids remain deployment configuration, not hard-coded architecture.

### Registration and gate

- When `"nebius_token_factory"` is present in `DRAFTLY_ENABLED_PROVIDERS`, the registry registers exactly one provider plus the four role models and the embedding model, all with `provider="nebius_token_factory"`.
- No other provider is registered when the gate is active. Exclusion happens at registration time, not call time.

### Nemotron routing profile

Seven task types map to Nemotron as follows:

| Task type | Models | Role fallback chain |
| --- | --- | --- |
| `FAST` (classifier, notify, memory_curator) | Nano-30B-A3B ($0.06/$0.24 per M tokens) | Nano → Super → Ultra |
| `SUPPORT` (support_engineer) | Nano-30B-A3B | Nano → Super → Ultra |
| `DELIVERY` (github_delivery) | Nano-30B-A3B | Nano → Super → Ultra |
| `RESEARCH` (github_intelligence, research, context, content_strategist) | Super-120b ($0.30/$0.90) | Super → Ultra |
| `EVALUATION` (deepeval, initial_evaluator, content_judge, rubric grader) | Super-120b | Super → Ultra |
| `DOCUMENTATION_GENERATION` (documentation_engineer, knowledge_extractor, blog/social writers) | Ultra-550b ($1/$3) | Ultra → Super |
| `DOCUMENTATION_REVIEW` (documentation_reviewer, recommender) | Ultra-550b | Ultra → Super |

Rationale per the track guidance: Nano/small models keep the app responsive and credits stretch; Super is the research/evaluation workhorse; Ultra is reserved where Draftly's evidence-grounded writing quality depends on frontier-tier reasoning.

### Embeddings

- Model `Qwen/Qwen3-Embedding-8B` at `dimensions=1024`.
- Existing vector space is replaced by a one-time, idempotent reindex (Section "Embedding reindex"). No schema/column change; cosine-similarity index configuration unchanged.
- The same retry policy applies to embedder calls; a failed embed degrades indexing but never blocks the workflow.

## Probe-first qualification gate

`tests/scripts/probe_token_factory.py` run against the real Token Factory account before routing defaults are promoted. Per model, it verifies:

- Chat + tool calling: emits a valid tool call with correctly nested arguments in the shape Strands parses.
- Structured output: JSON-schema-constrained completion parses and validates.
- Context size: long prompt at the advertised context (262K/256K/1024K) completes within budget.
- Latency/cost: TTFT and token counts recorded.

For embeddings, `Qwen/Qwen3-Embedding-8B` at `dimensions=1024` returns 1024-dim vectors for a mixed corpus and cosine similarity behaves.

Each model passes or the profile mapping is revised before implementation proceeds. Results are written to `docs/hackathon/nebius-token-factory-probes.md`.

## Failure handling

### Retry policy

- OpenAI-compatible client retries: capped exponential backoff with jitter for timeouts, rate limits (429), and transient 5xx.
- Bounded retry budget; exhaustion surfaces a classified `ModelError` with a type: `timeout`, `rate_limit`, `server`, `auth`, or `empty_output`.

### Fallback

- Fallback only to another Token Factory model that satisfies the same capability requirement (chains per the table above).
- Never downward below capability need (e.g., research/evaluation never fall to Nano).
- No cross-provider fallback. With the gate active, `NoCandidateError` (the router's offline signal) is the terminal outcome if Token Factory is fully unavailable; consumers degrade to deterministic modes exactly as they do today.

### Observability

- `PaymentAwareModel` continues to record every invocation with `provider=nebius_token_factory`, model id, tokens, latency, and outcome. Failed calls remain auditable in the `model_invocations` store.

## Embedding reindex

`scripts/reindex_embeddings.py`, run once as a one-shot job before the routing change is promoted.

- Reads all content rows currently embedded (docs, repo evidence, memory) from pgvector-backed stores.
- Chunks changed content; idempotent by a `(content_hash, model_id, dims)` key.
- Calls `Qwen/Qwen3-Embedding-8B` via the Token Factory client at 1024 dims; writes new vectors; deletes old-model vectors atomically per row after successful insert.
- Emits a summary: rows re-embedded, failures, and cost.

A verification query compares retrieval quality on a fixed set of seed queries before and after (recall of expected chunks), recorded in the probe report.

## Testing strategy

### Unit tests (stubbed client, no network)

- Provider construction: required `api_key`, correct `base_url`, `dimensions=1024` flow to embedder, `temperature`/`max_tokens` passthrough.
- Gate: with `DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory`, the registry contains only that provider; every role's `Router.route()` returns a TF decision; the embedding resolves to `Qwen/Qwen3-Embedding-8B` at 1024.
- Retry/backoff: timeouts, 429s, 5xx trigger retries with jitter; exhaustion raises classified errors.
- Fallback chains: Nano→Super→Ultra, Super→Ultra, Ultra→Super; never downgrades below capability need.

### Contract tests (recorded/erased HTTP)

- OpenAI-compatible chat + tool-call request/response shapes as Strands expects.
- `/v1/embeddings` request (model, `dimensions=1024`) and response (vector length).

### Live probes

The Section "Probe-first qualification gate" suite, gating promotion.

### Integration test

One real GitHub→draft→review run in a staging-like local setup where every `model_invocations` row shows `provider=nebius_token_factory` and a Nemotron/Qwen model id.

## Hackathon evidence

- `docs/hackathon/nebius-token-factory-probes.md` — live probe report (tool calling, structured output, TTFT, tokens, cost, embeddings behavior).
- Routing summary — role → Nemotron model mapping with cost/latency table.
- README diff in `draftly-agent-backend` — reproduce steps (env vars, provider gate, probe command) and a "Nebius x NVIDIA Global AI Hackathon" architecture section.
- Config reference — the environment variables above.
- Demo trace — one recorded end-to-end run showing `provider=nebius_token_factory` provenance.

## Deliverables

1. `nebius_token_factory` provider module.
2. Config additions and env vars.
3. Registry/gate wiring with only-the-provider assertion.
4. Routing profile registration (4 models + embedding model).
5. `tests/scripts/probe_token_factory.py` and probe report.
6. `scripts/reindex_embeddings.py` and verification query.
7. Unit, contract, live, and integration tests.
8. README section and config reference.

## References

- Nebius Token Factory model catalog: https://tokenfactory.nebius.com/model-catalog.md
- Nebius Token Factory quickstart: https://docs.tokenfactory.nebius.com/quickstart
- Hackathon overview: https://nebiusglobalaihackathon.devpost.com/
- Existing provider pattern: `src/draftly/models/providers/requesty.py`
- Provider abstraction: `src/draftly/models/providers/base.py`
- Router: `src/draftly/models/router.py`
- Registry: `src/draftly/models/registry.py`
- Role resolver: `src/draftly/integrations/strands/models.py`
- Task-type mapping: `src/draftly/models/schemas.py`