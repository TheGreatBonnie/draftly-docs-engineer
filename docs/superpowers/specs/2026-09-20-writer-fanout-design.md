# Writer Fan-out Design — One Documentation Task per Page/Bundle

## Context and problem

The PR documentation workflow (``draftly-agent-backend``) drives the whole
documentation change set of a PR through **one writer invocation**. The
``ImpactAnalysis`` output (``agents/schemas.py:56-63``) returns a flat
``action`` + ``affected_documents: list[str]`` + freeform ``evidence``. The
documentation graph (``orchestration/graphs/documentation_graph.py:366-372``)
routes to exactly one of ``answer`` / ``update`` / ``create``; the
``update``/``create`` nodes are single writer agents that handle every
affected page in one growing conversation.

A PR touching 10 pages and creating a new one becomes one large invocation.
The documented consequences (``docs/writer-agent-latency.md``):

- Context grows superlinearly; later model calls re-process all evidence.
- Evidence for unrelated pages competes for attention (wrong-page copy,
  contradictions, missed pages).
- Work is forced sequential (one agent, one thread).
- One timeout/rate-limit/JSON failure invalidates the whole job; the retry
  pays again for pages that already succeeded.
- The frontend only sees "writer started / writer completed".

The desired change: treat the eleven-page result as one coherent documentation
**changeset**, but treat each page or related-page bundle as a separate
**unit of execution** — isolated writer invocations, bounded concurrency,
per-page validation, per-page retry, one targeted global review.

## Goals

- One writer invocation per page/bundle, never one invocation for the whole
  PR's docs.
- Bounded concurrency (default 3 writers at once), no unbounded agent counts.
- Isolated agent conversation per task (framework-enforced).
- Only a failed page is retried; sibling pages are never re-drafted.
- Per-task progress ("3 of 11 pages completed") and per-task failure
  attribution reach the frontend.
- One global review pass that returns targeted corrections, never a full
  redraft.
- Delivery still produces one coherent documentation change set / PR.

## Non-goals

- No change to the ``answer`` route or the content-variant writers.
- No webhook/envelope *contract* break: existing consumers ignore unknown
  envelope types; ``node_start``/``node_stop`` semantics unchanged.
- No migration of historical draft rows; Section 3's per-path rule applies at
  read time only.
- ``ChangelogEntry.raw_markdown`` stays as-is.
- The human ReviewGate remains the final pre-delivery gate.

## Architecture

New graph shape (only the write tail changes):

```
classify → context → research → impact
  ├─(answer)─► answer ──────────────┐
  └─(update|create)─► document ──► review ─(clean)──► evaluate ─► changelog ─► deliver
                        │  ▲            └─(correct)──► document        (deterministic +
                        │  └── reviewer targets one page                human gate)
                        └── per-task retry inside the node
```

``document`` is a deterministic ``MultiAgentBase`` fan-out node (the same
pattern as ``EvaluatorNode`` / ``NotifyPostNode``). It expands the impact
task plan into per-task invocations of **fresh, isolated** writer Agents under
``asyncio.Semaphore(3)``, validates each page, retries only failures, and
emits compact per-task results.

### Component responsibilities

| Component | Responsibility |
|---|---|
| ``DocumentationTask`` (schemas) | One page/bundle unit: ``id, path, action, reason, related_symbols, evidence[], requirements[], bundle_id``. |
| ``ImpactAnalysis.tasks[]`` | Structured per-task plan emitted by the impact agent; fallback planner for restores. |
| ``FanOutWriterNode`` | Expands tasks, bounded-concurrency dispatch, per-task validation + retry, aggregated result payload. |
| ``WriterFactory`` | Builds a fresh isolated ``Agent`` per task (shared model, prompt, skills, tools). |
| ``DraftRepository.get_latest`` | Per-path latest sealed supersession (Section 3). |
| ``validate_page`` | Deterministic per-page gate (file sealed, concepts present, symbols/links/fences valid). |
| Reviewer node | Global cross-page coherence pass returning targeted corrections. |
| ``task_progress`` envelope | Out-of-band per-task progress by seq-shared sink. |

## Data model

### ``DocumentationTask`` (new, ``agents/schemas.py``)

```python
class DocumentationTask(BaseModel):
    id: str
    path: str
    action: str                # "update" | "create"
    reason: str = ""
    related_symbols: list[str] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    bundle_id: str | None = None
```

``ImpactAnalysis`` gains ``tasks: list[DocumentationTask] = []``. The existing
``action``/``affected_documents``/``evidence``/``rationale`` fields stay for
backward compatibility with the answer/none routes and offline fixtures.

Validation mirrors ``DocChangePlan``'s model_validator (``schemas.py:86-104``):
reject empty/absolute/escaping ``path``, duplicates across tasks (prevents two
concurrent writers editing the same file), and actions outside
``{"update","create"}``.

Plan of record: walk the impact prompt (``prompts.py:583``) with an output
section enumerating each affected document as a ``DocumentationTask`` with
scoped evidence and explicit do-not-document requirements.

Fallback planner (deterministic): ``tasks_from_impact(impact, research_evidence)``
expands a non-empty ``affected_documents`` into tasks (evidence attached by
path, empty ``requirements``) when ``tasks == []`` — covers session restores and
schema drift without an LLM.

## Writer factory & fan-out node

New ``orchestration/nodes/fan_out.py``.

```python
class FanOutWriterNode(MultiAgentBase):
    def __init__(self, name="document", *, model, tool_factory,
                 write_concurrency=3, limits=None, drafts_repo=None,
                 progress_sink=None): ...

    async def invoke_async(self, task, invocation_state, **kwargs):
        deps = parse_node_input(task)
        tasks = plan_tasks(deps["impact"], deps.get("research"))
        sem = asyncio.Semaphore(self.write_concurrency)

        async def run_one(t):
            async with sem:
                agent = self._factory.create(t)      # FRESH Agent per task
                result = await agent.invoke_async(
                    render_task_prompt(t), limits=self.limits_for(t))
                ok, reasons = await validate_page(t)
                return DocumentationResult(task_id=t.id, path=t.path, ok=ok, ...)

        results = await asyncio.gather(*[run_one(t) for t in tasks],
                                       return_exceptions=True)
        for failed in failed_tasks:                  # independent retry, once
            results.append(await run_one(failed))
        return aggregated_result(results)
```

Grounding (verified against the SDK and this repo):

- **Isolation is framework-enforced.** ``Agent`` defaults to
  ``concurrent_invocation_mode=THROW``: concurrent ``invoke_async`` on one
  instance raises ``ConcurrencyException``. Each task therefore uses its own
  ``Agent`` (shared model client, ``WRITER_PROMPT``, skills, draft tools),
  so message history / state / tool state never cross-contaminate.
- **One shared ``DraftScope`` per node execution.** ``NextGenerationHook``
  publishes one scope before the node fires (``draft_generation.py:64``). The
  fan-out node never re-sets it, so all concurrent writers address the same
  ``(run_id, org_id, generation)`` writing disjoint paths — safe because the
  duplicate-path validator guarantees no two tasks touch the same file.
- **Independent retry**: a failed task re-invokes only that task, once.
- **``limits``** cap turns/output tokens per task so one page cannot starve
  the set.
- **Node payload** is the compact per-task summary set (task_id, path, action,
  ok, reasons, evidence_refs) that ``evaluate``/``review``/``deliver`` consume
  in place of the old single ``DocChangePlan``.

``WriterFactory`` lives next to ``build_writer_agent``
(``agents/documentation/writer.py:17``).

## Draft store: per-path supersession

``get_latest(run_id)`` (``persistence/repositories/drafts.py:245``) currently
returns only the single **highest** sealed generation. Under fan-out a
per-task retry or a reviewer correction opens a new generation for **one
path**; every other page sealed in an older generation would otherwise vanish
from delivery.

New rule: *the latest sealed revision per path, across generations* — per
``path`` keep the row with the max ``generation`` (tie-break by latest
``sealed_at``/id).

- Whole-set supersede (full rejection → all tasks re-run → all paths in a
  newer generation) is unchanged.
- Partial supersession (one page re-run) keeps the untouched pages.
- Add ``get_path_latest(run_id, path)`` for per-task validation's "was this
  page sealed" check.

Callers verified safe: ``EvaluatorNode._store_draft`` (``evaluate.py:229``),
the ``get_drafted_docs`` tool (``tools/documentation/drafts.py:116``). No state
migration: ``get_latest`` is a read-time rule.

## Graph wiring

``documentation_graph.py``:

- Replace ``update_writer``/``create_writer`` with one
  ``FanOutWriterNode("document", ...)`` built from the same ``writer_model``
  and scoped writer tools. The SDK's duplicate-executor constraint
  (``documentation_graph.py:13-16``) no longer applies.
- ``add_node(document, "document")``; edge ``impact → document`` under
  ``route_to_update`` **or** ``route_to_create``; ``answer`` unchanged.
- ``document → review`` coherence edge; ``review → evaluate`` (clean verdict);
  ``needs_correction`` edge ``review → document`` feeds only corrected tasks
  back so the corrected set re-passes the deterministic gate before changelog.
- ``document → evaluate`` / ``review → evaluate`` wiring satisfies both the
  ``generated`` condition and the evaluate dependency scan;
  ``needs_revision_of("document")``; ``document → deliver`` content edge gated
  by ``delivery_content_ready``.
- ``NextGenerationHook.WRITER_NODE_IDS`` (``draft_generation.py:27``) becomes
  ``("document",)``.

Routing conditions (``orchestration/routing/conditions.py``) and
``evaluate.py:277`` swap ``update``/``create`` for ``document`` (answer keeps
its own edges).

Budgets: per-task ``limits`` keep the node inside the existing
``max_node_executions`` / ``node_timeout`` ceiling. The review-correction
loop (Section 5) is bounded by the same max-execution cap via the existing
revision-budget pattern on ``evaluate``.

## Global review

New LLM reviewer node between ``document`` and ``evaluate``
(``document → review → evaluate → changelog → deliver``), reusing the existing
reviewer agent shape (``prompts.py:851``).

- **Compact inputs**: the fan-out node deterministically derives per-page
  summaries from the store (heading list, extracted links, first paragraph,
  ``## References`` count) plus the impact ``tasks`` list. No extra LLM
  structured-output surface; no full-page redrafting by the reviewer.
- **Output**: targeted corrections keyed by ``task_id``/``path`` with
  instructions, and ``verdict: "clean" | "correct"``.
- **Routing**: ``clean`` → ``evaluate`` (today's deterministic gate +
  human ReviewGate, unchanged). ``correct`` → back to ``document`` via a
  ``needs_correction`` edge; the fan-out node re-invokes only the named tasks
  (per-path supersession keeps the rest).

## Progress / streaming

Child-writer invocations are not graph nodes, so ``filter_graph_event``
(``events/stream_envelope.py``) emits nothing for them. Add a new envelope
type ``task_progress`` with ``{task_id, path, action, status, position, total}``.

Transport: the deterministic node cannot stream through ``graph.stream_async``.
Emit via a progress sink wired into ``invocation_state`` (built at
``workflows/runner.py:476``), mirroring the shared-``stream_seq`` steering-sink
mechanism (``runner.py:193-246``) so envelopes keep coherent monotonic ``seq``.
``stream_envelope.py`` gains a ``task_progress_envelope(...)`` builder (pure,
redacted, table-tested). When no publisher is present (offline harness), the
node degrades to logging; the graph result payload still carries per-task
results.

## Testing & rollout

Unit: task planning + fallback planner + path validation; fan-out node
(bounded in-flight, failure isolation, one-step-per-task retry, duplicate-path
rejection); draft repository per-path supersession; ``task_progress`` envelope
redaction/round-trip; updated routing-condition matrix.

Graph/integration: reuse existing ``GraphBuilder``-based fixtures swapping
``update``/``create`` for ``document``; assert two-page impact → two isolated
writer invocations writing disjoint store paths; evaluate reads both; clean
verdict skips correction; a correction re-dispatches only the named task.

Rollout: (1) schema + store per-path supersession first (backward compatible);
(2) ``FanOutWriterNode`` behind a flag with ``write_concurrency=3`` while
``update``/``create`` wiring stays during a transition window; (3) reviewer
node + progress envelopes; (4) run the offline documentation evaluation
harness before/after to confirm no quality regression. Update
``docs/writer-agent-latency.md`` with an implementation-status note once
landed.

## References

- `docs/writer-agent-latency.md` — problem statement and proposed model.
- `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py`
- `draftly-agent-backend/src/draftly/agents/schemas.py`
- `draftly-agent-backend/src/draftly/agents/documentation/writer.py`
- `draftly-agent-backend/src/draftly/agents/documentation/draft_scope.py`
- `draftly-agent-backend/src/draftly/persistence/repositories/drafts.py`
- `draftly-agent-backend/src/draftly/orchestration/hooks/draft_generation.py`
- `draftly-agent-backend/src/draftly/events/stream_envelope.py`