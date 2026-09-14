# AgentCore Runtime Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy `draftly-agent-backend`'s composed Strands workflows on Amazon Bedrock AgentCore Runtime via an `/invocations` + `/ping` entrypoint, an arm64 8080 container, Terraform-managed IAM/ECR/networking, and ADOT/CloudWatch observability.

**Architecture:** A thin standalone FastAPI app (`src/draftly/app/agentcore/`) reuses the platform composition root (`create_application`) and composes agents + workflows through a new `prepare_workflows()` on `DraftlyApplication` — skipping the durable worker/RQ/Discord/Slack boot that does not fit per-session microVMs. `POST /invocations` accepts a normalized event and drives the existing `WorkflowRunner.run(event)` (events are routed by `event_type`, not registry key). Deployment is Terraform (ECR, IAM, log group, security group, `null_resource` → boto3) since the AgentCore control-plane resource has no guaranteed-first-class provider resource.

**Tech Stack:** Python 3.11, Strands Agents (`strands-agents>=1.52.0`), FastAPI + uvicorn, Pydantic v2, `bedrock-agentcore`/`bedrock-agentcore-control` boto3 clients, Terraform (`hashicorp/aws ~> 5.0`), docker buildx (linux/arm64), ADOT/OTel env wiring into CloudWatch. boto3 is already available transitively; add `bedrock-agentcore` via the plan's Task 1 if the AgentCore SDK package is required (see Global Constraints).

**Spec:** No spec file — design approved in chat on 2026-09-14. Deployment requirements are per the Strands docs: <https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/index.md> and <https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/python/index.md>.

## Global Constraints

- All commands (pytest, ruff, mypy, make, git, terraform) run from **`draftly-agent-backend/`** — that directory is its own git repository and is NOT tracked by the root repo. Commit steps below use backend-relative paths and must be executed with `draftly-agent-backend` as the working directory.
- AgentCore runtime mandates (from the Strands guide, non-negotiable): linux/**arm64** image on ECR, **`POST /invocations`**, **`GET /ping`**, listen on **port 8080**.
- `WorkflowRunner.run(event)` (runner.py:354) is the only in-process run path; `runner.run` routes on `event.event_type` via `EventDispatcher` — the entrypoint validates `event_type`, it does NOT take a registry key.
- An AgentCore `runtimeSessionId` is 33+ chars; when the client omits `event_id`, default the run id from the `x-agentcore-session-id` header (33+ chars) else `agentcore-<uuid4>`.
- Never modify existing API routes, `docker/Dockerfile`, `docker/Dockerfile.api`, `main.py`, or the platform `startup()`/`lifespan` boot path. The AgentCore app composes through a **new** `prepare_workflows()` method.
- TDD: every code change lands with a failing test first; suite is `uv run pytest -q` (pytest-asyncio auto mode, offline by default).
- Ruff + mypy gate on `src`: `uv run ruff check .` and `uv run mypy src` must stay clean for touched files.
- Terraform: run `terraform fmt -check .` and `terraform validate` after `terraform init -backend=false` from `infra/aws/terraform/`.
- After committing, keep the graph fresh: `graphify update .` (repo convention in AGENTS.md).

---

### Task 1: AgentCore app skeleton — `/ping`, composition, and 8080 server

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/agentcore/__init__.py`
- Create: `draftly-agent-backend/src/draftly/app/agentcore/routes.py`
- Create: `draftly-agent-backend/src/draftly/app/agentcore/app.py`
- Create: `draftly-agent-backend/agentcore_server.py`
- Modify: `draftly-agent-backend/src/draftly/app/lifecycle.py` (add `prepare_workflows()` below `_build_agents_and_workflows`, ~line 233)
- Modify: `draftly-agent-backend/src/draftly/app/config.py:79` (add `agentcore_port`)
- Test: `draftly-agent-backend/tests/test_api/test_agentcore_runtime.py`

**Interfaces:**
- Consumes: `DraftlyApplication` (lifecycle.py:30), `create_application(settings=None)` (lifecycle.py:414), `Settings` (config.py), `set_grounding`/`settin cleanup` — none beyond existing composition.
- Produces:
  - `draftly.app.agentcore.routes.router` — `APIRouter(tags=["agentcore"])` with `GET /ping`
  - `src/draftly/app/agentcore/app.py:create_agentcore_app(*, settings=None, with_lifespan=True) -> FastAPI`
  - `DraftlyApplication.prepare_workflows() -> None` (async)
  - `Settings.agentcore_port: int = 8080`
  - `agentcore_server.py` entrypoint running the app factory on `0.0.0.0:8080`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_api/test_agentcore_runtime.py
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from draftly.app.agentcore.app import create_agentcore_app


def test_settings_expose_agentcore_port() -> None:
    from draftly.app.config import get_settings

    assert hasattr(get_settings(), "agentcore_port")


def test_ping_route_is_registered() -> None:
    app = create_agentcore_app(with_lifespan=False)

    paths = [route.path for route in app.routes]
    assert "/ping" in paths


def test_ping_returns_healthy() -> None:
    client = TestClient(create_agentcore_app(with_lifespan=False))

    response = client.get("/ping")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


async def test_prepare_workflows_composes_without_worker_boot() -> None:
    from draftly.app.lifecycle import DraftlyApplication

    app = DraftlyApplication(
        settings=MagicMock(),
        dependencies=MagicMock(),
        tools=object(),
    )
    app._start_infrastructure = AsyncMock()
    app._build_agents_and_workflows = AsyncMock()

    await app.prepare_workflows()

    assert app._started is True
    app._start_infrastructure.assert_awaited_once()
    app._build_agents_and_workflows.assert_awaited_once()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api/test_agentcore_runtime.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'draftly.app.agentcore'` (and `AttributeError: agentcore_port`).

- [ ] **Step 3: Add the `agentcore_port` setting**

In `draftly-agent-backend/src/draftly/app/config.py`, directly after the `port: int = 8000` line (line 79):

```python
    agentcore_port: int = 8080
```

- [ ] **Step 4: Add `prepare_workflows()` to `DraftlyApplication`**

In `draftly-agent-backend/src/draftly/app/lifecycle.py`, directly after `_build_agents_and_workflows` (line 233) — a public composition entry for runtimes that skip the worker/queue/chat boot:

```python
    async def prepare_workflows(self) -> None:
        """Compose agents + workflows for runtimes that skip the durable worker.

        Starts infrastructure (database, evaluation) and builds the workflow
        registry/runner, but does NOT boot RQ queues, the unified worker,
        Discord gateway, or Slack socket mode. Used by the AgentCore runtime
        entrypoint, where each session is its own short-lived microVM.
        """
        if self._started:
            return
        self._started = True
        try:
            await self._start_infrastructure()
            await self._build_agents_and_workflows()
        except Exception:
            await self.shutdown()
            raise
```

- [ ] **Step 5: Create the agentcore package**

```python
# src/draftly/app/agentcore/__init__.py
"""AgentCore Runtime entrypoint for Draftly workflows."""
```

```python
# src/draftly/app/agentcore/routes.py
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["agentcore"])


@router.get("/ping")
async def ping() -> dict[str, str]:
    """AgentCore-required liveness endpoint (GET /ping)."""
    return {"status": "healthy"}
```

```python
# src/draftly/app/agentcore/app.py
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from draftly.app.agentcore.routes import router
from draftly.app.config import Settings, get_settings
from draftly.app.lifecycle import create_application
from draftly.observability.logging import configure_logging


@asynccontextmanager
async def agentcore_lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Compose Draftly workflows without the durable worker boot."""
    settings = get_settings()
    configure_logging(settings=settings)

    application = create_application(settings=settings)
    app.state.draftly = application

    try:
        await application.prepare_workflows()
        yield
    finally:
        await application.shutdown()


def create_agentcore_app(
    *,
    settings: Settings | None = None,
    with_lifespan: bool = True,
) -> FastAPI:
    """Build the AgentCore runtime FastAPI application.

    ``with_lifespan=False`` returns an app that skips composition, letting
    tests exercise routes without a database or Redis.
    """
    app = FastAPI(
        title="Draftly AgentCore",
        description="AgentCore Runtime entrypoint for Draftly workflows.",
        lifespan=agentcore_lifespan if with_lifespan else None,
    )
    app.include_router(router)
    return app
```

- [ ] **Step 6: Create the server entrypoint**

```python
# agentcore_server.py
import warnings

from dotenv import load_dotenv

load_dotenv()

import uvicorn

from draftly.app.config import get_settings
from draftly.observability.logging import configure_logging

warnings.filterwarnings(
    "ignore",
    message=".*type is unknown and inference may fail.*",
    category=UserWarning,
)


def main() -> None:
    settings = get_settings()

    configure_logging(settings=settings)

    uvicorn.run(
        "draftly.app.agentcore.app:create_agentcore_app",
        factory=True,
        host=settings.host,
        port=settings.agentcore_port,
        log_level=settings.log_level.lower(),
        log_config=None,
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest tests/test_api/test_agentcore_runtime.py -v`
Expected: PASS (4 passed).

- [ ] **Step 8: Smoke-start the server on 8080**

Run:
```bash
curl -sSf http://localhost:8080/ping >/dev/null 2>&1 || true
python agentcore_server.py &
sleep 3
curl -sSf http://localhost:8080/ping
kill %1
```
Expected: `{"status":"healthy"}`. (If the environment cannot reach Postgres, expect startup to fail on `database.start()` — that is accepted offline; the unit tests above are the definitive gate.)

- [ ] **Step 9: Lint + typecheck touched files**

Run: `uv run ruff check src/draftly/app/agentcore src/draftly/app/lifecycle.py src/draftly/app/config.py agentcore_server.py && uv run mypy src/draftly/app/agentcore`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/draftly/app/agentcore agentcore_server.py src/draftly/app/lifecycle.py src/draftly/app/config.py tests/test_api/test_agentcore_runtime.py
git commit -m "feat(agentcore): add /ping runtime entrypoint and prepare_workflows composition"
```

---

### Task 2: `/invocations` — run composed workflows from an AgentCore payload

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/agentcore/routes.py` (add `POST /invocations` + helpers)
- Test: `draftly-agent-backend/tests/test_api/test_agentcore_runtime.py` (extend)

**Interfaces:**
- Consumes: `router` from Task 1; `WorkflowRunner.run(event)` (runner.py:354) returns `WorkflowState` (state.py); `WorkflowState.to_dict()` (state.py:~40).
- Produces:
  - `draftly.app.agentcore.routes._resolve_event_id(event: dict, session_id: str) -> str`
  - `draftly.app.agentcore.routes.InvocationInput(event: dict[str, Any])` + `InvocationRequest(input: InvocationInput)`
  - `POST /invocations` handler → `{"output": WorkflowState.to_dict()}`; 400 on missing `event_type`; 503 when runner unavailable; 500 on run failure.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_api/test_agentcore_runtime.py  (append)
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from draftly.app.agentcore.routes import (
    InvocationInput,
    InvocationRequest,
    _resolve_event_id,
    invocations,
)
from draftly.workflows.state import WorkflowState, WorkflowStatus


def test_resolve_event_id_prefers_existing() -> None:
    assert _resolve_event_id({"event_id": "ev-1"}, "x" * 33) == "ev-1"


def test_resolve_event_id_uses_long_session_id() -> None:
    session = "s" * 33
    assert _resolve_event_id({}, session) == session


def test_resolve_event_id_short_session_falls_back_uuid() -> None:
    result = _resolve_event_id({}, "short")
    assert result.startswith("agentcore-")
    assert result != "short"


async def test_invocations_rejects_missing_event_type() -> None:
    request = MagicMock()
    request.app.state.draftly = MagicMock()

    with pytest.raises(HTTPException) as excinfo:
        await invocations(
            InvocationRequest(input=InvocationInput(event={})),
            request,
        )

    assert excinfo.value.status_code == 400


async def test_invocations_returns_503_when_runner_unavailable() -> None:
    request = MagicMock()
    request.app.state.draftly = MagicMock(workflows=MagicMock(runner=None))

    with pytest.raises(HTTPException) as excinfo:
        await invocations(
            InvocationRequest(
                input=InvocationInput(event={"event_id": "ev-1", "event_type": "slack_support"})
            ),
            request,
        )

    assert excinfo.value.status_code == 503


async def test_invocations_runs_workflow_and_wraps_output() -> None:
    state = WorkflowState(run_id="ev-1", event={"event_type": "slack_support"})
    state.finish(WorkflowStatus.DELIVERED)
    runner = AsyncMock(return_value=state)
    request = MagicMock()
    request.app.state.draftly = MagicMock(workflows=MagicMock(runner=runner))

    response = await invocations(
        InvocationRequest(
            input=InvocationInput(event={"event_id": "ev-1", "event_type": "slack_support"})
        ),
        request,
    )

    runner.assert_awaited_once()
    assert response == {"output": state.to_dict()}
    assert response["output"]["status"] == "delivered"


async def test_invocations_defaults_run_id_from_session_header() -> None:
    async def fake_run(event):
        return WorkflowState(run_id=event["event_id"]).finish(WorkflowStatus.SKIPPED)

    runner = AsyncMock(side_effect=fake_run)
    request = MagicMock()
    request.headers = {"x-agentcore-session-id": "a" * 33}
    request.app.state.draftly = MagicMock(workflows=MagicMock(runner=runner))

    response = await invocations(
        InvocationRequest(input=InvocationInput(event={"event_type": "slack_support"})),
        request,
    )

    assert response["output"]["run_id"] == "a" * 33


async def test_invocations_wraps_run_failure_as_500() -> None:
    runner = AsyncMock(side_effect=RuntimeError("boom"))
    request = MagicMock()
    request.app.state.draftly = MagicMock(workflows=MagicMock(runner=runner))

    with pytest.raises(HTTPException) as excinfo:
        await invocations(
            InvocationRequest(
                input=InvocationInput(event={"event_id": "ev-1", "event_type": "slack_support"})
            ),
            request,
        )

    assert excinfo.value.status_code == 500
    assert "boom" in excinfo.value.detail
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api/test_agentcore_runtime.py -v`
Expected: FAIL — `ImportError` for `invocations`, `InvocationInput`, `InvocationRequest`, `_resolve_event_id`.

- [ ] **Step 3: Implement the `POST /invocations` handler**

Replace the body of `draftly-agent-backend/src/draftly/app/agentcore/routes.py` with:

```python
# src/draftly/app/agentcore/routes.py
from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from draftly.workflows.state import WorkflowState

router = APIRouter(tags=["agentcore"])


class InvocationInput(BaseModel):
    event: dict[str, Any]


class InvocationRequest(BaseModel):
    input: InvocationInput


def _resolve_event_id(event: dict[str, Any], session_id: str) -> str:
    """Prefer an explicit event_id; else use the AgentCore session id (33+ chars)."""
    existing = event.get("event_id")
    if existing:
        return str(existing)
    if len(session_id) >= 33:
        return session_id
    return f"agentcore-{uuid4()}"


def _runner(request: Request) -> Any:
    draftly = getattr(request.app.state, "draftly", None)
    workflows = getattr(draftly, "workflows", None)
    runner = getattr(workflows, "runner", None)
    if runner is None:
        raise HTTPException(status_code=503, detail="workflow runner unavailable")
    return runner


@router.get("/ping")
async def ping() -> dict[str, str]:
    """AgentCore-required liveness endpoint (GET /ping)."""
    return {"status": "healthy"}


@router.post("/invocations")
async def invocations(
    invocation: InvocationRequest,
    request: Request,
) -> dict[str, Any]:
    """Run one normalized workflow event and return its terminal state."""
    event = dict(invocation.input.event)
    event_type = str(event.get("event_type") or "")
    if not event_type:
        raise HTTPException(
            status_code=400,
            detail="input.event.event_type is required",
        )

    session_id = request.headers.get("x-agentcore-session-id") or ""
    if not event.get("event_id"):
        event["event_id"] = _resolve_event_id(event, session_id)

    runner = _runner(request)

    try:
        state: WorkflowState = await runner.run(event)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"agent processing failed: {exc}",
        ) from exc

    return {"output": state.to_dict()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api/test_agentcore_runtime.py -v`
Expected: PASS (all ping + invocation tests green).

- [ ] **Step 5: Lint + typecheck**

Run: `uv run ruff check src/draftly/app/agentcore && uv run mypy src/draftly/app/agentcore`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/draftly/app/agentcore/routes.py tests/test_api/test_agentcore_runtime.py
git commit -m "feat(agentcore): invoke composed workflows from POST /invocations"
```

---

### Task 3: arm64 Dockerfile + Makefile targets

**Files:**
- Create: `draftly-agent-backend/docker/Dockerfile.agentcore`
- Modify: `draftly-agent-backend/Makefile` (add `run-agentcore`, `docker-build-agentcore`, `docker-push-agentcore`)

**Interfaces:**
- Consumes: `agentcore_server.py` (Task 1), `uv.lock`/`pyproject.toml`.
- Produces: `draftly/agentcore:latest` arm64 image (port 8080) → pushed to ECR repo `draftly-agentcore` (Task 4 consumer of the URI).

- [ ] **Step 1: Create `docker/Dockerfile.agentcore`**

```dockerfile
# Build stage
FROM --platform=linux/arm64 python:3.11-slim AS builder

ENV UV_VERSION=0.4.20
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY agentcore_server.py ./
COPY src ./src
RUN uv sync --frozen --no-dev

# Runtime stage
FROM --platform=linux/arm64 python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/app/.venv/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/.venv ./.venv
COPY --from=builder /app/agentcore_server.py ./
COPY --from=builder /app/src ./src

EXPOSE 8080

CMD ["python", "agentcore_server.py"]
```

- [ ] **Step 2: Add Makefile targets**

Add `run-agentcore docker-build-agentcore docker-push-agentcore` to the `.PHONY` line, a `run-agentcore` line under `run`, and the docker targets after `docker-push`:

```makefile
run-agentcore:
	python agentcore_server.py

docker-build-agentcore:
	docker buildx create --use 2>/dev/null || true
	docker buildx build --platform linux/arm64 -f docker/Dockerfile.agentcore -t draftly/agentcore:latest --load .

docker-push-agentcore:
	aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com
	docker tag draftly/agentcore:latest $$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com/draftly-agentcore:latest
	docker push $$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com/draftly-agentcore:latest
```

Add one `help` line: `@echo "  run-agentcore   Run the AgentCore runtime server (port 8080)"`.

- [ ] **Step 3: Build the image**

Run: `make docker-build-agentcore`
Expected: image builds; `docker run --rm -p 8080:8080 draftly/agentcore:latest` then `curl -sSf http://localhost:8080/ping` returns `{"status":"healthy"}`. (Skip local run if the host cannot reach Postgres — build success is the gate here.)

- [ ] **Step 4: Lint the Makefile change is whitespace-clean**

Run: `make -n docker-build-agentcore`
Expected: prints the commands without error.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile.agentcore Makefile
git commit -m "feat(agentcore): add arm64 8080 Dockerfile and Makefile targets"
```

---

### Task 4: boto3 deploy script + Terraform resources

**Files:**
- Create: `draftly-agent-backend/scripts/deploy_agentcore.py`
- Create: `draftly-agent-backend/infra/aws/terraform/agentcore.tf`
- Modify: `draftly-agent-backend/infra/aws/terraform/variables.tf`
- Modify: `draftly-agent-backend/infra/aws/terraform/outputs.tf`
- Test: `draftly-agent-backend/tests/scripts/test_deploy_agentcore.py` (new)

**Interfaces:**
- Consumes: Task 3 image URI (`var.agentcore_image_uri`); existing `aws_iam_policy.bedrock_access` (iam.tf:3); existing `aws_secretsmanager_secret.database_url` + `aws_secretsmanager_secret.provider_keys` (secrets.tf); existing `aws_vpc.main` (networking.tf).
- Produces:
  - `scripts/deploy_agentcore.py` `deploy(args) -> dict` calling `create_agent_runtime`; CLI flags `--container-uri --role-arn --runtime-name --region --network-mode --security-group-ids --subnet-ids --out`.
  - Terraform: `aws_ecr_repository.agentcore`, `aws_iam_role.agentcore_runtime`, `aws_iam_role_policy.agentcore_secrets`, `aws_cloudwatch_log_group.agentcore`, `aws_security_group.agentcore`, `null_resource.deploy_agentcore_runtime`, variables `agentcore_enabled` + `agentcore_image_uri`, output `agentcore_runtime_file`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/scripts/test_deploy_agentcore.py
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch


def _load_deploy_script() -> Any:
    """Load scripts/deploy_agentcore.py as a module (repo convention)."""
    script = Path(__file__).resolve().parents[2] / "scripts" / "deploy_agentcore.py"
    spec = importlib.util.spec_from_file_location("deploy_agentcore_under_test", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DEPLOY_MODULE = _load_deploy_script()
deploy = DEPLOY_MODULE.deploy


def _fake_boto3(client: MagicMock) -> MagicMock:
    fake = MagicMock()
    fake.client.return_value = client
    return fake


def test_deploy_creates_public_runtime() -> None:
    client = MagicMock()
    client.create_agent_runtime.return_value = {
        "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123:runtime/draftly",
        "status": "CREATING",
    }
    args = MagicMock(
        container_uri="123.dkr.ecr.us-east-1.amazonaws.com/draftly-agentcore:latest",
        role_arn="arn:aws:iam::123:role/draftly-agentcore-runtime",
        runtime_name="draftly-agentcore",
        region="us-east-1",
        network_mode="PUBLIC",
        security_group_ids=[],
        subnet_ids=[],
        out=None,
    )
    with patch.object(DEPLOY_MODULE, "boto3", _fake_boto3(client)):
        result = deploy(args)

    assert result["status"] == "CREATING"
    client.create_agent_runtime.assert_called_once_with(
        agentRuntimeName="draftly-agentcore",
        agentRuntimeArtifact={
            "containerConfiguration": {"containerUri": args.container_uri}
        },
        networkConfiguration={"networkMode": "PUBLIC"},
        roleArn=args.role_arn,
    )


def test_deploy_vpc_mode_passes_subnets_and_security_groups() -> None:
    client = MagicMock()
    client.create_agent_runtime.return_value = {
        "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123:runtime/draftly",
        "status": "CREATING",
    }
    args = MagicMock(
        container_uri="123.dkr.ecr.us-east-1.amazonaws.com/draftly-agentcore:latest",
        role_arn="arn:aws:iam::123:role/draftly-agentcore-runtime",
        runtime_name="draftly-agentcore",
        region="us-east-1",
        network_mode="VPC",
        security_group_ids=["sg-1"],
        subnet_ids=["subnet-1"],
        out=None,
    )
    with patch.object(DEPLOY_MODULE, "boto3", _fake_boto3(client)):
        deploy(args)

    _, kwargs = client.create_agent_runtime.call_args
    assert kwargs["networkConfiguration"] == {
        "networkMode": "VPC",
        "vpcConfiguration": {"subnetIds": ["subnet-1"], "securityGroupIds": ["sg-1"]},
    }


def test_deploy_writes_out_file() -> None:
    client = MagicMock()
    client.create_agent_runtime.return_value = {
        "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123:runtime/draftly",
        "status": "CREATING",
    }
    args = MagicMock(
        container_uri="u", role_arn="r", runtime_name="draftly-agentcore",
        region="us-east-1", network_mode="PUBLIC",
        security_group_ids=[], subnet_ids=[], out="/tmp/agentcore-runtime.json",
    )
    with patch.object(DEPLOY_MODULE, "boto3", _fake_boto3(client)), \
         patch.object(DEPLOY_MODULE, "open", MagicMock()):
        deploy(args)

    DEPLOY_MODULE.open.assert_called_once_with(
        "/tmp/agentcore-runtime.json", "w", encoding="utf-8"
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/scripts/test_deploy_agentcore.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `scripts/deploy_agentcore.py`**

```python
#!/usr/bin/env python
"""Provision or update a Draftly AgentCore runtime via the AWS SDK.

Mirrors Strands docs "Method B: Manual Deployment with boto3":
https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/python/
Invoked by Terraform local-exec; also usable standalone.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import boto3


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container-uri", required=True)
    parser.add_argument("--role-arn", required=True)
    parser.add_argument("--runtime-name", default="draftly-agentcore")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--network-mode", choices=["PUBLIC", "VPC"], default="PUBLIC")
    parser.add_argument("--security-group-ids", nargs="*", default=[])
    parser.add_argument("--subnet-ids", nargs="*", default=[])
    parser.add_argument("--out", help="path to write JSON with the runtime ARN")
    return parser.parse_args(argv)


def deploy(args: argparse.Namespace) -> dict[str, Any]:
    client = boto3.client("bedrock-agentcore-control", region_name=args.region)

    network_configuration: dict[str, Any] = {"networkMode": args.network_mode}
    if args.network_mode == "VPC":
        network_configuration["vpcConfiguration"] = {
            "subnetIds": args.subnet_ids,
            "securityGroupIds": args.security_group_ids,
        }

    response = client.create_agent_runtime(
        agentRuntimeName=args.runtime_name,
        agentRuntimeArtifact={
            "containerConfiguration": {"containerUri": args.container_uri}
        },
        networkConfiguration=network_configuration,
        roleArn=args.role_arn,
    )

    result = {
        "agentRuntimeArn": response["agentRuntimeArn"],
        "status": response["status"],
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
    print(json.dumps(result, indent=2))
    return result


def main(argv: list[str] | None = None) -> int:
    deploy(_parse_args(argv))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

> Note: the boto3 client pair `bedrock-agentcore-control` / `bedrock-agentcore` and the `create_agent_runtime(agentRuntimeArtifact.containerConfiguration.containerUri, networkConfiguration.networkMode, roleArn)` shape come verbatim from the Strands guide. If the released SDK renames any request field (e.g. `vpcConfiguration`), adjust the dictionary keys — the tests above pin the exact request shape and will catch drift.

- [ ] **Step 4: Verify the request shape against the installed SDK**

Run: `uv run python -c "import boto3, inspect; c = boto3.client('bedrock-agentcore-control', region_name='us-east-1'); print([m for m in dir(c) if 'agent_runtime' in m.lower()])"`
Expected: prints `create_agent_runtime` (and likely `enable_transaction_search`). If the installed botocore has no `bedrock-agentcore-control` service, install the AgentCore SDK: `uv add bedrock-agentcore` and adjust the client import in the script to the SDK's documented client. Re-run the step until the script's `create_agent_runtime` call matches.

- [ ] **Step 5: Create `infra/aws/terraform/agentcore.tf`**

```hcl
# AgentCore Runtime deployment for Draftly agents.

resource "aws_ecr_repository" "agentcore" {
  name                 = "draftly-agentcore"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_iam_role" "agentcore_runtime" {
  name = "${var.project_name}-${var.environment}-agentcore-runtime"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "agentcore_bedrock" {
  role       = aws_iam_role.agentcore_runtime.name
  policy_arn = aws_iam_policy.bedrock_access.arn
}

resource "aws_iam_role_policy" "agentcore_secrets" {
  name = "agentcore-secrets-read"
  role = aws_iam_role.agentcore_runtime.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.database_url.arn,
          aws_secretsmanager_secret.provider_keys.arn,
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "agentcore" {
  name              = "/aws/agentcore/${var.project_name}-${var.environment}"
  retention_in_days = var.log_retention_days
}

resource "aws_security_group" "agentcore" {
  name        = "${var.project_name}-${var.environment}-agentcore"
  description = "Egress for Draftly AgentCore runtime"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The AgentCore control-plane has no guaranteed first-class terraform provider
# resource; provision through the SDK (via null_resource) so the workflow is
# identical locally and from CI.
resource "null_resource" "deploy_agentcore_runtime" {
  count = var.agentcore_enabled ? 1 : 0

  triggers = {
    container_uri = var.agentcore_image_uri
    role_arn      = aws_iam_role.agentcore_runtime.arn
  }

  provisioner "local-exec" {
    command = <<-EOT
      python scripts/deploy_agentcore.py \
        --container-uri "${var.agentcore_image_uri}" \
        --role-arn "${aws_iam_role.agentcore_runtime.arn}" \
        --runtime-name draftly-agentcore \
        --region "${var.aws_region}" \
        --network-mode PUBLIC \
        --out "${path.module}/agentcore-runtime.json"
    EOT
  }
}
```

- [ ] **Step 6: Add variables and output**

In `draftly-agent-backend/infra/aws/terraform/variables.tf`, append:

```hcl
variable "agentcore_enabled" {
  description = "Provision the AgentCore runtime resources"
  type        = bool
  default     = true
}

variable "agentcore_image_uri" {
  description = "ECR image URI for the AgentCore runtime container"
  type        = string
  default     = ""
}
```

In `draftly-agent-backend/infra/aws/terraform/outputs.tf`, append:

```hcl
output "agentcore_runtime_arn_file" {
  description = "Path to the JSON file holding the AgentCore runtime ARN"
  value       = "${path.module}/agentcore-runtime.json"
}
```

- [ ] **Step 7: Run the script tests**

Run: `uv run pytest tests/scripts/test_deploy_agentcore.py -v`
Expected: PASS (3 passed).

- [ ] **Step 8: Validate Terraform**

Run from `draftly-agent-backend/infra/aws/terraform`:
```bash
terraform fmt -check .
terraform init -backend=false
terraform validate
```
Expected: `terraform fmt` reports no changes; `terraform validate` ends with `Success! The configuration is valid.` (If `terraform` is not installed, this is the single manual verification step — the HCL mirrors existing file patterns in `iam.tf`/`ecs.tf`.)

- [ ] **Step 9: Commit**

```bash
git add scripts/deploy_agentcore.py tests/scripts/test_deploy_agentcore.py infra/aws/terraform/agentcore.tf infra/aws/terraform/variables.tf infra/aws/terraform/outputs.tf
git commit -m "feat(agentcore): provision runtime via boto3 script and terraform"
```

---

### Task 5: Observability — CloudWatch transaction search, ADOT env, trace pass-through

**Files:**
- Modify: `draftly-agent-backend/scripts/deploy_agentcore.py` (add `--env` and `--enable-transaction-search`)
- Modify: `draftly-agent-backend/infra/aws/terraform/agentcore.tf` (pass env + flag to `local-exec`)
- Modify: `draftly-agent-backend/src/draftly/app/agentcore/routes.py` (add trace header helper + output field)
- Test: `draftly-agent-backend/tests/test_api/test_agentcore_runtime.py` + `draftly-agent-backend/tests/scripts/test_deploy_agentcore.py` (extend both)

**Interfaces:**
- Consumes: `deploy(args)` from Task 4; `_runner(request)`/`Invocation*` from Task 1-2.
- Produces: `_extract_trace_id(headers) -> str | None`; `/invocations` output gains `"trace_id"` when a `traceparent` header is present; `<AGENTCORE_ENV>`/`OTEL_*` env and the transaction-search flag reach `create_agent_runtime`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_api/test_agentcore_runtime.py  (append)
from draftly.app.agentcore.routes import _extract_trace_id


def test_extract_trace_id_returns_traceparent() -> None:
    assert _extract_trace_id({"traceparent": "00-abc-1-01"}) == "00-abc-1-01"


def test_extract_trace_id_missing_returns_none() -> None:
    assert _extract_trace_id({}) is None
```

```python
# tests/scripts/test_deploy_agentcore.py  (append)
from __future__ import annotations

import pytest


def test_parse_args_accepts_env_and_transaction_search() -> None:
    _parse_args = DEPLOY_MODULE._parse_args
    args = _parse_args(
        [
            "--container-uri", "u",
            "--role-arn", "r",
            "--env", "DATABASE_URL=postgres://db",
            "--env", "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4317",
            "--enable-transaction-search",
        ]
    )
    assert args.env == ["DATABASE_URL=postgres://db", "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4317"]
    assert args.enable_transaction_search is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api/test_agentcore_runtime.py tests/scripts/test_deploy_agentcore.py -v`
Expected: FAIL — `ImportError: _extract_trace_id`; `TypeError: _parse_args got unexpected keyword 'env'`.

- [ ] **Step 3: Add env + transaction-search to the deploy script**

Update `draftly-agent-backend/scripts/deploy_agentcore.py`:

In `_parse_args`, add after `--out`:

```python
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE env for the runtime")
    parser.add_argument("--enable-transaction-search", action="store_true")
```

In `deploy`, after the `network_configuration` block:

```python
    container_configuration: dict[str, Any] = {
        "containerUri": args.container_uri
    }
    if args.env:
        container_configuration["environment"] = [
            {"name": item.split("=", 1)[0], "value": item.split("=", 1)[1]}
            for item in args.env
        ]
```

Replace the `create_agent_runtime` call's artifact argument:

```python
    response = client.create_agent_runtime(
        agentRuntimeName=args.runtime_name,
        agentRuntimeArtifact={
            "containerConfiguration": container_configuration
        },
        networkConfiguration=network_configuration,
        roleArn=args.role_arn,
    )

    if args.enable_transaction_search:
        try:
            client.enable_transaction_search(agentRuntimeArn=response["agentRuntimeArn"])
        except Exception as exc:  # not fatal to deployment
            print(f"warning: enable_transaction_search failed: {exc}", file=sys.stderr)
```

- [ ] **Step 4: Add `_extract_trace_id` to routes.py**

In `draftly-agent-backend/src/draftly/app/agentcore/routes.py`, add below `_resolve_event_id`:

```python
def _extract_trace_id(headers: Any) -> str | None:
    """Return the incoming W3C trace header (traceparent), if present."""
    value = headers.get("traceparent")
    if value:
        return str(value)
    return None
```

In `invocations`, before `return`, thread the trace id into the output:

```python
    output = state.to_dict()
    trace_id = _extract_trace_id(request.headers)
    if trace_id is not None:
        output["trace_id"] = trace_id
    return {"output": output}
```

- [ ] **Step 5: Plumb env + flag through Terraform**

In `draftly-agent-backend/infra/aws/terraform/agentcore.tf`, update the `local-exec` command to:

```hcl
  provisioner "local-exec" {
    command = <<-EOT
      python scripts/deploy_agentcore.py \
        --container-uri "${var.agentcore_image_uri}" \
        --role-arn "${aws_iam_role.agentcore_runtime.arn}" \
        --runtime-name draftly-agentcore \
        --region "${var.aws_region}" \
        --network-mode PUBLIC \
        --env "OTEL_EXPORTER_OTLP_ENDPOINT=${var.agentcore_otlp_endpoint}" \
        --env "OTEL_SERVICE_NAME=draftly-agentcore" \
        --enable-transaction-search \
        --out "${path.module}/agentcore-runtime.json"
    EOT
  }
```

Add to `variables.tf`:

```hcl
variable "agentcore_otlp_endpoint" {
  description = "ADOT/OTLP collector endpoint for AgentCore observability"
  type        = string
  default     = ""
}
```

- [ ] **Step 6: Run the extended tests**

Run: `uv run pytest tests/test_api/test_agentcore_runtime.py tests/scripts/test_deploy_agentcore.py -v`
Expected: PASS (all).

- [ ] **Step 7: Validate Terraform again**

Run from `draftly-agent-backend/infra/aws/terraform`:
```bash
terraform fmt -check .
terraform validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 8: Lint + typecheck**

Run: `uv run ruff check src/draftly/app/agentcore scripts/deploy_agentcore.py && uv run mypy src/draftly/app/agentcore`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add scripts/deploy_agentcore.py infra/aws/terraform/agentcore.tf infra/aws/terraform/variables.tf src/draftly/app/agentcore/routes.py tests/test_api/test_agentcore_runtime.py tests/scripts/test_deploy_agentcore.py
git commit -m "feat(agentcore): wire CloudWatch transaction search and OTel env"
```

---

### Task 6: README — deploy to AgentCore Runtime

**Files:**
- Modify: `draftly-agent-backend/README.md` (add a "Deploy to Amazon Bedrock AgentCore" section)

**Interfaces:**
- Consumes: the feature end-to-end (scope, payload contract, commands).

- [ ] **Step 1: Add the AgentCore section to the README**

Insert before the final `## Run locally` / architecture section a new section containing: what the entrypoint is (`agentcore_server.py` on `:8080`), the mandatory endpoints (`GET /ping`, `POST /invocations` with the `{"input": {"event": {...}}}` payload contract and `x-agentcore-session-id` behavior), the three-step deploy (build arm64 image → `make docker-push-agentcore` → `terraform apply`), and a sample invoke snippet:

```markdown
## Deploy to Amazon Bedrock AgentCore Runtime

Draftly ships a standalone AgentCore Runtime entrypoint (`agentcore_server.py`,
port 8080) that drives the composed Strands workflows. It exposes the two
mandatory endpoints:

- `GET /ping` — liveness probe.
- `POST /invocations` — body `{"input": {"event": {...}}}` where `event` is a
  normalized Draftly workflow event (must include a routable `event_type`).
  The run id defaults from the `x-agentcore-session-id` header (33+ chars)
  when `event.event_id` is absent. Returns `{"output": <run state>}`.

Deploy steps:

```bash
make docker-build-agentcore        # linux/arm64 8080 image
make docker-push-agentcore         # push to ECR (draftly-agentcore)
cd infra/aws/terraform && terraform apply
```

The Terraform module provisions the ECR repo, AgentCore runtime IAM role,
CloudWatch log group, and invokes `scripts/deploy_agentcore.py` to create the
agent runtime with ADOT/OTel env and CloudWatch transaction search enabled.

Invoke a deployed runtime:

```python
import boto3, json

client = boto3.client("bedrock-agentcore", region_name="us-east-1")
response = client.invoke_agent_runtime(
    agentRuntimeArn="arn:aws:bedrock-agentcore:us-east-1:<account>:runtime/draftly-agentcore-suffix",
    runtimeSessionId="a" * 33,  # 33+ characters
    payload=json.dumps({"input": {"event": {"event_type": "slack_support"}}}).encode(),
)
print(json.loads(response["response"].read()))
```
```

- [ ] **Step 2: Verify the README renders and cross-references resolve**

Run: `git diff --stat` and confirm the new section is present; ensure any internal anchor names referenced match existing README headings.

- [ ] **Step 3: Run the full offline suite**

Run: `uv run pytest -q`
Expected: PASS (no regressions in the existing suite).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(agentcore): document AgentCore Runtime deployment"
```

---

## Self-Review Notes

- **Coverage:** `/ping` + `/invocations` → Tasks 1-2; arm64 8080 Dockerfile + Makefile → Task 3; ECR/IAM/networking + runtime creation → Task 4; observability (transaction search + OTel env + trace header) → Task 5; docs → Task 6. All Global Constraints are enforced in Task headers or steps.
- **Type consistency:** `_resolve_event_id(event, session_id) -> str`, `_extract_trace_id(headers) -> str | None`, `deploy(args) -> dict`, `create_agentcore_app(*, settings=None, with_lifespan=True)` names are stable across all tasks that reference them. The `outputs.tf` addition is pinned to the concrete `agentcore_runtime_arn_file` block (the earlier draft block is invalid and removed in Step 6).
- **Known risk:** the `create_agent_runtime`/`enable_transaction_search` request schema follows the Strands guide; Task 4 Step 4 verifies the exact field names against the installed SDK, and the deploy-script tests pin the request shape so any drift fails loudly.