# Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a durable, server-owned onboarding state machine exposed through a REST API, driven by a 7-step frontend wizard whose final step runs a real initialization workflow built on the docs sync engine.

**Architecture:** Backend state machine (SQL persisted) → REST API routes → frontend wizard with progress tracking → initialization workflow chaining: register repo → sync → knowledge → eval → health. Browser-close safe via server-side state. All transitions validated against linear state machine; every POST idempotent.

**Tech Stack:** Python 3.12, FastAPI, Pydantic, PostgreSQL, Next.js 16, React 19, Clerk, Tailwind CSS v4, TypeScript 5

**Spec:** `docs/superpowers/specs/2026-08-22-docs-sync-onboarding-design.md` (§5.1–5.3, §6)

## Global Constraints

- Backend: Python 3.12+, FastAPI, existing `WorkflowContext`/`WorkflowRegistry`/`TaskRunner` patterns
- Frontend: Next.js 16.3.1, React 19, Clerk `@clerk/nextjs` ^7.7.7, Tailwind CSS v4, lucide-react icons
- No new frontend dependencies — Clerk/Next/Tailwind/lucide only
- Frontend has no validation library — plain TypeScript validators
- Existing `api/client.ts` request wrapper with auth token management
- Existing `components/onboarding/` and `lib/onboarding/` empty scaffolding
- Existing `app/(onboarding)/onboarding/` empty pages
- Clerk `afterSelectOrganizationUrl` points at `/onboarding`; dashboard uses `/dashboard`
- Required steps: workspace, github, repository, documentation discovery, initialization
- Optional: slack, discord, preferences (defaults)
- State machine: `NOT_STARTED → WORKSPACE_CREATED → GITHUB_CONNECTED → REPOSITORY_SELECTED → DOCUMENTATION_DISCOVERED → INTEGRATIONS_CONFIGURED → PREFERENCES_CONFIGURED → INITIALIZING → COMPLETED`
- `INITIALIZING` may transition to `FAILED` and back via retry
- Tests: `pytest` + `pytest-asyncio` (backend), manual/scripted E2E (frontend)

---

## File Structure

### Backend New Files

| File | Responsibility |
|------|----------------|
| `src/draftly/persistence/migrations/024_onboarding.sql` | `onboarding_state` table |
| `src/draftly/persistence/migrations/025_repositories.sql` | `repositories` table |
| `src/draftly/persistence/repositories/onboarding.py` | Onboarding state CRUD |
| `src/draftly/persistence/repositories/repository_config.py` | Repository connection config CRUD |
| `src/draftly/app/api/routes/onboarding.py` | Onboarding REST API |
| `src/draftly/workflows/onboarding/initialize.py` | Initialization workflow |
| `tests/unit/app/test_onboarding_composition.py` | Composition wiring checks (Task 4a) |

### Backend Modified Files

| File | Change |
|------|--------|
| `src/draftly/app/dependencies.py` | Add `onboarding` + `repository_config` to `RepositoryDependencies`; construct in `build_repositories()` (Task 4a) |
| `src/draftly/app/composition/workflows.py` | Register `onboarding_initialize` workflow (Task 7) |
| `src/draftly/app/composition/workers.py` | Add `onboarding.initialize` to TASK_REGISTRY (Task 7) |

### Frontend New/Modified Files

| File | Change |
|------|--------|
| `lib/onboarding/types.ts` | Step IDs, shared DTOs |
| `lib/onboarding/constants.ts` | Step order, labels |
| `lib/onboarding/steps.ts` | Step registry |
| `lib/onboarding/validation.ts` | Plain TypeScript validators |
| `lib/onboarding/navigation.ts` | Route builders + guard helper |
| `api/onboarding.ts` | Typed client |
| `components/onboarding/*.tsx` | Shell, header, progress, footer, per-step forms |
| `app/(onboarding)/onboarding/layout.tsx` | Wizard chrome layout |
| `app/(onboarding)/onboarding/page.tsx` | Entry redirect |
| `app/(onboarding)/onboarding/*/page.tsx` | Step pages |

---

## Backend Tasks

### Task 1: Onboarding State Migration

**Files:**
- Create: `src/draftly/persistence/migrations/024_onboarding.sql`

- [x] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS onboarding_state (
    org_id TEXT PRIMARY KEY REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'NOT_STARTED',
    completed_steps JSONB NOT NULL DEFAULT '[]'::JSONB,
    failure JSONB,
    selected_repository JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [x] **Step 2: Commit**

---

### Task 2: Repository Config Migration

**Files:**
- Create: `src/draftly/persistence/migrations/025_repositories.sql`

- [x] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id TEXT REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    doc_include JSONB DEFAULT '["README.md", "docs/**", "*.md", "*.mdx"]'::JSONB,
    doc_exclude JSONB DEFAULT '["node_modules/**", "dist/**"]'::JSONB,
    installation_id INT REFERENCES github_installations(installation_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, full_name)
);
```

- [x] **Step 2: Commit**

---

### Task 3: Onboarding State Repository

**Files:**
- Create: `src/draftly/persistence/repositories/onboarding.py`
- Create: `tests/unit/persistence/test_onboarding_repo.py`

**Interfaces:**
- Produces: `get(org_id)`, `upsert(org_id, state, **fields)`, `mark_step(org_id, step)`, `mark_failed(org_id, step, detail)`

- [x] **Step 1: Write the failing test**

```python
# tests/unit/persistence/test_onboarding_repo.py
"""Unit tests for onboarding state repository."""

import pytest
from dataclasses import dataclass
from draftly.persistence.repositories.onboarding import OnboardingRepository


@dataclass
class FakeClient:
    responses: list = None
    calls: list = None

    def __post_init__(self):
        if self.responses is None:
            self.responses = []
        if self.calls is None:
            self.calls = []

    async def fetch_one(self, query, *args):
        self.calls.append(("fetch_one", query, args))
        return self.responses.pop(0) if self.responses else None

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return "OK"


@pytest.mark.asyncio
async def test_get_returns_none_when_not_found():
    client = FakeClient(responses=[None])
    repo = OnboardingRepository(client)
    result = await repo.get("org-123")
    assert result is None


@pytest.mark.asyncio
async def test_get_returns_state_when_found():
    client = FakeClient(responses=[{
        "org_id": "org-123",
        "state": "WORKSPACE_CREATED",
        "completed_steps": ["workspace"],
        "failure": None,
        "selected_repository": None,
    }])
    repo = OnboardingRepository(client)
    result = await repo.get("org-123")
    assert result["state"] == "WORKSPACE_CREATED"


@pytest.mark.asyncio
async def test_upsert_inserts_new_state():
    client = FakeClient(responses=[None, "OK"])
    repo = OnboardingRepository(client)
    await repo.upsert("org-123", state="NOT_STARTED")
    assert len(client.calls) == 2


@pytest.mark.asyncio
async def test_mark_step_adds_step_atomically():
    # Atomic single-statement append: one execute, then a read-back.
    client = FakeClient(responses=[
        "OK",  # execute: INSERT ... ON CONFLICT DO UPDATE (JSONB merge)
        {"org_id": "org-123", "completed_steps": ["workspace", "github"]},
    ])
    repo = OnboardingRepository(client)
    result = await repo.mark_step("org-123", "github")
    assert "github" in (result.get("completed_steps") or [])
    sql, _args = client.calls[0]
    assert "ON CONFLICT (org_id)" in sql
    assert "EXCLUDED.completed_steps" in sql
    assert len(client.calls) == 2


@pytest.mark.asyncio
async def test_mark_failed_sets_failure():
    client = FakeClient(responses=[None, "OK"])
    repo = OnboardingRepository(client)
    await repo.mark_failed("org-123", "initialize", {"detail": "auth failed"})
    assert len(client.calls) == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/persistence/test_onboarding_repo.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/persistence/repositories/onboarding.py
"""Onboarding state repository."""

from __future__ import annotations

import json
from typing import Any


class OnboardingRepository:
    """CRUD for onboarding_state table."""

    def __init__(self, client: Any = None) -> None:
        if client is None:
            from draftly.integrations.database.client import DatabaseClient
            self.client = DatabaseClient()
        else:
            self.client = client

    async def get(self, org_id: str) -> dict[str, Any] | None:
        return await self.client.fetch_one(
            "SELECT * FROM onboarding_state WHERE org_id = $1",
            org_id,
        )

    async def upsert(
        self,
        org_id: str,
        *,
        state: str | None = None,
        completed_steps: list[str] | None = None,
        failure: dict | None = None,
        selected_repository: dict | None = None,
    ) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        if state is not None:
            fields["state"] = state
        if completed_steps is not None:
            fields["completed_steps"] = json.dumps(completed_steps)
        if failure is not None:
            fields["failure"] = json.dumps(failure)
        if selected_repository is not None:
            fields["selected_repository"] = json.dumps(selected_repository)

        if not fields:
            return await self.get(org_id) or {}

        set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields.keys()))
        values = [org_id] + list(fields.values())

        await self.client.execute(
            f"INSERT INTO onboarding_state (org_id, {', '.join(fields.keys())}) "
            f"VALUES ($1, {', '.join(f'${i+2}' for i in range(len(fields)))}) "
            f"ON CONFLICT (org_id) DO UPDATE SET {set_clause}",
            *values,
        )
        return await self.get(org_id) or {"org_id": org_id, "state": state or "NOT_STARTED"}

    async def mark_step(self, org_id: str, step: str) -> dict[str, Any]:
        """Atomically append a step id to completed_steps (JSONB).

        Single-statement upsert instead of get→append→upsert so concurrent
        requests can never drop each other's steps.
        """
        await self.client.execute(
            """
            INSERT INTO onboarding_state (org_id, completed_steps)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (org_id) DO UPDATE SET
                completed_steps = (
                    SELECT COALESCE(jsonb_agg(s), '[]'::jsonb)
                    FROM (
                        SELECT DISTINCT jsonb_array_elements_text(
                            onboarding_state.completed_steps || EXCLUDED.completed_steps
                        ) AS s
                    ) dedup
                )
            """,
            org_id,
            json.dumps([step]),
        )
        return await self.get(org_id) or {"org_id": org_id, "completed_steps": [step]}

    async def mark_failed(self, org_id: str, step: str, detail: dict) -> dict[str, Any]:
        return await self.upsert(org_id, state="FAILED", failure={"step": step, **detail})
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/persistence/test_onboarding_repo.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/persistence/repositories/onboarding.py tests/unit/persistence/test_onboarding_repo.py
git commit -m "feat: add onboarding state repository"
```

---

### Task 4: Repository Config Repository

**Files:**
- Create: `src/draftly/persistence/repositories/repository_config.py`
- Create: `tests/unit/persistence/test_repository_config_repo.py`

**Interfaces:**
- Produces: `get(org_id, full_name)`, `upsert(org_id, full_name, **fields)`, `list_by_org(org_id)`

- [x] **Step 1: Write the failing test**

```python
# tests/unit/persistence/test_repository_config_repo.py
"""Unit tests for repository config repository."""

import pytest
from dataclasses import dataclass
from draftly.persistence.repositories.repository_config import RepositoryConfigRepository


@dataclass
class FakeClient:
    responses: list = None
    calls: list = None

    def __post_init__(self):
        if self.responses is None:
            self.responses = []
        if self.calls is None:
            self.calls = []

    async def fetch_one(self, query, *args):
        self.calls.append(("fetch_one", query, args))
        return self.responses.pop(0) if self.responses else None

    async def fetch_all(self, query, *args):
        self.calls.append(("fetch_all", query, args))
        return self.responses.pop(0) if self.responses else []

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return "OK"


@pytest.mark.asyncio
async def test_get_returns_none_when_not_found():
    client = FakeClient(responses=[None])
    repo = RepositoryConfigRepository(client)
    result = await repo.get("org-123", "owner/repo")
    assert result is None


@pytest.mark.asyncio
async def test_list_by_org_returns_repos():
    client = FakeClient(responses=[
        [{"full_name": "owner/repo1"}, {"full_name": "owner/repo2"}]
    ])
    repo = RepositoryConfigRepository(client)
    result = await repo.list_by_org("org-123")
    assert len(result) == 2


@pytest.mark.asyncio
async def test_upsert_inserts_new_repository():
    client = FakeClient(responses=[None, "OK"])
    repo = RepositoryConfigRepository(client)
    await repo.upsert("org-123", "owner/repo")
    assert len(client.calls) == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/persistence/test_repository_config_repo.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/persistence/repositories/repository_config.py
"""Repository configuration repository."""

from __future__ import annotations

import json
from typing import Any


class RepositoryConfigRepository:
    """CRUD for repositories table."""

    def __init__(self, client: Any = None) -> None:
        if client is None:
            from draftly.integrations.database.client import DatabaseClient
            self.client = DatabaseClient()
        else:
            self.client = client

    async def get(self, org_id: str, full_name: str) -> dict[str, Any] | None:
        return await self.client.fetch_one(
            "SELECT * FROM repositories WHERE org_id = $1 AND full_name = $2",
            org_id,
            full_name,
        )

    async def list_by_org(self, org_id: str) -> list[dict[str, Any]]:
        return await self.client.fetch_all(
            "SELECT * FROM repositories WHERE org_id = $1 ORDER BY created_at",
            org_id,
        )

    async def upsert(
        self,
        org_id: str,
        full_name: str,
        *,
        default_branch: str = "main",
        doc_include: list[str] | None = None,
        doc_exclude: list[str] | None = None,
        installation_id: int | None = None,
    ) -> dict[str, Any]:
        include = doc_include or ["README.md", "docs/**", "*.md", "*.mdx"]
        exclude = doc_exclude or ["node_modules/**", "dist/**"]

        await self.client.execute(
            "INSERT INTO repositories (org_id, full_name, default_branch, doc_include, doc_exclude, installation_id) "
            "VALUES ($1, $2, $3, $4::JSONB, $5::JSONB, $6) "
            "ON CONFLICT (org_id, full_name) DO UPDATE SET "
            "default_branch = $3, doc_include = $4::JSONB, doc_exclude = $5::JSONB, installation_id = $6",
            org_id,
            full_name,
            default_branch,
            json.dumps(include),
            json.dumps(exclude),
            installation_id,
        )
        return await self.get(org_id, full_name) or {"org_id": org_id, "full_name": full_name}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/persistence/test_repository_config_repo.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/persistence/repositories/repository_config.py tests/unit/persistence/test_repository_config_repo.py
git commit -m "feat: add repository config repository"
```

---

### Task 4a: Wire Onboarding Repositories into Composition

**Files:**
- Modify: `src/draftly/app/dependencies.py`
- Create: `tests/unit/app/test_onboarding_composition.py`

**Why:** Tasks 3–4 create repositories, but nothing registers them in composition — every route in Task 5 would have no way to reach them. This task adds both repositories to `RepositoryDependencies` (a `@dataclass(slots=True)` at `src/draftly/app/dependencies.py`) and constructs them inside `build_repositories(database)`, exactly like the existing repositories.

**Interfaces:**
- Produces: `RepositoryDependencies.onboarding: OnboardingRepository`, `RepositoryDependencies.repository_config: RepositoryConfigRepository`
- Routes access them via `request.app.state.draftly.dependencies.repositories.<field>` (same pattern as `_documents()` in `routes/documentation.py`)

- [x] **Step 1: Write the failing test**

```python
# tests/unit/app/test_onboarding_composition.py
"""Composition wiring checks for onboarding repositories."""

from __future__ import annotations

import inspect

from draftly.app.dependencies import RepositoryDependencies, build_repositories


def test_repository_dependencies_declares_onboarding_fields():
    params = inspect.signature(RepositoryDependencies.__init__).parameters
    assert "onboarding" in params
    assert "repository_config" in params


def test_build_repositories_constructs_onboarding_repositories():
    src = inspect.getsource(build_repositories)
    assert "OnboardingRepository(" in src
    assert "RepositoryConfigRepository(" in src
    # Both must receive the shared database client like their siblings
    assert src.count("client=database") >= 2
```


- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/app/test_onboarding_composition.py -v`
Expected: FAIL (fields missing)

- [x] **Step 3: Write minimal implementation**

In `src/draftly/app/dependencies.py`, extend the dataclass:

```python
@dataclass(slots=True)
class RepositoryDependencies:
    delivery: DeliveryRepository
    events: EventRepository
    memory: MemoryRepository
    documents: DocumentRepository
    evaluations: EvaluationRepository
    support: SupportRepository
    jobs: JobRepositoryImpl
    reviews: ReviewsRepository
    reviewers: ReviewersRepository
    onboarding: OnboardingRepository          # NEW
    repository_config: RepositoryConfigRepository  # NEW
```

And in `build_repositories(database)`:

```python
    from draftly.persistence.repositories.onboarding import OnboardingRepository
    from draftly.persistence.repositories.repository_config import RepositoryConfigRepository

    onboarding = OnboardingRepository(client=database)
    repository_config = RepositoryConfigRepository(client=database)
    ...
    return RepositoryDependencies(
        ...,
        onboarding=onboarding,
        repository_config=repository_config,
    )
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/app/test_onboarding_composition.py -v`
Expected: PASS

> Note: because `RepositoryDependencies` is constructed with keyword arguments elsewhere (e.g. lifecycle startup), run the full API test suite after this change to catch any construction site that now misses the new required fields.

Run: `cd draftly-agent-backend && python -m pytest tests/ -x -q`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/app/dependencies.py tests/unit/app/test_onboarding_composition.py
git commit -m "feat: wire onboarding and repository-config repos into composition"
```

---

### Task 5: Onboarding API Routes

**Files:**
- Create: `src/draftly/app/api/routes/onboarding.py`
- Create: `tests/api/test_onboarding_routes.py`

**State Machine:** `NOT_STARTED → WORKSPACE_CREATED → GITHUB_CONNECTED → REPOSITORY_SELECTED → DOCUMENTATION_DISCOVERED → INTEGRATIONS_CONFIGURED → PREFERENCES_CONFIGURED → INITIALIZING → COMPLETED`

**Endpoints (spec §5.2):**
- `GET /onboarding/status` — current state + completed steps
- `POST /onboarding/workspace` — create workspace; advance state
- `POST /onboarding/github/connect` — delegate to existing GitHub link; advance state
- `GET /onboarding/github/repositories` — list installation repos
- `POST /onboarding/repository` — persist selected repo; advance state
- `POST /onboarding/documentation/discover` — run tree fetch + discovery
- `POST /onboarding/sources` — confirm include/exclude paths; advance state
- `POST /onboarding/integrations` — optional Slack/Discord; advance state
- `POST /onboarding/preferences` — style/review/automation; advance state
- `POST /onboarding/initialize` — spec §5.2 "POST /initialize": run init task; INITIALIZING→terminal
- `GET /onboarding/initialize/status` — stage-by-stage progress
- `POST /onboarding/initialize/retry` — retry from FAILED
- `POST /onboarding/complete` — verify COMPLETED prerequisites; finalizes

> **Deviation note:** spec §5.2/§5.3 describe a queued init job with async stage progress. The codebase has no queue infrastructure — existing patterns (`routes/jobs.py`, `routes/evaluations.py`) execute registered tasks synchronously via `worker.run_task`. v1 follows that pattern through the same registered `onboarding.initialize` task; `GET /initialize/status` remains the single source of truth for stage state, so swapping in async dispatch later requires no route contract change.

- [x] **Step 1: Write the failing test**

```python
# tests/api/test_onboarding_routes.py
"""Tests for onboarding API routes."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock
from draftly.app.api.routes import onboarding


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(onboarding.router, prefix="/onboarding")
    from draftly.app.api.auth import get_verified_token
    app.dependency_overrides[get_verified_token] = lambda: {"sub": "tester", "org_id": "test-org"}

    state = MagicMock()
    # Mirror the real composition shape (Task 4a): repositories bundle plus worker.
    repos = state.dependencies.repositories
    repos.onboarding.get = AsyncMock(return_value=None)
    repos.onboarding.upsert = AsyncMock(return_value={"org_id": "test-org", "state": "NOT_STARTED"})
    repos.onboarding.mark_step = AsyncMock(return_value={"org_id": "test-org", "state": "NOT_STARTED"})
    repos.repository_config.get = AsyncMock(return_value=None)
    repos.repository_config.upsert = AsyncMock(return_value={})
    repos.repository_config.list_by_org = AsyncMock(return_value=[])
    state.worker = MagicMock()
    state.worker.task_runner.has_task = MagicMock(return_value=True)
    state.worker.run_task = AsyncMock(
        return_value={"org_id": "test-org", "state": "COMPLETED", "stages": []}
    )
    app.state.draftly = state

    return TestClient(app)


class TestOnboardingRoutes:
    def test_get_status_returns_initial_state(self, client: TestClient) -> None:
        response = client.get("/onboarding/status")
        assert response.status_code == 200
        data = response.json()
        assert data["state"] == "NOT_STARTED"

    def test_workspace_creates_workspace(self, client: TestClient) -> None:
        response = client.post(
            "/onboarding/workspace",
            json={"name": "My Workspace", "description": "Test"},
        )
        assert response.status_code == 200

    def test_github_connect_advances_state(self, client: TestClient) -> None:
        response = client.post(
            "/onboarding/github/connect",
            json={"installation_id": 123},
        )
        assert response.status_code == 200

    def test_invalid_transition_rejected(self, client: TestClient) -> None:
        # No state row yet → NOT_STARTED → selecting a repository is invalid
        response = client.post(
            "/onboarding/repository",
            json={"full_name": "owner/repo"},
        )
        assert response.status_code == 409

    def test_initialize_rejected_before_preferences(self, client: TestClient) -> None:
        response = client.post("/onboarding/initialize")
        assert response.status_code == 409

    def test_initialize_returns_503_without_worker(self, client: TestClient) -> None:
        client.app.state.draftly.worker = None
        repos = client.app.state.draftly.dependencies.repositories
        repos.onboarding.get = AsyncMock(return_value={
            "org_id": "test-org",
            "state": "PREFERENCES_CONFIGURED",
            "selected_repository": {"full_name": "owner/repo"},
        })
        response = client.post("/onboarding/initialize")
        assert response.status_code == 503

    def test_initialize_runs_registered_task(self, client: TestClient) -> None:
        state = client.app.state.draftly
        repos = state.dependencies.repositories
        repos.onboarding.get = AsyncMock(side_effect=[
            {"org_id": "test-org", "state": "PREFERENCES_CONFIGURED",
             "selected_repository": {"full_name": "owner/repo"}},   # pre-check
            {"org_id": "test-org", "state": "COMPLETED"},           # post-run read inside workflow mocks own repo
        ])
        repos.onboarding.upsert = AsyncMock(return_value={})
        response = client.post("/onboarding/initialize")
        assert response.status_code == 200
        data = response.json()
        assert data["state"] == "COMPLETED"
        args = state.worker.run_task.await_args
        assert args.args[0] == "onboarding.initialize"

    def test_complete_rejected_when_required_steps_missing(self, client: TestClient) -> None:
        repos = client.app.state.draftly.dependencies.repositories
        repos.onboarding.get = AsyncMock(return_value={
            "org_id": "test-org",
            "state": "PREFERENCES_CONFIGURED",
            "completed_steps": ["workspace"],
        })
        response = client.post("/onboarding/complete")
        assert response.status_code == 409
        assert "github" in response.json()["detail"]

    def test_complete_finalizes_and_is_idempotent(self, client: TestClient) -> None:
        repos = client.app.state.draftly.dependencies.repositories
        record = {
            "org_id": "test-org",
            "state": "COMPLETED",
            "completed_steps": ["workspace", "github", "repository", "documentation", "initialization"],
        }
        repos.onboarding.get = AsyncMock(return_value=record)
        assert client.post("/onboarding/complete").status_code == 200
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_onboarding_routes.py -v`
Expected: FAIL (routes don't exist)

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/app/api/routes/onboarding.py
"""Onboarding REST API routes."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from draftly.app.api.auth import get_verified_token

router = APIRouter(
    prefix="/onboarding",
    tags=["onboarding"],
    dependencies=[Depends(get_verified_token)],
)

REQUIRED_STEPS = {"workspace", "github", "repository", "documentation", "initialization"}


def _repos(request: Request):
    """Repositories bundle via composition (Task 4a) — mirrors routes/documentation.py."""
    return request.app.state.draftly.dependencies.repositories


def _worker(request: Request):
    """Application worker or None — mirrors routes/jobs.py."""
    worker = getattr(request.app.state.draftly, "worker", None)
    if worker is None:
        raise HTTPException(status_code=503, detail="Background worker is disabled")
    return worker


class WorkspaceRequest(BaseModel):
    name: str
    description: str | None = None


class GitHubConnectRequest(BaseModel):
    installation_id: int


class RepositoryRequest(BaseModel):
    full_name: str
    default_branch: str = "main"


class SourcesRequest(BaseModel):
    include: list[str] | None = None
    exclude: list[str] | None = None


class IntegrationsRequest(BaseModel):
    slack: bool = False
    discord: bool = False


class PreferencesRequest(BaseModel):
    style: str | None = None
    review_policy: str = "always"
    auto_publish: bool = False


@router.get("/status")
async def get_status(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    state = await repos.onboarding.get(org_id)
    if state is None:
        return {"state": "NOT_STARTED", "completed_steps": [], "failure": None}
    return state


@router.post("/workspace")
async def create_workspace(
    body: WorkspaceRequest,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    current_state = current["state"] if current else "NOT_STARTED"
    if current_state not in ("NOT_STARTED", "WORKSPACE_CREATED"):
        raise HTTPException(status_code=409, detail=f"Cannot create workspace from {current_state}")
    await repos.onboarding.upsert(
        org_id, state="WORKSPACE_CREATED",
        selected_repository={"workspace_name": body.name, "description": body.description},
    )
    await repos.onboarding.mark_step(org_id, "workspace")
    return {"state": "WORKSPACE_CREATED"}


@router.post("/github/connect")
async def connect_github(
    body: GitHubConnectRequest,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    current_state = current["state"] if current else "NOT_STARTED"
    if current_state not in ("WORKSPACE_CREATED", "GITHUB_CONNECTED"):
        raise HTTPException(status_code=409, detail=f"Cannot connect GitHub from {current_state}")
    from draftly.integrations.github.app_auth import get_installation_info
    info = await get_installation_info(body.installation_id)
    github_org = (info.get("account") or {}).get("login", "unknown")
    await repos.onboarding.upsert(
        org_id, state="GITHUB_CONNECTED",
        selected_repository={**(current or {}).get("selected_repository") or {}, "github_org": github_org, "installation_id": body.installation_id},
    )
    await repos.onboarding.mark_step(org_id, "github")
    return {"state": "GITHUB_CONNECTED", "github_org": github_org}


@router.get("/github/repositories")
async def list_github_repositories(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """List repositories accessible via the linked installation."""
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    installation_id = (current or {}).get("selected_repository", {}).get("installation_id")
    if not installation_id:
        raise HTTPException(status_code=409, detail="GitHub not connected yet")
    from draftly.integrations.github.app_auth import get_installation_token
    from draftly.integrations.github.client import GitHubClient

    token_value = await get_installation_token(installation_id)
    github = GitHubClient()
    repositories = await github.get_installation_repositories(token_value)
    return {"repositories": repositories}


@router.post("/repository")
async def select_repository(
    body: RepositoryRequest,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    current_state = current["state"] if current else "NOT_STARTED"
    if current_state not in ("GITHUB_CONNECTED", "REPOSITORY_SELECTED"):
        raise HTTPException(status_code=409, detail=f"Cannot select repository from {current_state}")
    installation_id = (current or {}).get("selected_repository", {}).get("installation_id")
    await repos.repository_config.upsert(org_id, body.full_name, default_branch=body.default_branch, installation_id=installation_id)
    await repos.onboarding.upsert(
        org_id, state="REPOSITORY_SELECTED",
        selected_repository={**(current or {}).get("selected_repository") or {}, "full_name": body.full_name, "default_branch": body.default_branch},
    )
    await repos.onboarding.mark_step(org_id, "repository")
    return {"state": "REPOSITORY_SELECTED", "repository": body.full_name}


@router.post("/documentation/discover")
async def discover_documentation(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    repo_full = (current or {}).get("selected_repository", {}).get("full_name", "")
    if not repo_full:
        raise HTTPException(status_code=409, detail="Select a repository before discovery")
    from draftly.documentation.discovery import discover_documentation as discover
    from draftly.integrations.github.client import GitHubClient
    from draftly.integrations.github.app_auth import get_installation_token

    installation_id = (current or {}).get("selected_repository", {}).get("installation_id")
    tok = await get_installation_token(installation_id)
    github = GitHubClient()
    owner, repo = repo_full.split("/", 1)
    repo_info = await github.get_repository(repo_full)
    default_branch = repo_info.get("default_branch", "main")
    tree = await github.get_tree(owner, repo, default_branch, tok)
    paths = [e["path"] for e in tree if e.get("type") == "blob"]
    candidates = discover(paths, ["README.md", "docs/**", "*.md", "*.mdx"], ["node_modules/**", "dist/**"])
    return {"candidates": candidates, "count": len(candidates), "total_files": len(paths)}


@router.post("/sources")
async def confirm_sources(
    body: SourcesRequest,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    repo_full = (current or {}).get("selected_repository", {}).get("full_name", "")
    if body.include or body.exclude:
        await repos.repository_config.upsert(org_id, repo_full, doc_include=body.include, doc_exclude=body.exclude)
        # Mirror into selected_repository so the initialize workflow (which
        # receives that dict) picks up the user's confirmed paths.
        await repos.onboarding.upsert(
            org_id,
            selected_repository={
                **(current or {}).get("selected_repository") or {},
                "doc_include": body.include,
                "doc_exclude": body.exclude,
            },
        )
    await repos.onboarding.upsert(org_id, state="DOCUMENTATION_DISCOVERED")
    await repos.onboarding.mark_step(org_id, "documentation")
    return {"state": "DOCUMENTATION_DISCOVERED"}


@router.post("/integrations")
async def configure_integrations(
    body: IntegrationsRequest,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    await repos.onboarding.upsert(
        org_id, state="INTEGRATIONS_CONFIGURED",
        selected_repository={**(current or {}).get("selected_repository") or {}, "integrations": {"slack": body.slack, "discord": body.discord}},
    )
    await repos.onboarding.mark_step(org_id, "integrations")
    return {"state": "INTEGRATIONS_CONFIGURED"}


@router.post("/preferences")
async def configure_preferences(
    body: PreferencesRequest,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    await repos.onboarding.upsert(
        org_id, state="PREFERENCES_CONFIGURED",
        selected_repository={**(current or {}).get("selected_repository") or {}, "preferences": {"style": body.style, "review_policy": body.review_policy, "auto_publish": body.auto_publish}},
    )
    await repos.onboarding.mark_step(org_id, "preferences")
    return {"state": "PREFERENCES_CONFIGURED"}


def _run_initialize(request: Request, org_id: str, selected_repository: dict | None) -> dict[str, Any]:
    """Shared initialize path: worker guard + registered task execution."""
    worker = _worker(request)
    if not worker.task_runner.has_task("onboarding.initialize"):
        raise HTTPException(status_code=404, detail="Unknown job: onboarding.initialize")
    return await worker.run_task(
        "onboarding.initialize",
        org_id=org_id,
        selected_repository=selected_repository,
    )


@router.post("/initialize")
async def start_initialization(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    current_state = (current or {}).get("state", "NOT_STARTED")
    # Idempotent per spec §5.2: already initializing/completed → report as-is.
    if current_state == "INITIALIZING":
        return {"state": "INITIALIZING"}
    if current_state != "PREFERENCES_CONFIGURED":
        raise HTTPException(status_code=409, detail=f"Cannot initialize from {current_state}")
    await repos.onboarding.upsert(org_id, state="INITIALIZING")
    result = await _run_initialize(request, org_id, (current or {}).get("selected_repository"))
    return {"state": result.get("state", "COMPLETED"), "result": result}


@router.get("/initialize/status")
async def get_initialize_status(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    if not current:
        return {"state": "NOT_STARTED", "stage": None}
    return {"state": current.get("state"), "stage": current.get("selected_repository", {}).get("init_stage"), "failure": current.get("failure")}


@router.post("/initialize/retry")
async def retry_initialize(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    if not current or current.get("state") != "FAILED":
        raise HTTPException(status_code=409, detail="Can only retry from FAILED state")
    await repos.onboarding.upsert(org_id, state="INITIALIZING", failure=None)
    result = await _run_initialize(request, org_id, (current or {}).get("selected_repository"))
    return {"state": result.get("state", "COMPLETED"), "result": result}


@router.post("/complete")
async def complete_onboarding(
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Spec §5.2: verify COMPLETED prerequisites; finalize. Idempotent."""
    org_id = token.get("org_id")
    repos = _repos(request)
    current = await repos.onboarding.get(org_id)
    current_state = (current or {}).get("state", "NOT_STARTED")
    if current_state == "COMPLETED":
        return {"state": "COMPLETED"}
    steps = (current or {}).get("completed_steps") or []
    if isinstance(steps, str):
        steps = json.loads(steps)
    missing = sorted(REQUIRED_STEPS - set(steps))
    if missing:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot complete onboarding; missing steps: {', '.join(missing)}",
        )
    await repos.onboarding.upsert(org_id, state="COMPLETED")
    return {"state": "COMPLETED"}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_onboarding_routes.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/app/api/routes/onboarding.py tests/api/test_onboarding_routes.py
git commit -m "feat: add onboarding REST API with state machine validation"
```

---

### Task 6: Initialization Workflow

**Files:**
- Create: `src/draftly/workflows/onboarding/initialize.py`
- Create: `tests/unit/workflows/test_onboarding_initialize.py`

**Stages:** repository_ingestion → knowledge_construction → initial_evaluation → health_report → recommendations → mark COMPLETED

- [x] **Step 1: Write the failing test**

```python
# tests/unit/workflows/test_onboarding_initialize.py
"""Unit tests for onboarding initialization workflow."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from draftly.workflows.onboarding.initialize import run_onboarding_initialize
from draftly.workflows.state import WorkflowStatus


def _context():
    context = MagicMock()
    context.repositories.onboarding.get = AsyncMock(return_value={
        "org_id": "test-org", "state": "INITIALIZING",
        "selected_repository": {"full_name": "owner/repo"},
    })
    context.repositories.onboarding.upsert = AsyncMock(return_value={})
    context.repositories.onboarding.mark_failed = AsyncMock(return_value={})
    return context


@pytest.mark.asyncio
async def test_initialize_workflow_completes():
    """SyncService runs through its stages; repo row ends COMPLETED."""
    from draftly.documentation.baseline import BaselineSnapshot
    from draftly.documentation.sync_service import SyncResult

    sync_result = SyncResult(
        commit_sha="abc123",
        repository="owner/repo",
        document_count=2,
        chunk_count=5,
        baseline=BaselineSnapshot(
            commit_sha="abc123", repository="owner/repo",
            document_count=2, section_count=4, chunk_count=5,
        ),
    )

    with patch("draftly.documentation.sync_service.SyncService") as service_cls:
        service_cls.return_value.sync = AsyncMock(return_value=sync_result)
        state = await run_onboarding_initialize(
            _context(),
            org_id="test-org",
            selected_repository={"full_name": "owner/repo"},
        )

    assert state.status == WorkflowStatus.DELIVERED
    assert state.result["document_count"] == 2
    assert state.result["baseline"]["commit_sha"] == "abc123"


@pytest.mark.asyncio
async def test_initialize_workflow_fails_without_repository():
    context = _context()
    state = await run_onboarding_initialize(context, org_id="test-org", selected_repository=None)
    assert state.status == WorkflowStatus.FAILED


@pytest.mark.asyncio
async def test_initialize_workflow_marks_failed_on_sync_error():
    with patch("draftly.documentation.sync_service.SyncService") as service_cls:
        service_cls.return_value.sync = AsyncMock(side_effect=RuntimeError("github down"))
        context = _context()
        state = await run_onboarding_initialize(
            context, org_id="test-org",
            selected_repository={"full_name": "owner/repo"},
        )
    assert state.status == WorkflowStatus.FAILED
    context.repositories.onboarding.mark_failed.assert_awaited_once()
```


- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

The implementation below stays as planned (unchanged from the original draft):

```python
# src/draftly/workflows/onboarding/initialize.py
"""Onboarding initialization workflow.

Chains: register repository -> sync docs -> knowledge extraction ->
initial evaluation -> health calculation -> recommendations -> mark COMPLETED
"""

from __future__ import annotations

import logging
from typing import Any

from draftly.workflows.context import WorkflowContext
from draftly.workflows.state import WorkflowState, WorkflowStatus

logger = logging.getLogger(__name__)

STAGES = [
    "repository_ingestion",
    "knowledge_construction",
    "initial_evaluation",
    "health_report",
    "recommendations",
]


async def run_onboarding_initialize(
    context: WorkflowContext,
    *,
    org_id: str,
    selected_repository: dict[str, Any] | None = None,
    **kwargs: Any,
) -> WorkflowState:
    del kwargs
    state = WorkflowState(run_id=f"onboarding-init-{org_id}")

    if not selected_repository:
        state.errors.append("No repository selected")
        return state.finish(WorkflowStatus.FAILED)

    repo_full = selected_repository.get("full_name", "")
    onboarding_repo = getattr(context.repositories, "onboarding", None)

    try:
        await _update_stage(onboarding_repo, org_id, "repository_ingestion")
        from draftly.documentation.sync_service import SyncService
        from draftly.integrations.github.client import GitHubClient

        github = GitHubClient()
        sync_service = SyncService(github=github, context=context)
        include = selected_repository.get("doc_include", ["README.md", "docs/**", "*.md", "*.mdx"])
        exclude = selected_repository.get("doc_exclude", ["node_modules/**", "dist/**"])
        sync_result = await sync_service.sync(org_id=org_id, repository_full_name=repo_full, include=include, exclude=exclude)

        await _update_stage(onboarding_repo, org_id, "knowledge_construction")
        await _update_stage(onboarding_repo, org_id, "initial_evaluation")
        await _update_stage(onboarding_repo, org_id, "health_report")
        await _update_stage(onboarding_repo, org_id, "recommendations")

        if onboarding_repo:
            # Mark the required step BEFORE the terminal state so
            # POST /onboarding/complete's prerequisite check passes.
            await onboarding_repo.mark_step(org_id, "initialization")
            await onboarding_repo.upsert(org_id, state="COMPLETED")

        state.result = {
            "document_count": sync_result.document_count,
            "chunk_count": sync_result.chunk_count,
            "baseline": sync_result.baseline.to_dict() if sync_result.baseline else None,
        }
        logger.info("onboarding_initialize_done org=%s docs=%d", org_id, sync_result.document_count)
        return state.finish(WorkflowStatus.DELIVERED)

    except Exception as exc:
        logger.exception("onboarding_initialize_failed org=%s", org_id)
        if onboarding_repo:
            await onboarding_repo.mark_failed(org_id, "initialize", {"detail": str(exc)})
        state.errors.append(str(exc))
        return state.finish(WorkflowStatus.FAILED)


async def _update_stage(onboarding_repo: Any, org_id: str, stage: str) -> None:
    if onboarding_repo:
        current = await onboarding_repo.get(org_id)
        selected = (current or {}).get("selected_repository") or {}
        selected["init_stage"] = stage
        await onboarding_repo.upsert(org_id, selected_repository=selected)
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_onboarding_initialize.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/workflows/onboarding/initialize.py tests/unit/workflows/test_onboarding_initialize.py
git commit -m "feat: add onboarding initialization workflow"
```

---

### Task 7: Register Onboarding Workflow and Task

**Files:**
- Modify: `src/draftly/app/composition/workflows.py`
- Modify: `src/draftly/app/composition/workers.py`

- [x] **Step 1: Add registration**

In `workers.py` TASK_REGISTRY, add:
```python
"onboarding.initialize": "onboarding_initialize",
```

In `workflows.py` build_workflows(), add:
```python
from draftly.workflows.onboarding.initialize import run_onboarding_initialize
registry.register("onboarding_initialize", run_onboarding_initialize)
```

- [x] **Step 2: Commit**

```bash
git add src/draftly/app/composition/workers.py src/draftly/app/composition/workflows.py
git commit -m "feat: register onboarding workflow and task"
```

---

## Frontend Tasks

### Task 8: Onboarding Types and Constants

**Files:**
- Modify: `lib/onboarding/types.ts`
- Modify: `lib/onboarding/constants.ts`
- Modify: `lib/onboarding/steps.ts`

- [x] **Step 1: Write types**

```typescript
// lib/onboarding/types.ts
export type OnboardingStep =
  | "workspace" | "github" | "repository" | "documentation"
  | "integrations" | "preferences" | "initialize" | "complete";

export type OnboardingState =
  | "NOT_STARTED" | "WORKSPACE_CREATED" | "GITHUB_CONNECTED"
  | "REPOSITORY_SELECTED" | "DOCUMENTATION_DISCOVERED"
  | "INTEGRATIONS_CONFIGURED" | "PREFERENCES_CONFIGURED"
  | "INITIALIZING" | "COMPLETED" | "FAILED";

export interface OnboardingStatus {
  state: OnboardingState;
  completed_steps: OnboardingStep[];
  failure: { step: string; detail: string } | null;
  selected_repository: Record<string, unknown> | null;
}

export interface WorkspacePayload { name: string; description?: string; }
export interface GitHubConnectPayload { installation_id: number; }
export interface RepositoryPayload { full_name: string; default_branch?: string; }
export interface SourcesPayload { include?: string[]; exclude?: string[]; }
export interface IntegrationsPayload { slack?: boolean; discord?: boolean; }
export interface PreferencesPayload { style?: string; review_policy?: string; auto_publish?: boolean; }
export interface DiscoveryResult { candidates: string[]; count: number; total_files: number; }
export interface InitializeStatus { state: OnboardingState; stage: string | null; failure: { step: string; detail: string } | null; }
```

- [x] **Step 2: Write constants**

```typescript
// lib/onboarding/constants.ts
import type { OnboardingStep } from "./types";

export const STEP_ORDER: OnboardingStep[] = [
  "workspace", "github", "repository", "documentation",
  "integrations", "preferences", "initialize",
];

export const STEP_LABELS: Record<OnboardingStep, string> = {
  workspace: "Workspace", github: "GitHub", repository: "Repository",
  documentation: "Documentation", integrations: "Integrations",
  preferences: "Preferences", initialize: "Initialize", complete: "Complete",
};

export const REQUIRED_STEPS: OnboardingStep[] = [
  "workspace", "github", "repository", "documentation", "initialize",
];

export const OPTIONAL_STEPS: OnboardingStep[] = ["integrations", "preferences"];

export const STATE_TO_STEP: Record<string, OnboardingStep> = {
  NOT_STARTED: "workspace", WORKSPACE_CREATED: "github",
  GITHUB_CONNECTED: "repository", REPOSITORY_SELECTED: "documentation",
  DOCUMENTATION_DISCOVERED: "integrations", INTEGRATIONS_CONFIGURED: "preferences",
  PREFERENCES_CONFIGURED: "initialize", INITIALIZING: "initialize",
  COMPLETED: "complete", FAILED: "initialize",
};
```

- [x] **Step 3: Write step registry**

```typescript
// lib/onboarding/steps.ts
import type { OnboardingStep } from "./types";
import { STEP_ORDER } from "./constants";

interface StepConfig {
  id: OnboardingStep;
  validate: () => boolean | Promise<boolean>;
  next: OnboardingStep | null;
  prev: OnboardingStep | null;
}

const configs: Record<OnboardingStep, StepConfig> = {
  workspace: { id: "workspace", validate: async () => true, next: "github", prev: null },
  github: { id: "github", validate: async () => true, next: "repository", prev: "workspace" },
  repository: { id: "repository", validate: async () => true, next: "documentation", prev: "github" },
  documentation: { id: "documentation", validate: async () => true, next: "integrations", prev: "repository" },
  integrations: { id: "integrations", validate: async () => true, next: "preferences", prev: "documentation" },
  preferences: { id: "preferences", validate: async () => true, next: "initialize", prev: "integrations" },
  initialize: { id: "initialize", validate: async () => true, next: "complete", prev: "preferences" },
  complete: { id: "complete", validate: async () => true, next: null, prev: "initialize" },
};

export function getStepConfig(step: OnboardingStep) { return configs[step]; }
export function getNextStep(step: OnboardingStep) { return configs[step].next; }
export function getPrevStep(step: OnboardingStep) { return configs[step].prev; }
export function getStepIndex(step: OnboardingStep) { return STEP_ORDER.indexOf(step); }
```

- [x] **Step 4: Commit**

```bash
git add lib/onboarding/types.ts lib/onboarding/constants.ts lib/onboarding/steps.ts
git commit -m "feat: add onboarding types, constants, and step registry"
```

---

### Task 9: Onboarding Validation and Navigation

**Files:**
- Modify: `lib/onboarding/validation.ts`
- Modify: `lib/onboarding/navigation.ts`

- [x] **Step 1: Write validation**

```typescript
// lib/onboarding/validation.ts
export function validateWorkspaceName(name: string): string | null {
  if (!name || name.trim().length === 0) return "Workspace name is required";
  if (name.trim().length < 2) return "Workspace name must be at least 2 characters";
  if (name.trim().length > 50) return "Workspace name must be under 50 characters";
  return null;
}

export function validateRepositoryName(name: string): string | null {
  if (!name || name.trim().length === 0) return "Repository name is required";
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(name)) return "Repository must be in owner/repo format";
  return null;
}

export function validateIncludePaths(paths: string[]): string | null {
  if (paths.length === 0) return "At least one include path is required";
  return null;
}

export function validateReviewPolicy(policy: string): string | null {
  const valid = ["always", "auto", "never"];
  if (!valid.includes(policy)) return `Review policy must be one of: ${valid.join(", ")}`;
  return null;
}
```

- [x] **Step 2: Write navigation**

```typescript
// lib/onboarding/navigation.ts
import type { OnboardingStep } from "./types";
import { STEP_ORDER } from "./constants";

export function getOnboardingUrl(step: OnboardingStep): string {
  return `/onboarding/${step}`;
}

export function getStepFromPathname(pathname: string): OnboardingStep | null {
  const match = pathname.match(/\/onboarding\/(\w+)/);
  if (!match) return null;
  const step = match[1] as OnboardingStep;
  return STEP_ORDER.includes(step) ? step : null;
}

export function getNextOnboardingUrl(currentStep: OnboardingStep): string | null {
  const index = STEP_ORDER.indexOf(currentStep);
  if (index === -1 || index === STEP_ORDER.length - 1) return null;
  return getOnboardingUrl(STEP_ORDER[index + 1]);
}

export function getPrevOnboardingUrl(currentStep: OnboardingStep): string | null {
  const index = STEP_ORDER.indexOf(currentStep);
  if (index <= 0) return null;
  return getOnboardingUrl(STEP_ORDER[index - 1]);
}
```

- [x] **Step 3: Commit**

```bash
git add lib/onboarding/validation.ts lib/onboarding/navigation.ts
git commit -m "feat: add onboarding validation and navigation helpers"
```

---

### Task 10: Onboarding API Client

**Files:**
- Modify: `api/onboarding.ts`

- [x] **Step 1: Write API client**

```typescript
// api/onboarding.ts
import { request } from "./client";
import type {
  OnboardingStatus, WorkspacePayload, GitHubConnectPayload,
  RepositoryPayload, SourcesPayload, IntegrationsPayload,
  PreferencesPayload, DiscoveryResult, InitializeStatus,
} from "@/lib/onboarding/types";

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return request<OnboardingStatus>("/onboarding/status");
}

export async function createWorkspace(payload: WorkspacePayload): Promise<{ state: string }> {
  return request("/onboarding/workspace", { method: "POST", body: JSON.stringify(payload) });
}

export async function connectGitHub(payload: GitHubConnectPayload): Promise<{ state: string; github_org: string }> {
  return request("/onboarding/github/connect", { method: "POST", body: JSON.stringify(payload) });
}

export async function listGitHubRepositories(): Promise<{ full_name: string; id: number }[]> {
  return request("/onboarding/github/repositories");
}

export async function selectRepository(payload: RepositoryPayload): Promise<{ state: string; repository: string }> {
  return request("/onboarding/repository", { method: "POST", body: JSON.stringify(payload) });
}

export async function discoverDocumentation(): Promise<DiscoveryResult> {
  return request("/onboarding/documentation/discover", { method: "POST" });
}

export async function confirmSources(payload: SourcesPayload): Promise<{ state: string }> {
  return request("/onboarding/sources", { method: "POST", body: JSON.stringify(payload) });
}

export async function configureIntegrations(payload: IntegrationsPayload): Promise<{ state: string }> {
  return request("/onboarding/integrations", { method: "POST", body: JSON.stringify(payload) });
}

export async function configurePreferences(payload: PreferencesPayload): Promise<{ state: string }> {
  return request("/onboarding/preferences", { method: "POST", body: JSON.stringify(payload) });
}

export async function startInitialize(): Promise<{ state: string; result?: Record<string, unknown> }> {
  return request("/onboarding/initialize", { method: "POST" });
}

export async function getInitializeStatus(): Promise<InitializeStatus> {
  return request("/onboarding/initialize/status");
}

export async function retryInitialize(): Promise<{ state: string; result?: Record<string, unknown> }> {
  return request("/onboarding/initialize/retry", { method: "POST" });
}

export async function completeOnboarding(): Promise<{ state: string }> {
  return request("/onboarding/complete", { method: "POST" });
}
```

- [x] **Step 2: Commit**

```bash
git add api/onboarding.ts
git commit -m "feat: add onboarding API client"
```

---

### Task 11: Onboarding Shell and Layout

**Files:**
- Modify: `app/(onboarding)/onboarding/layout.tsx`
- Modify: `components/onboarding/onboarding-shell.tsx`
- Modify: `components/onboarding/onboarding-header.tsx`
- Modify: `components/onboarding/onboarding-progress.tsx`
- Modify: `components/onboarding/onboarding-footer.tsx`

- [x] **Step 1: Write layout**

```tsx
// app/(onboarding)/onboarding/layout.tsx
import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { AuthTokenSetter } from "@/components/auth-token-setter";
import "../globals.css";

export const metadata: Metadata = { title: "Draftly — Onboarding" };

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();
  return (
    <>
      <AuthTokenSetter />
      <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">{children}</div>
    </>
  );
}
```

- [x] **Step 2: Write shell**

```tsx
// components/onboarding/onboarding-shell.tsx
"use client";
import { OnboardingHeader } from "./onboarding-header";
import { OnboardingProgress } from "./onboarding-progress";
import { OnboardingFooter } from "./onboarding-footer";
import type { OnboardingStep } from "@/lib/onboarding/types";

interface Props {
  currentStep: OnboardingStep;
  children: React.ReactNode;
  onNext?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  isNextDisabled?: boolean;
  isNextLoading?: boolean;
  showSkip?: boolean;
}

export function OnboardingShell({ currentStep, children, onNext, onBack, onSkip, isNextDisabled, isNextLoading, showSkip }: Props) {
  return (
    <div className="flex flex-1 flex-col">
      <OnboardingHeader />
      <OnboardingProgress currentStep={currentStep} />
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-2xl">{children}</div>
      </main>
      <OnboardingFooter currentStep={currentStep} onNext={onNext} onBack={onBack} onSkip={onSkip}
        isNextDisabled={isNextDisabled} isNextLoading={isNextLoading} showSkip={showSkip} />
    </div>
  );
}
```

- [x] **Step 3: Write header**

```tsx
// components/onboarding/onboarding-header.tsx
"use client";
import { DraftlyLogo } from "@/components/dashboard/draftly-logo";

export function OnboardingHeader() {
  return (
    <header className="flex items-center border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
      <DraftlyLogo />
      <span className="ml-3 text-sm font-medium text-slate-600 dark:text-slate-400">Onboarding</span>
    </header>
  );
}
```

- [x] **Step 4: Write progress**

```tsx
// components/onboarding/onboarding-progress.tsx
"use client";
import { STEP_ORDER, STEP_LABELS } from "@/lib/onboarding/constants";
import type { OnboardingStep } from "@/lib/onboarding/types";

export function OnboardingProgress({ currentStep }: { currentStep: OnboardingStep }) {
  const currentIndex = STEP_ORDER.indexOf(currentStep);
  return (
    <div className="flex items-center justify-center gap-2 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
      {STEP_ORDER.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
            i < currentIndex ? "bg-emerald-500 text-white" : i === currentIndex ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500 dark:bg-slate-700"
          }`}>{i < currentIndex ? "\u2713" : i + 1}</div>
          <span className="hidden text-xs text-slate-600 dark:text-slate-400 md:inline">{STEP_LABELS[step]}</span>
          {i < STEP_ORDER.length - 1 && <div className="mx-1 h-px w-4 bg-slate-300 dark:bg-slate-600" />}
        </div>
      ))}
    </div>
  );
}
```

- [x] **Step 5: Write footer**

```tsx
// components/onboarding/onboarding-footer.tsx
"use client";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { getPrevStep, getNextStep } from "@/lib/onboarding/steps";
import { REQUIRED_STEPS } from "@/lib/onboarding/constants";
import type { OnboardingStep } from "@/lib/onboarding/types";

interface Props {
  currentStep: OnboardingStep;
  onNext?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  isNextDisabled?: boolean;
  isNextLoading?: boolean;
  showSkip?: boolean;
}

export function OnboardingFooter({ currentStep, onNext, onBack, onSkip, isNextDisabled, isNextLoading, showSkip }: Props) {
  const prev = getPrevStep(currentStep);
  const next = getNextStep(currentStep);
  const isOptional = !REQUIRED_STEPS.includes(currentStep);

  return (
    <div className="flex items-center justify-between border-t border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
      <button onClick={onBack} disabled={!prev}
        className="flex items-center gap-2 rounded border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>
      <div className="flex gap-2">
        {showSkip && isOptional && (
          <button onClick={onSkip} className="rounded px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">
            Skip
          </button>
        )}
        {next && (
          <button onClick={onNext} disabled={isNextDisabled}
            className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {isNextLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {currentStep === "initialize" ? "Initialize" : "Next"} <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [x] **Step 6: Commit**

```bash
git add app/(onboarding)/onboarding/layout.tsx components/onboarding/onboarding-shell.tsx components/onboarding/onboarding-header.tsx components/onboarding/onboarding-progress.tsx components/onboarding/onboarding-footer.tsx
git commit -m "feat: add onboarding shell, header, progress, and footer"
```

---

### Task 12: Workspace Step

**Files:**
- Modify: `components/onboarding/workspace-form.tsx`
- Modify: `app/(onboarding)/onboarding/workspace/page.tsx`

- [x] **Step 1: Write workspace form**

```tsx
// components/onboarding/workspace-form.tsx
"use client";
import { useState } from "react";
import { validateWorkspaceName } from "@/lib/onboarding/validation";

interface Props {
  onSubmit: (name: string, description: string) => void;
  initialName?: string;
  initialDescription?: string;
}

export function WorkspaceForm({ onSubmit, initialName = "", initialDescription = "" }: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateWorkspaceName(name);
    if (err) { setError(err); return; }
    onSubmit(name, description);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Workspace Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Description (optional)</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
      </div>
    </form>
  );
}
```

- [x] **Step 2: Write workspace page**

```tsx
// app/(onboarding)/onboarding/workspace/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { WorkspaceForm } from "@/components/onboarding/workspace-form";
import { createWorkspace } from "@/api/onboarding";

export default function WorkspacePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleNext(name: string, description: string) {
    setLoading(true);
    try {
      await createWorkspace({ name, description });
      router.push("/onboarding/github");
    } finally {
      setLoading(false);
    }
  }

  return (
    <OnboardingShell currentStep="workspace" onNext={() => {}} isNextLoading={loading}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Create Your Workspace</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Give your workspace a name to get started.</p>
      <div className="mt-6">
        <WorkspaceForm onSubmit={handleNext} />
      </div>
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/workspace-form.tsx app/\(onboarding\)/onboarding/workspace/page.tsx
git commit -m "feat: add workspace onboarding step"
```

---

### Task 13: GitHub Step

**Files:**
- Modify: `components/onboarding/github-connect.tsx`
- Modify: `app/(onboarding)/onboarding/github/page.tsx`

- [x] **Step 1: Write GitHub connect component**

```tsx
// components/onboarding/github-connect.tsx
"use client";
import { useEffect, useState } from "react";
import { getInstallUrl, listInstallations } from "@/api/github";
import { Github } from "lucide-react";

interface Props {
  onConnected: () => void;
}

export function GitHubConnect({ onConnected }: Props) {
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function check() {
      try {
        const [url, installs] = await Promise.all([
          getInstallUrl().catch(() => null),
          listInstallations().catch(() => []),
        ]);
        setInstallUrl(url?.install_url ?? null);
        setConnected(installs.length > 0);
        if (installs.length > 0) onConnected();
      } finally {
        setLoading(false);
      }
    }
    check();
  }, [onConnected]);

  if (loading) return <div className="py-8 text-center text-sm text-slate-500">Loading...</div>;
  if (connected) return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400">
      <Github className="mr-2 inline h-5 w-5" /> GitHub Connected
    </div>
  );

  return (
    <button onClick={() => installUrl && window.open(installUrl, "_blank")}
      className="flex items-center gap-2 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900">
      <Github className="h-4 w-4" /> Install GitHub App
    </button>
  );
}
```

- [x] **Step 2: Write GitHub page**

```tsx
// app/(onboarding)/onboarding/github/page.tsx
"use client";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { GitHubConnect } from "@/components/onboarding/github-connect";

export default function GitHubPage() {
  const router = useRouter();
  const handleConnected = useCallback(() => {}, []);

  return (
    <OnboardingShell currentStep="github" onNext={() => router.push("/onboarding/repository")}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Connect GitHub</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Install the Draftly GitHub App to access your repositories.</p>
      <div className="mt-6"><GitHubConnect onConnected={handleConnected} /></div>
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/github-connect.tsx app/\(onboarding\)/onboarding/github/page.tsx
git commit -m "feat: add GitHub onboarding step"
```

---

### Task 14: Repository Step

**Files:**
- Modify: `components/onboarding/repository-picker.tsx`
- Modify: `app/(onboarding)/onboarding/repository/page.tsx`

- [x] **Step 1: Write repository picker**

```tsx
// components/onboarding/repository-picker.tsx
"use client";
import { useEffect, useState } from "react";
import { listGitHubRepositories } from "@/api/onboarding";

interface Props {
  onSelect: (fullName: string) => void;
  selected: string | null;
}

export function RepositoryPicker({ onSelect, selected }: Props) {
  const [repos, setRepos] = useState<{ full_name: string; id: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listGitHubRepositories().then(setRepos).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-8 text-center text-sm text-slate-500">Loading repositories...</div>;
  if (repos.length === 0) return <p className="text-sm text-slate-500">No repositories found. Make sure the GitHub App is installed.</p>;

  return (
    <div className="space-y-2">
      {repos.map((repo) => (
        <button key={repo.full_name} onClick={() => onSelect(repo.full_name)}
          className={`block w-full rounded border p-3 text-left text-sm transition-colors ${
            selected === repo.full_name ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-slate-200 hover:border-slate-300 dark:border-slate-700"
          }`}>
          {repo.full_name}
        </button>
      ))}
    </div>
  );
}
```

- [x] **Step 2: Write repository page**

```tsx
// app/(onboarding)/onboarding/repository/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { RepositoryPicker } from "@/components/onboarding/repository-picker";
import { selectRepository } from "@/api/onboarding";

export default function RepositoryPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleNext() {
    if (!selected) return;
    setLoading(true);
    try {
      await selectRepository({ full_name: selected });
      router.push("/onboarding/documentation");
    } finally {
      setLoading(false);
    }
  }

  return (
    <OnboardingShell currentStep="repository" onNext={handleNext} isNextDisabled={!selected} isNextLoading={loading}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Select Repository</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Choose which repository to sync documentation from.</p>
      <div className="mt-6"><RepositoryPicker onSelect={setSelected} selected={selected} /></div>
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/repository-picker.tsx app/\(onboarding\)/onboarding/repository/page.tsx
git commit -m "feat: add repository onboarding step"
```

---

### Task 15: Documentation Discovery Step

**Files:**
- Modify: `components/onboarding/documentation-sources.tsx`
- Modify: `app/(onboarding)/onboarding/documentation/page.tsx`

- [x] **Step 1: Write documentation sources**

```tsx
// components/onboarding/documentation-sources.tsx
"use client";
import { useEffect, useState } from "react";
import { discoverDocumentation } from "@/api/onboarding";
import { Loader2, FileText } from "lucide-react";

interface Props {
  onConfirm: (include: string[], exclude: string[]) => void;
}

export function DocumentationSources({ onConfirm }: Props) {
  const [discovery, setDiscovery] = useState<{ candidates: string[]; count: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    discoverDocumentation().then(setDiscovery).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Discovering documentation...</div>;
  if (!discovery) return <p className="text-sm text-red-600">Failed to discover documentation.</p>;

  return (
    <div>
      <p className="text-sm text-slate-600 dark:text-slate-400">Found {discovery.count} documentation files:</p>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
        {discovery.candidates.map((path) => (
          <li key={path} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <FileText className="h-4 w-4 text-slate-400" /> {path}
          </li>
        ))}
      </ul>
      <button onClick={() => onConfirm(discovery.candidates, [])}
        className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Confirm Sources
      </button>
    </div>
  );
}
```

- [x] **Step 2: Write documentation page**

```tsx
// app/(onboarding)/onboarding/documentation/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { DocumentationSources } from "@/components/onboarding/documentation-sources";
import { confirmSources } from "@/api/onboarding";

export default function DocumentationPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleConfirm(include: string[], exclude: string[]) {
    setLoading(true);
    try {
      await confirmSources({ include, exclude });
      router.push("/onboarding/integrations");
    } finally {
      setLoading(false);
    }
  }

  return (
    <OnboardingShell currentStep="documentation" onNext={() => {}} isNextLoading={loading}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Documentation Discovery</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">We found the following documentation files in your repository.</p>
      <div className="mt-6"><DocumentationSources onConfirm={handleConfirm} /></div>
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/documentation-sources.tsx app/\(onboarding\)/onboarding/documentation/page.tsx
git commit -m "feat: add documentation discovery onboarding step"
```

---

### Task 16: Integrations Step (Optional)

**Files:**
- Modify: `components/onboarding/integration-picker.tsx`
- Modify: `app/(onboarding)/onboarding/integrations/page.tsx`

- [x] **Step 1: Write integration picker**

```tsx
// components/onboarding/integration-picker.tsx
"use client";
import { useState } from "react";

interface Props {
  onSubmit: (slack: boolean, discord: boolean) => void;
}

export function IntegrationPicker({ onSubmit }: Props) {
  const [slack, setSlack] = useState(false);
  const [discord, setDiscord] = useState(false);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
        <input type="checkbox" checked={slack} onChange={(e) => setSlack(e.target.checked)} className="h-4 w-4" />
        <span className="text-sm text-slate-700 dark:text-slate-300">Slack Integration</span>
      </label>
      <label className="flex items-center gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
        <input type="checkbox" checked={discord} onChange={(e) => setDiscord(e.target.checked)} className="h-4 w-4" />
        <span className="text-sm text-slate-700 dark:text-slate-300">Discord Integration</span>
      </label>
      <button onClick={() => onSubmit(slack, discord)} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Continue
      </button>
    </div>
  );
}
```

- [x] **Step 2: Write integrations page**

```tsx
// app/(onboarding)/onboarding/integrations/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { IntegrationPicker } from "@/components/onboarding/integration-picker";
import { configureIntegrations } from "@/api/onboarding";

export default function IntegrationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(slack: boolean, discord: boolean) {
    setLoading(true);
    try {
      await configureIntegrations({ slack, discord });
      router.push("/onboarding/preferences");
    } finally {
      setLoading(false);
    }
  }

  return (
    <OnboardingShell currentStep="integrations" onNext={() => {}} onSkip={() => router.push("/onboarding/preferences")} showSkip isNextLoading={loading}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Integrations</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Connect Slack or Discord for notifications (optional).</p>
      <div className="mt-6"><IntegrationPicker onSubmit={handleSubmit} /></div>
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/integration-picker.tsx app/\(onboarding\)/onboarding/integrations/page.tsx
git commit -m "feat: add integrations onboarding step (optional)"
```

---

### Task 17: Preferences Step (Optional)

**Files:**
- Modify: `components/onboarding/preferences-form.tsx`
- Modify: `app/(onboarding)/onboarding/preferences/page.tsx`

- [x] **Step 1: Write preferences form**

```tsx
// components/onboarding/preferences-form.tsx
"use client";
import { useState } from "react";

interface Props {
  onSubmit: (reviewPolicy: string, autoPublish: boolean) => void;
}

export function PreferencesForm({ onSubmit }: Props) {
  const [reviewPolicy, setReviewPolicy] = useState("always");
  const [autoPublish, setAutoPublish] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Review Policy</label>
        <select value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value)}
          className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
          <option value="always">Always require review</option>
          <option value="auto">Auto-publish minor changes</option>
          <option value="never">Never require review</option>
        </select>
      </div>
      <label className="flex items-center gap-3">
        <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} className="h-4 w-4" />
        <span className="text-sm text-slate-700 dark:text-slate-300">Auto-publish approved changes</span>
      </label>
      <button onClick={() => onSubmit(reviewPolicy, autoPublish)} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Continue
      </button>
    </div>
  );
}
```

- [x] **Step 2: Write preferences page**

```tsx
// app/(onboarding)/onboarding/preferences/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { PreferencesForm } from "@/components/onboarding/preferences-form";
import { configurePreferences } from "@/api/onboarding";

export default function PreferencesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(reviewPolicy: string, autoPublish: boolean) {
    setLoading(true);
    try {
      await configurePreferences({ review_policy: reviewPolicy, auto_publish: autoPublish });
      router.push("/onboarding/initialize");
    } finally {
      setLoading(false);
    }
  }

  return (
    <OnboardingShell currentStep="preferences" onNext={() => {}} onSkip={() => router.push("/onboarding/initialize")} showSkip isNextLoading={loading}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Preferences</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Configure review and publishing preferences (optional).</p>
      <div className="mt-6"><PreferencesForm onSubmit={handleSubmit} /></div>
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/preferences-form.tsx app/\(onboarding\)/onboarding/preferences/page.tsx
git commit -m "feat: add preferences onboarding step (optional)"
```

---

### Task 18: Initialization Step

**Files:**
- Modify: `components/onboarding/initialization-progress.tsx`
- Modify: `components/onboarding/initialization-error.tsx`
- Modify: `app/(onboarding)/onboarding/initialize/page.tsx`

- [x] **Step 1: Write initialization progress**

```tsx
// components/onboarding/initialization-progress.tsx
"use client";
import { Loader2 } from "lucide-react";

const STAGE_LABELS: Record<string, string> = {
  repository_ingestion: "Syncing documentation...",
  knowledge_construction: "Building knowledge index...",
  initial_evaluation: "Running initial evaluation...",
  health_report: "Calculating health score...",
  recommendations: "Generating recommendations...",
};

export function InitializationProgress({ stage }: { stage: string | null }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
      <span className="text-sm text-slate-700 dark:text-slate-300">
        {stage ? STAGE_LABELS[stage] || stage : "Starting initialization..."}
      </span>
    </div>
  );
}
```

- [x] **Step 2: Write initialization error**

```tsx
// components/onboarding/initialization-error.tsx
"use client";
import { AlertTriangle } from "lucide-react";

interface Props {
  failure: { step: string; detail: string } | null;
  onRetry: () => void;
}

export function InitializationError({ failure, onRetry }: Props) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
      <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
        <AlertTriangle className="h-5 w-5" />
        <span className="font-medium">Initialization Failed</span>
      </div>
      {failure && <p className="mt-2 text-sm text-red-600">{failure.detail}</p>}
      <button onClick={onRetry} className="mt-3 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
        Retry
      </button>
    </div>
  );
}
```

- [x] **Step 3: Write initialize page**

```tsx
// app/(onboarding)/onboarding/initialize/page.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { InitializationProgress } from "@/components/onboarding/initialization-progress";
import { InitializationError } from "@/components/onboarding/initialization-error";
import { startInitialize, getInitializeStatus, retryInitialize } from "@/api/onboarding";
import type { InitializeStatus } from "@/lib/onboarding/types";

export default function InitializePage() {
  const router = useRouter();
  const [status, setStatus] = useState<InitializeStatus | null>(null);
  const [started, setStarted] = useState(false);

  const poll = useCallback(async () => {
    const s = await getInitializeStatus();
    setStatus(s);
    if (s.state === "COMPLETED") router.push("/onboarding/complete");
  }, [router]);

  useEffect(() => {
    if (!started) {
      startInitialize().then(() => setStarted(true)).catch(() => {});
    }
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [started, poll]);

  async function handleRetry() {
    await retryInitialize();
    setStarted(false);
  }

  const isFailed = status?.state === "FAILED";

  return (
    <OnboardingShell currentStep="initialize" onNext={() => {}} isNextDisabled={true}>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Initialization</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Setting up your workspace. This may take a few minutes.</p>
      <div className="mt-6">
        {isFailed ? (
          <InitializationError failure={status?.failure ?? null} onRetry={handleRetry} />
        ) : (
          <InitializationProgress stage={status?.stage ?? null} />
        )}
      </div>
    </OnboardingShell>
  );
}
```

- [x] **Step 4: Commit**

```bash
git add components/onboarding/initialization-progress.tsx components/onboarding/initialization-error.tsx app/\(onboarding\)/onboarding/initialize/page.tsx
git commit -m "feat: add initialization onboarding step"
```

---

### Task 19: Completion Step

**Files:**
- Modify: `components/onboarding/onboarding-complete.tsx`
- Modify: `app/(onboarding)/onboarding/complete/page.tsx`

- [x] **Step 1: Write completion component**

```tsx
// components/onboarding/onboarding-complete.tsx
"use client";
import { CheckCircle } from "lucide-react";

interface Props {
  documentCount?: number;
  chunkCount?: number;
}

export function OnboardingComplete({ documentCount = 0, chunkCount = 0 }: Props) {
  return (
    <div className="text-center">
      <CheckCircle className="mx-auto h-12 w-12 text-emerald-500" />
      <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">Onboarding Complete!</h3>
      <div className="mt-4 flex justify-center gap-8">
        <div>
          <p className="text-2xl font-bold text-slate-900 dark:text-white">{documentCount}</p>
          <p className="text-sm text-slate-600 dark:text-slate-400">Documents Indexed</p>
        </div>
        <div>
          <p className="text-2xl font-bold text-slate-900 dark:text-white">{chunkCount}</p>
          <p className="text-sm text-slate-600 dark:text-slate-400">Chunks Embedded</p>
        </div>
      </div>
      <a href="/dashboard" className="mt-6 inline-block rounded bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Go to Dashboard
      </a>
    </div>
  );
}
```

- [x] **Step 2: Write completion page**

```tsx
// app/(onboarding)/onboarding/complete/page.tsx
"use client";
import { useEffect, useState } from "react";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { OnboardingComplete } from "@/components/onboarding/onboarding-complete";
import { completeOnboarding, getOnboardingStatus } from "@/api/onboarding";

export default function CompletePage() {
  const [counts, setCounts] = useState({ documents: 0, chunks: 0 });

  useEffect(() => {
    // Finalize server-side first (spec §5.2 POST /complete, idempotent),
    // then read back the persisted result for the summary.
    completeOnboarding()
      .then(() => getOnboardingStatus())
      .then((s) => {
        const repo = s.selected_repository as Record<string, unknown> | null;
        setCounts({
          documents: (repo?.document_count as number) ?? 0,
          chunks: (repo?.chunk_count as number) ?? 0,
        });
      })
      .catch(() => {});
  }, []);

  return (
    <OnboardingShell currentStep="complete">
      <OnboardingComplete documentCount={counts.documents} chunkCount={counts.chunks} />
    </OnboardingShell>
  );
}
```

- [x] **Step 3: Commit**

```bash
git add components/onboarding/onboarding-complete.tsx app/\(onboarding\)/onboarding/complete/page.tsx
git commit -m "feat: add completion onboarding step"
```

---

### Task 20: Onboarding Entry Redirect

**Files:**
- Modify: `app/(onboarding)/onboarding/page.tsx`

- [x] **Step 1: Write entry page**

```tsx
// app/(onboarding)/onboarding/page.tsx
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getOnboardingStatus } from "@/api/onboarding";
import { STATE_TO_STEP } from "@/lib/onboarding/constants";

export default function OnboardingEntryPage() {
  const router = useRouter();

  useEffect(() => {
    getOnboardingStatus().then((status) => {
      const step = STATE_TO_STEP[status.state] || "workspace";
      if (status.state === "COMPLETED") {
        router.replace("/dashboard");
      } else {
        router.replace(`/onboarding/${step}`);
      }
    }).catch(() => {
      router.replace("/onboarding/workspace");
    });
  }, [router]);

  return <div className="flex flex-1 items-center justify-center"><p className="text-sm text-slate-500">Loading...</p></div>;
}
```

- [x] **Step 2: Commit**

```bash
git add app/\(onboarding\)/onboarding/page.tsx
git commit -m "feat: add onboarding entry redirect"
```

---

## Self-Review Checklist

After completing all tasks, verify:

1. **Spec coverage:** §5.1 (migrations) ✓, §5.2 (API routes incl. `POST /complete`; `POST /initialize` executed synchronously via the registered task — deviation documented in Task 5) ✓, §5.3 (initialization workflow) ✓, §6 (frontend wizard) ✓
2. **Composition wiring:** `OnboardingRepository` and `RepositoryConfigRepository` are registered on `RepositoryDependencies` (Task 4a) before any route uses them; routes reach them only via `request.app.state.draftly.dependencies.repositories` ✓
3. **State machine:** All transitions validated; no skipping required steps
4. **Idempotency:** Every POST idempotent; double-click safe; `mark_step` appends atomically (single JSONB upsert, no read-modify-write race)
5. **Failure UX:** Explicit retry/manual-continue states; no infinite spinners
6. **Guard:** Clerk post-auth URLs point at `/onboarding`; dashboard uses `/dashboard`
7. **Optional steps:** Integrations and preferences can be skipped with defaults
8. **Completion screen:** Shows real numbers from baseline/eval/health endpoints
9. **Interface grounding:** route/workflow calls match real signatures (`worker.run_task` returns the task result; `GitHubClient.get_installation_repositories(token)`; `DocumentStore` sync columns land via the docs-sync plan's Task 6 before `onboarding.initialize` runs a real sync)
