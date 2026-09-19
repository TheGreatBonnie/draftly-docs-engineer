# Tavily-Powered Initialization Design

**Date:** 2026-09-19
**Status:** Approved
**Scope:** `draftly-agent-backend` onboarding and initialization only

## Goal

Make Tavily the only external web retrieval and research provider used by the
onboarding initialization pipeline while preserving Draftly's existing stage
contracts, deterministic scoring, persistence semantics, progress reporting,
and private GitHub repository support.

The design adds a public-documentation source mode powered by Tavily and
replaces eligible LLM work in initialization stages 2, 3, and 5 with Tavily
Research. It does not attempt to make Tavily responsible for Draftly's
database, embeddings, knowledge graph, workflow state, or deterministic health
formula.

## Non-Goals

- Replacing GitHub App authentication or private-repository ingestion.
- Collapsing initialization into one Tavily Research request.
- Changing the five stage identifiers, stage weights, or frontend progress
  contract.
- Changing the persisted shapes of `eval_score`, `health_score`, extracted
  knowledge counts, or recommendations.
- Replacing Draftly's document, memory, graph, candidate, job, or onboarding
  repositories.
- Changing the PR documentation workflow or its research swarm.
- Sending private repository content to Tavily in the first release.
- Using Tavily to calculate deterministic health scores.

## Decisions

1. **Two source modes.** `github_repository` remains the default and keeps the
   existing authenticated synchronization path. `public_documentation` uses a
   public root URL and Tavily Map/Crawl/Extract.
2. **One normalized ingestion boundary.** Both source modes produce normalized
   source documents before Draftly performs document upserts, chunking, memory
   storage, and baseline construction.
3. **Tavily never writes Draftly state directly.** Tavily adapters return
   validated Pydantic values. Stage functions retain all organization scoping,
   batching, persistence, provenance, progress, and transaction behavior.
4. **Deterministic behavior remains local.** Full-corpus heuristics, the
   `0.4/0.6` evaluation blend, health calculation, freshness rules, stage
   orchestration, and completion checks stay in Draftly.
5. **Incremental rollout with independent kill switches.** Public ingestion,
   structured extraction/evaluation, and recommendations ship independently.
   Each Tavily-backed stage can be disabled without changing stored onboarding
   data.
6. **No silent source substitution.** A private GitHub source never falls back
   to public crawling. A public source never requires a GitHub installation.
7. **Safe replacement semantics.** Existing indexed content is not removed
   until replacement content has been retrieved, validated, and prepared for
   storage.

## Current Contracts That Must Remain Stable

The initialization workflow continues to publish and persist the same five
stages:

1. `repository_ingestion`
2. `knowledge_construction`
3. `initial_evaluation`
4. `health_report`
5. `recommendations`

The stage manifest, progress events, overall weighted progress, workflow
result, initialization lock, job record, retry behavior, and completion guard
remain unchanged.

The final onboarding record continues to expose:

```json
{
  "document_count": 12,
  "chunk_count": 87,
  "knowledge_count": 45,
  "eval_score": 0.72,
  "health_score": 0.68,
  "recommendations": []
}
```

## Source Configuration

The selected-repository JSON gains an explicit `source_type` discriminator.
Existing rows without it are interpreted as `github_repository` for backward
compatibility.

GitHub source:

```json
{
  "source_type": "github_repository",
  "full_name": "owner/repository",
  "default_branch": "main",
  "installation_id": 123,
  "doc_include": ["README.md", "docs/**", "*.md", "*.mdx"],
  "doc_exclude": ["node_modules/**", "dist/**"]
}
```

Public documentation source:

```json
{
  "source_type": "public_documentation",
  "root_url": "https://docs.example.com",
  "include_paths": ["/guides/.*", "/reference/.*"],
  "exclude_paths": ["/archive/.*"],
  "crawl_instructions": "Prioritize product and API documentation"
}
```

The API validates HTTPS URLs, rejects credentials embedded in URLs, and caps
path-filter counts and lengths before any Tavily call. Public-source discovery
returns URL candidates through the existing documentation-discovery response
shape.

## Components

### Tavily client

`draftly/integrations/tavily/client.py` owns:

- Bearer authentication with `TAVILY_API_KEY`.
- Map, Crawl, Extract, Research-create, and Research-status requests.
- Request timeouts and bounded retry behavior.
- Translation of Tavily HTTP responses into typed errors.
- Request IDs, response time, and credit usage metadata.
- Redacted structured logging that never records extracted content or files.

The transport is injected so unit tests use a deterministic fake without live
network requests.

### Public documentation source

`draftly/documentation/tavily_source.py` owns public-site discovery and
retrieval. It exposes two operations:

```python
async def discover(config: PublicDocumentationConfig) -> DiscoveryResult

async def fetch(config: PublicDocumentationConfig) -> PublicSyncPayload
```

`discover()` calls Map and returns normalized URL candidates. `fetch()` calls
Crawl for the selected public scope and may use Extract to retry individual
URLs that failed during the crawl. It returns successful normalized documents,
failed URLs, and Tavily usage metadata.

### Normalized source document

Both GitHub and Tavily ingestion produce a shared internal value:

```python
class SourceDocument(BaseModel):
    source_id: str
    path: str
    title: str
    content: str
    source_url: str
    source_updated_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
```

For GitHub, `source_id` remains repository path based and
`source_updated_at` is the last commit date. For public documentation,
`source_id` is the canonical URL, `path` is the URL path, and the update date
is populated only when Tavily supplies a trustworthy published/updated value.

### Tavily research provider

`draftly/integrations/tavily/research.py` owns three typed operations:

```python
async def extract_knowledge(batch: ResearchBatch) -> ExtractionOutput

async def evaluate_documents(batch: ResearchBatch) -> EvaluationScores

async def generate_recommendations(
    request: RecommendationRequest,
) -> RecommendationList
```

Every operation supplies an explicit JSON Schema and validates the response
against the existing stage Pydantic model before returning it. The provider
does not know about repositories, organization IDs, graph services, or memory
services.

## Data Flow

### Onboarding discovery

For `github_repository`, the current GitHub tree and glob discovery flow is
unchanged.

For `public_documentation`:

1. Validate the root URL and path filters.
2. Call Tavily Map using depth, breadth, total-link, and path constraints.
3. Normalize and deduplicate returned URLs.
4. Return candidates for confirmation.
5. Persist the confirmed public-source configuration in onboarding state.

### Stage 1: repository ingestion

GitHub sources continue through the existing `SyncService` behavior.

Public sources follow this sequence:

1. Call Tavily Crawl with the confirmed root URL and filters.
2. Record failed URLs without failing successful pages.
3. Retry eligible individual retrieval failures with Tavily Extract.
4. Convert successful pages into `SourceDocument` values.
5. Compute a stable content hash from normalized content.
6. Skip unchanged documents that still have stored chunks.
7. Parse or normalize headings and chunk the document using Draftly's local
   chunking policy.
8. Upsert document records and replace their stored memory chunks.
9. Construct the same baseline statistics used by later stages.
10. Fail the stage if zero documents are stored and at least one page failed.

The stage still emits `documentation_sync`, document count, chunk count, stage
progress, and overall progress events.

### Stage 2: knowledge construction

The stage continues to recall Draftly document chunks and batch them. For each
batch it calls `extract_knowledge()` with content and stable source IDs. The
Research response must contain facts, relationships, and procedures matching
the existing `ExtractionOutput` contract.

Draftly then performs all side effects:

- Facts become `Knowledge` values stored through `memory.store_batch()`.
- Relationships pass through the existing relation-type validator and are
  stored through `docgraph.link_batch()`.
- Procedures become `procedure_pattern` candidates.
- Failed batches contribute their source IDs to `failed_chunks`.
- Progress uses the existing stage and tool event names.

Research batches respect Tavily's file and word limits. The batching layer
must split inputs before calling the provider; no batch may rely on truncation.

### Stage 3: initial evaluation

The deterministic full-corpus heuristic pass remains unchanged. A stable
sample of at most 25 documents is sent through `evaluate_documents()`. The
validated Tavily scores replace only the current semantic LLM scores.

When semantic scores are available, the existing blend remains:

```text
dimension = 0.4 * heuristic + 0.6 * semantic
```

When Tavily evaluation fails or produces invalid output, the result falls back
to the full-corpus heuristic for every affected dimension. The total score
continues to weight coverage and completeness at 30% each and structure and
length at 20% each.

### Stage 4: health report

This stage is unchanged. Draftly computes the weighted health score locally.
GitHub sources use commit dates for freshness. Public sources use trustworthy
page dates when available and neutral freshness when none are available.

### Stage 5: recommendations

The stage sends evaluation dimensions, health dimensions, document count, and
chunk count to `generate_recommendations()`. Tavily Research returns the
existing `RecommendationList` schema with three to five items. A failure
returns an empty list and does not invalidate the completed analysis.

## Error Model

All integration failures are normalized into:

```python
class TavilyErrorCode(StrEnum):
    AUTHENTICATION = "authentication"
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_URL = "unsupported_url"
    RATE_LIMIT = "rate_limit"
    CREDIT_LIMIT = "credit_limit"
    TIMEOUT = "timeout"
    UPSTREAM = "upstream"
    INVALID_RESPONSE = "invalid_response"
```

Only `RATE_LIMIT`, `TIMEOUT`, and `UPSTREAM` are retryable. Retries use bounded
exponential backoff with jitter and honor server retry guidance. Authentication,
credit, validation, unsupported-URL, and schema failures fail immediately.

Stage policies are:

- Public ingestion isolates failures by URL and hard-fails only on zero
  successful stored documents.
- Knowledge construction isolates failures by research batch and records
  source IDs.
- Evaluation falls back to heuristics.
- Recommendations return an empty list.
- No failure deletes previously valid indexed content.

## Configuration

Application settings gain:

- `TAVILY_API_KEY`: optional globally, required when a Tavily feature flag is
  enabled.
- `TAVILY_BASE_URL`: defaults to `https://api.tavily.com`.
- `TAVILY_REQUEST_TIMEOUT_SECONDS`: default `60`.
- `TAVILY_RESEARCH_POLL_TIMEOUT_SECONDS`: default `300`.
- `TAVILY_MAX_CONCURRENCY`: default `4`.
- `TAVILY_PUBLIC_INGESTION_ENABLED`: default `false`.
- `TAVILY_STRUCTURED_RESEARCH_ENABLED`: default `false`.
- `TAVILY_RECOMMENDATIONS_ENABLED`: default `false`.

Startup validation rejects enabled Tavily features without an API key. The
existing GitHub-only deployment remains valid without Tavily configuration.

## Observability and Data Handling

Metrics record endpoint, latency, outcome, retry count, and credits. Logs add
organization ID, initialization run ID, stage, Tavily request ID, and error
code. Logs never contain document content, attached files, API keys, or full
Research responses.

Research requests involving customer documentation require an explicit source
policy. The first release permits public documentation only. Supporting
private repository content would require a separate privacy and data-retention
design and is outside this scope.

## Rollout

### Phase 1: public documentation ingestion

Ship the client, public-source configuration, Map discovery, Crawl/Extract
ingestion, normalized document boundary, and tests. GitHub remains the default.

### Phase 2: structured extraction and evaluation

Enable Tavily Research behind `TAVILY_STRUCTURED_RESEARCH_ENABLED`. Preserve
local persistence, heuristic scoring, health calculation, and fallbacks.

### Phase 3: recommendations

Enable Tavily Research recommendation generation behind
`TAVILY_RECOMMENDATIONS_ENABLED`.

Each phase is independently deployable and reversible. Disabling a flag routes
the corresponding GitHub or existing-model path without migrating onboarding
records.

## Testing Strategy

### Unit tests

- Request construction and response validation for every Tavily endpoint.
- Typed error translation and retry classification.
- URL normalization, deduplication, and path filtering.
- `SourceDocument` conversion.
- Research schema validation for extraction, evaluation, and recommendations.
- Word-limit-aware research batching.
- Redaction of keys and content from logs.

### Service tests

- Map discovery for public documentation configuration.
- Crawl success, partial success, Extract retry, and zero-success failure.
- Content-hash idempotency and safe replacement behavior.
- Stage 2 persistence and failed-source attribution.
- Stage 3 heuristic fallback and unchanged `0.4/0.6` blend.
- Stage 4 regression coverage for GitHub dates, public dates, and unknown
  freshness.
- Stage 5 structured recommendations and non-blocking failure.

### Workflow tests

- Complete GitHub initialization with all Tavily flags disabled.
- Complete public-documentation initialization.
- Existing stage manifest, stage progress, overall progress, workflow result,
  retry, lock, and completion behavior for both source modes.
- Feature-flag rollback after Tavily failures.

Normal tests use a deterministic fake transport and never call Tavily. A
separate opt-in integration suite requires `TAVILY_API_KEY` and is excluded
from default CI.

## Acceptance Criteria

1. Existing GitHub onboarding and initialization tests pass without a Tavily
   API key.
2. A public documentation root can be discovered, confirmed, ingested, and
   initialized through the same five visible stages.
3. Both source modes produce the current persisted result fields and event
   names.
4. Tavily Research outputs are schema validated before any persistence.
5. Knowledge, graph, candidate, document, and memory writes remain
   organization scoped and owned by Draftly.
6. Evaluation formulas and health formulas remain byte-for-byte equivalent in
   behavior for the same inputs.
7. Evaluation falls back to heuristics and recommendations degrade to an empty
   list when Tavily is unavailable.
8. No previously indexed valid content is deleted because a replacement
   Tavily request failed.
9. No default test performs a live Tavily request.
10. Each Tavily feature can be disabled independently without a data migration.

