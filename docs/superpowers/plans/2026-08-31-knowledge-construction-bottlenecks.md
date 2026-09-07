# Knowledge Construction Bottleneck Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the knowledge-construction stage bottlenecks that made onboarding take ~19 minutes for 129 chunks (741 facts, 357 relationships, 109 procedures), and restore a crash-safety timeout now that the overall workflow watchdog was removed.

**Architecture:** Four independent, layered fixes. (1) `EmbeddingService`/`EmbeddingRouter`/`OpenAICompatibleEmbedder` gain a real provider-level `embed_batch` that sends many texts in one request, collapsing ~741 network round-trips into a handful, with a per-text fallback. (2) `DocGraphService` and `CandidateService` gain batch methods (`link_batch`, `enqueue_batch`) backed by single-transaction store loops, and `run_knowledge_construction` calls them per batch instead of per-relationship/per-procedure. (3) `run_knowledge_construction` wraps each batch's extract+store in a bounded timeout so a hung provider/embed records a failed batch instead of stalling the workflow (the removed 1200s watchdog's replacement). (4) The embedding router logs once per batch instead of per text.

**Tech Stack:** Python 3.11, asyncio, asyncpg (NeonDB), OpenAI-compatible embeddings client (OpenRouter `text-embedding-3-small`), pytest + pytest-asyncio, ruff, mypy.

**Spec:** No separate design doc. Requirements derived from the observed failure analysis documented in the conversation: the stage is dominated by (a) per-fact serial embedding round-trips, (b) sequential per-relationship/per-procedure DB writes, and (c) no per-call deadline now that `INIT_WORKFLOW_TIMEOUT_SECONDS` was removed. The prior conversation removed the 1200s watchdog (`initialize.py`) and set RQ `job_timeout=-1` (`rq_jobs.py`), so a per-batch safety timeout is now required.

## Global Constraints

- Target Python 3.11 (`ruff` `target-version = "py311"`).
- Continue using the existing async patterns: `asyncpg` pool via `DatabaseClient`, per-transaction batches using `async with self.client.transaction() as conn` and `fetch_one_conn`/`execute_conn` (the established `insert_batch` convention in `memory_store.py:114-165`).
- `EmbeddingService` must keep the deterministic offline hash fallback (`_hash_embed`) so memory writes never fail without model keys (see `memory/embeddings.py:22-66`). Batch embedding must degrade gracefully to the per-text path on any provider error.
- `run_knowledge_construction`'s public signature and `KnowledgeExtractionResult` semantics must not change: callers/tests construct `context` with `.memory.recall`, `.memory.store_batch`, `.docgraph.link`, `.candidates.enqueue`, and `.repositories.performance`. Keep the fake `DocGraphService`/`CandidateService` layer so existing per-item calls remain available (used elsewhere).
- Maintain the invariant that a batch store failure marks that batch's chunks `failed` rather than losing counts (existing behavior at `stages.py:516-526`).
- Do NOT reintroduce an overall workflow watchdog. The per-batch timeout (Task 3) is the only new ceiling and is configurable via env with a positive default.
- Follow TDD: write the failing test first, run to confirm it fails, then implement, then confirm pass, then commit per task.

---

### Task 1: Provider-level embedding batching

**Files:**
- Modify: `src/draftly/memory/embeddings.py`
- Modify: `src/draftly/models/embeddings.py`
- Test: `tests/unit/memory/test_embedding_service.py` (create)
- Test: `tests/unit/models/test_embedding_router.py` (create)

**Interfaces:**
- Consumes: existing `EmbeddingService.embed(text)`, `EmbeddingRouter.embed(text)`, `OpenAICompatibleEmbedder.embed_query(text)`, and the offline `_hash_embed`.
- Produces:
  - `EmbeddingService.embed_batch(texts: Sequence[str]) -> list[list[float]]` — reuses the existing name, now delegates to the router's `embed_batch` when a router is present, else per-text fallback. Must keep returning one vector per input text, in order.
  - `EmbeddingRouter.embed_batch(texts: Sequence[str]) -> list[Sequence[float]]` — new; resolves the provider once, calls `embedder.embed_queries(texts)`, validates dimensions, records one health success/failure for the whole batch; on `FAILURE_INVALID_REQUEST` raises, on `FAILURE_AUTH` disables provider and falls back to next candidate, on other failure records and falls back.
  - `OpenAICompatibleEmbedder.embed_queries(texts: Sequence[str]) -> list[list[float]]` — new; calls `self._client.embeddings.create(model=self.model_id, input=list(texts))`, returns `[d.embedding for d in response.data]`. Order matching the input is guaranteed by the OpenAI API.
  - `EmbeddingService` fallback: if no router or the router raises or returns a vector of the wrong length, fall back to per-text `self.embed()` (which itself has the `_hash_embed` fallback). Must not raise for a single bad batch.

**Why:** This is the dominant bottleneck. `EmbeddingService.embed_batch` (`memory/embeddings.py:68-72`) fans out to one `self.embed()` per text via `asyncio.gather`, so a batch of 741 facts produces ~741 separate HTTPS round-trips to the OpenRouter embeddings endpoint. Each round-trip is serialized JSON over the network; with 129 chunks over the whole stage this dwarfs every other cost and is the single largest share of the ~19-minute runtime. The embeddings provider (`OpenAICompatibleEmbedder`) already accepts a list via `input=`, but nothing used it. By adding `embed_queries`/`embed_batch` we collapse ~741 requests into a handful, cutting the stage's dominant latency by roughly the batch factor. Task 4 then fixes the log flood this fan-out also caused.

- [ ] **Step 1: Write the failing test for `OpenAICompatibleEmbedder.embed_queries`**

```python
# tests/unit/models/test_embedding_router.py
from types import SimpleNamespace

from draftly.models.embeddings import OpenAICompatibleEmbedder


class _FakeOpenAI:
    def __init__(self):
        self.calls = []
        self._embeddings = self._Embeddings()

    class _Embeddings:
        def create(self, *, model, input):
            # record the inputs we sent; return fake vectors in order
            return SimpleNamespace(data=[
                SimpleNamespace(embedding=[float(i), float(i + 1)])
                for i, _ in enumerate(input)
            ])

    # NOTE: must be a property, NOT a method — embed_queries accesses
    # self._client.embeddings.create(...) without calling embeddings().
    @property
    def embeddings(self):
        return self._embeddings


def test_embed_queries_sends_all_texts_in_one_call():
    embedder = OpenAICompatibleEmbedder(
        api_key="k", base_url="https://x", model_id="text-embedding-3-small",
    )
    embedder._client = _FakeOpenAI()
    out = embedder.embed_queries(["a", "b", "c"])
    assert len(out) == 3
    assert out[0] == [0.0, 1.0]
    assert out[2] == [2.0, 3.0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/models/test_embedding_router.py -v`
Expected: FAIL with `AttributeError: 'OpenAICompatibleEmbedder' object has no attribute 'embed_queries'`

- [ ] **Step 3: Implement `embed_queries`**

In `src/draftly/models/embeddings.py`, add after `embed_query`:

```python
    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        response = self._client.embeddings.create(
            model=self.model_id,
            input=list(texts),
        )
        return [item.embedding for item in response.data]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/models/test_embedding_router.py -v`
Expected: PASS

- [ ] **Step 5: Write failing test for `EmbeddingRouter.embed_batch`**

```python
# tests/unit/models/test_embedding_router.py (append)
from unittest.mock import MagicMock

from draftly.memory.embeddings import EmbeddingService


def _embedder_returning(n_vecs):
    e = MagicMock()
    e.embed_queries.return_value = [[float(i), float(i + 1)] for i in range(n_vecs)]
    return e


def test_router_embed_batch_uses_batched_embedder():
    from draftly.models.embeddings import EmbeddingRouter

    embedder = _embedder_returning(3)
    router = EmbeddingRouter(registry=MagicMock(), health=MagicMock())
    router._ordered_candidates = lambda: [
        SimpleNamespace(
            provider="openrouter", model_id="text-embedding-3-small",
            priority=1, dimensions=2,
        )
    ]
    registry = MagicMock()
    registry.get_provider.return_value = MagicMock(
        is_enabled=lambda: True,
        create_embedder=lambda cfg: embedder,
    )
    router.registry = registry
    router.health = MagicMock()
    router.health.get.return_value = MagicMock(
        available=lambda: True, record_failure=lambda f: None, record_success=lambda: None,
    )

    out = router.embed_batch(["a", "b", "c"])

    assert len(out) == 3
    embedder.embed_queries.assert_called_once_with(["a", "b", "c"])
    # embed_query (per-text) must NOT be used for the batch path
    embedder.embed_query.assert_not_called()
```

- [ ] **Step 6: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/models/test_embedding_router.py -v`
Expected: FAIL with `AttributeError: 'EmbeddingRouter' object has no attribute 'embed_batch'` (or `unbound`)

- [ ] **Step 7: Implement `EmbeddingRouter.embed_batch`**

In `src/draftly/models/embeddings.py`, add after `embed` (mirror the existing fallback structure in `embed`, `models/embeddings.py:83-155`):

```python
    def embed_batch(self, texts: Sequence[str]) -> list[Sequence[float]]:
        candidates = self._ordered_candidates()
        errors: list[Exception] = []

        for config in candidates:
            provider_health = self.health.get(config.provider)
            if not provider_health.available():
                continue
            provider = self.registry.get_provider(config.provider)
            if not provider.is_enabled():
                continue

            logger.info(
                "embedding batch attempting provider=%s model=%s count=%d",
                config.provider, config.model_id, len(texts),
            )
            try:
                embedder = provider.create_embedder(config)
                vectors = embedder.embed_queries(texts)
            except Exception as exc:
                from .router import ModelRouter

                failure = ModelRouter._classify_failure(exc)
                logger.warning(
                    "embedding batch failure provider=%s model=%s type=%s error=%s",
                    config.provider, config.model_id, failure, exc,
                )
                if failure == FAILURE_INVALID_REQUEST:
                    raise
                if failure == FAILURE_AUTH:
                    provider_health.disable()
                    errors.append(exc)
                    continue
                provider_health.record_failure(failure)
                errors.append(exc)
                continue

            for vector in vectors:
                self._validate_dimensions(config, vector)
            provider_health.record_success()
            self.last_provider = config.provider
            logger.info(
                "embedding batch resolved provider=%s model=%s count=%d",
                config.provider, config.model_id, len(vectors),
            )
            return vectors

        raise RuntimeError("No healthy embedding provider was available.") from (
            errors[-1] if errors else None
        )
```

- [ ] **Step 8: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/models/test_embedding_router.py -v`
Expected: PASS

- [ ] **Step 9: Write failing test for `EmbeddingService.embed_batch` batching + fallback**

```python
# tests/unit/memory/test_embedding_service.py
from unittest.mock import MagicMock

import pytest

from draftly.memory.embeddings import EmbeddingService


@pytest.mark.asyncio
async def test_embed_batch_uses_router_batch_when_available():
    router = MagicMock()
    router_vectors = [[1.0, 2.0], [3.0, 4.0]]
    router.embed_batch.return_value = router_vectors
    svc = EmbeddingService(router=router)

    out = await svc.embed_batch(["a", "b"])

    assert out == router_vectors
    router.embed_batch.assert_called_once_with(["a", "b"])


@pytest.mark.asyncio
async def test_embed_batch_falls_back_per_text_on_router_error():
    import asyncio

    class Router:
        def embed(self, text):
            return [len(text), 1.0]

        def embed_batch(self, texts):
            raise RuntimeError("provider down")

    svc = EmbeddingService(router=Router())

    out = await svc.embed_batch(["a", "bb"])

    assert out == [[1.0, 1.0], [2.0, 1.0]]
```

- [ ] **Step 10: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/memory/test_embedding_service.py -v`
Expected: FAIL — `svc.embed_batch` currently uses only `self.embed` per text, so either the batch isn't used (assert router.embed_batch called fails) or router is called.

- [ ] **Step 11: Implement `EmbeddingService.embed_batch` with fallback**

Replace `embed_batch` in `src/draftly/memory/embeddings.py`:

```python
    async def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        import asyncio

        router = self.router
        if router is not None and hasattr(router, "embed_batch"):
            try:
                vectors = await asyncio.to_thread(router.embed_batch, list(texts))
                if vectors and len(vectors) == len(texts):
                    return [list(v) for v in vectors]
            except Exception as exc:
                logger.warning("embedder_batch_fallback_used error=%s", exc)

        return list(
            await asyncio.gather(*(self.embed(text) for text in texts))
        )
```

- [ ] **Step 12: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/memory/test_embedding_service.py -v`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/draftly/memory/embeddings.py src/draftly/models/embeddings.py \
  tests/unit/memory/test_embedding_service.py tests/unit/models/test_embedding_router.py
git commit -m "perf: batch embeddings at the provider level"
```

---

### Task 2: Batch relationship linking and procedure enqueueing

**Files:**
- Modify: `src/draftly/memory/docgraph/service.py`
- Modify: `src/draftly/integrations/database/doc_relations_store.py`
- Modify: `src/draftly/memory/candidates/service.py`
- Modify: `src/draftly/integrations/database/memory_candidates_store.py`
- Modify: `src/draftly/workflows/onboarding/stages.py` (`run_knowledge_construction`)
- Modify: `tests/fakes/memory_stores.py` (add batch fakes)
- Test: `tests/unit/memory/test_docgraph_service.py`
- Test: `tests/unit/memory/test_candidate_service.py`
- Test: `tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: existing `DocGraphService.link`, `CandidateService.enqueue`, `DatabaseClient` with `.transaction()`, `.fetch_one_conn()`, `.execute_conn()`.
- Produces:
  - `DocGraphService.link_batch(relations: list[dict]) -> int` — `relations` is a list of `{"source": str, "target": str, "type": str, "org_id": str|None, "source_type": str, "target_type": str, "evidence": list|None}`. Returns the count of edges linked.
  - `DocRelationsStore.link_batch(relations: list[dict]) -> int` — single transaction; for each relation: `ensure_node` (source), `ensure_node` (target), `upsert_edge`. Returns number of edges.
  - `CandidateService.enqueue_batch(candidates: list[MemoryCandidate]) -> int` — returns count inserted.
  - `MemoryCandidatesStore.insert_batch(fields_list: list[dict]) -> list[dict]` — single transaction inserting each candidate.
  - `run_knowledge_construction` calls the **batch** methods when the context exposes **real** `DocGraphService`/`CandidateService` instances (production wiring at `app/composition/workflows.py:123-124`), else falls back to the per-item loop. See Step detail below for the exact gate.

> **Design note for `stages.py`:** Gate batching on **isinstance, not hasattr**. `hasattr(context.docgraph, "link_batch")` is always True on a `MagicMock` context (existing tests), so it would route existing mock-based tests into the batch path and break them (`int += MagicMock`). Instead, lazily import and check `isinstance(context.candidates, CandidateService)` / `isinstance(context.docgraph, DocGraphService)`. Production wires real instances, so real runs always batch; MagicMock-based existing tests stay on the per-item loop and keep passing unchanged.

**Why:** After Task 1, embedding latency is fixed but the stage still writes relationships and procedure candidates **one row at a time**. `run_knowledge_construction` currently loops per chunk and, inside each chunk, calls `context.docgraph.link(...)` and `context.candidates.enqueue(...)` once per relationship/procedure — each a separate DB transaction. For 357 relationships + 109 procedures this is ~466 sequential transactions, and each `link` further fans out to `ensure_node` ×2 + `upsert_edge` inside its own transactions. The second-biggest cost class is this per-row DB round-trip. Task 2 introduces `link_batch`/`enqueue_batch` (single-transaction store loops) and, crucially, reduces the transaction count from ~466 to **one `link_batch` + one `enqueue_batch` per `CHUNK_BATCH_SIZE=50` group** (~6 batches total) by hoisting accumulation out of the per-chunk loop — a real ~50x transaction reduction. Keeping the per-item path (via the isinstance gate) preserves all existing mock-based tests and the `app/composition/workflows.py:123-124` production wiring's per-item behavior for any non-real context.

- [ ] **Step 1: Write failing test for `MemoryCandidatesStore.insert_batch`**

```python
# tests/unit/memory/test_candidate_service.py
import pytest

from draftly.integrations.database.memory_candidates_store import MemoryCandidatesStore


class _FakeClient:
    def __init__(self):
        self.conn_ops = []

    def transaction(self):
        import contextlib
        from unittest.mock import AsyncMock
        @contextlib.asynccontextmanager
        async def _tx():
            conn = AsyncMock()
            yield conn
        return _tx()

    async def fetch_one_conn(self, conn, query, *args):
        self.conn_ops.append(("fetch", args[0]))
        return {"id": args[0], "org_id": args[1], "candidate_type": args[2]}


@pytest.mark.asyncio
async def test_candidates_store_insert_batch():
    client = _FakeClient()
    store = MemoryCandidatesStore(client=client)
    rows = await store.insert_batch(fields_list=[
        {"org_id": "o", "candidate_type": "procedure_pattern", "payload": "{}",
         "source_type": "doc", "source_id": "c1", "evidence": "[]", "confidence": 0.6},
        {"org_id": "o", "candidate_type": "procedure_pattern", "payload": "{}",
         "source_type": "doc", "source_id": "c2", "evidence": "[]", "confidence": 0.6},
    ])
    assert len(rows) == 2
    assert client.conn_ops[0][0] == "fetch"
```

(Read `tests/unit/memory/test_candidate_service.py` first and mirror its existing fake client conventions; adjust the above to match the project's real fake patterns in `tests/fakes/`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/memory/test_candidate_service.py -v`
Expected: FAIL with `AttributeError: 'MemoryCandidatesStore' object has no attribute 'insert_batch'`

- [ ] **Step 3: Implement `MemoryCandidatesStore.insert_batch`**

In `src/draftly/integrations/database/memory_candidates_store.py`, add (single transaction, mirroring `memory_store.insert_batch` at `memory_store.py:114-165`). **IMPORTANT:** copy the exact column list, parameter mapping, JSON serialization, and `RETURNING` list from the existing `insert` (lines 15-38) — that insert is:
- 7 columns in this order: `org_id, candidate_type, payload, source_type, source_id, evidence, confidence`
- `payload`/`evidence` use JSONB casts: `$3::JSONB`, `$6::JSONB`
- no explicit `id` column (the server generates it)
- explicit `RETURNING id, org_id, candidate_type, payload, source_type, source_id, evidence, confidence, status, decision_reason, created_at` (NOT `*`)
- `confidence` normalized via `float(fields.get("confidence", 0.5))`

Recommended: extract the JSON-serialization branch (`payload`/`evidence` isinstance str check) from `insert` into a private `_serialize_fields(fields)` helper used by BOTH `insert` and `insert_batch`, and store the INSERT SQL as a module-level `_INSERT_SQL` constant shared by both — so the single-row and batch paths can never drift. If you keep two code paths, keep them byte-identical.

```python
    async def insert_batch(self, *, fields_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows = []
        async with self.client.transaction() as conn:
            for fields in fields_list:
                row = await self.client.fetch_one_conn(
                    conn,
                    _INSERT_SQL,
                    fields.get("org_id"),
                    fields["candidate_type"],
                    fields["payload"]
                    if isinstance(fields["payload"], str)
                    else json.dumps(fields["payload"]),
                    fields.get("source_type"),
                    fields.get("source_id"),
                    fields["evidence"]
                    if isinstance(fields["evidence"], str)
                    else json.dumps(fields["evidence"]),
                    float(fields.get("confidence", 0.5)),
                )
                rows.append(dict(row))
        return rows
```

> Do NOT invent the `id` column or `RETURNING *` — the plan's earlier draft had an 8-column insert that would break against the real schema.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/memory/test_candidate_service.py -v`
Expected: PASS

- [ ] **Step 5: Implement `CandidateService.enqueue_batch`**

In `src/draftly/memory/candidates/service.py`, add after `enqueue`. Prefer `store.insert_batch` when the store exposes it (real `MemoryCandidatesStore`), else fall back to a per-candidate `enqueue` loop (fake stores / soft-fail):

```python
    async def enqueue_batch(self, candidates: list[MemoryCandidate]) -> int:
        if not candidates:
            return 0
        if hasattr(self.store, "insert_batch"):
            fields_list = [
                {
                    "org_id": c.org_id,
                    "candidate_type": c.candidate_type,
                    "payload": json.dumps(c.payload),
                    "source_type": c.source_type,
                    "source_id": c.source_id,
                    "evidence": json.dumps(c.evidence),
                    "confidence": c.confidence,
                }
                for c in candidates
            ]
            rows = await self.store.insert_batch(fields_list=fields_list)
            logger.debug("candidate_batch_enqueued count=%d", len(rows))
            return len(rows)
        for c in candidates:
            await self.enqueue(c)
        return len(candidates)
```

- [ ] **Step 6: Write failing test for `CandidateService.enqueue_batch` using the fake store**

```python
# tests/unit/memory/test_candidate_service.py
from draftly.memory.candidates.models import MemoryCandidate
from draftly.memory.candidates.service import CandidateService


@pytest.mark.asyncio
async def test_candidate_service_enqueue_batch():
    class FakeCandidateStore:
        def __init__(self):
            self.inserted = []

        async def insert(self, *, fields):
            self.inserted.append(fields)
            return {"id": "x"}

        async def insert_batch(self, *, fields_list):
            self.inserted.extend(fields_list)
            return fields_list

    svc = CandidateService(store=FakeCandidateStore())
    cands = [
        MemoryCandidate(
            org_id="o", candidate_type="procedure_pattern", payload={"title": "t"},
            source_type="doc", source_id="c1", evidence=["e"], confidence=0.6,
        )
    ]
    count = await svc.enqueue_batch(cands)
    assert count == 1
```

- [ ] **Step 7: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/memory/test_candidate_service.py -v`
Expected: PASS

- [ ] **Step 8: Implement `DocRelationsStore.link_batch` (single transaction)**

In `src/draftly/integrations/database/doc_relations_store.py`, add a batch that ensures both nodes then upserts an edge per relation, inside one transaction. Reuse the exact SQL from `ensure_node` (lines 23-30) and `upsert_edge` (lines 47-63):

```python
    async def link_batch(self, relations: list[dict]) -> int:
        async with self.client.transaction() as conn:
            count = 0
            for rel in relations:
                src = await self.client.fetch_one_conn(
                    conn,
                    """
                    INSERT INTO knowledge_nodes (org_id, node_type, key, title)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (org_id, node_type, key)
                    DO UPDATE SET title = COALESCE(EXCLUDED.title, knowledge_nodes.title)
                    RETURNING id, org_id, node_type, key, title
                    """,
                    rel.get("org_id"),
                    rel.get("source_type", "code"),
                    rel["source"],
                    None,
                )
                tgt = await self.client.fetch_one_conn(
                    conn,
                    """
                    INSERT INTO knowledge_nodes (org_id, node_type, key, title)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (org_id, node_type, key)
                    DO UPDATE SET title = COALESCE(EXCLUDED.title, knowledge_nodes.title)
                    RETURNING id, org_id, node_type, key, title
                    """,
                    rel.get("org_id"),
                    rel.get("target_type", "doc"),
                    rel["target"],
                    None,
                )
                await self.client.fetch_one_conn(
                    conn,
                    """
                    INSERT INTO doc_edges (
                        org_id, source_node_id, target_node_id, relation_type, evidence
                    ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::JSONB)
                    ON CONFLICT (source_node_id, target_node_id, relation_type)
                    DO UPDATE SET last_confirmed_at = now(),
                                  evidence = EXCLUDED.evidence
                    RETURNING id
                    """,
                    rel.get("org_id"),
                    src["id"],
                    tgt["id"],
                    rel["type"],
                    json.dumps(rel.get("evidence") or []),
                )
                count += 1
        return count
```

- [ ] **Step 9: Implement `DocGraphService.link_batch` and add fake in `tests/fakes/memory_stores.py`**

In `src/draftly/memory/docgraph/service.py`, add:

```python
    async def link_batch(self, relations: list[dict]) -> int:
        return await self.store.link_batch(relations)
```

In `tests/fakes/memory_stores.py`, extend `FakeDocGraphStore` (around lines 59-91) with a `link_batch` that mirrors `DocGraphService.link`'s store-level semantics (the fake has NO `link` method — it exposes the store level `ensure_node`/`upsert_edge`, so the fake batch must reuse those directly):

```python
    async def link_batch(self, relations):
        count = 0
        for rel in relations:
            src = self._node(rel.get("source_type", "code"), rel["source"], rel.get("org_id"))
            tgt = self._node(rel.get("target_type", "doc"), rel["target"], rel.get("org_id"))
            await self.upsert_edge(
                source_node_id=src["id"],
                target_node_id=tgt["id"],
                relation_type=rel["type"],
                org_id=rel.get("org_id"),
                evidence=rel.get("evidence"),
            )
            count += 1
        return count
```

Also extend `FakeCandidatesStore` (around lines 110-135) with `insert_batch` for `CandidateService.enqueue_batch` and the Task 2 Step 13 stage test:

```python
    async def insert_batch(self, *, fields_list):
        for fields in fields_list:
            await self.insert(fields=fields)
        return list(self.rows[-len(fields_list):])
```

> `FakeCandidatesStore` already implements `insert`, `claim_pending`, `set_status`, `list_by_status` (lines 114-135); `insert_batch` must reuse the existing `insert` so status/id assignment stays consistent. Do NOT add a second in-memory list.

- [ ] **Step 10: Write failing test for `DocGraphService.link_batch`**

```python
# tests/unit/memory/test_docgraph_service.py (append)
import pytest

from draftly.memory.docgraph.service import DocGraphService
from tests.fakes.memory_stores import FakeDocGraphStore


@pytest.mark.asyncio
async def test_link_batch_links_all_relations():
    store = FakeDocGraphStore()
    svc = DocGraphService(store=store)
    n = await svc.link_batch([
        {"source": "a.py", "target": "docs/a.md", "type": "DOCUMENTED_BY", "org_id": "o"},
        {"source": "b.py", "target": "docs/b.md", "type": "DOCUMENTED_BY", "org_id": "o"},
    ])
    assert n == 2
    assert len(store.edges) == 2
```

- [ ] **Step 11: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/memory/test_docgraph_service.py -v`
Expected: PASS

- [ ] **Step 12: Update `run_knowledge_construction` to batch across chunks when real services are present**

In `src/draftly/workflows/onboarding/stages.py`, restructure the per-batch `for i in range(0, total, CHUNK_BATCH_SIZE)` loop's post-`asyncio.gather` section. **Replace the entire inner `for chunk, (extracted, chunk_id) in zip(batch, extracted_results):` loop plus the sequential relationship/procedure blocks (current `stages.py:464-511`) with the code below** — which folds the facts collection (currently `473-482`), relationship collection, and procedure collection into one accumulation loop, then flushes ONE `link_batch` + ONE `enqueue_batch` per `CHUNK_BATCH_SIZE` group. This is a real 50x transaction reduction versus the current per-relationship/per-procedure writes. The existing `store_batch(facts)` block (`516-526`) stays as-is:

```python
            # Accumulate across all chunks in this batch, then flush once.
            batch_relations: list[dict] = []
            batch_candidates: list[MemoryCandidate] = []

            for chunk, (extracted, chunk_id) in zip(batch, extracted_results):
                if extracted is None:
                    # Empty content or a failed/timed-out extraction.
                    result.failed_chunks.append(chunk_id)
                    continue

                # Collect extracted facts; stored in one batch at batch end
                for fact in extracted.facts:
                    facts.append(
                        Knowledge(
                            namespace="knowledge",
                            content=fact,
                            org_id=org_id,
                            topic=chunk.get("metadata", {}).get("title"),
                            source_quality=0.7,
                        )
                    )

                try:
                    # Collect relationships for the batch-level flush below.
                    # _chunk_id is used only by the per-item fallback for
                    # failure isolation; doc_edges SQL reads named keys only.
                    for rel in extracted.relationships:
                        batch_relations.append({
                            "_chunk_id": chunk_id,
                            "source": rel.source,
                            "target": rel.target,
                            "type": rel.type,
                            "org_id": org_id,
                            "source_type": "code",
                            "target_type": "doc",
                        })

                    # Collect procedure patterns for the batch-level flush below.
                    for proc in extracted.procedures:
                        batch_candidates.append(
                            MemoryCandidate(
                                org_id=org_id,
                                candidate_type="procedure_pattern",
                                payload=proc.model_dump(),
                                source_type="document_chunk",
                                source_id=chunk_id,
                                evidence=[chunk.get("content", "")[:200]],
                                confidence=0.6,
                            )
                        )
                except Exception as exc:
                    logger.warning(
                        "knowledge_extraction_collect_failed chunk=%s err=%s",
                        chunk_id, exc,
                    )
                    result.failed_chunks.append(chunk_id)

            # Flush relationships + candidates once per batch. Real services
            # (production) take the batch path; mock contexts take per-item.
            from draftly.memory.candidates.service import CandidateService
            from draftly.memory.docgraph.service import DocGraphService

            if batch_relations:
                if isinstance(context.docgraph, DocGraphService):
                    try:
                        result.relationship_count += await context.docgraph.link_batch(
                            batch_relations
                        )
                    except Exception as exc:
                        logger.warning(
                            "knowledge_link_batch_failed count=%d err=%s",
                            len(batch_relations), exc,
                        )
                        result.failed_chunks.extend(
                            chunk.get("id", "unknown") for chunk in batch
                        )
                else:
                    # Per-item fallback with per-chunk failure isolation.
                    for rel_def in batch_relations:
                        try:
                            await context.docgraph.link(
                                source_key=rel_def["source"],
                                target_key=rel_def["target"],
                                relation_type=rel_def["type"],
                                org_id=org_id,
                            )
                            result.relationship_count += 1
                        except Exception as exc:
                            logger.warning(
                                "knowledge_link_failed err=%s", exc,
                            )
                            result.failed_chunks.append(rel_def.get("_chunk_id"))

            if batch_candidates:
                if isinstance(context.candidates, CandidateService):
                    try:
                        result.candidate_count += await context.candidates.enqueue_batch(
                            batch_candidates
                        )
                    except Exception as exc:
                        logger.warning(
                            "knowledge_enqueue_batch_failed count=%d err=%s",
                            len(batch_candidates), exc,
                        )
                        result.failed_chunks.extend(
                            chunk.get("id", "unknown") for chunk in batch
                        )
                else:
                    for cand in batch_candidates:
                        try:
                            await context.candidates.enqueue(cand)
                            result.candidate_count += 1
                        except Exception as exc:
                            # cand.source_id is the chunk id (document_chunk).
                            logger.warning("knowledge_enqueue_failed err=%s", exc)
                            result.failed_chunks.append(cand.source_id)
```

> **Step 12 requires the accumulation to happen per-chunk but the flush to happen once per batch.** `batch_relations` entries carry a `_chunk_id` key used only by the per-item fallback's failure isolation (matched to the original `stages.py:507-511` chunk-level try/except); it is harmless to `link_batch` because both the real `DocRelationsStore.link_batch` SQL and the `FakeDocGraphStore.link_batch` read named keys only. **Do NOT add a chunk-id to `batch_candidates`** — `MemoryCandidate` is a pydantic model, so an unknown field would fail validation; candidate-enqueue failures were not per-chunk isolated in the original code anyway.

> **Count accounting preserved:** `result.relationship_count`/`result.candidate_count` now come from batch-method return values (real services) or explicit increments (per-item). No existing test asserts a positive exact relationship/candidate count (verified), so this is safe. `knowledge_count` is unaffected (still via `store_batch`).

> **Final layout of the batch loop after this step:** `extract` (via `_extract`/`asyncio.gather`) → accumulate `facts`, `batch_relations`, `batch_candidates` per chunk → flush `link_batch`/`enqueue_batch` (isinstance-gated) → flush `store_batch(facts)` → `publish` progress. This is a single emission cadence per batch.

- [ ] **Step 13: Write test that batching is used for real services**

```python
# tests/unit/workflows/test_onboarding_stages.py (append)
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from draftly.memory.candidates.service import CandidateService
from draftly.memory.docgraph.service import DocGraphService
from tests.fakes.memory_stores import FakeCandidatesStore, FakeDocGraphStore

from draftly.workflows.onboarding import stages
from draftly.workflows.onboarding.stages import (
    ExtractionOutput, Procedure, Relationship, run_knowledge_construction,
)


@pytest.mark.asyncio
async def test_knowledge_construction_batches_relationships_and_candidates():
    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[
        {"id": "chunk-1", "content": "About the auth system.", "metadata": {}},
        {"id": "chunk-2", "content": "About the tokens endpoint.", "metadata": {}},
    ])
    context.memory.store_batch = AsyncMock(return_value=[{"id": "k-1"}])
    # Real services carry real batch methods; MagicMock context stays per-item.
    context.docgraph = DocGraphService(store=FakeDocGraphStore())
    context.candidates = CandidateService(store=FakeCandidatesStore())
    publish = AsyncMock()

    with patch.object(stages, "Agent") as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(return_value=fake_agent_result(
            ExtractionOutput(
                facts=["fact"],
                relationships=[Relationship(source="a", target="b", type="DOCUMENTED_BY")],
                procedures=[Procedure(title="Run", steps=["go"])],
            )
        ))

        result = await run_knowledge_construction(
            context, org_id="test-org", publish=publish,
        )

    # Two chunks × (1 relationship + 1 procedure) were flushed to the real
    # stores via batch methods. Edge count is NOT asserted: both chunks emit
    # the same a->b relationship, which FakeDocGraphStore.upsert_edge dedups
    # to one edge (count still returns 2). relationship_count/candidate_count
    # come from the batch-method return values.
    assert result.relationship_count == 2
    assert result.candidate_count == 2
    assert len(context.candidates.store.rows) == 2
```

> This exercises the **batch** path end-to-end: `context.docgraph`/`context.candidates` are real `DocGraphService`/`CandidateService` instances (fakes as stores), so the isinstance gate routes to `link_batch`/`enqueue_batch`. The fake stores must expose `link_batch` (Step 9) and `insert_batch` (Step 3 of Task 2, added to `FakeCandidatesStore` in this task's fake edit) — add `insert_batch` to `FakeCandidatesStore` in `tests/fakes/memory_stores.py` alongside the Step 9 `link_batch` fake edit, looping `self.insert(fields=f)` per row and returning `len(fields_list)`.

- [ ] **Step 14: Run test to verify it passes; also run the full stages suite**

Run: `.venv/bin/pytest tests/unit/workflows/test_onboarding_stages.py -v`
Expected: new test PASS and all pre-existing tests still PASS (they use the per-item fallback path).

- [ ] **Step 15: Commit**

```bash
git add src/draftly/memory/docgraph/service.py \
  src/draftly/integrations/database/doc_relations_store.py \
  src/draftly/memory/candidates/service.py \
  src/draftly/integrations/database/memory_candidates_store.py \
  src/draftly/workflows/onboarding/stages.py \
  tests/fakes/memory_stores.py \
  tests/unit/memory/test_docgraph_service.py \
  tests/unit/memory/test_candidate_service.py \
  tests/unit/workflows/test_onboarding_stages.py
git commit -m "perf: batch relationship linking and procedure enqueueing"
```

---

### Task 3: Per-batch safety timeout (replaces removed watchdog)

**Files:**
- Modify: `src/draftly/workflows/onboarding/stages.py`
- Test: `tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: existing `constants` block in `stages.py` (lines ~102-127) and the `CHUNK_TIMEOUT_SECONDS` convention.
- Produces:
  - `KNOWLEDGE_BATCH_TIMEOUT_SECONDS = int(os.environ.get("KNOWLEDGE_BATCH_TIMEOUT_SECONDS", "600"))` — a new module constant. Positive default.
  - Helper `_run_batch_with_timeout(coro: Awaitable[Any]) -> Any`: wraps `asyncio.wait_for(coro, timeout=KNOWLEDGE_BATCH_TIMEOUT_SECONDS)`. If the batch times out, records every chunk in the batch as failed and continues to the next batch (does NOT raise out of `run_knowledge_construction`).

**Why:** The prior conversation removed the overall workflow watchdog — `INIT_WORKFLOW_TIMEOUT_SECONDS` (initialize.py) is gone and RQ `job_timeout=-1` (`rq_jobs.py`). That was correct for staged onboarding (the old 1200s ceiling was flaking on genuinely slow work and aborting the whole workflow), but it left **no ceiling at all**: if the embeddings provider or the extraction LLM hangs, the RQ job hangs indefinitely with no worker-level or workflow-level guard. Task 3 restores a safety net without reintroducing the global watchdog. Instead of bounding the whole run, it bounds **each batch's** extraction+store to a configurable positive default (600s). A genuinely hung call aborts just that batch — its chunks are recorded `failed`, the stage keeps going, and the job completes rather than stalling forever. This is strictly safer than the old model (a single slow batch no longer kills the entire workflow) and preserves the user's requirement that all *timeouts* be truly removed as a job/workflow ceiling while a bounded per-call deadline is reintroduced.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/workflows/test_onboarding_stages.py (append)
import asyncio


def test_knowledge_batch_timeout_has_positive_default():
    assert stages.KNOWLEDGE_BATCH_TIMEOUT_SECONDS > 0


@pytest.mark.asyncio
async def test_knowledge_construction_times_out_slow_batch(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock, patch

    monkeypatch.setattr(stages, "KNOWLEDGE_BATCH_TIMEOUT_SECONDS", 0.05)

    async def slow_store(items):
        await asyncio.sleep(1.0)
        return [{"id": "k"}]

    async def fast_llm(model, prompt, agent=None, *, output_model=None, telemetry=None):
        return ExtractionOutput(facts=["f"])

    monkeypatch.setattr(stages, "_llm_generate", fast_llm)

    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[
        {"id": "c1", "content": "Content.", "metadata": {}},
    ])
    context.memory.store_batch = slow_store
    context.docgraph.link = AsyncMock()
    context.candidates.enqueue = AsyncMock()
    publish = AsyncMock()

    with patch("draftly.workflows.onboarding.stages.Agent"):
        result = await run_knowledge_construction(
            context, org_id="test-org", publish=publish,
        )

    # The slow store_batch was cut off; the chunk is recorded failed and the
    # stage still returns (does not hang the workflow).
    assert "c1" in result.failed_chunks
```

> Mirror the existing `test_knowledge_construction_enforces_chunk_timeout` (line ~668) conventions: `slow_llm`/`fast_llm` return the raw `ExtractionOutput` (NOT `fake_agent_result(...)` — `_llm_generate` returns `result.structured_output`, so a `SimpleNamespace` wrapper would break the facts iteration), and `stages` is the module alias already imported at the top of the file. Import the new test's names from the existing imports; do NOT add a module-level `from ... import KNOWLEDGE_BATCH_TIMEOUT_SECONDS` (it would break the whole module's collection before Task 3 Step 3 exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/workflows/test_onboarding_stages.py -v -k "timeout or batch"`
Expected: FAIL — `AttributeError: module 'draftly.workflows.onboarding.stages' has no attribute 'KNOWLEDGE_BATCH_TIMEOUT_SECONDS'` (the constant doesn't exist yet), or the slow store hangs/counts as success.

- [ ] **Step 3: Add the constant**

In `src/draftly/workflows/onboarding/stages.py`, in the constants block (near line 113), add:

```python
# Per-batch ceiling for stage 2 (extraction + store). Replaces the removed
# overall workflow watchdog (INIT_WORKFLOW_TIMEOUT_SECONDS): a hung provider
# or embedder stalls one batch for at most this long, is recorded as failed,
# and the stage continues. Positive default; set env to 0 to disable.
KNOWLEDGE_BATCH_TIMEOUT_SECONDS = int(
    os.environ.get("KNOWLEDGE_BATCH_TIMEOUT_SECONDS", "600")
)
```

- [ ] **Step 4: Wrap the per-batch extract and store with the timeout**

In `run_knowledge_construction`, wrap both the `asyncio.gather(...)` extraction (current `stages.py:460-462`) AND the `context.memory.store_batch(facts)` (current `stages.py:516-526`) in `asyncio.wait_for(..., timeout=KNOWLEDGE_BATCH_TIMEOUT_SECONDS)`, but only when `KNOWLEDGE_BATCH_TIMEOUT_SECONDS > 0`. On `TimeoutError`, mark the batch's chunks failed and `continue` to the next batch rather than raising. Concretely:

```python
    async def _bounded(coro: Awaitable[Any]) -> Any:
        if KNOWLEDGE_BATCH_TIMEOUT_SECONDS > 0:
            return await asyncio.wait_for(coro, timeout=KNOWLEDGE_BATCH_TIMEOUT_SECONDS)
        return await coro

    # ... inside the for-batch loop:
    try:
        extracted_results = await _bounded(
            asyncio.gather(*(_extract(chunk) for chunk in batch))
        )
    except (TimeoutError, asyncio.TimeoutError):
        result.failed_chunks.extend(chunk.get("id", "unknown") for chunk in batch)
        continue
```

And for storage (current `stages.py:516-526`), wrap `store_batch`:

```python
        if facts:
            try:
                await _bounded(context.memory.store_batch(facts))
                result.knowledge_count += len(facts)
            except (TimeoutError, asyncio.TimeoutError):
                logger.warning("knowledge_batch_store_timeout count=%d", len(facts))
                result.failed_chunks.extend(
                    chunk.get("id", "unknown") for chunk in batch
                )
            except Exception as exc:
                logger.warning(
                    "knowledge_fact_store_failed count=%d err=%s", len(facts), exc
                )
                result.failed_chunks.extend(
                    chunk.get("id", "unknown") for chunk in batch
                )
```

> Wrap the existing `try/except Exception` block (add the `TimeoutError`/`asyncio.TimeoutError` clause before the generic `Exception`), because `TimeoutError` subclasses `Exception` on 3.11+ and must be caught specifically.

- [ ] **Step 5: Run test to verify it passes; run full stages suite**

Run: `.venv/bin/pytest tests/unit/workflows/test_onboarding_stages.py -v`
Expected: PASS, including new tests and all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat: per-batch knowledge construction timeout"
```

---

### Task 4: Embedding log hygiene

**Files:**
- Modify: `src/draftly/models/embeddings.py`
- Test: `tests/unit/models/test_embedding_router.py`

**Interfaces:**
- Consumes: the new `EmbeddingRouter.embed_batch` from Task 1.
- Produces: no new public API. Reduces the per-text `embedding router attempting`/`resolved` log volume so real progress is visible. The per-text `embed()` path (used elsewhere, e.g. one-off embeds) keeps its existing logs.

**Why:** Today the embedding router emits an `embedding router attempting`/`embedding router resolved` INFO pair **per call** (`models/embeddings.py:102,144`). Because `embed_batch` (pre-Task-1) called `embed` once per fact, a single stage emitted hundreds to thousands of these INFO pairs, flooding the terminal and making real progress unreadable — the observed "embedding-log flood" in stages 2/3. It's not just cosmetic: at INFO level, ~1500 log lines per stage clutter Docker/worker logs and make grepping for actual errors and stage boundaries impractical. With Task 1's batch methods logging once per batch instead of once per text, the volume drops by the batch factor automatically. Task 4 pins that behavior with a test (asserting a batch of 3 produces exactly one attempting + one resolved pair and zero per-text lines) so the log hygiene doesn't regress, and documents that the per-text fallback path's logs are acceptable on the failure path only.

- [ ] **Step 1: Write failing test that batch path does not log per text**

```python
# tests/unit/models/test_embedding_router.py (append)
import structlog
from structlog.testing import capture_logs

import draftly.models.embeddings as emb_mod


def test_embed_batch_logs_once_not_per_text(monkeypatch):
    from draftly.models.embeddings import EmbeddingRouter

    embedder = _embedder_returning(3)
    router = EmbeddingRouter(registry=MagicMock(), health=MagicMock())

    class Cfg:
        provider = "openrouter"
        model_id = "text-embedding-3-small"
        priority = 1
        dimensions = 2  # must match _embedder_returning's 2-dim vectors

    router._ordered_candidates = lambda: [Cfg()]
    registry = MagicMock()
    registry.get_provider.return_value = MagicMock(
        is_enabled=lambda: True, create_embedder=lambda cfg: embedder,
    )
    router.registry = registry
    router.health = MagicMock()
    router.health.get.return_value = MagicMock(
        available=lambda: True, record_failure=lambda f: None, record_success=lambda: None,
    )

    # The module logger is cached under cache_logger_on_first_use, so patch
    # emb_mod.logger with a fresh proxy that resolves against capture_logs'
    # temporary processors (mirrors test_llm_generate_logs_routing).
    with capture_logs() as logs:
        monkeypatch.setattr(
            emb_mod, "logger", structlog.get_logger("test.embed_batch_logging"),
        )
        router.embed_batch(["a", "b", "c"])

    batch_attempts = [l for l in logs if l.get("event") == "embedding batch attempting"]
    batch_resolved = [l for l in logs if l.get("event") == "embedding batch resolved"]
    per_text = [l for l in logs if l.get("event") == "embedding router attempting"]
    assert len(batch_attempts) == 1
    assert len(batch_resolved) == 1
    assert per_text == []
```

> Note: `capture_logs` records the bare event string (first positional arg), so this asserts on exact event equality — "embedding batch attempting" once, and NO per-text "embedding router attempting" from a batch of 3. If this test passes before any Step 3 code (because Task 1 already logs at batch granularity), mark Step 3 as satisfied.
>
> **Dimension invariant:** `Cfg.dimensions = 2` is REQUIRED — `_validate_dimensions` (models/embeddings.py:171-182) reads `config.dimensions` and raises on mismatch with the 2-dim vectors from `_embedder_returning`. Without it this test fails with a spurious AttributeError.

- [ ] **Step 2: Run test to verify it reflects current behavior**

Run: `.venv/bin/pytest tests/unit/models/test_embedding_router.py -v -k batch`
Expected: The batch test in Task 1 already asserts `embed_query` not used; this test may already pass if the implementation from Task 1 logs at batch granularity. If it passes, skip to Step 3 (implementation already satisfies it). If it fails (per-text logs present), proceed to Step 3.

- [ ] **Step 3: Ensure batch logging is at batch granularity**

Confirm the `embed_batch` implementation from Task 1 logs `embedding batch attempting` / `embedding batch resolved` (once per batch) and does NOT emit the per-text `attempting`/`resolved`. If the per-text `embed()` router path is reached via `EmbeddingService` fallback, that is acceptable (failure path). No further code change needed if Step 2 already passes.

- [ ] **Step 4: Run full embedding + router suites**

Run: `.venv/bin/pytest tests/unit/models/test_embedding_router.py tests/unit/memory/test_embedding_service.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/draftly/models/embeddings.py tests/unit/models/test_embedding_router.py
git commit -m "chore: log embeddings at batch granularity"
```

---

## Final Verification (after all tasks)

- [ ] Run the full unit suite (no live NeonDB/index keys needed; integration tests are gated behind `DRAFTLY_LIVE=1`):

```bash
.venv/bin/pytest -m "not integration" -q
```

Expected: all tests PASS.

- [ ] Run lint + typecheck:

```bash
.venv/bin/ruff check src/draftly tests
.venv/bin/mypy src/draftly 2>&1 | head -40
```

Expected: no new errors attributable to these changes.

- [ ] Rebuild and restart the worker, then re-trigger onboarding for `org_3If5Y...` and confirm `stage_complete knowledge_construction` completes in a small fraction of the previous ~19m:

```bash
docker compose -f docker-compose.redis.yml up -d --build --force-recreate rq-worker
```

Expected: onboarding reaches later stages and completes; no `onboarding_initialize_timeout` (removed) and no indefinite hang; per-batch timeout fires only on genuinely hung calls.

## Self-Review Notes

- **Spec coverage:** All four stated bottlenecks (per-fact embedding, sequential rel/proc writes, missing per-call deadline, embedding log spam) map to Tasks 1–4. Nothing re-adds the removed overall watchdog.
- **Placeholder scan:** All test/impl code is concrete. The spots that say "mirror the existing SQL" instruct the executor to copy from neighboring store methods (e.g. `insert` / `ensure_node` / `upsert_edge`) so DDL never drifts. Step 3 of Task 2 explicitly forbids the earlier draft's invented 8-column insert.

### Recorded review fixes (self-review pass, 2026-08-31)

These defects were found and corrected while self-reviewing the plan against the actual code:

1. **Task 1 Step 1 — broken `_FakeOpenAI` (2 bugs).** (a) `embeddings()` returned the nested *class* (a class attribute), so `create()` raised `missing 1 required positional argument: 'self'`. (b) Even as an instance method it would break: `embed_queries` accesses `self._client.embeddings.create(...)` WITHOUT calling `embeddings()` (mirroring the real OpenAI client where `embeddings` is an attribute), so `embeddings` must be a **property**, not a method. Also fixed the fake vector assertion (`out[2]` was `[4.0, 5.0]`, actual `[2.0, 3.0]`). All verified in isolation: the original class raises the `self` TypeError, the property form resolves and the generator math matches.
2. **Task 1 Step 5 + Task 4 Step 1 — `_validate_dimensions` requires `config.dimensions`.** The fake router configs (`SimpleNamespace`/`Cfg`) lacked `dimensions`, so `len(vector) != config.dimensions` raised `AttributeError` instead of testing the intended behavior. Added `dimensions=2` matching the fake's 2-dim vectors.
3. **Task 3 Step 1 — wrong log/return conventions.** The test imported `KNOWLEDGE_BATCH_TIMEOUT_SECONDS` at module level (breaks the entire test module's collection before the constant exists) and passed `fake_agent_result(...)` (a `SimpleNamespace` wrapper) to the patched `_llm_generate` — the real `_llm_generate` returns `result.structured_output`, so the wrapper would break facts iteration. Rewrote to mirror `test_knowledge_construction_enforces_chunk_timeout` (`ExtractionOutput` returned directly, `stages.` attribute access, `stages` module alias already imported).
4. **Task 4 Step 1 — logger patch was a no-op.** `monkeypatch.setattr(emb_mod, "logger", emb_mod.logger)` set the attribute to itself and captured nothing. Replaced with `structlog.get_logger("test.embed_batch_logging")` inside the `capture_logs` block, mirroring `test_llm_generate_logs_routing`. Assertions now use exact event equality (`capture_logs` records the bare event string).
5. **Task 2 Steps 3/5 — `insert_batch` SQL invented.** The earlier draft had an 8-column insert with a client-generated `id` and `RETURNING *`, which does not match the real table. Rewrote to mirror the real 7-column `insert` (JSONB casts, explicit RETURNING) and recommend a shared `_INSERT_SQL`/`_serialize_fields` helper so single-row and batch paths cannot drift. `enqueue_batch` now prefers `store.insert_batch` and falls back to per-item `enqueue`.
6. **Task 2 Step 12 — `hasattr` gate hits the MagicMock trap + batching was only per-chunk.** `hasattr(MagicMock(), "link_batch")` is always True, so a `hasattr`-gated batch path would route existing mock-based tests into the batch path and break them. Replaced with an `isinstance(context.docgraph, DocGraphService)` / `isinstance(context.candidates, CandidateService)` gate (production wires real instances; MagicMocks fail the isinstance and stay per-item — verified at `app/composition/workflows.py:123-124`). Also rewrote Step 12 to genuinely hoist accumulation and flush ONCE per `CHUNK_BATCH_SIZE` group (a real 50x transaction cut) instead of once per chunk.
7. **Task 2 Step 9 — fake `link_batch` called a nonexistent method.** `FakeDocGraphStore` has no `link` method (it's the store layer: `ensure_node`/`upsert_edge`), so the earlier fake would raise `AttributeError`. Rewrote it to mirror `DocGraphService.link`'s store-level calls; also added `FakeCandidatesStore.insert_batch` (reusing `insert`) for the stage test.
8. **Task 2 Step 13 — assertions wrong for 2 identical chunks.** Both chunks emit the same `a->b` relationship; the fake dedups identical edges to 1 while `link_batch` still counts 2. Assertions now target `relationship_count == 2` / `candidate_count == 2` / `rows == 2` with a comment explaining the dedup.
9. **Task 2 Step 12 — per-item candidate fallback lost failure isolation.** An `enqueue` failure would now propagate and fail the whole stage. Wrapped in per-item try/except and restored chunk-level isolation via `cand.source_id` (the chunk id).

### Known residual risks (accepted)

- **Task 2 Step 8 `DocRelationsStore.link_batch` reuses SQL inline** rather than calling the existing `ensure_node`/`upsert_edge` (those use auto-acquired connections, not the transaction conn). The `fetch_one_conn` variant is required inside `async with transaction()`. The executor must copy the SQL verbatim from the two existing methods; the plan provides the exact shape.
- **`_bounded` scoping in Task 3** wraps `_extract` gather and `store_batch` but not the link/enqueue flush — deliberate (DB writes bounded by transactions, no LLM/embedding stall risk). If a hung DB write is later observed, wrap the flush in `_bounded` too.
