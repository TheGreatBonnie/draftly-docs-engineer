# Tavily-RAG Design

**Date:** 2026-09-20
**Status:** Approved
**Scope:** `draftly-agent-backend` onboarding initialization and the PR documentation workflow.

## Goal

Add the two-path RAG architecture from `docs/tavily-rag.md` to Draftly while
reusing Draftly's existing pgvector documentation index instead of introducing
a parallel vector store.

Tavily is the **ingestion and freshness layer** — never the permanent vector
database. A pgvector + full-text index over Draftly's existing documentation
storage is the primary, low-latency retrieval path; restricted Tavily live
search is the fallback when the index is stale or insufficient.

The design wires RAG into two workflows:

1. **Onboarding init stages** — Stage 1 gains a `public_documentation` source
   mode (Tavily Map/Crawl/Extract → indexed chunks); Stages 2–5 retrieve from
   the index (hybrid + rerank) instead of running per-page LLM calls.
2. **PR documentation workflow** — the doc-retrieval tools used by the
   context/impact nodes and the research swarm are re-pointed at the RAG index,
   with a new flag-gated `live_docs_search` tool as the fallback. Citations
   carry URL provenance.

## Non-Goals

- Replacing the GitHub / private-repository ingestion path, GitHub App
  authentication, or grounding modes.
- Sending private repository content to Tavily in the first release.
- Collapsing initialization into a single Tavily request.
- Changing the five stage identifiers, stage weights, event names, persisted
  result fields, the `0.4/0.6` evaluation blend, or the health formula.
- Replacing the PR research swarm's agents or the documentation graph topology;
  only their doc-retrieval tools change.
- Using Tavily to compute deterministic health scores.
- A second vector store: this design extends Draftly's existing docs + memory
  storage (see Index extension).

## Context (verified)

- **Tavily API facts** (from `docs.tavily.com`):
  - `POST /search`: `search_depth` `advanced|basic|fast|ultra-fast`
    (advanced = 2 credits), `max_results` ≤ 20, `chunks_per_source` ≤ 3
    (chunks ≤ 500 chars), `include_domains[]` + `include_domains_mode:
    restrict|prefer`, `include_raw_content: markdown|text`,
    `include_published_date` (beta, per-result `published_date`), `usage`,
    `request_id`.
  - `POST /map`: `max_depth` (1–5), `max_breadth`, `limit`, `select_paths` /
    `select_domains` / `exclude_paths` / `exclude_domains` regex, `categories`,
    `allow_external`.
  - `POST /crawl`: map + extract in one request; same filters plus
    `extract_depth`, `format`, `include_images`.
  - `POST /extract`: ≤ 20 URLs per request, `extract_depth` `basic|advanced`,
    `format` `markdown|text`, per-URL `failed_results` on HTTP 200, optional
    `query` rerank + `chunks_per_source` (1–5).
  - `POST /research` → 201 `{request_id, status}`; poll `GET
    /research/{id}` (202 pending → 200 `completed`/`failed`). `output_schema`
    (JSON Schema with `properties`; `content` returned as a structured object),
    `model` `mini|pro|auto`, `files[]` (≤ 5 files, `[.txt, .md, .json]`,
    base64, ≤ 80k words combined), `citation_format`, `include_domains` (soft
    preference, ≤ 20), `sources[].url` citation list, `usage`.
- **Draftly stack**: `memory_embeddings` (pgvector, cosine `<=>`) + `memory_items`
  with org scoping; `VectorSearch` (`integrations/database/vector_search.py`);
  `semantic_search` / `keyword_search` / `hybrid_search` Strands tools
  (`tools/search/`) registered on every documentation agent graph; a
  `documents` repository (`persistence/repositories/documents.py`) with JSONB
  metadata, `source_hash`, `commit_sha`, versioning; `SyncService` for GitHub
  ingestion; grounding modes `local` / `github` / `docs`.

## Architecture

Two-path RAG, both paths consuming the same `RagRetrieval` service:

```
Primary path (indexed):
  Query → query embedding → pgvector (memory_embeddings over docs namespace)
       + full-text (generated TSVECTOR → GIN) → hybrid blend → rerank
       → confidence → LLM- or agent-grounded answer with URL citations

Fallback path (live Tavily):
  Low confidence → tavily.search(include_domains=[host], restrict)
       → filter url.startswith(docs_prefix) → optional extract of top URLs
       → results join the evidence bundle with URL provenance
```

Index decisions (Approach A):

- **One flat "docs" search namespace** serves both `github_repository` and
  `public_documentation` sources; retrieval filters by `source_type` when
  needed. No second vector store.
- Doc/chunk records gain citation + freshness metadata: `source_url`,
  `page_type` (`tutorial`|`how-to`|`reference`|`explanation`|`index`),
  `section` (heading path), `content_hash`, `indexed_at`.
- Chunk-level full-text: a generated `TSVECTOR` over chunk content with a GIN
  index. This upgrades `keyword_search` from string matching to real full-text
  rank, which the hybrid blend needs.

## Components

### Tavily client — `integrations/tavily/client.py`

- Async typed client: `map`, `crawl`, `extract`, `search`, `research`
  (create + poll, honoring the 201/202/200 contract).
- Injectable HTTP transport so unit tests use a deterministic fake; no live
  network in default tests.
- Typed `TavilyError` taxonomy:
  `authentication | invalid_request | unsupported_url | rate_limit |
  credit_limit | timeout | upstream | invalid_response`.
- Only `rate_limit`, `timeout`, `upstream` are retryable, with bounded
  exponential backoff + jitter honoring server guidance.
- Captures `usage` credits and `request_id` for telemetry; structured logs
  never contain page content, attached base64 files, API keys, or raw
  responses.

### Public documentation source — `documentation/tavily_source.py`

```python
async def discover(config: PublicDocumentationConfig) -> DiscoveryResult      # Map → canonical URL candidates
async def sync(*, org_id, config, on_progress) -> PublicSyncResult            # Crawl + Extract retry → indexed docs
```

- `discover()`: `map(root_url, max_depth, select_paths, select_domains,
  allow_external=False)`; dedupe and canonicalize returned URLs.
- `sync()`: crawl with the same regex filters; record `failed_results` without
  failing successful pages; retry eligible failures with `extract` (≤ 20
  URLs/batch); convert successes to `SourceDocument` values; run the existing
  hash-skip → chunk → embed → upsert → baseline path.
- Failure policy (from the sample): a sync that stores zero documents while
  pages failed is a hard failure. Safe replacement: no existing chunk is
  deleted until replacement content has been retrieved and validated.

### Source models — `documentation/source_models.py`

```python
class SourceType(StrEnum):
    GITHUB_REPOSITORY = "github_repository"
    PUBLIC_DOCUMENTATION = "public_documentation"

class PublicDocumentationConfig(BaseModel):
    root_url: HttpUrl                       # HTTPS only, no embedded credentials
    include_paths: list[str]                # regex, capped count/length
    exclude_paths: list[str]
    crawl_instructions: str | None = None

class SourceDocument(BaseModel):
    source_id: str        # canonical URL for public docs; repo path for GitHub
    path: str
    title: str
    content: str
    source_url: HttpUrl
    source_updated_at: datetime | None = None
    metadata: dict[str, Any]
```

### RAG retrieval — `documentation/rag_retrieval.py`

Single entry point used by both workflows:

```python
async def retrieve(*, org_id, query, product, version,
                   question_type="general", limit=8) -> RagResult
```

- SQL: hybrid query over the docs namespace combining vector similarity
  (`1 - (embedding <=> $1::vector)`), full-text rank (`ts_rank(search_vector,
  plainto_tsquery($2))`), exact-identifier match, and page-type priority,
  filtered by product/version/source_type.
- Score blend (from the sample):

```text
final_score = 0.60 × vector_similarity
            + 0.25 × full_text_rank
            + 0.10 × exact_identifier_match
            + 0.05 × page_type_priority
```

- `question_type` → page-type priority: signatures/parameters → `reference`;
  procedures → `how-to`/`tutorial`; concepts → `explanation`.
- Reranks the top-K; every result carries `url`/`source_url` + content so
  citations and EvaluatorNode citation-coverage have provenance.
- `confidence = best final_score` drives routing:
  - `≥ 0.78` — local index only
  - `0.60–0.78` — combine local + Tavily live
  - `< 0.60` — Tavily live or abstain (gap signal)
- Thresholds are calibrated against evaluation data; constant defaults only.

### Live docs search tool — `tools/search/live_docs_search.py`

Strands tool registered on the documentation agents (context/impact +
`docs_researcher`): performs the fallback path, returns URL-carrying results.

```python
@tool
async def live_docs_search(query: str, limit: int = 8) -> list[dict]:
    response = tavily.search(
        query=f"{product_display_name} documentation: {query}",
        search_depth="advanced", max_results=limit, chunks_per_source=3,
        include_domains=[corpus_host], include_domains_mode="restrict",
        include_answer=False, include_raw_content=False,
    )
    return [r for r in response.results if r["url"].startswith(corpus_docs_prefix)]
```

- Domain restriction is host-level; the URL-prefix filter additionally rejects
  sibling sites sharing the host (per the sample).
- Optional follow-up `extract` of top URLs when snippets are thin.

## Data flow — onboarding init stages

### Stage 0 / source configuration

- Selected-repository payload gains `source_type`; rows missing it default to
  `github_repository`.
- Public mode posts `PublicDocumentationConfig`; validation rejects non-HTTPS
  roots, credentials in URLs, oversized path lists.
- Discovery route: Map → canonical URL candidates → user confirmation →
  persisted in onboarding state. Same state machine and transitions.

### Stage 1 — repository_ingestion

- `github_repository`: existing `SyncService` unchanged.
- `public_documentation`: `TavilyDocumentationSource.sync()` per Components;
  results flow through the same hash-skip/chunk/embed/upsert/baseline path.
- Emits identical `documentation_sync` / `tool_progress` / doc-count /
  chunk-count / stage events; the frontend progress UI is untouched.

### Stage 2 — knowledge_construction

- The ~500-chunk per-page LLM loop is replaced by **retrieval-guided
  synthesis**: the corpus is sliced through the index into deterministic RAG
  shards (page-type strata), bounded by research caps (≤ 5 files, ≤ 80k words).
- Each shard → one `Research(model=mini, files=encode(shard),
  output_schema=ExtractionOutput)`.
- Output validation identical to today: relation-type whitelist
  (`IMPLEMENTS|DOCUMENTED_BY|AFFECTS|DERIVED_FROM`, else fallback) and dedup
  before persistence through the existing `memory.store_batch`,
  `docgraph.link_batch`, procedure-candidate writes; same event names.
- Per-shard failures record their source IDs in `failed_chunks`; retryable /
  credit-limit errors halt via the existing stage-fail path.

### Stage 3 — initial_evaluation

- Deterministic full-corpus heuristics unchanged.
- The 25-doc semantic sample becomes a stratified index retrieval (page-type
  strata, hybrid + rerank) scored by one Research call with
  `output_schema={coverage, structure, completeness, length}`.
- Blend unchanged: `dimension = 0.4 × heuristic + 0.6 × semantic`; total score
  weights coverage/completeness 30% each, structure/length 20% each.
- Research failure / invalid output → pure heuristics for that dimension.

### Stage 4 — health_report

- Deterministic formula unchanged.
- Freshness: GitHub → commit dates; public docs → `source_updated_at` /
  `indexed_at` when trustworthy, neutral `0.5` otherwise.

### Stage 5 — recommendations

- Inputs: eval dims, health dims, document/chunk counts, plus **gap evidence**:
  topics whose index-retrieval confidence was low (the sample's
  documentation-gap signal).
- `Research(output_schema=RecommendationList)` → 3–5 items with
  `priority`/`title`/`detail`/`category`.
- Failure or invalid output → `[]`; never invalidates a completed analysis.

### Preserved invariants

Five stage IDs/labels/weights, `stage_manifest`/`stage_change`/
`stage_progress`/`tool_progress`/`workflow_result` events, init-lock,
run-id/idempotency, retry-from-FAILED, completion guard, and persisted result
fields.

## Data flow — PR documentation workflow

### Re-pointed doc retrieval

- `semantic_search`, `keyword_search`, `hybrid_search` keep their names and
  signatures (graph wiring, skill files, and steering policy remain valid) but
  their corpus implementation delegates to `RagRetrieval.retrieve()` — hybrid
  blend + rerank + page-type priority + product/version filter.
- Results carry `url`/`source_url`, so the `context` and `impact` evidence
  bundles and the research swarm inherit citation provenance.

### Live fallback tool

- `live_docs_search` registered on `docs_researcher`, `context`, and `impact`;
  flag-gated and steering-allowlisted.
- Invoked by the routing policy: local confidence `≥ 0.78` local only;
  `0.60–0.78` combine; `< 0.60` live or abstain.
- `docs` grounding mode = index + live fallback with no repo token; `local` /
  `github` grounding modes unchanged.

### Evaluation and citations

- `EvaluatorNode`'s citation-coverage rubric is unchanged but citations now
  resolve against genuine URLs (index `source_url` or live search results) —
  the sample's citation verification. Fabricated or off-corpus URLs cannot
  satisfy citation coverage.

### Change impact and freshness

- The `impact` node / `affected_docs` tool uses index metadata PageType/section
  to find which docs a diff's identifiers touch.
- On PR merged / release published, the freshness flow re-extracts the changed
  doc URLs: content-hash skip for unchanged pages, replace-on-difference,
  delete removed pages, retry with exponential backoff after deploy.
- Low-confidence retrieval results feed the feedback-loop gap signals.

## Freshness lifecycle

Recommended triggers:

- GitHub push modifying `docs/**`
- PR merged (the PR workflow's terminal event)
- Release published
- Manual "Sync documentation" action in Draftly
- Scheduled reconciliation (daily)

Content-hash semantics (from the sample): new hash equals stored → skip; hash
differs → replace chunks; page gone → delete chunks. Deploys may lag the git
push, so extraction retries with exponential backoff before assuming a page is
unavailable.

## Error model

- All Tavily failures normalize to the `TavilyErrorCode` taxonomy above.
- Stage policies:
  - Public ingestion isolates failures by URL; hard-fails only on zero stored
    documents with failures.
  - Knowledge construction isolates failures by research shard and records
    source IDs.
  - Evaluation falls back to heuristics.
  - Recommendations degrade to `[]`.
  - No failure deletes previously valid indexed content.
- A configurable credit budget halts research before overspend.

## Configuration

```env
TAVILY_API_KEY=                          # optional globally; required when any Tavily flag is on
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_REQUEST_TIMEOUT_SECONDS=60
TAVILY_RESEARCH_POLL_TIMEOUT_SECONDS=300
TAVILY_MAX_CONCURRENCY=4
TAVILY_CREDIT_BUDGET=                    # optional hard cap
TAVILY_PUBLIC_INGESTION_ENABLED=false
TAVILY_LIVE_FALLBACK_ENABLED=false
TAVILY_RESEARCH_ENABLED=false
```

Startup rejects enabled Tavily features without an API key. Deployments without
Tavily configuration remain valid.

## Privacy and observability

- First release permits **public documentation only**. Private repository
  content is never sent to Tavily; a private GitHub source never falls back to
  public crawling and a public source never requires a GitHub installation.
- Metrics: endpoint, latency, outcome, retry count, credits.
- Logs: organization ID, init run ID, stage, Tavily `request_id`, error code.
  Logs never contain page content, attached files, API keys, or raw research
  responses.

## Testing strategy

- **Fake transport**: deterministic `FakeTavilyClient` injected through the
  client; no default test performs a live request.
- **Unit**: request construction and response validation for every endpoint;
  typed error translation and retry classification; URL normalization,
  dedup, path filtering; hybrid score blend and page-type priority; research
  schema validation; file/word-limit-aware sharding; log redaction.
- **Service**: Map discovery; Crawl + Extract-retry + zero-success failure;
  content-hash idempotency and safe replacement; Stage 2 shard persistence and
  failed-source attribution; Stage 3 heuristic fallback and unchanged
  0.4/0.6 blend; Stage 4 regression; Stage 5 `[]` on failure.
- **Workflow**: full GitHub init with Tavily flags off; full public-doc init
  through the same five visible stages; event-contract equality across source
  modes; PR workflow doc-retrieval re-pointing and live tool routing.
- **Opt-in live suite**: gated on `TAVILY_API_KEY`, excluded from default CI.

## Rollout phases

1. Tavily client + source/adapter package + config + fake.
2. Public documentation ingestion (Stage 1) behind
   `TAVILY_PUBLIC_INGESTION_ENABLED`.
3. Research-backed Stages 2/3/5 behind `TAVILY_RESEARCH_ENABLED`.
4. PR-workflow retrieval re-pointing + `live_docs_search` behind
   `TAVILY_LIVE_FALLBACK_ENABLED` + freshness triggers.

Each phase is independently deployable and reversible; disabling a flag routes
the previous model path without migrating onboarding data.

## Acceptance criteria

1. Existing GitHub onboarding/initialization tests pass without a Tavily API
   key.
2. A public documentation root can be discovered, confirmed, ingested, and
   initialized through the same five visible stages and persisted fields.
3. Stage 1 public sync emits the same event names/progress as GitHub sync and
   isolates per-URL failures.
4. Stages 2/3/5 consume index retrieval; the 0.4/0.6 blend and health formula
   are byte-for-byte equivalent for identical inputs.
5. Research outputs are schema-validated before persistence; invalid outputs
   degrade to heuristics / `[]`.
6. No previously indexed valid content is deleted because a replacement
   request failed.
7. PR workflow doc-retrieval tools resolve against the RAG index; citations
   carry genuine URLs; `live_docs_search` is flag-gated and route-policy
   driven.
8. No default test performs a live Tavily request; each Tavily feature can be
   disabled independently without a data migration.