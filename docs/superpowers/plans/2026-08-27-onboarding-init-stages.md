# Onboarding Initialization — Full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 4 placeholder initialization stages (knowledge_construction, initial_evaluation, health_report, recommendations) and replace hardcoded stage definitions/progress animation with dynamic, backend-driven stage mapping via Redis Streams + SSE.

**Architecture:** Stage config is written to NeonDB at workspace creation time and returned via `GET /initialize/status` on page load. The backend runs 5 stages sequentially: repository_ingestion (existing), knowledge_construction (LLM extraction), initial_evaluation (heuristic scoring), health_report (weighted aggregation), recommendations (LLM generation). Each stage publishes `stage_change` and `stage_progress` SSE events. The frontend fetches `stage_config` from NeonDB for immediate rendering, parses SSE events for live updates, and renders a dynamic task list with backend-driven progress bars.

**Tech Stack:** Python 3.12 (asyncio, Pydantic, structlog), Next.js 15 (React, TypeScript, Tailwind CSS), Redis Streams (XADD/XREAD), NeonDB (PostgreSQL), existing MemoryService/DocGraphService/CandidateService/DocumentationAnalyzer

**Specs:**
- `docs/superpowers/specs/2026-08-27-onboarding-init-stages-design.md` — stage implementations
- `reference/redis-streams-sse.md` — Redis Streams + SSE architecture reference

## Global Constraints

- Python 3.12+, asyncio only (no threads)
- All stage functions must be `async` (memory/docgraph/candidate services are async)
- Use `structlog` for logging (existing pattern)
- Follow existing test patterns: `unittest.mock`, `pytest.mark.asyncio`
- Per-chunk timeout: 10s (knowledge_construction only)
- Maximum 500 document chunks processed per run
- Backend stream key pattern: `draftly:stream:{run_id}` (existing, unchanged)
- Stream retention: `maxlen=1000` with approximate trimming (existing)
- SSE auth: ticket-based via `RedisTicketStore` (existing, unchanged)
- Event envelope format: `StreamEnvelope` with `type`, `run_id`, `surface`, `seq`, `ts`, `payload` (existing)
- One new migration (`033_onboarding_stage_config.sql`) — `ALTER TABLE` adding `stage_config JSONB`
- No new REST endpoints — existing `GET /status` and `GET /initialize/status` return `stage_config`
- Follow existing code conventions (structlog, Pydantic models, Tailwind utility classes)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `draftly-agent-backend/src/draftly/persistence/migrations/033_onboarding_stage_config.sql` | Create | Add `stage_config JSONB` column to `onboarding_state` |
| `draftly-agent-backend/src/draftly/persistence/repositories/onboarding.py` | Modify | Accept `stage_config` in `upsert`, deserialize in `get` |
| `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` | Modify | Write `stage_config` at workspace creation, return in status endpoints |
| `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py` | Create | 4 stage functions as standalone async functions |
| `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py` | Modify | Wire stages, emit `stage_manifest`/`stage_progress`, store results |
| `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py` | Create | Unit tests for each stage function |
| `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py` | Modify | Update integration tests for new stage behavior |
| `draftly-agent-frontend/lib/onboarding/types.ts` | Modify | Add `StageConfig` interface, update `OnboardingStatus` + `InitializeStatus` |
| `draftly-agent-frontend/hooks/use-workflow-events.ts` | Modify | Add `stage_manifest` and `stage_progress` to `StreamEventType` |
| `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx` | Modify | Fetch `stage_config` on load, parse manifest/progress events |
| `draftly-agent-frontend/components/onboarding/initialization-progress.tsx` | Modify | Render dynamic task list + backend-driven progress |

---

## Part A: Backend

---

### Task 1: Migration — Add `stage_config` JSONB column

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/033_onboarding_stage_config.sql`

**Interfaces:**
- Consumes: existing `onboarding_state` table (migration `024_onboarding.sql`)
- Produces: `stage_config JSONB` column, nullable, default `NULL`

- [ ] **Step 1: Create migration file**

```sql
-- 033_onboarding_stage_config.sql
-- Adds stage_config JSONB column to store workflow stage definitions.
-- Written at workspace creation time so stage config is available on the
-- initialize page before SSE connects.

ALTER TABLE onboarding_state
ADD COLUMN IF NOT EXISTS stage_config JSONB DEFAULT NULL;
```

- [ ] **Step 2: Verify SQL syntax**

Run: `cd draftly-agent-backend && cat src/draftly/persistence/migrations/033_onboarding_stage_config.sql`
Expected: Valid SQL with `ALTER TABLE` statement

---

### Task 2: Backend — Update `OnboardingRepository` to handle `stage_config`

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/onboarding.py`

**Interfaces:**
- Consumes: `stage_config` JSONB column (from migration 033)
- Produces: `stage_config` deserialized in `get()`, accepted in `upsert()`

- [ ] **Step 1: Add `stage_config` to the JSON deserialization list in `get()`**

In the `get()` method, add `"stage_config"` to the list of keys that get JSON-deserialized:

```python
for key in ("completed_steps", "failure", "selected_repository", "stage_config"):
    value = state.get(key)
    if isinstance(value, str):
        state[key] = json.loads(value)
```

- [ ] **Step 2: Add `stage_config` parameter to `upsert()`**

Update the `upsert` signature to accept `stage_config`:

```python
async def upsert(
    self,
    org_id: str,
    *,
    state: str | None = None,
    completed_steps: list[str] | None = None,
    failure: dict | None = None,
    selected_repository: dict | None = None,
    stage_config: list[dict] | None = None,
) -> dict[str, Any]:
```

Add the serialization block after the `selected_repository` serialization block:

```python
if stage_config is not None:
    fields["stage_config"] = json.dumps(stage_config)
```

- [ ] **Step 3: Verify syntax**

Run: `cd draftly-agent-backend && python3 -c "import ast; ast.parse(open('src/draftly/persistence/repositories/onboarding.py').read()); print('OK')"`
Expected: `OK`

---

### Task 3: Backend — Write `stage_config` at workspace creation + return in status

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py`

**Interfaces:**
- Consumes: `STAGES` list + `STAGE_LABELS` dict from `initialize.py`
- Produces: `stage_config` written to NeonDB at workspace creation, returned in status endpoints

- [ ] **Step 1: Import stage definitions in onboarding routes**

At the top of `onboarding.py`, after the existing imports, add:

```python
from draftly.workflows.onboarding.initialize import STAGES, STAGE_LABELS
```

- [ ] **Step 2: Build and write `stage_config` in `create_workspace`**

In the `create_workspace` endpoint, add `stage_config` to the `upsert` call. Replace the existing `upsert` call:

```python
stage_config = [
    {"id": s, "label": STAGE_LABELS.get(s, s), "order": i}
    for i, s in enumerate(STAGES)
]
await repos.onboarding.upsert(
    org_id,
    state="WORKSPACE_CREATED",
    selected_repository={"workspace_name": body.name, "description": body.description},
    stage_config=stage_config,
)
```

- [ ] **Step 3: Return `stage_config` in `get_status`**

In the `get_status` endpoint, the response already returns the full `state` dict from `repos.onboarding.get(org_id)`. Since `stage_config` is now a column in `onboarding_state`, it will be included automatically. No change needed here.

- [ ] **Step 4: Return `stage_config` in `get_initialize_status`**

In the `get_initialize_status` endpoint, the current response only returns `state`, `stage`, and `failure`. **This requires an explicit change** — add `stage_config` to the response dict:

```python
return {
    "state": current.get("state"),
    "stage": _selected(current).get("init_stage"),
    "failure": failure,
    "stage_config": current.get("stage_config"),
}
```

- [ ] **Step 5: Verify syntax**

Run: `cd draftly-agent-backend && python3 -c "import ast; ast.parse(open('src/draftly/app/api/routes/onboarding.py').read()); print('OK')"`
Expected: `OK`

---

### Task 4: Create `stages.py` with `knowledge_construction` function

**Files:**
- Create: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Test: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `WorkflowContext` (with `.memory`, `.docgraph`, `.candidates`, `.model`), `org_id: str`, `publish: Callable`
- Produces: `KnowledgeExtractionResult` dataclass with `knowledge_count`, `relationship_count`, `candidate_count`, `failed_chunks`

- [ ] **Step 1: Write the failing test**

```python
# draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py
"""Unit tests for onboarding initialization stage functions."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from draftly.workflows.onboarding.stages import (
    KnowledgeExtractionResult,
    run_knowledge_construction,
)


@pytest.mark.asyncio
async def test_knowledge_construction_extracts_from_chunks():
    """Should extract knowledge from document chunks and return counts."""
    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[
        {"id": "chunk-1", "content": "Use `npm install` to install dependencies.", "metadata": {}},
        {"id": "chunk-2", "content": "Run `npm start` to start the dev server.", "metadata": {}},
    ])
    context.memory.remember = AsyncMock(return_value={"id": "k-1"})
    context.docgraph.link = AsyncMock(return_value={"id": "edge-1"})
    context.candidates.enqueue = AsyncMock(return_value={"id": "c-1"})
    context.model.generate = AsyncMock(return_value=MagicMock(
        content='{"facts": ["Install via npm"], "relationships": [{"source": "npm", "target": "install", "type": "uses"}], "procedures": [{"steps": ["Run npm start"]}]}}'
    ))
    publish = AsyncMock()

    result = await run_knowledge_construction(
        context, org_id="test-org", publish=publish,
    )

    assert isinstance(result, KnowledgeExtractionResult)
    assert result.knowledge_count >= 0
    assert result.relationship_count >= 0
    assert result.candidate_count >= 0


@pytest.mark.asyncio
async def test_knowledge_construction_handles_empty_chunks():
    """Should return zero counts when no chunks exist."""
    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[])
    publish = AsyncMock()

    result = await run_knowledge_construction(
        context, org_id="test-org", publish=publish,
    )

    assert result.knowledge_count == 0
    assert result.relationship_count == 0
    assert result.candidate_count == 0
    assert result.failed_chunks == []


@pytest.mark.asyncio
async def test_knowledge_construction_skips_failed_chunks():
    """Should skip chunks that timeout or fail extraction, not abort."""
    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[
        {"id": "chunk-ok", "content": "Good content about APIs.", "metadata": {}},
        {"id": "chunk-bad", "content": "", "metadata": {}},
    ])
    context.memory.remember = AsyncMock(return_value={"id": "k-1"})
    context.docgraph.link = AsyncMock(return_value={"id": "edge-1"})
    context.candidates.enqueue = AsyncMock(return_value={"id": "c-1"})
    # First call succeeds, second raises
    context.model.generate = AsyncMock(side_effect=[
        MagicMock(content='{"facts": ["APIs exist"], "relationships": [], "procedures": []}'),
        RuntimeError("chunk failed"),
    ])
    publish = AsyncMock()

    result = await run_knowledge_construction(
        context, org_id="test-org", publish=publish,
    )

    assert result.knowledge_count >= 0
    assert "chunk-bad" in result.failed_chunks
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'draftly.workflows.onboarding.stages'`

- [ ] **Step 3: Write minimal implementation**

```python
# draftly-agent-backend/src/draftly/workflows/onboarding/stages.py
"""Onboarding initialization stage functions.

Stages 2-5 of the onboarding workflow: knowledge extraction, evaluation,
health scoring, and recommendation generation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

import structlog

logger = structlog.get_logger(__name__)

EXTRACTION_PROMPT = """\
Analyze this documentation chunk and extract structured knowledge.

Return a JSON object with these keys:
- "facts": list of key facts (strings)
- "relationships": list of {{"source": str, "target": str, "type": str}} objects
- "procedures": list of {{"steps": [str], "title": str}} objects

Chunk content:
{content}

Return ONLY valid JSON, no markdown fences."""


@dataclass
class KnowledgeExtractionResult:
    knowledge_count: int = 0
    relationship_count: int = 0
    candidate_count: int = 0
    failed_chunks: list[str] = field(default_factory=list)


@dataclass
class EvaluationResult:
    score: float = 0.0
    dimensions: dict[str, float] = field(default_factory=dict)


@dataclass
class HealthResult:
    score: float = 0.0
    dimensions: dict[str, float] = field(default_factory=dict)


@dataclass
class Recommendation:
    priority: str = "medium"
    title: str = ""
    detail: str = ""
    category: str = ""


CHUNK_BATCH_SIZE = 50
CHUNK_TIMEOUT_SECONDS = 10


async def run_knowledge_construction(
    context: Any,
    *,
    org_id: str,
    publish: Callable[[str, dict[str, Any]], Awaitable[None]],
) -> KnowledgeExtractionResult:
    """Stage 2: Extract knowledge from synced document chunks via LLM."""
    result = KnowledgeExtractionResult()

    # Recall all document chunks from memory
    chunks = await context.memory.recall(
        namespace="documents",
        query="*",
        limit=500,
    )

    if not chunks:
        logger.info("knowledge_construction_no_chunks org=%s", org_id)
        return result

    total = len(chunks)
    for i in range(0, total, CHUNK_BATCH_SIZE):
        batch = chunks[i : i + CHUNK_BATCH_SIZE]
        for chunk in batch:
            chunk_id = chunk.get("id", "unknown")
            content = chunk.get("content", "")
            if not content.strip():
                result.failed_chunks.append(chunk_id)
                continue

            try:
                prompt = EXTRACTION_PROMPT.format(content=content[:2000])
                response = await context.model.generate(prompt)
                raw = response.content if hasattr(response, "content") else str(response)
                # Strip markdown fences if present
                raw = raw.strip()
                if raw.startswith("```"):
                    raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                extracted = json.loads(raw)

                # Store facts as Knowledge items
                # Lazy imports to avoid circular dependencies (existing pattern)
                for fact in extracted.get("facts", []):
                    from draftly.memory.models.knowledge import Knowledge
                    item = Knowledge(
                        namespace="knowledge",
                        content=fact,
                        org_id=org_id,
                        topic=chunk.get("metadata", {}).get("title"),
                        source_quality=0.7,
                    )
                    await context.memory.remember(item)
                    result.knowledge_count += 1

                # Store relationships in docgraph
                for rel in extracted.get("relationships", []):
                    await context.docgraph.link(
                        source_key=rel.get("source", ""),
                        target_key=rel.get("target", ""),
                        relation_type=rel.get("type", "related_to"),
                        org_id=org_id,
                    )
                    result.relationship_count += 1

                # Enqueue procedures as candidates
                # Lazy import to avoid circular dependencies (existing pattern)
                from draftly.memory.candidates.models import MemoryCandidate
                for proc in extracted.get("procedures", []):
                    candidate = MemoryCandidate(
                        org_id=org_id,
                        candidate_type="procedure_pattern",
                        payload=proc,
                        source_type="document_chunk",
                        source_id=chunk_id,
                        evidence=[content[:200]],
                        confidence=0.6,
                    )
                    await context.candidates.enqueue(candidate)
                    result.candidate_count += 1

            except Exception as exc:
                logger.warning("knowledge_extraction_chunk_failed chunk=%s err=%s", chunk_id, exc)
                result.failed_chunks.append(chunk_id)

        # Publish progress after each batch
        processed = min(i + CHUNK_BATCH_SIZE, total)
        await publish("tool_progress", {
            "name": "knowledge_extraction",
            "processed": processed,
            "total": total,
        })

    logger.info(
        "knowledge_construction_done org=%s facts=%d rels=%d procs=%d failed=%d",
        org_id, result.knowledge_count, result.relationship_count,
        result.candidate_count, len(result.failed_chunks),
    )
    return result
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/stages.py draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat(onboarding): add knowledge_construction stage with LLM extraction"
```

---

### Task 5: Add `initial_evaluation` function

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `WorkflowContext` (with `.memory`), `org_id: str`
- Produces: `EvaluationResult` with `score: float` and `dimensions: {coverage, completeness, structure, length}`

- [ ] **Step 1: Write the failing test**

```python
# Add to test_onboarding_stages.py

@pytest.mark.asyncio
async def test_initial_evaluation_scores_corpus():
    """Should score documentation corpus on 4 dimensions."""
    from draftly.workflows.onboarding.stages import run_initial_evaluation

    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[
        {
            "id": "doc-1",
            "content": "# Getting Started\n\n## Installation\n\nRun npm install.\n\n## Usage\n\n```js\nconst app = require('./app');\n```\n\nSee [docs](https://example.com).",
            "metadata": {"title": "README"},
        },
        {
            "id": "doc-2",
            "content": "# API Reference\n\n## GET /users\n\nReturns all users.\n\n## POST /users\n\nCreates a user.",
            "metadata": {"title": "API"},
        },
    ])

    result = await run_initial_evaluation(context, org_id="test-org")

    assert 0.0 <= result.score <= 1.0
    assert "coverage" in result.dimensions
    assert "completeness" in result.dimensions
    assert "structure" in result.dimensions
    assert "length" in result.dimensions


@pytest.mark.asyncio
async def test_initial_evaluation_empty_corpus():
    """Should return 0 score for empty corpus."""
    from draftly.workflows.onboarding.stages import run_initial_evaluation

    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[])

    result = await run_initial_evaluation(context, org_id="test-org")

    assert result.score == 0.0
    assert all(v == 0.0 for v in result.dimensions.values())


@pytest.mark.asyncio
async def test_initial_evaluation_weights_dimensions():
    """Score should be weighted: coverage 30%, completeness 30%, structure 20%, length 20%."""
    from draftly.workflows.onboarding.stages import run_initial_evaluation

    context = MagicMock()
    context.memory.recall = AsyncMock(return_value=[
        {
            "id": "doc-1",
            "content": "# Title\n\n## Section\n\nSome text with `code`.\n\n```python\nprint('hello')\n```\n\n[Link](https://example.com)",
            "metadata": {"title": "Test"},
        },
    ])

    result = await run_initial_evaluation(context, org_id="test-org")

    expected = (
        0.3 * result.dimensions["coverage"]
        + 0.3 * result.dimensions["completeness"]
        + 0.2 * result.dimensions["structure"]
        + 0.2 * result.dimensions["length"]
    )
    assert abs(result.score - expected) < 0.01
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py::test_initial_evaluation_scores_corpus -v`
Expected: FAIL with `ImportError: cannot import name 'run_initial_evaluation'`

- [ ] **Step 3: Implement `run_initial_evaluation`**

Add to `stages.py`:

```python
import re

EXPECTED_TOPICS = {"readme", "getting started", "installation", "api", "usage", "examples", "changelog", "contributing"}
CODE_BLOCK_PATTERN = re.compile(r"```[\s\S]*?```")
HEADING_PATTERN = re.compile(r"^#{1,3}\s+", re.MULTILINE)
WORD_RANGE = (200, 5000)


async def run_initial_evaluation(
    context: Any,
    *,
    org_id: str,
) -> EvaluationResult:
    """Stage 3: Heuristic scoring of documentation corpus quality."""
    docs = await context.memory.recall(
        namespace="documents",
        query="*",
        limit=500,
    )

    if not docs:
        return EvaluationResult(score=0.0, dimensions={
            "coverage": 0.0, "completeness": 0.0,
            "structure": 0.0, "length": 0.0,
        })

    total = len(docs)
    coverage_hits = 0
    completeness_sum = 0.0
    structure_hits = 0
    length_hits = 0

    for doc in docs:
        content = doc.get("content", "")
        title = doc.get("metadata", {}).get("title", "").lower()
        text = f"{title} {content}".lower()

        # Coverage: does doc cover expected topics?
        if any(topic in text for topic in EXPECTED_TOPICS):
            coverage_hits += 1

        # Completeness: has title, headings, code examples, links
        has_title = bool(title)
        has_headings = bool(HEADING_PATTERN.search(content))
        has_code = bool(CODE_BLOCK_PATTERN.search(content))
        has_links = bool(re.search(r"\[.+\]\(.+\)", content))
        completeness_sum += sum([has_title, has_headings, has_code, has_links]) / 4.0

        # Structure: proper heading hierarchy
        headings = HEADING_PATTERN.findall(content)
        if headings:
            structure_hits += 1

        # Length: within acceptable range
        word_count = len(content.split())
        if WORD_RANGE[0] <= word_count <= WORD_RANGE[1]:
            length_hits += 1

    dimensions = {
        "coverage": coverage_hits / max(total, 1),
        "completeness": completeness_sum / max(total, 1),
        "structure": structure_hits / max(total, 1),
        "length": length_hits / max(total, 1),
    }

    score = (
        0.3 * dimensions["coverage"]
        + 0.3 * dimensions["completeness"]
        + 0.2 * dimensions["structure"]
        + 0.2 * dimensions["length"]
    )

    logger.info("initial_evaluation_done org=%s score=%.2f", org_id, score)
    return EvaluationResult(score=score, dimensions=dimensions)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/stages.py draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat(onboarding): add initial_evaluation stage with heuristic scoring"
```

---

### Task 6: Add `health_report` + `recommendations` functions

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `EvaluationResult`, `HealthResult`, `document_count: int`, `section_count: int`, `chunk_count: int`, `context.model`
- Produces: `HealthResult`, `list[Recommendation]`

- [ ] **Step 1: Write failing tests**

```python
# Add to test_onboarding_stages.py

@pytest.mark.asyncio
async def test_health_report_aggregates_scores():
    """Should compute weighted health from evaluation + baseline stats."""
    from draftly.workflows.onboarding.stages import (
        EvaluationResult, run_health_report,
    )

    eval_result = EvaluationResult(
        score=0.7,
        dimensions={"coverage": 0.8, "completeness": 0.6, "structure": 0.7, "length": 0.7},
    )

    result = run_health_report(
        eval_result=eval_result,
        document_count=25,
        section_count=75,
    )

    assert 0.0 <= result.score <= 1.0
    assert "coverage" in result.dimensions
    assert "freshness" in result.dimensions
    assert result.dimensions["freshness"] == 1.0  # Just synced = fresh


def test_health_report_sync_not_async():
    """Health report is pure math — should be sync, not async."""
    from draftly.workflows.onboarding.stages import run_health_report
    import inspect
    assert not inspect.iscoroutinefunction(run_health_report)


@pytest.mark.asyncio
async def test_recommendations_generates_suggestions():
    """Should generate recommendations from health + evaluation results."""
    from draftly.workflows.onboarding.stages import (
        EvaluationResult, HealthResult, run_recommendations,
    )

    context = MagicMock()
    context.model.generate = AsyncMock(return_value=MagicMock(
        content='[{"priority": "high", "title": "Add API reference", "detail": "Your docs lack API reference sections.", "category": "coverage"}]'
    ))

    eval_result = EvaluationResult(score=0.5, dimensions={
        "coverage": 0.3, "completeness": 0.5, "structure": 0.6, "length": 0.6,
    })
    health_result = HealthResult(score=0.52, dimensions={
        "coverage": 0.3, "structure": 0.6, "freshness": 1.0, "completeness": 0.5,
    })

    recs = await run_recommendations(
        context, eval_result=eval_result, health_result=health_result,
        document_count=10, chunk_count=40,
    )

    assert len(recs) >= 1
    assert recs[0].priority == "high"
    assert recs[0].title == "Add API reference"


@pytest.mark.asyncio
async def test_recommendations_handles_llm_failure():
    """Should return empty list if LLM fails, not raise."""
    from draftly.workflows.onboarding.stages import (
        EvaluationResult, HealthResult, run_recommendations,
    )

    context = MagicMock()
    context.model.generate = AsyncMock(side_effect=RuntimeError("model down"))

    eval_result = EvaluationResult(score=0.7, dimensions={
        "coverage": 0.7, "completeness": 0.7, "structure": 0.7, "length": 0.7,
    })
    health_result = HealthResult(score=0.7, dimensions={
        "coverage": 0.7, "structure": 0.7, "freshness": 1.0, "completeness": 0.7,
    })

    recs = await run_recommendations(
        context, eval_result=eval_result, health_result=health_result,
        document_count=30, chunk_count=150,
    )

    assert recs == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py::test_health_report_aggregates_scores -v`
Expected: FAIL with `ImportError: cannot import name 'run_health_report'`

- [ ] **Step 3: Implement `run_health_report`**

Add to `stages.py`:

```python
def run_health_report(
    *,
    eval_result: EvaluationResult,
    document_count: int,
    section_count: int,
) -> HealthResult:
    """Stage 4: Compute composite health score from evaluation + baseline stats."""
    doc_count_score = min(document_count / 50, 1.0)
    section_ratio = section_count / max(document_count, 1)
    section_ratio_score = min(section_ratio / 5, 1.0)

    health_score = (
        0.7 * eval_result.score
        + 0.15 * doc_count_score
        + 0.15 * section_ratio_score
    )

    dimensions = {
        "coverage": eval_result.dimensions.get("coverage", 0.0),
        "structure": eval_result.dimensions.get("structure", 0.0),
        "freshness": 1.0,  # Just synced
        "completeness": eval_result.dimensions.get("completeness", 0.0),
    }

    logger.info("health_report_done score=%.2f", health_score)
    return HealthResult(score=health_score, dimensions=dimensions)
```

- [ ] **Step 4: Implement `run_recommendations`**

Add to `stages.py`:

```python
RECOMMENDATION_PROMPT = """\
You are a documentation quality advisor. Based on the following metrics, generate 3-5 prioritized recommendations.

Health Score: {health_score:.2f}/1.0
Document Count: {document_count}
Chunk Count: {chunk_count}

Dimension Scores (0-1):
- Coverage: {coverage:.2f}
- Completeness: {completeness:.2f}
- Structure: {structure:.2f}
- Length: {length:.2f}

Low-scoring dimensions need the most attention.

Return a JSON array of recommendations, each with:
- "priority": "high", "medium", or "low"
- "title": short action title
- "detail": 1-2 sentence explanation
- "category": which dimension this addresses

Return ONLY valid JSON, no markdown fences."""


async def run_recommendations(
    context: Any,
    *,
    eval_result: EvaluationResult,
    health_result: HealthResult,
    document_count: int,
    chunk_count: int,
) -> list[Recommendation]:
    """Stage 5: Generate prioritized recommendations via LLM."""
    prompt = RECOMMENDATION_PROMPT.format(
        health_score=health_result.score,
        document_count=document_count,
        chunk_count=chunk_count,
        coverage=eval_result.dimensions.get("coverage", 0.0),
        completeness=eval_result.dimensions.get("completeness", 0.0),
        structure=eval_result.dimensions.get("structure", 0.0),
        length=eval_result.dimensions.get("length", 0.0),
    )

    try:
        response = await context.model.generate(prompt)
        raw = response.content if hasattr(response, "content") else str(response)
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        items = json.loads(raw)
        return [
            Recommendation(
                priority=item.get("priority", "medium"),
                title=item.get("title", ""),
                detail=item.get("detail", ""),
                category=item.get("category", ""),
            )
            for item in items
            if isinstance(item, dict)
        ]
    except Exception as exc:
        logger.warning("recommendations_generation_failed err=%s", exc)
        return []
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/stages.py draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat(onboarding): add health_report and recommendations stages"
```

---

### Task 7: Wire stages into `initialize.py` with SSE events

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`

**Interfaces:**
- Consumes: `KnowledgeExtractionResult`, `EvaluationResult`, `HealthResult`, `Recommendation` from `stages.py`
- Produces: Updated `selected_repository` JSONB with stage results, `stage_progress` SSE events

**Note:** The backend already publishes `stage_manifest` events at `initialize.py:106-111` and `stage_progress` events from `_flush_progress` during `repository_ingestion`. This task wires the remaining stages and adds `stage_progress` events for stages 2-5.

- [ ] **Step 1: Write the failing test**

```python
# Add to test_onboarding_initialize.py

@pytest.mark.asyncio
async def test_initialize_stores_stage_results(installation_client):
    """Stage results should be persisted in selected_repository."""
    from draftly.documentation.baseline import BaselineSnapshot
    from draftly.documentation.sync_service import SyncResult

    sync_result = SyncResult(
        commit_sha="abc123",
        repository="owner/repo",
        document_count=5,
        chunk_count=20,
        baseline=BaselineSnapshot(
            commit_sha="abc123", repository="owner/repo",
            document_count=5, section_count=15, chunk_count=20,
        ),
    )

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
                    score=0.72, dimensions={
                        "coverage": 0.8, "completeness": 0.6,
                        "structure": 0.7, "length": 0.7,
                    },
                )),
            ):
                with patch(
                    "draftly.workflows.onboarding.stages.run_health_report",
                    return_value=MagicMock(score=0.68, dimensions={
                        "coverage": 0.8, "structure": 0.7,
                        "freshness": 1.0, "completeness": 0.6,
                    }),
                ):
                    with patch(
                        "draftly.workflows.onboarding.stages.run_recommendations",
                        new=AsyncMock(return_value=[
                            MagicMock(priority="high", title="Add API ref",
                                      detail="Missing", category="coverage"),
                        ]),
                    ):
                        state = await run_onboarding_initialize(
                            _context(),
                            org_id="test-org",
                            selected_repository={"full_name": "owner/repo"},
                        )

    assert state.status == WorkflowStatus.DELIVERED
```

- [ ] **Step 2: Run test to verify it fails**

Run: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py::test_initialize_stores_stage_results -v`
Expected: FAIL (stages not yet wired, or assertion fails because results aren't stored)

- [ ] **Step 3: Modify `_on_sync_progress` and `_flush_progress` to emit `stage_progress`**

Replace the existing progress tracking code in the `run_onboarding_initialize` function body with:

```python
    # Buffer for intermediate progress updates during repository_ingestion.
    # Coalesced so we don't flood the stream with per-file events.
    _progress_lock = asyncio.Lock()
    _latest_progress: dict[str, Any] = {}
    _sync_total_files: int = 0

    def _on_sync_progress(document_count: int, chunk_count: int) -> None:
        nonlocal _latest_progress, _sync_total_files
        _latest_progress = {"document_count": document_count, "chunk_count": chunk_count}
        if document_count > _sync_total_files:
            _sync_total_files = document_count

    async def _flush_progress() -> None:
        if _latest_progress:
            await _publish("tool_progress", {
                "name": "documentation_sync",
                **_latest_progress,
            })
            # Emit stage_progress with actual percentage for the active stage
            doc_count = _latest_progress.get("document_count", 0)
            total = max(_sync_total_files, 1)
            progress = min(int((doc_count / total) * 92), 92) if _sync_total_files > 0 else 0
            await _publish("stage_progress", {
                "stage": "repository_ingestion",
                "progress": progress,
                "message": f"Processed {doc_count} files",
            })
            await asyncio.sleep(0)
```

- [ ] **Step 4: Replace placeholder stages with real implementations**

Replace the placeholder stages (the `await _stage_complete("knowledge_construction")` / `initial_evaluation` / `health_report` / `recommendations` block) with:

```python
        # Stage 2: Knowledge construction — extract from synced chunks
        await _update_stage(onboarding_repo, org_id, "knowledge_construction")
        await _stage_start("knowledge_construction", {"document_count": sync_result.document_count})
        from draftly.workflows.onboarding.stages import (
            run_knowledge_construction,
            run_initial_evaluation,
            run_health_report,
            run_recommendations,
        )

        extraction = await run_knowledge_construction(
            context, org_id=org_id, publish=_publish,
        )
        await _stage_complete("knowledge_construction", {
            "knowledge_count": extraction.knowledge_count,
            "relationship_count": extraction.relationship_count,
            "candidate_count": extraction.candidate_count,
        })

        # Stage 3: Initial evaluation — score corpus quality
        await _update_stage(onboarding_repo, org_id, "initial_evaluation")
        await _stage_start("initial_evaluation")
        eval_result = await run_initial_evaluation(context, org_id=org_id)
        await _stage_complete("initial_evaluation", {"score": eval_result.score})

        # Stage 4: Health report — aggregate scores
        await _update_stage(onboarding_repo, org_id, "health_report")
        await _stage_start("health_report")
        health_result = run_health_report(
            eval_result=eval_result,
            document_count=sync_result.document_count,
            section_count=sync_result.baseline.section_count if sync_result.baseline else 0,
        )
        await _stage_complete("health_report", {"score": health_result.score})

        # Stage 5: Recommendations — generate suggestions
        await _update_stage(onboarding_repo, org_id, "recommendations")
        await _stage_start("recommendations")
        recs = await run_recommendations(
            context,
            eval_result=eval_result,
            health_result=health_result,
            document_count=sync_result.document_count,
            chunk_count=sync_result.chunk_count,
        )
        await _stage_complete("recommendations", {"count": len(recs)})
```

- [ ] **Step 5: Update `selected_repository` write to include stage results**

Replace the final `selected_repository` write block with:

```python
        if onboarding_repo:
            current = await onboarding_repo.get(org_id)
            selected = dict((current or {}).get("selected_repository") or {})
            selected["document_count"] = sync_result.document_count
            selected["chunk_count"] = sync_result.chunk_count
            selected["knowledge_count"] = extraction.knowledge_count
            selected["eval_score"] = eval_result.score
            selected["health_score"] = health_result.score
            selected["recommendations"] = [
                {"priority": r.priority, "title": r.title,
                 "detail": r.detail, "category": r.category}
                for r in recs
            ]
            await onboarding_repo.mark_step_and_set_state(
                org_id, "initialization", "COMPLETED",
                selected_repository=selected,
            )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `pytest draftly-agent-backend/tests/ -v --tb=short`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py
git commit -m "feat(onboarding): wire stage implementations and SSE progress events"
```

---

### Task 8: Backend verify

**Files:**
- No new files

- [ ] **Step 1: Run typecheck**

Run: `cd draftly-agent-backend && python -m mypy src/draftly/workflows/onboarding/stages.py src/draftly/workflows/onboarding/initialize.py --ignore-missing-imports`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 2: Run linter**

Run: `cd draftly-agent-backend && python -m ruff check src/draftly/workflows/onboarding/stages.py src/draftly/workflows/onboarding/initialize.py`
Expected: No errors

- [ ] **Step 3: Run all onboarding tests**

Run: `pytest draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: All pass

- [ ] **Step 4: Run graphify update**

Run: `graphify update .`
Expected: Graph updated with new `stages.py` file

---

## Part B: Frontend

---

### Task 9: Frontend — Add `StageConfig` type and update status types

**Files:**
- Modify: `draftly-agent-frontend/lib/onboarding/types.ts`

**Interfaces:**
- Consumes: existing `OnboardingStatus`, `InitializeStatus` interfaces
- Produces: `StageConfig` interface, updated `OnboardingStatus` + `InitializeStatus` with `stage_config`

- [ ] **Step 1: Add `StageConfig` interface**

After the existing `DiscoveryResult` interface, add:

```typescript
export interface StageConfig {
  id: string;
  label: string;
  order: number;
}
```

- [ ] **Step 2: Add `stage_config` to `OnboardingStatus`**

Update `OnboardingStatus`:

```typescript
export interface OnboardingStatus {
  state: OnboardingState;
  completed_steps: OnboardingStep[];
  failure: { step: string; detail: string } | null;
  selected_repository: Record<string, unknown> | null;
  stage_config: StageConfig[] | null;
}
```

- [ ] **Step 3: Add `stage_config` to `InitializeStatus`**

Update `InitializeStatus`:

```typescript
export interface InitializeStatus {
  state: OnboardingState;
  stage: string | null;
  failure: { step: string; detail: string } | null;
  stage_config: StageConfig[] | null;
  run_id?: string;
  ticket?: string;
}
```

- [ ] **Step 4: Verify frontend types**

Run: `cd draftly-agent-frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `types.ts`

---

### Task 10: Frontend — Add new event types to `StreamEventType`

**Files:**
- Modify: `draftly-agent-frontend/hooks/use-workflow-events.ts`

**Interfaces:**
- Consumes: existing `StreamEventType` union
- Produces: extended union with `"stage_manifest"` and `"stage_progress"`

**Note:** The backend already publishes `stage_manifest` and `stage_progress` events — this task wires the frontend to receive and type them correctly.

- [ ] **Step 1: Add event types to the union**

In `use-workflow-events.ts`, add `"stage_manifest"` and `"stage_progress"` to the `StreamEventType` union:

```typescript
export type StreamEventType =
  | "node_start"
  | "node_stop"
  | "handoff"
  | "text_delta"
  | "tool_progress"
  | "stage_change"
  | "stage_manifest"
  | "stage_progress"
  | "workflow_result";
```

- [ ] **Step 2: Add event types to the listener registration**

In the `useEffect` inside `useWorkflowEvents`, add `"stage_manifest"` and `"stage_progress"` to the `eventTypes` array:

```typescript
for (const t of [
  "node_start",
  "node_stop",
  "handoff",
  "text_delta",
  "tool_progress",
  "stage_change",
  "stage_manifest",
  "stage_progress",
  "workflow_result",
]) {
```

- [ ] **Step 3: Verify frontend syntax**

Run: `cd draftly-agent-frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `use-workflow-events.ts`

---

### Task 11: Frontend — Fetch `stage_config` on page load + parse SSE events

**Files:**
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/initialize/page.tsx`

**Interfaces:**
- Consumes: `InitializeStatus.stage_config` (from `GET /initialize/status`), `StreamEvent` from SSE
- Produces: `stageManifest` (StageConfig[]), `stageProgress` (Record<string, number>), passed to `InitializationProgress`

- [ ] **Step 1: Import `StageConfig` type**

Add to the existing imports in the page:

```typescript
import type { StageConfig } from "@/lib/onboarding/types";
```

- [ ] **Step 2: Add state for `stageManifest` and `stageProgress`**

Inside `InitializePage`, add new state variables after the existing state declarations:

```typescript
const [stageManifest, setStageManifest] = useState<StageConfig[]>([]);
const [stageProgress, setStageProgress] = useState<Record<string, number>>({});
```

- [ ] **Step 3: Fetch `stage_config` from `GET /initialize/status` on mount**

Add a `useEffect` that fetches the initial stage config when the page loads (before SSE connects):

```typescript
useEffect(() => {
  getInitializeStatus()
    .then((res) => {
      if (res.stage_config && Array.isArray(res.stage_config)) {
        setStageManifest(res.stage_config);
      }
    })
    .catch(() => {
      // SSE stage_manifest event will provide fallback
    });
}, []);
```

- [ ] **Step 4: Parse `stage_manifest` and `stage_progress` SSE events**

Add a `useEffect` to handle the new event types from the stream:

```typescript
useEffect(() => {
  for (const event of events) {
    if (event.type === "stage_manifest") {
      const stages = event.payload.stages as StageConfig[];
      if (Array.isArray(stages)) {
        setStageManifest(stages);
      }
    }
    if (event.type === "stage_progress") {
      const stage = event.payload.stage as string;
      const progress = event.payload.progress as number;
      if (stage && typeof progress === "number") {
        setStageProgress((prev) => ({ ...prev, [stage]: progress }));
      }
    }
  }
}, [events]);
```

- [ ] **Step 5: Pass new props to `InitializationProgress`**

Update the `InitializationProgress` component invocation to pass the new props:

```tsx
<InitializationProgress
  stageHistory={stageHistory}
  activeStage={activeStage}
  syncProgress={syncProgress}
  finalStats={finalStats}
  stageManifest={stageManifest}
  stageProgress={stageProgress}
/>
```

- [ ] **Step 6: Verify frontend syntax**

Run: `cd draftly-agent-frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to initialize page

---

### Task 12: Frontend — Render dynamic task list + backend-driven progress

**Files:**
- Modify: `draftly-agent-frontend/components/onboarding/initialization-progress.tsx`

**Interfaces:**
- Consumes: `stageManifest` (StageConfig[]), `stageProgress` (Record<string, number>), `stageHistory`, `activeStage`
- Produces: Dynamic task rows rendered from manifest + preset steps, progress bars driven by backend data

- [ ] **Step 1: Import `StageConfig` type**

```typescript
import type { StageConfig } from "@/lib/onboarding/types";
```

- [ ] **Step 2: Update `InitializationProgress` props interface**

Replace the props interface to accept the new props:

```typescript
export function InitializationProgress({
  stageHistory,
  activeStage,
  syncProgress,
  finalStats,
  stageManifest,
  stageProgress,
}: {
  stageHistory: StageInfo[];
  activeStage: StageInfo | null;
  syncProgress: SyncProgress | null;
  finalStats: { document_count?: number; chunk_count?: number } | null;
  stageManifest: StageConfig[];
  stageProgress: Record<string, number>;
}) {
```

- [ ] **Step 3: Replace hardcoded `INIT_TASKS` with dynamic task builder**

Replace the static `INIT_TASKS` array with:

**Note:** The existing `INIT_TASKS` already maps all 5 backend stages (`repository_ingestion`, `knowledge_construction`, `initial_evaluation`, `health_report`, `recommendations`) with matching keys. The change here is to split into preset + dynamic parts so the manifest can override labels:

```typescript
const PRESET_TASKS: InitTask[] = [
  { key: "workspace_created", label: "Workspace created", isPreset: true },
  { key: "github_connected", label: "GitHub connected", isPreset: true },
  { key: "repository_indexed", label: "Repository indexed", isPreset: true },
  { key: "docs_discovered", label: "Documentation discovered", isPreset: true },
];

function buildInitTasks(manifest: StageConfig[]): InitTask[] {
  if (manifest.length === 0) {
    return PRESET_TASKS;
  }
  return [
    ...PRESET_TASKS,
    ...manifest
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        key: s.id,
        label: s.label,
        backendStage: s.id,
      })),
  ];
}
```

- [ ] **Step 4: Use dynamic task list in render**

Inside the component, replace `INIT_TASKS.map(...)` with:

```typescript
const initTasks = buildInitTasks(stageManifest);
```

Then in the JSX: `{initTasks.map((task, i) => { ... })}`

- [ ] **Step 5: Replace time-based progress with backend-driven progress**

Remove the `useStageProgress` hook call and replace with:

```typescript
const progress = activeStage?.stage
  ? (stageProgress[activeStage.stage] ?? 0)
  : 0;
```

Pass `progress` to the active `TaskRow`:

```typescript
<TaskRow
  key={task.key}
  label={task.label}
  done={done}
  active={active}
  progress={active ? progress : 0}
  relativeTs={...}
  showSubdetail={...}
  subdetail={...}
/>
```

- [ ] **Step 6: Remove the `useStageProgress` hook**

Delete the entire `useStageProgress` function since the backend now drives progress. The function currently fills 0-100% over estimated stage durations using `requestAnimationFrame` — this is replaced by backend-driven `stage_progress` events.

- [ ] **Step 7: Verify frontend compiles**

Run: `cd draftly-agent-frontend && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors

---

### Task 13: Verify end-to-end

- [ ] **Step 1: Run backend syntax checks**

Run: `cd draftly-agent-backend && python3 -c "import ast; ast.parse(open('src/draftly/workflows/onboarding/initialize.py').read()); ast.parse(open('src/draftly/app/api/routes/onboarding.py').read()); ast.parse(open('src/draftly/persistence/repositories/onboarding.py').read()); ast.parse(open('src/draftly/workflows/onboarding/stages.py').read()); print('All OK')"`
Expected: `All OK`

- [ ] **Step 2: Run frontend typecheck**

Run: `cd draftly-agent-frontend && npx tsc --noEmit --pretty 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 3: Run frontend lint**

Run: `cd draftly-agent-frontend && npx next lint 2>&1 | tail -5`
Expected: No new errors

- [ ] **Step 4: Run existing frontend tests**

Run: `cd draftly-agent-frontend && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass (or only pre-existing failures)
