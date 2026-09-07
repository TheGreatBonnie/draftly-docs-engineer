# Onboarding Initialization Stages — Design Spec

**Date:** 2026-08-27
**Status:** Approved
**Depends on:** Dynamic stage mapping plan (SSE wiring — separate concern)

## Problem

The onboarding initialization workflow (`initialize.py`) has 5 stages, but only `repository_ingestion` does real work. Stages 2-5 (`knowledge_construction`, `initial_evaluation`, `health_report`, `recommendations`) are placeholders that immediately start+complete with no processing.

## Goal

Implement the actual processing logic for stages 2-5 so the onboarding initialization workflow produces meaningful output: extracted knowledge, corpus quality scores, a health report, and actionable recommendations.

## Design Decisions

| Stage | Approach | Rationale |
|-------|----------|-----------|
| knowledge_construction | LLM-based extraction | Richer extraction of facts, relationships, procedures from document chunks |
| initial_evaluation | Heuristic scoring | Fast, deterministic, no LLM needed for structural analysis |
| health_report | Simple weighted score | Transparent, easy to explain to users |
| recommendations | LLM-generated | Natural language recommendations require understanding of context |

## Architecture

### Data Flow

```
Stage 1: repository_ingestion
    ↓ SyncResult(document_count, chunk_count, baseline)
Stage 2: knowledge_construction
    ↓ knowledge_count, relationship_count, candidate_count
Stage 3: initial_evaluation
    ↓ eval_result: {score, dimensions: {coverage, completeness, structure, length}}
Stage 4: health_report
    ↓ health_result: {score, dimensions: {coverage, structure, freshness, completeness}}
Stage 5: recommendations
    ↓ recommendations: [{priority, title, detail, category}]
```

Each stage receives the `WorkflowContext` (carrying `memory`, `docgraph`, `candidates`, `model`) and the results of the previous stage.

### Stage 2: knowledge_construction

**Input:** Synced document chunks from `MemoryService.recall_knowledge(namespace="documents")`

**Process:**
1. Recall all document chunks (batch, limit ~500)
2. For each chunk, call `context.model` with a structured extraction prompt:
   - Extract key facts → `MemoryService.remember()` as `Knowledge` items
   - Extract code↔doc relationships → `DocGraphService.link()`
   - Extract procedures/steps → `CandidateService.enqueue()` as `procedure_pattern` candidates
3. Report progress via `_publish("tool_progress", ...)` per batch

**Output:** `{knowledge_count, relationship_count, candidate_count}`

**Error handling:** Per-chunk timeout (10s). Failed chunks recorded in `failed_chunks` list, not fatal.

### Stage 3: initial_evaluation

**Input:** Document records from memory

**Dimensions (0-1 each):**
- **Coverage (30%):** % of expected topics present (README, API ref, getting-started, examples, changelog)
- **Completeness (30%):** Average section depth per document (has title? has code? has links?)
- **Structure (20%):** % of documents with proper heading hierarchy (h1 → h2 → h3)
- **Length (20%):** % of documents within acceptable word count range (200-5000 words)

**Output:** `{score: float, dimensions: {coverage, completeness, structure, length}}`

### Stage 4: health_report

**Input:** Baseline snapshot + evaluation result

**Formula:**
```
health_score = 0.7 * eval_score + 0.15 * doc_count_score + 0.15 * section_ratio_score
```

Where:
- `eval_score` = weighted average from stage 3
- `doc_count_score` = min(document_count / 50, 1.0) (capped at 50 docs)
- `section_ratio_score` = min(section_count / document_count / 5, 1.0) (capped at 5 sections/doc)

**Output:** `{score: float, dimensions: {coverage, structure, freshness, completeness}}`

### Stage 5: recommendations

**Input:** Evaluation result + health result + baseline stats

**Process:**
1. Build prompt with health score, dimension breakdown, document counts, low-scoring dimensions
2. Call `context.model` to generate 3-5 prioritized recommendations
3. Parse LLM output into structured recommendations

**Output:** `[{priority: "high"|"medium"|"low", title: str, detail: str, category: str}]`

### Storage

Results stored in `onboarding_state.selected_repository` JSONB:
```json
{
  "init_stage": "recommendations",
  "document_count": 12,
  "chunk_count": 87,
  "knowledge_count": 45,
  "eval_score": 0.72,
  "health_score": 0.68,
  "recommendations": [...]
}
```

No new API changes — `GET /initialize/status` already returns `selected_repository`.

### Error Handling

Each stage follows the same pattern:
- If stage fails → `mark_failed()` on NeonDB
- `workflow_result` with `FAILED` published via SSE
- Frontend shows error immediately

Stage 2 adds per-chunk timeout (10s) and skip-on-failure with `failed_chunks` tracking.

## Files Modified

| File | Change |
|------|--------|
| `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py` | Add 4 new functions, wire into workflow |
| `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py` | Add tests for each stage |

## Out of Scope

- Frontend changes (handled by dynamic stage mapping plan)
- Database migrations (no schema changes)
- New API endpoints (existing endpoints return the data)
- Knowledge curation workflow (separate concern, runs post-onboarding)
