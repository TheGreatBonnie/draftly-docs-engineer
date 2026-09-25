# Evaluate Subset Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the deterministic evaluator fails a multi-page docs revision, only the pages that failed evaluation are re-dispatched to the writer — not the entire bundle.

**Architecture:** `EvaluatorNode` currently concatenates every sealed page into one blob, emits a single `passed` boolean, and the fan-out re-derives and re-sends the full task list on every revise loop. The fix (1) makes the evaluator score each planned page independently against its path-scoped evidence, emitting `files` + `failed_files`; (2) makes `FanOutWriterNode` additionally filter its rebuilt task list by `evaluate.failed_files` (union with the existing review-corrections filter); (3) locks the wiring with an end-to-end graph test proving a second document execution dispatches only the failed page. Routing conditions are untouched — `needs_revision_of("document")` still fires on `passed is False`.

**Tech Stack:** Python 3.11 (draftly-agent-backend), Strands multiagent SDK, structlog, pytest (asyncio_mode=auto), ruff.

**Spec:** Approved design from the evaluate-subset-revision conversation: per-file deterministic verdicts gated on per-file scoped evidence being available for **every** planned task; global-blob fallback otherwise (preserves offline fixtures); fan-out builds the union of review correction task_ids and evaluate failed_files paths; `failed_files` is only emitted in per-file mode so legacy key sets are preserved.

## Global Constraints

- All work happens inside the `draftly-agent-backend` submodule (commands run from `draftly-agent-backend/`).
- Tests: `uv run pytest -q`; lint: `uv run ruff check .`.
- Payload additive rule: results with `drafts_repo=None` must keep the EXACT key set `{"passed", "score", "reasons", "iteration", "escalated"}` (asserted by `test_without_draft_store_keeps_legacy_key_set`). `has_drafts` is only added when `drafts_repo is not None`. `files`/`failed_files` are only added in per-file-scoped mode.
- Per-file mode activation requires: `drafts_repo` set, `has_drafts` True, a `document` payload whose `tasks` every have a string `path` and non-empty `evidence_refs` that all resolve to usable evidence items, and a sealed non-empty revision for each planned path. Any task without scoped evidence ⇒ fall back to the global blob (no `failed_files`).
- No behavior change to waiver, escalation, rubric-grader, or routing logic.
- Follow the skill discipline: each task is TDD (failing test → implement → green → commit).
- After all tasks pass, run `graphify update .` from the repo root (AGENTS.md rule) to refresh the knowledge graph.

---

## File Structure

- `draftly-agent-backend/src/draftly/orchestration/nodes/evaluate.py` — per-file verdicts; `_store_draft` gains a revisions element; new module helper `_scoped_evidence`.
- `draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py` — filter block widened to include evaluate `failed_files`.
- `draftly-agent-backend/tests/nodes/test_evaluator.py` — per-file verdict tests.
- `draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py` — subset-dispatch tests.
- `draftly-agent-backend/tests/graph/test_documentation_graph.py` — end-to-end revise-loop regression test.

---

### Task 1: EvaluatorNode per-file verdicts

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/evaluate.py` (`_store_draft` around line 229, scoring around lines 296-297, result payload around lines 372-382)
- Test: `draftly-agent-backend/tests/nodes/test_evaluator.py`

**Interfaces:**
- Consumes: existing `compute_quality`, `_evidence_has_signals`, `_research_evidence`, `parse_node_input`; existing `_FakeDraftsRepo`, `_NoopRubricGrader` test helpers.
- Produces: `EvaluatorNode.invoke_async` result JSON gains `files: list[str]` and `failed_files: list[str]` **only** in per-file mode. `_scoped_evidence(tasks, evidence) -> dict[str, list[dict]] | None`. `_store_draft(run_id) -> tuple[str, bool, list]` (content, has_files, revisions). Task 2 and Task 3 consume `failed_files`.

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-backend/tests/nodes/test_evaluator.py` (below `TestEvaluatorDraftStore`):

```python
_TWO_PAGE_EVIDENCE = [
    {"id": "docs/a.md", "topic": "alpha"},
    {"id": "docs/b.md", "topic": "beta"},
]


def _document_payload() -> dict:
    """A two-page fan-out payload whose tasks scope evidence per path."""
    return {
        "repository": "acme/api",
        "branch": "docs/fix",
        "summary": "behavior changed",
        "files": [
            {"path": "docs/a.md", "action": "update"},
            {"path": "docs/b.md", "action": "update"},
        ],
        "tasks": [
            {
                "task_id": "docs/a.md",
                "path": "docs/a.md",
                "action": "update",
                "ok": True,
                "reasons": [],
                "evidence_refs": ["docs/a.md"],
            },
            {
                "task_id": "docs/b.md",
                "path": "docs/b.md",
                "action": "update",
                "ok": True,
                "reasons": [],
                "evidence_refs": ["docs/b.md"],
            },
        ],
        "task_count": 2,
        "failed_tasks": [],
    }


def _store_blocks(payload: dict, evidence: list[dict]) -> list[dict]:
    return [
        {"text": "Original Task: task"},
        {"text": "\nInputs from previous nodes:"},
        {"text": "\nFrom research:"},
        {"text": f"  - ResearchAgent: {json.dumps({'items': evidence})}"},
        {"text": "\nFrom document:"},
        {"text": "  - WriterAgent: " + json.dumps(payload)},
    ]


class TestEvaluatorPerFileVerdicts:
    @pytest.mark.asyncio
    async def test_failed_page_is_named_and_passing_page_excluded(self) -> None:
        """Per-file verdicts: the page whose sealed revision misses its topic
        is listed in failed_files; the passing page is not."""
        repo = _FakeDraftsRepo(
            [
                {
                    "path": "docs/a.md",
                    "action": "update",
                    "content": "alpha is implemented and documented docs/a.md " * 20,
                },
                {"path": "docs/b.md", "action": "update", "content": "TODO"},
            ]
        )
        node = EvaluatorNode(drafts_repo=repo, rubric_grader=_NoopRubricGrader())
        result = await node.invoke_async(
            _store_blocks(_document_payload(), _TWO_PAGE_EVIDENCE),
            invocation_state={"run_id": "run-1"},
        )
        data = json.loads(result.results["evaluate"].result.message["content"][0]["text"])
        assert data["passed"] is False
        assert set(data["files"]) == {"docs/a.md", "docs/b.md"}
        assert data["failed_files"] == ["docs/b.md"]
        assert any("docs/b.md" in r for r in data["reasons"])
        assert any("beta" in r for r in data["reasons"])  # missing-topic feedback

    @pytest.mark.asyncio
    async def test_all_pages_pass_emits_empty_failed_files(self) -> None:
        repo = _FakeDraftsRepo(
            [
                {
                    "path": "docs/a.md",
                    "action": "update",
                    "content": "alpha is implemented and documented docs/a.md " * 20,
                },
                {
                    "path": "docs/b.md",
                    "action": "update",
                    "content": "beta is implemented and documented docs/b.md " * 20,
                },
            ]
        )
        node = EvaluatorNode(drafts_repo=repo, rubric_grader=_NoopRubricGrader())
        result = await node.invoke_async(
            _store_blocks(_document_payload(), _TWO_PAGE_EVIDENCE),
            invocation_state={"run_id": "run-1"},
        )
        data = json.loads(result.results["evaluate"].result.message["content"][0]["text"])
        assert data["passed"] is True
        assert data["files"] == ["docs/a.md", "docs/b.md"]
        assert data["failed_files"] == []

    @pytest.mark.asyncio
    async def test_without_scoped_tasks_falls_back_and_omits_files(self) -> None:
        """No document tasks → legacy single-blob verdict; the payload gains
        only has_drafts, never files/failed_files."""
        evidence = [{"id": "docs/a.md", "topic": "alpha"}]
        repo = _FakeDraftsRepo(
            [{"path": "docs/a.md", "action": "update", "content": ("alpha a.md " * 40)}]
        )
        node = EvaluatorNode(drafts_repo=repo, rubric_grader=_NoopRubricGrader())
        result = await node.invoke_async(
            _store_blocks({"draft": ""}, evidence),
            invocation_state={"run_id": "run-1"},
        )
        data = json.loads(result.results["evaluate"].result.message["content"][0]["text"])
        assert set(data) == {
            "passed",
            "score",
            "reasons",
            "iteration",
            "escalated",
            "has_drafts",
        }
        assert "files" not in data
        assert "failed_files" not in data

    @pytest.mark.asyncio
    async def test_partial_evidence_scoping_falls_back_to_blob(self) -> None:
        """A single task row without evidence_refs makes per-file verdicts
        unsound; the evaluator must fall back and NOT emit failed_files."""
        payload = _document_payload()
        payload["tasks"][1]["evidence_refs"] = []
        repo = _FakeDraftsRepo(
            [
                {
                    "path": "docs/a.md",
                    "action": "update",
                    "content": "alpha is implemented and documented docs/a.md " * 20,
                },
                {"path": "docs/b.md", "action": "update", "content": "TODO"},
            ]
        )
        node = EvaluatorNode(drafts_repo=repo, rubric_grader=_NoopRubricGrader())
        result = await node.invoke_async(
            _store_blocks(payload, _TWO_PAGE_EVIDENCE),
            invocation_state={"run_id": "run-1"},
        )
        data = json.loads(result.results["evaluate"].result.message["content"][0]["text"])
        assert "failed_files" not in data
        assert "files" not in data

    @pytest.mark.asyncio
    async def test_escalation_clears_failed_files(self) -> None:
        """When the revision budget is exhausted the run escalates (passed
        True); failed_files must empty so nothing targets a stale page."""
        repo = _FakeDraftsRepo(
            [
                {
                    "path": "docs/a.md",
                    "action": "update",
                    "content": "alpha is implemented and documented docs/a.md " * 20,
                },
                {"path": "docs/b.md", "action": "update", "content": "TODO"},
            ]
        )
        node = EvaluatorNode(
            max_iterations=1, drafts_repo=repo, rubric_grader=_NoopRubricGrader()
        )
        result = await node.invoke_async(
            _store_blocks(_document_payload(), _TWO_PAGE_EVIDENCE),
            invocation_state={"run_id": "run-1"},
        )
        data = json.loads(result.results["evaluate"].result.message["content"][0]["text"])
        assert data["passed"] is True
        assert data["escalated"] is True
        assert data["failed_files"] == []
```

The scoring math behind the fixtures: `compute_quality` never receives the raw header you might worry about — the evaluator scores `f"{path}\n{revision.content}"`. Because the path itself appears in that header, `_evidence_match_tokens` matches the full id token, so coverage contributes ~0.4 per page regardless. `docs/a.md` passes (topic `alpha` present → completeness 0.3, long prose → length 0.3, total ≈ 1.0). `docs/b.md` fails (topic `beta` absent → completeness 0; 4-char `TODO` → length ≈ 0.002; total ≈ 0.40 < 0.7, and a `Missing topics: beta` reason fires).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest -q tests/nodes/test_evaluator.py -k per_file -v`
Expected: FAIL — `assert set(data)["files"] ...` KeyError/`assert data["failed_files"] ...` KeyError (keys are not yet emitted).

- [ ] **Step 3: Implement per-file verdicts in evaluate.py**

First, add the module helper after `_evidence_has_signals`:

```python
def _scoped_evidence(
    tasks: list[dict[str, Any]], evidence: list[dict]
) -> dict[str, list[dict]] | None:
    """Map planned task paths to their path-scoped evidence, else None.

    Per-file scoring is only sound when every planned task carries at least
    one ``evidence_ref`` that resolves to a usable evidence item; otherwise a
    page would be scored without citation/completeness signals and the gate
    would loop on a verdict it cannot justify. ``None`` falls back to the
    legacy single-blob verdict.
    """
    if not tasks:
        return None
    scoped: dict[str, list[dict]] = {}
    for row in tasks:
        path = row.get("path")
        refs = row.get("evidence_refs") or []
        if not isinstance(path, str) or not path or not refs:
            return None
        matched = [e for e in evidence if e.get("id") in refs]
        if not matched or not all(_evidence_has_signals(e) for e in matched):
            return None
        scoped[path] = matched
    return scoped
```

Change `_store_draft` to also return the raw revisions (so per-file scoring can address content per path):

```python
    async def _store_draft(self, run_id: str | None) -> tuple[str, bool, list[Any]]:
        """Assembled content of the latest sealed generation for ``run_id``.

        Returns ``(content, has_files, revisions)``; ``has_files`` is True when
        at least one sealed revision exists. Content joins revisions in path
        order (revisions remain available for per-file scoring). Store failures
        degrade to empty (the waiver paths below still gate on evidence, not
        on the draft text).
        """
        if self.drafts_repo is None or not run_id:
            return "", False, []
        try:
            revisions = await self.drafts_repo.get_latest(run_id=run_id)
        except Exception:
            logger.warning("drafts_get_latest_failed", run_id=run_id, exc_info=True)
            return "", False, []
        if not revisions:
            return "", False, []
        parts = [f"{rev.path}\n{rev.content}" for rev in revisions]
        return "\n\n".join(parts), True, list(revisions)
```

Update the call site to capture the third element and initialize `revisions` in the offline branch. Before the `if self.drafts_repo is not None:` block (around line 269) add:

```python
        revisions: list[Any] = []
```

and change line 270 to:

```python
            store_draft, has_drafts, revisions = await self._store_draft(
                (invocation_state or {}).get("run_id")
            )
```

Replace the scoring verdict (currently `score, reasons = compute_quality(evidence, draft)` ... `passed = score >= 0.7` at lines 296-297) with:

```python
        score, reasons = compute_quality(evidence, draft)

        files: list[str] = []
        failed_files: list[str] = []
        per_file: dict[str, tuple[float, list[str]]] | None = None
        if has_drafts and isinstance(deps.get("document"), dict):
            scoped = _scoped_evidence(deps["document"].get("tasks") or [], evidence)
            rev_map = {getattr(rev, "path", None): rev for rev in revisions}
            if scoped is not None and all(
                path in rev_map and (rev_map[path].content or "").strip()
                for path in scoped
            ):
                per_file = {
                    path: compute_quality(ev, f"{path}\n{rev_map[path].content}")
                    for path, ev in scoped.items()
                }

        if per_file is not None:
            files = sorted(per_file)
            score = min((s for s, _ in per_file.values()), default=0.0)
            reasons = []
            for path in files:
                sub_score, sub_reasons = per_file[path]
                if sub_score < 0.7:
                    failed_files.append(path)
                    reasons.extend(
                        [f"{path}: {r}" for r in sub_reasons]
                        or [f"{path}: score {sub_score:.2f} (threshold: 0.70)"]
                    )
            passed = not failed_files
        else:
            passed = score >= 0.7
```

Add `failed_files` to the `evaluate_verdict` log call (after `files_present=files_present`, line 366):

```python
            failed_files=failed_files,
```

Extend the result payload (after `result["has_drafts"] = has_drafts`, line 382):

```python
            if per_file is not None:
                # Revision targeting: only paths that failed evaluation are
                # re-dispatched to the writer. Empty when the run passes.
                result["files"] = files
                result["failed_files"] = failed_files
```

Because escalation moves the run forward (no further document revision is scheduled), the branch must empty `failed_files` so a later consumer never sees a stale target. Extend the escalation branch (currently lines 346-356, `if not passed and self.iteration >= self.max_iterations:`) with `failed_files = []` right after `escalated = True`. In per-file mode the waiver branches cannot fire (they require `not evidence` or `not any(_evidence_has_signals(...))`, and per-file mode requires usable scoped evidence), so they need no change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q tests/nodes/test_evaluator.py`
Expected: PASS (all new tests plus all pre-existing evaluator tests, including `test_without_draft_store_keeps_legacy_key_set`).

- [ ] **Step 5: Commit**

```bash
git add src/draftly/orchestration/nodes/evaluate.py tests/nodes/test_evaluator.py
git commit -m "feat: emit per-file evaluator verdicts for targeted revision"
```

---

### Task 2: FanOutWriterNode dispatches only failed pages

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py:109-116` (the correction filter)
- Test: `draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py`

**Interfaces:**
- Consumes: `deps["evaluate"]["failed_files"]` (a `list[str]` of paths, from Task 1). Emitted only in per-file mode; absence must be a no-op.
- Produces: none new — the node still aggregates a per-task payload; it just runs fewer writers on a failed revision pass.

- [ ] **Step 1: Write the failing tests**

Append to `draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py` (after `test_node_corrections_restrict_to_corrected_tasks`):

```python
def _evaluated_input(impact: dict, evaluate: dict) -> list[dict]:
    lines = [
        "Original Task: {}",
        "Inputs from previous nodes:",
        "From impact:",
        f"  - Agent: {json.dumps(impact)}",
        "From evaluate:",
        f"  - Agent: {json.dumps(evaluate)}",
    ]
    return [{"text": "\n".join(lines)}]


async def test_node_evaluate_failed_files_restrict_to_failed_paths() -> None:
    """A failed evaluation names only docs/b.md → only that page is re-dispatched."""
    factory = _FakeFactory([_plan("docs/b.md")])
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None)
    evaluate = {
        "passed": False,
        "files": ["docs/a.md", "docs/b.md"],
        "failed_files": ["docs/b.md"],
    }
    await node.invoke_async(
        _evaluated_input(_impact(["docs/a.md", "docs/b.md"]), evaluate),
        {"run_id": "run-1"},
    )
    assert len(factory.agents) == 1
    assert "Path: docs/b.md" in factory.agents[0].invoked[0]
    assert "Path: docs/a.md" not in factory.agents[0].invoked[0]


async def test_node_no_evaluate_targets_dispatches_all_tasks() -> None:
    """First pass (no evaluate result yet, no review) dispatches every task."""
    factory = _FakeFactory([_plan("docs/a.md"), _plan("docs/b.md")])
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None)
    await node.invoke_async(_input(_impact(["docs/a.md", "docs/b.md"])), {"run_id": "run-1"})
    assert len(factory.agents) == 2


async def test_node_corrections_and_failed_files_union() -> None:
    """Review corrections and evaluate failures both target pages; the union
    is dispatched once each (a task id is unique in the rebuilt plan)."""
    factory = _FakeFactory([_plan("docs/b.md"), _plan("docs/c.md")])
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None)
    review = {
        "verdict": "correct",
        "corrections": [
            {"task_id": "docs/b.md", "path": "docs/b.md", "instructions": ["tighten"]}
        ],
    }
    evaluate = {"passed": False, "failed_files": ["docs/b.md", "docs/c.md"]}
    lines = [
        "Original Task: {}",
        "Inputs from previous nodes:",
        "From impact:",
        f"  - Agent: {json.dumps(_impact(['docs/a.md', 'docs/b.md', 'docs/c.md']))}",
        "From review:",
        f"  - Agent: {json.dumps(review)}",
        "From evaluate:",
        f"  - Agent: {json.dumps(evaluate)}",
    ]
    await node.invoke_async([{"text": "\n".join(lines)}], {"run_id": "run-1"})
    assert len(factory.agents) == 2
    dispatched = {a.invoked[0].splitlines()[1] for a in factory.agents}
    assert dispatched == {"Path: docs/b.md", "Path: docs/c.md"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest -q tests/unit/orchestration/test_fan_out_node.py -v`
Expected: FAIL — `assert len(factory.agents) == 1` gets 2 (the filter ignores `failed_files`, so both pages re-dispatch).

- [ ] **Step 3: Implement the filter**

Replace the correction filter (fan_out.py:109-116):

```python
        corrections = deps.get("review") or {}
        correction_ids: set[str] = set()
        if corrections.get("corrections"):
            correction_ids = {
                c["task_id"]
                for c in corrections["corrections"]
                if isinstance(c, dict) and c.get("task_id")
            }
        failed_paths = set((deps.get("evaluate") or {}).get("failed_files") or [])
        if correction_ids or failed_paths:
            tasks = [
                t
                for t in tasks
                if t.id in correction_ids or t.path in failed_paths
            ]
```

Note: evaluate is present in the node input exactly when the `evaluate → document` revise edge (condition `needs_revision_of("document")`) is satisfied — `_build_node_input` only includes dependency sections for edges whose condition currently traverses (they do, because they just scheduled this node). Absence of `evaluate` (first pass, or documents generated via the review-clean path) is a no-op thanks to `or []` and `or set()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q tests/unit/orchestration/test_fan_out_node.py`
Expected: PASS (3 new tests + existing behavior tests).

- [ ] **Step 5: Commit**

```bash
git add src/draftly/orchestration/nodes/fan_out.py tests/unit/orchestration/test_fan_out_node.py
git commit -m "feat: resend only evaluate-failed pages in the revision loop"
```

---

### Task 3: Graph end-to-end regression test

**Files:**
- Modify: `draftly-agent-backend/tests/graph/test_documentation_graph.py` (new test) and `draftly-agent-backend/tests/graph/conftest.py` (new fixture/helper)
- Test: the added test itself is the deliverable (no source changes)

**Interfaces:**
- Consumes: Task 1 (`evaluate.failed_files`) + Task 2 (fan-out filter). `build_graph_for_run` params `model`, `drafts_repo`, `agents`, `comment_factory`; `FakeDrafts` from conftest; `StubModel`.
- Produces: proves the full loop `document → evaluate(failed: b) → document(only b) → evaluate(escalate) → changelog → deliver`.

How it works end-to-end: the seeded `StubModel` schedules a two-page plan (`docs/a.md`, `docs/b.md`) with path-scoped evidence. The injected `FakeDrafts` seals a good `a` revision and a bad `b` revision (`"TODO"`, missing topic `beta`). The deterministic evaluator therefore emits `passed: False, failed_files: ["docs/b.md"]`, routing back to `document` via `needs_revision_of("document")`. On the revisit, Document's node input contains `From evaluate:` (the edge's condition is true), the Task 2 filter keeps only `docs/b.md`, and exactly one writer agent runs. The second evaluation still fails and escalates (`max_iterations` reached) → changelog → deliver.

- [ ] **Step 1: Add a two-page fixture and recording writer builder**

In `draftly-agent-backend/tests/graph/conftest.py`, add a `two_page_model()` builder function (a plain function so the test can call `two_page_model()` directly) and a `two_page_drafts` fixture next to `stub_model`:

```python
TWO_PAGE_IMPACT = {
    "action": "update",
    "affected_documents": ["docs/a.md", "docs/b.md"],
    "rationale": "behavior changed in two places",
    "tasks": [
        {
            "id": "docs/a.md",
            "path": "docs/a.md",
            "action": "update",
            "evidence": [{"id": "docs/a.md", "topic": "alpha"}],
        },
        {
            "id": "docs/b.md",
            "path": "docs/b.md",
            "action": "update",
            "evidence": [{"id": "docs/b.md", "topic": "beta"}],
        },
    ],
}

TWO_PAGE_EVIDENCE = {
    "items": [
        {"id": "docs/a.md", "topic": "alpha"},
        {"id": "docs/b.md", "topic": "beta"},
    ],
    "summary": "two page evidence",
}


def two_page_model() -> StubModel:
    """StubModel for the two-page mutation: every other agent output matches
    the single-page stub, impact/evidence/review carry two-page content."""
    two_page = dict(stub_model()._structured_outputs)
    two_page[ImpactAnalysis] = TWO_PAGE_IMPACT
    two_page[EvidenceBundle] = TWO_PAGE_EVIDENCE
    two_page[DocChangePlan] = {
        "repository": "acme/api",
        "branch": "docs/fix",
        "commit_message": "docs: two pages",
        "summary": "behavior changed in two places",
        "files": [
            {"path": "docs/a.md", "action": "update"},
            {"path": "docs/b.md", "action": "update"},
        ],
    }
    two_page[ReviewVerdict] = {"verdict": "clean", "corrections": []}
    return StubModel(structured_outputs=two_page)


@pytest.fixture
def two_page_drafts():
    """A sealed store where docs/a.md passes evaluation and docs/b.md fails
    (missing its topic, too short): per-file verdicts differ by path."""
    return FakeDrafts(
        [
            {
                "path": "docs/a.md",
                "action": "update",
                "content": "alpha is implemented and documented docs/a.md " * 20,
            },
            {"path": "docs/b.md", "action": "update", "content": "TODO"},
        ]
    )
```

Add a recording writer-builder fixture/production of the same module (near the graph-build fixtures, since `build(...)` passes `agents` to `build_graph_for_run`):

```python
def _recording_writer_agent(recorder: list[str]):
    class _RecordingWriterAgent:
        def __init__(self, recorder: list[str]) -> None:
            self._recorder = recorder

        async def invoke_async(self, prompt: str, invocation_state=None, **kwargs):
            self._recorder.append(prompt)
            return two_page_model_plan()

    def build(model, tools, runtime=None, agent_id=None, node_id=None):
        return _RecordingWriterAgent(recorder)

    return build


def two_page_model_plan() -> DocChangePlan:
    return DocChangePlan(
        repository="acme/api",
        branch="docs/fix",
        commit_message="docs: two pages",
        summary="behavior changed in two places",
        files=[
            {"path": "docs/a.md", "action": "update"},
            {"path": "docs/b.md", "action": "update"},
        ],
    )
```

`_recording_writer_agent(recorder)` returns a builder matching the `WriterFactory` contract — `build(model, tools, runtime=None, agent_id=None, node_id=None) -> Agent` — so it can be injected as `registry.writer_agent` via the `agents` namespace (line 304 of `documentation_graph.py` reads `getattr(registry, "writer_agent", None)`). The recording agent's `invoke_async` appends the rendered task prompt and returns the scripted two-page plan; the fan-out node aggregates and persists normally.

- [ ] **Step 2: Write the failing end-to-end test**

Append to `draftly-agent-backend/tests/graph/test_documentation_graph.py`:

```python
async def test_revision_reloop_sends_only_failed_page(
    tools, tmp_sessions, comment_factory, two_page_drafts
) -> None:
    """The full revise loop targets only evaluate-failed pages: page b fails
    the deterministic gate, document re-runs, and the second execution
    dispatches a single writer for docs/b.md (docs/a.md is untouched)."""
    from types import SimpleNamespace

    from tests.graph.conftest import _recording_writer_agent, two_page_model

    recorder: list[str] = []
    factory, _ = comment_factory
    graph = build_graph_for_run(
        "revise-subset",
        surface="pull_request",
        tools_registry=tools,
        model=two_page_model(),
        storage_dir=tmp_sessions,
        comment_factory=factory,
        drafts_repo=two_page_drafts,
        agents=SimpleNamespace(writer_agent=_recording_writer_agent(recorder)),
    )

    result = await graph.invoke_async(
        PR_TASK,
        invocation_state={"run_id": "revise-subset", "review_policy": "never"},
    )

    assert result.status == Status.COMPLETED
    order = [n.node_id for n in result.execution_order]
    assert order.count("document") == 2
    assert order.count("evaluate") == 2

    assert len(recorder) == 3, recorder
    first_batch = recorder[:2]
    assert "Path: docs/a.md" in first_batch[0]
    assert "Path: docs/b.md" in first_batch[1]
    second = recorder[2]
    assert "Path: docs/b.md" in second
    assert "Path: docs/a.md" not in second
```

Run from the `draftly-agent-backend/` directory with `review_policy: "never"` so the `ReviewGate` never pauses, while the scripted reviewer still returns `clean`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest -q tests/graph/test_documentation_graph.py -k revision_reloop`
Expected: FAIL — without Tasks 1 & 2 the graph either never targets a subset (both pages re-dispatch each pass, likely hitting `max_node_executions` or producing a different execution count) or `recorder` has a different shape. The specific assertion to satisfy is: two document executions, two evaluations, and the second batch prompts contain only `docs/b.md`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest -q tests/graph/test_documentation_graph.py -k revision_reloop`
Expected: PASS. If ordering of the two writer invocations in the first batch is non-deterministic (semaphore concurrency), relax the assertion to a set comparison:

```python
    first_batch = set()
    for prompt in recorder[:2]:
        lines = prompt.splitlines()
        first_batch.add(next(l for l in lines if l.startswith("Path: ")))
    assert first_batch == {"Path: docs/a.md", "Path: docs/b.md"}
```

- [ ] **Step 5: Commit**

```bash
git add tests/graph/conftest.py tests/graph/test_documentation_graph.py
git commit -m "test: lock evaluate-subset revision targeting end-to-end"
```

---

## Full Verification (final)

- [ ] Run the entire suite and lint from `draftly-agent-backend/`:

```bash
uv run pytest -q
uv run ruff check .
```

Expected: all tests pass, ruff clean.

- [ ] Run `graphify update .` from the repo root.

- [ ] Commit any leftover changes (typically none) with a conventional message.