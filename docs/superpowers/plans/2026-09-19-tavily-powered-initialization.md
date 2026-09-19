# Tavily-Powered Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tavily-backed public-documentation ingestion and Tavily Research implementations for eligible onboarding initialization work while preserving GitHub ingestion, deterministic scoring, persistence, and workflow contracts.

**Architecture:** Two source modes normalize content into a shared `SourceDocument`/`DocumentIngestor` boundary. A typed Tavily client supplies Map, Crawl, Extract, and Research; Draftly retains all storage and deterministic logic, and feature flags independently control public ingestion, structured research, and recommendations.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, pydantic-settings, httpx, asyncio, structlog, pytest, pytest-asyncio.

**Spec:** `docs/superpowers/specs/2026-09-19-tavily-powered-initialization-design.md`

## Global Constraints

- Existing selected-repository rows without `source_type` must behave as `github_repository`.
- Private GitHub content must never be sent to Tavily in this release.
- Tavily adapters return validated values and never write repositories, memory, graph edges, or candidates.
- Preserve stage IDs, stage weights, event names, persisted result fields, the `0.4/0.6` evaluation blend, and the health formula.
- Only `RATE_LIMIT`, `TIMEOUT`, and `UPSTREAM` Tavily errors are retryable.
- Evaluation failures fall back to heuristics; recommendation failures return `[]`.
- Existing indexed content must remain intact when replacement extraction fails.
- Default tests must never perform a live Tavily request.
- Keep the PR documentation workflow and research swarm out of scope.
- Run all backend commands from `draftly-agent-backend/` unless a command explicitly starts with `git -C ..`.

## File Structure

**Create:**

- `src/draftly/integrations/tavily/__init__.py` — public integration exports.
- `src/draftly/integrations/tavily/models.py` — endpoint DTOs, errors, and validated response envelopes.
- `src/draftly/integrations/tavily/client.py` — async HTTP transport, retries, polling, redacted telemetry.
- `src/draftly/integrations/tavily/research.py` — typed knowledge, evaluation, and recommendation operations.
- `src/draftly/documentation/source_models.py` — source discriminator models and `SourceDocument`.
- `src/draftly/documentation/document_ingestor.py` — shared hash, parse, chunk, upsert, and memory-write logic.
- `src/draftly/documentation/tavily_source.py` — Map discovery and Crawl/Extract retrieval.
- `tests/fakes/tavily.py` — deterministic fake Tavily client.
- `tests/unit/integrations/tavily/test_client.py` — transport and retry tests.
- `tests/unit/integrations/tavily/test_research.py` — structured Research contract tests.
- `tests/unit/documentation/test_document_ingestor.py` — normalized ingestion tests.
- `tests/unit/documentation/test_tavily_source.py` — public discovery/retrieval tests.
- `tests/integration/test_tavily_live.py` — opt-in live smoke tests.

**Modify:**

- `src/draftly/app/config.py` — Tavily settings and feature flags.
- `src/draftly/workflows/context.py` — optional `tavily` dependency.
- `src/draftly/app/composition/workflows.py` — Tavily composition.
- `src/draftly/app/api/routes/onboarding.py` — public-source selection and discovery routing.
- `src/draftly/documentation/sync_service.py` — delegate persistence to `DocumentIngestor`.
- `src/draftly/workflows/onboarding/initialize.py` — choose GitHub or public synchronization.
- `src/draftly/workflows/onboarding/stages.py` — Tavily Research paths for stages 2, 3, and 5.
- `tests/api/test_onboarding_routes.py` — public-source state-machine coverage.
- `tests/unit/documentation/test_sync_service.py` — GitHub regression coverage through the shared ingestor.
- `tests/unit/workflows/test_onboarding_initialize.py` — source routing and event-contract tests.
- `tests/unit/workflows/test_onboarding_stages.py` — Tavily stage and fallback tests.
- `tests/unit/app/test_onboarding_composition.py` — dependency composition tests.

---

### Task 1: Tavily settings, DTOs, transport, and fake

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/__init__.py`
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/models.py`
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/client.py`
- Create: `draftly-agent-backend/tests/fakes/tavily.py`
- Create: `draftly-agent-backend/tests/unit/integrations/tavily/test_client.py`
- Modify: `draftly-agent-backend/src/draftly/app/config.py:53`

**Interfaces:**
- Produces: `TavilyClient`, `TavilyError`, `TavilyErrorCode`, `MapRequest`, `CrawlRequest`, `ExtractRequest`, `ResearchRequest`, `ResearchResult`.
- Produces: settings fields named exactly as the approved spec.

- [ ] **Step 1: Write failing settings and transport tests**

```python
def test_tavily_settings_are_disabled_by_default():
    settings = Settings(_env_file=None)
    assert settings.tavily_api_key is None
    assert settings.tavily_public_ingestion_enabled is False
    assert settings.tavily_structured_research_enabled is False
    assert settings.tavily_recommendations_enabled is False

@pytest.mark.asyncio
async def test_rate_limit_retries_then_returns_map_response():
    transport = SequenceTransport([Response(429), Response(200, json={"results": ["https://docs.acme.dev/a"]})])
    client = TavilyClient(api_key="tvly-test", transport=transport, max_retries=1)
    result = await client.map(MapRequest(url="https://docs.acme.dev"))
    assert result.results == ["https://docs.acme.dev/a"]
    assert transport.calls == 2

@pytest.mark.asyncio
async def test_authentication_error_is_not_retried():
    transport = SequenceTransport([Response(401)])
    client = TavilyClient(api_key="bad", transport=transport, max_retries=3)
    with pytest.raises(TavilyError) as caught:
        await client.extract(ExtractRequest(urls=["https://docs.acme.dev/a"]))
    assert caught.value.code is TavilyErrorCode.AUTHENTICATION
    assert transport.calls == 1
```

- [ ] **Step 2: Run the focused tests and confirm the missing-module failure**

Run: `pytest tests/unit/integrations/tavily/test_client.py tests/unit/models/test_config_fields.py -v`

Expected: FAIL because `draftly.integrations.tavily` and Tavily settings do not exist.

- [ ] **Step 3: Add settings and validated endpoint models**

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

class ResearchRequest(BaseModel):
    input: str
    model: Literal["mini", "pro", "auto"] = "mini"
    output_schema: dict[str, Any] | None = None
    output_length: Literal["short", "standard", "long"] = "short"
    files: list[dict[str, str]] = Field(default_factory=list)
    include_usage: bool = True
```

Add the seven `tavily_*` fields from the spec to `Settings`, using the exact defaults specified there.

- [ ] **Step 4: Implement the async client with injectable transport and bounded retries**

```python
class TavilyClient:
    async def map(self, request: MapRequest) -> MapResult:
        payload = await self._request("POST", "/map", json=request.model_dump(exclude_none=True))
        return MapResult.model_validate(payload)

    async def research(self, request: ResearchRequest) -> ResearchResult:
        created = await self._request("POST", "/research", json=request.model_dump(exclude_none=True))
        request_id = created["request_id"]
        return await self._poll_research(request_id)

    def _retryable(self, error: TavilyError) -> bool:
        return error.code in {
            TavilyErrorCode.RATE_LIMIT,
            TavilyErrorCode.TIMEOUT,
            TavilyErrorCode.UPSTREAM,
        }
```

Implement `SequenceTransport` and `FakeTavilyClient` with call recording and queued typed results; ensure neither logs request bodies.

- [ ] **Step 5: Run tests**

Run: `pytest tests/unit/integrations/tavily/test_client.py tests/unit/models/test_config_fields.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/integrations/tavily src/draftly/app/config.py tests/fakes/tavily.py tests/unit/integrations/tavily/test_client.py tests/unit/models/test_config_fields.py
git commit -m "feat: add typed Tavily client and configuration"
```

### Task 2: Shared normalized document ingestion

**Files:**
- Create: `draftly-agent-backend/src/draftly/documentation/source_models.py`
- Create: `draftly-agent-backend/src/draftly/documentation/document_ingestor.py`
- Create: `draftly-agent-backend/tests/unit/documentation/test_document_ingestor.py`
- Modify: `draftly-agent-backend/src/draftly/documentation/sync_service.py:44`
- Modify: `draftly-agent-backend/tests/unit/documentation/test_sync_service.py`

**Interfaces:**
- Produces: `SourceType`, `SourceDocument`, `DocumentIngestResult`, and `DocumentIngestor.ingest(org_id, repository, commit_sha, source)`.
- Preserves: `SyncResult` and GitHub `SyncService.sync()` signature.

- [ ] **Step 1: Write failing ingestor tests**

```python
@pytest.mark.asyncio
async def test_ingestor_stores_normalized_document_and_chunks():
    source = SourceDocument(
        source_id="https://docs.acme.dev/start",
        path="/start",
        title="Start",
        content="# Start\n\nInstall the SDK.",
        source_url="https://docs.acme.dev/start",
    )
    result = await ingestor.ingest(
        org_id="org-1", repository="public:https://docs.acme.dev",
        commit_sha="tavily:run-1", source=source,
    )
    assert result.stored is True
    assert documents.rows[0]["metadata"]["source_url"] == source.source_url
    assert memory.items[0].metadata["source_id"] == source.source_id

@pytest.mark.asyncio
async def test_ingestor_does_not_delete_chunks_when_preparation_fails():
    parser.side_effect = ValueError("invalid content")
    with pytest.raises(ValueError):
        await ingestor.ingest(org_id="org-1", repository="public:x", commit_sha="x", source=source)
    assert memory.deleted == []
```

- [ ] **Step 2: Run the new tests and confirm failure**

Run: `pytest tests/unit/documentation/test_document_ingestor.py -v`

Expected: FAIL because `source_models` and `document_ingestor` do not exist.

- [ ] **Step 3: Implement normalized source types and safe ingestion**

```python
class SourceType(StrEnum):
    GITHUB_REPOSITORY = "github_repository"
    PUBLIC_DOCUMENTATION = "public_documentation"

class SourceDocument(BaseModel):
    source_id: str
    path: str
    title: str
    content: str
    source_url: HttpUrl
    source_updated_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

class DocumentIngestor:
    async def ingest(self, *, org_id: str, repository: str, commit_sha: str,
                     source: SourceDocument) -> DocumentIngestResult:
        content_hash = hashlib.sha256(source.content.encode()).hexdigest()
        parsed = parse_markdown(source.content)
        chunks = chunk_document(parsed, source.content)
        existing = await self.documents.get_by_org_and_path(org_id=org_id, path=source.path)
        if self._unchanged_with_chunks(existing, content_hash):
            return DocumentIngestResult(stored=False, skipped=True)
        record = await self.documents.upsert(
            org_id=org_id, repository=repository, path=source.path,
            title=source.title or parsed.title, content=source.content,
            status="indexed", commit_sha=commit_sha, source_hash=content_hash,
            last_committed_at=source.source_updated_at,
            metadata={**source.metadata, "source_url": str(source.source_url),
                      "section_count": len(parsed.headings), "chunk_count": len(chunks)},
        )
        if chunks:
            await self.memory.delete_by_metadata(
                namespace=MemoryNamespaces.DOCUMENTS, key="document_id",
                value=record["id"], org_id=org_id,
            )
            await self.memory.store_batch(self._memory_items(record["id"], source, chunks))
        return DocumentIngestResult(stored=True, chunk_count=len(chunks), section_count=len(parsed.headings))
```

Prepare parsed content and chunks before deleting any stored chunks.

- [ ] **Step 4: Refactor GitHub `SyncService` to delegate persistence**

Construct `SourceDocument` after fetching GitHub content and commit date, then call `DocumentIngestor`. Translate `DocumentIngestResult` into the existing `SyncResult` counters. Keep token minting, tree discovery, concurrency, failure isolation, commit-date cap, callback behavior, and baseline generation in `SyncService`.

- [ ] **Step 5: Run normalized-ingestion and GitHub regression tests**

Run: `pytest tests/unit/documentation/test_document_ingestor.py tests/unit/documentation/test_sync_service.py -v`

Expected: PASS with the existing GitHub sync assertions unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/documentation/source_models.py src/draftly/documentation/document_ingestor.py src/draftly/documentation/sync_service.py tests/unit/documentation/test_document_ingestor.py tests/unit/documentation/test_sync_service.py
git commit -m "refactor: normalize documentation ingestion"
```

### Task 3: Public-source onboarding state and discovery

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py:31`
- Modify: `draftly-agent-backend/tests/api/test_onboarding_routes.py`
- Create: `draftly-agent-backend/src/draftly/documentation/tavily_source.py`
- Create: `draftly-agent-backend/tests/unit/documentation/test_tavily_source.py`

**Interfaces:**
- Consumes: `TavilyClient.map(MapRequest)`.
- Produces: `PublicDocumentationConfig`, `DiscoveryResult`, `TavilyDocumentationSource.discover()`.
- Produces: `POST /onboarding/public-source` and source-aware `/documentation/discover`.

- [ ] **Step 1: Write failing route and discovery tests**

```python
def test_select_public_source_does_not_require_github(client):
    repos.onboarding.get.return_value = {
        "state": "WORKSPACE_CREATED", "selected_repository": {"workspace_name": "Acme"}
    }
    response = client.post("/onboarding/public-source", json={
        "root_url": "https://docs.acme.dev",
        "include_paths": ["/guides/.*"],
        "exclude_paths": ["/archive/.*"],
    })
    assert response.status_code == 200
    saved = repos.onboarding.upsert.await_args.kwargs["selected_repository"]
    assert saved["source_type"] == "public_documentation"

def test_select_public_source_requires_feature_flag(client):
    client.app.state.draftly.settings.tavily_public_ingestion_enabled = False
    response = client.post("/onboarding/public-source", json={
        "root_url": "https://docs.acme.dev"
    })
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_discover_normalizes_and_deduplicates_urls():
    client.map_result = MapResult(base_url="https://docs.acme.dev", results=[
        "https://docs.acme.dev/a", "https://docs.acme.dev/a#part",
    ])
    result = await source.discover(PublicDocumentationConfig(root_url="https://docs.acme.dev"))
    assert result.candidates == ["https://docs.acme.dev/a"]
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pytest tests/api/test_onboarding_routes.py -k 'public_source or public_documentation' tests/unit/documentation/test_tavily_source.py -v`

Expected: FAIL because the route and source service are absent.

- [ ] **Step 3: Implement validated public-source configuration and Map discovery**

```python
class PublicDocumentationConfig(BaseModel):
    root_url: HttpUrl
    include_paths: list[str] = Field(default_factory=list, max_length=50)
    exclude_paths: list[str] = Field(default_factory=list, max_length=50)
    crawl_instructions: str | None = Field(default=None, max_length=1000)

class TavilyDocumentationSource:
    async def discover(self, config: PublicDocumentationConfig) -> DiscoveryResult:
        mapped = await self.client.map(MapRequest(
            url=str(config.root_url), select_paths=config.include_paths,
            exclude_paths=config.exclude_paths, allow_external=False,
        ))
        return DiscoveryResult(candidates=canonicalize_urls(mapped.results))
```

Reject non-HTTPS roots, URL credentials, and external-domain results.

- [ ] **Step 4: Add source-aware route transitions and completion requirements**

Add `PublicSourceRequest`, return `404` while `tavily_public_ingestion_enabled` is false, allow `WORKSPACE_CREATED -> REPOSITORY_SELECTED`, persist `source_type`, and mark `public_source`. Update completion validation to require `{workspace, public_source, documentation, initialization}` for public sources and preserve the current GitHub requirements otherwise. Route `/documentation/discover` to Tavily Map when `source_type == "public_documentation"`.

- [ ] **Step 5: Run route and discovery suites**

Run: `pytest tests/api/test_onboarding_routes.py tests/unit/documentation/test_tavily_source.py -v`

Expected: PASS, including existing GitHub state-machine tests.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/app/api/routes/onboarding.py src/draftly/documentation/tavily_source.py tests/api/test_onboarding_routes.py tests/unit/documentation/test_tavily_source.py
git commit -m "feat: add public documentation onboarding source"
```

### Task 4: Tavily Crawl/Extract synchronization and Stage 1 routing

**Files:**
- Modify: `draftly-agent-backend/src/draftly/documentation/tavily_source.py`
- Modify: `draftly-agent-backend/tests/unit/documentation/test_tavily_source.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py:219`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`

**Interfaces:**
- Produces: `PublicSyncResult` matching the fields consumed from `SyncResult`.
- Produces: `TavilyDocumentationSource.sync(org_id, config, on_progress)`.

- [ ] **Step 1: Write failing public-sync tests**

```python
@pytest.mark.asyncio
async def test_sync_crawls_retries_failed_url_and_ingests_successes():
    client.crawl_result = CrawlResult(base_url="https://docs.acme.dev", results=[
        CrawlPage(url="https://docs.acme.dev/a", raw_content="# A")
    ], failed_results=[FailedResult(url="https://docs.acme.dev/b", error="timeout")])
    client.extract_result = ExtractResult(results=[
        ExtractPage(url="https://docs.acme.dev/b", raw_content="# B")
    ])
    result = await source.sync(org_id="org-1", config=config)
    assert result.document_count == 2
    assert result.failed_files == []

@pytest.mark.asyncio
async def test_sync_zero_success_raises_without_deleting_existing_content():
    client.crawl_result = CrawlResult(
        base_url="https://docs.acme.dev", results=[],
        failed_results=[FailedResult(url="https://docs.acme.dev/a", error="timeout")],
    )
    with pytest.raises(PublicDocumentationSyncError):
        await source.sync(org_id="org-1", config=config)
    assert memory.deleted == []
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pytest tests/unit/documentation/test_tavily_source.py -k sync -v`

Expected: FAIL because `sync()` and `PublicSyncResult` do not exist.

- [ ] **Step 3: Implement Crawl, eligible Extract retry, and ingestion**

```python
async def sync(self, *, org_id: str, config: PublicDocumentationConfig,
               on_progress: ProgressCallback | None = None) -> PublicSyncResult:
    crawl = await self.client.crawl(self._crawl_request(config))
    pages = list(crawl.results)
    retry_urls = [f.url for f in crawl.failed_results if is_retryable_page_failure(f)]
    if retry_urls:
        pages.extend((await self.client.extract(ExtractRequest(urls=retry_urls))).results)
    for page in dedupe_pages(pages):
        ingested = await self.ingestor.ingest(
            org_id=org_id, repository=f"public:{config.root_url}",
            commit_sha=f"tavily:{crawl.request_id}", source=to_source_document(page),
        )
        result.record(ingested)
        if on_progress:
            on_progress(result.document_count, result.chunk_count)
    if result.document_count == 0 and result.failed_files:
        raise PublicDocumentationSyncError(result.failed_files)
    return result
```

- [ ] **Step 4: Route Stage 1 by source type without changing events**

In `_run_stages()`, default missing `source_type` to GitHub. Build the existing `SyncService` only for `github_repository`; resolve `context.tavily.documentation_source` for `public_documentation`. Feed both results into the existing progress flusher and downstream stages.

- [ ] **Step 5: Run Stage 1 and initialization regression tests**

Run: `pytest tests/unit/documentation/test_tavily_source.py tests/unit/workflows/test_onboarding_initialize.py tests/unit/documentation/test_sync_service.py -v`

Expected: PASS with identical stage/event assertions for both source modes.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/documentation/tavily_source.py src/draftly/workflows/onboarding/initialize.py tests/unit/documentation/test_tavily_source.py tests/unit/workflows/test_onboarding_initialize.py
git commit -m "feat: ingest public documentation with Tavily"
```

### Task 5: Typed Tavily Research provider and batching

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/research.py`
- Create: `draftly-agent-backend/tests/unit/integrations/tavily/test_research.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/tavily/__init__.py`

**Interfaces:**
- Consumes: `TavilyClient.research(ResearchRequest)`.
- Produces: `ResearchBatch`, `SourceExtraction`, `RecommendationRequest`, `TavilyResearchProvider.extract_knowledge()`, `.evaluate_documents()`, `.generate_recommendations()`.
- Returns `list[SourceExtraction]` for provenance-preserving extraction; each `SourceExtraction.output` is the existing `ExtractionOutput`. Evaluation and recommendations return the existing `EvaluationScores` and `RecommendationList` models.

- [ ] **Step 1: Write failing provider tests**

```python
@pytest.mark.asyncio
async def test_extract_knowledge_validates_existing_contract():
    fake.queue_research({"facts": ["Uses OAuth"], "relationships": [
        {"source": "Auth", "target": "API", "type": "DOCUMENTED_BY"}
    ], "procedures": [{"title": "Login", "steps": ["Open app"]}]})
    outputs = await provider.extract_knowledge(ResearchBatch(items=[item]))
    assert outputs[0].source_id == item.source_id
    assert outputs[0].output.facts == ["Uses OAuth"]
    assert outputs[0].output.relationships[0].type == "DOCUMENTED_BY"

def test_batches_never_exceed_file_or_word_limits():
    batches = build_research_batches(items, max_files=5, max_words=80_000)
    assert all(len(batch.items) <= 5 for batch in batches)
    assert all(batch.word_count <= 80_000 for batch in batches)
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pytest tests/unit/integrations/tavily/test_research.py -v`

Expected: FAIL because `TavilyResearchProvider` does not exist.

- [ ] **Step 3: Implement explicit schemas, file encoding, and typed validation**

```python
class TavilyResearchProvider:
    async def extract_knowledge(self, batch: ResearchBatch) -> list[SourceExtraction]:
        result = await self.client.research(ResearchRequest(
            input=KNOWLEDGE_PROMPT,
            model="mini",
            output_schema=SourceExtractionList.model_json_schema(),
            files=encode_batch_files(batch),
        ))
        parsed = SourceExtractionList.model_validate(result.content)
        return validate_source_ids(parsed.items, batch.source_ids)

    async def evaluate_documents(self, batch: ResearchBatch) -> EvaluationScores:
        result = await self.client.research(ResearchRequest(
            input=EVALUATION_PROMPT, model="mini",
            output_schema=EvaluationScores.model_json_schema(),
            files=encode_batch_files(batch),
        ))
        return EvaluationScores.model_validate(result.content)
```

Implement recommendation generation with `RecommendationList.model_json_schema()`. Split text deterministically before base64 encoding so no request exceeds five files or 80,000 combined words.

- [ ] **Step 4: Run provider tests**

Run: `pytest tests/unit/integrations/tavily/test_research.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/integrations/tavily/research.py src/draftly/integrations/tavily/__init__.py tests/unit/integrations/tavily/test_research.py
git commit -m "feat: add typed Tavily research provider"
```

### Task 6: Compose Tavily dependencies and validate feature flags

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/context.py:19`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py:142`
- Modify: `draftly-agent-backend/tests/unit/app/test_onboarding_composition.py`

**Interfaces:**
- Produces: `WorkflowContext.tavily` namespace with `client`, `documentation_source`, and `research_provider`.

- [ ] **Step 1: Write failing composition tests**

```python
def test_build_workflows_composes_tavily_when_enabled():
    config = SimpleNamespace(
        tavily_api_key="tvly-test", tavily_public_ingestion_enabled=True,
        tavily_structured_research_enabled=True,
        tavily_recommendations_enabled=True,
        events_streaming_enabled=False, strands=SimpleNamespace(),
    )
    composed = build_workflows(config=config, repositories=repos, memory=memory)
    assert composed.context.tavily.documentation_source is not None
    assert composed.context.tavily.research_provider is not None

def test_enabled_tavily_feature_requires_key():
    with pytest.raises(ValueError, match="TAVILY_API_KEY"):
        build_workflows(config=enabled_config(tavily_api_key=None), repositories=repos)
```

- [ ] **Step 2: Run composition tests and confirm failure**

Run: `pytest tests/unit/app/test_onboarding_composition.py -v`

Expected: FAIL because `WorkflowContext` has no Tavily dependency.

- [ ] **Step 3: Add optional context field and composition helper**

```python
@dataclass
class WorkflowContext:
    tavily: Any = None

def _build_tavily_bundle(config, repositories, memory):
    enabled = any((config.tavily_public_ingestion_enabled,
                   config.tavily_structured_research_enabled,
                   config.tavily_recommendations_enabled))
    if not enabled:
        return None
    if not config.tavily_api_key:
        raise ValueError("TAVILY_API_KEY is required when Tavily features are enabled")
    client = TavilyClient.from_settings(config)
    ingestor = DocumentIngestor(repositories.documents, memory)
    return SimpleNamespace(
        client=client,
        documentation_source=TavilyDocumentationSource(client, ingestor),
        research_provider=TavilyResearchProvider(client),
    )
```

Inject test doubles through an optional `tavily` argument to `build_workflows()` so tests do not construct a live HTTP client.

- [ ] **Step 4: Run composition tests**

Run: `pytest tests/unit/app/test_onboarding_composition.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/workflows/context.py src/draftly/app/composition/workflows.py tests/unit/app/test_onboarding_composition.py
git commit -m "feat: compose Tavily initialization services"
```

### Task 7: Use Tavily Research in knowledge construction

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py:437`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `context.tavily.research_provider.extract_knowledge(ResearchBatch)`.
- Preserves: `run_knowledge_construction(context, *, org_id, publish) -> KnowledgeExtractionResult`.

- [ ] **Step 1: Add failing Tavily Stage 2 tests**

```python
@pytest.mark.asyncio
async def test_knowledge_construction_uses_tavily_and_persists_outputs():
    context.config.tavily_structured_research_enabled = True
    context.tavily.research_provider.extract_knowledge = AsyncMock(return_value=ExtractionOutput(
        facts=["Fact"], relationships=[Relationship(source="A", target="B", type="AFFECTS")],
        procedures=[Procedure(title="Do it", steps=["Step"])],
    ))
    result = await run_knowledge_construction(context, org_id="org-1", publish=publish)
    assert result.knowledge_count == 1
    context.memory.store_batch.assert_awaited()
    context.docgraph.link_batch.assert_awaited()
    context.candidates.enqueue_batch.assert_awaited()

@pytest.mark.asyncio
async def test_failed_tavily_batch_records_all_source_ids():
    context.tavily.research_provider.extract_knowledge.side_effect = TavilyError(
        TavilyErrorCode.TIMEOUT, "research timed out"
    )
    result = await run_knowledge_construction(context, org_id="org-1", publish=publish)
    assert set(result.failed_chunks) == set(chunk_ids)
```

- [ ] **Step 2: Run the Stage 2 tests and confirm failure**

Run: `pytest tests/unit/workflows/test_onboarding_stages.py -k 'knowledge_construction and tavily' -v`

Expected: FAIL because Stage 2 still calls the Strands model.

- [ ] **Step 3: Add a provider-selected extraction helper**

```python
async def _extract_batch(context: Any, batch: list[dict]) -> list[tuple[ExtractionOutput | None, str]]:
    if getattr(context.config, "tavily_structured_research_enabled", False):
        research_batch = ResearchBatch.from_document_chunks(batch)
        try:
            outputs = await context.tavily.research_provider.extract_knowledge(research_batch)
            by_source = {item.source_id: item.output for item in outputs}
            return [(by_source.get(str(chunk.get("id"))), str(chunk.get("id", "unknown")))
                    for chunk in batch]
        except TavilyError:
            return [(None, chunk.get("id", "unknown")) for chunk in batch]
    return await _extract_batch_with_existing_agents(context, batch)
```

Keep relationship validation, memory/graph/candidate writes, batching, progress, and disabled-flag behavior unchanged.

- [ ] **Step 4: Run all onboarding stage tests**

Run: `pytest tests/unit/workflows/test_onboarding_stages.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat: use Tavily for onboarding knowledge extraction"
```

### Task 8: Use Tavily Research for semantic evaluation and recommendations

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py:734`
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_stages.py`

**Interfaces:**
- Consumes: `evaluate_documents()` and `generate_recommendations()`.
- Preserves: `EvaluationResult`, exact blend and weights, and `list[Recommendation]`.

- [ ] **Step 1: Add failing evaluation and recommendation tests**

```python
@pytest.mark.asyncio
async def test_tavily_evaluation_preserves_blend():
    context.config.tavily_structured_research_enabled = True
    context.tavily.research_provider.evaluate_documents = AsyncMock(
        return_value=EvaluationScores(coverage=1, completeness=1, structure=1, length=1)
    )
    result = await run_initial_evaluation(context, org_id="org-1")
    assert result.dimensions["coverage"] == pytest.approx(
        0.4 * expected_heuristic_coverage + 0.6
    )

@pytest.mark.asyncio
async def test_tavily_evaluation_failure_uses_heuristics_only():
    context.tavily.research_provider.evaluate_documents.side_effect = TavilyError(
        TavilyErrorCode.TIMEOUT, "research timed out"
    )
    result = await run_initial_evaluation(context, org_id="org-1")
    assert result.dimensions == expected_heuristics

@pytest.mark.asyncio
async def test_tavily_recommendation_failure_is_non_blocking():
    context.config.tavily_recommendations_enabled = True
    context.tavily.research_provider.generate_recommendations.side_effect = TavilyError(
        TavilyErrorCode.UPSTREAM, "research unavailable"
    )
    assert await run_recommendations(context, eval_result=eval_result,
                                     health_result=health_result,
                                     document_count=2, chunk_count=4) == []
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pytest tests/unit/workflows/test_onboarding_stages.py -k 'tavily_evaluation or tavily_recommendation' -v`

Expected: FAIL because stages 3 and 5 still use existing agents.

- [ ] **Step 3: Select Tavily paths behind independent flags**

For Stage 3, retain the existing full heuristic pass and deterministic sample. Send that sample as a `ResearchBatch`, average valid Tavily results, and execute the existing blend block. On `TavilyError` or schema failure, leave `llm_count == 0` so the current heuristic fallback runs.

For Stage 5:

```python
if getattr(context.config, "tavily_recommendations_enabled", False):
    try:
        parsed = await context.tavily.research_provider.generate_recommendations(
            RecommendationRequest.from_metrics(
                eval_result, health_result, document_count, chunk_count
            )
        )
        return list(parsed.items)
    except TavilyError as exc:
        logger.warning("tavily_recommendations_failed", code=exc.code.value)
        return []
```

- [ ] **Step 4: Prove Stage 4 and existing paths remain unchanged**

Run: `pytest tests/unit/workflows/test_onboarding_stages.py -v`

Expected: PASS, including health-report formula tests and existing-model tests with flags disabled.

- [ ] **Step 5: Commit**

```bash
git add src/draftly/workflows/onboarding/stages.py tests/unit/workflows/test_onboarding_stages.py
git commit -m "feat: use Tavily for onboarding evaluation and recommendations"
```

### Task 9: End-to-end workflow, observability, and opt-in live test

**Files:**
- Modify: `draftly-agent-backend/tests/unit/workflows/test_onboarding_initialize.py`
- Modify: `draftly-agent-backend/tests/api/test_onboarding_routes.py`
- Modify: `draftly-agent-backend/tests/unit/integrations/tavily/test_client.py`
- Create: `draftly-agent-backend/tests/integration/test_tavily_live.py`
- Modify: `draftly-agent-backend/README.md`

**Interfaces:**
- Verifies the complete approved spec; produces no new runtime interface.

- [ ] **Step 1: Add full public initialization and rollback tests**

```python
@pytest.mark.asyncio
async def test_public_source_runs_existing_five_stage_contract():
    state = await run_onboarding_initialize(
        context,
        org_id="org-1",
        selected_repository={
            "source_type": "public_documentation",
            "root_url": "https://docs.acme.dev",
        },
    )
    assert state.status is WorkflowStatus.DELIVERED
    assert [event.payload["stage"] for event in stage_events] == STAGES
    assert persisted["document_count"] > 0
    assert "eval_score" in persisted
    assert "health_score" in persisted

@pytest.mark.asyncio
async def test_disabled_flags_execute_existing_github_and_model_paths():
    context.config.tavily_public_ingestion_enabled = False
    context.config.tavily_structured_research_enabled = False
    context.config.tavily_recommendations_enabled = False
    state = await run_onboarding_initialize(context, org_id="org-1", selected_repository=github_source)
    assert state.status is WorkflowStatus.DELIVERED
    assert context.tavily.client.calls == []
```

- [ ] **Step 2: Add redaction and telemetry assertions**

Capture logs around successful and failed client calls. Assert endpoint, latency, status, credits, organization, run ID, stage, and request ID are present where supplied; assert the API key, document content, attached base64 data, and raw response are absent.

- [ ] **Step 3: Add an opt-in live smoke test**

```python
pytestmark = pytest.mark.skipif(
    not os.getenv("TAVILY_API_KEY"), reason="requires TAVILY_API_KEY"
)

@pytest.mark.asyncio
async def test_live_map_and_extract():
    client = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
    mapped = await client.map(MapRequest(url="https://docs.tavily.com", limit=2))
    assert mapped.results
    extracted = await client.extract(ExtractRequest(urls=[mapped.results[0]]))
    assert extracted.results[0].raw_content
```

- [ ] **Step 4: Document configuration and source-mode API**

Add a README section containing the seven environment variables, disabled defaults, the `POST /onboarding/public-source` request example, the privacy boundary prohibiting private content, and the command for the opt-in test.

- [ ] **Step 5: Run focused and complete verification**

Run:

```bash
pytest tests/unit/integrations/tavily tests/unit/documentation/test_document_ingestor.py tests/unit/documentation/test_tavily_source.py tests/api/test_onboarding_routes.py tests/unit/workflows/test_onboarding_initialize.py tests/unit/workflows/test_onboarding_stages.py tests/unit/app/test_onboarding_composition.py -v
ruff check src/draftly/integrations/tavily src/draftly/documentation src/draftly/workflows/onboarding src/draftly/app/api/routes/onboarding.py
mypy src/draftly/integrations/tavily src/draftly/documentation/tavily_source.py src/draftly/documentation/document_ingestor.py
pytest -q
```

Expected: every command exits `0`; the live integration test remains skipped unless `TAVILY_API_KEY` is explicitly supplied.

- [ ] **Step 6: Refresh Graphify after runtime changes**

Run: `cd .. && graphify update .`

Expected: exit `0` and `graphify-out/graph.json` reflects the Tavily integration and new source path.

- [ ] **Step 7: Commit final verification and documentation**

```bash
git add README.md tests/integration/test_tavily_live.py tests/unit/workflows/test_onboarding_initialize.py tests/api/test_onboarding_routes.py tests/unit/integrations/tavily/test_client.py ../graphify-out
git commit -m "test: verify Tavily-powered initialization"
```
