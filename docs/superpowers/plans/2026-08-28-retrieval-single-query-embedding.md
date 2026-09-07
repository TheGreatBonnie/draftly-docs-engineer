# Single-Query-Embedding Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four outcomes for onboarding initialization:

1. Eliminate the redundant per-candidate query embedding in `MemoryRetrieval.retrieve` so each `recall()` triggers exactly one embedding-model call instead of 1 + N (fixes the 1,501-call amplification and the embedding-log flood in stages 2/3).
2. Make LLM model routing visible in the terminal during stages — one INFO line per `_llm_generate` call identifying the concrete provider/model answering. Today only the embedding router logs; the LLM `ModelRouter`'s own `router attempting/resolved` lines (`models/router.py:190-206`) never fire during stages because `WorkflowContext.model` is a concrete resolved `Model` (`app/lifecycle.py:266-280`), not the router.
3. Add structlog lifecycle lines for all five init stages — `stage_start` / `stage_complete` with outcome stats and duration — so the terminal shows stage boundaries with the same fidelity the SSE stream delivers.
4. Wire the adaptive `ModelRouter` into the onboarding init stages so each stage routes its LLM work per-role and records per-call outcome telemetry — the ~500 extraction + sampled evaluation + recommendation calls auto-warm the `model_performance` store on the first real run.

**Architecture:** `MemoryRetrieval.retrieve` currently embeds the query twice per retrieval — once inside `DomainMemoryRepository.search` and then once *per candidate record* in its similarity loop. We compute the query embedding a single time in `retrieve`, pass it into `search` as a new optional `embedding` kwarg, and reuse the same vector for every cosine similarity computation. Public signatures of `retrieve`/`retrieve_multi`/`recall` are unchanged; `search` gains one backward-compatible optional parameter.

Tasks 2 and 3 are observability-only: they change no routing, retrieval, or stage behavior, and must not rely on the `strands`/`httpx` loggers (suppressed at WARNING in `observability/logging.py:90-92`) — the new lines are emitted by Draftly's own structloggers.

Task 4 replaces the fixed runtime model with the adaptive router: `_resolve_runtime_model` (`app/lifecycle.py:266-280`) stops calling `resolve_concrete_model` and instead returns a `RoleAwareModelResolver(self.dependencies.models.router)` — the same wrapping `StrandsClient.__post_init__` already does (`integrations/strands/client.py:41-42`), so graph builders' `resolve_model_for_role(context.model, role)` contract is preserved. Each onboarding LLM stage (2/3/5) resolves its role's concrete model plus its `RoutingDecision` (`knowledge_extractor`→DOCUMENTATION_GENERATION, `initial_evaluator`→EVALUATION, `recommender`→DOCUMENTATION_REVIEW), invokes `_llm_generate(..., telemetry=recorder.record)`, updates the live EMA store per call with `record_outcome(..., flush=False)`, and persists once per stage via `flush_entry` — auto-warming the same `model_performance` rows the graph runner reads (`workflows/runner.py:270-271`). Offline parity is preserved: resolver degradation returns `(None, None)` and stages fall back to today's deterministic/heuristic behavior.

**Tech Stack:** Python 3.11 asyncio, structlog, CockroachDB/Redis vector store (via `MemoryRepository.semantic_search`).

**Spec:** N/A — codebase-driven optimization. Motivation and call-path evidence in the Overview below (files: `src/draftly/memory/retrieval.py`, `src/draftly/memory/repository.py`, invoked by `src/draftly/memory/service.py::recall` and `src/draftly/workflows/onboarding/stages.py:211,357`).

## Overview / Motivation

During onboarding initialization, `run_knowledge_construction` and `run_initial_evaluation` each call `context.memory.recall(namespace="documents", query="*", limit=500)`. Each recall fans out to:

1. `MemoryService.recall` → `MemoryRetrieval.retrieve` (`retrieval.py:23-45`).
2. `repository.search(...)` which embeds the query **once** (`repository.py:64`).
3. The similarity loop which embeds the **same query** once **per candidate** (`retrieval.py:41`).

For `limit=500` the candidate count is `max(limit * 3, 10) = 1500`, so today a single recall makes **1 + N (up to 1501) embedding-model calls**, hundreds to thousands of additional HTTP round-trips and "embedding router attempting/resolved" INFO log lines per stage (see `models/embeddings.py:102,144` — one pair per `embed_query`).

The identical query string is embedded N+1 times. Beyond pure waste, distinct per-candidate embed calls can also return marginally different vectors (provider nondeterminism), making cosine scores inconsistent across candidates. Computing the vector once and reusing it fixes both the amplification and the inconsistency.

**Expected impact:** `recall(limit=500)` goes from ~1501 embed calls to **1**. Two such recalls in an onboarding run → the embedding-log flood disappears, and provider load drops by ~1500× during the worst stage.

## Global Constraints

- **No new dependencies.** Pure stdlib + existing `EmbeddingService`.
- **Public API preserved.** `MemoryService.recall`, `MemoryRetrieval.retrieve`, and `MemoryRetrieval.retrieve_multi` signatures stay byte-for-byte identical. Callers outside `retrieve` (e.g. `episodic/service.py`, `procedural/service.py`) are untouched.
- **Backward-compatible `search`:** `DomainMemoryRepository.search` gains an optional keyword-only `embedding` parameter (default `None`), so any caller not passing it behaves exactly as before (embeds internally).
- **Behavioral parity:** when no embedding is supplied, `search` must still embed — test pins this.
- **Ruff clean:** `ruff check src tests workers` must pass (use `.venv/bin/ruff` — `ruff` is not on `PATH` in this environment).
- **Test harness:** all pytest runs use `.venv/bin/python -m pytest` from the `draftly-agent-backend` directory.
- **INFO-level, greppable, structlog:** every new log uses `logger.info` (visible at the currently configured level), carries key-value fields, uses a meaningful event name, and includes `stage=` / `provider=` / `model=` keys so terminal output is filterable per stage or provider.
- **Noise budget:** LLM routing is one compact line per call (mirrors the embedding router's own per-call precedent). Chunk progress logs stay batched — one line per batch, never per chunk.
- **Resolver offline parity:** `RoleAwareModelResolver.for_role` / `for_role_with_decision` degrade to `None` / `(None, None)` on `NoCandidateError` (never raise) so stages keep deterministic-only mode; legacy concrete models and non-resolver `context.model` values stay supported via `stages._resolve_stage_model`.
- **Telemetry default-off:** `_llm_generate(..., telemetry=None)` default keeps existing callers byte-compatible; outcomes are recorded only when a routing decision is present.
- **Single flush per stage:** per-call outcomes update the live EMA store with `record_outcome(..., flush=False)`; each stage persists once via `flush_entry` at stage end — one DB upsert per `(task_type, model_name)` per stage instead of ~500 per-call upserts.
- **Routing keys:** outcome `task_type` and `model_name` must match `workflows/runner.py:270-271` keying (`decision.task_type` / `decision.selected_model`) so onboarding warms the same rows the runner reads.
- **Role map additive-only:** new roles (`knowledge_extractor`, `initial_evaluator`, `recommender`) must not disturb existing mappings (`memory_curator` already → FAST).
- **Commit policy:** the user recently instructed *not* to commit during plan execution. The commit step below is included per repo convention but **must be confirmed with the user before running** — skip it if they maintain the no-commit instruction.

---
### Task 1: Embed the retrieval query exactly once

**Files:**
- Modify: `src/draftly/memory/repository.py:56-70` — add optional `embedding` to `search`.
- Modify: `src/draftly/memory/retrieval.py:12-45` — compute one query embedding, reuse it.
- Test: `tests/domain/test_memory.py` — add an embed-counting spy and three assertions.

**Interfaces:**
- Consumes: `EmbeddingService.embed(text: str) -> list[float]` (`memory/embeddings.py:55-66`); existing `DomainMemoryRepository.search`; `MemoryRetrieval` (already constructed by `MemoryService`, `service.py:26`).
- Produces: `DomainMemoryRepository.search(*, namespace, query, limit=10, org_id=None, embedding: Sequence[float] | None = None) -> list[dict]` — new kwarg; `MemoryRetrieval.retrieve(...)` unchanged externally, now 1 embed call per invocation.

- [ ] **Step 1: Write the failing tests**

Append to `tests/domain/test_memory.py` (near the `make_service` helper), a spy that counts `embed()` calls:

```python
class CountingEmbeddings(EmbeddingService):
    """EmbeddingService spy counting embed() calls (hash fallback)."""

    def __init__(self) -> None:
        super().__init__(router=False)
        self.calls = 0

    async def embed(self, text: str) -> list[float]:
        self.calls += 1
        return _hash_embed(text)
```

Then add these three tests to the `TestMemoryRetrieval` class (lines 181-194):

```python
    async def test_retrieve_embeds_query_once(self) -> None:
        service, embeddings = self._service_with_spy()
        for content in ("connection pooling basics", "pool sizing rules", "pool reuse"):
            await service.remember(Knowledge(namespace="knowledge", content=content))
        embeddings.calls = 0
        retrieval = MemoryRetrieval(service.repository)
        results = await retrieval.retrieve(namespace="knowledge", query="pooling", limit=5)
        assert len(results) == 3
        assert embeddings.calls == 1
        assert all("similarity" in r for r in results)

    async def test_search_skips_embedding_when_precomputed(self) -> None:
        service, embeddings = self._service_with_spy()
        await service.remember(Knowledge(namespace="knowledge", content="pooling"))
        embeddings.calls = 0
        await service.repository.search(
            namespace="knowledge", query="pooling", embedding=[1.0, 0.0]
        )
        assert embeddings.calls == 0

    async def test_search_embeds_when_no_embedding_given(self) -> None:
        service, embeddings = self._service_with_spy()
        await service.remember(Knowledge(namespace="knowledge", content="pooling"))
        embeddings.calls = 0
        await service.repository.search(namespace="knowledge", query="pooling")
        assert embeddings.calls == 1
```

And a module-level helper in the `TestMemoryRetrieval` class:

```python
    async def _service_with_spy(self):
        embeddings = CountingEmbeddings()
        repo = FakeMemoryRepository()
        service = MemoryService(
            repository=DomainMemoryRepository(cast(MemoryRepository, repo), embeddings),
        )
        return service, embeddings
```

Also add the top-level import `_hash_embed` and delete the lazy local import inside `test_hash_embedder_is_deterministic_and_normalized` (line ~173):

```python
from draftly.memory.embeddings import _hash_embed
```

(Add it as its own import line near the other imports; `EmbeddingService` is already available from `from draftly.memory import EmbeddingService`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/domain/test_memory.py -q -k "embeds_query_once or embedding"`

Expected: `test_retrieve_embeds_query_once` FAILS — current code calls `embed` 1× (inside `search`) + N× (per candidate) = 4 total, not 1. `test_search_skips_embedding_when_precomputed` FAILS with `TypeError` (unexpected keyword argument `embedding`). `test_search_embeds_when_no_embedding_given` PASSES already (current behavior).

- [ ] **Step 3: Implement — `repository.py`**

In `src/draftly/memory/repository.py` add `from collections.abc import Sequence` to the imports and change `search`:

```python
    async def search(
        self,
        *,
        namespace: str,
        query: str,
        limit: int = 10,
        org_id: str | None = None,
        embedding: Sequence[float] | None = None,
    ) -> list[dict[str, Any]]:
        """Semantic search. ``embedding`` lets callers reuse one query vector
        instead of re-embedding; when omitted the query is embedded here."""
        if embedding is None:
            embedding = await self.embeddings.embed(query)
        return await self.repository.semantic_search(
            namespace=namespace,
            embedding=embedding,
            limit=limit,
            org_id=org_id,
        )
```

- [ ] **Step 4: Implement — `retrieval.py`**

Replace `MemoryRetrieval.retrieve` (lines 23-45) with:

```python
    async def retrieve(
        self,
        *,
        namespace: str,
        query: str,
        limit: int = 10,
        min_similarity: float = 0.0,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Semantic search, then re-rank by recency/importance/quality.

        The query is embedded exactly once and reused for both the DB search
        and the in-process similarity pass — previously the identical query
        was embedded once per candidate (a 1 + N embedding amplification).
        """
        query_embedding = await self.repository.embeddings.embed(query)
        candidates = await self.repository.search(
            namespace=namespace,
            query=query,
            limit=max(limit * 3, 10),
            org_id=org_id,
            embedding=query_embedding,
        )
        for record in candidates:
            record["similarity"] = _cosine(record.get("embedding"), query_embedding)
        if min_similarity > 0:
            candidates = [r for r in candidates if r["similarity"] >= min_similarity]
        return self.ranking.rank(candidates, limit=limit)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/domain/test_memory.py -q`

Expected: all pass (retrieval now embeds once; precomputed `embedding` skips embedding; omitted `embedding` still embeds).

- [ ] **Step 6: Full regression + lint**

```bash
cd draftly-agent-backend
.venv/bin/python -m pytest tests/domain/test_memory.py -q
.venv/bin/python -m pytest tests -q
.venv/bin/ruff check src tests workers
```

Expected: `tests/domain/test_memory.py` green; full `tests` suite green (no callers depended on the per-candidate re-embed); ruff clean.

Manual spot-check that the amplification is gone at the call sites responsible for the observed flood (no code change — verify by reading, or by grepping):

```bash
grep -n "embeddings.embed(query)" src/draftly/memory/retrieval.py   # expect exactly 1
grep -rn "self.repository.search(" src/draftly/memory/retrieval.py   # passes embedding=
```

- [ ] **Step 7: Commit tasks 1-3 (confirm first — user previously required no commits)**

Task 4 has its own commit step below; this step covers Tasks 1-3 only.

```bash
cd draftly-agent-backend
git add src/draftly/memory/repository.py src/draftly/memory/retrieval.py \
        src/draftly/workflows/onboarding/stages.py \
        src/draftly/workflows/onboarding/initialize.py \
        tests/domain/test_memory.py \
        tests/unit/workflows/test_onboarding_stages.py \
        tests/unit/workflows/test_onboarding_initialize.py
git commit -m "perf+observability: embed retrieval query once; log LLM routing and init stage lifecycle"
```

If the user still holds their no-commit instruction, skip this step and note it in the plan-completion notes.

---
### Task 2: Log LLM model routing per `_llm_generate` call

**Why:** `WorkflowContext.model` is a *concrete* Strands Model resolved at startup (`_resolve_runtime_model`, `app/lifecycle.py:266-280`), so the `ModelRouter.resolve()` `router attempting/resolved` INFO lines (`models/router.py:190-206`) never fire during stages. `_llm_generate` (`workflows/onboarding/stages.py:142-162`) logs nothing about which model/provider answers — the gap vs. the embedding router's own `attempting/resolved` lines (`models/embeddings.py:102,144`). When no provider keys are configured, `context.model is None` (offline/deterministic) and the terminal shows no signal at all. This task adds the missing per-call routing line so the LLM path is as visible as the embedding path.

*Note for Task 4 integration:* after Task 4, `WorkflowContext.model` becomes a `RoleAwareModelResolver` and stages pass the *routed* concrete model into `_llm_generate`. `_describe_routing` is unaffected — it reads the concrete model's `config["model_id"]`, so the log will then show the router's chosen `(provider, model)` per stage.

**Files:**
- Modify: `src/draftly/workflows/onboarding/stages.py` — add `_describe_routing` helper + an INFO line in `_llm_generate`.
- Test: `tests/unit/workflows/test_onboarding_stages.py`.

**Interfaces:**
- Produces: `_describe_routing(model: Any) -> dict[str, str]` → `{"provider": str, "model": str}`; `_llm_generate` emits `logger.info("llm_generate provider=... model=... output_model=... prompt_chars=...")` once per call.
- Identity source: the concrete Strands provider's config dict (`model.config["model_id"]`, e.g. `"gpt-4o"`) and the provider class name (`type(model).__name__` minus the `Model` suffix, lowercased — `OpenAIModel` → `openai`). `None` model maps to the offline case.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/workflows/test_onboarding_stages.py` (mirroring the `patch("draftly.workflows.onboarding.stages.Agent")` harness at lines 822-836; the module is imported as `stages`):

```python
def test_describe_routing_extracts_provider_and_model():
    class OpenAIModel:
        config = {"model_id": "gpt-route-test"}

    assert stages._describe_routing(OpenAIModel()) == {
        "provider": "openai",
        "model": "gpt-route-test",
    }


def test_describe_routing_handles_offline_and_bare_model():
    assert stages._describe_routing(None) == {
        "provider": "none",
        "model": "deterministic/offline",
    }
    info = stages._describe_routing(object())  # no .config attribute
    assert info == {"provider": "object", "model": "object"}


@pytest.mark.asyncio
async def test_llm_generate_logs_routing():
    from structlog.testing import capture_logs

    class OpenAIModel:
        config = {"model_id": "gpt-route-test"}

    with capture_logs() as logs, patch(
        "draftly.workflows.onboarding.stages.Agent"
    ) as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(
            return_value=fake_agent_result(ExtractionOutput(facts=["f"]))
        )
        await stages._llm_generate(OpenAIModel(), "prompt", output_model=ExtractionOutput)

    routing = [line for line in logs if line.get("event") == "llm_generate"]
    assert len(routing) == 1
    assert routing[0]["provider"] == "openai"
    assert routing[0]["model"] == "gpt-route-test"
    assert routing[0]["output_model"] == "ExtractionOutput"
    assert routing[0]["prompt_chars"] == len("prompt")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q -k "routing or describe_routing"`

Expected: all three FAIL — `_describe_routing` does not exist (`AttributeError`) and no `llm_generate` event is emitted.

- [ ] **Step 3: Implement — add the `_describe_routing` helper**

Place it directly above `_llm_generate` (`stages.py:142`):

```python
def _describe_routing(model: Any) -> dict[str, str]:
    """Best-effort (provider, model) identity for terminal routing logs.

    WorkflowContext.model is a concrete Strands Model resolved at startup
    (app/lifecycle.py::_resolve_runtime_model), so the ModelRouter's own
    attempting/resolved lines never fire during stages. This supplies the
    equivalent visibility from the model we actually invoke.
    """
    if model is None:
        return {"provider": "none", "model": "deterministic/offline"}
    config = getattr(model, "config", None) or {}
    model_id = str(
        config.get("model_id")
        or getattr(model, "model", "")
        or type(model).__name__
    )
    provider = str(
        getattr(model, "provider", "")
        or type(model).__name__.removesuffix("Model").lower()
    )
    return {"provider": provider, "model": model_id}
```

- [ ] **Step 4: Implement — log the routing line in `_llm_generate`**

As the first statements of the function body (`stages.py:142-148`, before the `if agent is None:` block):

```python
    routing = _describe_routing(model)
    logger.info(
        "llm_generate provider=%s model=%s output_model=%s prompt_chars=%d",
        routing["provider"],
        routing["model"],
        getattr(output_model, "__name__", "none"),
        len(prompt),
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q`

Expected: all pass including the new routing tests.

---
### Task 3: structlog lifecycle lines for all five init stages

**Why:** `run_onboarding_initialize` (`workflows/onboarding/initialize.py`) pushes stage boundaries only to the SSE stream via `_stage_start`/`_stage_complete` (lines 71-83). The terminal gets nothing for repository_ingestion and only sparse `..._done` lines inside `stages.py` (knowledge_construction_done :342, initial_evaluation_done :489, health_report_done :536) with no `stage=` key. This task emits a `stage_start` / `stage_complete` structlog pair per stage — with outcome `stats` and `duration_ms` — and tags the existing stage boundary lines with `stage=` so terminal output is per-stage greppable.

**Files:**
- Modify: `src/draftly/workflows/onboarding/initialize.py` — `_stage_start`/`_stage_complete` gain structlog lines + a per-stage timing map (`import time` for `time.monotonic`).
- Modify: `src/draftly/workflows/onboarding/stages.py` — add `stage=` to the three `..._done` boundary lines and one batched progress INFO per chunk batch.
- Test: `tests/unit/workflows/test_onboarding_initialize.py`.

**Interfaces:**
- Emits (structlog INFO): `stage_start stage=<name>`; `stage_complete stage=<name> duration_ms=<int> stats=<dict>`; `knowledge_construction_progress stage=knowledge_construction done=<n>/<total>` (once per batch).

- [ ] **Step 1: Write the failing test**

Wrap the body of `test_initialize_workflow_completes` (`tests/unit/workflows/test_onboarding_initialize.py:41-93` — same nested `SyncService`/stage patching) inside `structlog.testing.capture_logs()`, then assert lifecycle lines:

```python
def test_initialize_emits_stage_lifecycle_logs(installation_client):
    from structlog.testing import capture_logs

    sync_result = SyncResult(
        commit_sha="abc123",
        repository="owner/repo",
        document_count=2,
        chunk_count=5,
        baseline=BaselineSnapshot(
            commit_sha="abc123", repository="owner/repo",
            document_count=2, section_count=4, chunk_count=5,
        ),
    )

    with capture_logs() as logs:
        with patch("draftly.documentation.sync_service.SyncService") as service_cls:
            service_cls.return_value.sync = AsyncMock(return_value=sync_result)
            with patch(
                "draftly.workflows.onboarding.stages.run_knowledge_construction",
                new=AsyncMock(return_value=MagicMock(
                    knowledge_count=10, relationship_count=5,
                    candidate_count=3, failed_chunks=[],
                )),
            ):
                with patch(
                    "draftly.workflows.onboarding.stages.run_initial_evaluation",
                    new=AsyncMock(return_value=MagicMock(
                        score=0.72, dimensions={},
                    )),
                ):
                    with patch(
                        "draftly.workflows.onboarding.stages.run_health_report",
                        return_value=MagicMock(score=0.68, dimensions={}),
                    ):
                        with patch(
                            "draftly.workflows.onboarding.stages.run_recommendations",
                            new=AsyncMock(return_value=[
                                MagicMock(priority="high", title="Add API ref",
                                          detail="Missing", category="coverage"),
                            ]),
                        ):
                            state = await run_onboarding_initialize(
                                _context(), org_id="test-org",
                                selected_repository={"full_name": "owner/repo"},
                            )

    assert state.status == WorkflowStatus.DELIVERED
    starts = [l for l in logs if l.get("event") == "stage_start"]
    completes = [l for l in logs if l.get("event") == "stage_complete"]
    assert [l["stage"] for l in starts] == list(STAGES)
    assert [l["stage"] for l in completes] == list(STAGES)
    assert all(l["duration_ms"] >= 0 for l in completes)
    assert all("stats" in l for l in completes)
```

(Add `from draftly.workflows.onboarding.initialize import STAGES` to this test module's imports alongside `run_onboarding_initialize`; `SyncResult`, `BaselineSnapshot`, and `WorkflowStatus` are already imported there as in `test_initialize_workflow_completes`.)

- [ ] **Step 2: Run the tests to verify it fails**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_initialize.py -q -k "lifecycle"`

Expected: FAIL — no `stage_start`/`stage_complete` structlog events exist yet, so `starts`/`completes` are empty.

- [ ] **Step 3: Implement — `initialize.py`**

Add `import time` to the module imports. Then replace `_stage_start`/`_stage_complete` (`initialize.py:71-83`) with timing + logging:

```python
    _stage_starts: dict[str, float] = {}

    async def _stage_start(stage: str, stats: dict[str, Any] | None = None) -> None:
        _stage_starts[stage] = time.monotonic()
        logger.info("stage_start stage=%s", stage)
        payload: dict[str, Any] = {"stage": stage, "status": "started"}
        if stats:
            payload["stats"] = stats
        await _publish("stage_change", payload)
        await asyncio.sleep(0)  # yield so the SSE subscriber can pick up the event

    async def _stage_complete(stage: str, stats: dict[str, Any] | None = None) -> None:
        duration_ms = int(
            (time.monotonic() - _stage_starts.get(stage, time.monotonic())) * 1000
        )
        logger.info(
            "stage_complete stage=%s duration_ms=%d stats=%s",
            stage, duration_ms, stats or {},
        )
        payload: dict[str, Any] = {"stage": stage, "status": "completed"}
        if stats:
            payload["stats"] = stats
        await _publish("stage_change", payload)
        await asyncio.sleep(0)
```

No changes to the SSE payloads — the stream contract is untouched; only structlog lines are added.

- [ ] **Step 4: Implement — tag and progress lines in `stages.py`**

Add a `stage=` key to the three boundary lines so they filter identically to the new lifecycle lines:

```python
# knowledge_construction_done (:342)
logger.info(
    "knowledge_construction_done stage=knowledge_construction org=%s "
    "facts=%d rels=%d procs=%d failed=%d",
    org_id, result.knowledge_count, result.relationship_count,
    result.candidate_count, len(result.failed_chunks),
)

# initial_evaluation_done (:489) — prepend "stage=initial_evaluation "
# health_report_done (:536)     — prepend "stage=health_report "
```

And one structlog progress line per batch, after the existing `publish("stage_progress", ...)` block at `stages.py:333-340` (batched by construction — CHUNK_BATCH_SIZE chunks per line, never per chunk):

```python
        logger.info(
            "knowledge_construction_progress stage=knowledge_construction done=%d/%d",
            processed, total,
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_initialize.py tests/unit/workflows/test_onboarding_stages.py -q`

Expected: all pass, including the new lifecycle test.

---
### Task 4: Wire the adaptive router into onboarding init (auto-warm routing stats)

**Why:** Stages 2/3/5 call Strands Agents with a fixed concrete model (`stages.py:227,413,563`), so the `ModelRouter`'s adaptive path never runs for the ~500 extraction + sampled evaluation + recommendation calls and no per-`(task_type, model)` outcome stats are recorded for them. Wiring the router in per stage means routing learns from real init traffic — the store auto-warms on the first real run — and `_describe_routing` (Task 2) then shows each stage's routed model. Because only `_resolve_runtime_model` forces a concrete model (`app/lifecycle.py:266-280`), replacing it with a `RoleAwareModelResolver` (the same wrap `StrandsClient.__post_init__` already uses) is additive to every existing consumer.

**Files:**
- Modify: `src/draftly/integrations/strands/models.py:46-85` — `for_role_with_decision`; `for_role` delegates; offline degrade.
- Modify: `src/draftly/models/schemas.py:26-38` — three new onboarding roles.
- Modify: `src/draftly/persistence/repositories/routing.py:33-47` — `flush: bool = True` on `record_outcome`.
- Modify: `src/draftly/app/lifecycle.py:266-280` — `_resolve_runtime_model` returns the resolver.
- Modify: `src/draftly/workflows/onboarding/stages.py` — `_resolve_stage_model`, `_OutcomeRecorder`, `_llm_generate` telemetry, per-stage resolution + flush.
- Modify: `src/draftly/workflows/memory/curation_workflow.py:50` — resolve the `memory_curator` role.
- Test: `tests/graph/test_role_aware_resolver.py`, `tests/unit/models/test_schemas.py`, `tests/unit/models/test_performance.py`, `tests/unit/workflows/test_onboarding_stages.py`, `tests/workflow/test_curation_workflow.py`.

**Interfaces:**
- Produces:
  - `RoleAwareModelResolver.for_role_with_decision(role, *, prompt_text=None, context_tokens=None) -> tuple[Model | None, RoutingDecision | None]` — concrete model + its decision; `(None, None)` offline (never raises).
  - `RoleAwareModelResolver.for_role(...) -> Model | None` — unchanged signature, delegates to `for_role_with_decision`.
  - `stages._resolve_stage_model(context, role, *, prompt_text=None) -> tuple[Any, Any | None]` — resolver-aware; legacy concrete models pass through as `(model, None)`.
  - `stages._OutcomeRecorder(context, decision)` — `.record(success, latency_ms)` (async; live EMA only, no-op when disabled), `.flush()` (one `flush_entry` per stage).
  - `_llm_generate(..., telemetry: Callable[[bool, float], Awaitable[None]] | None = None)` — records success/latency including the failure path; never raises from telemetry.
  - `PerformanceRepository.record_outcome(..., flush: bool = True)` — additive; `flush=False` defers the upsert to the caller's `flush_entry`.
- Consumes: `ModelRouter.route` / `.registry`, `RoutingDecision`, `WorkflowContext.repositories.performance`, `WorkflowContext.model` (a `RoleAwareModelResolver` after the wiring step).

- [ ] **Step 1: Write the failing resolver + role-map tests**

Append to `tests/graph/test_role_aware_resolver.py`:

```python
def test_for_role_with_decision_returns_model_and_decision(router):
    resolver = RoleAwareModelResolver(router)
    model, decision = resolver.for_role_with_decision("documentation_engineer")
    assert model == "MODEL<writer-model>"
    assert decision.selected_model == "writer-model"
    assert decision.task_type == "documentation_generation"


def test_for_role_delegates_to_for_role_with_decision(router):
    resolver = RoleAwareModelResolver(router)
    model, _decision = resolver.for_role_with_decision("github_intelligence")
    assert resolver.for_role("github_intelligence") == model


def test_for_role_with_decision_degrades_offline():
    from draftly.models.health import ProviderHealthRegistry
    from draftly.models.registry import ModelRegistry
    from draftly.models.router import ModelRouter

    empty = ModelRouter(registry=ModelRegistry(), health=ProviderHealthRegistry())
    resolver = RoleAwareModelResolver(empty)
    assert resolver.for_role_with_decision("support_engineer") == (None, None)
    assert resolver.for_role("support_engineer") is None
```

(`decision.task_type` is stored as a plain string by `route()` — `models/router.py:128`.)

Update `tests/unit/models/test_schemas.py::test_role_map_covers_all_agent_roles` — add the three onboarding roles to `expected_roles`:

```python
    expected_roles = {
        "documentation_engineer", "documentation_reviewer", "github_intelligence",
        "support_engineer", "support_reviewer", "research", "deepeval",
        "github_delivery", "memory_curator",
        # Every-agent-a-role wiring (graph builders resolve these too)
        "classifier", "context",
        # Onboarding init stages (Task 4)
        "knowledge_extractor", "initial_evaluator", "recommender",
    }
```

and append these mapping assertions:

```python
    assert ROLE_TO_TASK_TYPE["knowledge_extractor"] is TaskType.DOCUMENTATION_GENERATION
    assert ROLE_TO_TASK_TYPE["initial_evaluator"] is TaskType.EVALUATION
    assert ROLE_TO_TASK_TYPE["recommender"] is TaskType.DOCUMENTATION_REVIEW
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/graph/test_role_aware_resolver.py tests/unit/models/test_schemas.py -q`

Expected: the three new resolver tests FAIL (`AttributeError: for_role_with_decision`; the current `for_role` raises `NoCandidateError` on the empty router — proving the degrade path is missing); `test_role_map_covers_all_agent_roles` FAILS on the set equality.

- [ ] **Step 3: Implement — resolver + role map**

In `src/draftly/integrations/strands/models.py`, add a module-level structlog logger next to the imports:

```python
import structlog

from draftly.models.factory import build_model_router

logger = structlog.get_logger(__name__)
```

Then replace the body of `RoleAwareModelResolver.for_role` (`models.py:52-85`) with a delegating `for_role` plus the new `for_role_with_decision`:

```python
    def for_role(
        self,
        role: str,
        *,
        prompt_text: str | None = None,
        context_tokens: int | None = None,
    ) -> Any:
        model, _decision = self.for_role_with_decision(
            role, prompt_text=prompt_text, context_tokens=context_tokens
        )
        return model

    def for_role_with_decision(
        self,
        role: str,
        *,
        prompt_text: str | None = None,
        context_tokens: int | None = None,
    ) -> tuple[Any, Any | None]:
        """Per-role concrete model plus its RoutingDecision.

        Returns ``(None, None)`` when the router has no usable candidate
        (offline/unconfigured) instead of raising, so consumers degrade to
        deterministic modes — parity with the legacy "no runtime model" case.
        """
        from dataclasses import replace

        from draftly.models.router import NoCandidateError
        from draftly.models.schemas import ROLE_TO_TASK_TYPE, RoutingRequest

        try:
            task_type = ROLE_TO_TASK_TYPE[role]
        except KeyError:
            raise ValueError(
                f"Unknown role '{role}'; add it to ROLE_TO_TASK_TYPE."
            ) from None

        tokens = context_tokens or _estimate_tokens(prompt_text)
        request = RoutingRequest(task_type=task_type, context_tokens=tokens)
        try:
            decision = self._router.route(request)
        except NoCandidateError:
            logger.warning("role_routing_offline role=%s", role)
            return None, None

        config = self._router.registry.get_model(decision.selected_model)

        # Route the per-role output budget (factory ROLE_OUTPUT_TOKENS)
        # onto the constructed model so every role-resolved agent is
        # capped without changing any agent-factory signature.
        from draftly.models.factory import ROLE_OUTPUT_TOKENS

        if role in ROLE_OUTPUT_TOKENS:
            config = replace(config, max_tokens=ROLE_OUTPUT_TOKENS[role])

        provider = self._router.registry.get_provider(decision.provider)
        return provider.create_model(config), decision
```

In `src/draftly/models/schemas.py`, add the three onboarding roles to `ROLE_TO_TASK_TYPE` (additive only):

```python
    "classifier": TaskType.FAST,
    "context": TaskType.RESEARCH,
    "knowledge_extractor": TaskType.DOCUMENTATION_GENERATION,
    "initial_evaluator": TaskType.EVALUATION,
    "recommender": TaskType.DOCUMENTATION_REVIEW,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/graph/test_role_aware_resolver.py tests/unit/models/test_schemas.py -q`

Expected: all pass — `for_role_with_decision` returns `(model, decision)`, offline degrades to `(None, None)`, and the role map covers the new roles. (The existing `tests/graph/test_role_aware_resolver.py` tests stay green: their `router` fixture has registered models, so `route()` succeeds.)

- [ ] **Step 5: Write the failing `flush`-param test**

Append to `tests/unit/models/test_performance.py`:

```python
class _FakePerformanceStore:
    """In-memory store capturing upserts for the repo<->store bridge."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def upsert_performance(self, row: dict) -> None:
        self.rows.append(row)

    async def get_all(self) -> list[dict]:
        return list(self.rows)


@pytest.mark.asyncio
async def test_record_outcome_flush_false_defers_upsert():
    from draftly.models.performance import EMAStatsStore
    from draftly.persistence.repositories.routing import PerformanceRepository

    store = _FakePerformanceStore()
    repo = PerformanceRepository(store=store)
    repo.bind_stats_store(EMAStatsStore())

    await repo.record_outcome(
        task_type="fast", model_name="m", success=True, latency_ms=12.0,
    )
    assert len(store.rows) == 0  # flush=False → live EMA cache only

    await repo.record_outcome(
        task_type="fast", model_name="m", success=True, latency_ms=20.0,
        flush=False,
    )
    assert len(store.rows) == 0

    await repo.flush_entry("fast", "m")
    assert len(store.rows) == 1
    assert store.rows[0]["sample_count"] == 2
    assert store.rows[0]["success_rate"] == 1.0
```

(Add `import pytest` if not already present in that file.)

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/models/test_performance.py -q -k "flush"`

Expected: FAIL — `TypeError` (unexpected keyword argument `flush`), and the store already has a row right after the first `record_outcome` (per-call flush) before `flush_entry`.

- [ ] **Step 7: Implement — add `flush` to `record_outcome`**

In `src/draftly/persistence/repositories/routing.py:33-47`:

```python
    async def record_outcome(
        self,
        *,
        task_type: str,
        model_name: str,
        success: bool,
        latency_ms: float,
        flush: bool = True,
    ) -> None:
        # 1. Live cache first: the very next route() call sees it.
        if self._stats_store is not None:
            self._stats_store.record_outcome(
                task_type, model_name, success=success, latency_ms=latency_ms
            )
        # 2. Durable aggregate. flush=False lets a caller batch many
        # outcomes into ONE upsert via flush_entry (stage-level batching).
        if flush:
            await self.flush_entry(task_type, model_name)
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/models/test_performance.py -q`

Expected: all pass, including the new `flush` test and every existing one (default `flush=True` preserves the old per-call upsert behavior).

- [ ] **Step 9: Write the failing stage + telemetry tests (and update the five `_llm_generate` doubles)**

First, the five existing test doubles that patch `_llm_generate` must accept the new keyword. Update each local `async def slow_llm(...)` / `async def fake_llm(...)` signature in `tests/unit/workflows/test_onboarding_stages.py` (lines 615, 647, 727, 751, 775) from

```python
    async def fake_llm(model, prompt, agent=None, *, output_model=None):
```

to

```python
    async def fake_llm(model, prompt, agent=None, *, output_model=None, telemetry=None):
```

(identical one-line change for each of the five doubles; the body is unchanged).

Then append the new tests to the same file, adding these imports:

```python
from draftly.integrations.strands.models import RoleAwareModelResolver
from draftly.models.schemas import RoutingDecision, TaskType
```

```python
_ROUTING_DECISION = RoutingDecision(
    selected_model="model-a-demo", provider="openrouter", score=0.9,
    candidates_considered=1, profile="documentation_generation",
    task_type="documentation_generation",
)


class _FakeRoleResolver(RoleAwareModelResolver):
    """Stub resolver returning a fixed (model, decision); passes
    stages._resolve_stage_model's isinstance guard."""

    def __init__(self, model: Any, decision: Any | None) -> None:
        self._model = model
        self._decision = decision
        super().__init__(object())

    def for_role_with_decision(self, role, **kwargs):
        return self._model, self._decision


@pytest.mark.asyncio
async def test_llm_generate_records_success_telemetry():
    calls = []

    async def telemetry(success, latency_ms):
        calls.append((success, latency_ms))

    class FakeAgent:
        async def invoke_async(self, prompt, **kwargs):
            return fake_agent_result(ExtractionOutput(facts=["f"]))

    with patch("draftly.workflows.onboarding.stages.Agent", return_value=FakeAgent()):
        out = await stages._llm_generate(
            MagicMock(), "p", output_model=ExtractionOutput, telemetry=telemetry,
        )

    assert out.facts == ["f"]
    assert len(calls) == 1
    assert calls[0][0] is True
    assert calls[0][1] >= 0


@pytest.mark.asyncio
async def test_llm_generate_records_failure_telemetry():
    calls = []

    async def telemetry(success, latency_ms):
        calls.append((success, latency_ms))

    class BoomAgent:
        async def invoke_async(self, prompt, **kwargs):
            raise RuntimeError("provider down")

    with patch("draftly.workflows.onboarding.stages.Agent", return_value=BoomAgent()):
        with pytest.raises(RuntimeError, match="provider down"):
            await stages._llm_generate(
                MagicMock(), "p", output_model=ExtractionOutput, telemetry=telemetry,
            )

    assert len(calls) == 1
    assert calls[0][0] is False          # failure still recorded
    assert calls[0][1] >= 0


@pytest.mark.asyncio
async def test_knowledge_construction_records_routing_outcomes(monkeypatch):
    """Routed stage: one live-EMA record per chunk, one flush at stage end."""
    async def fake_llm(model, prompt, agent=None, *, output_model=None, telemetry=None):
        if telemetry is not None:
            await telemetry(True, 42.0)
        return ExtractionOutput(facts=["F"])

    monkeypatch.setattr(stages, "_llm_generate", fake_llm)

    context = MagicMock()
    context.model = _FakeRoleResolver(MagicMock(), _ROUTING_DECISION)
    context.memory.recall = AsyncMock(return_value=[
        {"id": f"chunk-{i}", "content": f"Content {i}.", "metadata": {}}
        for i in range(stages.CHUNK_BATCH_SIZE)
    ])
    context.memory.store_batch = AsyncMock(
        return_value=[{"id": f"k-{i}"} for i in range(stages.CHUNK_BATCH_SIZE)]
    )
    context.docgraph.link = AsyncMock(return_value={"id": "edge-1"})
    context.candidates.enqueue = AsyncMock(return_value={"id": "c-1"})
    context.repositories.performance = AsyncMock()
    publish = AsyncMock()

    with patch("draftly.workflows.onboarding.stages.Agent"):
        result = await run_knowledge_construction(
            context, org_id="test-org", publish=publish,
        )

    perf = context.repositories.performance
    assert result.knowledge_count == stages.CHUNK_BATCH_SIZE
    assert perf.record_outcome.call_count == stages.CHUNK_BATCH_SIZE
    assert perf.flush_entry.call_count == 1
    call = perf.record_outcome.call_args
    assert call.kwargs["task_type"] == "documentation_generation"
    assert call.kwargs["model_name"] == "model-a-demo"
    assert call.kwargs["success"] is True
    assert call.kwargs["flush"] is False


@pytest.mark.asyncio
async def test_knowledge_construction_offline_never_records(monkeypatch):
    """Offline (context.model is None) → deterministic path, no telemetry."""
    async def fake_llm(model, prompt, agent=None, *, output_model=None, telemetry=None):
        if telemetry is not None:
            await telemetry(False, 0.0)   # recorder is disabled → no-op
        return ExtractionOutput(facts=["F"])

    monkeypatch.setattr(stages, "_llm_generate", fake_llm)

    context = MagicMock()
    context.model = None
    context.memory.recall = AsyncMock(return_value=[
        {"id": "chunk-1", "content": "Content 1.", "metadata": {}},
    ])
    context.memory.store_batch = AsyncMock(return_value=[{"id": "k-1"}])
    context.docgraph.link = AsyncMock(return_value={"id": "edge-1"})
    context.candidates.enqueue = AsyncMock(return_value={"id": "c-1"})
    context.repositories.performance = AsyncMock()
    publish = AsyncMock()

    with patch("draftly.workflows.onboarding.stages.Agent"):
        result = await run_knowledge_construction(
            context, org_id="test-org", publish=publish,
        )

    assert result.knowledge_count == 1
    assert context.repositories.performance.record_outcome.call_count == 0
    assert context.repositories.performance.flush_entry.call_count == 0
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q`

Expected: the four new tests FAIL — `_OutcomeRecorder`/`_resolve_stage_model` don't exist yet and `_llm_generate` accepts no `telemetry` (`TypeError`/`AttributeError`). The five updated doubles pass unchanged (no behavioral change to those tests).

- [ ] **Step 11: Implement — stages.py plumbing**

Add `import time` and `from draftly.integrations.strands.models import RoleAwareModelResolver` to the module imports (`stages.py:9-24`).

Insert these two helpers directly above `_llm_generate` (`stages.py:142`):

```python
def _resolve_stage_model(
    context: Any, role: str, *, prompt_text: str | None = None,
) -> tuple[Any, Any | None]:
    """Per-stage routed model + its RoutingDecision; offline → (None, None).

    Non-resolver ``context.model`` (legacy concrete models, test doubles)
    passes through unchanged as ``(model, None)`` — no routing, no telemetry.
    """
    model_or_resolver = getattr(context, "model", None)
    if model_or_resolver is None:
        return None, None
    if isinstance(model_or_resolver, RoleAwareModelResolver):
        try:
            return model_or_resolver.for_role_with_decision(
                role, prompt_text=prompt_text
            )
        except Exception as exc:
            logger.warning("stage_routing_failed role=%s err=%s", role, exc)
            return None, None
    return model_or_resolver, None


class _OutcomeRecorder:
    """Accumulates per-call routing outcomes; one flush_entry per stage.

    No-ops entirely when there is no routing decision or no performance
    repository on the context (offline / legacy). ``record`` feeds only the
    live EMA cache so the very next route() call sees each outcome; ``flush``
    persists the aggregated row once per stage.
    """

    def __init__(self, context: Any, decision: Any | None) -> None:
        self._task_type: str | None = None
        self._model_name: str | None = None
        self._repo: Any = None
        if decision is not None:
            repo = getattr(getattr(context, "repositories", None), "performance", None)
            if repo is not None:
                self._repo = repo
                self._task_type = getattr(
                    decision.task_type, "value", decision.task_type
                )
                self._model_name = decision.selected_model

    @property
    def enabled(self) -> bool:
        return self._repo is not None and self._task_type is not None

    async def record(self, success: bool, latency_ms: float) -> None:
        """Update the live EMA cache (never raises)."""
        if not self.enabled:
            return
        try:
            await self._repo.record_outcome(
                task_type=self._task_type, model_name=self._model_name,
                success=success, latency_ms=latency_ms, flush=False,
            )
        except Exception:
            logger.warning("routing_outcome_record_failed", exc_info=True)

    async def flush(self) -> None:
        """Persist the stage's aggregated row once (never raises)."""
        if not self.enabled:
            return
        try:
            await self._repo.flush_entry(self._task_type, self._model_name)
        except Exception:
            logger.warning("routing_outcome_flush_failed", exc_info=True)
```

Change `_llm_generate` (`stages.py:142-162`) to accept and fire telemetry:

```python
async def _llm_generate(
    model: Any,
    prompt: str,
    agent: Any | None = None,
    *,
    output_model: type[BaseModel] | None = None,
    telemetry: Callable[[bool, float], Awaitable[None]] | None = None,
) -> BaseModel | None:
    """Generate a schema-validated response from the LLM via a Strands Agent.

    ``agent`` may be supplied by callers that run many prompts (stages 2/3)
    so one client is reused instead of constructing an Agent per call.
    Returns ``result.structured_output`` (the validated model instance, or
    None when the provider returned nothing parseable). ``telemetry``, when
    given, is awaited with ``(success, latency_ms)`` after every invocation —
    including the failure path (the exception is re-raised after recording).
    """
    if agent is None:
        agent = Agent(model=model, structured_output_model=output_model)
    start = time.monotonic()
    try:
        result = await agent.invoke_async(
            prompt, structured_output_model=output_model, limits=LLM_LIMITS,
        )
    except BaseException:
        if telemetry is not None:
            await telemetry(False, (time.monotonic() - start) * 1000.0)
        raise
    latency_ms = (time.monotonic() - start) * 1000.0
    _record_usage(result)
    if telemetry is not None:
        await telemetry(result.structured_output is not None, latency_ms)
    return result.structured_output
```

- [ ] **Step 12: Wire the three stages**

**Stage 2 — `run_knowledge_construction`** (`stages.py:222-347`): after `total = len(chunks)`, add

```python
    stage_model, routing_decision = _resolve_stage_model(
        context, "knowledge_extractor",
    )
    recorder = _OutcomeRecorder(context, routing_decision)
```

Replace the agent build (`:227`) with `Agent(model=stage_model, structured_output_model=ExtractionOutput)`, and the per-chunk call (`:242-245`) with

```python
                    _llm_generate(
                        stage_model, prompt, agent=agent,
                        output_model=ExtractionOutput, telemetry=recorder.record,
                    ),
```

Immediately after the `knowledge_construction_done` log (`:342-346`), before `return result`:

```python
    await recorder.flush()
    return result
```

**Stage 3 — `run_initial_evaluation`** (`stages.py:370-493`): after the `if not docs:` early return (just before `total = len(docs)` at `:370`), add

```python
    stage_model, routing_decision = _resolve_stage_model(
        context, "initial_evaluator",
    )
    recorder = _OutcomeRecorder(context, routing_decision)
```

Change the LLM guard at `:409` to `if stage_model is not None:`, the agent build at `:413` to `Agent(model=stage_model, structured_output_model=EvaluationScores)`, and the sampled call at `:429-434` to target `stage_model` with `telemetry=recorder.record`:

```python
                    scores = await asyncio.wait_for(
                        _llm_generate(
                            stage_model, prompt, agent=agent,
                            output_model=EvaluationScores,
                            telemetry=recorder.record,
                        ),
                        timeout=CHUNK_TIMEOUT_SECONDS,
                    )
```

Immediately before `return EvaluationResult(score=score, dimensions=dimensions)` (`:493`):

```python
    await recorder.flush()
    return EvaluationResult(score=score, dimensions=dimensions)
```

**Stage 5 — `run_recommendations`** (`stages.py:549-574`): after the prompt is built and before the `try:` block, add

```python
    stage_model, routing_decision = _resolve_stage_model(
        context, "recommender", prompt_text=prompt,
    )
    recorder = _OutcomeRecorder(context, routing_decision)
```

Replace the agent build (`:563`) with `Agent(model=stage_model, structured_output_model=RecommendationList)` and the call (`:566-568`) to pass `stage_model` and `telemetry=recorder.record`. Wrap the flush in a `finally` so it runs on both the success and exception paths:

```python
    finally:
        await recorder.flush()
```

- [ ] **Step 13: Run the stage tests to verify they pass**

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q`

Expected: all pass — the four new tests verify per-call live recording + single flush, offline no-op, and success/failure telemetry; the updated doubles keep the concurrency/timeout/sampling tests green.

- [ ] **Step 14: Curation — route the `memory_curator` agent**

Add a failing test first. Append to `tests/workflow/test_curation_workflow.py`:

```python
from draftly.integrations.strands.models import RoleAwareModelResolver


class _OfflineRoleResolver(RoleAwareModelResolver):
    """Real resolver subclass that always degrades to offline (None)."""

    def __init__(self):
        super().__init__(object())

    def for_role(self, role, **kwargs):
        return None


@pytest.mark.asyncio
async def test_offline_routed_curator_releases_batch(monkeypatch):
    import draftly.workflows.memory.curation_workflow as cw

    store = FakeCandidatesStore()
    svc = CandidateService(store=store)
    await svc.enqueue(MemoryCandidate(org_id="org1", candidate_type="fact", payload={}))

    def assert_not_built(**kwargs):
        raise AssertionError("curator must not be built when offline")

    monkeypatch.setattr(cw, "build_memory_curator", assert_not_built)

    class FakeContext:
        candidates = svc
        model = _OfflineRoleResolver()

    summary = await cw.run_memory_curation(FakeContext())

    assert summary["claimed"] == 0
    pending = await svc.store.list_by_status("pending")
    assert len(pending) == 1
```

Then implement in `src/draftly/workflows/memory/curation_workflow.py`. Add the import at the top:

```python
from draftly.integrations.strands.models import RoleAwareModelResolver
```

and replace the `agent = build_memory_curator(model=context.model, tools=_MEMORY_CURATOR_TOOLS)` line (`:50`) with:

```python
    resolver = getattr(context, "model", None)
    model = (
        resolver.for_role("memory_curator")
        if isinstance(resolver, RoleAwareModelResolver)
        else resolver
    )
    if model is None:
        # Offline: no routed model → release the claim for retry, exactly
        # like the "curator returned nothing usable" fallback below.
        for record in claimed:
            await candidates.set_status_pending(
                str(record["id"]), "offline: no routed curator model"
            )
        return {"claimed": 0}

    agent = build_memory_curator(model=model, tools=_MEMORY_CURATOR_TOOLS)
```

(`memory_curator` already maps to `FAST` in `ROLE_TO_TASK_TYPE` — `models/schemas.py:35` — so no role-map change is needed here.)

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/workflow/test_curation_workflow.py -q`

Expected: all pass — the existing three tests use `model = object()` (non-resolver passthrough, untouched) and the new one verifies offline batch release.

- [ ] **Step 15: Wire the lifecycle and run the initialize regression**

Change `_resolve_runtime_model` (`app/lifecycle.py:266-280`) to return the resolver instead of a concrete model:

```python
    def _resolve_runtime_model(self) -> Any:
        """Build the per-role adaptive resolver for graph agents.

        Wraps the configured ModelRouter in a RoleAwareModelResolver so every
        workflow consumer resolves its role's routed model. Offline mode is
        no longer a distinct None path: ``for_role`` degrades to None /
        ``(None, None)`` when no candidate exists. resolve_concrete_model
        stays for Strands Evals LLM judges, which accept only concrete models.
        """
        try:
            from draftly.integrations.strands.models import RoleAwareModelResolver

            return RoleAwareModelResolver(self.dependencies.models.router)
        except Exception as exc:
            logger.warning("runtime_model_unavailable: %s", exc)
            return None
```

Run: `cd draftly-agent-backend && .venv/bin/python -m pytest tests/unit/workflows/test_onboarding_initialize.py tests/unit/test_graph_role_resolution.py tests/graph/test_role_aware_resolver.py -q`

Expected: all pass. `run_onboarding_initialize` never touches `context.model` directly (it calls the three stage functions, which the initialize tests patch); `test_graph_role_resolution` uses its own `RecordingResolver`; the real resolver is covered by the graph tests.

- [ ] **Step 16: Full regression + lint**

```bash
cd draftly-agent-backend
.venv/bin/python -m pytest tests -q
.venv/bin/ruff check src tests workers
```

Expected: full suite green; ruff clean. (Tests that relied on `_resolve_runtime_model` returning `None` offline now see a resolver that degrades to `None` per role — covered by the resolver and graph tests above.)

- [ ] **Step 17: Commit (confirm first — user previously required no commits)**

```bash
cd draftly-agent-backend
git add src/draftly/integrations/strands/models.py \
        src/draftly/models/schemas.py \
        src/draftly/persistence/repositories/routing.py \
        src/draftly/app/lifecycle.py \
        src/draftly/workflows/onboarding/stages.py \
        src/draftly/workflows/memory/curation_workflow.py \
        tests/graph/test_role_aware_resolver.py \
        tests/unit/models/test_schemas.py \
        tests/unit/models/test_performance.py \
        tests/unit/workflows/test_onboarding_stages.py \
        tests/workflow/test_curation_workflow.py
git commit -m "feat: wire adaptive router into onboarding init (auto-warms routing stats)"
```

If the user still holds their no-commit instruction, skip this step and note it in the plan-completion notes.

---
## Plan amendments

This project uses a plan amendment workflow. When instructions from the executor reveal missing constraints, ambiguity, or complexity, append amendments here (Task X, Reason, Constraints) rather than rewriting the tasks above. The working tree drives the implementation; this section is a review journal.

_No amendments yet._

## Verification / Outcome (fill in after execution)

- **Test counts:** `tests/domain/test_memory.py` — __ passed; `test_onboarding_stages.py` / `test_onboarding_initialize.py` — __ passed; full `tests` — __ passed, __ skipped; `ruff check src tests workers` — __.
- **Embedding call reduction:** `recall(limit=500)` 1,501 calls → 1 (measured via `test_retrieve_embeds_query_once`; terminal embedding-log lines during onboarding stages 2 and 3 should disappear).
- **LLM routing visibility:** every `_llm_generate` call logs one `llm_generate` INFO line (`provider=`, `model=`, `output_model=`, `prompt_chars=`); verified by `test_llm_generate_logs_routing` + `test_describe_routing_*`.
- **Stage lifecycle visibility:** one `stage_start` + one `stage_complete` (with `duration_ms` and `stats`) per init stage; verified by `test_initialize_emits_stage_lifecycle_logs`.
- **Router wiring:** `_resolve_runtime_model` returns a `RoleAwareModelResolver` (no concrete model at `context.model`); every onboarding LLM stage resolves its role's routed model + `RoutingDecision`; verified by `tests/graph/test_role_aware_resolver.py` (`for_role_with_decision`/delegate/offline tests) and the `test_onboarding_initialize` regression.
- **Stat-warming:** each stage records per-call success/latency into the live EMA store with `record_outcome(..., flush=False)` and persists once via `flush_entry` — verified by `test_knowledge_construction_records_routing_outcomes` (50 records, 1 flush, correct `task_type`/`model_name` keys) and `test_record_outcome_flush_false_defers_upsert`.
- **Offline parity:** resolver degradation → `(None, None)` / `None`; stages fall back to deterministic/heuristic paths and record nothing; verified by `test_knowledge_construction_offline_never_records` and `test_offline_routed_curator_releases_batch`.
- **Curation:** `memory_curator` resolves via `for_role` (FAST profile), offline releases claimed batches back to pending; existing `model=object()` passthrough tests unchanged.
- **Outcome summary:** single-line description of before/after once executed.