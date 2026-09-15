# Draftly on the Strands Agents SDK — Build Guide

How to build the Draftly documentation-intelligence platform described in
[`draftly-workflows-architecture.md`](./draftly-workflows-architecture.md) using the
**Strands Agents SDK (Python)**, version pinned by `draftly-agent-backend/pyproject.toml`
(`strands-agents>=1.52.0`).

Every API name below was verified against the installed package. The guide maps each
architecture section of the reference doc to a concrete Strands construct and to the
already-scaffolded files in `draftly-agent-backend/src/draftly/`.

---

## 1. Architecture recap

Draftly is **one documentation-intelligence engine with three event surfaces**:

| Surface | Signal | Graph entry |
| --- | --- | --- |
| GitHub PR (`pull_request.opened` / `.synchronize`) | software changed | PR workflow |
| GitHub Issue | developer struggling | Issue workflow |
| Slack / Discord question | developer confused | Support workflow |

All three converge on one shared pipeline, implemented as one Strands Graph:

```
ingest → classify → context → research (Swarm) → impact → generate/retrieve
       → evaluate (loop back on FAIL) → human review (interrupt) → deliver
```

Two cross-cutting systems sit outside the graph:

1. **Feedback loop** — support questions are persisted, embedded, and clustered;
   high-frequency topics with low doc coverage become `DocumentationGap` records that
   re-trigger the documentation workflow.
2. **Observability / audit** — Strands hooks emit run, node, tool, and evaluation traces
   into CockroachDB and the dashboard.

**Orchestration philosophy (doc §16–17):**

> Graph = governance (deterministic stages, conditional routing, review gates)
> Swarm = exploration (research sub-agents handing off autonomously)

---

## 2. State model: mapping `DraftlyState` to Strands

The reference doc's `DraftlyState` (doc §18) maps to **three distinct Strands concepts** —
don't force it into one object:

| `DraftlyState` field | Where it lives |
| --- | --- |
| `run_id`, `project_id`, `event`, `event_type`, `actor`, `issue`, `pull_request`, `support_question` | The **task** string passed to `graph(task)` — a compact JSON payload of the normalized event |
| `evidence[]`, `related_events[]`, `related_documents[]`, `documentation_impact`, `documentation_changes[]`, `generated_response`, `evaluation` | **`GraphState.results[node_id].result`** — each node's output, readable by later nodes and edge conditions |
| runtime context (user role, repo config, DB handle, feature flags) | **`invocation_state`** dict passed at invocation; available to conditions via `EdgeConditionWithContext`; persisted across interrupts and kept out of prompts |
| anything cross-run (support history, doc versions, gaps, approvals) | **CockroachDB tables** (doc §25) — Strands state is per-run |

The task payload is a string so every node receives it as its base input. Example:

```python
EVENT_TASK = json.dumps({
    "event_id": "ev_abc123",
    "event_type": "pull_request.opened",
    "project_id": "proj_42",
    "repository": "acme/sdk",
    "actor": "octocat",
    "pull_request": {"number": 142, "sha": "deadbeef", "title": "Add refresh-token rotation"},
})

result = graph(EVENT_TASK, invocation_state={
    "project_config": project_config,   # repo mapping, docs path, channels
    "db_pool": db_pool,                 # any non-JSON-serializable runtime handle
})
```

Edge conditions that need runtime context opt into it (protocol
`EdgeConditionWithContext` in `strands.multiagent.graph`):

```python
from strands.multiagent.graph import GraphState

def require_review(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
    policy = invocation_state["project_config"].get("review_policy", "always")
    return policy in ("always", "risky")

# legacy plain callables (state only) are auto-detected — no migration needed.
# always guard on presence: session persistence re-evaluates conditions at any time
def eval_passed(state: GraphState) -> bool:
    return "evaluate" in state.results and node_data(state, "evaluate")["passed"]
```

`GraphState` (`strands.multiagent.graph`) exposes `results: dict[str, NodeResult]`,
`task`, `status`, `completed_nodes`, `failed_nodes`, `interrupted_nodes`,
`execution_order`, and accumulated usage metrics.

---

## 3. Agent inventory

All agents live in the scaffolded `src/draftly/agents/**` modules. Each is a plain
`Agent` with a system prompt and tools. Tools already scaffolded under
`src/draftly/tools/` (GitHub branch/commit/PR/comment, Slack/Discord post + search,
doc structure/frontmatter/markdown, hybrid/semantic/keyword search).

| Node | Agent | Tools (scaffolded) | Output |
| --- | --- | --- | --- |
| `classify` | EventClassifier (`agents/shared/`) | none (pure reasoning) | pydantic `EventClassification` via `structured_output_model` |
| `context` | ContextAgent (`agents/shared/`) | search tools, GitHub get PR/issue, Slack/Discord search | evidence bundle JSON |
| `research` | ResearchSwarm (nested Swarm, `agents/shared/subagents.py`) | per-channel agents (GitHub / Slack / Discord / Docs) | evidence summary |
| `impact` | ImpactAgent (`agents/documentation/analyzer.py`) | doc search, code search, `get_diff`, `get_files` | `{doc: {impact: HIGH/MEDIUM/LOW/NONE, evidence: [...]}}` |
| `answer` / `update` / `create` | AnswerWriter (`agents/support/answer_writer.py`), DocWriter (`agents/documentation/writer.py`) | doc read/write, GitHub PR tools | response text or doc change plan |
| `evaluate` | Evaluator — **deterministic custom node** (`orchestration/nodes/evaluate.py`), optionally LLM-augmented | — | `{passed: bool, score: float, reasons: [...]}` |
| `deliver` | Delivery agent (`orchestration/nodes/publish.py`) | `create_branch`, `create_commit`, `create_pull_request`, `post_message` | delivery receipt |
| review gate | not an agent — a hook interrupt (see §5) | — | — |

### 3.1 Classification via structured output

```python
from pydantic import BaseModel
from strands import Agent

class EventClassification(BaseModel):
    surface: str            # "pull_request" | "issue" | "support_question"
    change_type: str        # "documentation_only" | "bug_fix" | "new_feature" |
                            # "api_change" | "breaking_change" | "deprecation" | ...
    urgency: str            # "low" | "medium" | "high"
    reason: str

classifier = Agent(
    name="event_classifier",
    system_prompt=(
        "You classify developer events for a documentation-intelligence system. "
        "Classify the change type and how urgently documentation may be affected."
    ),
    structured_output_model=EventClassification,
)
```

---

## 4. The unified Draftly Graph

This is the core deliverable. It implements doc §13 (production graph) and §28
(final architecture). Built with `GraphBuilder` from `strands.multiagent`.

```python
import json
from strands import Agent, tool
from strands.multiagent import GraphBuilder, Swarm
from strands.multiagent.graph import GraphState
from strands.session import FileSessionManager

from draftly.orchestration.routing.conditions import (
    is_valid_surface,                 # classifier structured-output guard
    route_to_answer, route_to_update, route_to_create,
    research_sufficient, needs_revision, eval_passed, generated,
)
from draftly.orchestration.nodes.evaluate import EvaluatorNode  # custom deterministic node
from draftly.agents.shared import classifier, context_agent, delivery_agent, review_gate_hook
from draftly.agents.shared.subagents import build_research_swarm
from draftly.agents.documentation import impact_agent, writer_agent
from draftly.agents.support import answer_agent

def build_draftly_graph(session_manager: FileSessionManager) -> "Graph":
    research_swarm: Swarm = build_research_swarm()   # §4.3

    builder = GraphBuilder()
    builder.set_graph_id("draftly-main-graph")

    # ── intake / classification ────────────────────────────────────────────────
    builder.add_node(classifier, "classify")
    builder.set_entry_point("classify")        # explicit; auto-detected otherwise

    # ── three event surfaces (parallel branches) ───────────────────────────────
    builder.add_node(context_agent, "context")     # shared across all three
    builder.add_edge("classify", "context",
                     condition=is_valid_surface)   # reads classifier structured output

    # ── research / grounding ───────────────────────────────────────────────────
    builder.add_node(research_swarm, "research")   # nested Swarm as a node
    builder.add_edge("context", "research")

    # ── documentation impact analysis ──────────────────────────────────────────
    builder.add_node(impact_agent, "impact")
    builder.add_edge("research", "impact")

    # ── generation: answer vs update vs create (conditional fan-out) ───────────
    builder.add_node(answer_agent, "answer")
    builder.add_node(writer_agent, "update")
    builder.add_node(writer_agent, "create")

    builder.add_edge("impact", "answer",  condition=route_to_answer)   # support surface
    builder.add_edge("impact", "update",  condition=route_to_update)   # docs exist
    builder.add_edge("impact", "create",  condition=route_to_create)   # docs missing

    # ── evaluation + quality gates ─────────────────────────────────────────────
    evaluator = EvaluatorNode("evaluate")          # custom deterministic node
    builder.add_node(evaluator, "evaluate")
    # each generation branch funnels into the evaluator (OR-semantics, see §4.2)
    builder.add_edge("answer", "evaluate", condition=generated)
    builder.add_edge("update", "evaluate", condition=generated)
    builder.add_edge("create", "evaluate", condition=generated)

    # cyclic revise loop: evaluate → (FAIL) → update/create → evaluate
    builder.add_edge("evaluate", "update", condition=needs_revision)
    builder.add_edge("evaluate", "create", condition=needs_revision)

    # ── human review + delivery ────────────────────────────────────────────────
    builder.add_node(delivery_agent, "deliver")
    builder.add_edge("evaluate", "deliver", condition=eval_passed)

    # safety rails for the revise cycle
    builder.set_max_node_executions(10)      # hard cap on total node executions
    builder.set_execution_timeout(600)       # 10-minute wall clock
    builder.set_node_timeout(180)            # per-node ceiling
    builder.reset_on_revisit(True)           # writers start clean on each loop

    # persistence across interrupt/resume in stateless HTTP deployments
    builder.set_session_manager(session_manager)

    graph = builder.build()
    graph.add_hook(review_gate_hook, BeforeNodeCallEvent)   # §5 human review
    return graph
```

> The graph is invoked with `result = graph(event_task, invocation_state={...})`
> or `await graph.invoke_async(event_task, invocation_state=...)`. Results expose
> `result.status`, `result.execution_order` (each `GraphNode` has `.node_id`,
> `.execution_time`, `.result`), `result.failed_nodes`, and `result.execution_time`.

### 4.1 Node roles, summarized per branch

- **PR branch** (`is_pr_event`): classify → context → research → impact → `update`/`create`
  → evaluate → review → `deliver` (open a docs PR).
- **Issue branch** (`is_issue_event`): classify → context → research → impact → `answer`
  (or update/create if a gap is found) → evaluate → review → `deliver` (reply on the issue).
- **Support branch** (`is_support_event`): classify → context → research → impact →
  `answer` → evaluate → review → `deliver` (reply in Slack/Discord thread) →
  **feedback loop** records the question and detects gaps (§6).

### 4.2 Two Python-specific semantics you must handle

1. **Dependency fan-in is OR, not AND** (docs and source: a node fires when *any*
   incoming edge's source completes). The evaluate/deliver/context nodes have multiple
   incoming edges, so gate them with a condition factory to get AND semantics:

```python
from strands.multiagent.graph import GraphState
from strands.multiagent.base import Status

def all_dependencies_complete(required: list[str]):
    """AND semantics: fire only when every listed node completed successfully."""
    def check(state: GraphState) -> bool:
        return all(
            nid in state.results and state.results[nid].status == Status.COMPLETED
            for nid in required
        )
    return check

builder.add_edge("answer", "evaluate", condition=all_dependencies_complete(["answer"]))
builder.add_edge("update", "evaluate", condition=all_dependencies_complete(["update"]))
builder.add_edge("create", "evaluate", condition=all_dependencies_complete(["create"]))
```

2. **Revisited nodes accumulate agent state** in Python unless you call
   `builder.reset_on_revisit(True)` (done above) — otherwise the revise loop grows the
   writer's context on every lap.

### 4.3 Research Swarm (Graph = governance, Swarm = exploration)

```python
from strands import Agent
from strands.multiagent import Swarm

def build_research_swarm() -> Swarm:
    github_agent = Agent(name="github_researcher",
        system_prompt="You research GitHub issues, PRs, and release history for evidence.",
        tools=[get_issue, get_pull_request, get_diff, get_files, search_code])
    slack_agent = Agent(name="slack_researcher",
        system_prompt="You search Slack history for related conversations and answers.",
        tools=[search_messages, get_thread])
    discord_agent = Agent(name="discord_researcher",
        system_prompt="You search Discord history for related conversations and answers.",
        tools=[search_messages, get_thread])
    docs_agent = Agent(name="docs_researcher",
        system_prompt="You search the documentation store and report coverage.",
        tools=[semantic_search, keyword_search, hybrid_search])

    return Swarm(
        [github_agent, slack_agent, discord_agent, docs_agent],
        entry_point=github_agent,
        max_handoffs=20,
        max_iterations=20,
        execution_timeout=900.0,
        node_timeout=300.0,
        repetitive_handoff_detection_window=8,
        repetitive_handoff_min_unique_agents=3,   # no ping-pong between agents
    )
```

Swarm members coordinate autonomously via the injected `handoff_to_agent` tool and
shared context; the graph treats the swarm as a single node whose final message is
`state.results["research"].result`. Add the swarm to the graph with
`builder.add_node(research_swarm, "research")`.

### 4.4 Deterministic custom nodes (evaluation, idempotency checks)

Extend `MultiAgentBase` and implement `invoke_async` (verified signature:
`invoke_async(self, task, invocation_state=None, **kwargs) -> MultiAgentResult`).
Custom nodes must wrap their structured payload in an `AgentResult` message — the
graph feeds node results forward and reads `state.results[node_id].result.message`,
so a bare dict is not accepted. Use one shared helper:

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
        message=Message(content=[ContentBlock(text=json.dumps(data))], role="assistant"),
        metrics=EventLoopMetrics(),
        state=None,
    )

def node_data(state, node_id: str) -> dict:
    """Read a custom node's structured payload from graph state.

    The graph stores the node's MultiAgentResult as state.results[node_id].result;
    the AgentResult we wrapped lives one level deeper (keyed by the node's own name).
    """
    node_result = state.results[node_id].result
    if isinstance(node_result, MultiAgentResult):
        node_result = node_result.results[node_id].result
    block = node_result.message["content"][0]   # Message is a TypedDict
    return json.loads(block["text"])

class EvaluatorNode(MultiAgentBase):
    """Deterministic quality gate: grounding, completeness, source coverage."""

    def __init__(self, name: str = "evaluate"):
        self.name = name
        self.iteration = 0

    async def invoke_async(self, task, invocation_state=None, **kwargs) -> MultiAgentResult:
        self.iteration += 1
        # pull earlier node outputs via node_data(state, ...) — or from task/results
        evidence = ...   # evidence bundle produced by research/impact nodes
        draft = ...      # candidate answer or doc change
        score = compute_quality(evidence, draft)   # e.g. citation coverage, completeness
        passed = score >= 0.9 or self.iteration >= 3   # bound the loop
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={self.name: NodeResult(result=agent_result({
                "passed": passed, "score": score,
                "reasons": ["grounded in 12 sources", "covers rotation + revocation"],
            }))},
        )
```

Conditions then read the structured payload:

```python
def eval_passed(state) -> bool:
    return "evaluate" in state.results and node_data(state, "evaluate")["passed"]
```

> **Conditions must be defensive.** When a session manager is attached (always, in
> production), the SDK persists graph state after *every* node via
> `AfterNodeCallEvent`, which calls `serialize_state()` → `_compute_ready_nodes_for_resume()`
> and evaluates **every** edge condition — including edges whose source node has not
> run yet. `state.results[node_id]` may be absent at any moment, so every condition
> must guard on presence and be cheap + side-effect free. (Verified against
> `strands-agents` 1.52.0: without the guard, a session manager attached to a graph
> with a revise loop crashes mid-run.)

---

## 5. Human review: interrupt-based gate

Human review is a first-class gate (doc §19), not a UI button. Two complementary
mechanisms, both verified in the SDK:

### 5.1 Primary: interrupt before the delivery node

A graph-level hook on `BeforeNodeCallEvent` raises an interrupt when the `deliver`
node is about to run and policy requires review. The graph halts with
`status == Status.INTERRUPTED`; the web app presents the interrupt to a human; the
caller resumes the graph with the response.

```python
from strands.hooks import BeforeNodeCallEvent, HookProvider, HookRegistry

class ReviewGate(HookProvider):
    """Pause before delivery; resume with approval or cancel with rejection."""

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.gate)

    def gate(self, event: BeforeNodeCallEvent) -> None:
        if event.node_id != "deliver":
            return
        decision = event.interrupt("doc-review", reason={
            "run_id": event.invocation_state["run_id"],
            "summary": event.invocation_state["delivery_summary"],   # diff/PR preview
            "evaluation": event.invocation_state["evaluation"],
            "evidence_count": event.invocation_state["evidence_count"],
        })
        if decision.get("approved") is not True:
            event.cancel_node = f"Rejected by reviewer: {decision.get('comment', '')}"
```

Caller side — the FastAPI review endpoint collects the human's decision and resumes.
The interrupt **instance id** (not the interrupt name) comes from the result:

```python
# run 1 returned: result.status == Status.INTERRUPTED
for interrupt in result.interrupts:      # each has .id, .name, .reason
    store_interrupt(run_id, interrupt.id, interrupt.reason)   # show reason in review UI

# POST /runs/{run_id}/review  {"approved": true, "comment": "LGTM"}
response = {"interruptResponse": {
    "interruptId": interrupt_id,          # result.interrupts[i].id — instance UUID
    "response": {"approved": True, "comment": "LGTM"},
}}
result = graph([response], invocation_state=...)
```

This end-to-end flow (revise loop → interrupt at the delivery gate → session restore
on a fresh graph → resume → delivery) is verified against `strands-agents` 1.52.0.

Requirements on the resume path:

- **Stateless deployment** (webhook worker per request): construct the graph with a
  session manager so interrupt state survives between HTTP requests —
  `builder.set_session_manager(FileSessionManager(session_id=run_id, storage_dir=...))`,
  or a CockroachDB-backed `SessionManager` subclass. Swarm accepts `session_manager=`
  too. Note the session manager **restores the interrupted state when the graph is
  constructed**, so build the graph per run and never re-invoke a still-interrupted
  graph with a plain string task (the SDK raises
  `TypeError: must resume from interrupt with list of interruptResponse's`).
- Interrupts are **free-form**: `name` (unique per event), JSON-serializable `reason`
  (shown to the reviewer), JSON-serializable `response` (any shape you choose).
- `result.status == Status.INTERRUPTED` and `result.interrupted_nodes` tell you the
  graph is waiting; `result.interrupts` carries the instance ids for resume; nodes
  already in flight run to completion on resume.

### 5.2 Secondary: `HumanInTheLoop` on delivery tools

For defense-in-depth on the delivery agent, attach the vended intervention so any
mutation tool (`create_pull_request`, `post_message`, ...) that slips through the
gate still requires approval — with an LLM risk classifier deciding per call:

```python
from strands.vended_interventions.hitl import HumanInTheLoop

delivery_agent = Agent(
    name="delivery",
    tools=[create_branch, create_commit, create_pull_request, post_message],
    interventions=[
        HumanInTheLoop(
            allowed_tools=[],            # nothing bypasses; or ["*", "!create_pull_request"]
            classifier=True,             # LLM risk classifier per tool call
            enable_trust=False,          # reviewers can answer 't' to trust a tool for the session
        ),
    ],
)
```

Use raw interrupts (§5.1) when you need multi-step interaction or custom shapes;
use `HumanInTheLoop` when simple approve/deny gating with an allow-list is enough.

---

## 6. The feedback loop: support questions → `DocumentationGap`

Doc §7–8, §26. Implemented as a **separate feedback graph** (`feedback_graph.py`) run
on a schedule (croniter is already a dependency) and after every support run.

Data model (CockroachDB, doc §25): `support_questions(id, source, source_message_id,
repository, normalized_question, embedding vector(1536), answer_status, created_at)`.

```sql
-- 1. every support run records its question (with embedding)
INSERT INTO support_questions (id, source, source_message_id, repository,
                               normalized_question, embedding, answer_status)
VALUES ($1, $2, $3, $4, $5, $6, $7);

# 2. cluster by semantic similarity (pgvector cosine)
SELECT q1.id AS cluster_seed, q2.id AS related, q1.normalized_question
FROM support_questions q1
JOIN support_questions q2
  ON q1.embedding <=> q2.embedding < 0.15
 AND q1.id <> q2.id
WHERE q1.created_at > now() - interval '14 days';

# 3. coverage analysis per topic
SELECT topic,
       count(*)                       AS occurrences,
       count(DISTINCT source)         AS sources,
       bool_and(doc_coverage >= 0.6)  AS documented
FROM support_clusters
GROUP BY topic
HAVING count(*) >= 5;                 -- threshold: recurring pain
```

For topics with high occurrences and low doc coverage, insert a
`documentation_gaps` row (topic, severity, evidence_count, affected_documents,
source_of_truth, recommended_action, status='open') and enqueue a documentation run
for the affected repo — closing the loop that doc §12 calls the core product loop.

The feedback graph itself is a small Strands Graph: `summarize_clusters → detect_gaps →
prioritize → (docs graph if gaps found)`, using the same interrupt-based human review
before any documentation PR is opened.

---

## 7. Idempotency and audit (doc §23–24)

**Idempotency** lives in the ingestion layer (`app/composition/events.py` +
`app/pipelines/*.py`), *before* the graph runs:

- Unique index on `(event_id, project_id, workflow_type)` in the `events` table.
  Persist Slack/Discord message IDs, GitHub issue IDs, and PR SHAs.
- If the key exists, return the existing run — never invoke the graph twice for a
  replayed webhook. A `pull_request.synchronize` delivered twice must produce one doc PR.
- Use `builder.set_graph_id("draftly-main-graph")` so session state and traces are
  namespaced per graph identity.

**Audit trail**: for every run, write `agent_runs` + `agent_steps` rows covering:
trigger → evidence → agents → tool calls → generated artifact → evaluation → approval
→ delivery. The hook provider in §8 writes these rows; approvals are captured in the
review endpoint; delivery receipts come from the `deliver` node result.

---

## 8. Observability: hooks → traces, metrics, audit (doc §21)

Hooks are the supported extension point (verified vocabulary — attach via
`agent.add_hook(callback, EventType)` or `graph.hooks.add_callback(EventType, cb)` /
`graph.add_hook(cb, EventType)`; bundle many callbacks in a `HookProvider`).

```python
from strands.hooks import (
    BeforeNodeCallEvent, AfterNodeCallEvent, AfterToolCallEvent,
    AfterInvocationEvent, MultiAgentHandoffEvent, HookProvider, HookRegistry,
)

class RunAuditLogger(HookProvider):
    """Persist per-step telemetry and audit rows for a run."""

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeNodeCallEvent,   self.node_start)
        registry.add_callback(AfterNodeCallEvent,    self.node_end)
        registry.add_callback(AfterToolCallEvent,    self.tool_end)
        registry.add_callback(AfterInvocationEvent,  self.run_end)

    def node_start(self, event: BeforeNodeCallEvent) -> None:
        # INSERT INTO agent_steps (run_id, node_id, status, started_at) ...
        pass

    def node_end(self, event: AfterNodeCallEvent) -> None:
        # INSERT ... status=COMPLETED, execution_time, tokens, result_summary
        # event.node_id, event.invocation_state["run_id"]
        pass

    def tool_end(self, event: AfterToolCallEvent) -> None:
        # INSERT INTO agent_steps (kind='tool', name=event.tool_use["name"],
        #                          input=event.tool_use["input"], duration=...)
        pass

    def run_end(self, event: AfterInvocationEvent) -> None:
        # close out agent_runs with status, duration, accumulated usage
        pass
```

Attach on the graph: `builder.set_hook_providers([RunAuditLogger(), ReviewGate()])`.
For live dashboard events, stream the graph instead of a blocking call —
`async for event in graph.stream_async(task)` yields `multiagent_node_start`,
`multiagent_node_stream`, `multiagent_node_stop`, and `multiagent_result` events,
which the backend can fan out over WebSocket/SSE to the frontend.

For build-time evaluation (doc §20), run the Strands Evals SDK (see
`implementation-plan.md` §8.10) against a golden dataset of PR/issue/support
fixtures in CI — the hook trace is the shared substrate. If the real SDK is
not yet published, pin DeepEval as a temporary interim with the same
metric mapping (§8.10).

---

## 9. Failure handling (doc §22)

Python graph semantics: **node failures raise** (fail-fast), orchestrator-level limit
violations return a FAILED result. Wrap the invocation boundary:

```python
async def invoke_workflow(task: str, invocation_state: dict) -> None:
    try:
        result = await graph.invoke_async(task, invocation_state=invocation_state)
    except Exception as exc:                      # a node raised
        await notify_incident(run_id, exc)        # unrecoverable → incident
        raise

    if result.status == Status.FAILED:
        # inspect result.failed_nodes / result.interrupted_nodes
        pass

    if result.status == Status.INTERRUPTED:
        # awaiting human review — persist interrupt IDs, expose to dashboard
        pass
```

Workflow-level policies:

| Situation | Policy |
| --- | --- |
| retryable failure (transient tool error) | `AfterToolCallEvent.retry` / `AfterModelCallEvent.retry` hook (verified: retry re-invokes with same `tool_use_id`) |
| insufficient evidence | condition routes research back through a bounded loop (`research_sufficient`), capped by `set_max_node_executions` |
| confidence too low / ambiguous | route to the review gate — the human decides instead of the model guessing |
| unrecoverable | mark run FAILED, record incident, notify; never fabricate an answer to satisfy the workflow |

---

## 10. Build order (maps to the empty scaffold)

| Step | Files to fill | Verify with |
| --- | --- | --- |
| 1. State + tools | `orchestration/state/*.py`, `tools/**` (wire the existing functions as `tool()`s) | pytest: tool round-trips |
| 2. Agents | `agents/shared/`, `agents/documentation/*`, `agents/support/*`, `agents/github/*`, `agents/prompts.py`, `agents/schemas.py` | pytest: classifier on fixtures |
| 3. PR graph end-to-end | `orchestration/graphs/documentation_graph.py`, `orchestration/nodes/*`, `orchestration/routing/conditions.py` | integration test: fake webhook → docs PR (review gate stubbed to approve) |
| 4. Support loop + gaps | `orchestration/graphs/support_graph.py`, `feedback_graph.py`, `agents/support/*` | test: 20 clustered questions → 1 gap |
| 5. Issue loop | `orchestration/graphs/issue_graph.py`, `routing/classifiers.py` | test: bug vs support routing |
| 6. Human review API | `app/api/routes/*` review endpoints + session manager wiring in `app/composition/workers.py` | test: interrupt → approve → resume → deliver |
| 7. Observability + audit | `agents` hooks module, `RunAuditLogger` in `app/composition/agents.py` | test: run → rows in `agent_steps` |
| 8. Evaluation golden suite | `evaluation/` (Strands Evals SDK) | `uv run pytest tests/evaluation` |

---

## 11. Appendix: SDK caveats & alternatives

- **Python vs TypeScript differ** in ways that matter if you ever port the frontend
  to TS: TS Graph = AND dependency semantics by default, individual node scheduling
  with `maxConcurrency`, stateless nodes by default (`preserveContext: true` to
  accumulate), and interrupts must be resumed with `new InterruptResponseContent(...)`.
  This guide targets Python only.
- **Python Graph executes in batches** (wait for a batch, then schedule the next set);
  the graph is not a streaming pipeline per node.
- **Interrupts must carry JSON-serializable `reason` and `response`**; keep DB handles
  and config in `invocation_state`, never in prompt text.
- **`reset_on_revisit(True)` is required** for the revise loop in Python, or the writer
  accumulates every iteration's messages.
- **Set execution bounds on every cyclic topology** (`set_max_node_executions`,
  `set_execution_timeout`, `set_node_timeout`) — the SDK warns when a cyclic graph has
  none.
- **Node cancellation** is available via `BeforeNodeCallEvent.cancel` /
  `event.cancel_node` (Python yields a FAILED status for the cancelled node); use it
  for the REJECT path in human review.
- `GraphResult` exposes `execution_order` (each entry: `.node_id`, `.result`,
  `.execution_time`, `.execution_status`) — use it to render the doc §21 run trace
  ("Agents: ✓ EventClassifier 0.8s ✓ PRAnalyzer 2.1s ...").