# Agents Page Live Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fictional mock agents page with real backend agent definitions + live run telemetry, delivered **strictly over SSE** (no polling).

**Architecture:** Add a new org-scoped `GET /api/agents` backend route serving Draftly's real `AgentRegistry` catalog (role, name, description, surface, tools) enriched with per-agent status/history aggregated from the existing `agent_runs`/`agent_steps` audit tables. Enrich the audit hook to (a) record richer per-step `detail` going forward and (b) **stream per-step envelopes into each run's Redis-Streams channel** (per-run SSE), so the frontend receives live agent progress. Rewrite the frontend `agents` feature to render the catalog (one-shot fetch of static definitions) + a **live activity feed and per-run detail driven entirely by per-run SSE** (`useWorkflowEvents` over the existing `/workflows/{run_id}/stream-ticket` + `/workflows/{run_id}/events`), and drop the hardcoded `data.tsx` mock. **No `setInterval` polling anywhere in the agents feature.**

> This plan supersedes the earlier polling-based draft. See "SSE-first data flow" below.

**Tech Stack:** Python 3.11 / FastAPI (backend), React 19 / Next.js 16 / TypeScript / Tailwind / lucide-react (frontend), CockroachDB via the existing `agent_runs` repository.

**Spec:** See the approved design in the conversation (brainstorming phase): "Expose real backend agent definitions" with "Full rich detail", "Enrich audit hook too", and "Real aggregates" decisions.

## Global Constraints

- Follow the existing backend route pattern exactly: `APIRouter(..., dependencies=[Depends(get_verified_token)])`, registered in `app/api/app.py` with prefix `/api` and listed in `app/api/routes/__init__.py`.
- Do NOT construct Strands agent instances at request time — agent factories need `(model, tools)` and provider keys. Serve a static catalog instead.
- **Strict-SSE rule:** the agents page must never poll. Live data (activity feed, per-run status, step/tool events) streams over per-run SSE via `useWorkflowEvents`. The only HTTP fetches are one-shot retrievals of *static* data (the `GET /api/agents` catalog and an initial `GET /runs` snapshot to enumerate streams to subscribe to) — never repeated timers.
- Reuse the existing per-run SSE transport untouched: `RedisStreamBus` (`events/redis_stream_bus.py`) + `workflow_events` replay + `POST /workflows/{run_id}/stream-ticket` + `GET /workflows/{run_id}/events` + the frontend `useWorkflowEvents` hook. Add **no** new transport (reject the pub/sub dashboard model here — per-run only).
- The audit hook's Strands callbacks are **synchronous**; publishing is async. Follow the existing buffered-async pattern: record envelope specs on the sync path, publish them in the async `run_end` flush on the persistent event loop.
- For `stream-ticket` to resolve for agent runs, each agent run needs a `jobs` row (mirror what `github.py`/onboarding do before issuing a ticket). The audit hook upserts one on `run_start`.
- Frontend `api/*.ts` wrappers go through `request()` from `api/client.ts` (handles Clerk Bearer token, 401 redirect).
- Both `draftly-agent-backend/` and `draftly-agent-frontend/` are separate git repos. Commit backend work in the backend repo and frontend work in the frontend repo.
- Do not add comments to code unless required for clarity.

---

## File Structure

**Backend (`draftly-agent-backend/`):**
- Create `src/draftly/app/api/routes/agents.py` — the `/agents` route + static `AGENT_CATALOG`.
- Modify `src/draftly/app/api/routes/__init__.py` — register the router.
- Modify `src/draftly/app/api/app.py` — add the router under prefix `/api`.
- Modify `src/draftly/orchestration/hooks/audit.py` — enrich step `detail` **and** stream per-step SSE envelopes via an injected publisher.
- Modify `src/draftly/integrations/strands/graph.py` + `src/draftly/orchestration/graphs/{documentation_graph,issue_graph,support_graph}.py` — thread `publisher` into `RunAuditLogger`.
- Modify `src/draftly/workflows/runner.py` — forward `context.publisher` to `build_graph_for_run`.
- Create `tests/api/test_agents_routes.py` — route tests.
- Create `tests/orchestration/hooks/test_audit_stream.py` — audit-hook streaming tests.

**Frontend (`draftly-agent-frontend/`):**
- Create `api/agents.ts` — typed API wrapper (`listAgents`).
- Create `api/runs.ts` — typed API wrapper (`listRuns`, `getRunSteps` for the initial snapshot).
- Modify `api/types.ts` — add agent + run types.
- Modify `components/agents/agents.tsx` — **strict-SSE** page: one-shot catalog + per-run `useWorkflowEvents` feed/detail, no polling.
- Modify `components/agents/agent-list.tsx` — real data row.
- Modify `components/agents/agent-detail.tsx` — live per-run SSE detail.
- Modify `components/agents/agent-filters.tsx` — derived counts.
- Delete `components/agents/data.tsx` — remove mock + hand-rolled SVG icons.
- Create `components/agents/agent-icons.tsx` — role/surface → lucide icon map.
- Create `components/agents/__tests__/agents.test.tsx` — page test with `MockEventSource`.
- Create `hooks/use-agent-runs.ts` — per-run SSE hook (wraps `useWorkflowEvents`, maps agent run frames to feed/detail state).

---

### Task 1: Backend — `GET /api/agents` route + catalog

**Files:**
- Create: `draftly-agent-backend/src/draftly/app/api/routes/agents.py`
- Create: `draftly-agent-backend/tests/api/test_agents_routes.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/__init__.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/app.py`

**Interfaces:**
- Consumes: `agent_runs` repo (`AgentRunsRepository.list_runs`, `list_steps`) from `request.app.state.draftly.dependencies.repositories.agent_runs`; `get_verified_token` from `draftly.app.api.auth`.
- Produces: `GET /api/agents` → `{"agents": [AgentSummary]}` where `AgentSummary` = `{role, name, description, surface, tools: [str], status, activity, history: [{label, result, detail}]}`. Frontend Task 5 depends on this exact shape.

- [ ] **Step 1: Write the failing test**

Create `draftly-agent-backend/tests/api/test_agents_routes.py`, modeled on `tests/api/test_runs_routes.py`, but where the route reads the catalog statically (no DB required for the definition fields) and derives live status from a fake agent_runs repo.

```python
"""Agents catalog API: definitions, tool mapping, live status/history derivation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from draftly.app.api.auth import get_verified_token
from draftly.app.api.routes.agents import router


class FakeRunsRepo:
    def __init__(self, runs: list[dict[str, Any]] | None = None,
                 steps: list[dict[str, Any]] | None = None) -> None:
        self.runs = runs or []
        self.steps = steps or []
        self.last_list_runs_kwargs: dict[str, Any] = {}

    async def list_runs(self, *, org_id: str | None = None, status: str | None = None,
                        limit: int = 50) -> list[dict[str, Any]]:
        self.last_list_runs_kwargs = {"org_id": org_id, "status": status, "limit": limit}
        return self.runs

    async def list_steps(self, run_id: str) -> list[dict[str, Any]]:
        return self.steps


def make_app(runs_repo: FakeRunsRepo | None = None) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_verified_token] = lambda: {"org_id": "org-1"}
    app.state.draftly = SimpleNamespace(
        dependencies=SimpleNamespace(
            repositories=SimpleNamespace(agent_runs=runs_repo or FakeRunsRepo())
        )
    )
    return app


def test_list_agents_returns_catalog_with_expected_roles() -> None:
    app = make_app()
    client = TestClient(app)
    resp = client.get("/agents")
    assert resp.status_code == 200
    roles = {a["role"] for a in resp.json()["agents"]}
    assert "classifier" in roles
    assert "context_agent" in roles
    assert "writer_agent" in roles
    assert "research_swarm_factory" in roles


def test_agents_include_name_description_and_tools() -> None:
    app = make_app()
    client = TestClient(app)
    agents = client.get("/agents").json()["agents"]
    by_role = {a["role"]: a for a in agents}
    writer = by_role["writer_agent"]
    assert writer["name"] == "doc_writer"
    assert writer["description"]
    assert isinstance(writer["tools"], list)
    assert all(isinstance(t, str) for t in writer["tools"])


def test_agent_status_and_history_derived_from_run_steps() -> None:
    runs = [{"run_id": "evt-1", "event_type": "pull_request.opened",
             "status": "completed", "source": "github", "org_id": "org-1"}]
    steps = [
        {"seq": 1, "kind": "node", "name": "classify", "status": "completed",
         "duration_ms": 120, "detail": {}},
        {"seq": 2, "kind": "node", "name": "update", "status": "failed",
         "duration_ms": 500, "detail": {}},
    ]
    repo = FakeRunsRepo(runs=runs, steps=steps)
    app = make_app(repo)
    client = TestClient(app)
    agents = client.get("/agents").json()["agents"]
    writer = next(a for a in agents if a["name"] == "doc_writer")
    assert writer["status"] == "failed"
    assert writer["history"]
    # org-scoped: impl must forward token org_id to list_runs
    # FakeRunsRepo captures the kwarg; a real failure would leak tenants.
    assert repo.last_list_runs_kwargs.get("org_id") == "org-1"


def test_agents_status_defaults_gracefully_when_no_runs() -> None:
    app = make_app(FakeRunsRepo(runs=[], steps=[]))
    client = TestClient(app)
    agents = client.get("/agents").json()["agents"]
    for a in agents:
        assert a["status"] in ("idle", "running", "completed", "failed")
        assert a["history"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_agents_routes.py -v`
Expected: FAIL with `ModuleNotFoundError: draftly.app.api.routes.agents`

- [ ] **Step 3: Write minimal implementation**

Create `draftly-agent-backend/src/draftly/app/api/routes/agents.py`:

```python
"""Agent catalog API over the real Draftly AgentRegistry + run telemetry."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from draftly.app.api.auth import get_verified_token

router = APIRouter(
    prefix="/agents", tags=["agents"], dependencies=[Depends(get_verified_token)]
)

# Static role → (name, description, surface, tool_keys) mirroring the lazily-built
# AgentRegistry (composition/agents.py) and the scoped tool groups (composition/tools.py).
# Factories are NOT invoked here: constructing a Strands Agent needs (model, tools)
# and provider keys. This catalog is the single source of display metadata.
AGENT_CATALOG: list[dict[str, Any]] = [
    {
        "role": "classifier",
        "name": "event_classifier",
        "description": "Classifies incoming developer events by surface and impact.",
        "surface": "shared",
        "tool_keys": [],
    },
    {
        "role": "context_agent",
        "name": "context",
        "description": "Collects evidence about the event from GitHub, search, and docs.",
        "surface": "shared",
        # Must be valid ToolRegistry fields (see composition/tools.py:build_tools) — used by _unique_tools.
        "tool_keys": ["github_intelligence", "semantic_search", "keyword_search", "hybrid_search", "slack_search", "slack_get_thread", "discord_search", "discord_get_thread"],
    },
    {
        "role": "delivery_agent",
        "name": "delivery",
        "description": "Delivers the final output (PR, reply, or message).",
        "surface": "shared",
        "tool_keys": ["github_delivery", "support_engineer"],
    },
    {
        "role": "impact_agent",
        "name": "impact",
        "description": "Analyzes documentation impact and decides answer/update/create.",
        "surface": "documentation",
        "tool_keys": ["documentation"],
    },
    {
        "role": "writer_agent",
        "name": "doc_writer",
        "description": "Writes documentation change plans (create/update).",
        "surface": "documentation",
        "tool_keys": ["documentation_engineer"],
    },
    {
        "role": "answer_writer",
        "name": "support_writer",
        "description": "Writes answers to support questions.",
        "surface": "support",
        "tool_keys": ["support_engineer"],
    },
    {
        "role": "question_analyzer",
        "name": "support_analyzer",
        "description": "Analyzes support questions for documentation gaps.",
        "surface": "support",
        "tool_keys": ["support_engineer"],
    },
    {
        "role": "solution_researcher",
        "name": "support_researcher",
        "description": "Researches solutions for support questions.",
        "surface": "support",
        "tool_keys": ["support_engineer"],
    },
    {
        "role": "issue_analyzer",
        "name": "issue_analyzer",
        "description": "Analyzes GitHub issues for documentation gaps.",
        "surface": "github",
        "tool_keys": ["github_intelligence"],
    },
    {
        "role": "issue_responder",
        "name": "issue_responder",
        "description": "Responds to GitHub issues with answers or doc pointers.",
        "surface": "github",
        "tool_keys": ["support_engineer", "github_delivery"],
    },
    {
        "role": "research_swarm_factory",
        "name": "research_swarm",
        "description": "Four channel-scoped researchers handing off autonomously.",
        "surface": "research",
        # Must stay in sync with _RESEARCH_TOOLS (composition/tools.py) — expand via github_intelligence + per-channel search.
        "tool_keys": ["github_intelligence", "slack_search", "slack_get_thread", "discord_search", "discord_get_thread",
                      "semantic_search", "keyword_search", "hybrid_search"],
    },
]

# Surface → human-readable display label
SURFACE_LABELS: dict[str, str] = {
    "shared": "Shared",
    "documentation": "Documentation",
    "support": "Support",
    "github": "GitHub",
    "research": "Research",
}

# Tool group name → individual tool names (MUST mirror composition/tools.py: _*_TOOLS).
# Keep in sync with ToolRegistry fields; _unique_tools dedupes overlapping groups.
TOOL_GROUPS: dict[str, list[str]] = {
    "documentation": [
        "analyze_structure", "extract_frontmatter", "extract_links",
        "find_section", "generate_toc", "markdown_to_text", "split_sections",
        "update_frontmatter", "validate_links", "semantic_search",
        "keyword_search", "hybrid_search", "code_search", "get_diff",
        "get_files", "affected_docs",
    ],
    "documentation_engineer": [
        "read_file", "write_file", "list_directory", "file_exists",
        "git_status", "git_diff", "git_log", "analyze_structure",
        "extract_frontmatter", "update_frontmatter", "validate_links",
        "create_branch", "create_commit", "create_pull_request",
    ],
    "documentation_reviewer": [
        "get_diff", "get_files", "semantic_search", "keyword_search",
        "hybrid_search", "analyze_structure", "extract_links", "validate_links",
        "markdown_to_text",
    ],
    "github_intelligence": [
        "get_pull_request", "get_issue", "get_diff", "get_files",
        "create_comment", "code_search",
    ],
    "support_engineer": [
        "slack_search_messages", "slack_get_thread", "slack_post_message",
        "discord_search_messages", "discord_get_thread", "discord_post_message",
        "semantic_search", "keyword_search", "hybrid_search",
    ],
    "support_reviewer": [
        "slack_search_messages", "slack_get_thread", "discord_search_messages",
        "discord_get_thread", "semantic_search", "keyword_search",
    ],
    "github_delivery": [
        "create_branch", "create_commit", "create_pull_request", "create_comment",
    ],
    "slack_search": ["slack_search_messages"],
    "slack_get_thread": ["slack_get_thread"],
    "discord_search": ["discord_search_messages"],
    "discord_get_thread": ["discord_get_thread"],
    "semantic_search": ["semantic_search"],
    "keyword_search": ["keyword_search"],
    "hybrid_search": ["hybrid_search"],
    "research": [
        "get_pull_request", "get_issue", "get_diff", "get_files",
        "slack_search_messages", "slack_get_thread", "discord_search_messages",
        "discord_get_thread", "semantic_search", "keyword_search",
        "hybrid_search", "code_search",
    ],
    "memory_curator": [
        "memory_search", "get_memory", "supersede_memory", "reinforce_memory",
        "archive_memory", "record_doc_relation", "record_procedure",
    ],
}


def _unique_tools(keys: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for key in keys:
        for tool in TOOL_GROUPS.get(key, []):
            if tool not in seen:
                seen.add(tool)
                result.append(tool)
    return result


# Role → node_id(s) as written to agent_steps.name (audit.py: node_id).
# Writer fans out to update/create; all others map 1:1. Keeps the lookup
# correct when steps are keyed by node id, not agent display name.
ROLE_NODES: dict[str, list[str]] = {
    "classifier": ["classify"],
    "context_agent": ["context"],
    "delivery_agent": ["deliver"],
    "impact_agent": ["impact"],
    "writer_agent": ["update", "create"],
    "answer_writer": ["answer"],
    "question_analyzer": ["question_analyzer"],
    "solution_researcher": ["solution_researcher"],
    "issue_analyzer": ["issue_analyzer"],
    "issue_responder": ["issue_responder"],
    "research_swarm_factory": ["research"],
}


async def _agent_status_history(
    request: Request, role: str, *, org_id: str | None
) -> tuple[str, str, list[dict[str, str]]]:
    """Return (status, activity, history) for one agent from live run telemetry.

    Org-scoped via org_id (from the verified Clerk token) — never list
    across tenants. Iterates newest-first (list_runs is ORDER BY started_at DESC)
    and stops at the first run that touched this agent.
    """
    runs_repo = getattr(
        getattr(getattr(request.app.state.draftly, "dependencies", None), "repositories", None),
        "agent_runs",
        None,
    )
    if runs_repo is None:
        return "idle", "", []

    runs = await runs_repo.list_runs(org_id=org_id, limit=20) or []
    history: list[dict[str, str]] = []
    status = "idle"
    activity = ""
    target_nodes = set(ROLE_NODES.get(role, [role]))
    for run in runs:  # newest first — do NOT reverse
        steps = await runs_repo.list_steps(str(run.get("run_id"))) or []
        matched = [s for s in steps if str(s.get("name")) in target_nodes]
        if not matched:
            continue
        for step in matched:
            history.append(
                {
                    "label": str(run.get("event_type") or "run"),
                    "result": "failed" if step.get("status") == "failed" else "success",
                    "detail": f"{step.get('kind')} · {step.get('duration_ms') or 0}ms",
                }
            )
            status = "failed" if step.get("status") == "failed" else (
                "running" if step.get("status") == "running" else "completed"
            )
            activity = str(run.get("event_type") or "")
        break  # only the most recent relevant run
    return status, activity, history[-6:]


@router.get("")
async def list_agents(
    request: Request, token: dict[str, Any] = Depends(get_verified_token)
) -> dict[str, Any]:
    """List Draftly's real agent catalog with live status/history."""
    org_id = str(token.get("org_id") or "") or None
    agents: list[dict[str, Any]] = []
    for entry in AGENT_CATALOG:
        status, activity, history = await _agent_status_history(
            request, entry["role"], org_id=org_id
        )
        agents.append(
            {
                "role": entry["role"],
                "name": entry["name"],
                "description": entry["description"],
                "surface": SURFACE_LABELS.get(entry["surface"], entry["surface"]),
                "tools": _unique_tools(entry["tool_keys"]),
                "status": status,
                "activity": activity,
                "history": history,
            }
        )
    return {"agents": agents}
```

- [ ] **Step 4: Register the router**

Modify `draftly-agent-backend/src/draftly/app/api/routes/__init__.py` to add `agents` to the `from . import (...)` tuple and to `__all__` (alphabetical, mirrors existing list).

Modify `draftly-agent-backend/src/draftly/app/api/app.py`:
- Add `agents,` to the `from draftly.app.api.routes import (...)` import.
- Add:
```python
    app.include_router(
        agents.router,
        prefix="/api",
    )
```
Place it alongside the other routers (e.g. after `reviewers`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_agents_routes.py -v`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Run existing api route tests to ensure no regressions**

Run: `cd draftly-agent-backend && python -m pytest tests/api/ -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/agents.py src/draftly/app/api/routes/__init__.py src/draftly/app/api/app.py tests/api/test_agents_routes.py
git commit -m "feat: add /agents catalog API from real AgentRegistry + run telemetry"
```

---

### Task 2: Backend — enrich audit hook detail + stream per-step SSE

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/hooks/audit.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/strands/graph.py` + `orchestration/graphs/{documentation_graph,issue_graph,support_graph}.py` + `workflows/runner.py` (thread `publisher` into `RunAuditLogger`).
- Test: `draftly-agent-backend/tests/orchestration/hooks/test_audit_detail.py` + `draftly-agent-backend/tests/orchestration/hooks/test_audit_stream.py`

**Interfaces:**
- Consumes: existing `_buffer_step(run_id, kind, name, status, duration_ms)` in `audit.py`; an injected `publisher` (the existing `_TeePublisher`) with an async `publish(StreamEnvelope) -> bool`.
- Produces: (1) `_buffer_step` accepts an optional `detail` and writes it to `agent_steps.detail`; (2) the hook emits per-step `StreamEnvelope`s (`node_start`/`node_stop`/`tool_progress`) keyed by the run's `run_id` into the same per-run Redis-Streams channel that `/workflows/{run_id}/events` already serves. Non-breaking — `publisher=None` preserves today's behavior.

**Rationale:** The DB already has a `detail JSONB NOT NULL` column but it is always written as `{}`, and agent steps never surface live. Threading the `context.publisher` into the audit hook means **every** Strands graph (PR/issue/support) streams its agent/node/tool steps into the run's per-run SSE stream — the exact data the Agents page feed + detail pane need, with rich `detail`, and no new transport.

- [ ] **Step A: Thread `publisher` into the graph builders**

`build_graph_for_run` (`integrations/strands/graph.py:45`) already receives `**graph_kwargs` and forwards to each builder. Add `publisher: Any = None` to its signature and pass it through. In each graph builder (`documentation_graph.py:76`, `issue_graph.py:45`, `support_graph.py:46`) add `publisher: Any = None` and construct `RunAuditLogger(audit_repo, publisher=publisher)`. In `workflows/runner.py` `_default_graph_factory` (`runner.py:80-93`) change `build_graph_for_run(...)` to pass `publisher=context.publisher`.

- [ ] **Step 1: Write the failing test (title detail)**

Create `draftly-agent-backend/tests/orchestration/hooks/test_audit_detail.py`:

```python
"""Audit hook writes agent/tool detail into step records."""

from __future__ import annotations

from draftly.orchestration.hooks.audit import RunAuditLogger


class RecordingRepo:
    def __init__(self) -> None:
        self.steps: list[dict] = []

    async def start_run(self, **kw) -> None:  # async no-op
        pass

    async def record_step(self, run_id=None, seq=0, kind="", name="",
                          status="", duration_ms=None, detail=None) -> None:
        self.steps.append(
            {"kind": kind, "name": name, "status": status, "detail": detail}
        )

    async def finish_run(self, **kw) -> None:  # async no-op
        pass


def _bump(logger: RunAuditLogger) -> None:
    # Access the sync buffer path used by node_end/tool_end before the async flush.
    logger._buffer_step(
        run_id="evt-1",
        kind="node",
        name="doc_writer",
        status="completed",
        duration_ms=120,
        detail={"agent_name": "doc_writer", "capabilities": ["write", "format"]},
    )


def test_buffer_step_records_detail() -> None:
    logger = RunAuditLogger()
    _bump(logger)
    step = logger._steps[0]
    assert step["detail"] == {
        "agent_name": "doc_writer",
        "capabilities": ["write", "format"],
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/orchestration/hooks/test_audit_detail.py -v`
Expected: FAIL — the hook currently does not accept/propagate `detail`.

- [ ] **Step 3: Write failing streaming test**

Create `draftly-agent-backend/tests/orchestration/hooks/test_audit_stream.py`:

```python
"""Audit hook publishes per-step SSE envelopes via its publisher."""

from __future__ import annotations

from types import SimpleNamespace
from draftly.orchestration.hooks.audit import RunAuditLogger


class RecordingPublisher:
    def __init__(self) -> None:
        self.envelopes: list = []

    async def publish(self, envelope) -> bool:
        self.envelopes.append(envelope)
        return True


def _event(node_id="doc_writer"):
    return SimpleNamespace(
        node_id=node_id,
        invocation_state={"run_id": "evt-1", "project_id": "org-1", "source": "github"},
        result=SimpleNamespace(status="COMPLETED"),
    )


def test_run_end_publishes_step_envelopes() -> None:
    pub = RecordingPublisher()
    logger = RunAuditLogger(audit_repo=None, publisher=pub)
    logger.node_start(_event())
    logger.node_end(_event())
    import asyncio
    asyncio.run(logger.run_end_async(_event()))
    types = {e.type for e in pub.envelopes}
    assert {"node_start", "node_stop"} <= types
    assert all(e.run_id == "evt-1" for e in pub.envelopes)
```

> Note: `run_end` buffers and schedules an async flush on the running loop. To keep the test deterministic we expose a small awaitable `run_end_async(event)` that performs the buffered stream publish synchronously-under-test; the sync `run_end` callback calls `loop.create_task(run_end_async(event))` in production (see Step 4). Default `publisher=None` ⇒ no envelopes and no behavior change.

- [ ] **Step 4: Write minimal implementation in `audit.py`**

Update the constructor and `_buffer_step` signature, add stream buffering, and add `run_end_async`:

```python
    def __init__(self, audit_repo: Any = None, publisher: Any = None) -> None:
        self.audit_repo = audit_repo
        self.publisher = publisher
        self._node_started_at: dict[str, float] = {}
        self._steps: list[dict[str, Any]] = []
        self._stream_pending: list[dict[str, Any]] = []
        self._run_meta: dict[str, Any] = {}
        self._seq = 0
        self._stream_seq = 0
```

In `node_start`, record a stream entry (envelope spec) for `node_start`:
```python
    def node_start(self, event: BeforeNodeCallEvent) -> None:
        self._node_started_at[event.node_id] = time.monotonic()
        state = event.invocation_state or {}
        run_id = state.get("run_id")
        if run_id:
            self._stream_seq += 1
            self._stream_pending.append({
                "type": "node_start",
                "node_id": str(event.node_id),
                "payload": {"node_type": "agent"},
                "seq": self._stream_seq,
            })
```

In `node_end`, append a `node_stop` stream spec carrying the rich `detail` (same detail written to the DB):
```python
    def node_end(self, event: AfterNodeCallEvent) -> None:
        state = event.invocation_state or {}
        run_id = state.get("run_id")
        started = self._node_started_at.pop(event.node_id, None)
        duration_ms = round((time.monotonic() - started) * 1000) if started else None
        status = _status_of(event)
        detail = {"agent_name": str(event.node_id), "capabilities": [str(event.node_id)]}
        self._buffer_step(
            run_id=run_id, kind="node", name=str(event.node_id),
            status=status, duration_ms=duration_ms, detail=detail,
        )
        if run_id:
            self._stream_seq += 1
            self._stream_pending.append({
                "type": "node_stop",
                "node_id": str(event.node_id),
                "payload": {**detail, "status": status, "duration_ms": duration_ms},
                "seq": self._stream_seq,
            })
```

In `tool_end`, append a `tool_progress` stream spec:
```python
    def tool_end(self, event: AfterToolCallEvent) -> None:
        state = event.invocation_state or {}
        run_id = state.get("run_id")
        tool_name = getattr(event.tool_use, "get", lambda *_: None)("name")
        status = _tool_status_of(event)
        self._buffer_step(
            run_id=run_id, kind="tool", name=str(tool_name or "unknown"),
            status=status,
            detail={"tool_name": str(tool_name or "unknown"), "status": status},
        )
        if run_id:
            self._stream_seq += 1
            self._stream_pending.append({
                "type": "tool_progress",
                "node_id": None,
                "payload": {
                    "name": str(tool_name or "unknown"),
                    "status": status,
                    "node_id": None,
                },
                "seq": self._stream_seq,
            })
```

Make `run_end` schedule an async flush that publishes the buffered stream specs, and add `run_end_async`:

```python
    def run_end(self, event: AfterInvocationEvent) -> None:
        state = event.invocation_state or {}
        run_id = state.get("run_id")
        if not run_id:
            return
        meta = dict(self._run_meta)
        steps = list(self._steps)
        stream_pending = list(self._stream_pending)
        self._steps.clear()
        self._stream_pending.clear()
        self._run_meta.clear()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning("audit_flush_skipped_no_loop run_id=%s", run_id)
            return
        if self.audit_repo is not None and steps:
            loop.create_task(_flush_run(self.audit_repo, str(run_id), meta, steps))
        elif not steps:
            # No steps to flush; audit_repo path is no-op (preserves offline behavior).
            pass
        if self.publisher is not None and stream_pending:
            loop.create_task(
                _flush_stream(
                    self.publisher, str(run_id),
                    meta.get("surface", ""), stream_pending,
                )
            )
```

Add the module-level async helper:

```python
async def _flush_stream(
    publisher: Any, run_id: str, surface: str, pending: list[dict[str, Any]]
) -> None:
    """Publish buffered per-step envelopes into the run's per-run SSE channel.

    Failures are swallowed by the publisher/bus — streaming must never
    fail the workflow (spec §Error handling). seq is monotonic per run.
    """
    from draftly.events.stream_envelope import StreamEnvelope

    try:
        for spec in pending:
            await publisher.publish(
                StreamEnvelope(
                    type=str(spec["type"]),
                    run_id=run_id,
                    surface=surface,
                    seq=int(spec.get("seq", 0)),
                    node_id=spec.get("node_id"),
                    payload=dict(spec.get("payload") or {}),
                )
            )
    except Exception:
        logger.warning("audit_stream_flush_failed run_id=%s", run_id, exc_info=True)
```

For the deterministic test path, add a small method the test calls directly:
```python
    async def run_end_async(self, event: AfterInvocationEvent) -> None:
        state = event.invocation_state or {}
        run_id = state.get("run_id")
        if not run_id:
            return
        if self.publisher is not None:
            from draftly.events.stream_envelope import StreamEnvelope
            for spec in self._stream_pending:
                await self.publisher.publish(
                    StreamEnvelope(
                        type=str(spec["type"]),
                        run_id=run_id,
                        surface=self._run_meta.get("surface", ""),
                        seq=int(spec.get("seq", 0)),
                        node_id=spec.get("node_id"),
                        payload=dict(spec.get("payload") or {}),
                    )
                )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd draftly-agent-backend && python -m pytest tests/orchestration/hooks/test_audit_detail.py tests/orchestration/hooks/test_audit_stream.py -v`
Expected: PASS

- [ ] **Step 6: Run existing run/audit tests to ensure no regressions**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_runs_routes.py tests/workflows/test_audit_hook.py -q`
Expected: PASS (default `publisher=None` path unchanged)

- [ ] **Step 7: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/orchestration/hooks/audit.py src/draftly/integrations/strands/graph.py src/draftly/orchestration/graphs/ src/draftly/workflows/runner.py tests/orchestration/hooks/
git commit -m "feat: stream per-step agent SSE envelopes + record audit step detail"
```

---

### Task 3: Backend — jobs-row ticket resolution for agent runs

`POST /workflows/{run_id}/stream-ticket` (`routes/workflows.py:57`) resolves the ticket only if a `jobs` row exists (`jobs.get(job_id=run_id)`, lines 73-76); it 404s otherwise. Onboarding and the PR webhook create a `jobs` row before issuing a ticket (`github.py:280-312`). Agent runs currently write only `agent_runs`/`agent_steps`, so the ticket would 404 and `useWorkflowEvents` could never attach. **Fix: the audit hook upserts a `jobs` row on `run_start`** so every agent run can be streamed over the existing per-run SSE transport with no new route or transport.

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/hooks/audit.py` (inject `jobs_repo`).
- Modify: `draftly-agent-backend/src/draftly/integrations/strands/graph.py` + graph builders + `workflows/runner.py` (forward `jobs_repo=getattr(context.repositories, "jobs", None)` — see Step 1).
- Test: `draftly-agent-backend/tests/orchestration/hooks/test_audit_jobs_row.py`

**Interfaces:**
- Consumes: an injected `jobs_repo` with `upsert_on_conflict(**kwargs) -> dict | None` (already implemented on `JobRepositoryImpl.jobs.py:22`). If `jobs_repo is None`, skip the upsert (non-breaking).
- Produces: on `run_start`, `RunAuditLogger` upserts a `jobs` row `{job_id: run_id, org_id, name: <surface>, job_type: "agent", status: "running"}` so `stream-ticket` resolves. Mirror the field shape `github.py` uses when minting a ticket row so the same `GET /workflows/{run_id}/events` replay path works.

- [ ] **Step 1: Verify how `jobs` is exposed to the workflow context/runner**

Check `WorkflowContext` (`workflows/context.py:40`) — it only exposes `repositories`, `publisher`, `audit_repo` directly. `jobs` lives at `context.repositories.jobs` (like `context.repositories` in `runner.py:80` and `app/composition/workflows.py:build_workflows`). Do **not** use `context.jobs` (does not exist); forward `getattr(context.repositories, "jobs", None)` via `build_graph_for_run(**graph_kwargs)` the same way `audit_repo` is passed today. Record the resolved accessor in a code comment rather than guessing.

- [ ] **Step 2: Write the failing test**

Create `draftly-agent-backend/tests/orchestration/hooks/test_audit_jobs_row.py`:

```python
"""Audit hook upserts a jobs row on run_start so stream-ticket resolves."""

from __future__ import annotations

from types import SimpleNamespace

from draftly.orchestration.hooks.audit import RunAuditLogger


class RecordingJobs:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def upsert_on_conflict(self, **kwargs) -> dict | None:
        self.calls.append(kwargs)
        return kwargs


def _start_event():
    return SimpleNamespace(
        invocation_state={
            "run_id": "evt-1",
            "project_id": "org-1",
            "source": "github",
            "event_type": "pull_request.opened",
        }
    )


def test_run_start_upserts_jobs_row() -> None:
    jobs = RecordingJobs()
    logger = RunAuditLogger(audit_repo=None, jobs_repo=jobs)
    logger.run_start(_start_event())
    assert len(jobs.calls) == 1
    row = jobs.calls[0]
    assert row["job_id"] == "evt-1"
    assert row["org_id"] == "org-1"
    assert row["status"] == "running"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/orchestration/hooks/test_audit_jobs_row.py -v`
Expected: FAIL — `RunAuditLogger` has no `jobs_repo` param / no upsert.

- [ ] **Step 4: Write minimal implementation**

Add `jobs_repo` to the `RunAuditLogger.__init__`. In `run_start`, after setting `self._run_meta`, if `jobs_repo` is present, schedule an async upsert:

```python
    def __init__(self, audit_repo: Any = None, publisher: Any = None,
                 jobs_repo: Any = None) -> None:
        self.audit_repo = audit_repo
        self.publisher = publisher
        self.jobs_repo = jobs_repo
        # ...existing fields...

    def run_start(self, event: BeforeInvocationEvent) -> None:
        state = event.invocation_state or {}
        run_id = state.get("run_id")
        if not run_id:
            return
        self._run_meta = {
            "run_id": str(run_id),
            "source": str(state.get("source", "github")),
            "event_type": str(state.get("event_type", "unknown")),
            "org_id": str(state.get("project_id", "")),
        }
        if self.jobs_repo is not None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None:
                loop.create_task(
                    _upsert_job_row(
                        self.jobs_repo,
                        job_id=str(run_id),
                        org_id=str(state.get("project_id", "")),
                        surface=str(state.get("source", "github")),
                        event_type=str(state.get("event_type", "unknown")),
                    )
                )
        logger.info("audit.run.start run_id=%s", run_id)
```

Add the module-level helper:

```python
async def _upsert_job_row(
    jobs_repo: Any, *, job_id: str, org_id: str, surface: str, event_type: str
) -> None:
    """Create a jobs row so the per-run SSE ticket endpoint can resolve it.

    Mirrors the webhook/onboarding shape (github.py:280-312). Failures are
    logged and swallowed — a missing jobs row must never fail the graph run.
    """
    try:
        await jobs_repo.upsert_on_conflict(
            job_id=job_id,
            org_id=org_id,
            name=surface or event_type or "agent",
            job_type="agent",
            status="running",
        )
    except Exception:
        logger.warning("audit_job_row_upsert_failed run_id=%s", job_id, exc_info=True)
```

> The sync `run_start` hands off to the running loop (the same persistent loop used by `rq_dispatch`), so the upsert races ahead of (and overlaps with) the per-step stream flush — exactly as onboarding/I/O already do. `publisher=None`/`jobs_repo=None` ⇒ today's behavior unchanged. Note: if the ticket is requested before the upsert lands, `POST /workflows/{run_id}/stream-ticket` (`workflows.py:73`) will 404. The runner already retries ticket issuance via `jobs.get`; the frontend should surface a transient "preparing stream…" state and retry once (useWorkflowEvents already reconnects) rather than failing hard.

- [ ] **Step 5: Thread `jobs_repo` through graph builders + runner**

Forward it exactly like `publisher` in Task 2 (append to `build_graph_for_run` + `documentation_graph.py`/`issue_graph.py`/`support_graph.py` + `workflows/runner.py` `_default_graph_factory`), but resolve as `getattr(context.repositories, "jobs", None)` in `runner.py` (not `context.jobs`). Only pass a truthy value so default-`None` call sites stay non-breaking.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd draftly-agent-backend && python -m pytest tests/orchestration/hooks/test_audit_jobs_row.py tests/orchestration/hooks/test_audit_stream.py tests/orchestration/hooks/test_audit_detail.py -v`
Expected: PASS

- [ ] **Step 7: Run existing run/audit/worker tests to ensure no regressions**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_runs_routes.py tests/workflows/test_audit_hook.py tests/app/test_workers_register.py -q`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/orchestration/hooks/audit.py src/draftly/integrations/strands/graph.py src/draftly/orchestration/graphs/ src/draftly/workflows/runner.py tests/orchestration/hooks/test_audit_jobs_row.py
git commit -m "feat: mint jobs row on agent run start so per-run SSE tickets resolve"
```

---

### Task 4: Frontend — API wrapper + types

**Files:**
- Create: `draftly-agent-frontend/api/agents.ts`
- Create: `draftly-agent-frontend/api/runs.ts`
- Modify: `draftly-agent-frontend/api/types.ts`

**Interfaces:**
- Consumes: `request()` from `api/client.ts`; `AgentSummary`/run types defined here.
- Produces: `listAgents(): Promise<{ agents: AgentSummary[] }>`, `listRuns(): Promise<RunSummary[]>`, and the `AgentSummary`/`RunSummary` types. Tasks 5–6 consume these.

- [ ] **Step 1: Add types to `api/types.ts`**

Append:

```ts
export interface AgentHistoryEntry {
  label: string;
  result: "success" | "failed";
  detail: string;
}

export interface AgentSummary {
  role: string;
  name: string;
  description: string;
  surface: string;
  tools: string[];
  status: "idle" | "running" | "completed" | "failed";
  activity: string;
  history: AgentHistoryEntry[];
}

// Per-run SSE / list snapshot types (source-of-truth: GET /api/runs).
export interface RunSummary {
  run_id: string;
  agent_name: string;
  status: "running" | "completed" | "failed";
  surface: string;
  started_at: string;
  finished_at?: string | null;
  last_step_at?: string | null;
}

export interface RunStepSummary {
  seq: number;
  kind: string;
  name: string;
  status: string;
  duration_ms?: number | null;
  detail?: Record<string, unknown>;
}

export interface AgentRun {
  run_id: string;
  surface: string;
  status: string;
  steps: RunStepSummary[];
}
```

- [ ] **Step 2: Create `api/agents.ts`**

```ts
import { request } from "./client";
import type { AgentSummary } from "./types";

export async function listAgents(): Promise<{ agents: AgentSummary[] }> {
  return request("/agents");
}
```

- [ ] **Step 2b: Create `api/runs.ts`**

One-shot snapshot to enumerate the per-run SSE channels to subscribe to (NOT polled):

```ts
import { request } from "./client";
import type { RunSummary, RunStepSummary } from "./types";

export async function listRuns(): Promise<RunSummary[]> {
  // routes/runs.py returns { items: [...] } (not { runs: [...] })
  const res = await request<{ items: RunSummary[] }>("/runs");
  return res.items;
}

export async function getRunSteps(runId: string): Promise<RunStepSummary[]> {
  const res = await request<{ items: RunStepSummary[] }>(`/runs/${runId}/steps`);
  return res.items;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd draftly-agent-frontend && npx tsc --noEmit`
Expected: no errors introduced

- [ ] **Step 4: Commit**

```bash
cd draftly-agent-frontend
git add api/agents.ts api/runs.ts api/types.ts
git commit -m "feat: add agents + runs API clients and types"
```

---

### Task 5: Frontend — rewrite agents page to live data (strict SSE, no polling)

**Files:**
- Modify: `draftly-agent-frontend/components/agents/agents.tsx`
- Create: `draftly-agent-frontend/components/agents/agent-icons.tsx`
- Create: `draftly-agent-frontend/hooks/use-agent-runs.ts`

**Interfaces:**
- Consumes: `listAgents()` + `listRuns()` from Task 4; `useWorkflowEvents(run_id)` from `hooks/use-workflow-events.ts` (per-run SSE — ticket fetch, `EventSource`, `seq` dedupe, auto-close on `workflow_result`); `AgentList`, `AgentDetail`, `AgentFilters`, `Sidebar`, `Topbar` (existing props preserved).
- Produces: `Agents` page rendering the real catalog (one-shot) plus a **live per-run activity feed and live per-run detail driven entirely by SSE**. `useAgentRuns()` (new hook) manages the feed/detail state, subscribes to per-run streams, and exposes `{ runs, selected, connectRun, error }`. **There is no `setInterval` anywhere on this page.**

**SSE data flow (strict, no polling):**
1. On mount, `listAgents()` (static catalog) and `listRuns()` (one-shot snapshot of recent agent runs) are fetched **once**.
2. The run list seeds a feed of `RunSummary` rows. Selecting a row calls `connectRun(run_id)`, which calls `useWorkflowEvents(run_id)` → POST `/workflows/{run_id}/stream-ticket` → `EventSource` on `/workflows/{run_id}/events?ticket=...` (existing transport, reused unchanged).
3. Frames (`node_start`/`node_stop`/`tool_progress`/`workflow_result`) from the selected run's SSE stream update the selected run's status and the live `AgentDetail` step pane in real time. On `workflow_result`, the hook (per `useWorkflowEvents`) closes the stream; the run is marked terminal in the feed.
4. The **live feed** is composed from the runs list + the SSE-driven progress of the run(s) the user has opened. If a live update should surface for runs not currently selected, it streams when selected (per-run streams are one-run-by-design). No timer refreshes the list.

- [ ] **Step 1: Create `agent-icons.tsx`**

A role/surface → lucide icon map used by the list and detail. Follows the `dashboard/data.tsx` pattern of importing lucide components and exposing a `ComponentType<{ className?: string }>`.

```tsx
import {
  Bot,
  Brain,
  BookOpen,
  ClipboardCheck,
  FileSearch,
  GitBranch,
  Pen,
  Search,
  Send,
  Shield,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";

export const agentIconFor: Record<string, ComponentType<{ className?: string }>> = {
  classifier: Bot,
  context_agent: Search,
  delivery_agent: Send,
  impact_agent: FileSearch,
  writer_agent: Pen,
  answer_writer: Pen,
  question_analyzer: Brain,
  solution_researcher: Search,
  issue_analyzer: FileSearch,
  issue_responder: GitBranch,
  research_swarm_factory: Workflow,
};

export function agentIcon(role: string): ComponentType<{ className?: string }> {
  return agentIconFor[role] ?? Bot;
}
```

- [ ] **Step 2: Create `hooks/use-agent-runs.ts` (per-run SSE)**

A hook that owns the feed/detail state and wraps `useWorkflowEvents` per selected run. It fetches the run snapshot once and subscribes to a run's per-run SSE stream on selection (no polling).

```ts
import { useCallback, useEffect, useState } from "react";
import { listRuns } from "@/api/runs";
import { useWorkflowEvents } from "@/hooks/use-workflow-events";
import type { AgentRun, RunSummary } from "@/api/types";

const EMPTY: AgentRun[] = [];

export function useAgentRuns() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // One-shot snapshot to enumerate the per-run streams (NOT polled).
  useEffect(() => {
    let cancelled = false;
    listRuns()
      .then((rows) => {
        if (!cancelled) {
          setRuns(rows);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connectRun = useCallback((runId: string) => setSelectedId(runId), []);

  // Attach the per-run SSE stream for the selected run (auto-closes on workflow_result).
  // useWorkflowEvents handles null → no stream (see hooks/use-workflow-events.ts: useEffect early-return on !run_id).
  const selectedRun = runs.find((r) => r.run_id === selectedId) ?? null;
  const frames = useWorkflowEvents(selectedId);

  // Fold live frames into the selected run's status + detail steps.
  const detail: AgentRun | null = selectedId
    ? {
        run_id: selectedId,
        surface: selectedRun?.surface ?? "",
        status: selectedRun?.status ?? "running",
        steps: frames.map((f) => ({
          seq: f.seq,
          kind: f.type === "tool_progress" ? "tool" : "node",
          name: f.payload?.name ?? f.node_id ?? f.type,
          status: f.payload?.status ?? (f.type === "node_stop" ? "completed" : "running"),
          duration_ms: f.payload?.duration_ms ?? null as any,
          detail: f.payload,
        })),
      }
    : null;

  return { runs, loaded, error, selectedId, selectedRun, detail, connectRun };
}
```

> `useWorkflowEvents(null)` is the no-op case (hook returns `[]` without opening a stream — see `hooks/use-workflow-events.ts: if (!run_id) return`). The call is unconditional (Rules of Hooks) — null vs undefined matters for the type `string | null`.

- [ ] **Step 3: Rewrite `agents.tsx`**

Consume `useAgentRuns()` instead of the mock; render the catalog (from `listAgents`, loaded once) and the feed/detail from `useAgentRuns`:

```tsx
import { listAgents } from "@/api/agents";
import type { AgentSummary } from "@/api/types";
import { useAgentRuns } from "@/hooks/use-agent-runs";

// inside the component:
const [agents, setAgents] = useState<AgentSummary[] | null>(null);
const [catalogError, setCatalogError] = useState<string | null>(null);
useEffect(() => {
  let cancelled = false;
  listAgents()
    .then((res) => !cancelled && setAgents(res.agents))
    .catch((e) => !cancelled && setCatalogError(e instanceof Error ? e.message : String(e)));
  return () => { cancelled = true; };
}, []);

const { runs, loaded: runsLoaded, error: runError, selectedId, selectedRun, detail, connectRun } =
  useAgentRuns();
```

Then render (mirror existing layout, but with per-run detail streaming):
```tsx
{/* one-shot catalog loading/error/empty */}
{catalogError ? <div className="...red...">Failed to load agents: {catalogError}</div>
 : agents === null ? <div className="...">Loading agents…</div>
 : (
  <div className="flex min-h-0 flex-1 gap-6 overflow-hidden">
    <AgentList
      agents={agents}
      runs={runs}
      runsLoaded={runsLoaded}
      selectedId={selectedId}
      onSelect={connectRun}
    />
    <AgentDetail agent={selected} run={detail} />
  </div>
)}
```

Keep: `mobileNavOpen`, `dark` theme handling, `query` (drives Topbar), the layout (Sidebar/Topbar/header/filters/list+detail). Reset `selectedId` if the selected run disappears from `runs` (optional; `detail` is null then).

- [ ] **Step 4: Update `agent-list.tsx` to consume `AgentSummary` + live run rows**

Change the import from `./data` to `@/api/types` (`AgentSummary`) / `@/api/types` (`RunSummary`). Render one row per catalog `AgentSummary`, and surface the **live per-run feed**: the most recently active `RunSummary` per agent (from `runs`, looked up by surface/name) drives the live status; fall back to `agent.status`/`agent.activity`. Update `status` styling to include `completed`/`failed`, and replace the hand-rolled icon with `agentIcon(role)`.

Replace:
```tsx
const Icon = agentIcon(agent.role);
```
(import `agentIcon` from `./agent-icons`).

```tsx
const statusStyles: Record<string, { badge: string; dot: string }> = {
  idle: { badge: "text-slate-600 dark:text-slate-400", dot: "bg-slate-400" },
  running: { badge: "text-sky-600 dark:text-sky-400", dot: "bg-sky-500" },
  completed: { badge: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  failed: { badge: "text-red-600 dark:text-red-400", dot: "bg-red-500" },
};
```

For the live feed portion, render the `runs` rows under the agent catalog (or merge by surfacing each run's live status). Keep the pulse animation only when `status === "running"`.

- [ ] **Step 5: Update `agent-detail.tsx` to consume `AgentSummary` + live run stream**

Live per-run pane from `run` (the `AgentRun` from `useAgentRuns`): render `run.steps` as the streaming step timeline (status from `node_stop`/`tool_progress` frames, `duration_ms` from node_stop, `detail` for tool/agent). Update `statusStyles` to add `completed`/`failed` (mirror list). Use `agentIcon(agent.role)` for the header icon. If `run` is null, show the existing "Select an agent" empty state.

- [ ] **Step 6: Update `agent-filters.tsx`**

Derive filter counts from the fetched `AgentSummary[]` instead of hardcoded counts:
```tsx
export function AgentFilters({
  activeFilter,
  onFilterChange,
  agents,
}: {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  agents: AgentSummary[];
}) {
  const filters = ["Active", "Running", "Completed", "Failed", ...].map((label) => {
    const count = label === "Active"
      ? agents.length
      : agents.filter((a) => a.status.toUpperCase() === label.toUpperCase()).length;
    return { label, count };
  });
  // …existing render with `color` per label
}
```
Update `agents.tsx` to pass `agents={agents ?? []}` to `AgentFilters`.

- [ ] **Step 7: Delete the mock**

Delete `draftly-agent-frontend/components/agents/data.tsx`. Confirm no remaining imports of `./data` exist after Task 5.

- [ ] **Step 8: Typecheck**

Run: `cd draftly-agent-frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 9: Add frontend page test**

Create `draftly-agent-frontend/components/agents/__tests__/agents.test.tsx`. It must assert the **strict-SSE** contract: the catalog renders, and selecting a run opens an `EventSource` to `/api/workflows/{run_id}/events` (via `useAgentRuns`→`useWorkflowEvents`), with a `MockEventSource` like `__tests__/hooks/use-workflow-events.test.ts`. Minimal shape:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const listAgents = vi.hoisted(() => vi.fn());
const listRuns = vi.hoisted(() => vi.fn());
vi.mock("@/api/agents", () => ({ listAgents }));
vi.mock("@/api/runs", () => ({ listRuns }));
// Stub the SSE hook so the test drives frames deterministically.
const connectMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-agent-runs", () => ({
  useAgentRuns: () => ({ ... }), // seeded via hoisted factory
}));
vi.mock("@/components/dashboard/sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock("@/components/dashboard/topbar", () => ({ Topbar: () => <div data-testid="topbar" /> }));

import { Agents } from "../agents";

describe("Agents (strict SSE)", () => {
  it("renders the catalog and streams the selected run's detail", async () => {
    // seed agents + runs + a live frame; render; click a run; expect detail
    expect(await screen.findByText("doc_writer")).toBeTruthy();
  });
});
```

A second test asserts **no polling**: `vi.useFakeTimers()` + advance timers and confirm no additional `listAgents`/`listRuns` calls occur (only SSE frames update state).

- [ ] **Step 10: Run frontend tests**

Run: `cd draftly-agent-frontend && npm test`
Expected: PASS (new tests + no regressions)

- [ ] **Step 11: Run lint**

Run: `cd draftly-agent-frontend && npm run lint`
Expected: no errors

- [ ] **Step 12: Commit**

```bash
cd draftly-agent-frontend
git add -A components/agents hooks/use-agent-runs.ts
git rm components/agents/data.tsx
git commit -m "feat: render agents page via live per-run SSE (no polling)"
```

---

### Task 6: Verification + final handoff

- [ ] **Step 1: Backend full test run**

Run: `cd draftly-agent-backend && python -m pytest tests/api/ tests/orchestration/hooks/ -q`
Expected: all pass

- [ ] **Step 2: Backend manual smoke (optional)**

If a dev API server is running, hit `GET /api/agents` with a valid Clerk token and confirm the JSON shape matches the frontend `AgentSummary`.

- [ ] **Step 3: Frontend full test + lint**

Run: `cd draftly-agent-frontend && npm test && npm run lint`
Expected: all pass

- [ ] **Step 4: Manual dev check (optional)**

Run `npm run dev` in the frontend and confirm the Agents page loads real data (or shows the loading/error state cleanly when the backend is down).

- [ ] **Step 5: Final commit (if any stragglers)**

```bash
cd draftly-agent-backend && git add -A && git commit -m "chore: verification" || true
cd draftly-agent-frontend && git add -A && git commit -m "chore: verification" || true
```

## Out of Scope / Residuals

- `performancePercent`/`Reliability`/`Pass rate` labels from the mock are replaced with real aggregates (success rate from `history`).
- `detail`/capability data populates for **new** runs only after the audit-hook enrichment ships (Task 2); old runs have thin/graceful data.
- Agent instances are never constructed at request time; the catalog is static definitions + live telemetry.
