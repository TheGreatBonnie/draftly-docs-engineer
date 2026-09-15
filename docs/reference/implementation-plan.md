# Draftly Implementation Plan — Strands Agents

Complete implementation guide for a production-ready Draftly system in
`draftly-agent-backend/`, using the verified Strands SDK patterns in
[`strands-build-guide.md`](./strands-build-guide.md), the GitHub PR flow in
[`github-pr-flow.md`](./github-pr-flow.md), and the Strands Agents docs.

Scope decisions (confirmed):

- **Full system in one pass**: all three surfaces (GitHub PR, GitHub Issue,
  Slack/Discord support) + feedback loop + evaluation + memory.
- **Rewrite the composition layer to the Strands API**: normalize imports to
  `draftly.*` and replace the LangGraph-flavored app wiring with Strands
  `Graph`/`Swarm`/`Agent` + session-manager constructs.
- **No model keys / no live NeonDB at verification time**: verify with
  deterministic custom-node graph tests, a stub `Model`, and in-memory fakes;
  live runs are gated behind an `@pytest.mark.integration` marker.

---

## 0. Ground truth (from repository exploration)

| Layer                                                                                                                                                                                                                                                                | State                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FastAPI app** (`app/`): routes (health/github/slack/discord/clerk/jobs/reviewers), middleware, lifecycle, workers, scheduler, pipelines, config                                                                                                                    | **Implemented** (33 files, ~4200 lines) but imports are broken — see §0.1                                                                                                                                                                                                                                                                                                     |
| **Integrations** (`integrations/`): github, slack, discord, database (was cockroachdb, 22 migrations), deepeval, clerk                                                                                                                                               | **Implemented** (42 files). **`integrations/cockroachdb/` is renamed to `integrations/database/` and re-targeted at NeonDB/pgvector in Phase 0 (§2.7).** `integrations/deepeval/` and `agents/shared/deepeval.py` are **removed** in Phase 6 — replaced by the Strands Evals SDK (`strands-agents-evals==1.1.1`, verified §8.10); `deepeval` is dropped from `pyproject.toml` |
| **Models** (`models/`): custom router over openrouter/nvidia/orcarouter/requesty, factory, registry, health, policies, embeddings                                                                                                                                    | **Implemented but broken** — `models/providers/base.py` imports `langchain_core`, which is **not in `uv.lock`**                                                                                                                                                                                                                                                               |
| **Persistence** (`persistence/`): 14 repository modules + 22 SQL migrations                                                                                                                                                                                          | **Implemented** — migrations are Postgres-compatible (applied via `psql`/`neonctl`); only `VECTOR` DDL + `STRING` types need Neon fixes (§2.7)                                                                                                                                                                                                                                |
| **Strands domain layer**: `agents/`, `tools/`, `orchestration/`, `events/`, `workflows/`, `memory/`, `evaluation/`, `review/`, `feedback/`, `documentation/`, `delivery/`, `support/`, `skills/**/SKILL.md`, `integrations/strands/*`, `security/`, `observability/` | **216 stubs** (0-byte files)                                                                                                                                                                                                                                                                                                                                                  |
| **Tests** (`tests/`): 7 files across `workflow/` and `evaluation/`                                                                                                                                                                                                   | **Stubs**                                                                                                                                                                                                                                                                                                                                                                     |
| **Context policies** (`context/*.md`): 11 markdown files at `draftly-agent-backend/context/`                                                                                                                                                                         | Present (input to prompts / context injection)                                                                                                                                                                                                                                                                                                                                |
| **Skills** (`skills/`): 20 SKILL.md files + 66 reference .md + 4 asset .md                                                                                                                                                                                           | All stubs                                                                                                                                                                                                                                                                                                                                                                     |

**Total**: 280 `.py` files — 64 implemented, 216 stubs. 20 SKILL.md files, 66 reference docs, 4 asset templates — all stubs.

### 0.1 Broken composition layer (must be fixed first)

The implemented app layer imports packages that do not exist and uses a
LangGraph API that is not a dependency:

| File                               | Broken import                                                                         | Fix                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `app/composition/agents.py`        | `from agents.draftly_agent import create_draftly_agent`                               | `from draftly.agents.draftly_agent`                       |
| `app/composition/agents.py`        | `from agents.subagents import build_subagents`                                        | `from draftly.agents.subagents`                           |
| `app/composition/agents.py`        | `from models import create_model_router_middleware`                                   | `from draftly.models`                                     |
| `app/composition/agents.py`        | LangGraph-style `create_draftly_agent(model=..., checkpointer=..., interrupt_on=...)` | Rewrite to Strands `Agent` + `GraphBuilder`               |
| `app/composition/workflows.py`     | `workflows.run_pull_request_workflow` etc.                                            | `from draftly.workflows.*`                                |
| `app/pipelines/github_pipeline.py` | _(all imports)_                                                                       | **Delete file** — replaced by runner in §7.4              |
| `app/pipelines/github_pipeline.py` | `app_state.workflows.github_support`                                                  | _(deleted with file)_                                     |
| `app/composition/workers.py`       | `from workflows.context import WorkflowContext`                                       | `from draftly.workflows.context import WorkflowContext`   |
| `app/composition/workers.py`       | `from integrations.scheduler.client import SchedulerClient`                           | `from draftly.app.workers.task_runner`                    |
| `app/api/routes/github.py`         | `from events.github_events import GitHubEventProcessor`                               | `from draftly.events.github.pull_request`                 |
| `app/lifecycle.py`                 | `from langgraph.checkpoint_postgres.aio import AsyncPostgresSaver`                    | Delete; replace with `strands.session.FileSessionManager` |
| `app/composition/tools.py`         | `from tools.communication.search_discord import ...`                                  | `from draftly.tools.discord.search_messages`              |
| `app/composition/tools.py`         | `from tools.delivery.create_commit import ...`                                        | `from draftly.tools.github.create_commit`                 |
| `app/composition/tools.py`         | `tools.documentation.analyze_impact`                                                  | `draftly.tools.documentation.structure`                   |

`main.py` imports `from src.draftly.app.api.app import app`, so the canonical
import prefix is `draftly.*`.

### 0.2 Verified Strands SDK facts (strands-agents 1.52.0)

- **Graph**: `strands.multiagent.GraphBuilder` — `add_node`, `add_edge(condition=)`,
  `set_entry_point`, `set_max_node_executions`, `set_execution_timeout`,
  `set_node_timeout`, `set_graph_id`, `set_session_manager`, `set_hook_providers`,
  `reset_on_revisit`, `build`. Returns a `Graph` callable.
- **Swarm**: `strands.multiagent.Swarm` — `entry_point`, `max_handoffs`,
  `max_iterations`, `execution_timeout`, `node_timeout`,
  `repetitive_handoff_detection_window`, `repetitive_handoff_min_unique_agents`.
- **Status**: `strands.multiagent.base.Status` — `COMPLETED`, `FAILED`, `INTERRUPTED`.
- **Custom nodes**: subclass `MultiAgentBase`, implement
  `invoke_async(self, task, invocation_state=None, **kwargs) -> MultiAgentResult`.
  Wrap payloads in `AgentResult` (see build guide §4.4).
- **Conditions**: plain `Callable[[GraphState], bool]` or `EdgeConditionWithContext`
  protocol (accepts `invocation_state=`). **Must be defensive** — session persistence
  re-evaluates all conditions at any time.
- **Interrupts**: `BeforeNodeCallEvent.interrupt(name, reason=...)` halts graph with
  `Status.INTERRUPTED`. Resume with `[{"interruptResponse": {"interruptId": ..., "response": ...}}]`.
  Use `result.interrupts[i].id` (instance UUID), NOT the interrupt name.
- **Sessions**: `strands.session.FileSessionManager`, `RepositorySessionManager`,
  `S3SessionManager`. Session manager restores interrupted state on graph construction.
- **Agent model**: `Agent(model=...)` accepts `Model | str | ModelRouter`.
- **Skills**: `Skill.from_directory()` / `AgentSkills` plugin; `SKILL.md` + YAML
  frontmatter; progressive disclosure.
- **Vended tools**: `strands.vended_tools` — `make_file_editor`, `make_http_request`,
  `make_shell`, `make_sleep`.
- **Hooks**: `Before/AfterNodeCallEvent`, `Before/AfterToolCallEvent`,
  `Before/AfterModelCallEvent`, `AfterInvocationEvent`, `MultiAgentHandoffEvent`,
  `HookProvider` / `HookRegistry.add_callback(event_type, cb)`.

---

## 1. Architecture summary

One documentation-intelligence engine with three event surfaces, each a Strands
Graph converging on shared primitives:

```
ingest → classify → context → research (Swarm) → impact → generate/retrieve
       → evaluate (loop back on FAIL) → human review (interrupt) → deliver
```

- **Graph = governance** (deterministic stages, conditional routing, review gates).
- **Swarm = exploration** (research sub-agents handing off autonomously).
- **State** maps across four homes: task string (normalized event), `state.results`
  (node outputs), `invocation_state` (runtime context, DB handles, config),
  NeonDB/Postgres (cross-run: memory, gaps, approvals, audit).
- Two cross-cutting systems: feedback loop (support questions → `DocumentationGap`)
  and observability/audit (hooks → `agent_runs`/`agent_steps`).

### 1.1 Surface routing

| Surface                                            | Signal               | Graph entry                                      | Delivery                        |
| -------------------------------------------------- | -------------------- | ------------------------------------------------ | ------------------------------- |
| GitHub PR (`pull_request.opened` / `.synchronize`) | software changed     | PR workflow → `update`/`create`                  | Open a docs PR                  |
| GitHub Issue                                       | developer struggling | Issue workflow → `answer` (or `update`/`create`) | Reply on the issue              |
| Slack / Discord question                           | developer confused   | Support workflow → `answer`                      | Reply in thread + feedback loop |

---

## 2. Phase 0 — Reconcile packaging, dependencies, and composition

**Goal:** the whole package imports cleanly under `draftly.*` before any domain
code is written.

### 2.1 Normalize imports to `draftly.*`

Every bare import in the implemented layer must be rewritten:

| Source file                        | Old import                                                         | New import                                                                      |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `app/composition/agents.py`        | `from agents.draftly_agent import ...`                             | `from draftly.agents.draftly_agent import ...`                                  |
| `app/composition/agents.py`        | `from agents.subagents import ...`                                 | `from draftly.agents.subagents import ...`                                      |
| `app/composition/agents.py`        | `from models import ...`                                           | `from draftly.models import ...`                                                |
| `app/composition/workflows.py`     | `from workflows.run_pull_request_workflow import ...`              | `from draftly.workflows.documentation.github_pr_workflow import ...`            |
| `app/composition/workflows.py`     | `from workflows.scheduled.run_review_expiry import ...`            | `from draftly.workflows.scheduled import ...` (create `workflows/scheduled.py`) |
| `app/pipelines/github_pipeline.py` | `from workflows.result import WorkflowResult`                      | **Delete file** — replaced by runner (§7.4)                                     |
| `app/pipelines/github_pipeline.py` | `from workflows.context import WorkflowContext`                    | _(deleted with file)_                                                           |
| `app/composition/workers.py`       | `from workflows.context import WorkflowContext`                    | `from draftly.workflows.context import WorkflowContext`                         |
| `app/composition/workers.py`       | `from integrations.scheduler.client import SchedulerClient`        | Remove; use `draftly.app.workers.task_runner`                                   |
| `app/api/routes/github.py`         | `from events.github_events import GitHubEventProcessor`            | `from draftly.events.github.pull_request import PullRequestProcessor`           |
| `app/composition/tools.py`         | `from tools.communication.search_discord import ...`               | `from draftly.tools.discord.search_messages import ...`                         |
| `app/composition/tools.py`         | `from tools.delivery.create_commit import ...`                     | `from draftly.tools.github.create_commit import ...`                            |
| `app/composition/tools.py`         | `tools.documentation.analyze_impact`                               | `draftly.tools.documentation.structure`                                         |
| `app/lifecycle.py`                 | `from langgraph.checkpoint_postgres.aio import AsyncPostgresSaver` | Delete; replace with `strands.session.FileSessionManager`                       |

### 2.2 Remove the LangGraph surface

- Delete the guarded `langgraph.checkpoint_postgres` import in `app/lifecycle.py`.
- In `app/composition/agents.py`, drop `checkpointer`, `interrupt_on`, and
  `AsyncPostgresSaver` parameters; replace with a Strands `SessionManager`
  (implemented in Phase 4).
- The `DraftlyApplication` dataclass in `app/lifecycle.py` loses its `checkpointer`
  field; gain a `session_manager` field.

### 2.3 Fix the model layer

The current `models/providers/base.py` returns `langchain_core.BaseChatModel`,
but langchain-core is not in `uv.lock`. Rewrite to return Strands `Model` instances:

```python
# models/providers/base.py (new version)
from abc import ABC, abstractmethod
from typing import Any

from strands.models.model import Model

from ..config import ModelConfig, ProviderConfig


class ModelProvider(ABC):
    """Provider abstraction used by Draftly's model registry."""

    def __init__(self, provider_config: ProviderConfig) -> None:
        self.config = provider_config

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider identifier."""

    @abstractmethod
    def create_model(self, config: ModelConfig) -> Model:
        """Create a Strands-compatible chat model."""

    def is_enabled(self) -> bool:
        return self.config.enabled

    def metadata(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "enabled": self.config.enabled,
            "priority": self.config.priority,
        }
```

Each provider (`openrouter.py`, `nvidia.py`, `orcarouter.py`, `requesty.py`) becomes
a thin factory returning `Model` objects built from `ModelConfig` (model name, API
key, base URL, default params).

### 2.4 Create missing route modules

`app/api/app.py` imports `documentation`, `evaluations`, and `support` route
modules that do not exist. Create stubs:

- `app/api/routes/documentation.py` — dashboard/list endpoints over documentation
  repositories (Phase 7 fills these).
- `app/api/routes/evaluations.py` — evaluation run endpoints.
- `app/api/routes/support.py` — support question list/detail endpoints.

### 2.5 Config extensions

Extend `app/config.py` and `config/*.yaml` with:

```python
class StrandsConfig(BaseModel):
    graph_id: str = "draftly-main-graph"
    session_storage_dir: str = ".draftly/sessions"
    max_node_executions: int = 10
    execution_timeout: int = 600
    node_timeout: int = 180
    review_policy: str = "always"  # "always" | "risky" | "never"
```

### 2.6 Add missing `__init__.py` files

28 subdirectories under `src/draftly/` lack `__init__.py`. Without them, no
`from draftly.*` import works. Run:

```bash
find src/draftly -type d -not -path '*/__pycache__*' -exec sh -c 'test ! -f "$1/__init__.py" && touch "$1/__init__.py"' _ {} \;
```

Verify the count matches expectations (~28 new files).

### 2.7 Replace CockroachDB with NeonDB

The DB layer (`integrations/cockroachdb/` + 22 migrations + `persistence/repositories/`)
is implemented and almost entirely standard Postgres — asyncpg, `gen_random_uuid()`,
`ON CONFLICT`, JSONB. Only three things are CockroachDB-specific; swap them for Neon:

**a. Vector search → pgvector** (the only real SQL work)

- `CREATE EXTENSION IF NOT EXISTS vector;` must run first (pgvector is preinstalled
  on Neon; the extension is enabled per-database).
- `migrations/003_memory_embeddings.sql` + `migrations/015_embeddings.sql`:
  - `VECTOR(1536)` / `VECTOR(3072)` → `vector(1536)` / `vector(3072)`
  - `CREATE VECTOR INDEX ... (embedding vector_cosine_ops)` →
    `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`
- Query side is unchanged: the `<=>` cosine operator, `$n::VECTOR` casts, and the
  `[1.0,2.0,...]` literal from `_format_vector()` are identical in pgvector
  (`integrations/cockroachdb/vector_search.py`, `memory_store.py` INSERTs).

**b. `STRING` → `TEXT` in all 22 migrations**

`STRING` is a CockroachDB-only alias; Postgres rejects it. `INT8`, `TIMESTAMPTZ`,
`now()`, `gen_random_uuid()` are valid Postgres and stay:

```bash
cd src/draftly/persistence/migrations && sed -i '' 's/ STRING/ TEXT/g' *.sql
```

**c. Client, class name, config, isolation**

- Rename class `CockroachDBClient` → `DatabaseClient` (`client.py`; type hints in
  the 12 `integrations/cockroachdb/*_store.py` files follow).
- Change the `transaction()` default `isolation` from `"serializable"` to
  `"read_committed"` — Postgres SSI aborts more readily than Cockroach's optimistic
  serializable, and the repositories have no 40001 retry handling.
- `app/config.py` — add `NEON_DATABASE_URL` to the `AliasChoices("COCKROACHDB_URL",
"DATABASE_URL")` of `database_url` (keep old aliases as fallbacks).
- `integrations/database/client.py` — extend env resolution to
  `os.environ.get("NEON_DATABASE_URL") or os.environ.get("COCKROACHDB_URL")
or os.environ["DATABASE_URL"]` so `DatabaseClient()` picks up Neon without
  an explicit URL.

**d. Rename package → `integrations/database/`**

The module is no longer CockroachDB-specific:

```bash
git mv src/draftly/integrations/cockroachdb src/draftly/integrations/database
grep -rl "integrations\.cockroachdb" src/draftly --include="*.py" | xargs sed -i '' 's/integrations\.cockroachdb/integrations.database/g'
```

(~25 import sites across `app/`, `persistence/repositories/`, `tools/search/`.)

**e. Neon connection notes**

- Use the **direct** Neon connection string — the pooled (PgBouncer-style
  transaction) endpoint rejects prepared statements, and asyncpg prepares by
  default. If the pooled endpoint is required, create the pool with
  `statement_cache_size=0` and `prepared_statement_cache_size=0`.
- Migrations have no runner in the repo — apply per database via
  `neonctl database create draftly` + `psql "$NEON_DATABASE_URL" -f migrations/00X_*.sql`,
  or add a tiny `scripts/migrate.py` in Phase 7. Neon branches give a per-PR
  preview database for free.
- Free-tier autosuspend: the first query after idle wakes the compute (a
  few-second latency spike); harmless for this workload.

**f. Verification**

```bash
# With a real Neon URL:
uv run python - <<'PY'
import asyncio
from draftly.integrations.database.client import DatabaseClient

async def main() -> None:
    client = DatabaseClient("NEON_DATABASE_URL")
    await client.start()
    print(await client.fetch_one("SELECT version()"))
    await client.close()

asyncio.run(main())
PY
```

Offline, `FakeDatabase` (§11.3) covers repository/memory tests without a live DB.

### 2.8 Verification

```bash
uv run python -c "from draftly.app.api.app import app; print('OK')"
uv run ruff check src/draftly
```

---

## 3. Phase 1 — Strands core primitives (`orchestration/`)

**Files**: `orchestration/state/{documentation,issue,support,feedback}.py`,
`orchestration/routing/conditions.py`, `orchestration/nodes/{base,evaluate}.py`.

> **Stub decision — `orchestration/nodes/{analyze,generate,research,retrieve,
respond,review,publish}.py`** (7 more 0-byte stubs): **delete them.** Their
> roles are covered by real agents (research swarm, impact agent, writer,
> answer agent, delivery agent) and hooks (ReviewGate). Keeping empty files
> invites dead imports. If a deterministic, LLM-free variant is needed later
> for tests, re-add it as a `MultiAgentBase` node like `EvaluatorNode`.

### 3.1 State dataclasses

`orchestration/state/documentation.py` — the task JSON schema for PR workflows:

```python
from pydantic import BaseModel

class PullRequestEvent(BaseModel):
    event_id: str
    event_type: str  # "pull_request.opened" | "pull_request.synchronize"
    project_id: str
    repository: str
    actor: str
    pull_request: dict  # {number, sha, title, body, changed_files, ...}

class IssueEvent(BaseModel):
    event_id: str
    event_type: str  # "issues.opened" | "issues.reopened"
    project_id: str
    repository: str
    actor: str
    issue: dict  # {number, title, body, labels, ...}

class SupportEvent(BaseModel):
    event_id: str
    event_type: str  # "slack.message" | "discord.message"
    project_id: str
    source: str  # "slack" | "discord"
    source_message_id: str
    repository: str | None
    question: str
```

`orchestration/state/feedback.py` — feedback loop state:

```python
class FeedbackEvent(BaseModel):
    event_id: str
    project_id: str
    source: str
    source_message_id: str
    normalized_question: str
    answer_status: str  # "answered" | "unanswered" | "partial"
```

### 3.2 Conditions (all defensive)

`orchestration/routing/conditions.py`:

```python
from strands.multiagent.graph import GraphState
from strands.multiagent.base import Status

from draftly.orchestration.nodes.base import node_data


def is_valid_surface(state: GraphState) -> bool:
    """Surface guard: verify the task's event_type maps to a recognized surface.

    Surface is known from the normalized event (task JSON), NOT the classifier
    output — the classifier is an LLM agent whose result format is not
    guaranteed JSON. The event_type is authoritative.
    """
    if not isinstance(state.task, str):
        return False
    import json
    try:
        task_data = json.loads(state.task)
    except json.JSONDecodeError:
        return False
    return task_data.get("event_type", "").split(".")[0] in (
        "pull_request", "issues", "slack", "discord",
    )


def route_to_answer(state: GraphState) -> bool:
    """Impact found that no docs update needed (support/issue surface)."""
    if "impact" not in state.results:
        return False
    data = node_data(state, "impact")
    return data.get("action") == "answer"


def route_to_update(state: GraphState) -> bool:
    """Docs exist but need updating."""
    if "impact" not in state.results:
        return False
    data = node_data(state, "impact")
    return data.get("action") == "update"


def route_to_create(state: GraphState) -> bool:
    """Docs are missing entirely."""
    if "impact" not in state.results:
        return False
    data = node_data(state, "impact")
    return data.get("action") == "create"


def generated(state: GraphState) -> bool:
    """Any of answer/update/create has produced output."""
    return any(nid in state.results for nid in ("answer", "update", "create"))


def needs_revision(state: GraphState) -> bool:
    """Evaluate ran and the output did not pass."""
    if "evaluate" not in state.results:
        return False
    return not node_data(state, "evaluate")["passed"]


def eval_passed(state: GraphState) -> bool:
    """Evaluate ran and the output passed."""
    if "evaluate" not in state.results:
        return False
    return node_data(state, "evaluate")["passed"]


def all_dependencies_complete(required: list[str]):
    """AND-semantics factory: fire only when every listed node completed."""
    def check(state: GraphState) -> bool:
        return all(
            nid in state.results and state.results[nid].status == Status.COMPLETED
            for nid in required
        )
    return check
```

### 3.3 Node helpers

`orchestration/nodes/base.py`:

```python
import json
from strands.agent.agent_result import AgentResult
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status
from strands.telemetry.metrics import EventLoopMetrics
from strands.types.content import ContentBlock, Message


def agent_result(data: dict) -> AgentResult:
    """Wrap structured data so downstream nodes/conditions can parse it."""
    return AgentResult(
        stop_reason="end_turn",
        message=Message(
            content=[ContentBlock(text=json.dumps(data))], role="assistant"
        ),
        metrics=EventLoopMetrics(),
        state=None,
    )


def node_data(state, node_id: str) -> dict:
    """Read a node's structured payload from graph state.

    Two shapes (verified against strands/multiagent/graph.py `_execute_node`):

    1. Custom MultiAgentBase nodes: the graph stores the returned
       MultiAgentResult at state.results[node_id].result; our AgentResult (JSON
       in message text) lives one level deeper, keyed by the node's own name.
    2. LLM Agent nodes with structured_output_model: the graph stores the
       AgentResult DIRECTLY at state.results[node_id].result; the parsed model
       is on `.structured_output` (NOT in message content — str(AgentResult)
       returns structured_output.model_dump_json()).
    """
    node_result = state.results[node_id].result
    if isinstance(node_result, MultiAgentResult):
        node_result = node_result.results[node_id].result
    structured = getattr(node_result, "structured_output", None)
    if structured is not None:
        return structured.model_dump()
    block = node_result.message["content"][0]  # Message is a TypedDict
    return json.loads(block["text"])


def parse_node_input(task) -> dict[str, dict]:
    """Parse the graph's node input into per-dependency structured payloads.

    IMPORTANT (verified against strands/multiagent/graph.py `_build_node_input`):
    the graph does NOT pass the raw task string to nodes with satisfied
    dependencies. It builds a `list[ContentBlock]` formatted as:

        Original Task: <task>
        Inputs from previous nodes:
        From <dep_id>:
          - <agent_name>: <str(AgentResult)>

    `str(AgentResult)` is the message text — for custom nodes that is the JSON
    we wrapped via `agent_result()`. So:
      - a node WITHOUT dependencies receives the raw task string,
      - a node WITH dependencies receives the ContentBlock list and must parse
        the "From <dep_id>:" sections.

    Returns {dep_id: parsed_json_dict} for every dependency present.
    """
    blocks = task if isinstance(task, list) else []
    text = "\n".join(b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "") for b in blocks)
    result: dict[str, dict] = {}
    current_dep: str | None = None
    for line in text.splitlines():
        if line.startswith("From "):
            current_dep = line[len("From "):].strip()
            continue
        if current_dep and line.startswith("  - "):
            payload = line[len("  - "):].strip()
            if payload.startswith("{"):
                import json as _json
                try:
                    result[current_dep] = _json.loads(payload.split(": ", 1)[1] if ": " in payload else payload)
                except _json.JSONDecodeError:
                    pass
            current_dep = None
    return result
```

### 3.4 EvaluatorNode

`orchestration/nodes/evaluate.py`:

```python
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status

from draftly.orchestration.nodes.base import agent_result


def compute_quality(evidence: list[dict], draft: str) -> tuple[float, list[str]]:
    """Deterministic quality scoring: citation coverage, completeness, grounding."""
    reasons = []
    score = 0.0

    # Citation coverage: does the draft reference available evidence?
    cited = sum(1 for e in evidence if e.get("id", "") in draft)
    coverage = cited / max(len(evidence), 1)
    score += coverage * 0.4
    if coverage > 0.8:
        reasons.append(f"Grounded in {cited}/{len(evidence)} sources")

    # Completeness: does the draft cover the key topics?
    topics = [e.get("topic", "") for e in evidence if e.get("topic")]
    covered = sum(1 for t in topics if t.lower() in draft.lower())
    completeness = covered / max(len(topics), 1)
    score += completeness * 0.3
    if completeness > 0.7:
        reasons.append(f"Covers {covered}/{len(topics)} key topics")

    # Length heuristic: very short drafts are usually incomplete
    length_score = min(len(draft) / 500, 1.0)
    score += length_score * 0.3
    if length_score > 0.5:
        reasons.append("Adequate detail level")

    return score, reasons


class EvaluatorNode(MultiAgentBase):
    """Deterministic quality gate: grounding, completeness, source coverage."""

    def __init__(self, name: str = "evaluate", max_iterations: int = 3):
        self.name = name
        self.iteration = 0
        self.max_iterations = max_iterations

    async def invoke_async(self, task, invocation_state=None, **kwargs) -> MultiAgentResult:
        self.iteration += 1

        # Parse dependency outputs from the graph's ContentBlock input.
        # The graph feeds prior node results as a list[ContentBlock] with
        # "From <dep_id>:" sections — the draft comes from whichever of
        # answer/update/create ran; evidence comes from research.
        # NOTE: the research swarm's final message may be plain text, not JSON;
        # parse_node_input skips non-JSON payloads, so evidence degrades to []
        # and scoring falls back to length + iteration caps. Safe by design.
        from draftly.orchestration.nodes.base import parse_node_input

        deps = parse_node_input(task)
        draft = ""
        for dep_id in ("answer", "update", "create"):
            if dep_id in deps:
                draft = deps[dep_id].get("draft", deps[dep_id].get("content", ""))
        evidence = deps.get("research", {}).get("evidence", [])

        score, reasons = compute_quality(evidence, draft)
        passed = score >= 0.7 or self.iteration >= self.max_iterations

        if not reasons:
            reasons.append(f"Score {score:.2f} (threshold: 0.70)")

        return MultiAgentResult(
            status=Status.COMPLETED,
            results={self.name: NodeResult(result=agent_result({
                "passed": passed,
                "score": score,
                "reasons": reasons,
                "iteration": self.iteration,
            }))},
        )
```

### 3.5 Verification

Tests in `tests/conditions/` and `tests/evaluation/`:

- Conditions: simulate `GraphState` with/without results; verify presence-guard behavior.
- `node_data`: round-trip a dict through `agent_result()` → `node_data()`.
- `parse_node_input`: feed a simulated ContentBlock list (matching the graph's
  "From <dep_id>:" format) and verify per-dependency dict extraction; verify the
  raw-string form returns `{}`.
- `EvaluatorNode`: invoke with ContentBlock input carrying evidence+draft, verify
  `{passed, score, reasons}` shape.

---

## 4. Phase 2 — Tools (`tools/`)

Each tool is a `@tool`-decorated async function wrapping an integration client.
The integration clients (`integrations/github/client.py`, `integrations/slack/client.py`,
etc.) are already implemented and need no changes.

### 4.1 GitHub tools (`tools/github/`)

| File                     | Tool                                                        | Wraps                                                      |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `get_pull_request.py`    | `get_pull_request(owner, repo, number)`                     | `integrations.github.client.GitHubClient.get_pull_request` |
| `get_diff.py`            | `get_diff(owner, repo, number)`                             | `GitHubClient.get_pull_request_diff`                       |
| `get_files.py`           | `get_files(owner, repo, number)`                            | `GitHubClient.get_pull_request_files`                      |
| `get_issue.py`           | `get_issue(owner, repo, number)`                            | `GitHubClient.get_issue`                                   |
| `create_branch.py`       | `create_branch(owner, repo, name, base_sha)`                | `GitHubClient.create_ref`                                  |
| `create_commit.py`       | `create_commit(owner, repo, branch, message, files)`        | `GitHubClient.create_commit_and_tree`                      |
| `create_pull_request.py` | `create_pull_request(owner, repo, title, body, head, base)` | `GitHubClient.create_pull_request`                         |
| `create_comment.py`      | `create_comment(owner, repo, number, body)`                 | `GitHubClient.create_comment`                              |

Pattern for each:

```python
from strands import tool

@tool
async def get_pull_request(owner: str, repo: str, number: int) -> dict:
    """Fetch a GitHub pull request by number."""
    from draftly.integrations.github.client import GitHubClient
    client = GitHubClient()
    return await client.get_pull_request(owner, repo, number)
```

### 4.2 Documentation tools (`tools/documentation/`)

| File             | Tool                                                           | Purpose                           |
| ---------------- | -------------------------------------------------------------- | --------------------------------- |
| `markdown.py`    | `read_markdown(path)`, `write_markdown(path, content)`         | Read/write markdown files in repo |
| `frontmatter.py` | `parse_frontmatter(content)`, `render_frontmatter(meta, body)` | YAML frontmatter parsing          |
| `links.py`       | `validate_links(content, base_url)`                            | Check internal/external links     |
| `structure.py`   | `analyze_documentation_structure(repo_path)`                   | Map docs tree, identify gaps      |

### 4.3 Search tools (`tools/search/`)

| File                 | Tool                           | Wraps                                       |
| -------------------- | ------------------------------ | ------------------------------------------- |
| `semantic_search.py` | `semantic_search(query, k=10)` | `integrations.database.vector_search`       |
| `keyword_search.py`  | `keyword_search(query, k=10)`  | `integrations.database.vector_search` (FTS) |
| `hybrid_search.py`   | `hybrid_search(query, k=10)`   | Combines semantic + keyword                 |

### 4.4 Communication tools (`tools/slack/`, `tools/discord/`)

| File                         | Tool                                                | Wraps                                                    |
| ---------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `slack/post_message.py`      | `post_message(channel, text, thread_ts=None)`       | `integrations.slack.client.SlackClient.post_message`     |
| `slack/search_messages.py`   | `search_messages(query, channel=None)`              | `SlackClient.search_messages`                            |
| `slack/get_thread.py`        | `get_thread(channel, ts)`                           | `SlackClient.get_conversation_thread`                    |
| `discord/post_message.py`    | `post_message(channel_id, content, thread_id=None)` | `integrations.discord.client.DiscordClient.send_message` |
| `discord/search_messages.py` | `search_messages(query, channel_id=None)`           | `DiscordClient.search_messages`                          |
| `discord/get_thread.py`      | `get_thread(channel_id, thread_id)`                 | `DiscordClient.get_thread`                               |

### 4.5 Repository tools (`tools/repository/`)

| File             | Tool                                       | Purpose                      |
| ---------------- | ------------------------------------------ | ---------------------------- |
| `filesystem.py`  | `read_file(path)`, `list_files(directory)` | Read repo files (git-aware)  |
| `git.py`         | `git_log(path, max_count=10)`              | Recent commit history        |
| `code_search.py` | `search_code(pattern, path=None)`          | Regex search across codebase |

### 4.6 Tool registry

`app/composition/tools.py` — rewritten to import from `draftly.tools.*`:

```python
from dataclasses import dataclass
from draftly.tools.github import (
    get_pull_request, get_diff, get_files, get_issue,
    create_branch, create_commit, create_pull_request, create_comment,
)
from draftly.tools.documentation import (
    read_markdown, write_markdown, parse_frontmatter,
    render_frontmatter, validate_links, analyze_documentation_structure,
)
from draftly.tools.search import semantic_search, keyword_search, hybrid_search
from draftly.tools.slack import post_message as slack_post, search_messages as slack_search, get_thread as slack_thread
from draftly.tools.discord import post_message as discord_post, search_messages as discord_search, get_thread as discord_thread
from draftly.tools.repository import read_file, list_files, git_log, search_code


@dataclass
class ToolRegistry:
    # GitHub
    get_pull_request: object = get_pull_request
    get_diff: object = get_diff
    get_files: object = get_files
    get_issue: object = get_issue
    create_branch: object = create_branch
    create_commit: object = create_commit
    create_pull_request: object = create_pull_request
    create_comment: object = create_comment
    # Documentation
    read_markdown: object = read_markdown
    write_markdown: object = write_markdown
    # Search
    semantic_search: object = semantic_search
    keyword_search: object = keyword_search
    hybrid_search: object = hybrid_search
    # Slack
    slack_post: object = slack_post
    slack_search: object = slack_search
    slack_thread: object = slack_thread
    # Discord
    discord_post: object = discord_post
    discord_search: object = discord_search
    discord_thread: object = discord_thread
    # Repository
    read_file: object = read_file
    search_code: object = search_code

    def all_tools(self) -> list:
        return [getattr(self, f) for f in dir(self) if not f.startswith("_")]

    def github_tools(self) -> list:
        return [
            self.get_pull_request, self.get_diff, self.get_files, self.get_issue,
            self.create_branch, self.create_commit, self.create_pull_request, self.create_comment,
        ]

    def research_tools(self) -> list:
        return [
            self.get_pull_request, self.get_diff, self.get_files, self.get_issue,
            self.slack_search, self.slack_thread,
            self.discord_search, self.discord_thread,
            self.semantic_search, self.keyword_search, self.hybrid_search,
            self.search_code,
        ]

    def documentation_tools(self) -> list:
        return [
            self.read_markdown, self.write_markdown,
            self.semantic_search, self.keyword_search,
            self.search_code,
        ]

    def delivery_tools(self) -> list:
        return [
            self.create_branch, self.create_commit, self.create_pull_request,
            self.slack_post, self.discord_post,
        ]
```

### 4.7 Verification

Tool unit tests with in-memory fakes for integration clients; verify `tool()` schemas render correctly.

---

## 5. Phase 3 — Agents (`agents/`) and skills (`skills/`)

### 5.1 Agent inventory

All agents are plain `Agent` instances: `Agent(name=..., system_prompt=..., tools=[...], model=<handle>)`.

#### Shared agents (`agents/shared/`)

> **NEW files**: the scaffold's `agents/shared/` contains only `deepeval.py`,
> `github_delivery.py`, `memory_curator.py`, `research.py` (all stubs).
> `classifier.py`, `context_agent.py`, and `delivery_agent.py` do NOT exist —
> create them as new files.

| File                          | Agent                                                                                                                                                    | Tools                                 | Output                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| `classifier.py` **(NEW)**     | `classifier = Agent(name="event_classifier", structured_output_model=EventClassification, ...)`                                                          | none                                  | `EventClassification` pydantic |
| `context_agent.py` **(NEW)**  | `context_agent = Agent(name="context_agent", ...)`                                                                                                       | search, GitHub, Slack/Discord         | evidence bundle JSON           |
| `delivery_agent.py` **(NEW)** | `delivery_agent = Agent(name="delivery", ...)`                                                                                                           | create_branch/commit/PR, post_message | delivery receipt               |
| `github_delivery.py`          | `github_delivery_agent = Agent(name="github_delivery", ...)`                                                                                             | GitHub PR tools                       | PR URL                         |
| `memory_curator.py`           | `memory_curator = Agent(name="memory_curator", ...)`                                                                                                     | semantic_search, write                | curated knowledge              |
| ~~`deepeval.py`~~             | **Delete** — evaluation moved out of the agent graph into the Strands Evals `Experiment` (§8.10); the in-graph gate is the deterministic `EvaluatorNode` | —                                     | —                              |
| `research.py`                 | Research swarm builder (see subagents.py)                                                                                                                | per-channel                           | evidence summary               |

#### Subagents (`agents/subagents.py`)

```python
from strands import Agent
from strands.multiagent import Swarm


def build_research_swarm(
    github_tools, slack_tools, discord_tools, docs_tools,
) -> Swarm:
    """4-agent Swarm for cross-channel evidence gathering."""
    github_researcher = Agent(
        name="github_researcher",
        system_prompt="Research GitHub issues, PRs, and release history for evidence.",
        tools=github_tools,
    )
    slack_researcher = Agent(
        name="slack_researcher",
        system_prompt="Search Slack history for related conversations and answers.",
        tools=slack_tools,
    )
    discord_researcher = Agent(
        name="discord_researcher",
        system_prompt="Search Discord history for related conversations and answers.",
        tools=discord_tools,
    )
    docs_researcher = Agent(
        name="docs_researcher",
        system_prompt="Search the documentation store and report coverage.",
        tools=docs_tools,
    )

    return Swarm(
        [github_researcher, slack_researcher, discord_researcher, docs_researcher],
        entry_point=github_researcher,
        max_handoffs=20,
        max_iterations=20,
        execution_timeout=900.0,
        node_timeout=300.0,
        repetitive_handoff_detection_window=8,
        repetitive_handoff_min_unique_agents=3,
    )
```

#### Documentation agents (`agents/documentation/`)

| File            | Agent            | Tools                                            |
| --------------- | ---------------- | ------------------------------------------------ |
| `analyzer.py`   | `impact_agent`   | doc search, code search, get_diff, get_files     |
| `researcher.py` | `doc_researcher` | semantic_search, keyword_search, read_file       |
| `writer.py`     | `writer_agent`   | read_markdown, write_markdown, frontmatter tools |
| `reviewer.py`   | `doc_reviewer`   | validate_links, analyze_structure                |
| `auditor.py`    | `doc_auditor`    | all documentation tools                          |

#### Support agents (`agents/support/`)

| File                     | Agent                 | Tools                               |
| ------------------------ | --------------------- | ----------------------------------- |
| `question_analyzer.py`   | `question_analyzer`   | semantic_search (memory)            |
| `solution_researcher.py` | `solution_researcher` | search tools, GitHub, Slack/Discord |
| `answer_writer.py`       | `answer_agent`        | semantic_search, write              |
| `support_reviewer.py`    | `support_reviewer`    | validate_links                      |

#### GitHub agents (`agents/github/`)

| File                  | Agent              | Tools                                     |
| --------------------- | ------------------ | ----------------------------------------- |
| `issue_analyzer.py`   | `issue_analyzer`   | get_issue, search_code                    |
| `issue_researcher.py` | `issue_researcher` | get_issue, get_pull_request, search tools |
| `issue_responder.py`  | `issue_responder`  | create_comment                            |

#### Root agent (`agents/draftly_agent.py`)

```python
from strands import Agent

def create_draftly_agent(model, tools=None, skills_dir=None):
    """Root Draftly agent that delegates to sub-graphs."""
    system_prompt = (
        "You are Draftly, a documentation intelligence system. "
        "Classify incoming events, research context, and generate or update documentation."
    )
    return Agent(
        name="draftly",
        model=model,
        system_prompt=system_prompt,
        tools=tools or [],
    )
```

#### Schemas (`agents/schemas.py`)

```python
from pydantic import BaseModel

class EventClassification(BaseModel):
    surface: str  # "pull_request" | "issue" | "support_question"
    change_type: str  # "documentation_only" | "bug_fix" | "new_feature" | "api_change" | "breaking_change" | "deprecation"
    urgency: str  # "low" | "medium" | "high"
    reason: str

class EvidenceItem(BaseModel):
    id: str
    source: str  # "github" | "slack" | "discord" | "docs" | "memory"
    topic: str
    content: str
    url: str | None = None

class DocumentationImpact(BaseModel):
    action: str  # "answer" | "update" | "create" | "none"
    affected_files: list[str]
    evidence: list[EvidenceItem]

class QualityScore(BaseModel):
    passed: bool
    score: float
    reasons: list[str]
    iteration: int

class DeliveryReceipt(BaseModel):
    status: str  # "delivered" | "failed" | "pending_review"
    target: str  # PR URL, issue comment URL, Slack message URL
    summary: str
```

### 5.2 Skills (20 SKILL.md files)

Each `skills/<topic>/SKILL.md` has YAML frontmatter + markdown instructions.
The 20 skills and their content:

| Skill                         | Purpose                             | Key instructions                                             |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `github-pr-analysis`          | Analyze PR diffs for doc impact     | Identify changed files, classify impact, extract key changes |
| `github-issue-analysis`       | Analyze issues for doc signals      | Read issue body/labels, determine if doc gap or bug          |
| `github-release-analysis`     | Analyze releases for doc updates    | Changelog parsing, breaking change detection                 |
| `repository-analysis`         | Map repo structure to docs          | Find docs dir, identify conventions, map code-to-docs        |
| `documentation-research`      | Research existing docs for gaps     | Search coverage, identify outdated content                   |
| `documentation-generation`    | Generate new docs from code         | Follow templates, maintain style guide                       |
| `documentation-update`        | Update existing docs for changes    | Backward compatibility, change management                    |
| `documentation-audit`         | Audit docs for quality/completeness | Freshness, consistency, completeness rules                   |
| `documentation-evaluation`    | Evaluate generated doc quality      | Groundedness, completeness, factuality                       |
| `evaluation-failure-analysis` | Analyze evaluation failures         | Failure taxonomy, remediation rules                          |
| `github-delivery`             | Deliver docs via GitHub PR          | Branch policy, commit conventions, PR template               |
| `memory-retrieval`            | Retrieve relevant memory            | Semantic search, relevance scoring                           |
| `memory-curation`             | Curate and consolidate memory       | Conflict resolution, quality scoring                         |
| `support-triage`              | Triage support questions            | Confidence, severity, escalation rules                       |
| `support-answering`           | Answer support questions            | Citation policy, uncertainty handling                        |
| `support-evaluation`          | Evaluate support answers            | Answer quality, groundedness                                 |
| `support-delivery`            | Deliver support answers             | Platform-specific response policies                          |
| `support-feedback-analysis`   | Analyze support for doc gaps        | Signal weighting, recurring problem detection                |
| `documentation-feedback-loop` | Close the feedback loop             | Gap detection → doc generation pipeline                      |
| `documentation-gap-detection` | Detect documentation gaps           | Recurring questions, signal prioritization                   |

Each SKILL.md follows this structure:

```markdown
---
name: <skill-name>
description: <one-line description>
---

# <Skill Title>

<Instructions for the agent on how to perform this task.>

## Rules

<List of specific rules and constraints.>

## Output Format

<Expected output structure.>

## References

<Links to reference/ subdirectory files.>
```

Reference files in `skills/<topic>/references/` contain detailed rules.
Asset templates in `skills/<topic>/assets/` contain doc templates (for generation).

### 5.3 Context injection

`context/*.md` files (11 at `draftly-agent-backend/context/`) feed system prompts:

| File                      | Used by                           |
| ------------------------- | --------------------------------- |
| `documentation_policy.md` | Documentation agents, writer      |
| `human_review_policy.md`  | ReviewGate hook                   |
| `repository_rules.md`     | GitHub tools, repository analysis |
| `writing_style.md`        | Documentation writer, generator   |
| `security_rules.md`       | All agents (redaction, secrets)   |
| `evaluation_rules.md`     | EvaluatorNode, evaluation agents  |
| `support_policy.md`       | Support agents                    |
| `architecture.md`         | Context agent                     |
| `project_context.md`      | Context agent                     |
| `diagram_rules.md`        | Documentation generator           |

Load via a `ContextInjector` or build prompts with context content:

```python
def load_context(name: str) -> str:
    path = Path(__file__).parent.parent.parent / "context" / f"{name}.md"
    return path.read_text()
```

### 5.4 Verification

- Classifier: unit test with `StubModel` returning structured output.
- Swarm construction: verify 4 agents created, `max_handoffs=20`.
- Skills: `Skill.from_directory(skills_dir)` loads without error.

---

## 6. Phase 4 — Orchestration graphs, review gate, sessions

**Files**: `orchestration/graphs/{documentation,issue,support,feedback,evaluation}_graph.py`,
`orchestration/routing/policies.py`, `integrations/strands/{client,graph,models,tools}.py`.

### 6.1 Documentation graph (the core graph)

`orchestration/graphs/documentation_graph.py`:

```python
from strands.multiagent import GraphBuilder
from strands.hooks import BeforeNodeCallEvent

from draftly.orchestration.routing.conditions import (
    is_valid_surface, route_to_answer, route_to_update, route_to_create,
    generated, needs_revision, eval_passed,
)
from draftly.orchestration.nodes.evaluate import EvaluatorNode
from draftly.orchestration.hooks.review_gate import ReviewGate
from draftly.orchestration.hooks.audit import RunAuditLogger


def build_documentation_graph(session_manager, tools_registry, model, hooks=None):
    """Build the unified Draftly Graph for documentation workflows."""
    # Import agents
    from draftly.agents.shared.classifier import classifier
    from draftly.agents.shared.context_agent import context_agent
    from draftly.agents.shared.delivery_agent import delivery_agent
    from draftly.agents.documentation.analyzer import impact_agent
    from draftly.agents.documentation.writer import writer_agent
    from draftly.agents.support.answer_writer import answer_agent
    from draftly.agents.subagents import build_research_swarm

    # Build research swarm with scoped tools
    research_swarm = build_research_swarm(
        github_tools=tools_registry.github_tools(),
        slack_tools=[tools_registry.slack_search, tools_registry.slack_thread],
        discord_tools=[tools_registry.discord_search, tools_registry.discord_thread],
        docs_tools=[tools_registry.semantic_search, tools_registry.keyword_search, tools_registry.search_code],
    )

    builder = GraphBuilder()
    builder.set_graph_id("draftly-main-graph")

    # Intake / classification
    builder.add_node(classifier, "classify")
    builder.set_entry_point("classify")

    # Context
    builder.add_node(context_agent, "context")
    builder.add_edge("classify", "context", condition=is_valid_surface)

    # Research
    builder.add_node(research_swarm, "research")
    builder.add_edge("context", "research")

    # Impact analysis
    builder.add_node(impact_agent, "impact")
    builder.add_edge("research", "impact")

    # Generation fan-out
    builder.add_node(answer_agent, "answer")
    builder.add_node(writer_agent, "update")
    builder.add_node(writer_agent, "create")
    builder.add_edge("impact", "answer", condition=route_to_answer)
    builder.add_edge("impact", "update", condition=route_to_update)
    builder.add_edge("impact", "create", condition=route_to_create)

    # Evaluation
    evaluator = EvaluatorNode("evaluate")
    builder.add_node(evaluator, "evaluate")
    builder.add_edge("answer", "evaluate", condition=generated)
    builder.add_edge("update", "evaluate", condition=generated)
    builder.add_edge("create", "evaluate", condition=generated)

    # Revise loop
    builder.add_edge("evaluate", "update", condition=needs_revision)
    builder.add_edge("evaluate", "create", condition=needs_revision)

    # Delivery
    builder.add_node(delivery_agent, "deliver")
    builder.add_edge("evaluate", "deliver", condition=eval_passed)

    # Safety rails
    builder.set_max_node_executions(10)
    builder.set_execution_timeout(600)
    builder.set_node_timeout(180)
    builder.reset_on_revisit(True)

    # Session manager
    builder.set_session_manager(session_manager)

    # Build and attach hooks
    graph = builder.build()
    graph.add_hook(ReviewGate(), BeforeNodeCallEvent)
    if hooks:
        for hook in hooks:
            graph.add_hook(hook, BeforeNodeCallEvent)
    return graph
```

### 6.2 Issue graph

`orchestration/graphs/issue_graph.py` — same primitives, different agent set:
classify → context → research → impact → answer (or update/create if gap) → evaluate → review → deliver (reply on issue).

### 6.3 Support graph

`orchestration/graphs/support_graph.py` — ends in deliver (post reply in thread)
and records the question for the feedback loop.

### 6.4 Feedback graph

`orchestration/graphs/feedback_graph.py` — `summarize_clusters → detect_gaps →
prioritize → (enqueue documentation run if gaps found)`.

### 6.5 Evaluation graph

`orchestration/graphs/evaluation_graph.py` — build-time/CI harness over golden
datasets using the Strands Evals SDK (see §8.10): each dataset becomes a
`Case` list, and the graph schedules `Experiment.run_evaluations_async` runs.
When the graph executes, the evaluators are the `evaluation/evaluators/*`
wrappers from §8.2 — no DeepEval.

### 6.6 Review gate hook

`orchestration/hooks/review_gate.py`:

```python
from strands.hooks import BeforeNodeCallEvent, HookProvider, HookRegistry


class ReviewGate(HookProvider):
    """Pause before delivery; resume with approval or cancel with rejection."""

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.gate)

    def gate(self, event: BeforeNodeCallEvent) -> None:
        if event.node_id != "deliver":
            return

        policy = event.invocation_state.get("review_policy", "always")
        if policy == "never":
            return

        decision = event.interrupt("doc-review", reason={
            "run_id": event.invocation_state.get("run_id"),
            "summary": event.invocation_state.get("delivery_summary", ""),
            "evaluation": event.invocation_state.get("evaluation", {}),
            "evidence_count": event.invocation_state.get("evidence_count", 0),
        })

        if decision.get("approved") is not True:
            event.cancel_node = f"Rejected by reviewer: {decision.get('comment', '')}"
```

### 6.7 Audit logger hook

`orchestration/hooks/audit.py`:

```python
from strands.hooks import (
    BeforeNodeCallEvent, AfterNodeCallEvent, AfterToolCallEvent,
    AfterInvocationEvent, HookProvider, HookRegistry,
)


class RunAuditLogger(HookProvider):
    """Persist per-step telemetry and audit rows for a run."""

    def __init__(self, audit_repo=None):
        self.audit_repo = audit_repo

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.node_start)
        registry.add_callback(AfterNodeCallEvent, self.node_end)
        registry.add_callback(AfterToolCallEvent, self.tool_end)
        registry.add_callback(AfterInvocationEvent, self.run_end)

    def node_start(self, event: BeforeNodeCallEvent) -> None:
        run_id = event.invocation_state.get("run_id")
        if self.audit_repo and run_id:
            # INSERT INTO agent_steps (run_id, node_id, status='started', started_at)
            pass

    def node_end(self, event: AfterNodeCallEvent) -> None:
        run_id = event.invocation_state.get("run_id")
        if self.audit_repo and run_id:
            # UPDATE agent_steps SET status='completed', execution_time=..., tokens=...
            pass

    def tool_end(self, event: AfterToolCallEvent) -> None:
        run_id = event.invocation_state.get("run_id")
        if self.audit_repo and run_id:
            # INSERT INTO agent_steps (kind='tool', name=..., input=..., duration=...)
            pass

    def run_end(self, event: AfterInvocationEvent) -> None:
        run_id = event.invocation_state.get("run_id")
        if self.audit_repo and run_id:
            # UPDATE agent_runs SET status=..., duration=..., usage=...
            pass
```

### 6.8 Session manager

`integrations/strands/graph.py` — builds graphs per-run with session persistence:

```python
from pathlib import Path
from strands.session import FileSessionManager

from draftly.orchestration.graphs.documentation_graph import build_documentation_graph
from draftly.orchestration.graphs.issue_graph import build_issue_graph
from draftly.orchestration.graphs.support_graph import build_support_graph


def build_session_manager(run_id: str, storage_dir: str = ".draftly/sessions"):
    """Create a FileSessionManager for a specific run."""
    Path(storage_dir).mkdir(parents=True, exist_ok=True)
    return FileSessionManager(
        session_id=f"draftly-{run_id}",
        storage_dir=storage_dir,
    )


def build_graph_for_run(run_id, surface: str, tools_registry, model, hooks=None):
    """Build the graph for ONE surface, with its own session manager.

    IMPORTANT: build only the graph the run actually needs. Session state is
    keyed by session_id, so sharing one FileSessionManager across multiple
    graphs (as an earlier draft did) makes them clobber each other's
    persistence. One run = one session = one graph.
    """
    session_mgr = build_session_manager(run_id)

    if surface == "issue":
        return build_issue_graph(
            session_manager=session_mgr,
            tools_registry=tools_registry,
            model=model,
            hooks=hooks,
        )
    if surface == "support":
        return build_support_graph(
            session_manager=session_mgr,
            tools_registry=tools_registry,
            model=model,
            hooks=hooks,
        )
    # default: pull_request surface
    return build_documentation_graph(
        session_manager=session_mgr,
        tools_registry=tools_registry,
        model=model,
        hooks=hooks,
    )
```

### 6.9 Verification

Extend the previously-verified deterministic graph test:

1. Revise loop: invoke with task that triggers update → evaluate (FAIL) → update → evaluate (PASS).
2. Interrupt at delivery: `ReviewGate` halts graph; `result.status == Status.INTERRUPTED`.
3. Resume: construct new graph with same session manager; invoke with `interruptResponse`.
4. Delivery: graph completes with `Status.COMPLETED`.
5. Session restore: verify `FileSessionManager` restores interrupted state on construction.

---

## 7. Phase 5 — Events, workflows, runner (rewrite composition)

### 7.1 Events (`events/`)

| File                                 | Content                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.py`                           | `EventType` enum: `GITHUB_PULL_REQUEST`, `GITHUB_ISSUE`, `GITHUB_RELEASE`, `GITHUB_PUSH`, `SLACK_SUPPORT`, `DISCORD_SUPPORT`, `DOCUMENTATION_CHANGED`, `DOCUMENTATION_PUBLISHED`, `REVIEW_COMPLETED` |
| `envelope.py`                        | `EventEnvelope(event_type, payload, metadata)` — wraps raw webhook payloads                                                                                                                          |
| `dispatcher.py`                      | `EventDispatcher` — routes `EventType` → workflow function                                                                                                                                           |
| `base.py`                            | Base event processor interface                                                                                                                                                                       |
| `github/pull_request.py`             | `PullRequestProcessor` — normalizes webhook → `PullRequestEvent`                                                                                                                                     |
| `github/issue.py`                    | `IssueProcessor` — normalizes webhook → `IssueEvent`                                                                                                                                                 |
| `github/release.py`                  | `ReleaseProcessor` — normalizes webhook → release event                                                                                                                                              |
| `github/push.py`                     | `PushProcessor` — normalizes webhook → push event                                                                                                                                                    |
| `support/slack.py`                   | `SlackProcessor` — normalizes Slack event → `SupportEvent`                                                                                                                                           |
| `support/discord.py`                 | `DiscordProcessor` — normalizes Discord event → `SupportEvent`                                                                                                                                       |
| `documentation/document_changed.py`  | Doc change event processor                                                                                                                                                                           |
| `documentation/publish_completed.py` | Doc publish completion event                                                                                                                                                                         |
| `documentation/review_completed.py`  | Review completion event                                                                                                                                                                              |

### 7.2 Workflows (`workflows/`)

| File                                       | Content                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.py`                                 | `WorkflowState` dataclass (status, run_id, events, results) — replaces `WorkflowResult`                                                                         |
| `context.py` **(NEW — not in scaffold)**   | `WorkflowContext(repositories, memory, evaluation, config)` — dependency bundle for workflow functions. Imported by `app/composition/workers.py` and the runner |
| `runner.py`                                | `WorkflowRunner` — builds graph, invokes, handles result/interrupt                                                                                              |
| `registry.py`                              | `WorkflowRegistry` — maps workflow types to runner functions                                                                                                    |
| `documentation/github_pr_workflow.py`      | `run_pull_request_workflow(context, event)`                                                                                                                     |
| `documentation/github_release_workflow.py` | `run_release_workflow(context, event)`                                                                                                                          |
| `documentation/documentation_sync.py`      | `run_documentation_sync(context)`                                                                                                                               |
| `documentation/documentation_audit.py`     | `run_documentation_audit(context)`                                                                                                                              |
| `github/issue_resolution.py`               | `run_github_issue_workflow(context, event)`                                                                                                                     |
| `github/issue_feedback.py`                 | Issue feedback processing                                                                                                                                       |
| `support/slack_support_workflow.py`        | `run_slack_support(context, event)`                                                                                                                             |
| `support/discord_support_workflow.py`      | `run_discord_support(context, event)`                                                                                                                           |
| `support/support_resolution.py`            | Support resolution logic                                                                                                                                        |
| `feedback/documentation_feedback_loop.py`  | `run_feedback_loop(context)` — scheduled feedback graph                                                                                                         |
| `feedback/feedback_prioritization.py`      | Gap prioritization                                                                                                                                              |
| `feedback/knowledge_update.py`             | Knowledge base updates                                                                                                                                          |
| `evaluation/documentation_evaluation.py`   | `run_evaluation_loop(context)`                                                                                                                                  |
| `evaluation/support_evaluation.py`         | Support answer evaluation                                                                                                                                       |

### 7.3 Composition rewrite

`app/composition/agents.py` → `AgentRegistry` of Strands agents/swarms (no checkpointer):

```python
from dataclasses import dataclass, field
from draftly.agents.shared.classifier import classifier
from draftly.agents.shared.context_agent import context_agent
from draftly.agents.shared.delivery_agent import delivery_agent
from draftly.agents.documentation.analyzer import impact_agent
from draftly.agents.documentation.writer import writer_agent
from draftly.agents.support.answer_writer import answer_agent
from draftly.agents.subagents import build_research_swarm


@dataclass
class AgentRegistry:
    classifier: object = classifier
    context_agent: object = context_agent
    delivery_agent: object = delivery_agent
    impact_agent: object = impact_agent
    writer_agent: object = writer_agent
    answer_agent: object = answer_agent
    research_swarm_factory: object = build_research_swarm
```

`app/composition/workflows.py` → `WorkflowRegistry`:

```python
from dataclasses import dataclass
from draftly.workflows.documentation.github_pr_workflow import run_pull_request_workflow
from draftly.workflows.github.issue_resolution import run_github_issue_workflow
from draftly.workflows.support.slack_support_workflow import run_slack_support
from draftly.workflows.support.discord_support_workflow import run_discord_support
from draftly.workflows.feedback.documentation_feedback_loop import run_feedback_loop
from draftly.workflows.evaluation.documentation_evaluation import run_evaluation_loop


@dataclass
class WorkflowRegistry:
    github_pr: object = run_pull_request_workflow
    github_issue: object = run_github_issue_workflow
    slack_support: object = run_slack_support
    discord_support: object = run_discord_support
    feedback_loop: object = run_feedback_loop
    evaluation_loop: object = run_evaluation_loop
```

`app/composition/events.py` (330 lines, implemented with broken imports) →
`EventComposition` wrapping `draftly.events.dispatcher` + normalizers:

```python
from dataclasses import dataclass, field

from draftly.events.dispatcher import EventDispatcher
from draftly.events.github.pull_request import PullRequestProcessor
from draftly.events.github.issue import IssueProcessor
from draftly.events.support.slack import SlackProcessor
from draftly.events.support.discord import DiscordProcessor


@dataclass
class EventComposition:
    """Single entry point for raw webhook payloads → normalized events."""

    dispatcher: EventDispatcher = field(default_factory=EventDispatcher)
    pull_request: object = PullRequestProcessor()
    issue: object = IssueProcessor()
    slack: object = SlackProcessor()
    discord: object = DiscordProcessor()

    async def normalize_github(self, payload: dict) -> dict:
        """Route a raw GitHub webhook to the matching normalizer."""
        action = payload.get("action", "")
        if payload.get("pull_request"):
            return (await self.pull_request.process(payload)).model_dump()
        if payload.get("issue"):
            return (await self.issue.process(payload)).model_dump()
        raise ValueError(f"Unhandled GitHub payload action={action}")

    async def normalize_slack(self, payload: dict) -> dict:
        return (await self.slack.process(payload)).model_dump()

    async def normalize_discord(self, payload: dict) -> dict:
        return (await self.discord.process(payload)).model_dump()

    def workflow_type_for(self, event: dict) -> str:
        """Map a normalized event to its graph surface."""
        return self.dispatcher.route(event)
```

### 7.4 Workflow runner (replaces the pipelines layer)

**Delete `app/pipelines/*` (3 files)** — they are an indirection the build
guide never uses, and the graph needs none of it. Webhook routes call the
normalizers, then hand the event straight to a `WorkflowRunner`:

```python
from strands.multiagent.base import Status


class WorkflowRunner:
    """Build the per-run graph, invoke it, and handle the outcome.

    One run = one session = one graph (see §6.8). Idempotency is checked
    BEFORE the graph is touched.
    """

    def __init__(self, app_state):
        self.app_state = app_state

    async def run(self, event: dict) -> dict:
        # 1. Idempotency: dedupe replayed webhooks before invoking the graph
        existing = await self.app_state.events.find_by_event_id(
            event["event_id"], event.get("project_id")
        )
        if existing:
            return {"status": "duplicate", "run_id": existing["run_id"]}

        # 2. One session + one graph for this run's surface
        surface = self.app_state.events.workflow_type_for(event)
        graph = build_graph_for_run(
            event["event_id"],
            surface=surface,
            tools_registry=self.app_state.tools,
            model=self.app_state.model,
            hooks=self.app_state.hooks,
        )

        # 3. Invoke with runtime context in invocation_state (never in the
        #    prompt): DB handles, config, review policy, delivery summary.
        #    ReviewGate reads these when it fires before the deliver node.
        result = await graph.invoke_async(
            json.dumps(event),
            invocation_state={
                "run_id": event["event_id"],
                "project_config": await self.app_state.projects.get(event.get("project_id")),
                "review_policy": self.app_state.config.strands.review_policy,
                "delivery_summary": "",
                "evaluation": {},
                "evidence_count": 0,
            },
        )

        # 4. Handle the outcome
        if result.status == Status.INTERRUPTED:
            for interrupt in result.interrupts:
                await self.app_state.reviews.store_interrupt(
                    run_id=event["event_id"],
                    interrupt_id=interrupt.id,
                    reason=interrupt.reason,
                    workflow_type=surface,  # needed by the resume route (§9.1)
                )
            await self.app_state.events.mark_pending(event["event_id"], result)
            return {"status": "pending_review", "run_id": event["event_id"]}

        if result.status == Status.COMPLETED:
            await self.app_state.events.mark_completed(event["event_id"], result)
            return {"status": "delivered", "run_id": event["event_id"]}

        if result.status == Status.FAILED:
            await self.app_state.events.mark_failed(event["event_id"], result)
            return {"status": "failed", "errors": result.failed_nodes}

        return {"status": result.status, "run_id": event["event_id"]}
```

Webhook route wiring (in `app/api/routes/github.py`, already implemented —
just fix imports):

```python
@router.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks,
                  app_state=Depends(get_app_state)):
    payload = await request.json()
    event = await app_state.events.normalize_github(payload)   # EventComposition
    background_tasks.add_task(app_state.workflows.runner.run, event)
    return {"status": "accepted"}
```

### 7.5 Verification

- Runner test: mocked graph result (INTERRUPTED → interrupt stored + `pending_review`; COMPLETED → `delivered`; FAILED → `failed`).
- Idempotency test: second call with the same `event_id` → `duplicate`, graph never invoked.
- Dispatcher routing tests: verify correct surface selected per event type.
- EventComposition: raw GitHub/Slack/Discord payloads → normalized event dicts.

---

## 8. Phase 6 — Domain services

### 8.1 Memory (`memory/`)

| File            | Purpose                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `service.py`    | `MemoryService` — orchestrate storage/retrieval/curation                                            |
| `retrieval.py`  | `MemoryRetrieval` — semantic search, relevance scoring                                              |
| `ranking.py`    | `MemoryRanking` — rank results by recency, source quality                                           |
| `embeddings.py` | `EmbeddingService` — generate embeddings via model layer                                            |
| `repository.py` | `MemoryRepository` — wraps `integrations.database.memory_store`                                     |
| `models/*.py`   | Pydantic models for Document, Conversation, Question, Solution, Issue, Knowledge, Feedback, Project |

### 8.2 Evaluation (`evaluation/`)

> **DeepEval is replaced by the Strands Evals SDK** — see §8.10 for the full
> rationale, mapping table, and install caveat. In short: same vendor as the
> agents SDK, deterministic evaluators run for free in CI (no model keys), and
> the custom evaluator reuses `compute_quality()` from the in-graph gate.

| File                                  | Purpose                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.py`                          | `EvaluationService` — orchestrate evaluation runs                                                                                                                                                                            |
| `runner.py`                           | `StrandsEvalsRunner` — wraps `Experiment(cases, evaluators)` + `run_evaluations_async(..., evaluation_data_store=)`; persists results via `LocalFileTaskResultStore`/custom `EvaluationDataStore` → `012_evaluations` tables |
| `failure_analyzer.py`                 | `FailureAnalyzer` — categorize eval failures (uses `test_pass=False` + `reason`)                                                                                                                                             |
| `evaluators/correctness.py`           | Thin wrapper over `strands_evals.evaluators.CorrectnessEvaluator`                                                                                                                                                            |
| `evaluators/relevance.py`             | Thin wrapper over `ResponseRelevanceEvaluator`                                                                                                                                                                               |
| `evaluators/completeness.py`          | `OutputEvaluator(rubric=...)` — completeness rubric (rubric is a required positional arg; inject `model=`)                                                                                                                   |
| `evaluators/groundedness.py`          | Thin wrapper over `FaithfulnessEvaluator`                                                                                                                                                                                    |
| `evaluators/documentation_quality.py` | `CustomEvaluator` subclass reusing `compute_quality()` from `orchestration/nodes/evaluate.py`                                                                                                                                |
| `evaluators/deterministic.py`         | `Contains` / `Equals` / `ToolCalled` — free CI regression checks                                                                                                                                                             |
| `datasets/*.json`                     | Golden datasets → `Case` lists (fixtures)                                                                                                                                                                                    |

### 8.3 Review (`review/`)

| File           | Purpose                                          |
| -------------- | ------------------------------------------------ |
| `service.py`   | `ReviewService` — manage review queue, decisions |
| `queue.py`     | `ReviewQueue` — pending reviews, expiry          |
| `models.py`    | Pydantic models for review requests/decisions    |
| `policies.py`  | Review policies (always, risky, never)           |
| `rejection.py` | Rejection handling, feedback to graph            |
| `approvals.py` | Approval handling, trigger delivery              |

### 8.4 Documentation (`documentation/`)

| File           | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `service.py`   | `DocumentationService` — high-level doc operations       |
| `analyzer.py`  | `DocumentationAnalyzer` — impact analysis, gap detection |
| `indexer.py`   | `DocumentationIndexer` — build/update doc index          |
| `validator.py` | `DocumentationValidator` — link checking, freshness      |
| `models.py`    | Pydantic models for documents, gaps                      |
| `generator.py` | `DocumentationGenerator` — create new docs               |
| `updater.py`   | `DocumentationUpdater` — modify existing docs            |

### 8.5 Feedback (`feedback/`)

| File                   | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `service.py`           | `FeedbackService` — feedback loop orchestration          |
| `classifier.py`        | `FeedbackClassifier` — categorize feedback signals       |
| `gap_detector.py`      | `GapDetector` — identify documentation gaps from support |
| `prioritization.py`    | `GapPrioritizer` — rank gaps by severity/frequency       |
| `knowledge_updater.py` | `KnowledgeUpdater` — update memory from resolved issues  |
| `deduplication.py`     | `DeduplicationService` — merge similar feedback          |
| `models.py`            | Pydantic models for gaps, feedback items                 |

### 8.6 Delivery (`delivery/`)

| File               | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `service.py`       | `DeliveryService` — coordinate delivery across surfaces |
| `github.py`        | `GitHubDelivery` — create PR, commit, branch            |
| `slack.py`         | `SlackDelivery` — post message, thread reply            |
| `discord.py`       | `DiscordDelivery` — post message, thread reply          |
| `documentation.py` | `DocumentationDelivery` — doc-specific delivery         |

### 8.7 Support (`support/`)

| File            | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `service.py`    | `SupportService` — support question lifecycle        |
| `classifier.py` | `SupportClassifier` — triage questions               |
| `answer.py`     | `SupportAnswer` — generate/validate answers          |
| `resolver.py`   | `SupportResolver` — resolve questions, update memory |
| `escalation.py` | `EscalationService` — escalate unclear questions     |
| `models.py`     | Pydantic models for support questions/answers        |

### 8.8 Security (`security/`)

| File                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `webhook_verification.py` | Verify webhook signatures (GitHub, Slack, Discord) |
| `audit.py`                | Security audit logging                             |
| `permissions.py`          | Permission checks                                  |
| `redaction.py`            | PII/secrets redaction in prompts                   |
| `secrets.py`              | Secret management                                  |

### 8.9 Verification

Domain unit tests with repository fakes (no DB); feedback cluster→gap logic with a seeded in-memory question set.

### 8.10 Strands Evals SDK (replaces DeepEval)

**✅ Verified against `strands-agents-evals==1.1.1` (2026-08-20):** installed in
`pyproject.toml`, `import strands_evals` succeeds, and every API below is
confirmed against the installed package. (History: `strands-evals==0.0.1` on
PyPI was an unrelated/fake package — a "data synchronization" client with no
evals code; it has been removed. The real SDK is published as
`strands-agents-evals` and imports as `strands_evals`.)

**Why replace DeepEval:**

- Same vendor as the agents SDK (one dependency surface)
- Deterministic evaluators (`Contains`, `Equals`, `ToolCalled`, `StateEquals`) run with no model keys — free offline CI under the "no model keys" constraint
- Custom evaluator can reuse `compute_quality()` from the in-graph `EvaluatorNode`, so online gate and offline harness share logic
- `EvaluationOutput` is simpler than DeepEval metrics: `score`, `test_pass`, `reason`

**API shape (verified against strands-agents-evals 1.1.1):**

```python
from strands_evals import Case, Experiment
from strands_evals.evaluators import Contains, FaithfulnessEvaluator, OutputEvaluator
from strands_evals.types import EvaluationData, EvaluationOutput

# EvaluationData fields: input, actual_output, actual_trajectory,
# actual_interactions, expected_output, expected_environment_state, ...
# Evaluator.evaluate(EvaluationData) -> list[EvaluationOutput]
# EvaluationOutput fields: score, test_pass, reason, label

evaluators = [
    Contains(value="Paris"),           # deterministic — no LLM needed
    FaithfulnessEvaluator(model=model),  # LLM judge — inject a draftly.models Model
    OutputEvaluator(rubric="Assess professional tone", model=model),  # rubric required
]

experiment = Experiment(cases=cases, evaluators=evaluators)
report = await experiment.run_evaluations_async(
    get_response,                       # get_response(case) -> str
    evaluation_data_store=store,        # optional persistence (LocalFileTaskResultStore)
)
report.run_display()
```

- LLM evaluators take `model: Model | str | None = None` — pass a
  `draftly.models` `Model` (Phase 2) as the judge; `None` falls back to the
  SDK default model config. Deterministic evaluators need no model.
- Persistence: `Experiment.run_evaluations_async(..., evaluation_data_store=)`.
  `EvaluationDataStore` is a `Protocol` (`save(case_name, result)` /
  `load(case_name)`); `LocalFileTaskResultStore` ships with the SDK and maps to
  the `012_evaluations` tables.
- CLI: `strands-evals` console script wraps the same library API (CI runs).

**Built-in evaluator catalog (7 categories):**

| Category         | Evaluators                                                                                                                                                                                         | Level          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Response quality | `OutputEvaluator` (custom rubric), `Helpfulness`, `Faithfulness`, `Correctness`, `Coherence`, `Conciseness`, `ResponseRelevance`, `Harmfulness`, `Refusal`, `Stereotyping`, `InstructionFollowing` | OUTPUT/TRACE   |
| Multimodal       | `MultimodalOutput/OverallQuality/Correctness/Faithfulness/InstructionFollowing`                                                                                                                    | OUTPUT         |
| Tool usage       | `ToolSelectionAccuracy`, `ToolParameterAccuracy`                                                                                                                                                   | TRACE          |
| Flow             | `TrajectoryEvaluator`, `InteractionsEvaluator`                                                                                                                                                     | SESSION        |
| Goal achievement | `GoalSuccessRateEvaluator`                                                                                                                                                                         | SESSION        |
| Resilience       | `FailureCommunication`, `PartialCompletion`, `RecoveryStrategy` — import from `strands_evals.evaluators.chaos`                                                                                     | TRACE          |
| Deterministic    | `Equals`, `Contains`, `StartsWith`, `ToolCalled`, `StateEquals`                                                                                                                                    | OUTPUT/SESSION |
| Custom           | subclass `Evaluator` → `evaluate()` / `evaluate_async()`                                                                                                                                           | any            |

**Draftly mapping (DeepEval metric → Strands evaluator):**

| Draftly need          | DeepEval (old)      | Strands (new)                                                               |
| --------------------- | ------------------- | --------------------------------------------------------------------------- |
| Groundedness          | G-Eval/faithfulness | `FaithfulnessEvaluator`                                                     |
| Factual correctness   | FactualCorrectness  | `CorrectnessEvaluator`                                                      |
| Relevance             | AnswerRelevancy     | `ResponseRelevanceEvaluator`                                                |
| Documentation quality | custom metric       | `OutputEvaluator(rubric=...)` or `CustomEvaluator` over `compute_quality()` |
| Completeness          | custom metric       | `OutputEvaluator` completeness rubric                                       |
| Tool discipline       | custom              | `ToolSelectionAccuracyEvaluator` + `ToolParameterAccuracyEvaluator`         |
| End-to-end success    | TaskCompletion      | `GoalSuccessRateEvaluator`                                                  |
| CI/regression         | —                   | `Contains` / `Equals` / `ToolCalled` (free, no model)                       |

**Draftly file changes (Phase 6):**

| File                                       | Change                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pyproject.toml`                           | Drop `deepeval>=4.1.8`; add real `strands-evals` once published (pin exact version after install verification)                                                |
| `evaluation/deepeval_runner.py`            | → `evaluation/runner.py` (`StrandsEvalsRunner` wrapping `Experiment`)                                                                                         |
| `evaluation/evaluators/*.py`               | Thin wrappers per §8.2 table                                                                                                                                  |
| `evaluation/datasets/*.json`               | Become `Case` lists (`Case(name, input, expected_output)`)                                                                                                    |
| `agents/shared/deepeval.py`                | Delete (evaluation leaves the agent graph)                                                                                                                    |
| `integrations/deepeval/`                   | Delete; LLM-judge model wiring lives in `integrations/strands/evals.py` (reuses `draftly.models` — judges need a `Model`; deterministic evaluators need none) |
| `orchestration/graphs/evaluation_graph.py` | Schedules `Experiment` runs (see §6.5)                                                                                                                        |
| Persistence                                | `EvaluationDataStore`/`LocalFileTaskResultStore` → `012_evaluations` tables (existing migration)                                                              |

**Interaction with the in-graph gate:** the `EvaluatorNode` (§3.4) stays the
deterministic runtime quality gate inside the workflow graph (grounding,
completeness, length heuristics, revise-loop). Strands evals are the offline
harness: golden datasets, regressions, tool usage, and end-to-end success.
The two share `compute_quality()` — the custom evaluator calls it so CI and
runtime measure the same thing.

**Risks:** real SDK not yet published (unverified API — verify `reason` vs
`reasoning`, `EvaluationData` field names, judge-model configuration at
install); LLM-judge evaluators need model keys → gate behind
`@pytest.mark.integration`; docs API may evolve pre-1.0.

---

## 9. Phase 7 — API routes, workers, observability

### 9.1 Routes

| File                              | Endpoints                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `app/api/routes/github.py`        | Webhook handler (already implemented, fix imports); `POST /api/review/{run_id}` to resume |
| `app/api/routes/slack.py`         | Slack webhook (already implemented, fix imports)                                          |
| `app/api/routes/discord.py`       | Discord webhook (already implemented, fix imports)                                        |
| `app/api/routes/documentation.py` | `GET /api/documentation` (list), `GET /api/documentation/{id}` (detail)                   |
| `app/api/routes/evaluations.py`   | `GET /api/evaluations` (list), `POST /api/evaluations/run` (trigger)                      |
| `app/api/routes/support.py`       | `GET /api/support/questions` (list), `GET /api/support/questions/{id}` (detail)           |
| `app/api/routes/reviewers.py`     | Already implemented; fix imports                                                          |
| `app/api/routes/jobs.py`          | Already implemented; fix imports                                                          |

The review resume endpoint:

```python
@router.post("/review/{run_id}")
async def resume_review(run_id: str, decision: ReviewDecision, app_state=Depends(get_app_state)):
    """Resume a graph after human review."""
    from draftly.integrations.strands.graph import build_graph_for_run

    # Load stored interrupt + the run's surface (persisted at interrupt time)
    interrupt = await app_state.reviews.get_interrupt(run_id)

    graph = build_graph_for_run(
        run_id,
        surface=interrupt.workflow_type,  # "pull_request" | "issue" | "support"
        tools_registry=app_state.tools,
        model=app_state.model,
        hooks=app_state.hooks,
    )

    # Resume with interrupt response
    response = [{"interruptResponse": {
        "interruptId": interrupt.interrupt_id,
        "response": decision.model_dump(),
    }}]

    result = await graph.invoke_async(response, invocation_state={"run_id": run_id})

    return {"status": result.status, "run_id": run_id}
```

### 9.2 Workers

| File                               | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `app/workers/worker.py`            | `DraftlyWorker` — event loop worker (already implemented)     |
| `app/workers/scheduler.py`         | Scheduler for periodic tasks (already implemented)            |
| `app/workers/task_runner.py`       | `TaskRunner` — execute registered tasks (already implemented) |
| `app/workers/scheduler_adapter.py` | Adapter for scheduler (already implemented)                   |

Top-level `workers/` entrypoints (all stubs — create as thin wrappers):

| File                           | Entry point                             |
| ------------------------------ | --------------------------------------- |
| `workers/event_worker.py`      | `uvicorn` worker for webhook processing |
| `workers/workflow_worker.py`   | Resume/retry worker                     |
| `workers/indexing_worker.py`   | Documentation indexing worker           |
| `workers/evaluation_worker.py` | CI/batch evaluation worker              |

### 9.3 Observability

| File                       | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `observability/audit.py`   | Audit trail management                   |
| `observability/events.py`  | Graph event streaming to SSE/WebSocket   |
| `observability/metrics.py` | Metrics collection                       |
| `observability/tracing.py` | Request correlation, distributed tracing |

Graph event streaming:

```python
async def stream_graph_events(graph, task, invocation_state):
    """Stream graph events over SSE."""
    async for event in graph.stream_async(task, invocation_state=invocation_state):
        yield {
            "event": event.get("event_type", "unknown"),
            "data": event,
        }
```

### 9.4 Verification

Route smoke tests with a mocked runner; audit rows written for a fake run.

---

## 10. Phase 8 — Idempotency and audit

### 10.1 Idempotency

- Unique index on `(event_id, project_id, workflow_type)` in the `events` table
  (migration `007_events` exists).
- The `WorkflowRunner` checks for an existing run BEFORE invoking the graph
  (first lines of `run()`, §7.4):
  ```python
  existing = await events_repo.find_by_event_id(event_id, project_id)
  if existing:
      return {"status": "duplicate", "run_id": existing["run_id"]}  # replayed webhook
  ```
- `set_graph_id("draftly-main-graph")` namespaces session state and traces.

### 10.2 Audit trail

For every run, write `agent_runs` + `agent_steps` rows covering:
trigger → evidence → agents → tool calls → generated artifact → evaluation → approval → delivery.

The `RunAuditLogger` hook (Phase 4) writes these rows. Migrations `007_events`,
`012_evaluations`, `014_delivery`, `022_reviews` exist.

### 10.3 Verification

- Verify dedupe: same `event_id` → second call returns existing run, no graph invoked.
- Verify audit: run a graph → `agent_steps` rows exist for each node.

---

## 11. Phase 9 — Tests and verification (no model keys / no DB)

### 11.1 StubModel

`tests/stub_model.py` — a `strands.models.model.Model` subclass with scripted outputs:

```python
from strands.models.model import Model


class StubModel(Model):
    """Deterministic model for testing — returns scripted responses."""

    def __init__(self, responses=None):
        self.responses = responses or []
        self.call_count = 0

    async def __call__(self, messages, **kwargs):
        if self.call_count < len(self.responses):
            response = self.responses[self.call_count]
            self.call_count += 1
            return response
        return {"content": [{"text": "default response"}], "stop_reason": "end_turn"}

    async def structured_output(self, messages, output_model, **kwargs):
        """Return a deterministic structured output."""
        if self.call_count < len(self.responses):
            response = self.responses[self.call_count]
            self.call_count += 1
            return response
        return output_model.model_validate({"surface": "pull_request", "change_type": "bug_fix", "urgency": "medium", "reason": "test"})
```

### 11.2 Test structure

| Test file                                        | What it tests                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `tests/conditions/test_conditions.py`            | All conditions with simulated GraphState                                           |
| `tests/conditions/test_session_reevaluation.py`  | Conditions under session persistence                                               |
| `tests/nodes/test_evaluator.py`                  | EvaluatorNode with various inputs                                                  |
| `tests/nodes/test_base_helpers.py`               | `agent_result()` and `node_data()` round-trips                                     |
| `tests/graph/test_documentation_graph.py`        | Full documentation graph with StubModel                                            |
| `tests/graph/test_issue_graph.py`                | Full issue graph                                                                   |
| `tests/graph/test_support_graph.py`              | Full support graph                                                                 |
| `tests/graph/test_review_gate.py`                | Interrupt → resume → delivery                                                      |
| `tests/graph/test_session_restore.py`            | Session persistence across graph rebuilds                                          |
| `tests/workflow/test_pr_workflow.py`             | PR workflow end-to-end                                                             |
| `tests/workflow/test_issue_workflow.py`          | Issue workflow end-to-end                                                          |
| `tests/workflow/test_support_workflow.py`        | Support workflow end-to-end                                                        |
| `tests/workflow/test_feedback_loop.py`           | Feedback loop: questions → gaps                                                    |
| `tests/evaluation/test_documentation_quality.py` | Documentation quality evaluator (Strands `CustomEvaluator` over `compute_quality`) |
| `tests/evaluation/test_groundedness.py`          | `FaithfulnessEvaluator` wrapper                                                    |
| `tests/evaluation/test_support_accuracy.py`      | Support accuracy evaluator                                                         |
| `tests/evaluation/test_runner.py`                | `StrandsEvalsRunner` with a mocked `Experiment`                                    |
| `tests/tools/test_github_tools.py`               | GitHub tool round-trips                                                            |
| `tests/tools/test_search_tools.py`               | Search tool round-trips                                                            |
| `tests/events/test_dispatcher.py`                | Event routing tests                                                                |
| `tests/workflow/test_runner.py`                  | Runner with mocked graph (interrupt/completed/failed/duplicate)                    |
| `tests/memory/test_retrieval.py`                 | Memory retrieval with fakes                                                        |
| `tests/feedback/test_gap_detection.py`           | Gap detection logic                                                                |

### 11.3 In-memory fakes

Create `tests/fakes/` with:

- `FakeGitHubClient` — in-memory GitHub API mock
- `FakeSlackClient` — in-memory Slack API mock
- `FakeDiscordClient` — in-memory Discord API mock
- `FakeDatabase` — in-memory store mock (formerly `FakeCockroachDB`)
- `FakeMemoryStore` — in-memory vector search mock

### 11.4 Live tests

Live verification runs the **same tests** against a real Strands `Model`/`ModelRouter`
and real NeonDB. The switch is a single env var — no separate test suite:

```python
# tests/conftest.py (shared by all suites)
import os

import pytest

from draftly.integrations.database.client import DatabaseClient
from tests.fakes import FakeDatabase
from tests.stub_model import StubModel


@pytest.fixture
def model():
    """StubModel offline; real ModelRouter when DRAFTLY_LIVE=1."""
    if os.getenv("DRAFTLY_LIVE"):
        from draftly.models.factory import build_model_router

        return build_model_router()  # real providers from .env keys
    return StubModel()  # deterministic, offline


@pytest.fixture
async def db():
    """FakeDatabase offline; real NeonDB when DRAFTLY_LIVE=1."""
    if os.getenv("DRAFTLY_LIVE"):
        client = DatabaseClient()  # reads NEON_DATABASE_URL (client.py, §2.7c)
        await client.start()
        yield client
        await client.close()
    else:
        yield FakeDatabase()


@pytest.fixture
def requires_live():
    """Skip (not fail) when a live test is run without DRAFTLY_LIVE=1."""
    if not os.getenv("DRAFTLY_LIVE"):
        pytest.skip("set DRAFTLY_LIVE=1 and keys in .env for live verification")
```

```python
@pytest.mark.integration
async def test_live_pr_workflow(model, db, requires_live):
    """Requires model keys and NeonDB. Full PR event through WorkflowRunner."""
    runner = WorkflowRunner(app_state=...)  # wired with real model + DatabaseClient
    result = await runner.run(sample_pr_event())
    assert result["status"] == "completed"
    # rows now exist in Neon: agent_runs, agent_steps, events,
    # documentation, evaluations, memory + embeddings
```

**What live tests verify:**

| Test                                                | Live concern                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| DB round-trip (`tests/integration/test_db.py`)      | Write a memory item → `semantic_search()` returns it (real embeddings via `EMBEDDING_MODEL`/`EMBEDDING_MODEL_ID`) |
| LLM judges (`tests/integration/test_evaluators.py`) | `FaithfulnessEvaluator(model=...)`, `OutputEvaluator(rubric=..., model=...)` score real output                    |
| Full workflows (PR / issue / support)               | Graph runs end-to-end with real models; audit + delivery rows land in Neon                                        |
| Interrupt/resume                                    | `ReviewGate` interrupt → resume via `interrupt.workflow_type` (§9.1) → delivery node writes                       |

Run modes:

```bash
uv run pytest tests/ -v                     # offline gate — CI, no keys
uv run pytest tests/ -m integration -v      # live — requires DRAFTLY_LIVE=1 + .env keys
```

### 11.5 Gates

```bash
uv run ruff check src/draftly
uv run mypy src/draftly
uv run pytest tests/ -v
```

### 11.6 Live verification setup

**Env prerequisites** (`.env`, names confirmed present in the repo):

- `Neon_DATABASE_URL` — Neon direct connection string (NOT the pooled
  `-pooler` endpoint — it rejects asyncpg prepared statements, §2.7e).
- At least one provider key: `NVIDIA_API_KEY` | `REQUESTY_API_KEY` +
  `REQUESTY_BASE_URL` | `ORCAROUTER_API_KEY` | `OPENROUTER_API_KEY`.
- Embedding model vars (`EMBEDDING_MODEL`/`EMBEDDING_MODEL_ID`) for
  vector-search tests.

**DB bootstrap** (no migration runner exists — loop or a tiny
`scripts/migrate.py` in Phase 7):

```bash
neonctl database create draftly
for f in src/draftly/persistence/migrations/*.sql; do
  psql "$Neon_DATABASE_URL" -f "$f"
done
psql "$Neon_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

**Sanity checks before the live suite:**

```bash
# DB
uv run python -c "from draftly.integrations.database.client import DatabaseClient; ..."  # §2.7f
# Model (after Phase 2 lands)
uv run python -c "from draftly.models.factory import build_model_router; ..."
```

**Marker registration** (already applied in `pyproject.toml`):

```toml
[tool.pytest.ini_options]
markers = ["integration: requires live NeonDB and model keys (run with DRAFTLY_LIVE=1)"]
```

**Workflow:** set `DRAFTLY_LIVE=1` in `.env`, run `pytest -m integration`; without
it, the same tests run offline against `StubModel` + `FakeDatabase`. Use a Neon
**branch** for throwaway test state instead of the main database.

**.env hygiene:** remove the stale `cockroachlabs.cloud` connection URL + MCP
block at the bottom of `.env` (contains a database password — rotate it if it
has leaked anywhere).

---

## 12. Build order checklist

| #   | Phase       | Files to fill                                                                                                                                                                                                                                                                                                                               | Verify                                                           |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **Phase 0** | `app/composition/*`, **delete `app/pipelines/*`**, `app/api/routes/{github,documentation,evaluations,support}.py`, `app/lifecycle.py`, `models/providers/*`, `__init__.py` sweep, **NeonDB swap (§2.7): rename `integrations/cockroachdb` → `integrations/database`, `STRING`→`TEXT`, pgvector DDL, `read_committed`, `NEON_DATABASE_URL`** | `import draftly.app.api.app` succeeds                            |
| 2   | **Phase 1** | `orchestration/state/*.py`, `orchestration/routing/conditions.py`, `orchestration/nodes/{base,evaluate}.py`                                                                                                                                                                                                                                 | pytest: conditions, node helpers, evaluator                      |
| 3   | **Phase 2** | `tools/{github,documentation,search,slack,discord,repository}/*.py`, `app/composition/tools.py`                                                                                                                                                                                                                                             | pytest: tool schemas render                                      |
| 4   | **Phase 3** | `agents/{shared,documentation,support,github}/*.py` (create NEW `shared/{classifier,context_agent,delivery_agent}.py`), `agents/{draftly_agent,subagents,prompts,schemas}.py`, 20 `skills/**/SKILL.md` + reference docs                                                                                                                     | pytest: classifier, swarm, skills                                |
| 5   | **Phase 4** | `orchestration/graphs/*.py`, `orchestration/hooks/*.py`, `integrations/strands/*.py`                                                                                                                                                                                                                                                        | pytest: graph e2e with StubModel                                 |
| 6   | **Phase 5** | `events/**/*.py`, `workflows/**/*.py` (+ `workflows/context.py`), `app/composition/{agents,workflows,events}.py` rewrite, `workflows/runner.py`                                                                                                                                                                                             | pytest: runner, dispatcher                                       |
| 7   | **Phase 6** | `memory/**/*.py`, `evaluation/**/*.py` (**Strands Evals SDK already installed `strands-agents-evals==1.1.1` — §8.10**; delete `deepeval_runner.py`, `integrations/deepeval/`, `agents/shared/deepeval.py`, drop `deepeval` dep), `review/**/*.py`, `documentation/**/*.py`, `feedback/**/*.py`, `delivery/**/*.py`, `support/**/*.py`       | pytest: domain services + evals wrappers                         |
| 8   | **Phase 7** | `app/api/routes/{documentation,evaluations,support}.py`, `workers/*.py`, `observability/*.py`                                                                                                                                                                                                                                               | pytest: route smoke tests                                        |
| 9   | **Phase 8** | Idempotency wiring in runner, audit wiring in hooks                                                                                                                                                                                                                                                                                         | pytest: dedupe, audit rows                                       |
| 10  | **Phase 9** | `tests/**/*.py`, `tests/fakes/*.py`, `tests/stub_model.py`, `tests/conftest.py` (two-mode `model`/`db` fixtures, §11.4), pytest `integration` marker (§11.6)                                                                                                                                                                                | `uv run pytest` green; `uv run pytest -m integration` live-ready |

---

## 13. Risks and mitigations

| Risk                                                                                                                                                                                                         | Mitigation                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Composition rewrite is substantial** — app layer was written against LangGraph, not Strands                                                                                                                | Phase 0 is dedicated entirely to this; verify import before proceeding                                                                                               |
| **No runtime** — no model keys or NeonDB                                                                                                                                                                     | StubModel + deterministic custom nodes + in-memory fakes; `@pytest.mark.integration` for live                                                                        |
| **Skills are empty** — 20 SKILL.md + 66 reference docs + 4 asset templates need real content                                                                                                                 | Phase 3 dedicates time to writing SKILL.md content; minimum set prioritized                                                                                          |
| **Missing `__init__.py` files** — 28 subdirectories lack `__init__.py`                                                                                                                                       | Phase 0 must add them; without them imports fail                                                                                                                     |
| **`context/*.md` location** — files are at `draftly-agent-backend/context/`, not inside `src/draftly/`                                                                                                       | Use `Path(__file__).parent.parent.parent / "context"` or copy into package                                                                                           |
| **Session manager state** — session restores on graph construction, can't re-invoke with plain string                                                                                                        | Document in runner code; always build graph per-run                                                                                                                  |
| **Defensive conditions** — session persistence re-evaluates all edges at any time                                                                                                                            | Every condition must guard on `nid in state.results` first                                                                                                           |
| **Node input format** — the graph feeds nodes with satisfied dependencies a `list[ContentBlock]` (`"Original Task:"` + `"From <dep_id>:"` sections), NOT the raw task string; reading `task` as JSON crashes | All custom nodes read dependency outputs via `parse_node_input()` (§3.3); `EvaluatorNode` uses it; never `json.loads(task)`                                          |
| **One session per graph** — session state is keyed by `session_id`; sharing one `FileSessionManager` across graphs clobbers persistence                                                                      | `build_graph_for_run` builds exactly one graph per run (§6.8)                                                                                                        |
| **Neon pooler rejects prepared statements** — the pooled (PgBouncer-style) endpoint breaks asyncpg's default statement caching                                                                               | Use the **direct** Neon connection string, or create the pool with `statement_cache_size=0` / `prepared_statement_cache_size=0` (§2.7e)                              |
| **Postgres SSI aborts** — keeping `serializable` on Neon increases transaction conflict aborts (no 40001 retry in repos)                                                                                     | Default to `read_committed` in `DatabaseClient.transaction()` (§2.7c)                                                                                                |
| **Evaluator `model=` may reject `ModelRouter`** — Strands LLM judges take a concrete `Model`, and `app_state.model` is a router                                                                              | Verify at Phase 2; resolve a concrete `Model` from the router before evaluator construction                                                                          |
| **LLM-judge evaluators need model keys** — Strands `Faithfulness`/`Correctness`/`Output` evaluators use a judge `Model`                                                                                      | Wire judges through `draftly.models` (Phase 2) via `model=`; gate LLM-judge eval tests behind `@pytest.mark.integration`; use deterministic evaluators in default CI |
