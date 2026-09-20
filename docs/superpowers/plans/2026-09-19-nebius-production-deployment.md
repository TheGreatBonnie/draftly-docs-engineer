# Draftly Nebius Production Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Draftly as a production-style Nebius Managed Kubernetes application whose documentation workflows execute in Nebius Serverless Jobs, use Nebius Token Factory as their only LLM provider, and attempt Tavily research on every run with a visible repository-evidence fallback.

**Architecture:** Next.js, FastAPI, a dispatcher, and a reconciler run continuously in Managed Kubernetes. PostgreSQL remains canonical and atomically stores each workflow run plus a dispatch outbox command; the dispatcher creates one Nebius Serverless Job per start or resume phase, and the reconciler projects Nebius state back into the run. Jobs checkpoint and exit at human review, and approval inserts a new resume command. Redis remains limited to live delivery and coordination rather than durable execution truth.

**Tech Stack:** Python 3.11, FastAPI, Pydantic 2, asyncpg, httpx, Strands Agents, PostgreSQL/Neon, Redis, Next.js 16, React 19, TypeScript, Docker, Nebius Managed Kubernetes, Nebius Container Registry, Nebius Serverless Jobs, Nebius Token Factory, SecretStash, Terraform, Helm, GitHub Actions, Tavily Search API.

**Spec:** `docs/superpowers/specs/2026-09-19-nebius-production-deployment-design.md`

## Global Constraints

- Token Factory is the only enabled chat-model provider in Nebius environments: `DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory`.
- Every documentation execution phase must record exactly one Tavily attempt outcome: `completed`, `empty`, `degraded`, or `rejected`.
- Tavily failure must not fail a run that has sufficient repository evidence; the degraded state must be persisted, logged, metered, and shown in the UI.
- PostgreSQL is the source of truth for runs, commands, leases, receipts, evidence, and model invocation metadata. Redis is not a durable queue for documentation workflows.
- A review checkpoint terminates the current Serverless Job. Approval, rejection, or requested changes create a separate idempotent resume command/job.
- Slack and Discord workflows stay disabled in the initial Nebius deployment. GitHub-backed documentation workflows are the initial supported surface.
- Never persist API keys, bearer tokens, source-control credentials, or raw secret values in run payloads, logs, receipts, or Kubernetes manifests.
- Pin deployable images by digest. Do not use mutable tags in production Helm values or Serverless Job commands.
- Run backend checks with `DRAFTLY_LIVE=0`; live Token Factory, Tavily, GitHub, and Nebius checks belong only in the explicitly named smoke stage.

## File Map

### Existing files to modify

- `draftly-agent-backend/src/draftly/models/providers/__init__.py` — export the Token Factory provider.
- `draftly-agent-backend/src/draftly/models/factory.py` — register Token Factory and its role models.
- `draftly-agent-backend/src/draftly/models/policies.py` — make Token Factory the only production fallback target.
- `draftly-agent-backend/.env.example` — document Nebius, Tavily, dispatch, and runtime variables.
- `draftly-agent-backend/src/draftly/app/config.py` — validate runtime mode and Nebius service configuration.
- `draftly-agent-backend/src/draftly/agents/documentation/research_capabilities.py` — make external research an explicit, non-fatal capability.
- `draftly-agent-backend/src/draftly/agents/documentation/research_swarm.py` — include normalized Tavily evidence in documentation research.
- `draftly-agent-backend/src/draftly/agents/schemas.py` — carry evidence provenance and acceptance state.
- `draftly-agent-backend/src/draftly/workflows/runner.py` — invoke the Tavily stage for every documentation workflow and checkpoint phases.
- `draftly-agent-backend/src/draftly/workflows/grounding.py` — expose internal and external evidence state to graph construction.
- `draftly-agent-backend/src/draftly/persistence/repositories/workflows.py` — create a run and dispatch command atomically; expose execution detail.
- `draftly-agent-backend/src/draftly/persistence/repositories/__init__.py` — export execution repositories.
- `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py` — dispatch, retry, and cancel through the durable Nebius command path.
- `draftly-agent-backend/src/draftly/app/api/routes/reviews.py` — turn review decisions into resume commands.
- `draftly-agent-backend/src/draftly/app/api/workflow_schemas.py` — publish provisioning, Tavily, and execution metadata.
- `draftly-agent-backend/src/draftly/review/resume.py` — preserve the domain resume operation for the job entrypoint, not the API process.
- `draftly-agent-backend/src/draftly/observability/metrics.py` — add dispatch, job, Tavily, lease, and model metrics.
- `draftly-agent-backend/src/draftly/app/api/routes/health.py` — report component-specific readiness.
- `draftly-agent-backend/docker/Dockerfile.api` — build the shared production runtime correctly.
- `draftly-agent-backend/docker/Dockerfile.worker` — replace the RQ default with a role-selectable runtime image.
- `draftly-agent-ui/api/workflows.ts` — type and fetch execution metadata.
- `draftly-agent-ui/lib/workflow-view-model.ts` — map the expanded run states and degraded state.
- `draftly-agent-ui/components/sections/workflows/workflow-run-detail-page.tsx` — show Job IDs, model, Tavily outcome, phase, and recovery actions.
- `draftly-agent-ui/tests/workflow-api.test.ts` and `draftly-agent-ui/tests/workflow-view-model.test.ts` — lock the product contract.

### New backend files

- `draftly-agent-backend/src/draftly/models/providers/nebius_token_factory.py`
- `draftly-agent-backend/src/draftly/integrations/tavily/client.py`
- `draftly-agent-backend/src/draftly/integrations/tavily/models.py`
- `draftly-agent-backend/src/draftly/integrations/tavily/policy.py`
- `draftly-agent-backend/src/draftly/integrations/nebius/jobs_client.py`
- `draftly-agent-backend/src/draftly/persistence/repositories/executions.py`
- `draftly-agent-backend/src/draftly/app/workers/nebius_dispatcher.py`
- `draftly-agent-backend/src/draftly/app/workers/nebius_reconciler.py`
- `draftly-agent-backend/src/draftly/app/workers/serverless_job.py`
- `draftly-agent-backend/workers/nebius_dispatcher.py`
- `draftly-agent-backend/workers/nebius_reconciler.py`
- `draftly-agent-backend/workers/serverless_job.py`
- `draftly-agent-backend/src/draftly/persistence/migrations/059_nebius_execution.sql`
- focused tests under `draftly-agent-backend/tests/unit/{models,integrations,persistence,app,workflows}/`

### New deployment files

- `draftly-agent-backend/infra/nebius/terraform/{versions,providers,variables,main,network,kubernetes,registry,service_accounts,secretstash,outputs}.tf`
- `draftly-agent-backend/infra/nebius/helm/draftly/{Chart.yaml,values.yaml,values-production.yaml}`
- Helm templates for namespace, service accounts, deployments, services, ingress, migration job, HPA, PDB, network policy, config, and monitoring.
- `.github/workflows/nebius-ci.yml`
- `.github/workflows/nebius-deploy.yml`
- `draftly-agent-backend/docs/runbooks/nebius-production.md`
- `draftly-agent-backend/docs/runbooks/nebius-demo.md`

---

## Task 1: Add the Token Factory provider and enforce the provider gate

**Files:**
- Create: `draftly-agent-backend/src/draftly/models/providers/nebius_token_factory.py`
- Modify: `draftly-agent-backend/src/draftly/models/providers/__init__.py`
- Modify: `draftly-agent-backend/src/draftly/models/factory.py`
- Modify: `draftly-agent-backend/src/draftly/models/policies.py`
- Modify: `draftly-agent-backend/.env.example`
- Test: `draftly-agent-backend/tests/unit/models/test_nebius_token_factory.py`
- Test: `draftly-agent-backend/tests/unit/models/test_factory.py`
- Test: `draftly-agent-backend/tests/unit/models/test_policies.py`

- [ ] **Step 1: Write failing provider construction tests**

```python
def test_token_factory_uses_openai_compatible_endpoint(monkeypatch):
    monkeypatch.setenv("NEBIUS_TOKEN_FACTORY_API_KEY", "test-key")
    provider = NebiusTokenFactoryProvider(
        ProviderConfig(name="nebius_token_factory", api_key="test-key")
    )
    model = provider.create_model(ModelConfig(name="writer", provider=provider.name, model_id="model-1"))
    assert provider.name == "nebius_token_factory"
    assert provider.config.base_url is None
    assert model is not None


def test_nebius_runtime_rejects_any_second_provider(monkeypatch):
    monkeypatch.setenv("DRAFTLY_RUNTIME", "nebius")
    monkeypatch.setenv("DRAFTLY_ENABLED_PROVIDERS", "nebius_token_factory,openrouter")
    with pytest.raises(ValueError, match="only nebius_token_factory"):
        build_model_router()
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/models/test_nebius_token_factory.py tests/unit/models/test_factory.py tests/unit/models/test_policies.py -q`

Expected: FAIL because the provider and production gate do not exist.

- [ ] **Step 3: Implement the provider as a narrow OpenAI-compatible adapter**

```python
class NebiusTokenFactoryProvider(ModelProvider):
    DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1/"

    @property
    def name(self) -> str:
        return "nebius_token_factory"

    def create_model(self, config: ModelConfig) -> Model:
        if not self.config.api_key:
            raise ValueError("NEBIUS_TOKEN_FACTORY_API_KEY is not configured.")
        return OpenAIModel(
            model_id=config.model_id,
            client_args={
                "api_key": self.config.api_key,
                "base_url": self.config.base_url or self.DEFAULT_BASE_URL,
                "timeout": self.config.timeout,
                "max_retries": self.config.max_retries,
            },
            params={"temperature": config.temperature, "max_tokens": config.max_tokens},
        )
```

- [ ] **Step 4: Register role-specific models and remove production fallbacks**

Use environment variables `NEBIUS_REASONING_MODEL`, `NEBIUS_FAST_MODEL`, `NEBIUS_WRITER_MODEL`, and `NEBIUS_EVALUATOR_MODEL`. Add `nebius_token_factory` to `KNOWN_PROVIDERS`. When `DRAFTLY_RUNTIME=nebius`, require the enabled-provider set to equal `{"nebius_token_factory"}` and make every role fallback chain Token Factory-only.

- [ ] **Step 5: Document exact runtime variables**

Add `NEBIUS_TOKEN_FACTORY_API_KEY`, `NEBIUS_TOKEN_FACTORY_BASE_URL`, the four model IDs, `DRAFTLY_RUNTIME=nebius`, and `DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory` to `.env.example` without real values.

- [ ] **Step 6: Run tests and static checks**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/models/test_nebius_token_factory.py tests/unit/models/test_factory.py tests/unit/models/test_policies.py -q`

Run: `cd draftly-agent-backend && uv run ruff check src/draftly/models tests/unit/models`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/models draftly-agent-backend/tests/unit/models draftly-agent-backend/.env.example
git commit -m "feat(models): add Nebius Token Factory provider"
```

## Task 2: Build the Tavily client, normalization, and trust policy

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/__init__.py`
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/models.py`
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/client.py`
- Create: `draftly-agent-backend/src/draftly/integrations/tavily/policy.py`
- Modify: `draftly-agent-backend/src/draftly/agents/schemas.py`
- Modify: `draftly-agent-backend/.env.example`
- Test: `draftly-agent-backend/tests/unit/integrations/test_tavily_client.py`
- Test: `draftly-agent-backend/tests/unit/integrations/test_tavily_policy.py`

- [ ] **Step 1: Write failing contract tests for all four outcomes**

```python
@pytest.mark.parametrize("response,outcome", [
    ({"results": [{"url": "https://docs.example.com/a", "title": "A", "content": "text", "score": 0.9}]}, "completed"),
    ({"results": []}, "empty"),
])
async def test_search_normalizes_success(response, outcome):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await TavilyClient(api_key="test", http_client=http).search("Draftly API")
        assert result.outcome == outcome

async def test_timeout_is_visible_degraded_result():
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await TavilyClient(api_key="test", http_client=http).search("Draftly API")
        assert result.outcome == "degraded"
        assert result.error_code == "timeout"

def test_policy_rejects_low_authority_or_irrelevant_results():
    candidate = ExternalEvidence(
        query="Draftly API",
        url="https://forum.example.com/post",
        title="Unverified post",
        excerpt="A claim without primary support",
        relevance=0.1,
        authority_class="community",
        accepted=False,
        retrieved_at=datetime.now(UTC),
    )
    result = accept_external_evidence(candidate)
    assert result.accepted is False
    assert result.rejection_reason == "low_relevance"
```

Assert that errors are returned as typed results, not raised into the workflow, and that raw response bodies are never logged.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/integrations/test_tavily_client.py tests/unit/integrations/test_tavily_policy.py -q`

Expected: FAIL because the integration is absent.

- [ ] **Step 3: Define stable models**

```python
TavilyOutcome = Literal["completed", "empty", "degraded", "rejected"]

class ExternalEvidence(BaseModel):
    query: str
    url: HttpUrl
    title: str
    excerpt: str
    relevance: float = Field(ge=0, le=1)
    source_type: Literal["tavily"] = "tavily"
    authority_class: str
    accepted: bool
    rejection_reason: str | None = None
    retrieved_at: datetime

class TavilyResearchResult(BaseModel):
    outcome: TavilyOutcome
    query: str
    evidence: list[ExternalEvidence] = Field(default_factory=list)
    error_code: str | None = None
```

- [ ] **Step 4: Implement bounded HTTP behavior**

Use `httpx.AsyncClient`, `POST https://api.tavily.com/search`, `TAVILY_API_KEY`, a configurable 10-second timeout, at most two attempts, `search_depth="advanced"`, and `include_raw_content=False`. Map authentication, timeout, rate limit, transport, and malformed response failures to sanitized `degraded` results.

- [ ] **Step 5: Implement evidence acceptance**

Normalize domains, strip active content, cap excerpts, classify official/vendor/reference/community sources, reject missing URLs, low relevance, duplicate URLs, and obvious prompt-injection text. Preserve rejected records for audit while returning only `accepted=True` evidence to prompt assembly.

- [ ] **Step 6: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/integrations/test_tavily_client.py tests/unit/integrations/test_tavily_policy.py -q`

Run: `cd draftly-agent-backend && uv run mypy src/draftly/integrations/tavily src/draftly/agents/schemas.py`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/integrations/tavily draftly-agent-backend/src/draftly/agents/schemas.py draftly-agent-backend/tests/unit/integrations draftly-agent-backend/.env.example
git commit -m "feat(research): add bounded Tavily evidence client"
```

## Task 3: Invoke Tavily in every documentation workflow with degraded fallback

**Files:**
- Modify: `draftly-agent-backend/src/draftly/agents/documentation/research_capabilities.py`
- Modify: `draftly-agent-backend/src/draftly/agents/documentation/research_swarm.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/grounding.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Test: `draftly-agent-backend/tests/unit/agents/test_research_capabilities.py`
- Test: `draftly-agent-backend/tests/unit/workflows/test_tavily_grounding.py`
- Test: `draftly-agent-backend/tests/agents/test_doc_swarm_grounding.py`

- [ ] **Step 1: Write the invariant tests first**

Cover `github_pr`, `github_release`, `github_issue`, `documentation_sync`, `documentation_audit`, and `content_generation`. For each workflow, assert one Tavily call occurs after repository retrieval and before impact/writing. Add a timeout case asserting the workflow continues, repository evidence remains available, and the state includes `tavily.outcome == "degraded"`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/agents/test_research_capabilities.py tests/unit/workflows/test_tavily_grounding.py tests/agents/test_doc_swarm_grounding.py -q`

- [ ] **Step 3: Make Tavily an unconditional documentation research stage**

Add a deterministic `run_external_research(event, repository_evidence)` call in the shared documentation path. Build queries from the event, changed symbols/files, repository, version, and affected documentation topics. Do not let an individual agent decide whether Tavily runs.

- [ ] **Step 4: Preserve the trust boundary**

Prompt assembly must label accepted results as untrusted external evidence, keep source URLs next to excerpts, and state that repository evidence wins on conflict. Never expose rejected results to the writer or evaluator.

- [ ] **Step 5: Emit a visible workflow event**

Persist/emit `external_research.completed`, `.empty`, `.degraded`, or `.rejected` with `run_id`, `phase`, query count, accepted count, rejected count, duration, and sanitized error code.

- [ ] **Step 6: Verify all documentation surfaces**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/agents/test_research_capabilities.py tests/unit/workflows/test_tavily_grounding.py tests/agents/test_doc_swarm_grounding.py tests/agents/test_doc_swarm_local.py -q`

Expected: PASS and no live network calls.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/agents draftly-agent-backend/src/draftly/workflows draftly-agent-backend/tests/unit/agents draftly-agent-backend/tests/unit/workflows draftly-agent-backend/tests/agents
git commit -m "feat(workflows): require Tavily attempt with degraded fallback"
```

## Task 4: Add durable execution, evidence, and invocation tables

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/059_nebius_execution.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/executions.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/__init__.py`
- Test: `draftly-agent-backend/tests/unit/persistence/test_nebius_execution_migration.py`
- Test: `draftly-agent-backend/tests/persistence/test_execution_repository.py`

- [ ] **Step 1: Write migration and repository tests**

Assert unique `(run_id, phase, attempt)`, one active lease per run/phase, receipt uniqueness by command, organization-scoped reads, atomic run-plus-command insertion, `FOR UPDATE SKIP LOCKED` claims, expired claim recovery, and sanitized evidence/model records.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/persistence/test_nebius_execution_migration.py tests/persistence/test_execution_repository.py -q`

- [ ] **Step 3: Create the schema**

Create `workflow_dispatch_commands`, `workflow_execution_receipts`, `workflow_execution_leases`, `workflow_external_evidence`, and `workflow_model_invocations`. Use UUID primary keys where appropriate, foreign keys to `workflow_runs(id)`, JSONB only for bounded metadata, timestamp indexes for claims/reconciliation, and partial indexes for active commands/leases.

- [ ] **Step 4: Implement the repository contracts**

Implement these concrete `ExecutionRepository` methods: `create_run_with_command(run, phase, image_digest)`, `enqueue_phase(org_id, run_id, phase, image_digest)`, `claim_commands(owner, limit, claim_ttl)`, `record_receipt(command_id, nebius_job_id, state)`, `acquire_lease(run_id, phase, owner_job_id, attempt, ttl)`, `heartbeat_lease(run_id, phase, owner_job_id, ttl)`, and `release_lease(run_id, phase, owner_job_id)`. Return dictionaries for created/claimed records, booleans for lease acquisition, and `None` for successful mutation-only operations.

- [ ] **Step 5: Make manual run creation transactional**

Replace the current split `start_or_get_idempotent` + process dispatch path with one database transaction that inserts/gets the run and inserts the initial `start` command on first creation. Return `created: bool` so duplicate API requests do not emit duplicate commands.

- [ ] **Step 6: Verify with a real local test database**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/persistence/test_nebius_execution_migration.py tests/persistence/test_execution_repository.py -q`

Expected: PASS, including concurrent claim and duplicate-enqueue tests.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/persistence/migrations/059_nebius_execution.sql draftly-agent-backend/src/draftly/persistence/repositories draftly-agent-backend/tests/unit/persistence draftly-agent-backend/tests/persistence
git commit -m "feat(persistence): add durable Nebius execution outbox"
```

## Task 5: Implement the Nebius Serverless Jobs API client

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/nebius/__init__.py`
- Create: `draftly-agent-backend/src/draftly/integrations/nebius/jobs_client.py`
- Modify: `draftly-agent-backend/src/draftly/app/config.py`
- Modify: `draftly-agent-backend/.env.example`
- Test: `draftly-agent-backend/tests/unit/integrations/test_nebius_jobs_client.py`

- [ ] **Step 1: Write failing request/response tests**

Cover create, get, and cancel; bearer authentication; idempotency metadata; SecretStash environment references; image digest validation; timeouts; 429/5xx retry classification; and unknown states.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/integrations/test_nebius_jobs_client.py -q`

- [ ] **Step 3: Implement typed client contracts**

Define `NebiusJobState` with the exact values `PROVISIONING`, `STARTING`, `IMAGE_PULLING`, `RUNNING`, `COMPLETED`, `FAILED`, and `ERROR`. Implement `NebiusJobsClient.create(CreateJobRequest)`, `.get(job_id)`, and `.cancel(job_id)` to return a validated `NebiusJob` model.

Use the configured Nebius API base, project ID, service-account token source, and strict request timeout. Send only run ID, phase, command ID, attempt, and SecretStash references—not secret values.

- [ ] **Step 4: Validate configuration at startup**

In Nebius mode require project ID, region, registry image digest, Serverless Job preset, service-account auth settings, and SecretStash secret identifiers. Fail before serving readiness when any required value is absent.

- [ ] **Step 5: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/integrations/test_nebius_jobs_client.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/integrations/nebius draftly-agent-backend/src/draftly/app/config.py draftly-agent-backend/tests/unit/integrations/test_nebius_jobs_client.py draftly-agent-backend/.env.example
git commit -m "feat(nebius): add Serverless Jobs API client"
```

## Task 6: Build the idempotent dispatcher

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/workers/nebius_dispatcher.py`
- Create: `draftly-agent-backend/workers/nebius_dispatcher.py`
- Test: `draftly-agent-backend/tests/unit/app/test_nebius_dispatcher.py`

- [ ] **Step 1: Write dispatcher behavior tests**

Test claim batching, duplicate create recovery, successful receipt persistence, retryable versus terminal API errors, claim expiry, exponential backoff with jitter, image digest propagation, and SIGTERM shutdown after the active claim is safely released.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_nebius_dispatcher.py -q`

- [ ] **Step 3: Implement one-command-at-a-time dispatch semantics**

```python
async def dispatch_once(repo: ExecutionRepository, jobs: NebiusJobsClient, owner: str) -> int:
    commands = await repo.claim_commands(owner=owner, limit=10, claim_ttl=timedelta(minutes=2))
    for command in commands:
        try:
            job = await jobs.create(create_request(command))
            await repo.record_receipt(command_id=command["command_id"], nebius_job_id=job.id, state=job.state)
            await repo.mark_dispatched(command_id=command["command_id"], owner=owner)
        except RetryableNebiusError as exc:
            await repo.reschedule(command_id=command["command_id"], owner=owner, error_code=exc.code)
        except TerminalNebiusError as exc:
            await repo.fail_command(command_id=command["command_id"], owner=owner, error_code=exc.code)
    return len(commands)
```

The Nebius request name/labels must deterministically include the command ID so a timeout after remote creation can be reconciled rather than duplicated.

- [ ] **Step 4: Add the process entrypoint**

Run a bounded poll loop, expose `/healthz` and `/readyz` on a small internal port, log structured correlation fields, and stop claiming before shutdown.

- [ ] **Step 5: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_nebius_dispatcher.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/app/workers/nebius_dispatcher.py draftly-agent-backend/workers/nebius_dispatcher.py draftly-agent-backend/tests/unit/app/test_nebius_dispatcher.py
git commit -m "feat(dispatch): launch workflow phases as Nebius jobs"
```

## Task 7: Build the phase-aware Serverless Job entrypoint

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/workers/serverless_job.py`
- Create: `draftly-agent-backend/workers/serverless_job.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/review/resume.py`
- Test: `draftly-agent-backend/tests/unit/app/test_serverless_job.py`
- Test: `draftly-agent-backend/tests/review/test_review_resume.py`

- [ ] **Step 1: Write failing lease and lifecycle tests**

Test start phase, resume phase, duplicate lease refusal, heartbeat, stale lease takeover, successful completion, review checkpoint, intervention checkpoint, cancellation observation, sanitized failure persistence, and lease release on every exit path.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_serverless_job.py tests/review/test_review_resume.py -q`

- [ ] **Step 3: Implement the executable contract**

Implement `execute_phase(command_id, run_id, phase, attempt) -> int` in this exact order: load and cross-check the command/run; acquire the `(run_id, phase)` lease using the Nebius Job ID as owner; mark the run running; start a heartbeat task; call `runner.run(event)` for `start` or the checkpoint resume function for `resume`; persist a terminal state or durable checkpoint; map observed cancellation to `cancelled`; map all other exceptions to a sanitized failure and exit code `1`; then stop heartbeat and release the lease in `finally`. A duplicate active lease exits `0` without executing the graph.

- [ ] **Step 4: Make review a process boundary**

When the graph reaches `pending_review` or `pending_intervention`, persist the complete checkpoint, mark the run accordingly, stop heartbeat, release the lease, and exit zero. Do not block a Serverless Job while waiting for a person.

- [ ] **Step 5: Record model and Tavily provenance**

For every LLM call store provider, model ID, role, latency, input/output token counts when available, success/error code, run ID, and phase. Persist the Tavily attempt and accepted/rejected evidence before impact analysis begins.

- [ ] **Step 6: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_serverless_job.py tests/review/test_review_resume.py tests/unit/workflows/test_tavily_grounding.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/app/workers/serverless_job.py draftly-agent-backend/workers/serverless_job.py draftly-agent-backend/src/draftly/workflows/runner.py draftly-agent-backend/src/draftly/review/resume.py draftly-agent-backend/tests
git commit -m "feat(runtime): execute checkpointed workflows in Serverless Jobs"
```

## Task 8: Build reconciliation, cancellation, and recovery

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/workers/nebius_reconciler.py`
- Create: `draftly-agent-backend/workers/nebius_reconciler.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/executions.py`
- Test: `draftly-agent-backend/tests/unit/app/test_nebius_reconciler.py`

- [ ] **Step 1: Write state-mapping tests**

Assert `PROVISIONING`, `STARTING`, and `IMAGE_PULLING` map to a visible provisioning state; `RUNNING` maps to running; `COMPLETED` trusts the database checkpoint/terminal state; `FAILED` and `ERROR` become retryable or terminal based on policy. Cover orphaned remote jobs, missing receipts, stale leases, user cancellation, maximum attempts, and unknown Nebius states.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_nebius_reconciler.py -q`

- [ ] **Step 3: Implement bounded reconciliation**

Poll only non-terminal receipts, use a configurable concurrency limit, persist state transitions before emitting events, and retry a phase by inserting the next attempt with the same run/phase and pinned image digest. Never mutate an existing attempt into a retry.

- [ ] **Step 4: Implement cancellation semantics**

The API marks cancellation requested in PostgreSQL. The reconciler calls Nebius cancel for active jobs and finalizes the run only after remote cancellation/termination or a documented timeout policy. Jobs also check the cancellation flag between graph stages.

- [ ] **Step 5: Add readiness and graceful shutdown**

Readiness requires PostgreSQL plus Nebius authentication; liveness requires the event loop and a recent successful cycle. Stop polling on SIGTERM and finish only already-started receipt updates.

- [ ] **Step 6: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/app/test_nebius_reconciler.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/app/workers/nebius_reconciler.py draftly-agent-backend/workers/nebius_reconciler.py draftly-agent-backend/src/draftly/persistence/repositories/executions.py draftly-agent-backend/tests/unit/app/test_nebius_reconciler.py
git commit -m "feat(runtime): reconcile Nebius workflow jobs"
```

## Task 9: Route starts, retries, and human decisions through the outbox

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/reviews.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/workflow_schemas.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/rq_jobs.py`
- Test: `draftly-agent-backend/tests/api/test_workflow_runs.py`
- Test: `draftly-agent-backend/tests/api/test_reviews.py`
- Test: `draftly-agent-backend/tests/api/test_github_routes.py`

- [ ] **Step 1: Write failing API tests**

Assert manual and GitHub documentation triggers return after atomically storing `queued + start command`; retries create a new run/start command; review approval/rejection/request-changes creates exactly one resume command; duplicate idempotency keys create none; cancellation is asynchronous; Slack/Discord documentation dispatch is rejected as disabled in Nebius mode.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/api/test_workflow_runs.py tests/api/test_reviews.py tests/api/test_github_routes.py -q`

- [ ] **Step 3: Replace `_dispatch_if_available` for documentation runs**

The API must call the transactional repository method and never invoke `asyncio.create_task`, RQ, or a workflow runner for a Nebius documentation run. Keep RQ code isolated only for explicitly unsupported/non-documentation legacy modes until removal.

- [ ] **Step 4: Make review decisions idempotent commands**

Use a command key derived from `review_id + decision version`. Persist the reviewer decision and resume command in one transaction. Return `202 Accepted` with run ID, command ID, and `status="queued"`.

- [ ] **Step 5: Expand public run status**

Add `provisioning`, `cancellation_requested`, and execution detail containing `phase`, `attempt`, `nebius_job_id`, `tavily_outcome`, `model_provider`, and `model_id`. Keep tenant scoping on every detail query.

- [ ] **Step 6: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/api/test_workflow_runs.py tests/api/test_reviews.py tests/api/test_github_routes.py -q`

Expected: PASS and no RQ enqueue assertions for documentation runs.

- [ ] **Step 7: Commit**

```bash
git add draftly-agent-backend/src/draftly/app/api draftly-agent-backend/src/draftly/app/composition/rq_jobs.py draftly-agent-backend/tests/api
git commit -m "feat(api): dispatch documentation runs through Nebius outbox"
```

## Task 10: Add product and operational observability

**Files:**
- Modify: `draftly-agent-backend/src/draftly/observability/metrics.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/observability.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/health.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/workflow_runs.py`
- Test: `draftly-agent-backend/tests/unit/observability/test_nebius_metrics.py`
- Test: `draftly-agent-backend/tests/api/test_observability_routes.py`

- [ ] **Step 1: Write failing metric and redaction tests**

Cover counters/histograms for dispatch latency, provisioning latency, execution duration, reconciliation failures, retry count, stale leases, Tavily outcomes, Tavily degraded ratio, Token Factory latency/errors/tokens, review wait, and end-to-end run duration. Assert metric labels never contain org IDs, run IDs, job IDs, URLs, prompts, or exception text.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/observability/test_nebius_metrics.py tests/api/test_observability_routes.py -q`

- [ ] **Step 3: Implement low-cardinality metrics and correlated logs**

Logs carry `org_id`, `run_id`, `command_id`, `phase`, `attempt`, and `nebius_job_id` after secret scrubbing. Metrics use only stable labels such as phase, outcome, provider, model role, state, and error code.

- [ ] **Step 4: Add health/readiness detail**

API readiness checks PostgreSQL and required configuration. Dispatcher/reconciler readiness is exposed through their own internal endpoints and Kubernetes probes. Redis failure may degrade live streaming but must not corrupt durable run state.

- [ ] **Step 5: Verify**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/unit/observability/test_nebius_metrics.py tests/api/test_observability_routes.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/src/draftly/observability draftly-agent-backend/src/draftly/app/api/routes draftly-agent-backend/tests/unit/observability draftly-agent-backend/tests/api/test_observability_routes.py
git commit -m "feat(observability): expose Nebius execution health"
```

## Task 11: Expose execution and degraded research state in the UI

**Files:**
- Modify: `draftly-agent-ui/api/workflows.ts`
- Modify: `draftly-agent-ui/lib/workflow-view-model.ts`
- Modify: `draftly-agent-ui/components/sections/workflows/workflow-run-detail-page.tsx`
- Modify: `draftly-agent-ui/hooks/use-workflow-run.ts`
- Modify: `draftly-agent-ui/tests/workflow-api.test.ts`
- Modify: `draftly-agent-ui/tests/workflow-view-model.test.ts`

- [ ] **Step 1: Write failing TypeScript contract tests**

Test provisioning and cancellation labels/tones, a Tavily degraded banner, accepted/rejected evidence counts, Token Factory provider/model rendering, Nebius job/attempt rendering, review-to-resume transition, cancel availability, and retry availability only for terminal failures.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-ui && npm test`

- [ ] **Step 3: Extend the typed API**

```typescript
export type RunStatus = "queued" | "provisioning" | "running" | "pending_review" |
  "pending_intervention" | "cancellation_requested" | "completed" | "failed" |
  "cancelled" | "skipped";

export interface WorkflowExecution {
  phase: "start" | "resume";
  attempt: number;
  nebius_job_id: string | null;
  state: string;
  tavily_outcome: "completed" | "empty" | "degraded" | "rejected" | null;
  model_provider: "nebius_token_factory" | null;
  model_id: string | null;
}
```

- [ ] **Step 4: Update the existing run-detail component**

Add compact execution metadata and an explicit amber degraded-research notice reading that Tavily was unavailable/unusable and Draftly continued with repository evidence. Do not add browser mockups, new landing-page diagrams, or unrelated visual redesign.

- [ ] **Step 5: Verify**

Run: `cd draftly-agent-ui && npm test`

Run: `cd draftly-agent-ui && npm run lint`

Run: `cd draftly-agent-ui && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-ui/api/workflows.ts draftly-agent-ui/lib/workflow-view-model.ts draftly-agent-ui/components/sections/workflows/workflow-run-detail-page.tsx draftly-agent-ui/hooks/use-workflow-run.ts draftly-agent-ui/tests
git commit -m "feat(ui): show Nebius jobs and Tavily degradation"
```

## Task 12: Produce immutable role-selectable container images

**Files:**
- Modify: `draftly-agent-backend/docker/Dockerfile.api`
- Modify: `draftly-agent-backend/docker/Dockerfile.worker`
- Create: `draftly-agent-backend/docker/entrypoint.sh`
- Create: `draftly-agent-ui/Dockerfile`
- Test: `draftly-agent-backend/tests/deployment/test_container_contracts.py`

- [ ] **Step 1: Write failing static container-contract tests**

Assert non-root users, health checks, no baked secret directory, deterministic entrypoints, API/dispatcher/reconciler/job roles, OCI source/revision labels, and UI standalone output.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/deployment/test_container_contracts.py -q`

- [ ] **Step 3: Build a shared backend image with explicit roles**

`DRAFTLY_PROCESS_ROLE` may be `api`, `dispatcher`, `reconciler`, or `serverless-job`. Reject unknown roles. The Serverless Job role accepts only command ID, run ID, phase, and attempt as arguments. Remove `COPY secrets ./secrets`.

- [ ] **Step 4: Build and inspect locally**

Run: `docker build -f draftly-agent-backend/docker/Dockerfile.worker -t draftly-backend:test draftly-agent-backend`

Run: `docker build -f draftly-agent-ui/Dockerfile -t draftly-ui:test draftly-agent-ui`

Run: `docker inspect draftly-backend:test --format '{{json .Config.User}} {{json .Config.Entrypoint}}'`

Expected: both images build; backend runs non-root with the role entrypoint.

- [ ] **Step 5: Run container tests**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/deployment/test_container_contracts.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/docker draftly-agent-backend/tests/deployment draftly-agent-ui/Dockerfile
git commit -m "build(containers): add production runtime roles"
```

## Task 13: Provision Nebius infrastructure with Terraform

**Files:**
- Create: `draftly-agent-backend/infra/nebius/terraform/versions.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/providers.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/variables.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/main.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/network.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/kubernetes.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/registry.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/service_accounts.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/secretstash.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/outputs.tf`
- Create: `draftly-agent-backend/infra/nebius/terraform/terraform.tfvars.example`

- [ ] **Step 1: Define validation targets before resources**

Require explicit project ID, region, availability zone(s), cluster/node sizes, registry name, domain, allowed ingress CIDRs, and secret identifiers. Mark all credentials sensitive and reject `0.0.0.0/0` for control-plane access.

- [ ] **Step 2: Provision the production baseline**

Create a VPC, private workload subnet(s), NAT/egress, Managed Kubernetes control plane, autoscaled worker node group spanning available zones, Container Registry, least-privilege service accounts for Kubernetes nodes, CI deploy, dispatcher/reconciler, and Serverless Jobs, plus SecretStash containers/secret metadata. Do not put secret values in Terraform state when the provider supports references/import.

- [ ] **Step 3: Encode least privilege**

Separate identities: nodes pull images; CI pushes images and updates deployments; dispatcher creates/reads/cancels jobs; reconciler reads/cancels jobs; Serverless Jobs read only their required secrets. No application identity receives project-wide administrator.

- [ ] **Step 4: Format and validate**

Run: `cd draftly-agent-backend/infra/nebius/terraform && terraform fmt -check -recursive`

Run: `cd draftly-agent-backend/infra/nebius/terraform && terraform init -backend=false`

Run: `cd draftly-agent-backend/infra/nebius/terraform && terraform validate`

Expected: PASS.

- [ ] **Step 5: Review the plan with redacted variable values**

Run: `cd draftly-agent-backend/infra/nebius/terraform && terraform plan -var-file=terraform.tfvars -out=/tmp/draftly-nebius.tfplan`

Expected: only intended Nebius resources; no secret values printed. This command requires operator-provided variables and Nebius credentials.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/infra/nebius/terraform
git commit -m "infra(nebius): provision production Kubernetes foundation"
```

## Task 14: Deploy the Kubernetes control plane with Helm

**Files:**
- Create: `draftly-agent-backend/infra/nebius/helm/draftly/Chart.yaml`
- Create: `draftly-agent-backend/infra/nebius/helm/draftly/values.yaml`
- Create: `draftly-agent-backend/infra/nebius/helm/draftly/values-production.yaml`
- Create: `draftly-agent-backend/infra/nebius/helm/draftly/templates/*.yaml`
- Test: `draftly-agent-backend/tests/deployment/test_helm_contracts.py`

- [ ] **Step 1: Write failing manifest-contract tests**

Assert two API replicas, two UI replicas, dispatcher and reconciler Deployments, a pre-upgrade migration Job, service accounts per role, readiness/liveness probes, resource requests/limits, PDBs, HPAs, topology spread, anti-affinity, non-root security contexts, read-only root filesystems where supported, default-deny ingress/egress, restricted egress destinations, and digest-pinned images.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/deployment/test_helm_contracts.py -q`

- [ ] **Step 3: Implement the chart**

Deploy UI, API, dispatcher, reconciler, Services, ingress/load balancer with TLS, ConfigMaps for non-secrets, Secret references materialized by CI, ServiceMonitors/Prometheus rules where supported, and a migration hook that must succeed before rollout.

- [ ] **Step 4: Restrict the initial product surface**

Set Slack/Discord runtime flags false. Permit application egress only to DNS, Neon/PostgreSQL, managed Redis, Token Factory, Tavily, Clerk, GitHub, and Nebius APIs. Document that provider IP ranges may require an egress proxy when stable CIDRs are unavailable.

- [ ] **Step 5: Render and validate**

Run: `helm lint draftly-agent-backend/infra/nebius/helm/draftly -f draftly-agent-backend/infra/nebius/helm/draftly/values-production.yaml`

Run: `helm template draftly draftly-agent-backend/infra/nebius/helm/draftly -f draftly-agent-backend/infra/nebius/helm/draftly/values-production.yaml > /tmp/draftly-rendered.yaml`

Run: `kubectl apply --dry-run=server -f /tmp/draftly-rendered.yaml`

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/deployment/test_helm_contracts.py -q`

Expected: lint, server-side schema validation, and contract tests PASS.

- [ ] **Step 6: Commit**

```bash
git add draftly-agent-backend/infra/nebius/helm draftly-agent-backend/tests/deployment/test_helm_contracts.py
git commit -m "infra(kubernetes): add production Draftly Helm chart"
```

## Task 15: Add CI/CD, secret materialization, and rollout safety

**Files:**
- Create: `.github/workflows/nebius-ci.yml`
- Create: `.github/workflows/nebius-deploy.yml`
- Create: `draftly-agent-backend/scripts/verify_nebius_deployment.sh`
- Create: `draftly-agent-backend/tests/deployment/test_workflow_contracts.py`

- [ ] **Step 1: Write failing workflow-policy tests**

Assert pinned action SHAs, minimum permissions, OIDC/service-account authentication, no long-lived Nebius credential in workflow YAML, image digest capture, SBOM and vulnerability scan, Terraform/Helm validation, migration before rollout, environment approval for production, atomic Helm upgrade, and rollback/verification steps.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/deployment/test_workflow_contracts.py -q`

- [ ] **Step 3: Implement CI**

Run backend unit/integration tests, ruff, mypy, UI tests/lint/build, container-contract tests, Terraform validation, Helm lint/render, dependency audit, image scan, and SBOM generation. Push backend/UI images only after all checks pass.

- [ ] **Step 4: Implement production deployment**

Authenticate to Nebius with workload identity/OIDC, push immutable images, capture digests, read secret values from the approved CI secret boundary, materialize/update namespaced Kubernetes Secrets without printing values, run migration, perform `helm upgrade --install --atomic`, and execute smoke verification.

- [ ] **Step 5: Verify workflow structure**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest tests/deployment/test_workflow_contracts.py -q`

Run: `actionlint .github/workflows/nebius-ci.yml .github/workflows/nebius-deploy.yml`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows draftly-agent-backend/scripts/verify_nebius_deployment.sh draftly-agent-backend/tests/deployment/test_workflow_contracts.py
git commit -m "ci(nebius): build scan and deploy immutable images"
```

## Task 16: Run end-to-end resilience, security, and acceptance checks

**Files:**
- Create: `draftly-agent-backend/tests/e2e/test_nebius_workflow_lifecycle.py`
- Create: `draftly-agent-backend/tests/e2e/test_nebius_failure_recovery.py`
- Create: `draftly-agent-backend/docs/runbooks/nebius-production.md`
- Create: `draftly-agent-backend/docs/runbooks/nebius-demo.md`
- Modify: `README.md`

- [ ] **Step 1: Encode the acceptance lifecycle**

Create an opt-in test that triggers a GitHub documentation run, observes queued → provisioning → running, verifies a Tavily attempt, verifies Token Factory metadata, reaches human review, records the first Nebius job ID, approves the review, observes a different resume job ID, and ends with a GitHub pull request/artifact.

- [ ] **Step 2: Encode failure drills**

Cover Tavily timeout/auth failure, Token Factory 429/5xx, dispatcher restart after remote create/before receipt, reconciler restart, stale lease, duplicate webhook, job image-pull failure, job runtime failure, PostgreSQL interruption, Redis interruption, pod eviction, and user cancellation. Assert no duplicate delivery and no loss of canonical state.

- [ ] **Step 3: Write the operator runbook**

Document prerequisites, Terraform apply, SecretStash population, secret rotation, DNS/TLS, Helm deployment, migration recovery, dispatcher/reconciler diagnosis, stuck-run recovery, cancellation, rollback by digest, database backup/restore, alerts, and safe log collection.

- [ ] **Step 4: Write the hackathon demonstration runbook**

Use one real repository change and show: Managed Kubernetes workloads, transactional command, Serverless Job ID, Token Factory model, Tavily completed or visibly degraded outcome, review checkpoint, separate resume Job ID, final PR, and metrics. Include a pre-recorded fallback only for presentation continuity, not as product evidence.

- [ ] **Step 5: Run the offline release gate**

Run: `cd draftly-agent-backend && DRAFTLY_LIVE=0 uv run pytest -q`

Run: `cd draftly-agent-backend && uv run ruff check src tests workers`

Run: `cd draftly-agent-backend && uv run mypy src`

Run: `cd draftly-agent-ui && npm test && npm run lint && npm run build`

Expected: all PASS.

- [ ] **Step 6: Run the live smoke gate in staging**

Run: `DRAFTLY_LIVE=1 draftly-agent-backend/scripts/verify_nebius_deployment.sh staging`

Expected: the full start/review/resume lifecycle completes, every documentation run has one Tavily outcome, all model invocations report `nebius_token_factory`, and the resume job ID differs from the initial job ID.

- [ ] **Step 7: Update the knowledge graph**

Run: `graphify update .`

Expected: graph update succeeds and captures the new provider, integrations, workers, persistence relationships, and infrastructure files.

- [ ] **Step 8: Request code review and address findings**

Use `superpowers:requesting-code-review`. Re-run the offline release gate after any changes and use `superpowers:verification-before-completion` before claiming readiness.

- [ ] **Step 9: Commit**

```bash
git add draftly-agent-backend/tests/e2e draftly-agent-backend/docs/runbooks README.md graphify-out
git commit -m "docs(nebius): add production and demo runbooks"
```

## Release Acceptance Checklist

- [ ] Nebius production configuration rejects every LLM provider except Token Factory.
- [ ] Every supported documentation run persists exactly one Tavily attempt outcome per execution phase.
- [ ] A Tavily failure continues only when repository evidence meets the grounding gate and is visibly marked degraded.
- [ ] Starts and review resumes are atomic PostgreSQL outbox operations.
- [ ] Dispatcher and reconciler restarts do not duplicate a Serverless Job or delivery.
- [ ] Human review consumes no idle Serverless Job; resume uses a distinct Job ID.
- [ ] UI/API expose provisioning, execution, review, cancellation, retry, model, Tavily, and terminal state.
- [ ] Kubernetes workloads are redundant, probed, resource-bounded, non-root, disruption-protected, and digest-pinned.
- [ ] Secrets are supplied by SecretStash or the approved CI-to-Kubernetes secret path and never committed or logged.
- [ ] Terraform, Helm, backend, frontend, container, resilience, and live staging gates all pass.
- [ ] The hackathon demo proves the real Nebius architecture rather than a mock or browser-only visualization.
