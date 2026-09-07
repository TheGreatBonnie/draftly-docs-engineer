# Plan: Structured output + token-cost enhancements for onboarding stages

Date: 2026-08-28

## Goal

Enhance the Strands Agents calls in `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py` so that:

1. The three LLM-backed stages (knowledge construction, initial evaluation, recommendations) get **typed, validated structured output** via Pydantic models instead of hand-rolled JSON-string parsing.
2. We remove the fragile `_parse_extraction`, `_parse_llm_scores`, and inline markdown-fence-stripping code.
3. Token usage is **metered** (budget cap per call + `draftly_tokens_input_total` / `draftly_tokens_output_total` metrics), mirroring `runner.py` conventions.
4. Prompts are slimmed (the output schema now conveys structure, so prompts drop "Return ONLY valid JSON" boilerplate).

Scope is bounded to `stages.py` and `tests/unit/workflows/test_onboarding_stages.py`. No other modules, no new dependencies, no API/interface changes to other modules.

## Architecture

- Strands SDK (installed, version inspected in `.venv`): `Agent(model=..., structured_output_model=type[BaseModel], ...)` and `agent.invoke_async(prompt, *, structured_output_model=..., limits=..., ...) -> AgentResult`. `AgentResult.structured_output` holds the validated model instance (or `None`); `AgentResult.__str__` returns `structured_output.model_dump_json()`. `Limits` is a `TypedDict` with optional `turns` / `output_tokens` / `total_tokens`. Validation failures raise `StructuredOutputException` (`strands.types.exceptions`), which our existing generic `except Exception` stage guards already absorb.
- Each stage constructs one reusable `Agent` (with its stage's `structured_output_model`) and passes that agent into `_llm_generate`, which returns `result.structured_output`. Build/convert the schema once per stage rather than once per chunk.
- Pydantic schemas live in `stages.py` as module-level models. Extra fields ignored; unknown relation types **degrade to `DERIVED_FROM`** (never kills a whole chunk), while out-of-range/ill-typed scores and bad priorities **fail fast** (chunk falls back to heuristics / recommendations returns `[]`).
- Token telemetry mirrors `runner.py:26-27,39-59`: module-level injectable `_metrics: Metrics`, `Metrics.increment(name, value)` counters `draftly_tokens_input_total` / `draftly_tokens_output_total`.
- Token budget mirrors `LLM_MAX_CONCURRENCY` env pattern: `LLM_TOTAL_TOKENS_CAP = int(os.environ.get("LLM_TOTAL_TOKENS_CAP", "12000"))`, passed as `limits={"total_tokens": cap}` (or `None` when cap is `0`).

## Tech Stack

- Python 3.11, `strands` agent SDK, `pydantic>=2.9.0` (already declared), structlog, pytest + `pytest-asyncio` + `unittest.mock`.

## Spec

N/A — bounded refactor. Design was brainstormed and approved in-session; no separate spec file exists. A prior plan that this one builds on is `2026-08-28-initialization-bottleneck-remediation.md` (completed).

## Existing behavior to preserve

- Extraction: facts become `Knowledge` rows (batched via `store_batch` every `CHUNK_BATCH_SIZE`); each `relationship` links via `context.docgraph.link(relation_type=...)`; procedures become `MemoryCandidate(candidate_type="procedure_pattern", payload=<dict>, ...)`.
- Evaluation: per-doc LLM scores blended with heuristic `Dimension` scores; a failed/empty LLM eval falls back to pure heuristics.
- Recommendations: 3-5 suggestions derived from metrics; any failure returns `[]`.
- Empty-content chunks/docs short-circuit without an LLM call and still count as failed.
- `CHUNK_TIMEOUT_SECONDS`, `LLM_MAX_CONCURRENCY`, `EVAL_LLM_SAMPLE_SIZE`, `CHUNK_BATCH_SIZE` semantics unchanged.
- Log events (`knowledge_extraction_chunk_failed`, `knowledge_postprocess_failed`, `evaluation_llm_chunk_failed`, `recommendations_generation_failed`, stage progress) unchanged. **Exception:** the `invalid_relation_type` warning (stages.py:281-286) is intentionally retired — normalization moves into the `Relationship` validator, so no log fires on degrade. Semantics (normalize unknown → `DERIVED_FROM`) are identical.

## Global constraints

- Run everything from `/Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend` with `.venv/bin/python`.
- Must stay repo-wide ruff clean: `ruff check src tests workers`.
- No new third-party dependencies.
- Follow existing conventions: structlog `logger.warning("event", key=val)` strings, module-level env-derived constants, `runner.py` metrics/`_record_usage` patterns.
- Code is committed inside the backend git repo (`draftly-agent-backend`, branch `feat/rq-integration` — plenty of uncommitted plan-baseline changes already present; do not touch them). Commit style mixes conventional `feat:`/`refactor:` and plain descriptions at HEAD; prefer `feat:` for the per-task commits listed below.
- The plan file itself lives outside the backend repo (workspace root is not a git repo) — never commit the plan doc.

---

## Task 1 — Typed structured output for all three stages

Largest task, deliberately. Convert `_llm_generate` from "string in / string out" to "agent in / validated model out", add the Pydantic schemas, convert extraction → evaluation → recommendations, delete both legacy parsers, and rewrite the affected tests. Everything after this task is additive (limits, telemetry, prompt slimming).

### Files
- Modify: `src/draftly/workflows/onboarding/stages.py`
- Modify: `tests/unit/workflows/test_onboarding_stages.py`

### Interfaces Produced
- `stages.Relationship` — Pydantic model, `source: str`, `target: str`, `type: str` with a `mode="before"` validator that normalizes unknown types to `"DERIVED_FROM"`.
- `stages.Procedure` — `title: str = ""`, `steps: list[str] = Field(default_factory=list)`.
- `stages.ExtractionOutput` — `facts: list[str]`, `relationships: list[Relationship]`, `procedures: list[Procedure]` (all `default_factory=list`).
- `stages.EvaluationScores` — `coverage` / `completeness` / `structure` / `length`, each `float` with `Field(ge=0.0, le=1.0)`.
- `stages.Recommendation` — **replaces the existing `@dataclass Recommendation` (stages.py:61-67)**, which is deleted. Same fields/defaults (`priority: Literal["high", "medium", "low"] = "medium"`, `title`/`detail`/`category` `str = ""`), so the constructor footprint and `initialize.py` consumption (`run_recommendations` results) are unchanged.
- `stages.RecommendationList` — `items: list[Recommendation]` (root model wrapper, because the SDK `structured_output_model` takes a model type, not a bare list type).
- `_llm_generate(model, prompt, agent=None, *, output_model=None) -> BaseModel | None` — returns `result.structured_output` instead of a string.

### Steps

- [x] **1.1 Write failing tests for the new schemas.** Append to `tests/unit/workflows/test_onboarding_stages.py` (imports: `import pytest`, `from pydantic import ValidationError`, and `Relationship`, `EvaluationScores`, `ExtractionOutput`, `RecommendationList` from `draftly.workflows.onboarding.stages`):

```python
def test_relationship_degrades_unknown_type_to_derived_from():
    rel = Relationship(source="npm", target="utils", type="contains")
    assert rel.type == "DERIVED_FROM"


def test_relationship_preserves_valid_type():
    rel = Relationship(source="a", target="b", type="IMPLEMENTS")
    assert rel.type == "IMPLEMENTS"


def test_extraction_parses_from_raw_provider_json():
    out = ExtractionOutput.model_validate({
        "facts": ["Install via npm"],
        "relationships": [{"source": "npm", "target": "install", "type": "DOCUMENTED_BY"}],
        "procedures": [{"title": "Run", "steps": ["npm start"]}],
    })
    assert out.facts == ["Install via npm"]
    assert out.relationships[0].type == "DOCUMENTED_BY"
    assert out.procedures[0].steps == ["npm start"]


def test_evaluation_scores_reject_out_of_range():
    with pytest.raises(ValidationError):
        EvaluationScores(coverage=1.5, completeness=0.5, structure=0.5, length=0.5)


def test_recommendation_list_validates_priority_literal():
    parsed = RecommendationList.model_validate({
        "items": [{"priority": "high", "title": "t", "detail": "d", "category": "c"}]
    })
    assert parsed.items[0].priority == "high"
```

- [x] **1.2 Run the schema tests; confirm they fail** (ImportError / missing names):

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q -k "relationship or extraction_parses or evaluation_scores or recommendation_list"
```

- [x] **1.3 Add the schemas to `stages.py`.** Update the pydantic import to `from pydantic import BaseModel, Field, field_validator`, and change `from typing import Any` to `from typing import Any, Literal`. **Delete the existing `@dataclass\nclass Recommendation` block (lines 61-67)** — the pydantic `Recommendation` below replaces it 1:1 (keep `dataclass`/`field` imports; they remain used by `KnowledgeExtractionResult`/`EvaluationResult`/`HealthResult`). Insert the new models after the `VALID_RELATION_TYPES` set near the top:

```python
class Relationship(BaseModel):
    source: str = ""
    target: str = ""
    type: str = "DERIVED_FROM"

    @field_validator("type", mode="before")
    @classmethod
    def _normalize_type(cls, value: Any) -> str:
        normalized = str(value).upper()
        if normalized in VALID_RELATION_TYPES:
            return normalized
        return "DERIVED_FROM"


class Procedure(BaseModel):
    title: str = ""
    steps: list[str] = Field(default_factory=list)


class ExtractionOutput(BaseModel):
    facts: list[str] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    procedures: list[Procedure] = Field(default_factory=list)


class EvaluationScores(BaseModel):
    coverage: float = Field(ge=0.0, le=1.0)
    completeness: float = Field(ge=0.0, le=1.0)
    structure: float = Field(ge=0.0, le=1.0)
    length: float = Field(ge=0.0, le=1.0)


class Recommendation(BaseModel):
    priority: Literal["high", "medium", "low"] = "medium"
    title: str = ""
    detail: str = ""
    category: str = ""


class RecommendationList(BaseModel):
    items: list[Recommendation] = Field(default_factory=list)
```

- [x] **1.4 Run the schema tests; confirm they pass** (command from 1.2).

- [x] **1.5 Write failing tests for the new `_llm_generate` contract.** Update the existing test import to `from unittest.mock import ANY, AsyncMock, MagicMock, patch`, and add a shared helper near the top of the test module (after existing imports):

```python
from types import SimpleNamespace


def fake_agent_result(model_instance=None, usage=None):
    # `is not None` (not `or`): an explicit empty dict must stay empty so the
    # zero-usage telemetry path can be tested.
    return SimpleNamespace(
        structured_output=model_instance,
        metrics=SimpleNamespace(
            accumulated_usage=(
                usage if usage is not None else {"inputTokens": 100, "outputTokens": 50}
            )
        ),
    )
```

Then append:

```python
@pytest.mark.asyncio
async def test_llm_generate_returns_validated_structured_output():
    with patch("draftly.workflows.onboarding.stages.Agent") as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(
            return_value=fake_agent_result(ExtractionOutput(facts=["f"]))
        )
        out = await stages._llm_generate(
            MagicMock(), "prompt", output_model=ExtractionOutput
        )
    assert isinstance(out, ExtractionOutput)
    assert out.facts == ["f"]
    mock_agent_cls.assert_called_once_with(
        model=ANY, structured_output_model=ExtractionOutput,
    )
    mock_agent.invoke_async.assert_awaited_once()
```

- [x] **1.6 Run it; confirm it fails** (current `_llm_generate` returns a string, has no `output_model` param):

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q -k test_llm_generate_returns_validated_structured_output
```

- [x] **1.7 Rework `_llm_generate` in `stages.py`.** Replace the current body:

```python
async def _llm_generate(
    model: Any,
    prompt: str,
    agent: Any | None = None,
    *,
    output_model: type[BaseModel] | None = None,
) -> BaseModel | None:
    if agent is None:
        agent = Agent(model=model, structured_output_model=output_model)
    result = await agent.invoke_async(prompt, structured_output_model=output_model)
    return result.structured_output
```

- [x] **1.8 Run the test from 1.5; confirm it passes.**

- [x] **1.9 Convert the knowledge-construction stage.** In `run_knowledge_construction` (currently uses `_parse_extraction(str(raw))`), build one reusable agent and switch `_extract` to typed access (keeping the existing `Agent(...)` construction `try/except` → `agent = None` fallback), then update the batch loop to iterate typed fields:

```python
    try:
        agent = Agent(model=context.model, structured_output_model=ExtractionOutput)
    except Exception:
        agent = None

    sem = asyncio.Semaphore(LLM_MAX_CONCURRENCY)

    async def _extract(chunk: dict) -> tuple[ExtractionOutput | None, str]:
        content = chunk.get("content", "")
        cid = chunk.get("id", "unknown")
        if not content.strip():
            return None, cid
        prompt = EXTRACTION_PROMPT.format(content=content[:2000])
        try:
            async with sem:
                extracted = await asyncio.wait_for(
                    _llm_generate(context.model, prompt, agent=agent, output_model=ExtractionOutput),
                    timeout=CHUNK_TIMEOUT_SECONDS,
                )
            return extracted, cid
        except Exception as exc:
            logger.warning("knowledge_extraction_chunk_failed chunk=%s err=%s", cid, exc)
            return None, cid
```

The batch loop body changes from `parsed.get("facts", [])` / `parsed.get("relationships", [])` / `parsed.get("procedures", [])` to typed access:

```python
        for chunk, (extracted, chunk_id) in zip(batch, extracted_results):
            if extracted is None:
                result.failed_chunks.append(chunk_id)
                continue

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
                for rel in extracted.relationships:
                    await context.docgraph.link(
                        source_key=rel.source,
                        target_key=rel.target,
                        relation_type=rel.type,
                        org_id=org_id,
                    )
                    result.relationship_count += 1

                for proc in extracted.procedures:
                    await context.candidates.enqueue(
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
                    result.candidate_count += 1
            except Exception as exc:
                logger.warning("knowledge_postprocess_failed chunk=%s err=%s", chunk_id, exc)
                result.failed_chunks.append(chunk_id)
```

After this step, `_parse_extraction` is dead code but still works for the interim — do **not** delete it yet; its deletion step is 1.15 (keeps every commit green and reviewable). Note the original `invalid_relation_type` warning block is gone here — normalization is now handled inside the `Relationship` validator.

- [x] **1.10 Convert the initial-evaluation stage.** In `run_initial_evaluation`, build `agent = Agent(model=context.model, structured_output_model=EvaluationScores)` (same `try/except` → `None` fallback pattern) and change `_evaluate`:

```python
        async def _evaluate(doc: dict) -> EvaluationScores | None:
            content = doc.get("content", "")
            title = doc.get("metadata", {}).get("title", "Untitled")
            if not content.strip():
                return None
            prompt = EVALUATION_LLM_PROMPT.format(title=title, content=content[:2000])
            try:
                async with sem:
                    scores = await asyncio.wait_for(
                        _llm_generate(context.model, prompt, agent=agent, output_model=EvaluationScores),
                        timeout=CHUNK_TIMEOUT_SECONDS,
                    )
                return scores
            except Exception as exc:
                logger.warning("evaluation_llm_chunk_failed doc=%s err=%s", title, exc)
                return None
```

Change the blend loop that consumes `eval_results` from string/`_parse_llm_scores` indexing to `getattr`. **Keep the progress-publishing block inside the loop intact** (the existing `for` does blending *and* emits `tool_progress`/`stage_progress` every 10 results — do not drop it):

```python
        for i, scores in enumerate(eval_results):
            if scores:
                for dim in llm_scores:
                    llm_scores[dim] += getattr(scores, dim)
                llm_count += 1

            if publish and (i + 1) % 10 == 0:
                processed = i + 1
                await publish("tool_progress", {
                    "name": "initial_evaluation",
                    "processed": processed,
                    "total": eval_total,
                })
                pct = processed / eval_total
                await publish("stage_progress", {
                    "stage": "initial_evaluation",
                    "progress": min(int(pct * 100), 95),
                })
```

- [x] **1.11 Convert the recommendations stage.** In `run_recommendations`, replace the fence-strip + `json.loads(parsed_text)` handling (currently around lines 558-570) with:

```python
    try:
        try:
            agent = Agent(model=context.model, structured_output_model=RecommendationList)
        except Exception:
            agent = None
        parsed = await _llm_generate(context.model, prompt, agent=agent, output_model=RecommendationList)
        if parsed is None:
            return []
        return list(parsed.items)
    except Exception as exc:
        logger.warning("recommendations_generation_failed err=%s", exc)
        return []
```

- [x] **1.12 Update existing stage tests to return model instances instead of JSON strings.** Every test that stubs `Agent` (via the `patch("draftly.workflows.onboarding.stages.Agent")` + `mock_agent.invoke_async = AsyncMock(return_value=...)` pattern) or monkeypatches `stages._llm_generate` must now return `fake_agent_result(<model instance>)` / a model instance. Concretely, in `tests/unit/workflows/test_onboarding_stages.py`:

  - `test_knowledge_construction_extracts_from_chunks`: return `fake_agent_result(ExtractionOutput(facts=["Install via npm"], relationships=[Relationship(source="npm", target="install", type="DOCUMENTED_BY")], procedures=[Procedure(title="Run", steps=["Run npm start"])]))`. (Add `Procedure` to the module imports.)
  - `test_knowledge_construction_maps_invalid_relation_type` and `test_knowledge_construction_preserves_valid_relation_type`: build the mock value via `fake_agent_result(ExtractionOutput.model_validate({...}))` with raw dicts (respectively `type: "contains"` and `type: "IMPLEMENTS"`) so the real provider→schema path is exercised; the existing `context.docgraph.link.call_args.kwargs["relation_type"] == "DERIVED_FROM"` / `== "IMPLEMENTS"` assertions carry over unchanged.
  - `test_knowledge_construction_skips_failed_chunks`: `side_effect=[fake_agent_result(ExtractionOutput(facts=["APIs exist"])), RuntimeError("chunk failed")]`.
  - `test_knowledge_construction_batches_fact_storage_per_batch`: return `fake_agent_result(ExtractionOutput(facts=["Fact A", "Fact B"]))`; keep `store_batch.assert_awaited_once()` and `len(args[0]) == 6`.
  - `test_knowledge_construction_publishes_granular_stage_progress` / `test_initial_evaluation_publishes_granular_stage_progress`: return `fake_agent_result(ExtractionOutput(facts=["f"]))` / `fake_agent_result(EvaluationScores(coverage=0.8, completeness=0.7, structure=0.6, length=0.5))`.
  - All `fake_llm` / `slow_llm` / concurrency fakes monkeypatching `_llm_generate` (sampled-eval, per-doc eval, timeout, concurrency cap): change signature to `async def fake_llm(model, prompt, agent=None, *, output_model=None)` (the stages now call with the `output_model=` keyword) and return `EvaluationScores(coverage=0.8, completeness=0.7, structure=0.6, length=0.5)` (or `ExtractionOutput(...)` for the extraction-side ones); `slow_llm` keeps its `await asyncio.sleep(...)` then returns an `ExtractionOutput(...)`.
  - `test_initial_evaluation_llm_failure_falls_back_to_heuristics` and `test_recommendations_handles_llm_failure`: unchanged (generic `RuntimeError` side effects still hit the `except Exception` guards).
  - `test_recommendations_generates_suggestions`: return `fake_agent_result(RecommendationList(items=[Recommendation(priority="high", title="Add API reference", detail="Your docs lack API reference sections.", category="coverage")]))`; keep `recs[0].priority == "high"` and `recs[0].title == "Add API reference"`.

- [x] **1.13 Run the full stage test file; iterate until green:**

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
```

- [x] **1.14 Delete the legacy parser tests.** Remove `test_parse_extraction_handles_fenced_unfenced_and_invalid` from the test file.

- [x] **1.15 Delete the legacy parsers + dead import.** In `stages.py`, remove the `_parse_extraction` and `_parse_llm_scores` functions, and **remove `import json`** (its only uses were the two parsers and the recommendations inline `json.loads` — all gone now). Keep `import re` (still used by `CODE_BLOCK_PATTERN`/`HEADING_PATTERN` at 149-150 and `re.search` at line 389). Verify no references remain:

```bash
grep -rn "_parse_extraction\|_parse_llm_scores" src tests
```

- [x] **1.16 Full green + lint.** Run the stage file again, then the whole unit suite and ruff:

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
.venv/bin/python -m pytest tests/unit -q
ruff check src tests workers
```

- [x] **1.17 Commit** _(skipped — user instructed not to commit changes)_ (inside `draftly-agent-backend`):


```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat: use typed structured output in onboarding stages"
```

---

## Task 2 — Token budget caps per LLM call

### Files
- Modify: `src/draftly/workflows/onboarding/stages.py`
- Modify: `tests/unit/workflows/test_onboarding_stages.py`

### Interfaces Produced
- `stages.LLM_TOTAL_TOKENS_CAP` — `int(os.environ.get("LLM_TOTAL_TOKENS_CAP", "12000"))` (green, env-driven, mirrors `LLM_MAX_CONCURRENCY`).
- `stages.LLM_LIMITS` — `{"total_tokens": LLM_TOTAL_TOKENS_CAP}` when cap `> 0`, else `None`. Passed to every `invoke_async`.

### Steps

- [x] **2.1 Write a failing test.**

```python
@pytest.mark.asyncio
async def test_llm_generate_passes_token_budget_limits():
    with patch("draftly.workflows.onboarding.stages.Agent") as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(
            return_value=fake_agent_result(EvaluationScores(coverage=0.5, completeness=0.5, structure=0.5, length=0.5))
        )
        await stages._llm_generate(MagicMock(), "p", output_model=EvaluationScores)
    kwargs = mock_agent.invoke_async.call_args.kwargs
    assert kwargs["limits"] == {"total_tokens": stages.LLM_TOTAL_TOKENS_CAP}
```

- [x] **2.2 Run it; confirm it fails** (`limits` is not currently passed), e.g. `assert "limits" in kwargs` fails.

- [x] **2.3 Implement.** Add near the other constants:

```python
LLM_TOTAL_TOKENS_CAP = int(os.environ.get("LLM_TOTAL_TOKENS_CAP", "12000"))
LLM_LIMITS = {"total_tokens": LLM_TOTAL_TOKENS_CAP} if LLM_TOTAL_TOKENS_CAP > 0 else None
```

In `_llm_generate`, change the invoke line to:

```python
    result = await agent.invoke_async(prompt, structured_output_model=output_model, limits=LLM_LIMITS)
```

- [x] **2.4 Extend the test for the cap-disabled path.**

```python
@pytest.mark.asyncio
async def test_llm_generate_token_limits_none_when_cap_disabled(monkeypatch):
    monkeypatch.setattr(stages, "LLM_TOTAL_TOKENS_CAP", 0)
    monkeypatch.setattr(stages, "LLM_LIMITS", None)
    with patch("draftly.workflows.onboarding.stages.Agent") as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(return_value=fake_agent_result())
        await stages._llm_generate(MagicMock(), "p", output_model=EvaluationScores)
    assert mock_agent.invoke_async.call_args.kwargs["limits"] is None
```

- [x] **2.5 Stage file + ruff green:**

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
ruff check src tests workers
```

- [x] **2.6 Commit:** _(skipped — user instructed not to commit changes)_


```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat: enforce total-token budget on onboarding LLM calls"
```

---

## Task 3 — Token-usage telemetry

### Files
- Modify: `src/draftly/workflows/onboarding/stages.py`
- Modify: `tests/unit/workflows/test_onboarding_stages.py`

### Interfaces Produced
- `stages._metrics: Metrics` — module-level, defaults to the shared registry (`from draftly.observability.metrics import metrics as _metrics_default`), swap-injectable by tests.
- `_record_usage(result) -> None` — increments `draftly_tokens_input_total` and `draftly_tokens_output_total` from `result.metrics.accumulated_usage`, skipping zero/absent values (parity with `runner.py`).
- `_llm_generate` now calls `_record_usage(result)` after each invoke.

### Steps

- [x] **3.1 Write failing tests.**

```python
@pytest.mark.asyncio
async def test_llm_generate_records_token_usage(monkeypatch):
    from draftly.observability.metrics import Metrics

    fake_metrics = Metrics()
    monkeypatch.setattr(stages, "_metrics", fake_metrics)
    with patch("draftly.workflows.onboarding.stages.Agent") as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(
            return_value=fake_agent_result(
                EvaluationScores(coverage=0.5, completeness=0.5, structure=0.5, length=0.5),
                usage={"inputTokens": 200, "outputTokens": 80},
            )
        )
        await stages._llm_generate(MagicMock(), "p", output_model=EvaluationScores)
    snapshot = fake_metrics.snapshot()
    assert snapshot["counters"]["draftly_tokens_input_total"] == 200.0
    assert snapshot["counters"]["draftly_tokens_output_total"] == 80.0


@pytest.mark.asyncio
async def test_llm_generate_skips_zero_token_usage(monkeypatch):
    from draftly.observability.metrics import Metrics

    fake_metrics = Metrics()
    monkeypatch.setattr(stages, "_metrics", fake_metrics)
    with patch("draftly.workflows.onboarding.stages.Agent") as mock_agent_cls:
        mock_agent = mock_agent_cls.return_value
        mock_agent.invoke_async = AsyncMock(
            return_value=fake_agent_result(usage={}),
        )
        await stages._llm_generate(MagicMock(), "p", output_model=EvaluationScores)
    assert fake_metrics.snapshot()["counters"] == {}
```

(`Metrics.snapshot()` verified against `src/draftly/observability/metrics.py:65-73` — it returns `{"counters": {...}, "gauges": {...}, "timings": {...}}`, hence the `["counters"]` access in the assertions.)

- [x] **3.2 Run; confirm they fail** (`_metrics` / `_record_usage` don't exist yet).

- [x] **3.3 Implement** in `stages.py`:

```python
from draftly.observability.metrics import Metrics, metrics as _metrics_default

_metrics: Metrics = _metrics_default


def _record_usage(result: Any) -> None:
    usage = getattr(result.metrics, "accumulated_usage", None)
    if not isinstance(usage, dict):
        return
    input_tokens = usage.get("inputTokens")
    output_tokens = usage.get("outputTokens")
    if input_tokens:
        _metrics.increment("draftly_tokens_input_total", float(input_tokens))
    if output_tokens:
        _metrics.increment("draftly_tokens_output_total", float(output_tokens))
```

Add `_record_usage(result)` as the last line of `_llm_generate`.

- [x] **3.4 Stage file + ruff green:**

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
ruff check src tests workers
```

- [x] **3.5 Commit:** _(skipped — user instructed not to commit changes)_


```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat: emit draftly_tokens_* metrics from onboarding stages"
```

---

## Task 4 — Slim the three prompts

The output schema now carries the structure, so the prompts drop JSON/fence boilerplate. Behavior (facts/relations/procedures, four 0-1 dimensions, 3-5 prioritized recommendations) is unchanged; the schema `Field` constraints and `Literal["high","medium","low"]` carry what the old prose conveyed.

### Files
- Modify: `src/draftly/workflows/onboarding/stages.py`
- Modify: `tests/unit/workflows/test_onboarding_stages.py`

### Steps

- [x] **4.1 Write a failing regression test guarding the slim goal.**

```python
def test_extraction_prompt_has_no_json_boilerplate():
    assert "markdown fences" not in stages.EXTRACTION_PROMPT
    assert "Return ONLY valid JSON" not in stages.EXTRACTION_PROMPT


def test_evaluation_prompt_has_no_json_boilerplate():
    assert "markdown fences" not in stages.EVALUATION_LLM_PROMPT
    assert "Return ONLY valid JSON" not in stages.EVALUATION_LLM_PROMPT
```

- [x] **4.2 Run; confirm the assertions fail** against the current prompt text.

- [x] **4.3 Replace `EXTRACTION_PROMPT`** (currently ~50 lines of schema prose):

```python
EXTRACTION_PROMPT = """Extract structured knowledge from this documentation chunk.

Chunk content:
{content}"""
```

- [x] **4.4 Replace `EVALUATION_LLM_PROMPT`** (keep `{title}` / `{content}` placeholders):

```python
EVALUATION_LLM_PROMPT = """Evaluate this documentation's quality. Rate each dimension from 0.0 (poor) to 1.0 (excellent): coverage, completeness, structure, length.

Documentation title: {title}
Content:
{content}"""
```

- [x] **4.5 Replace `RECOMMENDATION_PROMPT`** (keep all existing metric placeholders; drop the JSON-array instructions):

```python
RECOMMENDATION_PROMPT = """You are a documentation quality advisor. Based on the metrics below, generate 3-5 prioritized recommendations for improving the documentation.

Health Score: {health_score:.2f}/1.0
Document Count: {document_count}
Chunk Count: {chunk_count}

Dimension Scores (0-1):
- Coverage: {coverage:.2f}
- Completeness: {completeness:.2f}
- Structure: {structure:.2f}
- Length: {length:.2f}

Low-scoring dimensions need the most attention."""
```

The `RecommendationList` wrapper model (not a bare list type) is what makes the array shape expressible via `structured_output_model`; the new prompt deliberately drops "Return a JSON array". During Task 5 verification, confirm the live recommendation path still produces items; if the model under-delivers, add short `Field(description=...)` strings to the schemas (a follow-up, not in scope).

- [x] **4.6 Green check:**

```bash
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py -q
.venv/bin/python -m pytest tests/unit -q
ruff check src tests workers
```

- [x] **4.7 Commit:** _(skipped — user instructed not to commit changes)_


```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "refactor: slim onboarding prompts to remove json boilerplate"
```

---

## Task 5 — Full verification and close-out

### Steps

- [x] **5.1 Full backend suite + ruff clean:**

```bash
.venv/bin/python -m pytest tests -q
ruff check src tests workers
```

- [x] **5.2 Confirm no stage-string-parsing language remains:**

```bash
grep -rnE "markdown fences|_parse_extraction|_parse_llm_scores|Return ONLY valid JSON|json.loads" src/draftly/workflows/onboarding/stages.py || echo "clean"
```

- [x] **5.3 Update plan-completion notes**: mark every checkbox above as done; append a short "Outcome" section summarizing the before/after (string parsing → typed models; add `limits` + token metrics; prompts slimmed) plus the measured test counts (`tests/unit` pass count and ruff result).

- [x] **5.4 Refresh the knowledge graph** (AST-only, no API cost), from the workspace root:

```bash
graphify update .
```

- [x] **5.5 Final review check:** stages are green, ruff clean, graph refreshed. Return to the user with a summary; do not run the repo-wide lint/tsc/frontend suites (frontend untouched by this plan).

## Outcome

All three onboarding stages now produce schema-validated typed output instead of parsing LLM JSON strings.

- **Before:** ad-hoc string parsing — `_parse_extraction`, `_parse_llm_scores`, and a fence-strip + `json.loads` block inside `run_recommendations`; the dataclass `Recommendation` was hand-populated from parsed dicts.
- **After:** pydantic `Relationship` / `Procedure` / `ExtractionOutput` / `EvaluationScores` / `Recommendation` / `RecommendationList` models. `_llm_generate(..., output_model=...)` now passes the model as the Strands `structured_output_model` and returns `result.structured_output`; `Relationship.type` normalizes to the `VALID_RELATION_TYPES` set and unknown types fall back to `DERIVED_FROM` (the old `invalid_relation_type` warning log is gone — encoding handles it).
- **Token budget:** every LLM call passes `limits={"total_tokens": LLM_TOTAL_TOKENS_CAP}` (env `LLM_TOTAL_TOKENS_CAP`, default `12000`; `"0"` disables). 
- **Token telemetry:** `_llm_generate` records `result.metrics.accumulated_usage` into the `draftly_tokens_input_total` / `draftly_tokens_output_total` counters (parity with `runner.py`; zero totals are skipped).
- **Prompts slimmed:** `EXTRACTION_PROMPT`, `EVALUATION_LLM_PROMPT`, and `RECOMMENDATION_PROMPT` drop the JSON-schema prose and "Return ONLY valid JSON, no markdown fences" boilerplate — the schema carries that structure now.
- **Commits skipped** per explicit user instruction ("execute the plan and don't commit changes").

**Measured:** `tests/unit/workflows/test_onboarding_stages.py` — 38 passed; `tests/unit` — 327 passed; full `tests` — 772 passed, 5 skipped; `ruff check src tests workers` — clean; `graphify update .` — 12549 nodes, 19132 edges, 835 communities.

## Plan amendments

This project uses a plan amendment workflow. When instructions from the executor reveal missing constraints, ambiguity, or complexity, append amendments here (Task X, Reason, Constraints) rather than rewriting the tasks above. The working tree drives the implementation; this section is a review journal.

- **Task 1/4, skip commits:** user explicitly instructed not to commit changes; commit steps (1.17, 2.6, 3.5, 4.7) marked skipped.
- **Task 1.12, extra imports:** the updated mocks also needed `Procedure` and `Recommendation` in the test module imports (plan listed only the schema names used by the 1.1 tests).
- **Task 4.3-4.5, E501:** the slimmed `EVALUATION_LLM_PROMPT` and `RECOMMENDATION_PROMPT` first lines exceed 100 chars; wrapped with adjacent string-literal concatenation to preserve the exact prompt text (no embedded newlines).
- **Task 4, no refactor needed:** the recommendations prompt formatting stayed inline in `run_recommendations` (the earlier `build_recommendations_prompt` refactor is not part of this plan revision).