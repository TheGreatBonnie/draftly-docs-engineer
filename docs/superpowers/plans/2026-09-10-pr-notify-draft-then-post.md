# PR Notify: Draft-Then-Post Node for Pull-Request Events

> Execution status (2026-09-10): Tasks 1–6 all complete, implemented TDD and
> verified green. Deviation: `NotifyReceipt` is a Pydantic `BaseModel` (mirrors
> the schema-flavor used by siblings), not a custom `Importable` — Agent API is
> `invoke_async` (verified), not `execute`. The optional phase-5 assertion was
> N/A: `tests/workflows/test_phase5_runner_events.py` only builds `FakeGraph`
> runners, never the real PR graph.

Date: 2026-09-10
Status: Draft
Spec: Approved design from this session's brainstorming ("Looks good proceed");
the implementation plan for the notify node described in `RUN_PR_WORKFLOW.md`
and expanded below.

## Positive spec

A Draftly run reacting to a `pull_request.opened` event must tell the author,
in a comment on the PR, what Draftly did:

- If the impact analysis found a documentation gap (`action` ∈ answer/update/create
  with `affected_documents`), post a comment explaining that Draftly will
  generate docs for this PR and listing the affected documents.
- If no doc gap was detected (`action` == `none`), post a comment saying no
  documentation changes are needed for this PR.
- The content cannot be predicted at build time — it depends on the run's
  impact verdict — so it must be composed by an LLM. But an LLM must never
  perform a mutation. Draft-then-post: the LLM only returns a `NotifyReceipt`
  (JSON, no tools); a deterministic node posts it.

## Negative spec

- NOT a single LLM agent that calls `create_comment` as a tool. The comment
  is a mutation; an LLM with a write tool in prompt reach can call it
  arbitrarily (the class of bug that burned the writer and delivery scoping).
  The LLM is a strictly read-only draft composer, like the changelog agent.
- NOT a hardcoded "assistant said hi" message: the user explicitly asked for
  the comment to explain what Draftly will be doing, branching on whether a
  doc gap was found. The LLM needs the impact verdict, so the notify node must
  be downstream of `impact`, not `classify`.
- NOT dependent on the delivery tool's `create_comment` (mutation-path scopes
  only hold on github grounding and are reserved for document delivery). The
  post is a separate deterministic `comment_factory` call, injected so tests
  never hit the network.
- NOT a sequential extra leg: the +2 nodes run in parallel with the writer
  branch, keeping the worst-case node count under `max_node_executions=15`.
- NOT posted for releases: `release.published` routes to the same
  documentation graph but must not get a notify comment (no PR comment exists
  to post to, and the runner gates on `.opened` anyway).

## Strategies

- **Incremental, dependency-first (TDD).** Each test is green before the code
  it tests exists is worth anything; depend on existing patterns
  (`build_changelog_agent`, `ChangelogEvaluatorNode`, `EvaluatorNode`,
  `none_and_release` condition) rather than inventing new shapes.
- **Deterministic, best-effort post (tombstone + never-fail).** The post node
  never raises; a failed or absent receipt degrades to a logged, no-op
  COMPLETED result (mirror the rubric-grader's `except Exception:
  logger.warning(...)` degrade pattern). The run's success is not coupled to
  whether the comment posted.
- **Idempotent by session restore.** Strands resume skips completed nodes
  (`_compute_ready_nodes_for_resume`), so notify_post won't re-fire a comment
  on a resumed session. Verify this at graph level, don't add a manual guard
  unless the test proves one is needed.

## File structure

```
draftly-agent-backend/src/draftly/
  agents/
    notify.py                         NEW  build_notify_agent + NotifyAgent doc
    schemas.py                              ADD NotifyReceipt (Importable)
    prompts.py                              ADD NOTIFY_PROMPT
    documentation/
      (changelog.py = pattern to copy)      (read-only)
  orchestration/
    nodes/
      notify_post.py                  NEW  NotifyPostNode (deterministic)
      base.py                               ADD shared original_task() helper
      (changelog_evaluate.py = pattern)     (read-only)
    graphs/content_graph.py                 REFACTOR: use shared original_task()
    graphs/documentation_graph.py           wire notify + notify_post
    routing/conditions.py                   ADD pull_request_opened()
  app/composition/agents.py                 ADD notify_agent factory
  integrations/github/client.py             (read-only; create_comment @ client.py:275)

draftly-agent-backend/tests/
  agents/test_notify_agent.py         NEW
  nodes/test_notify_post.py           NEW
  conditions/test_conditions.py             ADD pull_request_opened cases
  graph/conftest.py                         ADD NotifyReceipt to stub_model; comment factory
  graph/test_documentation_graph.py         UPDATE order assertions + stub comment factory
  graph/test_review_gate.py                 UPDATE stub comment factory (PR runs)
  graph/test_session_restore.py             UPDATE stub comment factory; resume no-repost test
  workflows/test_phase5_runner_events.py    (read-only; assert notify_post presence in opened run)
```

## Bite-sized tasks

### Task 1 — `NotifyReceipt` schema + `NOTIFY_PROMPT` + `build_notify_agent`
- `src/draftly/agents/schemas.py`: add
  ```python
  class NotifyReceipt(Importable):
      should_notify: bool = False
      kind: str = ""      # "gap_detected" | "no_gap"
      body: str = ""
  ```
  (frozen dataclass like `ImpactAnalysis`; check exact flavor used by siblings
  and mirror it).
- `src/draftly/agents/prompts.py`: `NOTIFY_PROMPT`. Mention the event
  (pull_request.opened), that `From impact:` carries the verdict
  (`action`, `affected_documents`, `rationale`), two cases:
  - action ∈ answer/update/create → `should_notify=True`,
    `kind="gap_detected"`, body says Draftly will generate docs for this PR
    and lists `affected_documents`.
  - action == none → `should_notify=True`, `kind="no_gap"`, body says no
    documentation changes are needed.
  - never fabricate; read the verdict from the impact payload; keep the body
    concise author-facing markdown (mirror length policy of CHANGELOG_PROMPT).
  Remember the effective prompt is
  `build_prompt(NOTIFY_PROMPT, output_model=NotifyReceipt)` — the
  `{output_contract}` slot.
- `src/draftly/agents/notify.py`:
  ```python
  def build_notify_agent(model, tools=()):
      return Agent(
          name="pr_notify",
          system_prompt=build_prompt(NOTIFY_PROMPT, output_model=NotifyReceipt),
          model=model,
          tools=tools,
          structured_output_model=NotifyReceipt,
          description="Composes a PR comment explaining Draftly's doc work.",
      )
  ```
  No tools: `build_notify_agent(model, [])` (mirror `build_changelog_agent`).
  The input already carries everything: `Original Task` (event JSON:
  repository, pull_request.number/title) + `From impact` (impact payload).
- TDD — `tests/agents/test_notify_agent.py` (mirror `test_changelog_agent.py`):
  - agent name == `pr_notify`.
  - `_default_structured_output_model` is `NotifyReceipt`.
  - tools list is empty.
  - executes with a StubModel scripted `NotifyReceipt` and returns it as
    `structured_output` (mirror existing changelog agent test).

### Task 2 — shared `original_task()` helper
- `src/draftly/orchestration/nodes/base.py`: add `original_task(task) -> dict`,
  moving the logic from `content_graph._original_task` (parses a JSON string,
  or extracts the `Original Task:` JSON block from a ContentBlock list).
- `src/draftly/orchestration/graphs/content_graph.py`: replace the local
  `_original_task` def with `from ...nodes.base import original_task` aliased
  `as _original_task` so existing call sites (`content_graph.py:46`) are
  unchanged — one public source of truth.
- TDD: existing content_graph evaluation/judge tests exercise the string case;
  add a unit test in `tests/nodes/` (or extend Task 4's test file) covering the
  list-of-ContentBlocks case with a trailing `\nInputs...` section.

### Task 3 — `pull_request_opened` condition
- `src/draftly/orchestration/routing/conditions.py`: add
  ```python
  def pull_request_opened(state) -> bool:
      if not isinstance(state.task, str): return False
      try: data = json.loads(state.task)
      except json.JSONDecodeError: return False
      return data.get("event_type") == "pull_request.opened"
  ```
  Mirror `none_and_release`'s defensive task parsing.
- TDD — `tests/conditions/test_conditions.py` (use existing
  `_state_with_results`/`_impact_result` helpers):
  - `pull_request.opened` → True.
  - `release.published` → False.
  - `issues.opened` → False.
  - `pull_request.merged`/`pull_request.closed` → False.
  - non-JSON / non-string task → False.
  - short-circuit: returns False without touching `state.results` (no impact
    node needed — it is a pure event-type gate).

### Task 4 — `NotifyPostNode` (deterministic post)
- `src/draftly/orchestration/nodes/notify_post.py`: a `MultiAgentBase` node
  (mirror `ChangelogEvaluatorNode` scissors):
  - `__init__(self, name="notify_post", *, comment_factory=None,
    lazy_commenter=None)` — `comment_factory` is an injectable callable
    returning an async object with
    `create_comment(repository, pull_request_number: int, body) -> dict`
    (GitHubClient shape). When None, lazily default to
    `lazy_commenter or GitHubClient` at invocation time (NOT at graph build
    time) so `current_installation_id()` from the runner contextvar is
    already set (`runner.py:262` sets it around invoke; the built-in default
    `GitHubClient()` in `client.py` reads it in `__init__`).
  - `invoke_async`:
    1. `deps = parse_node_input(task)`; `receipt = deps.get("notify", {})`.
    2. skip unless `receipt.get("should_notify")` and `body`;
       return COMPLETED `{"posted": False, "reason": "not_needed"|"no_receipt"}`.
    3. `event = original_task(task)`; guard `repository` and
       `pull_request.number` present; else `{"posted": False, "reason": "no_target"}`.
    4. resolve commenter via the injected factory/default; call
       `await commenter.create_comment(repository, pr_number, body)`.
    5. `try/except Exception` around the call → `{"posted": False,
       "reason": "error", "error": str(e)}`, logger.warning, status COMPLETED.
    6. success → `{"posted": True, "reference": result.get("html_url")
       or result.get("id")}`.
    Return `MultiAgentResult(COMPLETED, {self.name: NodeResult(result=
    agent_result(payload))})` — mirror the evaluator node's result shape.
  - This node is terminal (no outgoing edges) and best-effort; it must never
    control graph status.
- TDD — `tests/nodes/test_notify_post.py` (fabricate ContentBlocks like the
  changelog_evaluate tests; stub comment factory records calls, optionally
  raises):
  - should_notify + body + repo + number → create_comment called with the
    parsed repo `acme/api`, number 7, the body; posted=True.
  - should_notify False → no network, posted=False.
  - empty body → posted=False.
  - missing repository / missing pull_request.number in original task →
    posted=False, no call.
  - factory raises → status COMPLETED, posted=False, no exception escapes.
  - list-input variant: `original_task` parses `Original Task:` block from
    ContentBlocks (Task 2 coverage).
  - node always returns `Status.COMPLETED`.

### Task 5 — graph wiring + registry + test stubbing
- `src/draftly/orchestration/graphs/documentation_graph.py`:
  - import `build_notify_agent`, `NotifyPostNode`, `pull_request_opened`,
    `original_task` helpers as needed.
  - `notify_model = resolve_model_for_role(model, "notify")` (falls through
    to shared model).
  - `notify_builder = getattr(registry, "notify_agent", None) or
    build_notify_agent`; `notify_agent = notify_builder(notify_model, [])`.
  - `notify_post = NotifyPostNode("notify_post", comment_factory=...)`.
  - Add a keyword arg to `build_documentation_graph`:
    `comment_factory: Any = None` (a callable returning the GitHubClient-like
    commenter). thread it into NotifyPostNode. Production call sites
    (`build_graph_for_run`/runner) pass nothing → default GitHubClient used.
    (Mirror the `agents=` / `audit_repo=` pattern.)
  - Wiring:
    ```python
    builder.add_node(notify_agent, "notify")
    builder.add_node(notify_post, "notify_post")
    builder.add_edge("impact", "notify", condition=pull_request_opened)
    builder.add_edge("notify", "notify_post")
    ```
    placed with the generation fan-out block. notify is a parallel branch —
    it does NOT gate the writer path. Budget: +2 nodes in parallel keeps
    worst case well under `max_node_executions=15`.
  - Sequencing note: notify depends on impact only, so its edge condition can
    fire even when the impact action is `none` — exactly what we want (the
    "no gap" branch).
- `src/draftly/app/composition/agents.py`: add `notify_agent: Any = None`
  field to `AgentRegistry` and wire `notify_agent=build_notify_agent` in
  `build_agents()`.
- `tests/graph/conftest.py`:
  - `stub_model()`: add a scripted `NotifyReceipt` for the PR path, e.g.
    `{"should_notify": True, "kind": "gap_detected", "body": "Draftly will
    generate docs for this PR: docs/widgets.md"}`.
  - Add a `comment_factory` fixture returning a recording stub whose
    `create_comment` appends `(repository, pr_number, body)` to `calls` and
    returns `{"id": 1, "html_url": "https://github/acme/api/pull/7#issuecomment-1"}`.
- BREAKING order assertions — `tests/graph/test_documentation_graph.py`:
  - `test_full_pipeline_with_quality_gate` asserts an exact tail
    `order[4:] == ["update","evaluate","changelog","changelog_evaluate",
    "deliver"]`. With notify, execution becomes
    `impact → {update, notify} → {evaluate|notify_post} → ...`. Relax to
    ordered-membership: `impact` before `notify` before `notify_post`; and the
    generation/delivery relative order still holds; keep `order[0]=="classify"`,
    `order[-1]=="deliver"`, counts for update/evaluate.
  - Inject `comment_factory=comment_factory` in every PR-surface graph build in
    this file that invokes the graph with PR_TASK (e2e-1, e2e-3, memory-grounded,
    review-gate, session-restore, and any others running PR events) so notify_post
    uses the stub — otherwise the default GitHubClient tries real auth in CI.
  - `test_impact_none_skips_generation_and_delivery` (e2e-3, PR_TASK):
    assert `notify` and `notify_post` ARE now in order (they fire on the
    opened event even when action==none) while answer/update/create/evaluate/
    deliver stay absent; the stub comment factory called once with the
    scripted body.
  - Release tests (e2e-release-1 / e2e-release-none): assert `notify` and
    `notify_post` NOT in order (release events don't get PR notify).
- `tests/graph/test_review_gate.py`, `tests/graph/test_session_restore.py`:
  inject `comment_factory=comment_factory` in graph builds (they run PR_TASK).
- `tests/workflows/test_phase5_runner_events.py`: add an assertion on the
  opened-PR e2e that the run outcome reports notify_post as executed/completed
  (extend the existing full-run test; keep it read-only otherwise).

### Task 6 — session-resume idempotency test
- `tests/graph/test_session_restore.py`: new test — run PR_TASK to
  pending_review with a recording stub, then resume; assert
  `comment_factory.calls` has exactly ONE entry (soft-assert before adding a
  manual guard; strands resume skipping completed nodes should already hold).

## Testing instructions

- Test command: `uv run pytest -q` (workspace root of the Python app is
  `draftly-agent-backend/`, where `.venv/bin/python -m pytest` also works).
- Run per-task during implementation; final full suite must be green (only the
  pre-existing `tests/evaluation/test_online.py::test_build_online_task_env_state_carries_real_diff`
  env-dependent failure is allowed to remain).
- After implementation, `graphify update .` (AST-only) to refresh the project
  knowledge graph.