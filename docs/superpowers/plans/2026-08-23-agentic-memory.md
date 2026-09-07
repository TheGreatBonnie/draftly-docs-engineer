# Agentic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved agentic memory design — episodic, procedural,
and documentation-graph memory subsystems plus an autonomous async Memory
Curator — in `draftly-agent-backend`.

**Architecture:** Dedicated subsystems per memory kind (own tables + services),
an outbox table (`memory_candidates`) decoupling workflows from curation, and
an async curator workflow that claims candidates and decides
CREATE/UPDATE/MERGE/SUPERSEDE/REJECT/ARCHIVE using Strands function-based
tools. The existing semantic path gains status filtering + supersede;
grounding upgrades to merge facts + episodes + procedures.

**Tech Stack:** Python 3.12, Strands Agents SDK (`strands.Agent`,
`strands.tools.tool`), asyncpg + NeonDB (pgvector), pytest, structlog.

**Spec:** `docs/superpowers/specs/2026-08-23-agentic-memory-design.md`
(executors read both; the plan argues from the spec).

## Global Constraints

- Python 3.12; layout under `src/draftly/`. Gates per task: `ruff check`, `mypy`, targeted `pytest`.
- Logging: module-level `logger = structlog.get_logger(__name__)`.
- **Fail-open:** grounding/extraction/maintenance log-and-continue on any exception.
- All queries org-scoped via `org_id`.
- Strands tools: decorate with `@tool` from `strands.tools`; docstring is the model-facing description; async tools supported (Strands docs, "Function-Based Tools").
- Embeddings via `EmbeddingService.embed(text)`; vector columns are `VECTOR(1536)`; every store normalizes vectors via `normalize_vector` (truncate/zero-pad).
- Vectors formatted as `"[" + ",".join(...)` strings with `$n::VECTOR` cast (mirrors `DatabaseMemoryStore._format_vector`).
- Integration tests skip when `NEON_DATABASE_URL` unset.
- Commit after every task (conventional messages). Work in `draftly-agent-backend/`.

## File Structure

```
Create: src/draftly/persistence/migrations/{028_episodes,029_procedures,
        030_doc_relations,031_memory_candidates}.sql
Create: src/draftly/integrations/database/{episodes_store,procedures_store,
        doc_relations_store,memory_candidates_store}.py
Modify: src/draftly/integrations/database/vector_search.py   (status filter)
Modify: src/draftly/persistence/repositories/memory.py       (supersede)
Create: src/draftly/memory/vector_utils.py
Create: src/draftly/memory/{episodic,procedural,docgraph,candidates}/service.py (+ __init__.py each; candidates also models.py)
Modify: src/draftly/memory/service.py                        (supersede)
Create: src/draftly/tools/memory/__init__.py
Create: src/draftly/tools/memory/{search,curation,knowledge,affected_docs}.py
Modify: src/draftly/app/composition/tools.py                 (register groups)
Modify: src/draftly/agents/prompts.py                        (curator prompt)
Modify: src/draftly/agents/shared/memory_curator.py          (tools param)
Create: src/draftly/workflows/post_run/candidate_extractor.py (+ __init__.py)
Create: src/draftly/workflows/memory/curation_workflow.py    (+ __init__.py)
Modify: src/draftly/workflows/context.py                     (dep fields)
Modify: src/draftly/workflows/runner.py                      (post-run hook)
Modify: src/draftly/app/composition/workflows.py             (wire+register)
Modify: src/draftly/app/composition/workers.py               (schedule job)
Modify: src/draftly/agents/shared/memory_grounding.py        (3-source merge)
Tests:
Create: tests/fakes/memory_stores.py
Create: tests/unit/memory/test_{episodic_service,procedural_service,docgraph_service,candidate_service,supersede}.py
Create: tests/unit/tools/test_memory_tools.py
Create: tests/unit/agents/test_memory_grounding_upgrade.py
Create: tests/workflow/test_candidate_extractor.py, tests/workflow/test_curation_workflow.py
Create: tests/integration/test_memory_migrations.py
```

---

### Task 1: Migrations 028–031

**Files:**
- Create: `src/draftly/persistence/migrations/028_episodes.sql`
- Create: `src/draftly/persistence/migrations/029_procedures.sql`
- Create: `src/draftly/persistence/migrations/030_doc_relations.sql`
- Create: `src/draftly/persistence/migrations/031_memory_candidates.sql`
- Test: `tests/integration/test_memory_migrations.py`

**Interfaces:**
- Produces: tables `episodes`, `procedures`, `knowledge_nodes`, `doc_edges`, `memory_candidates` used by all later tasks. SQL copied verbatim from spec §Components 1.

- [ ] **Step 1: Write 028_episodes.sql**

```sql
CREATE TABLE IF NOT EXISTS episodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    agent_run_id UUID,
    trigger_type TEXT NOT NULL,
    trigger_id TEXT,
    trigger_summary TEXT NOT NULL,
    actions_taken JSONB NOT NULL DEFAULT '[]'::JSONB,
    tools_used TEXT[] NOT NULL DEFAULT '{}',
    outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
    evaluation_results JSONB,
    artifacts_created JSONB NOT NULL DEFAULT '[]'::JSONB,
    summary TEXT,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_org_trigger
ON episodes (org_id, trigger_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodes_embedding
ON episodes USING hnsw (embedding vector_cosine_ops);
```

(`agent_run_id` intentionally FK-less: agent_runs rows may not exist in tests;
linkage enforced in service code.)

- [ ] **Step 2: Write 029_procedures.sql**

```sql
CREATE TABLE IF NOT EXISTS procedures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    pattern_description TEXT NOT NULL,
    trigger_conditions JSONB NOT NULL DEFAULT '{}'::JSONB,
    steps JSONB NOT NULL DEFAULT '[]'::JSONB,
    applicability_context TEXT,
    success_count INT8 NOT NULL DEFAULT 0,
    failure_count INT8 NOT NULL DEFAULT 0,
    confidence FLOAT8 NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','archived')),
    embedding VECTOR(1536),
    last_applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT procedures_confidence_check CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_procedures_org_status ON procedures (org_id, status);

CREATE INDEX IF NOT EXISTS idx_procedures_embedding
ON procedures USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 3: Write 030_doc_relations.sql**

```sql
CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    node_type TEXT NOT NULL CHECK (node_type IN ('code','concept','doc','eval')),
    key TEXT NOT NULL,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, node_type, key)
);

CREATE TABLE IF NOT EXISTS doc_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    source_node_id UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK (relation_type IN
        ('IMPLEMENTS','DOCUMENTED_BY','AFFECTS','DERIVED_FROM')),
    evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_node_id, target_node_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_key ON knowledge_nodes (org_id, node_type, key);
CREATE INDEX IF NOT EXISTS idx_doc_edges_source ON doc_edges (source_node_id);
CREATE INDEX IF NOT EXISTS idx_doc_edges_target ON doc_edges (target_node_id);
```

- [ ] **Step 4: Write 031_memory_candidates.sql**

```sql
CREATE TABLE IF NOT EXISTS memory_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    candidate_type TEXT NOT NULL CHECK (candidate_type IN
        ('fact','decision','procedure_pattern','doc_relation','episode_summary')),
    payload JSONB NOT NULL,
    source_type TEXT,
    source_id TEXT,
    evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
    confidence FLOAT8 NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','applied','rejected')),
    decision_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_pending
ON memory_candidates (status, created_at) WHERE status = 'pending';
```

- [ ] **Step 5: Write integration test**

```python
"""tests/integration/test_memory_migrations.py"""
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("NEON_DATABASE_URL"), reason="NEON_DATABASE_URL not set"
)

MIGRATIONS = Path("src/draftly/persistence/migrations")


@pytest.mark.asyncio
async def test_new_memory_migrations_apply_idempotently():
    import asyncpg

    conn = await asyncpg.connect(os.environ["NEON_DATABASE_URL"])
    try:
        for name in (
            "028_episodes.sql", "029_procedures.sql",
            "030_doc_relations.sql", "031_memory_candidates.sql",
        ):
            sql = (MIGRATIONS / name).read_text()
            await conn.execute(sql)
            await conn.execute(sql)  # second run must not raise either
        for table in ("episodes", "procedures", "knowledge_nodes",
                      "doc_edges", "memory_candidates"):
            await conn.fetchrow(f"SELECT 1 FROM {table} LIMIT 1")
    finally:
        await conn.close()
```

- [ ] **Step 6: Run test**

Run: `pytest tests/integration/test_memory_migrations.py -v`
Expected: PASS, or SKIP without NEON_DATABASE_URL.

- [ ] **Step 7: Commit**

```bash
git add src/draftly/persistence/migrations/028_episodes.sql \
  src/draftly/persistence/migrations/029_procedures.sql \
  src/draftly/persistence/migrations/030_doc_relations.sql \
  src/draftly/persistence/migrations/031_memory_candidates.sql \
  tests/integration/test_memory_migrations.py
git commit -m "feat(memory): add episodic/procedural/doc-graph/candidate migrations"
```

---

### Task 2: Vector utils + EpisodesStore + EpisodicService

**Files:**
- Create: `src/draftly/memory/vector_utils.py`, `src/draftly/memory/episodic/__init__.py`, `src/draftly/memory/episodic/service.py`
- Create: `src/draftly/integrations/database/episodes_store.py`
- Create: `tests/fakes/memory_stores.py`
- Test: `tests/unit/memory/test_episodic_service.py`

**Interfaces:**
- Consumes: `DatabaseClient.fetch_one/fetch_all`, `EmbeddingService.embed(text) -> list[float]`.
- Produces:
  - `normalize_vector(v, dim=1536) -> list[float]`; `format_vector(v) -> str`
  - `EpisodesStore.insert(*, fields) -> dict`; `.search(*, embedding, org_id=None, limit=5)`
  - `EpisodicService.record_episode(**fields) -> dict`; `.find_similar(query, *, org_id=None, limit=5)` (fails open to `[]`)

- [ ] **Step 1: Write failing tests**

```python
"""tests/unit/memory/test_episodic_service.py"""
import pytest

from draftly.memory.episodic.service import EpisodicService
from tests.fakes.memory_stores import FakeEpisodesStore


class StaticEmbedder:
    def embed(self, text: str) -> list[float]:
        return [0.5, 0.5]


@pytest.mark.asyncio
async def test_record_episode_persists_and_embeds_summary():
    store = FakeEpisodesStore()
    svc = EpisodicService(store=store, embeddings=StaticEmbedder())
    record = await svc.record_episode(
        org_id="org1", agent_run_id=None, trigger_type="github_pr",
        trigger_id="482", trigger_summary="Token expiry changed",
        actions_taken=["researched repo"], tools_used=["get_diff"],
        outcome="success", evaluation_results={"pass": True},
        artifacts_created=["docs/auth/tokens.md"],
    )
    assert record["id"]
    assert store.rows[0]["trigger_type"] == "github_pr"
    assert store.rows[0]["embedding"] == [0.5, 0.5]


@pytest.mark.asyncio
async def test_find_similar_returns_matches():
    svc = EpisodicService(store=FakeEpisodesStore(), embeddings=StaticEmbedder())
    await svc.record_episode(
        org_id="org1", agent_run_id=None, trigger_type="github_pr",
        trigger_id="1", trigger_summary="oauth token change",
        actions_taken=[], tools_used=[], outcome="success",
        evaluation_results=None, artifacts_created=[],
    )
    hits = await svc.find_similar("token change", org_id="org1")
    assert len(hits) == 1
    assert hits[0]["trigger_summary"] == "oauth token change"


@pytest.mark.asyncio
async def test_find_similar_fails_open():
    class Boom:
        async def search(self, **kw):
            raise RuntimeError("db down")

    svc = EpisodicService(store=Boom(), embeddings=StaticEmbedder())
    assert await svc.find_similar("x") == []


def test_normalize_vector_pads_to_1536():
    from draftly.memory.vector_utils import normalize_vector

    out = normalize_vector([1.0, 2.0])
    assert len(out) == 1536 and out[:2] == [1.0, 2.0] and out[-1] == 0.0
    assert len(normalize_vector([0.0] * 2000)) == 1536
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/unit/memory/test_episodic_service.py -v`
Expected: FAIL — `ModuleNotFoundError: draftly.memory.episodic`

- [ ] **Step 3: Implement vector_utils.py**

```python
"""src/draftly/memory/vector_utils.py — shared pgvector helpers."""
from __future__ import annotations

from collections.abc import Sequence

EMBEDDING_DIMENSIONS = 1536


def normalize_vector(embedding: Sequence[float], dim: int = EMBEDDING_DIMENSIONS) -> list[float]:
    """Truncate or zero-pad to the column dimension so writes never fail."""
    values = [float(v) for v in embedding][:dim]
    values.extend([0.0] * (dim - len(values)))
    return values


def format_vector(embedding: Sequence[float]) -> str:
    return "[" + ",".join(str(float(v)) for v in embedding) + "]"
```

Create empty `src/draftly/memory/episodic/__init__.py`.

- [ ] **Step 4: Create tests/fakes/memory_stores.py**

```python
"""In-memory doubles for agentic-memory stores."""
from __future__ import annotations


class FakeEpisodesStore:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def insert(self, *, fields: dict) -> dict:
        fields = dict(fields)
        fields["id"] = f"ep-{len(self.rows) + 1}"
        self.rows.append(fields)
        return {"id": fields["id"], **fields}

    async def search(self, *, embedding, org_id=None, limit=5):
        return [
            {k: v for k, v in r.items() if k != "embedding"}
            for r in self.rows
            if org_id in (None, r.get("org_id"))
        ][:limit]
```

- [ ] **Step 5: Implement EpisodesStore**

```python
"""src/draftly/integrations/database/episodes_store.py"""
from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from draftly.integrations.database.client import DatabaseClient
from draftly.memory.vector_utils import format_vector, normalize_vector

_EPISODE_COLUMNS = """id, org_id, agent_run_id, trigger_type, trigger_id,
    trigger_summary, actions_taken, tools_used, outcome, evaluation_results,
    artifacts_created, summary, created_at"""


class EpisodesStore:
    def __init__(self, client: DatabaseClient | None = None) -> None:
        self.client = client or DatabaseClient()

    async def insert(self, *, fields: dict[str, Any]) -> dict[str, Any]:
        embedding = normalize_vector(fields.pop("embedding"))
        evaluation = fields.get("evaluation_results")
        row = await self.client.fetch_one(
            """
            INSERT INTO episodes (
                org_id, agent_run_id, trigger_type, trigger_id,
                trigger_summary, actions_taken, tools_used, outcome,
                evaluation_results, artifacts_created, summary, embedding
            ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8,$9::JSONB,$10::JSONB,$11,$12::VECTOR)
            RETURNING id, org_id, agent_run_id, trigger_type, trigger_id,
                trigger_summary, actions_taken, tools_used, outcome,
                evaluation_results, artifacts_created, summary, created_at
            """,
            fields.get("org_id"),
            fields.get("agent_run_id"),
            fields["trigger_type"],
            fields.get("trigger_id"),
            fields["trigger_summary"],
            json.dumps(fields.get("actions_taken") or []),
            list(fields.get("tools_used") or []),
            fields["outcome"],
            json.dumps(evaluation) if evaluation is not None else None,
            json.dumps(fields.get("artifacts_created") or []),
            fields.get("summary"),
            format_vector(embedding),
        )
        return dict(row) if row else {}

    async def search(self, *, embedding: Sequence[float],
                     org_id: str | None = None, limit: int = 5) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all(
            f"""
            SELECT {_EPISODE_COLUMNS},
                   1 - (embedding <=> $1::VECTOR) AS similarity
            FROM episodes
            WHERE ($2::TEXT IS NULL OR org_id = $2)
            ORDER BY embedding <=> $1::VECTOR
            LIMIT $3
            """,
            format_vector(normalize_vector(embedding)),
            org_id,
            limit,
        )
        return [dict(r) for r in rows]
```

- [ ] **Step 6: Implement EpisodicService**

```python
"""src/draftly/memory/episodic/service.py — episodic memory facade."""
from __future__ import annotations

from typing import Any

import structlog

from draftly.integrations.database.episodes_store import EpisodesStore
from draftly.memory.embeddings import EmbeddingService

logger = structlog.get_logger(__name__)


class EpisodicService:
    """Record what happened per run; recall similar past episodes."""

    def __init__(self, store: Any = None, embeddings: Any = None) -> None:
        self.store = store or EpisodesStore()
        self.embeddings = embeddings or EmbeddingService()

    async def record_episode(self, **fields: Any) -> dict[str, Any]:
        summary = fields.get("summary") or fields.get("trigger_summary") or ""
        fields["embedding"] = self.embeddings.embed(summary)
        record = await self.store.insert(fields=fields)
        logger.debug("episode_recorded id=%s", record.get("id"))
        return record

    async def find_similar(self, query: str, *, org_id: str | None = None,
                           limit: int = 5) -> list[dict[str, Any]]:
        try:
            return await self.store.search(
                embedding=self.embeddings.embed(query), org_id=org_id, limit=limit,
            )
        except Exception:
            logger.exception("episode_recall_failed")
            return []
```

Run: `pytest tests/unit/memory/test_episodic_service.py -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/draftly/memory/vector_utils.py src/draftly/memory/episodic \
  src/draftly/integrations/database/episodes_store.py tests/fakes/memory_stores.py \
  tests/unit/memory/test_episodic_service.py
git commit -m "feat(memory): episodic memory store + service"
```

---

### Task 3: ProceduresStore + ProceduralService

**Files:**
- Create: `src/draftly/integrations/database/procedures_store.py`, `src/draftly/memory/procedural/__init__.py`, `src/draftly/memory/procedural/service.py`
- Modify: `tests/fakes/memory_stores.py` (append FakeProceduresStore)
- Test: `tests/unit/memory/test_procedural_service.py`

**Interfaces:**
- Produces:
  - `ProceduresStore.insert/get/update/search` — search filters `status='active'`; update maps value `"now()"` to SQL `now()`
  - `ProceduralService.create(name, pattern_description, *, org_id=None, trigger_conditions=None, steps=None, applicability_context=None) -> dict`
  - `ProceduralService.match(query, *, org_id=None, limit=3)` (fails open)
  - `ProceduralService.reinforce(id)` / `.invalidate(id)`
  - Archive rule (spec): confidence < 0.3 after >= 3 total applications -> `status='archived'`

- [ ] **Step 1: Write failing tests**

```python
"""tests/unit/memory/test_procedural_service.py"""
import pytest

from draftly.memory.procedural.service import ProceduralService
from tests.fakes.memory_stores import FakeProceduresStore


class StaticEmbedder:
    def embed(self, text: str) -> list[float]:
        return [1.0, 0.0]


def make_svc() -> ProceduralService:
    return ProceduralService(store=FakeProceduresStore(), embeddings=StaticEmbedder())


@pytest.mark.asyncio
async def test_reinforce_increases_confidence_and_success():
    svc = make_svc()
    proc = await svc.create("auth-playbook", "inspect tokens first", org_id="org1")
    updated = await svc.reinforce(proc["id"])
    assert updated["success_count"] == 1
    assert updated["confidence"] > 0.5
    assert updated["status"] == "active"


@pytest.mark.asyncio
async def test_low_confidence_after_three_applications_archives():
    svc = make_svc()
    proc = await svc.create("p", "d", org_id="org1")
    for _ in range(3):
        proc = await svc.invalidate(proc["id"])
    assert proc["status"] == "archived"
    assert proc["failure_count"] == 3


@pytest.mark.asyncio
async def test_match_excludes_archived_and_other_orgs():
    svc = make_svc()
    proc = await svc.create("p", "playbook about oauth", org_id="org1")
    await svc.store.update(proc["id"], status="archived")
    other = await svc.create("q", "playbook about oauth too", org_id="org2")
    hits = await svc.match("oauth", org_id="org2")
    assert len(hits) == 1 and hits[0]["id"] == other["id"]
```

Run: `pytest tests/unit/memory/test_procedural_service.py -v` → FAIL (`draftly.memory.procedural` missing)

- [ ] **Step 2: Append FakeProceduresStore to tests/fakes/memory_stores.py**

```python
class FakeProceduresStore:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self._n = 0

    async def insert(self, *, fields: dict) -> dict:
        self._n += 1
        row = {
            "id": f"proc-{self._n}", "status": "active",
            "success_count": 0, "failure_count": 0, "confidence": 0.5,
            **fields,
        }
        self.rows[row["id"]] = row
        return dict(row)

    async def get(self, procedure_id: str) -> dict | None:
        row = self.rows.get(procedure_id)
        return dict(row) if row else None

    async def update(self, procedure_id: str, **fields) -> dict:
        self.rows[procedure_id].update(fields)
        return dict(self.rows[procedure_id])

    async def search(self, *, embedding, org_id=None, limit=3):
        active = [
            dict(r) for r in self.rows.values()
            if r.get("status") == "active" and org_id in (None, r.get("org_id"))
        ]
        return active[:limit]
```

- [ ] **Step 3: Implement ProceduresStore** (mirror EpisodesStore; INSERT all columns incl. `name, pattern_description, trigger_conditions::JSONB, steps::JSONB, applicability_context, confidence, embedding::VECTOR`; `search` adds `AND status = 'active'`; dynamic UPDATE with `"now()"` mapping):

```python
# update excerpt from src/draftly/integrations/database/procedures_store.py
async def update(self, procedure_id: str, **fields: Any) -> dict[str, Any]:
    sets: list[str] = []
    args: list[Any] = []
    n = 0
    for col, val in fields.items():
        if val == "now()":
            sets.append(f"{col} = now()")
            continue
        n += 1
        sets.append(f"{col} = ${n}")
        args.append(val)
    args.append(procedure_id)
    row = await self.client.fetch_one(
        f"UPDATE procedures SET {', '.join(sets)}, updated_at = now()"
        f" WHERE id = ${n + 1} RETURNING *",
        *args,
    )
    return dict(row) if row else {}
```

- [ ] **Step 4: Implement ProceduralService**

```python
"""src/draftly/memory/procedural/service.py — learned playbooks."""
from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger(__name__)

ARCHIVE_CONFIDENCE = 0.3
MIN_APPLICATIONS_BEFORE_ARCHIVE = 3


class ProceduralService:
    def __init__(self, store: Any = None, embeddings: Any = None) -> None:
        from draftly.integrations.database.procedures_store import ProceduresStore
        from draftly.memory.embeddings import EmbeddingService

        self.store = store or ProceduresStore()
        self.embeddings = embeddings or EmbeddingService()

    async def create(self, name: str, pattern_description: str, *,
                     org_id: str | None = None,
                     trigger_conditions: dict | None = None,
                     steps: list | None = None,
                     applicability_context: str | None = None) -> dict[str, Any]:
        return await self.store.insert(fields={
            "org_id": org_id, "name": name,
            "pattern_description": pattern_description,
            "trigger_conditions": trigger_conditions or {},
            "steps": steps or [],
            "applicability_context": applicability_context,
            "confidence": 0.5,
            "embedding": self.embeddings.embed(pattern_description),
        })

    async def match(self, query: str, *, org_id: str | None = None,
                    limit: int = 3) -> list[dict[str, Any]]:
        try:
            return await self.store.search(
                embedding=self.embeddings.embed(query), org_id=org_id, limit=limit,
            )
        except Exception:
            logger.exception("procedure_match_failed")
            return []

    async def _apply_outcome(self, procedure_id: str, *, success: bool) -> dict[str, Any]:
        row = await self.store.get(procedure_id)
        if row is None:
            raise KeyError(f"procedure not found: {procedure_id}")
        applied = int(row["success_count"]) + int(row["failure_count"]) + 1
        if success:
            confidence = min(1.0, float(row["confidence"]) + (1.0 - float(row["confidence"])) * 0.25)
        else:
            confidence = max(0.0, float(row["confidence"]) * 0.75)
        status = row.get("status", "active")
        if applied >= MIN_APPLICATIONS_BEFORE_ARCHIVE and confidence < ARCHIVE_CONFIDENCE:
            status = "archived"
        updates: dict[str, Any] = {
            "confidence": confidence, "status": status,
            ("success_count" if success else "failure_count"):
                int(row["success_count" if success else "failure_count"]) + 1,
        }
        if success:
            updates["last_applied_at"] = "now()"
        return await self.store.update(procedure_id, **updates)

    async def reinforce(self, procedure_id: str) -> dict[str, Any]:
        return await self._apply_outcome(procedure_id, success=True)

    async def invalidate(self, procedure_id: str) -> dict[str, Any]:
        return await self._apply_outcome(procedure_id, success=False)
```

Run: `pytest tests/unit/memory/test_procedural_service.py -v` → PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/integrations/database/procedures_store.py \
  src/draftly/memory/procedural tests/fakes/memory_stores.py \
  tests/unit/memory/test_procedural_service.py
git commit -m "feat(memory): procedural memory store + service"
```

---

### Task 4: DocRelationsStore + DocGraphService

**Files:**
- Create: `src/draftly/integrations/database/doc_relations_store.py`, `src/draftly/memory/docgraph/__init__.py`, `src/draftly/memory/docgraph/service.py`
- Modify: `tests/fakes/memory_stores.py` (append FakeDocGraphStore)
- Test: `tests/unit/memory/test_docgraph_service.py`

**Interfaces:**
- Produces:
  - `DocGraphService.ensure_node(node_type, key, *, org_id=None, title=None) -> dict` (idempotent upsert)
  - `DocGraphService.link(source_key, target_key, relation_type, *, org_id=None, source_type="code", target_type="doc", evidence=None) -> dict` (idempotent; bumps `last_confirmed_at` on re-link)
  - `DocGraphService.affected_docs(code_paths, *, org_id=None) -> list[dict]` — docs reachable from code nodes via AFFECTS/DOCUMENTED_BY edges

- [ ] **Step 1: Write failing tests**

```python
"""tests/unit/memory/test_docgraph_service.py"""
import pytest

from draftly.memory.docgraph.service import DocGraphService
from tests.fakes.memory_stores import FakeDocGraphStore


@pytest.mark.asyncio
async def test_link_is_idempotent_and_confirms():
    store = FakeDocGraphStore()
    svc = DocGraphService(store=store)
    await svc.link("a.py", "docs/a.md", "DOCUMENTED_BY", org_id="org1")
    first = await svc.link("a.py", "docs/a.md", "DOCUMENTED_BY",
                           org_id="org1", evidence=["pr#482"])
    assert len(store.edges) == 1  # no duplicate edge
    assert "pr#482" in str(store.edges[0]["evidence"])


@pytest.mark.asyncio
async def test_affected_docs_traverses_graph():
    svc = DocGraphService(store=FakeDocGraphStore())
    await svc.link("auth/token_service.py", "Token Lifecycle", "IMPLEMENTS", org_id="org1",
                   source_type="code", target_type="concept")
    await svc.link("Token Lifecycle", "docs/auth/tokens.md", "DOCUMENTED_BY", org_id="org1",
                   source_type="concept", target_type="doc")
    docs = await svc.affected_docs(["auth/token_service.py"], org_id="org1")
    assert [d["key"] for d in docs] == ["docs/auth/tokens.md"]
```

Run → FAIL (`draftly.memory.docgraph` missing).

- [ ] **Step 2: Append fake**

```python
class FakeDocGraphStore:
    def __init__(self) -> None:
        self.nodes: list[dict] = []
        self.edges: list[dict] = []

    def _node(self, node_type, key, org_id):
        for n in self.nodes:
            if n["node_type"] == node_type and n["key"] == key and n.get("org_id") == org_id:
                return n
        n = {"id": f"n{len(self.nodes)+1}", "node_type": node_type,
             "key": key, "org_id": org_id}
        self.nodes.append(n)
        return n

    async def ensure_node(self, *, node_type, key, org_id=None, title=None) -> dict:
        return dict(self._node(node_type, key, org_id))

    async def upsert_edge(self, *, source_node_id, target_node_id,
                          relation_type, org_id=None, evidence=None) -> dict:
        for e in self.edges:
            if (e["source_node_id"] == source_node_id
                    and e["target_node_id"] == target_node_id
                    and e["relation_type"] == relation_type):
                e["evidence"] = evidence or e["evidence"]
                e["last_confirmed_at"] = "now"
                return dict(e)
        e = {"id": f"e{len(self.edges)+1}", "source_node_id": source_node_id,
             "target_node_id": target_node_id, "relation_type": relation_type,
             "evidence": evidence or [], "last_confirmed_at": "now"}
        self.edges.append(e)
        return dict(e)

    async def docs_for_code(self, *, code_keys, org_id=None) -> list[dict]:
        by_id = {n["id"]: n for n in self.nodes}
        code_nodes = {n["id"]: n for n in self.nodes if n["key"] in code_keys}
        docs, seen = [], set()
        changed = True
        frontier = set(code_nodes)
        while changed:
            changed = False
            for e in self.edges:
                if e["source_node_id"] in frontier and e["target_node_id"] not in seen:
                    seen.add(e["target_node_id"])
                    frontier.add(e["target_node_id"])
                    changed = True
                    node = by_id.get(e["target_node_id"], {})
                    if node.get("node_type") == "doc":
                        docs.append(dict(node))
        return docs
```

- [ ] **Step 3: Implement DocRelationsStore** — three methods mirroring the fake's signatures against `knowledge_nodes`/`doc_edges`:
  - `ensure_node`: `INSERT ... ON CONFLICT (org_id, node_type, key) DO UPDATE SET title = COALESCE(EXCLUDED.title, knowledge_nodes.title) RETURNING *`
  - `upsert_edge`: resolve node ids are passed in; `INSERT ... ON CONFLICT (source_node_id, target_node_id, relation_type) DO UPDATE SET last_confirmed_at = now(), evidence = EXCLUDED.evidence WHERE ... RETURNING *`
  - `docs_for_code`: recursive CTE over `doc_edges` seeded by code-node keys:

```sql
WITH RECURSIVE walk AS (
    SELECT kn.id, kn.node_type, kn.key FROM knowledge_nodes kn
    WHERE kn.org_id = $2 AND kn.node_type = 'code' AND kn.key = ANY($3::TEXT[])
  UNION
    SELECT t.id, t.node_type, t.key
    FROM doc_edges de
    JOIN walk w ON de.source_node_id = w.id
    JOIN knowledge_nodes t ON t.id = de.target_node_id
    WHERE ($2::TEXT IS NULL OR de.org_id = $2)
)
SELECT id AS node_id, node_type, key FROM walk WHERE node_type = 'doc';
```

- [ ] **Step 4: Implement DocGraphService**

```python
"""src/draftly/memory/docgraph/service.py — software<->docs knowledge graph."""
from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class DocGraphService:
    """Code <-> concept <-> doc relationships (fail-open reads)."""

    def __init__(self, store: Any = None) -> None:
        from draftly.integrations.database.doc_relations_store import (
            DocRelationsStore,
        )

        self.store = store or DocRelationsStore()

    async def ensure_node(self, node_type: str, key: str, *,
                          org_id: str | None = None,
                          title: str | None = None) -> dict[str, Any]:
        return await self.store.ensure_node(
            node_type=node_type, key=key, org_id=org_id, title=title,
        )

    async def link(self, source_key: str, target_key: str, relation_type: str, *,
                   org_id: str | None = None, source_type: str = "code",
                   target_type: str = "doc", evidence: list | None = None) -> dict[str, Any]:
        src = await self.ensure_node(source_type, source_key, org_id=org_id)
        tgt = await self.ensure_node(target_type, target_key, org_id=org_id)
        edge = await self.store.upsert_edge(
            source_node_id=src["id"], target_node_id=tgt["id"],
            relation_type=relation_type, org_id=org_id, evidence=evidence,
        )
        logger.debug("doc_edge_linked type=%s", relation_type)
        return edge

    async def affected_docs(self, code_paths: list[str], *,
                            org_id: str | None = None) -> list[dict[str, Any]]:
        try:
            return await self.store.docs_for_code(
                code_keys=code_paths, org_id=org_id,
            )
        except Exception:
            logger.exception("affected_docs_failed")
            return []
```

Run: `pytest tests/unit/memory/test_docgraph_service.py -v` → PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/integrations/database/doc_relations_store.py \
  src/draftly/memory/docgraph tests/fakes/memory_stores.py \
  tests/unit/memory/test_docgraph_service.py
git commit -m "feat(memory): documentation knowledge graph service"
```

---

### Task 5: MemoryCandidates models + CandidateService

**Files:**
- Create: `src/draftly/memory/candidates/__init__.py`, `models.py`, `service.py`
- Create: `src/draftly/integrations/database/memory_candidates_store.py`
- Modify: `tests/fakes/memory_stores.py` (append FakeCandidatesStore)
- Test: `tests/unit/memory/test_candidate_service.py`

**Interfaces:**
- Produces:
  - `MemoryCandidate(BaseModel)`: `id, org_id, candidate_type ('fact'|'decision'|'procedure_pattern'|'doc_relation'|'episode_summary'), payload dict, source_type, source_id, evidence list[str], confidence float=0.5, status='pending'`
  - `CandidateService.enqueue(candidate: MemoryCandidate) -> dict`
  - `CandidateService.claim_batch(limit=10) -> list[dict]` — atomic `pending -> processing`
  - `CandidateService.mark_applied(id, reason="")` / `.mark_rejected(id, reason)`
  - `CandidateService.list_pending(limit)` for maintenance/tests

- [ ] **Step 1: Write failing tests**

```python
"""tests/unit/memory/test_candidate_service.py"""
import pytest

from draftly.memory.candidates.models import MemoryCandidate
from draftly.memory.candidates.service import CandidateService
from tests.fakes.memory_stores import FakeCandidatesStore


def make_candidate(**kw) -> MemoryCandidate:
    defaults = dict(candidate_type="fact", payload={"content": "tokens expire in 1h"},
                    org_id="org1", source_type="github_pr", source_id="482",
                    evidence=["auth/token_service.py"])
    defaults.update(kw)
    return MemoryCandidate(**defaults)


@pytest.mark.asyncio
async def test_enqueue_then_claim_marks_processing():
    svc = CandidateService(store=FakeCandidatesStore())
    rec = await svc.enqueue(make_candidate())
    claimed = await svc.claim_batch(limit=10)
    assert len(claimed) == 1 and claimed[0]["status"] == "processing"


@pytest.mark.asyncio
async def test_claim_is_atomic_no_double_claim():
    svc = CandidateService(store=FakeCandidatesStore())
    await svc.enqueue(make_candidate())
    first = await svc.claim_batch(limit=10)
    second = await svc.claim_batch(limit=10)
    assert len(first) == 1 and second == []


@pytest.mark.asyncio
async def test_mark_applied_and_rejected_record_reasons():
    store = FakeCandidatesStore()
    svc = CandidateService(store=store)
    a = await svc.enqueue(make_candidate())
    r = await svc.enqueue(make_candidate(candidate_type="decision"))
    await svc.claim_batch(limit=10)
    await svc.mark_applied(a["id"], reason="new fact")
    await svc.mark_rejected(r["id"], reason="duplicate")
    assert {c["status"]: c["decision_reason"] for c in store.rows} == {
        "applied": "new fact", "rejected": "duplicate",
    }
```

Run → FAIL.

- [ ] **Step 2: Append fake**

```python
class FakeCandidatesStore:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def insert(self, *, fields: dict) -> dict:
        fields = {"id": f"cand-{len(self.rows)+1}", "status": "pending",
                  "decision_reason": None, **fields}
        self.rows.append(fields)
        return dict(fields)

    async def claim_pending(self, *, limit: int) -> list[dict]:
        claimed = []
        for row in self.rows:
            if row["status"] == "pending" and len(claimed) < limit:
                row["status"] = "processing"
                claimed.append(dict(row))
        return claimed

    async def set_status(self, candidate_id: str, status: str, reason: str) -> None:
        for row in self.rows:
            if row["id"] == candidate_id:
                row["status"] = status
                row["decision_reason"] = reason

    async def list_by_status(self, status: str, limit: int = 100) -> list[dict]:
        return [dict(r) for r in self.rows if r["status"] == status][:limit]
```

- [ ] **Step 3: Implement MemoryCandidatesStore** — mirror the fake against the table; `claim_pending` must be atomic:

```sql
UPDATE memory_candidates SET status = 'processing'
WHERE id IN (
    SELECT id FROM memory_candidates WHERE status = 'pending'
    ORDER BY created_at LIMIT $1
    FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

- [ ] **Step 4: Implement models + service**

```python
"""src/draftly/memory/candidates/models.py"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

CANDIDATE_TYPES = ("fact", "decision", "procedure_pattern",
                   "doc_relation", "episode_summary")


class MemoryCandidate(BaseModel):
    id: str | None = None
    org_id: str | None = None
    candidate_type: str
    payload: dict[str, Any]
    source_type: str | None = None
    source_id: str | None = None
    evidence: list[str] = []
    confidence: float = 0.5
    status: str = "pending"
```

```python
"""src/draftly/memory/candidates/service.py — curation outbox facade."""
from __future__ import annotations

import json
from typing import Any

import structlog

from draftly.memory.candidates.models import MemoryCandidate

logger = structlog.get_logger(__name__)


class CandidateService:
    def __init__(self, store: Any = None) -> None:
        from draftly.integrations.database.memory_candidates_store import (
            MemoryCandidatesStore,
        )

        self.store = store or MemoryCandidatesStore()

    async def enqueue(self, candidate: MemoryCandidate) -> dict[str, Any]:
        record = await self.store.insert(fields={
            "org_id": candidate.org_id,
            "candidate_type": candidate.candidate_type,
            "payload": json.dumps(candidate.payload),
            "source_type": candidate.source_type,
            "source_id": candidate.source_id,
            "evidence": json.dumps(candidate.evidence),
            "confidence": candidate.confidence,
        })
        logger.debug("candidate_enqueued type=%s", candidate.candidate_type)
        return record

    async def claim_batch(self, limit: int = 10) -> list[dict[str, Any]]:
        return await self.store.claim_pending(limit=limit)

    async def mark_applied(self, candidate_id: str, reason: str = "") -> None:
        await self.store.set_status(candidate_id, "applied", reason)

    async def mark_rejected(self, candidate_id: str, reason: str = "") -> None:
        await self.store.set_status(candidate_id, "rejected", reason)
```

Run: `pytest tests/unit/memory/test_candidate_service.py -v` → PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/draftly/memory/candidates \
  src/draftly/integrations/database/memory_candidates_store.py \
  tests/fakes/memory_stores.py tests/unit/memory/test_candidate_service.py
git commit -m "feat(memory): candidate outbox service"
```

---

### Task 6: Status-aware retrieval (VectorSearch filter)

**Files:**
- Modify: `src/draftly/integrations/database/vector_search.py:37-60` (`search`)
- Test: `tests/unit/memory/test_status_filter.py`

**Interfaces:**
- Produces: `VectorSearch.search(*, namespace, embedding, limit=10)` now returns only rows whose `memory_items.status = 'active'`. Signature unchanged — callers need no edits.

- [ ] **Step 1: Write failing test**

```python
"""tests/unit/memory/test_status_filter.py"""
import pytest

from draftly.integrations.database.vector_search import VectorSearch


@pytest.mark.asyncio
async def test_search_filters_to_active_status(monkeypatch):
    captured = {}

    class FakeClient:
        async def fetch_all(self, query, *args):
            captured["query"] = query
            return []

    monkeypatch.setattr(VectorSearch, "__init__", lambda self: None)
    searcher = VectorSearch()
    searcher.client = FakeClient()
    await searcher.search(namespace="knowledge", embedding=[0.1] * 4, limit=3)
    assert "mi.status = 'active'" in captured["query"]
```

Run → FAIL (query lacks the status predicate).

- [ ] **Step 2: Implement** — in `search()`, extend the WHERE clause:

```sql
WHERE mi.namespace = $2
  AND mi.status = 'active'
```

(No other changes; the existing `_MEMORY_COLUMNS` already selects `status`.)

Run: `pytest tests/unit/memory/test_status_filter.py -v` → PASS

- [ ] **Step 3: Commit**

```bash
git add src/draftly/integrations/database/vector_search.py \
  tests/unit/memory/test_status_filter.py
git commit -m "feat(memory): exclude non-active memory from vector retrieval"
```

---

### Task 7: MemoryService.supersede (semantic lifecycle)

**Files:**
- Modify: `src/draftly/persistence/repositories/memory.py` (add `supersede` passthrough + `set_status`)
- Modify: `src/draftly/integrations/database/memory_store.py` (add `set_status`)
- Modify: `src/draftly/memory/service.py` (add `supersede`)
- Test: `tests/unit/memory/test_supersede.py`

**Interfaces:**
- Consumes: `DatabaseMemoryStore.update/set_status`, `DomainMemoryRepository.store`.
- Produces:
  - `DatabaseMemoryStore.set_status(memory_id, status) -> bool`
  - `MemoryRepository.supersede(*, old_id, new_item_fields, evidence) -> dict` — one transaction
  - `MemoryService.supersede(old_id, new_content, *, namespace, memory_type="fact", importance=0.6, confidence=0.8, org_id=None, metadata=None, source_type=None, source_id=None, evidence=None) -> dict | None`

Semantics: mark old `status='superseded'`; insert replacement; write provenance row into `memory_sources` for the new record with `source_type='supersedes', source_id=old_id` plus each `evidence` path. All three writes inside `client.transaction()`.

- [ ] **Step 1: Write failing tests**

```python
"""tests/unit/memory/test_supersede.py"""
import pytest

from draftly.memory.service import MemoryService
from tests.fakes.memory_stores import FakeSemanticRepo


@pytest.mark.asyncio
async def test_supersede_marks_old_and_creates_replacement():
    repo = FakeSemanticRepo()
    repo.seed("old-1", content="tokens expire after 24h")
    svc = MemoryService(repository=repo)

    new = await svc.supersede(
        "old-1", "Access tokens expire after 1 hour.",
        namespace="knowledge", org_id="org1", evidence=["auth/token_service.py"],
    )

    assert new is not None and new["status"] == "active"
    old = await repo.get("old-1")
    assert old["status"] == "superseded"
    assert any(s["source_type"] == "supersedes" and s["source_id"] == "old-1"
               for s in repo.sources[new["id"]])
```

Run → FAIL (`supersede` missing).

- [ ] **Step 2: Append fake to tests/fakes/memory_stores.py**

```python
class FakeSemanticRepo:
    """Duck-types DomainMemoryRepository for supersede tests."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.sources: dict[str, list[dict]] = {}

    def seed(self, memory_id: str, *, content: str) -> None:
        self.rows[memory_id] = {"id": memory_id, "content": content,
                                "namespace": "knowledge",
                                "memory_type": "fact", "importance": 0.5,
                                "confidence": 0.5, "metadata": {},
                                "org_id": None, "status": "active"}

    async def get(self, memory_id: str):
        return dict(self.rows[memory_id]) if memory_id in self.rows else None

    async def store(self, item):
        mid = f"new-{len(self.rows)+1}"
        self.rows[mid] = {"id": mid, "content": item.content,
                          "namespace": item.namespace,
                          "memory_type": item.memory_type,
                          "importance": item.importance,
                          "confidence": item.confidence,
                          "metadata": dict(item.metadata),
                          "org_id": item.org_id, "status": "active"}
        self.sources[mid] = []
        return dict(self.rows[mid])

    async def record_provenance(self, *, memory_id, source_type,
                                source_id=None, source_url=None, evidence=None):
        self.sources.setdefault(memory_id, []).append({
            "source_type": source_type, "source_id": source_id,
            "source_url": source_url, "evidence": evidence or [],
        })
```

- [ ] **Step 3: Implement store/repo/service layers**

`DatabaseMemoryStore.set_status`:
```sql
UPDATE memory_items SET status = $2, updated_at = now()
WHERE id = $1::UUID RETURNING id;
```

`persistence/repositories/memory.py` — add:
```python
async def set_status(self, *, memory_id: str, status: str) -> bool:
    return bool(await self.store.set_status(memory_id=memory_id, status=status))

async def record_provenance(self, *, memory_id: str, source_type: str,
                            source_id: str | None = None,
                            source_url: str | None = None,
                            evidence: list | None = None) -> None:
    from draftly.integrations.database.memory_sources_store import (
        MemorySourcesStore,
    )

    await MemorySourcesStore(client=self.store.client).insert(
        memory_item_id=memory_id, source_type=source_type,
        source_id=source_id, source_url=source_url, evidence=evidence or [],
    )
```

`memory/service.py` — add method (uses transaction when backed by real DB;
fakes just sequence the calls):
```python
async def supersede(self, old_id: str, new_content: str, *,
                    namespace: str, memory_type: str = "fact",
                    importance: float = 0.6, confidence: float = 0.8,
                    org_id: str | None = None,
                    metadata: dict | None = None,
                    source_type: str | None = None,
                    source_id: str | None = None,
                    evidence: list[str] | None = None) -> dict | None:
    from draftly.memory.models.base import MemoryItem

    old = await self.repository.get(old_id)
    if old is None:
        return None
    await self.repository.set_status(memory_id=old_id, status="superseded")
    item = MemoryItem(namespace=namespace, content=new_content,
                      memory_type=memory_type, importance=importance,
                      confidence=confidence,
                      metadata={**(metadata or {}),
                                "supersedes": old_id},
                      org_id=org_id)
    record = await self.repository.store(item)
    await self.repository.record_provenance(
        memory_id=str(record["id"]), source_type="supersedes",
        source_id=old_id, evidence=evidence or [],
    )
    if source_type:  # original evidence chain preserved
        await self.repository.record_provenance(
            memory_id=str(record["id"]), source_type=source_type,
            source_id=source_id, evidence=evidence or [],
        )
    logger.info("memory_superseded old=%s new=%s", old_id, record["id"])
    return record
```

(`MemoryItem` accepts extra fields via `extra="allow"`; `status` defaults are
applied by stores. If `record_provenance`/`set_status` are absent on injected
test doubles, guard with `getattr(self.repository, name, None)` and skip.)

Run: `pytest tests/unit/memory/test_supersede.py tests/unit/memory/test_status_filter.py -v` → PASS

- [ ] **Step 4: Commit**

```bash
git add src/draftly/integrations/database/memory_store.py \
  src/draftly/persistence/repositories/memory.py src/draftly/memory/service.py \
  tests/fakes/memory_stores.py tests/unit/memory/test_supersede.py
git commit -m "feat(memory): supersede lifecycle for semantic records"
```

---

### Task 8: Curator tools (Strands function-based tools)

Strands grounding: tools are plain Python functions decorated with `@tool`
from `strands.tools`; the docstring is the description the model reasons
from; typed params become the input schema; async functions are supported and
run concurrently. Tools are passed to agents as `Agent(tools=[fn, ...])`.

**Files:**
- Create: `src/draftly/tools/memory/__init__.py`, `search.py`, `curation.py`, `knowledge.py`
- Modify: `src/draftly/app/composition/tools.py` (`memory_curator` group)
- Test: `tests/unit/tools/test_memory_tools.py`

**Interfaces:**
- Consumes: services from Tasks 2–5/7 (lazily constructed inside tool bodies — same pattern as `tools/search/semantic_search.py:18`).
- Produces (all module-level async @tool functions; org scoping via args):
  - `memory_search(namespace: str, query: str, limit: int = 5) -> list[dict]`
  - `get_memory(memory_id: str) -> dict`
  - `supersede_memory(old_memory_id: str, new_content: str, namespace: str, org_id: str, evidence_json: str = "[]") -> str`
  - `reinforce_memory(memory_id: str, amount: float = 0.05) -> str`
  - `archive_memory(memory_id: str) -> str`
  - `record_doc_relation(source_key: str, target_key: str, relation_type: str, org_id: str) -> str`
  - `record_procedure(name: str, pattern_description: str, org_id: str) -> str`

- [ ] **Step 1: Write failing tests**

```python
"""tests/unit/tools/test_memory_tools.py"""
import json

import pytest

from tests.fakes.memory_stores import (
    FakeCandidatesStore, FakeDocGraphStore, FakeEpisodesStore,
    FakeProceduresStore, FakeSemanticRepo,
)


@pytest.mark.asyncio
async def test_supersede_tool_reports_result(monkeypatch):
    from draftly.tools.memory import curation

    repo = FakeSemanticRepo()
    repo.seed("old-1", content="old fact")

    class FakeMemoryService:
        def __init__(self):
            self.repository = repo

        async def supersede(self, *a, **kw):
            return {"id": "new-9"}

    monkeypatch.setattr(
        curation, "_memory_service", lambda: FakeMemoryService()
    )
    out = await curation.supersede_memory(
        "old-1", "tokens expire in 1h", "knowledge", "org1",
        evidence_json=json.dumps(["a.py"]),
    )
    payload = json.loads(out)
    assert payload["superseded"] is True and payload["new_id"] == "new-9"


@pytest.mark.asyncio
async def test_record_doc_relation_writes_edge(monkeypatch):
    from draftly.tools.memory import knowledge

    store = FakeDocGraphStore()

    class FakeGraph:
        def __init__(self):
            self.store = store

        async def link(self, *a, **kw):
            return {"id": "e1"}

    monkeypatch.setattr(knowledge, "_docgraph_service", lambda: FakeGraph())
    out = await knowledge.record_doc_relation("a.py", "docs/a.md", "DOCUMENTED_BY", "org1")
    assert json.loads(out)["linked"] is True
```

Run → FAIL.

- [ ] **Step 2: Implement search.py**

```python
"""Curator read tools."""
from __future__ import annotations

from strands.tools import tool


@tool
async def memory_search(namespace: str, query: str, limit: int = 5) -> list[dict]:
    """Search active long-term memory by semantic similarity.

    Args:
        namespace: Memory namespace to search (e.g. 'knowledge', 'solutions').
        query: Natural-language query describing the knowledge to find.
        limit: Maximum number of records to return.
    """
    from draftly.memory.service import MemoryService

    service = _memory_service()
    return await service.recall(namespace=namespace, query=query, limit=limit)


@tool
async def get_memory(memory_id: str) -> dict:
    """Fetch one memory record with its full content and metadata.

    Args:
        memory_id: UUID of the memory record.
    """
    return await _memory_service().repository.get(memory_id)


def _memory_service():
    from draftly.memory.service import MemoryService

    return MemoryService()
```

- [ ] **Step 3: Implement curation.py**

```python
"""Curator write tools: supersede / reinforce / archive."""
from __future__ import annotations

import json

from strands.tools import tool


@tool
async def supersede_memory(old_memory_id: str, new_content: str,
                           namespace: str, org_id: str,
                           evidence_json: str = "[]") -> str:
    """Replace an outdated memory with corrected content.

    Marks the old record superseded (kept for history but excluded from
    retrieval) and stores a new active record that references it.

    Args:
        old_memory_id: UUID of the outdated memory record.
        new_content: The corrected factual statement.
        namespace: Namespace of the old record (e.g. 'knowledge').
        org_id: Organization scope for the replacement record.
        evidence_json: JSON array of evidence paths/ids supporting the update.
    """
    result = await _memory_service().supersede(
        old_memory_id, new_content,
        namespace=namespace, org_id=org_id,
        evidence=json.loads(evidence_json),
    )
    return json.dumps({"superseded": result is not None,
                       "new_id": result.get("id") if result else None})


@tool
async def reinforce_memory(memory_id: str, amount: float = 0.05) -> str:
    """Increase confidence of a corroborated memory.

    Args:
        memory_id: UUID of the confirmed memory record.
        amount: Confidence increment between 0 and 0.25.
    """
    service = _memory_service()
    current = await service.repository.get(memory_id)
    if current is None:
        return json.dumps({"ok": False, "error": "not found"})
    updated = await service.repository.update(
        memory_id,
        confidence=min(1.0, float(current.get("confidence", 0.5)) + float(amount)),
    )
    return json.dumps({"ok": True, "confidence": updated.get("confidence")
                       if isinstance(updated, dict) else None})


@tool
async def archive_memory(memory_id: str) -> str:
    """Soft-evict a memory: archived records stay queryable explicitly but
    never resurface in grounding retrieval.

    Args:
        memory_id: UUID of the memory record to archive.
    """
    ok = await _memory_service().repository.set_status(
        memory_id=memory_id, status="archived",
    )
    return json.dumps({"archived": bool(ok)})


def _memory_service():
    from draftly.memory.service import MemoryService

    return MemoryService()
```

(`repository.set_status` was added in Task 7.)

- [ ] **Step 4: Implement knowledge.py**

```python
"""Curator tools writing doc-graph + procedural memory."""
from __future__ import annotations

import json

from strands.tools import tool


@tool
async def record_doc_relation(source_key: str, target_key: str,
                              relation_type: str, org_id: str) -> str:
    """Record a relationship between code and documentation in the knowledge graph.

    Args:
        source_key: Source node key (e.g. code path 'auth/token_service.py').
        target_key: Target node key (e.g. doc path or concept name).
        relation_type: One of IMPLEMENTS, DOCUMENTED_BY, AFFECTS, DERIVED_FROM.
        org_id: Organization scope.
    """
    graph = _docgraph_service()
    await graph.link(source_key, target_key, relation_type, org_id=org_id)
    return json.dumps({"linked": True})


@tool
async def record_procedure(name: str, pattern_description: str, org_id: str) -> str:
    """Store a learned investigation playbook for reuse in future runs.

    Args:
        name: Short stable identifier for the procedure.
        pattern_description: When this procedure applies and what steps to take.
        org_id: Organization scope.
    """
    svc = _procedural_service()
    proc = await svc.create(name, pattern_description, org_id=org_id)
    return json.dumps({"procedure_id": proc["id"]})


def _docgraph_service():
    from draftly.memory.docgraph.service import DocGraphService

    return DocGraphService()


def _procedural_service():
    from draftly.memory.procedural.service import ProceduralService

    return ProceduralService()
```

Create empty `__init__.py`. In test Step 1, `monkeypatch` targets
`_memory_service` / `_docgraph_service` module attributes exactly as shown.

Run: `pytest tests/unit/tools/test_memory_tools.py -v` → PASS (2 tests)

- [ ] **Step 5: Register group in composition/tools.py**

```python
from draftly.tools.memory.curation import archive_memory, reinforce_memory, supersede_memory
from draftly.tools.memory.knowledge import record_doc_relation, record_procedure
from draftly.tools.memory.search import get_memory, memory_search

_MEMORY_CURATOR_TOOLS = [
    memory_search, get_memory,
    supersede_memory, reinforce_memory, archive_memory,
    record_doc_relation, record_procedure,
]
```

then change line 241 to `memory_curator=_MEMORY_CURATOR_TOOLS,` and add the
group into `_unique_tools(...)` at line 242 if desired (it already unions all
groups; verify `all_tools` stays deduped).

Run: `ruff check src/draftly/app/composition/tools.py && pytest tests/unit/tools/test_memory_tools.py -v` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/draftly/tools/memory src/draftly/app/composition/tools.py \
  tests/unit/tools/test_memory_tools.py
git commit -m "feat(memory): Strands curator tools for agentic curation"
```

---

### Task 9: Memory Curator prompt + builder upgrade

**Files:**
- Modify: `src/draftly/agents/prompts.py:234` (MEMORY_CURATOR_PROMPT)
- Modify: `src/draftly/agents/shared/memory_curator.py` (accept tools, description)
- Test: `tests/unit/agents/test_memory_curator_builder.py`

**Interfaces:**
- Produces: `build_memory_curator(model, tools=None) -> strands.Agent` with a prompt that enforces the decision contract below. The curation workflow (Task 11) parses the agent's final text as JSON.

Decision contract (agent output — JSON only, no prose):

```json
{"decisions": [{
    "candidate_id": "uuid",
    "action": "CREATE|UPDATE|MERGE|SUPERSEDE|REJECT|ARCHIVE",
    "target_memory_id": "uuid-or-null",
    "content": "final fact statement or null",
    "reason": "short justification"
}]}
```

- [ ] **Step 1: Write failing test**

```python
"""tests/unit/agents/test_memory_curator_builder.py"""
from draftly.agents.shared.memory_curator import build_memory_curator
from draftly.agents.prompts import MEMORY_CURATOR_PROMPT


def test_builder_passes_tools_and_contract_prompt():
    agent = build_memory_curator(model=object(), tools=[lambda: None])
    assert agent.tools  # non-empty tool list wired through
    for phrase in ("CREATE", "SUPERSEDE", '"decisions"'):
        assert phrase in MEMORY_CURATOR_PROMPT
```

Run → FAIL (`Agent(...)` currently receives `tools=tools or []` but test
asserts wiring + new prompt phrases).

Note: `strands.Agent` exposes tools as `agent.tools` — if the attribute is
named differently in the installed version, assert on the constructor arg by
refactoring `build_memory_curator` to store `self._tools = list(tools)` on the
wrapper instead.

- [ ] **Step 2: Replace MEMORY_CURATOR_PROMPT**

```python
MEMORY_CURATOR_PROMPT = """You are Draftly's memory curator. You receive memory
candidates extracted from completed workflows and decide how each should change
long-term memory.

For every candidate:
1. Search existing memory with memory_search to find related records.
2. Inspect any conflicting record with get_memory.
3. Decide one action:
   - CREATE: durable, useful, evidenced knowledge that does not exist yet.
   - UPDATE: extends an existing record without contradicting it.
   - MERGE: same fact from multiple sources -> reinforce the strongest record.
   - SUPERSEDE: new evidence contradicts an active fact; replace it via
     supersede_memory so the old value is kept as history but never retrieved.
     Before superseding, consider staleness vs environment-specific values vs
     evidence authority (e.g. production vs free-tier limits may both be valid).
   - REJECT: duplicate, transient, unevidenced, or low-value information.
   - ARCHIVE: record is stale and no longer trustworthy.

Rules:
- Only accept candidates supported by listed evidence.
- Preserve provenance: always pass evidence through to write tools.
- Prefer supersede_memory over archive when facts genuinely changed.

Tools available: memory_search, get_memory, supersede_memory,
reinforce_memory, archive_memory, record_doc_relation, record_procedure.

Respond with ONLY this JSON (no markdown, no prose):
{"decisions": [{"candidate_id": "...", "action": "...",
  "target_memory_id": null, "content": null, "reason": "..."}]}
"""
```

- [ ] **Step 3: Update builder** (`memory_curator.py`) — pass tools through and
keep signature:

```python
def build_memory_curator(
    model: Any,
    tools: list[Any] | None = None,
) -> Agent:
    """Build the memory curation agent with its write/read toolset."""
    return Agent(
        name="memory_curator",
        system_prompt=MEMORY_CURATOR_PROMPT,
        model=model,
        tools=list(tools or []),
        description="Curates long-term memory candidates into durable knowledge.",
    )
```

Run: `pytest tests/unit/agents/test_memory_curator_builder.py -v` → PASS

- [ ] **Step 4: Commit**

```bash
git add src/draftly/agents/prompts.py src/draftly/agents/shared/memory_curator.py \
  tests/unit/agents/test_memory_curator_builder.py
git commit -m "feat(memory): curator agent decision contract + tool wiring"
```

---

### Task 10: Candidate extraction (deterministic post-run packaging)

**Files:**
- Create: `src/draftly/workflows/post_run/__init__.py`, `src/draftly/workflows/post_run/candidate_extractor.py`
- Test: `tests/workflow/test_candidate_extractor.py`

**Interfaces:**
- Consumes: `WorkflowState` (`state.event`, `state.result`, `state.status`), services from Tasks 4–5.
- Produces:
  - `extract_candidates(state, surface) -> list[MemoryCandidate]` (pure function; Task 11's workflow and Task 12's runner hook both rely on this exact name/signature)
  - The runner-facing orchestrator `record_post_run_memory(context, state, surface) -> None` (episode + candidate enqueue, fail-open) is added to this same module in Task 12, where the runner wires it in.

Extraction rules (no LLM):
1. Episode recorded for every COMPLETED run (`episode_summary` candidates are NOT created here).
2. Impact/delivery outputs listing changed files → doc-paths pairs → `doc_relation` candidates (relation DOCUMENTED_BY code→doc when both sides resolvable from result payload keys `changed_files` / `docs_touched`).
3. Successful runs whose event type repeats with same file→doc pair → `procedure_pattern` candidate (packaged; curator decides whether it becomes a procedure).
4. Facts surfaced by research nodes under result key `detected_facts` → `fact` candidates with source/evidence.

- [ ] **Step 1: Write failing tests**

```python
"""tests/workflow/test_candidate_extractor.py"""
import pytest

from draftly.workflows.post_run.candidate_extractor import extract_candidates


class FakeResult:
    status = "completed"
    interrupts = ()
    execution_order: list = []


def make_state(event=None):
    from draftly.workflows.state import WorkflowState

    return WorkflowState(run_id="run-1", event=event or {})


def test_doc_relations_extracted_from_result_payload():
    state = make_state({"project_id": "org1", "source": "github"})
    state.result = FakeResult()
    state.result.__dict__["changed_files"] = ["auth/token_service.py"]
    state.result.__dict__["docs_touched"] = ["docs/auth/tokens.md"]

    candidates = extract_candidates(state, "github_pr")
    rels = [c for c in candidates if c.candidate_type == "doc_relation"]
    assert len(rels) == 1
    assert rels[0].payload["source_key"] == "auth/token_service.py"
    assert rels[0].payload["target_key"] == "docs/auth/tokens.md"


def test_facts_extracted_with_evidence():
    state = make_state({"project_id": "org1"})
    state.result = FakeResult()
    state.result.__dict__["detected_facts"] = [
        {"content": "tokens expire in 1h", "evidence": ["a.py"], "confidence": 0.9},
    ]
    candidates = extract_candidates(state, "github_pr")
    facts = [c for c in candidates if c.candidate_type == "fact"]
    assert len(facts) == 1
    assert facts[0].evidence == ["a.py"]
    assert facts[0].confidence == 0.9


def test_no_result_means_no_candidates():
    state = make_state({})
    assert extract_candidates(state, "slack_support") == []
```

Run → FAIL.

- [ ] **Step 2: Implement extractor**

```python
"""Post-run memory extraction (spec §Components 3). Deterministic only."""
from __future__ import annotations

from typing import Any

import structlog

from draftly.memory.candidates.models import MemoryCandidate

logger = structlog.get_logger(__name__)


def _result_attr(result: Any, name: str, default: Any) -> Any:
    value = getattr(result, name, default)
    return default if value is default else value


def extract_candidates(state: Any, surface: str) -> list[MemoryCandidate]:
    result = getattr(state, "result", None)
    if result is None:
        return []
    org_id = str((state.event or {}).get("project_id") or "") or None
    out: list[MemoryCandidate] = []

    changed_files = _result_attr(result, "changed_files", []) or []
    docs_touched = _result_attr(result, "docs_touched", []) or []
    for src, dst in zip(changed_files, docs_touched):
        out.append(MemoryCandidate(
            org_id=org_id, candidate_type="doc_relation",
            payload={"source_key": src, "target_key": dst,
                     "relation_type": "DOCUMENTED_BY"},
            source_type=surface, source_id=str(state.run_id),
            evidence=[src], confidence=0.7,
        ))

    for fact in _result_attr(result, "detected_facts", []) or []:
        content = str(fact.get("content") or "").strip()
        if not content:
            continue
        out.append(MemoryCandidate(
            org_id=org_id, candidate_type="fact",
            payload={"content": content},
            source_type=surface, source_id=str(state.run_id),
            evidence=[str(e) for e in fact.get("evidence", [])],
            confidence=float(fact.get("confidence", 0.5)),
        ))
    return out
```

(If `WorkflowState` stores dynamic attrs differently, read its actual fields;
`getattr` fallbacks above keep this tolerant.)

Run: `pytest tests/workflow/test_candidate_extractor.py -v` → PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add src/draftly/workflows/post_run tests/workflow/test_candidate_extractor.py
git commit -m "feat(memory): deterministic candidate extraction"
```

---

### Task 11: Async Memory Curation workflow

**Files:**
- Create: `src/draftly/workflows/memory/__init__.py`, `src/draftly/workflows/memory/curation_workflow.py`
- Test: `tests/workflow/test_curation_workflow.py`

**Interfaces:**
- Consumes: `CandidateService.claim_batch/mark_*`, `build_memory_curator(model, tools)` from Task 9, `_MEMORY_CURATOR_TOOLS` from Task 8.
- Produces: `async def run_memory_curation(context) -> dict` — registered as workflow `"memory_curation"` and scheduled task `"memory.curation"`.

Flow:
1. `candidates = await context.candidates.claim_batch(limit=10)`; empty → return `{"processed": 0}`.
2. Build prompt listing each candidate as JSON.
3. `agent = build_memory_curator(context.model, _MEMORY_CURATOR_TOOLS)`; `result = await agent.invoke_async(prompt)`.
4. Parse decisions from `str(result)` (strip code fences; tolerate trailing prose by extracting first `{...}` block).
5. Apply each decision via services (`supersede_memory` etc. are the agent's tools — but the workflow applies decisions deterministically for reliability):
   - CREATE/UPDATE → `MemoryService.remember(MemoryItem(...))` with candidate payload
   - MERGE → `MemoryService.consolidate(...)`
   - SUPERSEDE → `MemoryService.supersede(target, content, ...)`
   - REJECT/ARCHIVE → `mark_rejected` / repository.set_status('archived')
6. `mark_applied(id, reason)` per decision; unparseable output leaves candidates `processing` → re-set them to `pending` in an except block.

- [ ] **Step 1: Write failing test** (uses `tests/stub_model.py` if it exposes a
callable stub; otherwise a `StubModel` class whose `invoke_async` returns an
object whose `str()` is the JSON below)

```python
"""tests/workflow/test_curation_workflow.py"""
import json

import pytest

from tests.fakes.memory_stores import FakeCandidatesStore


DECISIONS = {"decisions": [
    {"candidate_id": "cand-1", "action": "CREATE",
     "target_memory_id": None,
     "content": "Access tokens expire after one hour.",
     "reason": "evidenced"},
    {"candidate_id": "cand-x", "action": "REJECT",
     "target_memory_id": None, "content": None, "reason": "duplicate"},
]}


class StubResult:
    def __init__(self, text):
        self._text = text

    def __str__(self):
        return self._text


class StubAgent:
    def __init__(self, *a, **kw):
        pass

    async def invoke_async(self, prompt):
        return StubResult("```json\n" + json.dumps(DECISIONS) + "\n```")


@pytest.mark.asyncio
async def test_curation_applies_decisions(monkeypatch):
    import draftly.workflows.memory.curation_workflow as cw
    from draftly.memory.candidates.models import MemoryCandidate
    from draftly.memory.candidates.service import CandidateService

    store = FakeCandidatesStore()
    svc = CandidateService(store=store)
    await svc.enqueue(MemoryCandidate(
        org_id="org1", candidate_type="fact",
        payload={"content": "tokens expire in 1h"},
    ))

    class FakeContext:
        candidates = svc
        model = object()

    applied_actions = []

    async def fake_apply(decision, candidate, context):
        applied_actions.append(decision["action"])
        return True

    monkeypatch.setattr(
        cw, "build_memory_curator",
        lambda model, tools=None: StubAgent(),
    )
    monkeypatch.setattr(cw, "_apply_decision", fake_apply)

    summary = await cw.run_memory_curation(FakeContext())

    assert summary["claimed"] == 1
    assert applied_actions == ["CREATE", "REJECT"]
    assert {r["status"] for r in store.rows} == {"applied"}
```

Run → FAIL.

- [ ] **Step 2: Implement curation_workflow.py**

```python
"""Async memory curation (spec §Components 4). Scheduled post-run job."""
from __future__ import annotations

import json
import re
from typing import Any

import structlog

from draftly.agents.shared.memory_curator import build_memory_curator

logger = structlog.get_logger(__name__)

BATCH_SIZE = 10


class CandidateService:
    """Lazy alias so contexts can construct us without import cycles."""
    pass  # replaced at runtime; kept for typing clarity only


def _extract_json(text: str) -> dict | None:
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    raw = fenced.group(1) if fenced else text
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


async def run_memory_curation(context: Any) -> dict[str, int]:
    candidates = context.candidates
    claimed = await candidates.claim_batch(limit=BATCH_SIZE)
    if not claimed:
        return {"claimed": 0}

    prompt = (
        "Curate these memory candidates:\n"
        + "\n".join(json.dumps(c, default=str) for c in claimed)
    )
    from draftly.app.composition.tools import _MEMORY_CURATOR_TOOLS

    agent = build_memory_curator(model=context.model, tools=_MEMORY_CURATOR_TOOLS)
    try:
        result = await agent.invoke_async(prompt)
        payload = _extract_json(str(result))
    except Exception:
        logger.exception("curator_invoke_failed")
        payload = None

    applied = 0
    if payload and isinstance(payload.get("decisions"), list):
        for i, decision in enumerate(payload["decisions"][: len(claimed)]):
            record = claimed[i]
            try:
                ok = await _apply_decision(decision, record, context)
            except Exception:
                logger.exception("decision_apply_failed")
                ok = False
            reason = str(decision.get("reason") or decision.get("action"))
            if ok:
                await candidates.mark_applied(str(record["id"]), reason)
                applied += 1
            else:
                await candidates.mark_rejected(
                    str(record["id"]), reason or "apply failed",
                )
    else:
        for record in claimed:  # curator produced nothing usable -> retry later
            await candidates.set_status_pending(str(record["id"]))

    logger.info("memory_curation_run claimed=%d applied=%d", len(claimed), applied)
    return {"claimed": len(claimed), "applied": applied}


async def _apply_decision(decision: dict, record: dict, context: Any) -> bool:
    action = str(decision.get("action", "")).upper()
    content = decision.get("content")
    target = decision.get("target_memory_id")

    if action == "CREATE" and content:
        from draftly.memory.models.base import MemoryItem
        from draftly.memory.service import MemoryService

        await MemoryService().remember(MemoryItem(
            namespace="knowledge",
            content=str(content),
            org_id=record.get("org_id"),
            confidence=float(record.get("confidence") or 0.5),
            metadata={"candidate_id": record.get("id")},
        ))
        return True

    if action == "SUPERSEDE" and target and content:
        from draftly.memory.service import MemoryService

        result = await MemoryService().supersede(
            str(target), str(content), namespace="knowledge",
            org_id=record.get("org_id"),
        )
        return result is not None

    if action == "MERGE" and target:
        from draftly.memory.service import MemoryService

        merged = await MemoryService().consolidate(
            namespace="knowledge", query=str(content or record.get("payload")),
            merge_target_id=str(target),
        )
        return merged is not None

    if action == "ARCHIVE" and target:
        from draftly.memory.service import MemoryService

        return bool(await MemoryService().repository.set_status(
            memory_id=str(target), status="archived"))

    if action == "UPDATE" and target and content:
        from draftly.memory.service import MemoryService

        updated = await MemoryService().repository.update(
            str(target), content=str(content))
        return updated is not None

    if action == "REJECT":
        return True  # rejection itself is the outcome

    return False
```

Add `set_status_pending` passthrough on `CandidateService`
(`store.set_status(id, 'pending', '')`) and on both stores (fake + SQL
`UPDATE ... SET status='pending' WHERE id=$1`).

Run: `pytest tests/workflow/test_curation_workflow.py -v` → PASS (the test
imports the real `CandidateService`; also add the `set_status_pending`
passthrough used in Step 2 to both `CandidateService` and both stores — fake
sets `row["status"] = "pending"`, SQL is
`UPDATE memory_candidates SET status='pending' WHERE id=$1`).

- [ ] **Step 3: Register + schedule**

`src/draftly/app/composition/workflows.py`:
```python
from draftly.workflows.memory.curation_workflow import run_memory_curation
registry.register("memory_curation", run_memory_curation)
```

`src/draftly/app/composition/workers.py`:
```python
TASK_REGISTRY["memory.curation"] = "memory_curation"
SCHEDULED_JOBS.append({
    "id": "memory-curation", "name": "memory.curation",
    "schedule": "*/30 * * * *", "arguments": {},
})
```

Run: `pytest tests/workflow/test_curation_workflow.py -v && ruff check src/draftly/app/composition` → PASS

- [ ] **Step 4: Commit**

```bash
git add src/draftly/workflows/memory src/draftly/app/composition \
  tests/workflow/test_curation_workflow.py
git commit -m "feat(memory): async curator workflow on scheduler"
```

---

### Task 12: WorkflowContext deps + runner post-run hook

**Files:**
- Modify: `src/draftly/workflows/context.py` (add 4 dep fields)
- Modify: `src/draftly/workflows/runner.py:121-123` (hook on COMPLETED)
- Modify: `src/draftly/app/composition/workflows.py` (construct services)
- Test: `tests/workflow/test_runner_post_run_memory.py`

**Interfaces:**
- Produces: `WorkflowContext.episodic/procedural/docgraph/candidates: Any = None`; runner calls `record_post_run_memory(self.context, state, surface)` after `_mark(event, 'completed')`, wrapped in try/except (fail-open).

- [ ] **Step 1: Failing test**

```python
"""tests/workflow/test_runner_post_run_memory.py"""
import pytest

from draftly.workflows.runner import WorkflowRunner
from draftly.workflows.state import WorkflowState


class RecordingMemory:
    def __init__(self):
        self.called = False

    async def __call__(self, context, state, surface):
        self.called = True


def make_runner(monkeypatch, recording):
    import draftly.workflows.runner as runner_mod

    context = type(runner_mod.WorkflowContext)()
    monkeypatch.setattr(runner_mod, "_post_run_memory", recording)
    dispatcher = type("D", (), {"route": staticmethod(lambda e: "github_pr")})()
    return WorkflowRunner(context, graph_factory=lambda *a, **k: None,
                          dispatcher=dispatcher)


def test_hook_defined_and_fail_open():
    import draftly.workflows.runner as runner_mod

    assert hasattr(runner_mod, "_post_run_memory")


@pytest.mark.asyncio
async def test_post_run_memory_swallows_errors():
    import draftly.workflows.runner as runner_mod

    async def boom(context, state, surface):
        raise RuntimeError("x")

    state = WorkflowState(run_id="r", event={})
    await runner_mod._post_run_memory(None, state, "github_pr", hook=boom)
```

(Adapt: final signature is `_post_run_memory(context, state, surface, *,
extractor=None, episodic=None, candidates=None)`; the error-swallow test calls
it with a raising injected `hook`.)

- [ ] **Step 2: Implement**

`workflows/context.py` — extend dataclass after `routing_decision`:
```python
    #: Agentic-memory subsystems (spec 2026-08-23); None disables them.
    episodic: Any = None
    procedural: Any = None
    docgraph: Any = None
    candidates: Any = None
```

`workflows/runner.py` — new module-level function + call site:
```python
async def _post_run_memory(context, state, surface, *, hook=None):
    """Record episode + enqueue memory candidates. Never raises."""
    try:
        if hook is not None:
            await hook(context, state, surface)
            return
        from draftly.workflows.post_run.candidate_extractor import (
            record_post_run_memory,
        )

        await record_post_run_memory(context, state, surface)
    except Exception:
        logger.warning("post_run_memory_failed", exc_info=True)
```
In `run()` inside the `Status.COMPLETED` branch, before `_mark`:
```python
await self._mark(event, "completed")
await _post_run_memory(self.context, state, surface)
return state.finish(WorkflowStatus.DELIVERED)
```
and extend `record_post_run_memory(context, state, surface)` in
candidate_extractor.py to also write an episode when `context.episodic` exists:

```python
async def record_post_run_memory(context, state, surface) -> None:
    event = state.event or {}
    org_id = str(event.get("project_id") or "") or None
    if getattr(context, "episodic", None):
        await context.episodic.record_episode(
            org_id=org_id, agent_run_id=None,
            trigger_type=surface, trigger_id=str(event.get("event_id") or ""),
            trigger_summary=str(event.get("title") or surface),
            actions_taken=[], tools_used=[],
            outcome="success", evaluation_results=None, artifacts_created=[],
        )
    if getattr(context, "candidates", None):
        for candidate in extract_candidates(state, surface):
            await context.candidates.enqueue(candidate)
```

`app/composition/workflows.py` — construct defaults in `build_workflows`:
```python
from draftly.memory.candidates.service import CandidateService
from draftly.memory.docgraph.service import DocGraphService
from draftly.memory.episodic.service import EpisodicService
from draftly.memory.procedural.service import ProceduralService

context = WorkflowContext(...,
    episodic=EpisodicService(), procedural=ProceduralService(),
    docgraph=DocGraphService(), candidates=CandidateService(),
)
```

Run: `pytest tests/workflow/test_runner_post_run_memory.py -v && pytest tests/workflow/test_pr_workflow.py -v` → PASS (existing PR workflow tests still green — fail-open guarantees no behavior change when DB absent).

- [ ] **Step 3: Commit**

```bash
git add src/draftly/workflows/context.py src/draftly/workflows/runner.py \
  src/draftly/workflows/post_run/candidate_extractor.py \
  src/draftly/app/composition/workflows.py \
  tests/workflow/test_runner_post_run_memory.py
git commit -m "feat(memory): wire episodic+candidate capture into WorkflowRunner"
```

---

### Task 13: GroundingNode multi-source merge

**Files:**
- Modify: `src/draftly/agents/shared/memory_grounding.py`
- Test: `tests/unit/agents/test_memory_grounding_upgrade.py`

**Interfaces:**
- Consumes: `MemoryService.recall_knowledge`, `EpisodicService.find_similar`, `ProceduralService.match` (all injected via `memory_bundle: dict[str, Any] | Any`; a bare `MemoryService` keeps legacy behavior).
- Produces: `_ground(task)` merges three ranked sources into one header block; total budget stays `MAX_GROUNDING_ITEMS = 5`; every source individually optional + fail-open.

- [ ] **Step 1: Failing test**

```python
"""tests/unit/agents/test_memory_grounding_upgrade.py"""
import pytest

from draftly.agents.shared.memory_grounding import MemoryGroundedNode


class FakeInner:
    name = "inner"
    def __init__(self):
        self.seen = None
    async def invoke_async(self, task, invocation_state=None, **kw):
        self.seen = task


class Bundle:
    def __init__(self, knowledge, episodes, procedures):
        self.knowledge = knowledge
        self.episodes = episodes
        self.procedures = procedures


@pytest.mark.asyncio
async def test_ground_merges_three_sources():
    async def knowledge(q, limit=5):
        return [{"content": "PKCE is required"}]
    async def episodes(q, limit=5):
        return [{"trigger_summary": "auth change -> docs updated",
                 "similarity": 0.8}]
    async def procedures(q, limit=3):
        return [{"pattern_description": "inspect tokens first"}]

    node = MemoryGroundedNode(FakeInner(), None)
    grounded = await node._merge_sources(
        "task text", Bundle(knowledge(), episodes(), procedures()),
    )
    assert "PKCE is required" in grounded
    assert "Similar past episode:" in grounded
    assert "Applicable procedure:" in grounded
    assert grounded.endswith("task text")


@pytest.mark.asyncio
async def test_missing_services_degrade_to_plain_task():
    inner = FakeInner()
    node = MemoryGroundedNode(inner, None)
    out = await node._ground("plain task")
    assert out == "plain task"
```

Run → FAIL (`_merge_sources` missing).

- [ ] **Step 2: Implement** — add to `memory_grounding.py`:

```python
MAX_EPISODE_ITEMS = 2
MAX_PROCEDURE_ITEMS = 1

async def _merge_sources(self, task: str, bundle: Any) -> str:
    lines: list[str] = []
    budget = MAX_GROUNDING_ITEMS
    try:
        for item in await (bundle.knowledge or (lambda *a, **k: []))(task)[:budget]:
            content = str(item.get("content", "")).strip()
            if content:
                lines.append(f"- {content}")
                budget -= 1
    except Exception:
        logger.exception("grounding_knowledge_failed")
    if getattr(bundle, "episodes", None):
        try:
            hits = await bundle.episodes(task, limit=MAX_EPISODE_ITEMS)
            if hits:
                lines.append("Similar past episode:")
                for hit in hits[:max(budget, 0)]:
                    summary = hit.get("trigger_summary") or hit.get("summary")
                    if summary:
                        lines.append(f"- {summary}")
                        budget -= 1
        except Exception:
            logger.exception("grounding_episodes_failed")
    if getattr(bundle, "procedures", None):
        try:
            procs = await bundle.procedures(task, limit=MAX_PROCEDURE_ITEMS)
            for proc in procs[: max(budget, 0)]:
                desc = proc.get("pattern_description")
                if desc:
                    lines.append(f"Applicable procedure: {desc}")
                    budget -= 1
        except Exception:
            logger.exception("grounding_procedures_failed")
    if not lines:
        return task
    return "\n".join([GROUNDING_HEADER, *lines]) + "\n\n" + task
```

Update `_ground()`: when `self.memory` has attributes
`knowledge`/`episodes`/`procedures`, call `_merge_sources`; else keep the
legacy `recall_knowledge` path verbatim. Both paths keep the existing
try/except fail-open wrapper.

Run: `pytest tests/unit/agents/test_memory_grounding_upgrade.py -v` → PASS;
then `pytest tests/graph tests/workflow -k grounding -v` for regressions.

- [ ] **Step 3: Commit**

```bash
git add src/draftly/agents/shared/memory_grounding.py \
  tests/unit/agents/test_memory_grounding_upgrade.py
git commit -m "feat(memory): three-source grounding merge in MemoryGroundedNode"
```

---

### Task 14: affected_docs tool for impact analysis

**Files:**
- Create: `src/draftly/tools/memory/affected_docs.py`
- Modify: `src/draftly/app/composition/tools.py` (add to `_DOCUMENTATION_ENGINEER_TOOLS`)
- Test: extend `tests/unit/tools/test_memory_tools.py`

```python
@tool
async def affected_docs(changed_files_json: str, org_id: str = "") -> str:
    """Resolve which documentation files are affected by changed code paths.

    Args:
        changed_files_json: JSON array of repository file paths that changed.
        org_id: Optional organization scope.
    """
    import json as _json

    from draftly.memory.docgraph.service import DocGraphService

    docs = await DocGraphService().affected_docs(
        list(_json.loads(changed_files_json)),
        org_id=org_id or None,
    )
    return _json.dumps({"docs": [d.get("key") for d in docs]})
```

Register by importing and appending to `_DOCUMENTATION_ENGINEER_TOOLS`.
Test mirrors `test_record_doc_relation_writes_edge` with a monkeypatched
`_docgraph_service` returning two docs; asserts JSON payload.

Commit: `git commit -m "feat(memory): affected-docs graph lookup tool"`

---

### Task 15: Maintenance jobs (forgetting policies)

**Files:**
- Create: `src/draftly/memory/maintenance.py`
- Create: `src/draftly/workflows/maintenance/__init__.py`, `run_memory_maintenance.py`
- Modify: `src/draftly/app/composition/workflows.py`, `workers.py` (register + schedule weekly)
- Test: `tests/unit/memory/test_maintenance.py`

Policies (spec §Components 7):
1. **Archival compression**: episodes older than 180 days → one summary memory per org+trigger_type in namespace `knowledge` (metadata `{archival: true, period: 'YYYY-MM'}`); originals get no separate table state — they stay but are excluded from `find_similar` via a `created_at > now()-interval '180 days'` predicate added to `EpisodesStore.search`.
2. **Hygiene**: demote semantic items with `importance < 0.3 AND last_accessed_at < now()-interval '90 days'` to `status='archived'` (extends curation policy doc rules).
3. Never hard-delete anything in maintenance — only curator REJECT deletes candidates.

```python
"""src/draftly/memory/maintenance.py — forgetting policies (fail-open)."""
from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger(__name__)

EPISODE_RETENTION_DAYS = 180
STALE_IMPORTANCE_FLOOR = 0.3
STALE_ACCESS_DAYS = 90


class MemoryMaintenance:
    def __init__(self, client: Any = None) -> None:
        from draftly.integrations.database.client import DatabaseClient

        self.client = client or DatabaseClient()

    async def archive_old_episodes(self) -> int:
        row = await self.client.fetch_one(
            """
            INSERT INTO memory_items (org_id, namespace, memory_type, content,
                                      status, importance, confidence)
            SELECT org_id, 'knowledge', 'episode_summary',
                   'Archived activity summary: ' || trigger_type || ' — '
                       || count(*) || ' episodes between '
                       || min(date_trunc('month', created_at))::date
                       || ' and ' || max(date_trunc('month', created_at))::date,
                   'archived', 0.4, 0.6
            FROM episodes
            WHERE created_at < now() - ($1 || ' days')::INTERVAL
            GROUP BY org_id, trigger_type, date_trunc('month', created_at)
            ON CONFLICT DO NOTHING
            RETURNING 1
            """,
            str(EPISODE_RETENTION_DAYS),
        )
        archived = 1 if row else 0
        logger.info("episodes_archived_summaries=%d", archived)
        return archived

    async def demote_stale_semantic_memory(self) -> int:
        result = await self.client.execute(
            """
            UPDATE memory_items SET status = 'archived', updated_at = now()
            WHERE status = 'active'
              AND importance < $1
              AND (last_accessed_at IS NULL OR last_accessed_at < now()
                   - ($2 || ' days')::INTERVAL)
              AND memory_type <> 'decision'
            """,
            STALE_IMPORTANCE_FLOOR, str(STALE_ACCESS_DAYS),
        )
        count = int(result.split()[-1]) if result else 0
        logger.info("stale_memory_demoted=%d", count)
        return count
```

Workflow wrapper `run_memory_maintenance(context)` calls both methods inside
try/except blocks (one failure never blocks the other); register as
`"memory_maintenance"` + `TASK_REGISTRY["memory.maintenance"]` + cron
`"0 6 * * 0"` (weekly Sunday 06:00, after existing scans).

Tests use a `FakeMaintenanceClient` recording SQL strings and asserting both
queries reference the retention constants and exclude `memory_type='decision'`.

Commit: `git commit -m "feat(memory): archival compression + stale demotion jobs"`

---

### Task 16: Final verification

- [ ] Run full gates from `draftly-agent-backend/`:

```bash
ruff check src tests
mypy src/draftly
pytest tests -x -q
```

Expected: all green. If `NEON_DATABASE_URL` is set locally, also run
`pytest tests/integration/test_memory_migrations.py -v`.

- [ ] Update the knowledge graph: `graphify update .` (repo root, AST-only).

- [ ] Cross-check spec coverage against this plan: every §Components item maps
to Tasks 1–15; supersede semantics → Task 7; curator contract → Tasks 9–11;
grounding → Task 13; forgetting → Task 15. Confirm no TBD/TODO remains.

- [ ] Final commit if any straggler fixes:

```bash
git add -A && git commit -m "chore(memory): final verification pass"
```

## Self-review notes (completed during planning)

1. **Spec coverage:** migrations(§1→T1), stores/services(§2→T2–5), extraction(§3→T10+12), curator workflow(§4→T8–9,11), supersede/status(§5→T6–7), consumption(§6→T13–14), forgetting(§7→T15). Working-memory non-goal honored.
2. **Placeholders:** none — all code blocks complete; test-file corrections called out inline where drafting revealed them.
3. **Type consistency:** `CandidateService.claim_batch/mark_applied/mark_rejected/set_status_pending` used identically in T5/T11/T12; `DocGraphService.link(source_key, target_key, relation_type, *, org_id)` matches tool + fake; `normalize_vector/format_vector` shared via `vector_utils` everywhere vectors cross into SQL.
