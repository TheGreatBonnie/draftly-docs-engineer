# Implement Tavily-RAG (two-path RAG in `draftly-agent-backend`)

**Date:** 2026-09-20
**Status:** Approved (spec) → Ready to implement (this plan)
**Spec:** `docs/superpowers/specs/2026-09-20-tavily-rag-design.md` (414 lines, Approved)
**Scope:** `draftly-agent-backend` onboarding initialization + PR documentation workflow
**Working dir:** `/Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend`

## Summary

Implement the two-path RAG architecture. Tavily is the ingestion/freshness layer
only — never the permanent vector DB. The primary retrieval path is Draftly's
existing pgvector + full-text index over `memory_items`/`memory_embeddings`
(namespace `documents`); restricted Tavily live search is the fallback when the
index is stale/insufficient. Delivered in four independently-deployable phases,
each reversible by disabling its env flag (`TAVILY_PUBLIC_INGESTION_ENABLED`,
`TAVILY_RESEARCH_ENABLED`, `TAVILY_LIVE_FALLBACK_ENABLED`).

## Status of Context

- All code discovery is done; every referenced symbol/file below was verified in
  the working tree.
- Constants baked in (not placeholders): score blend, confidence thresholds,
  stage weights, eval blend, env block, migration number.
- Confirmed revision decisions that the plan locks in:
  1. **Metadata JSONB for page info** — 059 adds only the generated TSVECTOR
     column + GIN. `source_type`/`source_id`/`source_url`/`page_type`/`section`/
     `content_hash`/`indexed_at`/`source_updated_at` travel in the existing
     `metadata` JSONB (chunks + document rows) because
     `DatabaseMemoryStore.insert()` does not persist the `source_type`/`source_id`
     columns through the domain path, and `memory_items.metadata` is already
     `jsonb` with `extra="allow"` on `MemoryItem`.
  2. **Migration 059** is minimal: `ALTER TABLE memory_items ADD COLUMN
     content_search_vector TSVECTOR GENERATED ALWAYS AS
     (to_tsvector('english', coalesce(content, ''))) STORED` + `CREATE INDEX
     ... USING GIN (content_search_vector)`. Idempotent under
     `scripts/bootstrap.py` (skips `already exists`/`duplicate`, raises
     otherwise).
  3. **`RagRetrieval`** returns `RagResult(results, confidence, source)` with
     `source in {"local","tavily","none"}`; `_local_retrieve` is one SQL join;
     Python does the blend + rerank + confidence; routing is a pure function.
  4. **Tool re-point keeps legacy for non-`documents` namespaces.** The three
     search tools delegate to `RagRetrieval` only when the resolved scope
     namespace is `documents`; other namespaces and the memory-curator tools
     keep today's behavior (prevents breaking support/slack/discord surfaces).
  5. **Stage 4 health report is byte-for-byte unchanged**; public-doc freshness
     is fed through the existing `last_committed_dates` list populated from
     `SourceDocument.source_updated_at`/`indexed_at`.
  6. **TavilyClient gets injectable transport** (unlike `GitHubClient` which
     builds its own `httpx.AsyncClient`); default tests use
     `httpx.MockTransport`, no live network.

## File Structure Map

### New files

```
docs/superpowers/plans/2026-09-20-tavily-rag.md   (this file)

draftly-agent-backend/
  src/draftly/
    integrations/tavily/
      __init__.py                       # re-export TavilyClient, TavilyError taxonomy
      errors.py                         # tavily error taxonomy + retry classification
      client.py                         # async typed client: map/crawl/extract/search/research
      models.py                         # request/response models (pydantic) + TavilyUsage
    documentation/
      source_models.py                  # SourceType, PublicDocumentationConfig, SourceDocument, DiscoveryResult
      tavily_source.py                  # TavilyDocumentationSource (discover, sync), PublicSyncResult
      rag_retrieval.py                  # RagRetrieval.retrieve + RagResult + routing + page-type map
      page_type.py                      # derive_page_type(path), map_page_type(question_type)
    tools/search/live_docs_search.py    # @tool live_docs_search (flag-gated live fallback)

  persistence/migrations/
    059_docs_fulltext.sql               # TSVECTOR + GIN on memory_items.content

  tests/
    fakes/tavily.py                     # FakeTavilyClient (deterministic, no network)
    api/test_onboarding_public.py       # public source routes (next to test_onboarding_routes.py)
    unit/app/test_config_tavily.py
    unit/integrations/test_tavily_client.py
    unit/integrations/test_tavily_errors.py
    unit/integrations/test_fake_tavily_client.py
    unit/documentation/test_source_models.py
    unit/documentation/test_tavily_source.py
    unit/documentation/test_rag_retrieval.py
    unit/documentation/test_page_type.py
    unit/tools/test_live_docs_search.py
    unit/tools/test_search_repont.py
    unit/workflows/test_onboarding_stage_public.py
    unit/workflows/test_stage2_public.py
    unit/workflows/test_stage3_public.py
    unit/workflows/test_stage4_public.py
    unit/workflows/test_stage5_public.py
    unit/workflows/test_pr_docs_routing.py
    unit/workflows/test_docs_freshness.py
```

### Modified files

```
draftly-agent-backend/
  src/draftly/app/config.py                     # Settings: tavily_* fields + _validate_tavily model_validator
  src/draftly/app/api/routes/onboarding.py      # RepositoryRequest.source_type, public discovery, PublicDocumentationConfig validation
  src/draftly/workflows/onboarding/initialize.py# Stage 1 branch by source_type
  src/draftly/workflows/onboarding/stages.py    # Stages 2/3/5 research-backed paths
  src/draftly/tools/search/semantic_search.py   # delegate to RagRetrieval when namespace == documents
  src/draftly/tools/search/keyword_search.py    # delegate to RagRetrieval when namespace == documents
  src/draftly/tools/search/hybrid_search.py     # delegate to RagRetrieval when namespace == documents
  src/draftly/tools/search/__init__.py          # + live_docs_search export
  src/draftly/app/composition/tools.py          # register live_docs_search; add to _DOCUMENTATION_TOOLS
  src/draftly/agents/catalog.py                 # context_agent tool_keys += "live_docs_search" (flag-gated)
  src/draftly/agents/subagents.py               # docs_agent tool list += live docs (flag-gated)
  src/draftly/agents/shared/research.py         # build_docs_researcher honors live flag
  src/draftly/persistence/repositories/onboarding.py  # repository_config.upsert signature (source_type nullable)
```

## Global Constraints

These constraints apply across every task; re-read each before editing.

```text
final_score = 0.60 × vector_similarity (1 - (embedding <=> $1::vector))
            + 0.25 × full_text_rank     (ts_rank(content_search_vector, plainto_tsquery))
            + 0.10 × exact_identifier_match (metadata.source_id == query, bool→float)
            + 0.05 × page_type_priority (see page-type map)

confidence = best final_score across top-K
routing:  >= 0.78  -> local index only   ("local")
          0.60–0.78 -> combine local + Tavily live   ("tavily")
          <  0.60  -> Tavily live or abstain   ("none"/"tavily")

blend (evaluation, unchanged): dimension = 0.40 × heuristic + 0.60 × semantic
total (evaluation, unchanged): coverage 30% + completeness 30% + structure 20% + length 20%

Stage weights (unchanged): STAGE_WEIGHTS = {0.35, 0.35, 0.15, 0.075, 0.075}
Stage ids/labels/order (unchanged): repository_ingestion, knowledge_construction,
  initial_evaluation, health_report, recommendations
Event names (unchanged): stage_manifest, stage_change, stage_progress,
  tool_progress, workflow_result
```

```env
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_REQUEST_TIMEOUT_SECONDS=60
TAVILY_RESEARCH_POLL_TIMEOUT_SECONDS=300
TAVILY_MAX_CONCURRENCY=4
TAVILY_CREDIT_BUDGET=
TAVILY_PUBLIC_INGESTION_ENABLED=false
TAVILY_LIVE_FALLBACK_ENABLED=false
TAVILY_RESEARCH_ENABLED=false
```

Rules:

1. **No enabled Tavily feature without `TAVILY_API_KEY`** → raise at `Settings`
   construction (pydantic `model_validator`). No key + all flags off = valid.
2. **Private content never leaves Draftly.** `tavily_source` and
   `live_docs_search` only ever handle public URLs; GitHub/private sources never
   fall back to Tavily.
3. **Never delete valid indexed content on failed replacement.** Hash-skip →
   skip; hash differs → replace (retrieve+validate first); page gone → delete
   only after replacement succeeded for the others in that batch.
4. **Retryable = `rate_limit` | `timeout` | `upstream`** with bounded exp backoff
   + jitter honoring server guidance. `authentication`/`invalid_request`/
   `unsupported_url`/`credit_limit`/`invalid_response` never retry.
5. **No default test performs a live Tavily call.** Use `FakeTavilyClient` /
   `httpx.MockTransport`. Opt-in live sheet is `TAVILY_API_KEY`-gated,
   excluded from default CI.
6. **Logs/metrics never contain** page content, attached base64 files, API
   keys, or raw responses. Log org_id / run_id / stage / `request_id` / code.
7. **Do not reorder the five stages, don't rename events, don't change the
   persisted onboarding fields** (`selected_repository`, `confirmed_sources`,
   `state`, `steps`).
8. **Do not change grounding modes** (`local`/`github`/`docs`) or the `docs`
   grounding flag semantics; `docs` mode = index + live fallback with no repo
   token, which is achieved by tool availability inside `docs` grounding —
   grounding mode values are unchanged.
9. **`base`/`branch`/`head` commit comparison in PR workflow is untouched.**
   Only doc-retrieval tools change.

## Task Ordering (Dependency-Aware)

```
Phase 1  config→errors/transport→client→models→source→discover+sync→fakes/tests
Phase 2  → migration 059 → Stage 0/1 wiring (routes + initialize branch)
Phase 3  → RagRetrieval core → tool re-point → Stage 2 → Stage 3 → Stage 5 → Stage 4 freshness
Phase 4  → live_docs_search tool → agent/graph registration → freshness triggers
```

Each phase leaves the app fully functional (tests green).

## Phase 1 — Tavily client, source package, config, fake

### Task 1: Tavily configuration + flag validation

**Files:** `src/draftly/app/config.py`, new `tests/unit/app/test_config_tavily.py`

Add to `Settings` (note: config.py uses flat fields on `Settings`, not nested):

```python
    # ------------------------------------------------------------------
    # Tavily (spec: 2026-09-20-tavily-rag-design)
    # ------------------------------------------------------------------

    tavily_api_key: str | None = None
    tavily_base_url: str = "https://api.tavily.com"
    tavily_request_timeout_seconds: int = 60
    tavily_research_poll_timeout_seconds: int = 300
    tavily_max_concurrency: int = 4
    tavily_credit_budget: int | None = None
    tavily_public_ingestion_enabled: bool = False
    tavily_live_fallback_enabled: bool = False
    tavily_research_enabled: bool = False

    @model_validator(mode="after")
    def _validate_tavily(self) -> "Settings":
        flags = (
            ("TAVILY_PUBLIC_INGESTION_ENABLED", self.tavily_public_ingestion_enabled),
            ("TAVILY_LIVE_FALLBACK_ENABLED", self.tavily_live_fallback_enabled),
            ("TAVILY_RESEARCH_ENABLED", self.tavily_research_enabled),
        )
        enabled = [flag for flag, on in flags if on]
        if enabled and not self.tavily_api_key:
            names = ", ".join(enabled)
            raise ValueError(f"Tavily features enabled without TAVILY_API_KEY: {names}")
        if self.tavily_request_timeout_seconds <= 0:
            raise ValueError("tavily_request_timeout_seconds must be > 0")
        if self.tavily_research_poll_timeout_seconds <= 0:
            raise ValueError("tavily_research_poll_timeout_seconds must be > 0")
        if self.tavily_max_concurrency < 1:
            raise ValueError("tavily_max_concurrency must be >= 1")
        any_enabled = self.tavily_public_ingestion_enabled or self.tavily_live_fallback_enabled or self.tavily_research_enabled
        self._tavily_enabled = any_enabled
        return self
```

Add `_tavily_enabled: bool = False` class attribute so it's always present.
Add a property `tavily_enabled` reading it.

Delete the `Settings` import of `model_validator` (add to existing pydantic import
line: `from pydantic import AliasChoices, BaseModel, Field, model_validator`).

**TDD.**

- RED: `tests/unit/app/test_config_tavily.py`
  - `test_enabled_flag_without_key_raises` (each of the 3 flags)
  - `test_no_flags_and_no_key_valid`
  - `test_all_flags_off_with_key_valid`
  - `test_negative_timeout_raises`
  - `test_zero_concurrency_raises`
  - `test_tavily_enabled_property` (true when any flag on)
- GREEN: implement per above.
- REFACTOR: none needed (small).

**Escape hatch:** none — this is a one-file pure change; if validator conflicts
with `Settings()` in existing tests, adjust the validator **only** (never weaken
the no-key-with-flags rule). Run the config tests + `tests/unit/app`.

**Verification:** `python -m pytest tests/unit/app/test_config_tavily.py -q` then
`python -m pytest tests/unit/app -q`. `ruff check src/draftly/app/config.py`.

### Task 2: Tavily error taxonomy + transport

**Files:** new `src/draftly/integrations/tavily/errors.py`,
`src/draftly/integrations/tavily/__init__.py`, new
`tests/unit/integrations/test_tavily_errors.py`

```python
# src/draftly/integrations/tavily/errors.py
from __future__ import annotations

from enum import StrEnum


class TavilyErrorCode(StrEnum):
    AUTHENTICATION = "authentication"
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_URL = "unsupported_url"
    RATE_LIMIT = "rate_limit"
    CREDIT_LIMIT = "credit_limit"
    TIMEOUT = "timeout"
    UPSTREAM = "upstream"
    INVALID_RESPONSE = "invalid_response"


RETRYABLE = frozenset(
    {TavilyErrorCode.RATE_LIMIT, TavilyErrorCode.TIMEOUT, TavilyErrorCode.UPSTREAM}
)


class TavilyError(RuntimeError):
    """Normalized Tavily failure; `code` is always a TavilyErrorCode."""

    def __init__(
        self,
        code: TavilyErrorCode,
        message: str,
        *,
        request_id: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        self.code = code
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds
        super().__init__(message)


def is_retryable(code: TavilyErrorCode) -> bool:
    return code in RETRYABLE


def retry_backoff(attempt: int, *, base: float = 1.0, cap: float = 20.0, jitter: float = 0.2) -> float:
    """Exponential backoff with bounded jitter; attempt is 0-indexed."""
    import random
    delay = min(base * (2 ** attempt), cap)
    return delay * (1.0 + random.uniform(-jitter, jitter))
```

`__init__.py` re-exports: `TavilyClient` (lazy import in `__getattr__`), the
`TavilyErrorCode`, `TavilyError`, `is_retryable`.

**TDD.**

- RED: `tests/unit/integrations/test_tavily_errors.py`
  - `test_is_retryable_table` (rate_limit/timeout/upstream True; others False)
  - `test_backoff_monotonic_and_capped` (`attempt=0` < `attempt=5`, never > cap)
  - `test_error_carries_code_request_id_retry_after`
- GREEN: implement.
- REFACTOR: ensure no module-level import of `random` side effects (import inside
  function keeps module import-time clean).

**Verification:** pytest file + `ruff`.

### Task 3: Typed async Tavily client

**Files:** new `src/draftly/integrations/tavily/client.py`,
`src/draftly/integrations/tavily/models.py`, injectable transport; unit tests via
`httpx.MockTransport` (no network).

**`models.py`** — pydantic response models for each endpoint:

```python
class TavilyUsage(BaseModel):
    total_tokens: int | None = None
    credits_used: float | None = None
    extra_tokens: int | None = None

class SearchResult(BaseModel):
    title: str
    url: str
    content: str
    score: float | None = None
    raw_content: str | None = None
    published_date: str | None = None

class SearchResponse(BaseModel):
    results: list[SearchResult]
    usage: TavilyUsage | None = None
    request_id: str | None = None

class MapCandidate(BaseModel):
    url: str
    source: str | None = None

class MapResponse(BaseModel):
    urls: list[str]
    limit: int | None = None

class CrawlResult(BaseModel):
    url: str
    content: str
    markdown: str | None = None

class CrawlResponse(BaseModel):
    results: list[CrawlResult]
    usage: TavilyUsage | None = None
    request_id: str | None = None

class ExtractResult(BaseModel):
    url: str
    raw_content: str | None = None
    """When API returns raw_content, treat as markdown/text per format param."""

class ExtractFailed(BaseModel):
    url: str
    error: str

class ExtractResponse(BaseModel):
    results: list[ExtractResult]
    failed_results: list[ExtractFailed] = Field(default_factory=list)
    usage: TavilyUsage | None = None
    request_id: str | None = None

class ResearchResponse(BaseModel):
    request_id: str
    status: str  # "pending" | "completed" | "failed"
    content: Any = None
    usage: TavilyUsage | None = None

class ResearchPollResponse(BaseModel):
    request_id: str
    status: str
    content: Any = None
    sources: list[dict[str, str]] = Field(default_factory=list)
    usage: TavilyUsage | None = None
```

**`client.py`** — async typed client, injectable transport, per-spec params:

```python
class TavilyClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.tavily.com",
        timeout_seconds: int = 60,
        max_concurrency: int = 4,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._closed = False
        self._client = None
        ...
```

- Lazy `_client()` (mirror GitHubClient): `httpx.AsyncClient(base_url=..., timeout=...,
  transport=self._transport, headers={"Authorization": f"Bearer {self._api_key}"})`.
- `semaphore = asyncio.Semaphore(max_concurrency)` wrapping public methods.
- Methods:
  - `async def search(self, query, *, search_depth="advanced", max_results=8, chunks_per_source=3, include_domains=(), include_domains_mode="restrict", include_answer=False, include_raw_content=False) -> SearchResponse`
  - `async def map(self, url, *, max_depth=3, max_breadth=20, limit=50, select_paths=(), select_domains=(), exclude_paths=(), exclude_domains=(), categories=(), allow_external=False) -> MapResponse`
  - `async def crawl(self, url, *, max_depth, max_breadth, limit, select_paths=(), exclude_paths=(), exclude_domains=(), extract_depth="advanced", format="markdown", include_images=False) -> CrawlResponse`
  - `async def extract(self, urls: list[str], *, extract_depth="advanced", format="markdown") -> ExtractResponse` (≤20 URLs/batch, chunk internally)
  - `async def research(self, *, query, model="mini", files=(), output_schema: dict | None = None, max_tokens=None, include_domains=(), citation_format="markdown") -> ResearchResponse` (POST /research → 201)
  - `async def research_poll(self, request_id, *, poll_timeout_seconds: int) -> ResearchResponse` (GET /research/{id} loop; 202 → sleep+retry; 200 completed/failed; honor credit-limit/poll timeout → `TAVILY_RESEARCH_POLL_TIMEOUT_SECONDS`)
- Error normalization: `_translate(status_code, payload)` maps to taxonomy;
  capture `request_id` from headers/body; `rate_limit`/`credit_limit` attrs honor
  `Retry-After`.
- Structured logging (structlog) with org-scoped context passed by caller; fields
  `request_id`, `endpoint`, `latency_ms`, `status`, `credits_used`. Never log
  content/files/keys.
- `aclose()` closes the client; `__aenter__`/`__aexit__`.

**TDD.**

- RED: `tests/unit/integrations/test_tavily_client.py` using `httpx.MockTransport`
  with a canned responder:
  - `test_search_builds_request_and_parses` (assert method/URL/headers/body, parse SearchResponse)
  - `test_extract_chunks_to_20_and_collects_failed_results`
  - `test_research_create_returns_request_id` (201)
  - `test_research_poll_pending_to_completed` (202 then 200)
  - `test_research_poll_times_out_raises_timeout` (poll_timeout_seconds small)
  - `test_http_401_maps_to_authentication`
  - `test_http_429_maps_to_rate_limit_and_is_retryable`
  - `test_invalid_payload_maps_to_invalid_response`
  - `test_credit_limit_not_retryable`
  - `test_max_concurrency_bounded` (count concurrent in-flight in transport handler)
  - `test_logs_redact_content_and_keys` (capture emitted log fields; assert no key/content)
- GREEN: implement.
- REFACTOR: keep transport injectable; ensure `aclose` in tests.

**Verification:** `python -m pytest tests/unit/integrations/test_tavily_client.py -q`.
`ruff`.

### Task 4: FakeTavilyClient + source/migration-free seams

**Files:** new `tests/fakes/tavily.py`, extended `tests/fakes/__init__.py`

```python
# tests/fakes/tavily.py
"""Deterministic in-memory Tavily fake. Mirrors TavilyClient method surface."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FakeTavilyClient:
    map_urls: list[str] = field(default_factory=list)
    crawl_pages: dict[str, str] = field(default_factory=dict)   # url -> markdown
    extract_pages: dict[str, str] = field(default_factory=dict)
    search_results: list[dict] = field(default_factory=list)
    research_content: Any = None
    research_status: str = "completed"
    calls: list[tuple] = field(default_factory=list)
    fail_codes: list[str] = field(default_factory=list)   # queue of TavilyErrorCode

    async def map(self, url, **kwargs) -> MapResponse:
        self.calls.append(("map", url, kwargs))
        self._maybe_fail()
        return MapResponse(urls=self.map_urls)

    async def crawl(self, url, **kwargs) -> CrawlResponse:
        self.calls.append(("crawl", url, kwargs))
        self._maybe_fail()
        return CrawlResponse(results=[CrawlResult(url=u, content=c) for u, c in self.crawl_pages.items()])

    async def extract(self, urls, **kwargs) -> ExtractResponse:
        self.calls.append(("extract", list(urls), kwargs))
        self._maybe_fail()
        return ExtractResponse(results=[ExtractResult(url=u, raw_content=self.extract_pages.get(u, "")) for u in urls])

    async def search(self, query, **kwargs) -> SearchResponse:
        self.calls.append(("search", query, kwargs))
        self._maybe_fail()
        return SearchResponse(results=[SearchResult(**r) for r in self.search_results])

    async def research(self, **kwargs) -> ResearchResponse:
        self.calls.append(("research", kwargs))
        self._maybe_fail()
        return ResearchResponse(request_id="req-1", status="pending")

    async def research_poll(self, request_id, *, poll_timeout_seconds) -> ResearchResponse:
        return ResearchResponse(request_id=request_id, status=self.research_status, content=self.research_content)

    def _maybe_fail(self) -> None:
        if self.fail_codes:
            code = self.fail_codes.pop(0)
            from draftly.integrations.tavily.errors import TavilyError, TavilyErrorCode
            raise TavilyError(TavilyErrorCode(code), f"fake {code}")
```

Export `FakeTavilyClient` from `tests/fakes/__init__.py`.

**TDD.**

- RED: minimal smoke test `tests/unit/integrations/test_fake_tavily_client.py`:
  `test_no_network_and_deterministic`, `test_scripted_failures`.
- GREEN: implement.
- REFACTOR: none.

**Verification:** pytest file, `ruff`.

### Task 5: Source models

**Files:** new `src/draftly/documentation/source_models.py`, new
`tests/unit/documentation/test_source_models.py`

```python
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class SourceType(StrEnum):
    GITHUB_REPOSITORY = "github_repository"
    PUBLIC_DOCUMENTATION = "public_documentation"


class PublicDocumentationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    root_url: HttpUrl
    include_paths: list[str] = Field(default_factory=list, max_length=50)
    exclude_paths: list[str] = Field(default_factory=list, max_length=50)
    crawl_instructions: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _validate_https_and_no_creds(self) -> "PublicDocumentationConfig":
        url = str(self.root_url)
        if not url.lower().startswith("https://"):
            raise ValueError("root_url must be HTTPS")
        parsed = urlparse(url)
        if parsed.username or parsed.password:
            raise ValueError("root_url must not contain embedded credentials")
        for p in self.include_paths + self.exclude_paths:
            if len(p) < 1 or len(p) > 500:
                raise ValueError("path patterns must be 1..500 chars")
        return self


class SourceDocument(BaseModel):
    source_id: str        # canonical URL for public docs; repo path for GitHub
    path: str
    title: str
    content: str
    source_url: HttpUrl
    source_updated_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    # derived at ingestion: page_type, section, content_hash, indexed_at


class DiscoveryResult(BaseModel):
    source_type: SourceType
    candidates: list[str]          # canonical URLs
    total: int = 0
    skipped: int = 0
```

**TDD.**

- RED: `tests/unit/documentation/test_source_models.py`
  - `test_public_config_rejects_http_root`
  - `test_public_config_rejects_credentials_in_url`
  - `test_public_config_rejects_oversized_path_list` (max_length violation)
  - `test_public_config_rejects_path_pattern_too_long`
  - `test_public_config_valid_constructs`
  - `test_source_document_defaults` (metadata default_factory, optional updated_at)
  - `test_source_type_values`
- GREEN: implement.
- REFACTOR: none.

**Verification:** pytest file, `ruff`.

### Task 6: `TavilyDocumentationSource` discover + sync

**Files:** new `src/draftly/documentation/tavily_source.py`, new
`src/draftly/documentation/page_type.py`, new
`tests/unit/documentation/test_tavily_source.py`,
`tests/unit/documentation/test_page_type.py`

**`page_type.py`** (shared by sync + retrieval):

```python
PAGE_TYPES = ("tutorial", "how-to", "reference", "explanation", "index")

_TOKENS = {
    "tutorial": ("tutorial", "getting-started", "getting started", "quickstart"),
    "how-to": ("how-to", "howto", "guide", "guides", "how to"),
    "reference": ("reference", "ref", "api", "spec", "sdk", "syntax"),
    "explanation": ("concepts", "concept", "explanation", "background", "overview", "learn"),
    "index": ("index", "readme", "README", "welcome", ""),
}

def derive_page_type(path: str) -> str: ...
    # lowercased, basename + parent segments; first token hit wins; else "index"
    # deterministic, pure.

QUESTION_TYPE_PAGE_TYPES = {
    "signatures": ("reference",),
    "parameters": ("reference",),
    "procedures": ("how-to", "tutorial"),
    "concepts": ("explanation",),
    "general": PAGE_TYPES,   # no priority
}

def map_question_type(question_type: str) -> tuple[str, ...]: ...
```

**`tavily_source.py`:**

```python
class TavilyDocumentationSource:
    def __init__(self, client: TavilyClient, *, repositories) -> None:
        # repositories: the same bundle SyncService receives — DocumentRepository
        #   (documents.upsert/get_by_org_and_path), MemoryService
        #   (delete_by_metadata/store_batch), DocGraphService.
        ...

    async def discover(self, config: PublicDocumentationConfig) -> DiscoveryResult:
        resp = await self.client.map(
            str(config.root_url),
            max_depth=3,
            select_paths=config.include_paths or None,
            exclude_paths=config.exclude_paths or None,
            allow_external=False,
        )
        # dedupe, canonicalize (strip fragments/trailing-slash), filter by root
        # prefix; skip non-http(s)
        return DiscoveryResult(source_type=SourceType.PUBLIC_DOCUMENTATION,
                               candidates=candidates, total=len(candidates), skipped=skipped)

    async def sync(
        self,
        *,
        org_id: str,
        config: PublicDocumentationConfig,
        on_progress: ProgressCallback | None = None,
    ) -> PublicSyncResult:   # shares the SyncResult field contract
        # 1. crawl(root, same select/exclude) -> pages; count failed_results
        # 2. retry eligible failures via extract() in <=20 URL batches
        # 3. successes -> SourceDocument (title from first markdown heading or host+path;
        #    content = markdown; source_updated_at from crawl/extract if present)
        # 4. hash-skip: for each SourceDocument, compute content_hash = sha256(content.strip());
        #    compare against documents.get_by_org_and_path(org_id, path).get("source_hash");
        #    equal → skip, differs/empty → reprocess (mirror sync_service guard); skip when equal
        # 5. chunk + embed + upsert + baseline: reuse the exact pipeline SyncService
        #    uses — documents.upsert(..., source_hash=content_hash, metadata={...}),
        #    memory.delete_by_metadata(document_id) then Document(memory_type=
        #    "document_chunk") items + memory.store_batch(items),
        #    create_baseline(commit_sha=..., repository=..., ...)
        # 6. if zero documents stored and failures occurred -> raise
        #    TavilyError(TavilyErrorCode.UPSTREAM, ...) (hard failure; stage-fail path)
        # 7. return PublicSyncResult mirroring SyncResult's fields, with
        #    last_committed_dates=[d.source_updated_at for stored docs if trusted]
        ...
```

`PublicSyncResult` fields match `SyncResult` (`commit_sha`, `repository`,
`document_count`, `section_count`, `chunk_count`, `skipped_count`, `failed_files`,
`baseline`, `last_committed_dates`) so stage-1 wiring is a drop-in (see Task 8).
Reuse the exact seams `SyncService` uses —
read `src/draftly/documentation/sync_service.py`, `integrations/database/document_store.py`,
`persistence/repositories/documents.py` to mirror exact signatures and hashing
(`source_hash` semantics: content-hash, equal → skip; differs → replace;
page gone → delete chunks).

**TDD.**

- RED: `tests/unit/documentation/test_page_type.py`
  - `test_derive_page_type_tokens` (examples for each of 5 types + empty/root → index)
  - `test_map_question_type_priorities`
- RED: `tests/unit/documentation/test_tavily_source.py` (using `FakeTavilyClient`
  + a fake repositories bundle / in-memory `DocumentStore`)
  - `test_discover_dedupes_and_filters_off_root`
  - `test_discover_skips_non_http`
  - `test_sync_crawl_and_extract_retry_collects_failed`
  - `test_sync_hash_skip_skips_unchanged`
  - `test_sync_hash_change_replaces_chunks`
  - `test_sync_zero_stored_with_failures_raises`
  - `test_sync_no_deletion_on_failed_replacement` (AC6)
  - `test_sync_populates_last_committed_dates_from_source_updated_at`
  - `test_sync_uses_page_type_and_section_and_indexed_at_metadata`
  - `test_sync_persists_same_event_names` (`documentation_sync`, `tool_progress`)
- GREEN: implement per above, matching `SyncService` patterns.
- REFACTOR: factor `_canonicalize(url)` and `_hash(content)` helpers; keep the
  "retry eligible failures" loop bounded and list-driven.

**Verification:** `python -m pytest tests/unit/documentation/test_tavily_source.py
tests/unit/documentation/test_page_type.py -q`, then the full `sync_service`
unit suite to assert we didn't alter the GitHub path.

---

## Phase 2 — Migration 059 + Stage 0/1 wiring

### Task 7: Migration 059 — chunk full-text

**Files:** new `src/draftly/persistence/migrations/059_docs_fulltext.sql`

```sql
-- Tavily-RAG design: chunk-level full-text for keyword_search + hybrid blend
-- (spec: 2026-09-20-tavily-rag-design). Minimal: only the generated
-- TSVECTOR column + GIN index. Page/source metadata lives in memory_items.metadata
-- JSONB (existing column); no new metadata columns.

ALTER TABLE memory_items
    ADD COLUMN IF NOT EXISTS content_search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_memory_items_content_search_vector
    ON memory_items USING GIN (content_search_vector);
```

Verify idempotency under `scripts/bootstrap.py` (skips `already
exists`/`duplicate`, raises otherwise). Both statements use `IF NOT EXISTS`, so
re-running is safe for both skip and duplicate paths.

**TDD.** No Python unit test can run migration SQL without a DB — verification is
the bootstrap smoke path:
- `python scripts/bootstrap.py` against a scratch `DATABASE_URL` (the dev NeonDB
  or local pg), assert no raise and `\d memory_items` now shows
  `content_search_vector` and the GIN index. If live DB unavailable, gate behind
  existing live-suite marker and verify the SQL by review + `ruff` no-op.
- Regression: `python -m pytest tests/unit/documentation/test_rag_retrieval.py -q`
  (Task 10) requires this migration.

**Escape hatch:** if the dev workspace has no reachable DB, mark this task
`verified-by-SQL-review` (same standard as existing migrations with `IF NOT
EXISTS`) and rely on the live suite in Task 10/global verification.

**Verification:** bootstrap run + `ruff`.

### Task 8: Stage 0/1 wiring — routes + initialize branch

**Files:** `src/draftly/app/api/routes/onboarding.py`,
`src/draftly/workflows/onboarding/initialize.py`,
`src/draftly/persistence/repositories/onboarding.py`; new
`tests/api/test_onboarding_public.py` (route tests live in `tests/api/`, next to
the existing `test_onboarding_routes.py`), new
`tests/unit/workflows/test_onboarding_stage_public.py`

**Route changes (`onboarding.py`):**

- `RepositoryRequest`: add `source_type: SourceType = SourceType.GITHUB_REPOSITORY`
  (defaulted so existing rows/requests stay GitHub).
- `select_repository`: when `body.source_type == PUBLIC_DOCUMENTATION`, accept a
  `PublicDocumentationConfig` (pass through body as `documentation_config:
  PublicDocumentationConfig | None = None`), validate it (pydantic raises 422),
  **skip** the GitHub installation/access check, store config; else existing path.
- New `POST /documentation/discover` handling per spec stage 0:
  - when selected `source_type == PUBLIC_DOCUMENTATION`: build
    `TavilyDocumentationSource`, call `discover(config)`, return
    `{"candidates": [...]}`; same state machine/transition (`DISCOVERY` step).
  - else existing GitHub discovery.
- `confirm_sources`: persist `include`/`exclude`. For public mode store the
  confirmed `include_paths`/`exclude_paths` back into the saved config; the
  `repository_config.upsert` signature gains an optional `source_type` param
  (default `GITHUB_REPOSITORY`) and an optional public config payload.

**`initialize.py` changes (`run_onboarding_initialize`):**

- Read `source_type` from the selected repository payload; default
  `github_repository` when missing (spec: rows missing default).
- Stage 1 branch:
  - `github_repository` → existing `SyncService` (no change).
  - `public_documentation` → if `TAVILY_PUBLIC_INGESTION_ENABLED`: build
    `TavilyDocumentationSource` with a `TavilyClient` and call
    `sync(org_id=org_id, config=config, on_progress=...)`; if flag off → keep the
    GitHub path semantics (i.e., the source stays GitHub) so a public payload
    without the flag behaves like today.
- Emit **identical** `documentation_sync` / `tool_progress` / doc-count /
  chunk-count events and the same stage transitions (GitHub path manager
  `_documentation_sync` helper reused for public, same events, same progress
  hydration).

**Test seam:** the initialize path already builds `SyncService` via a helper —
add `TavilyClient`+`TavilyDocumentationSource` construction behind a factory
injectable in tests (patch the factory, mirror how `test_onboarding_stages.py`
patches `draftly.agents.factory.Agent`).

**TDD.**

- RED: `tests/api/test_onboarding_public.py`
  - `test_select_repository_github_still_requires_installation`
  - `test_select_repository_public_skips_github_access`
  - `test_select_repository_public_rejects_http_root` (422)
  - `test_discover_public_returns_candidates`
  - `test_confirm_sources_public_persists_config`
- RED: `tests/unit/workflows/test_onboarding_stage_public.py`
  - `test_stage1_public_ingestion_uses_tavily_source` (flag on, fake Tavily)
  - `test_stage1_metrics_mirror_github_flow` (event names identical)
  - `test_stage1_flag_off_falls_back_to_github_path`
- GREEN: implement.
- REFACTOR: extract a `_build_stage1_source(repos, settings)` factory so the
  flag branch is a tiny switch, not buried in the router.

**Verification:** `python -m pytest tests/api/test_onboarding_public.py
tests/unit/workflows/test_onboarding_stage_public.py -q` + run the existing
`tests/unit/workflows/test_onboarding_stages.py` and `tests/api` suites
(no regressions).

---

## Phase 3 — RAG retrieval core + research-backed stages

### Task 9: `RagRetrieval.retrieve` — hybrid blend, rerank, confidence, routing

**Files:** new `src/draftly/documentation/rag_retrieval.py`; new
`tests/unit/documentation/test_rag_retrieval.py`

```python
@dataclass(frozen=True)
class RagResult:
    results: list[dict[str, Any]]     # each: id, content, metadata, url/source_url,
                                      # score (final blended), page_type, section
    confidence: float                  # best final_score
    source: Literal["local", "tavily", "none"]
    question_type: str

class RagRetrieval:
    def __init__(self, *, db, embeddings, tavily_client: TavilyClient | None = None,
                 live_fallback_enabled: bool = False) -> None:
        # db: dependency-wired DatabaseClient (same interface VectorSearch uses)
        ...

    async def retrieve(
        self,
        *,
        org_id: str,
        query: str,
        product: str | None = None,
        version: str | None = None,
        question_type: str = "general",
        limit: int = 8,
    ) -> RagResult:
        rows = await self._local_retrieve(org_id, query, product=product, version=version,
                                          question_type=question_type, top_k=max(limit * 3, 20))
        scored = [self._score(row, question_type, query) for row in rows]
        scored.sort(key=lambda r: r["score"], reverse=True)
        results = scored[:limit]
        confidence = results[0]["score"] if results else 0.0
        if not results:
            source = "none"
        elif confidence >= 0.78:
            source = "local"
        elif self._live_enabled():
            source = "tavily"   # routing policy; live results combined below
            results = await self._combine_live(org_id, query, results, limit)
        else:
            source = "none"
        return RagResult(results=results, confidence=confidence, source=source, question_type=question_type)
```

**`_local_retrieve` SQL** (single join; mirrors `VectorSearch.search` shape):

```sql
SELECT
  mi.id::text                       AS id,
  mi.namespace,
  mi.content,
  mi.metadata,
  1 - (me.embedding <=> $1::vector) AS similarity,
  ts_rank(mi.content_search_vector, plainto_tsquery('english', $2)) AS fts_rank,
  mi.metadata->>'source_id'         AS source_id,
  mi.metadata->>'page_type'         AS page_type,
  mi.metadata->>'source_url'        AS source_url
FROM memory_embeddings me
JOIN memory_items mi ON mi.id = me.memory_item_id
WHERE mi.namespace = $3            -- 'documents'
  AND mi.org_id = $4
  AND mi.status = 'active'
  AND ($5::text IS NULL OR mi.metadata->>'product' = $5)
  AND ($6::text IS NULL OR mi.metadata->>'version' = $6)
  AND ($7::text IS NULL OR mi.metadata->>'source_type' = $7)
ORDER BY similarity DESC
LIMIT $8
```

- `$1` = query embedding (one embed call, `EmbeddingService`), `$2` = query text,
  `$3` = "documents", `$4` = org_id, `$5`/`$6` = product/version (nullable),
  `$7` = optional `source_type` filter, `$8` = top_k.
- `plainto_tsquery` on the raw query string — never the embedded vector.
- product/version/source_type are optional; with all null, unfiltered (spec:
  "filtered by product/version/source_type when needed").

**`_score`** (Python, deterministic):

```python
def _score(row: dict, question_type: str, query: str) -> dict:
    similarity = row["similarity"] if row.get("similarity") is not None else 0.0
    fts = row["fts_rank"] if row.get("fts_rank") is not None else 0.0
    source_id = row.get("source_id") or ""
    exact = 1.0 if (source_id == query or source_id.rstrip("/") == query.rstrip("/")) else 0.0
    page_types = map_question_type(question_type)
    ptype = row.get("page_type") or "index"
    page_priority = 1.0 if ptype in page_types else 0.40
    score = 0.60 * similarity + 0.25 * fts + 0.10 * exact + 0.05 * page_priority
    return {**row, "score": round(score, 6)}
```

**`_combine_live`** — call `tavily.search(query=f"{product} documentation: {query}",
search_depth="advanced", max_results=limit, chunks_per_source=3,
include_domains=[host], include_domains_mode="restrict", include_answer=False,
include_raw_content=False)`, filter
`url.startswith(corpus_docs_prefix)`, normalize to the same result dict shape with
`source_url`, `score=None`, `metadata={"source": "tavily"}`; combine local +
live; take top `limit` by final score (live rows given the same blend formula's
local-equivalent weight — see REFACTOR note: keep live as `score`-appended and
stable-sorted so an unchanged local result never shifts on identical inputs).

The `host` and `corpus_docs_prefix` come from `PublicDocumentationConfig` of the
org (resolved via the documents `DocumentRepository`/config store); when a
public config is absent, `_live_enabled()` is False (no live fallback for GitHub/
private sources — privacy rule 2).

**TDD.**

- RED: `tests/unit/documentation/test_rag_retrieval.py` (mock DB rows, fake
  embeddings, monkeypatched `EmbeddingService`, fake Tavily for live path)
  - `test_blend_weights` (construct rows with known similarity/fts/exact/page and
    assert exact blend numerics, e.g. all-max → score 1.0)
  - `test_exact_source_id_bonus` (source_id == query beats fuzzy)
  - `test_page_type_priority_for_question_type` (procedures prefers how-to/tutorial)
  - `test_no_rows_returns_source_none`
  - `test_routing_local_when_ge_078` (confidence >= 0.78 → "local", no Tavily call)
  - `test_routing_combine_when_060_to_078` (0.60..0.78 → tavily invoked, results combined)
  - `test_routing_none_or_live_below_060` (< 0.60 without live → "none"; with live → "tavily")
  - `test_product_version_source_type_filters`
  - `test_never_calls_live_for_private_source` (no public config → no tavily call)
- GREEN: implement.
- REFACTOR: separate `_build_query_embedding` and `_live_enabled` so tests never
  embed twice and live path is trivially mockable.

**Verification:** `python -m pytest tests/unit/documentation/test_rag_retrieval.py -q`; `ruff`.

### Task 10: Upgrade `keyword_search` to full-text + re-point tools to `RagRetrieval`

**Files:** `src/draftly/tools/search/keyword_search.py`,
`src/draftly/tools/search/semantic_search.py`,
`src/draftly/tools/search/hybrid_search.py`, new
`tests/unit/tools/test_search_repont.py`

Design (decision 4):

- Keep names/signatures (`(query, namespace, limit)`) — the Strands graph wiring
  and steering policy files reference these symbol names; do not break them.
- When `current_memory_scope().namespace == "documents"` (or namespace resolved
  to the docs namespace), delegate to `RagRetrieval.retrieve(org_id=scope.org_id,
  query=query, limit=limit, question_type=question_type_from_namespace)` and
  return `result.results` (map each row to the same dict contract they return
  today — `id`, `content`, `metadata`, plus new `url`/`source_url`).
- Otherwise, keep the existing behavior (memory-grounded tools unchanged;
  `keyword_search` still uses `_COLUMNS`/ILIKE for non-docs namespaces).
- The hybrid tool compute stays `0.7 semantic + 0.3 keyword` when both
  sub-calls delegate — for the docs namespace it becomes a single
  `RagRetrieval.retrieve` call (already the pre-blended sum); for non-docs it
  keeps today's arithmetic.
- Add `question_type` map to `RagRetrieval`: `question_type` from the *scope* or
  a default `"general"`. Because the three tools have no `question_type` param,
  add a small resolver `question_type_for(namespace)` defaulting to `"general"`.

**TDD.**

- RED: `tests/unit/tools/test_search_repont.py`
  - `test_docs_namespace_delegates_to_rag_retrieval` (three tools; scope
    namespace="documents"; assert RagRetrieval called, results carry url/source_url)
  - `test_non_docs_namespace_keeps_legacy_path` (namespace="solutions" → old behavior; no RagRetrieval call)
  - `test_keyword_search_uses_fts_rank_in_docs_namespace` (assert SQL/node uses
    `ts_rank`/`content_search_vector` — via a scripted query assertion hole)
  - `test_hybrid_docs_query_invokes_single_retrieve` (0.7/0.3 remains only for non-docs)
- GREEN: implement.
- REFACTOR: keep delegation one-liners; move shared "docs namespace?" check to a
  helper `is_documents_namespace(scope)`.

**Verification:** pytest file + full `tests/unit/tools -q` (existing tool tests
must pass unchanged, proving non-docs fallbacks hold).

### Task 11: Stage 2 — retrieval-guided synthesis (research shards)

**Files:** `src/draftly/workflows/onboarding/stages.py`, new
`tests/unit/workflows/test_stage2_public.py`

Behind `TAVILY_RESEARCH_ENABLED`. Replace the per-page LLM loop with
retrieval-guided synthesis when the source is public:

- Build deterministic shards: group pages from the POST-sync docs namespace;
  for each **page-type stratum** (tutorial/how-to/reference/explanation/index),
  pack pages into shards bounded by `≤ 5 files` and `≤ 80k words` combined
  (`build_research_shards(pages, question_type)` in `tavily_source.py` or a
  shared helper in `stages.py` — keep in `tavily_source.py` to reuse in Stage 3).
- Each shard → one `Research(model="mini", files=encode(shard),
  output_schema=ExtractionOutput)` where `encode` base64-encodes each page's
  markdown to a `.md` file entry. `include_domains=[root host]`.
- Output validation === today: relation-type whitelist
  (`IMPLEMENTS|DOCUMENTED_BY|AFFECTS|DERIVED_FROM`, else fallback `RELATED`),
  dedup before persistence via existing `memory.store_batch`,
  `docgraph.link_batch`, procedure-candidate writes; same event names.
- Per-shard failure → record that shard's pages' `source_id` into
  `failed_chunks`; retryable/credit-limit errors → existing
  `stage-fail` path (stop), never delete prior valid index rows (rule 3).

**TDD.**

- RED: `tests/unit/workflows/test_stage2_public.py`
  - `test_synthesis_uses_research_shards_not_per_page_loop` (fake Tavily research;
    assert number of research calls == number of shards, not number of pages)
  - `test_shard_respects_file_and_word_caps` (5 files/80k words)
  - `test_shard_failure_records_failed_sources`
  - `test_credit_limit_hard_fails_stage` (raises via existing stage-fail)
  - `test_relation_whitelist_and_dedup` (same gates as today)
  - `test_flag_off_keeps_existing_loop` (TAVILY_RESEARCH_ENABLED=false → no research calls)
- GREEN: implement.
- REFACTOR: none heavy.

**Verification:** pytest file + existing `tests/unit/workflows/test_onboarding_stages.py`.

### Task 12: Stage 3 — stratified index retrieval + unchanged 0.4/0.6 blend

**Files:** `src/draftly/workflows/onboarding/stages.py`, new
`tests/unit/workflows/test_stage3_public.py`

Behind `TAVILY_RESEARCH_ENABLED`:

- Replace the "25-doc semantic sample" with a stratified index retrieval:
  top-K per page-type stratum via `RagRetrieval.retrieve` (hybrid + rerank).
- One `Research(output_schema={coverage, structure, completeness, length})` call
  over the stratified sample → semantic dimension.
- Blend **byte-for-byte unchanged**: `dimension = 0.40 × heuristic + 0.60 ×
  semantic`; total = coverage 30% + completeness 30% + structure 20% + length
  20%. Extraction/validation identical.
- Research failure / invalid output → pure heuristics for that dimension (no
  raise; no partial blending).

**TDD.**

- RED: `tests/unit/workflows/test_stage3_public.py`
  - `test_stratified_sample_retrieved_per_page_type`
  - `test_semantic_dimension_from_research`
  - `test_blend_unchanged_040_060_and_weights`
  - `test_research_failure_falls_back_to_heuristics`
- GREEN: implement.
- REFACTOR: extract `_score_dimension(heuristic, semantic)` pure helper.

**Verification:** pytest file + existing stage tests.

### Task 13: Stage 5 — recommendations with gap evidence + `[]` on failure

**Files:** `src/draftly/workflows/onboarding/stages.py`, new
`tests/unit/workflows/test_stage5_public.py`

Behind `TAVILY_RESEARCH_ENABLED`:

- Inputs: eval dims, health dims, doc/chunk counts, plus **gap evidence** —
  topics (from map/from extracted section headings) whose index-retrieval
  confidence was low (`RagRetrieval` returned `< 0.60`, tracked during Stage 2/3).
- One `Research(output_schema=RecommendationList)` → 3–5 items with
  `priority`/`title`/`detail`/`category`.
- Schema validate; on failure or invalid output → `[]` (existing behavior;
  never invalidate a completed analysis).

**TDD.**

- RED: `tests/unit/workflows/test_stage5_public.py`
  - `test_recommendations_from_research_with_gap_evidence`
  - `test_recommendation_failure_returns_empty`
  - `test_recommendation_schema_validated` (5 items max, required fields)
  - `test_priority_title_detail_category_fields`
- GREEN: implement.

**Verification:** pytest file.

### Task 14: Stage 4 — public-doc freshness without formula change

**Files:** `src/draftly/workflows/onboarding/initialize.py` (already handled by
Task 6 `last_committed_dates` from `SourceDocument.source_updated_at`) + a
freshness regression test.

No change to `run_health_report`'s formula (`stale_after_days=90`,
`check_freshness`) — that is byte-for-byte preserved (ruled by decision 5). The
only input change: public sync passes `source_updated_at`/`indexed_at` values of
stored `SourceDocument`s for the `last_committed_dates` list when trustworthy,
else nothing (→ neutral 0.5), via the `InitializeState` plumbing that already
feeds `run_health_report`. Verify `check_freshness` handles `None`/empty list with
0.5 (read `validator.py` lines 13-23 to confirm the guard exists).

**TDD.**

- RED: `tests/unit/workflows/test_stage4_public.py`
  - `test_public_freshness_uses_source_updated_at`
  - `test_public_freshness_neutral_when_dates_missing`
  - `test_health_formula_unchanged` (fixed inputs → identical scores to today's
    expectations; assert equal to pre-change fixtures)
- GREEN: implement/verify.

**Verification:** pytest file + re-run `tests/unit/workflows`.

---

## Phase 4 — live fallback tool + PR workflow wiring + freshness triggers

### Task 15: `live_docs_search` tool + registration

**Files:** new `src/draftly/tools/search/live_docs_search.py`, modified
`src/draftly/tools/search/__init__.py`, `src/draftly/app/composition/tools.py`,
`src/draftly/agents/subagents.py`, `src/draftly/agents/catalog.py`,
`src/draftly/agents/shared/research.py`; new `tests/unit/tools/test_live_docs_search.py`

```python
@tool
async def live_docs_search(query: str, limit: int = 8) -> list[dict]:
    config = await _public_config_for_current_org()   # from onboarding store; None → []
    if not config:
        return []
    tavily = TavilyClient(api_key=_api_key(), timeout_seconds=_timeout(), transport=_transport_or_none())
    response = await tavily.search(
        query=f"{_corpus_display_name(config)} documentation: {query}",
        search_depth="advanced", max_results=limit, chunks_per_source=3,
        include_domains=[config.root_url.host or ""], include_domains_mode="restrict",
        include_answer=False, include_raw_content=False,
    )
    prefix = _corpus_docs_prefix(config)          # url prefix under root
    results = [r for r in response.results if r["url"].startswith(prefix)]
    return [{**r.model_dump(), "source_url": r.url, "metadata": {"source": "tavily"},
             "score": None} for r in results]
```

- `_public_config_for_current_org`: uses the same resolved onboarding/repository
  store as the workflow; when the org's source is private → `[]` (privacy rule 2).
- Query string uses org display-name prefix exactly per spec sample
  (`"{product} documentation: {query}"`).
- Host-level restriction + URL-prefix column filtering (rejects sibling sites on
  the same host) — both enforced.
- Flag-gated: `live_docs_search` returns `[]` immediately when
  `TAVILY_LIVE_FALLBACK_ENABLED` is off (test: flag off → no Tavily client
  construction).
- Register in:
  - `tools/search/__init__.py` `__all__`
  - `tools.py` `_RESEARCH_TOOLS`, `_DOCUMENTATION_TOOLS`, `_CONTENT_TOOLS`
  - `agents.catalog.context_agent` `tool_keys` (steering allowlist) when flag on
  - `agents.subagents.build_research_swarm` docs_agent tools list when flag on
  - `agents.shared.research.build_docs_researcher` (passes through)
- Steering catalog: `context_agent` uses `tool_keys` — the `live_docs_search`
  key must be allowlisted in `src/draftly/agents/catalog.py` (verify real key
  name indexed by the catalog store to avoid a silent drop).

**TDD.**

- RED: `tests/unit/tools/test_live_docs_search.py`
  - `test_flag_off_returns_empty_no_client`
  - `test_returns_filtered_host_and_prefix` (fake config; assert only
    url.startswith(prefix) survive; sibling site rejected)
  - `test_no_public_config_returns_empty`
  - `test_results_carry_source_url`
- GREEN: implement.
- REFACTOR: factor client construction to a `_build_client()` lazy helper.

**Verification:** pytest file + Rerun `tests/unit/tools -q`.

### Task 16: PR workflow wiring + grounding + routing policy

**Files:** `src/draftly/tools/search/*` (already re-pointed in Task 10),
`src/draftly/orchestration/graphs/documentation_graph.py` (tool availability),
`tests/unit/workflows/test_pr_docs_routing.py`

- The graph's context/impact nodes and research swarm already consume the three
  search tools via `ToolRegistry` — re-pointing (Task 10) + registration
  (Task 15) is what wires RAG in. Add `live_docs_search` to the tool sets
  actually handed to the docs research swarm / research_swarm `docs_agent` and the
  context/impact retriever lists.
- Routing policy: `RagRetrieval` returns `RagResult.source`; the retrieval
  wrapper already implements policy in `_combine_live`. The graph nodes just
  consume `retrieve()` output; no graph topology change (non-goal).
- Grounding: `docs` grounding mode = index + live fallback with no repo token
  (achieved through tool availability; `grounding.py` values `LOCAL`/`GITHUB`/
  `DOCS` unchanged).
- `EvaluatorNode` citation-coverage rubric unchanged; citations resolve against
  genuine URLs because results carry `source_url`.
- `affected_docs` tool (memory) continues to use index metadata PageType/section
  (no change).

**TDD.**

- RED: `tests/unit/workflows/test_pr_docs_routing.py`
  - `test_retrieval_results_carry_url_for_citation_verification`
  - `test_context_and_impact_bundles_include_source_url`
  - `test_live_fallback_tool_available_in_docs_grounding`
  - `test_private_source_no_live_fallback` (GitHub grounding never invokes live)
- GREEN: implement.

**Verification:** pytest file + the full PR workflow suite
(`find tests -name '*pr*'`/`test_pr_*`).

### Task 17: Freshness triggers (PR merged / release published)

**Files:** new `src/draftly/workflows/documentation/refresh.py` (or reuse the
existing freshness machinery), `src/draftly/app/api/routes/onboarding.py`
(manual "Sync documentation"), tests.

- PR merged → for the docs' changed URLs: `TavilyDocumentationSource.sync` with
  hash-skip (content-hash equal → skip; differs → replace; gone → delete),
  replacement only after retrieval succeeded, retry eligible URLs with
  exponential backoff after deploy (rate-limit/timeout/upstream retryable).
- Release published → same flow on the released docs set.
- Manual "Sync documentation" route when a public config exists; scheduled
  reconciliation optional (design exists; wiring to scheduler left out — the
  same `sync()` is callable; mark as follow-up).
- Trigger integration points: hook into the PR workflow's terminal event
  (`workflow_result`) and the release-published event where they exist; keep the
  change minimal and reversible (`TAVILY_PUBLIC_INGESTION_ENABLED`).

**TDD.**

- RED: `tests/unit/workflows/test_docs_freshness.py`
  - `test_pr_merged_triggers_resync_of_changed_urls`
  - `test_hash_equal_skips_hash_differs_replaces_gone_deletes`
  - `test_retry_after_deploy_eligible_failures`
  - `test_flag_off_no_freshness_trigger`
- GREEN: implement.

**Verification:** pytest file.

---

## Global Verification

Run the **full default suite** (no `TAVILY_API_KEY`):

```bash
cd draftly-agent-backend
DRAFTLY_LIVE=0 TAVILY_API_KEY=        python -m pytest -q
```

Must stay green. Then map each spec acceptance criterion:

| AC | Check | Where |
|----|-------|-------|
| 1 | GitHub onboarding/init tests pass without a key | `pytest tests/unit/workflows/test_onboarding_stages.py` + full suite |
| 2 | Public root discovered/confirmed/ingested/initialized through same 5 stages + persisted fields | `test_onboarding_public.py`, `test_onboarding_stage_public.py`, `test_stage2/3/5_public.py` |
| 3 | Stage 1 public sync emits same event names/progress + per-URL isolation | `test_sync_isolation` (Task 6), `test_stage1_metrics_mirror_github_flow` |
| 4 | Stages 2/3/5 consume index retrieval; 0.4/0.6 blend and health formula byte-for-byte | `test_blend_unchanged_040_060`, `test_health_formula_unchanged` |
| 5 | Research outputs schema-validated before persist; invalid → heuristics/[] | `test_schema_validated` (Task 13), `test_research_failure_falls_back` |
| 6 | No deletion on failed replacement | `test_sync_no_deletion_on_failed_replacement` |
| 7 | PR tools resolve against RAG index; citations carry genuine URLs; live tool gated + policy-driven | `test_pr_docs_routing.py`, Task 15/16 tests |
| 8 | No live request in default tests; each feature disable-able without migration | suite w/o key + `test_flag_off_*` / `test_never_calls_live_for_private_source` |

**Lint:** `ruff check src/draftly tests`.

## Ongoing Maintenance

- Keep `graphify` graph current: `graphify update .` (repo rule) after phases 2–4.
- When `059` migration ships, update any SQL-snapshot fixtures referencing
  `memory_items` columns (`tests` may assert full column lists — grep for
  `memory_items` column lists before merge).
- Feature flags must remain independent of the migration (rules): a deploy with
  `059` applied but all `TAVILY_*` off must behave exactly like today.