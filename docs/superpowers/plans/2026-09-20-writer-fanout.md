# Writer Fan-out Implementation Plan — Per-Page/Bundle Documentation Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single whole-PR writer invocation with one isolated writer Agent per documentation task (page/bundle), under bounded concurrency, with per-task validation/retry, a targeted global review, and per-task progress envelopes.

**Architecture:** The static documentation graph gains a deterministic fan-out node (`document`, a `MultiAgentBase`) that expands `ImpactAnalysis.tasks[]` into per-task invocations of **fresh, isolated** writer Agents under `asyncio.Semaphore(3)`. A new `review` node merges those pages with a targeted global review; `DraftRepository.get_latest` switches to per-path supersession so a partial retry never drops siblings. Progress is emitted through a `task_progress` envelope on the shared run stream (mirroring the steering sink).

**Tech Stack:** Python 3.12+, asyncio, strands SDK (`Agent.invoke_async`, `MultiAgentBase`, `concurrent_invocation_mode`), pydantic v2, AsyncPG (run-time), pytest + `tests/stub_model.StubModel` (test-time), structlog, uv.

**Spec:** `docs/superpowers/specs/2026-09-20-writer-fanout-design.md`

## Global Constraints

- **Fresh Agent per task.** Strands `Agent` defaults `concurrent_invocation_mode=THROW`; concurrent `invoke_async` on one instance raises `ConcurrencyException`. `WriterFactory.create()` MUST return a new Agent instance per call, never a cached one.
- **Shared `DraftScope`, never re-set.** `NextGenerationHook` publishes one run-scoped draft scope before the fan-out node fires; the node must NOT call `set_draft_scope` per child. Concurrent writers share `(run_id, org_id, generation)` and write disjoint paths (the duplicate-path validator guarantees this).
- **Task paths are relative, non-escaping, unique.** Rejected otherwise (matches `DocChangePlan` validator style).
- **Concurrency default: `write_concurrency=3`.**
- **Node result payload shape** (what later tasks read via `node_data("document")`):
  `{"repository", "branch", "commit_message", "summary", "files": [{path, action}], "tasks": [{task_id, path, action, ok, reasons, evidence_refs}], "task_count", "failed_tasks": [task_id,...]}`
- **Progress dict passed to `progress_sink`:** `{node_id, task_id, path, action, status, position, total}` with `status ∈ {"running","completed","failed"}`; envelope type `"task_progress"`.
- **`document` replaces `update`/`create` at the graph level.** `NextGenerationHook.WRITER_NODE_IDS` becomes `("document",)`; `delivery_content_ready` and evaluate dep scans treat `document` as the write node.
- Test/run commands (all from `draftly-agent-backend/`, the directory containing `pyproject.toml`): `uv run pytest tests/... -q`, `uv run ruff check .`, `uv run mypy src`. Offline harness: `uv run pytest -q` for the full suite.
- After modifying backend source, keep the project knowledge graph current: `graphify update .` from the repo root (workspace root).

---

## Phase A — Task planning & draft store (independent, shippable alone)

### Task 1: `DocumentationTask` schema + `ImpactAnalysis.tasks` + path validation

**Files:**
- Modify: `draftly-agent-backend/src/draftly/agents/schemas.py`
- Test: `draftly-agent-backend/tests/unit/agents/test_task_schemas.py` (create)

**Interfaces:**
- Consumes: existing `EvidenceItem`, `EvidenceBundle`, `ImpactAnalysis` in `schemas.py`.
- Produces: `DocumentationTask(id, path, action, reason, related_symbols, evidence, requirements, bundle_id)`; `ImpactAnalysis.tasks: list[DocumentationTask]` with validated paths; raises `pydantic.ValidationError` on bad paths.

- [ ] **Step 1: Write the failing test**

`tests/unit/agents/test_task_schemas.py`:

```python
"""DocumentationTask + ImpactAnalysis.tasks path-validation contract tests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from draftly.agents.schemas import DocumentationTask, ImpactAnalysis


def test_impact_analysis_defaults_tasks_when_absent() -> None:
    impact = ImpactAnalysis(action="update", affected_documents=["docs/a.md"])
    assert impact.tasks == []


def test_impact_analysis_parses_task_list() -> None:
    impact = ImpactAnalysis(
        action="update",
        affected_documents=["docs/a.md", "docs/b.md"],
        tasks=[
            DocumentationTask(id="t1", path="docs/a.md", action="update"),
            DocumentationTask(id="t2", path="docs/b.md", action="create"),
        ],
    )
    assert len(impact.tasks) == 2
    assert impact.tasks[1].action == "create"


def test_task_path_must_be_relative() -> None:
    with pytest.raises(ValidationError, match="relative"):
        ImpactAnalysis(
            action="update",
            affected_documents=["docs/a.md"],
            tasks=[{"id": "t1", "path": "/docs/abs.md", "action": "update"}],
        )


def test_task_path_must_not_escape_repo() -> None:
    with pytest.raises(ValidationError, match="relative"):
        ImpactAnalysis(
            action="update",
            affected_documents=["docs/a.md"],
            tasks=[
                {"id": "t1", "path": "docs/../outside.md", "action": "update"}
            ],
        )


def test_task_paths_must_be_unique_within_a_plan() -> None:
    with pytest.raises(ValidationError, match="duplicate"):
        ImpactAnalysis(
            action="create",
            affected_documents=["docs/a.md", "docs/b.md"],
            tasks=[
                {"id": "t1", "path": "docs/a.md", "action": "create"},
                {"id": "t2", "path": "docs/a.md", "action": "create"},
            ],
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/agents/test_task_schemas.py -q`
Expected: FAIL — `ImportError: cannot import name 'DocumentationTask'`.

- [ ] **Step 3: Write minimal implementation**

In `src/draftly/agents/schemas.py`. Place the model after `EvidenceItem`/`EvidenceBundle` and before `ImpactAnalysis`; add the validator on `ImpactAnalysis`:

```python
class DocumentationTask(BaseModel):
    """One page/bundle to write or update (a single isolated writer unit)."""

    id: str
    path: str
    action: str = "update"  # only "update" | "create" (validated by plan_tasks/downstream)
    reason: str = ""
    related_symbols: list[str] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    bundle_id: str | None = None
```

Add to `ImpactAnalysis` (fields and validator). Confirmed existing fields: `action`, `affected_documents`, `evidence`, `rationale`. `on_event_staging` untouched.

```python
from pathlib import PurePath

    # on ImpactAnalysis
    tasks: list[DocumentationTask] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_task_paths(self) -> ImpactAnalysis:
        seen: set[str] = set()
        for task in self.tasks:
            path = task.path.strip()
            if not path:
                raise ValueError(f"task {task.id!r} has an empty path")
            candidate = PurePath(path)
            if candidate.is_absolute() or ".." in candidate.parts:
                raise ValueError(
                    f"task {task.id!r} path must be relative and within the repo: {path!r}"
                )
            if path in seen:
                raise ValueError(f"duplicate task path: {path}")
            seen.add(path)
        return self
```

Add the `PurePath` import at the top of the file (verify it is not already imported). Add `model_validator` to the existing `pydantic` import line in `schemas.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/agents/test_task_schemas.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/agents/schemas.py draftly-agent-backend/tests/unit/agents/test_task_schemas.py
git commit -m "feat: add DocumentationTask and per-task impact plan schema"
```

---

### Task 2: Deterministic planning helpers (`plan_tasks`, `tasks_from_impact`)

**Files:**
- Create: `draftly-agent-backend/src/draftly/agents/documentation/planning.py`
- Test: `draftly-agent-backend/tests/unit/agents/test_task_planning.py` (create)

**Interfaces:**
- Consumes: `DocumentationTask`, `ImpactAnalysis`, `EvidenceBundle`, `EvidenceItem` from `schemas.py`.
- Produces:
  - `task_id_for(path: str) -> str` — stable id for a task (`path`).
  - `tasks_from_impact(impact: ImpactAnalysis, evidence: EvidenceBundle | None) -> list[DocumentationTask]` — deterministic fallback expanding `affected_documents`, scoping evidence by item id == path, empty requirements.
  - `plan_tasks(impact: ImpactAnalysis, evidence: EvidenceBundle | None) -> list[DocumentationTask]` — `impact.tasks` when non-empty, else the fallback.

- [ ] **Step 1: Write the failing test**

`tests/unit/agents/test_task_planning.py`:

```python
"""plan_tasks/tasks_from_impact fallback contract tests."""

from __future__ import annotations

from draftly.agents.documentation.planning import task_id_for, tasks_from_impact, plan_tasks
from draftly.agents.schemas import DocumentationTask, EvidenceBundle, EvidenceItem, ImpactAnalysis


def _impact(action: str = "update", paths: list[str] | None = None) -> ImpactAnalysis:
    return ImpactAnalysis(action=action, affected_documents=paths or ["docs/a.md"], rationale="behavior changed")


def test_tasks_from_impact_expands_paths_with_scoped_evidence() -> None:
    evidence = EvidenceBundle(
        items=[EvidenceItem(id="docs/a.md", topic="widgets")], summary="s"
    )
    tasks = tasks_from_impact(_impact(paths=["docs/a.md", "docs/b.md"]), evidence)
    assert [t.path for t in tasks] == ["docs/a.md", "docs/b.md"]
    assert tasks[0].evidence[0].id == "docs/a.md"
    assert tasks[1].evidence == []
    assert all(t.id == t.path for t in tasks)
    assert all(t.action == "update" for t in tasks)


def test_tasks_from_impact_defaults_action_for_unknown_action() -> None:
    tasks = tasks_from_impact(_impact(action="none"), None)
    assert all(t.action == "update" for t in tasks)


def test_plan_tasks_prefers_llm_tasks_over_fallback() -> None:
    impact = ImpactAnalysis(
        action="update",
        affected_documents=["docs/a.md"],
        tasks=[DocumentationTask(id="t-hand", path="docs/b.md", action="create")],
    )
    tasks = plan_tasks(impact, None)
    assert [t.id for t in tasks] == ["t-hand"]


def test_plan_tasks_falls_back_when_llm_emitted_none() -> None:
    tasks = plan_tasks(_impact(paths=["docs/a.md"]), None)
    assert [t.id for t in tasks] == ["docs/a.md"]


def test_task_id_for_is_the_path() -> None:
    assert task_id_for("docs/guide.md") == "docs/guide.md"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/agents/test_task_planning.py -q`
Expected: FAIL — `ModuleNotFoundError: no module named 'draftly.agents.documentation.planning'`.

- [ ] **Step 3: Write minimal implementation**

`src/draftly/agents/documentation/planning.py`:

```python
"""Deterministic per-task planning for the documentation fan-out node.

The impact agent emits ``ImpactAnalysis.tasks`` natively; these helpers add
the deterministic fallback used when that structured field is empty (offline
restores, older runs, schema drift) and the shared validation gate.
"""

from __future__ import annotations

from draftly.agents.schemas import DocumentationTask, EvidenceBundle, ImpactAnalysis


def task_id_for(path: str) -> str:
    """Stable, reproduction-friendly task id: the target path."""
    return path


def tasks_from_impact(
    impact: ImpactAnalysis, evidence: EvidenceBundle | None
) -> list[DocumentationTask]:
    """Expand ``affected_documents`` into tasks, scoping evidence by path."""
    items = {item.id: item for item in (evidence.items if evidence else [])}
    action = impact.action if impact.action in ("update", "create") else "update"
    return [
        DocumentationTask(
            id=task_id_for(path),
            path=path,
            action=action,
            reason=impact.rationale or "",
            evidence=[items[path]] if path in items else [],
        )
        for path in impact.affected_documents
    ]


def plan_tasks(
    impact: ImpactAnalysis, evidence: EvidenceBundle | None
) -> list[DocumentationTask]:
    """The task plan of record: LLM-emitted tasks, else the fallback."""
    return list(impact.tasks) if impact.tasks else tasks_from_impact(impact, evidence)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/agents/test_task_planning.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/agents/documentation/planning.py draftly-agent-backend/tests/unit/agents/test_task_planning.py
git commit -m "feat: deterministic per-task planning fallback for docs fan-out"
```

---

### Task 3: Draft store per-path supersession (`get_latest`, `get_path_latest`)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/drafts.py:245-263` (`get_latest`) and imports near top
- Test: `draftly-agent-backend/tests/unit/persistence/test_draft_repository.py` (modify `test_get_latest_returns_highest_sealed_generation`, add new tests)

**Interfaces:**
- Consumes: existing `_to_revision`, `_assembled`, `DraftFile`, `DraftRevision`.
- Produces:
  - `get_latest(*, run_id) -> list[DraftFile]` — the **latest sealed supersession per path, across generations** (path's newest sealed row wins; siblings in older generations survive).
  - `get_path_latest(*, run_id, path) -> DraftFile | None` — the newest sealed revision for one path, or None when absent/unsealed.

- [ ] **Step 1: Write the failing test**

Modify `test_get_latest_returns_highest_sealed_generation` in `tests/unit/persistence/test_draft_repository.py` from paths-only to the per-path rule, and add the new tests (replace the old body at `tests/unit/persistence/test_draft_repository.py:195-209`):

```python
async def test_get_latest_keeps_latest_sealed_per_path_across_generations(
    repo: DraftRepository,
) -> None:
    rev1 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=1, path="docs/a.md", action="update"
    )
    await repo.append_chunk(rev1.id, "old")
    await repo.finalize(rev1.id)
    rev2 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=2, path="docs/b.md", action="create"
    )
    await repo.append_chunk(rev2.id, "new")
    await repo.finalize(rev2.id)

    by_path = {f.path: f.content for f in await repo.get_latest(run_id="run-1")}
    assert by_path == {"docs/a.md": "old", "docs/b.md": "new"}


async def test_get_latest_partial_supersession_keeps_siblings(
    repo: DraftRepository,
) -> None:
    a1 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=1, path="docs/a.md", action="update"
    )
    await repo.append_chunk(a1.id, "old-a")
    await repo.finalize(a1.id)
    b1 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=1, path="docs/b.md", action="create"
    )
    await repo.append_chunk(b1.id, "beta")
    await repo.finalize(b1.id)
    a2 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=2, path="docs/a.md", action="update"
    )
    await repo.append_chunk(a2.id, "new-a")
    await repo.finalize(a2.id)

    by_path = {f.path: f.content for f in await repo.get_latest(run_id="run-1")}
    assert by_path == {"docs/a.md": "new-a", "docs/b.md": "beta"}


async def test_get_path_latest_returns_newest_sealed_for_path(
    repo: DraftRepository,
) -> None:
    rev1 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=1, path="docs/a.md", action="update"
    )
    await repo.append_chunk(rev1.id, "old-a")
    await repo.finalize(rev1.id)
    rev2 = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=2, path="docs/a.md", action="update"
    )
    await repo.append_chunk(rev2.id, "new-a")
    await repo.finalize(rev2.id)

    latest = await repo.get_path_latest(run_id="run-1", path="docs/a.md")
    assert latest is not None
    assert latest.content == "new-a"


async def test_get_path_latest_none_when_unsealed_or_missing(
    repo: DraftRepository,
) -> None:
    rev = await repo.create_revision(
        run_id="run-1", org_id="org-1", generation=1, path="docs/a.md", action="update"
    )
    await repo.append_chunk(rev.id, "drafting")
    assert await repo.get_path_latest(run_id="run-1", path="docs/a.md") is None
    assert await repo.get_path_latest(run_id="run-1", path="docs/none.md") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/persistence/test_draft_repository.py -q`
Expected: FAIL — `test_get_latest_keeps_latest_sealed_per_path_across_generations` returns `["docs/b.md"]` only; `AttributeError: 'DraftRepository' object has no attribute 'get_path_latest'`.

- [ ] **Step 3: Write minimal implementation**

Replace `get_latest` and add `get_path_latest` in `src/draftly/persistence/repositories/drafts.py`:

```python
    async def get_latest(self, *, run_id: str) -> list[DraftFile]:
        """Latest sealed supersession per path, across generations.

        Supersession is per path, NOT per generation: a per-task retry or a
        reviewer correction opens a newer generation for one file while its
        siblings remain sealed in an older generation. Per-path supersession
        keeps every page's newest bytes without dropping untouched pages.
        """
        rows = await self.database.fetch_all(
            """
            SELECT * FROM draft_revisions
             WHERE run_id = $1
             ORDER BY generation DESC, path
            """,
            run_id,
        )
        files: list[DraftFile] = []
        seen: set[str] = set()
        for row in rows:
            revision = self._to_revision(row)
            if not revision.sealed or revision.path in seen:
                continue
            seen.add(revision.path)
            content = await self._assembled(revision.id)
            files.append(
                DraftFile(
                    path=revision.path,
                    action=revision.action,
                    content=content,
                    content_size=revision.content_size,
                )
            )
        return files

    async def get_path_latest(self, *, run_id: str, path: str) -> DraftFile | None:
        """Newest sealed supersession for one path, or None."""
        rows = await self.database.fetch_all(
            """
            SELECT * FROM draft_revisions
             WHERE run_id = $1
             ORDER BY generation DESC, path
            """,
            run_id,
        )
        for row in rows:
            revision = self._to_revision(row)
            if revision.sealed and revision.path == path:
                return DraftFile(
                    path=revision.path,
                    action=revision.action,
                    content=await self._assembled(revision.id),
                    content_size=revision.content_size,
                )
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/persistence/test_draft_repository.py -q`
Expected: PASS (all, including the 4 rewritten/added tests).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/persistence/repositories/drafts.py draftly-agent-backend/tests/unit/persistence/test_draft_repository.py
git commit -m "feat: per-path draft supersession keeps partial retries safe"
```

---

## Phase B — Fan-out writer node

### Task 4: `WriterFactory` (fresh isolated Agent per task)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/agents/documentation/writer.py`
- Test: `draftly-agent-backend/tests/unit/agents/test_writer_factory.py` (create)

**Interfaces:**
- Consumes: `build_writer_agent` (already in `writer.py:17`), `DocumentationTask`, `Agent`.
- Produces:
  - `WriterFactory.__init__(*, model, tools, runtime=None, builder=None)`
  - `WriterFactory.create(task: DocumentationTask) -> Agent` — NEW Agent per call, built with `agent_id="documentation.writer"`, `node_id="document"`.

- [ ] **Step 1: Write the failing test**

`tests/unit/agents/test_writer_factory.py`:

```python
"""WriterFactory must yield a distinct Agent per task (SDK THROW rule)."""

from __future__ import annotations

from typing import Any

from draftly.agents.documentation.writer import WriterFactory
from draftly.agents.schemas import DocumentationTask


def test_create_returns_distinct_isolated_agents_per_task() -> None:
    built: list[dict[str, Any]] = []

    def fake_builder(model: Any, tools: list[Any], **kwargs: Any) -> Any:
        built.append(kwargs)
        return object()

    factory = WriterFactory(model=object(), tools=[], builder=fake_builder)
    a = factory.create(DocumentationTask(id="t1", path="docs/a.md"))
    b = factory.create(DocumentationTask(id="t2", path="docs/b.md"))

    assert a is not b
    assert [kw["agent_id"] for kw in built] == ["documentation.writer", "documentation.writer"]
    assert [kw["node_id"] for kw in built] == ["document", "document"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/agents/test_writer_factory.py -q`
Expected: FAIL — `ImportError: cannot import name 'WriterFactory'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/draftly/agents/documentation/writer.py`:

```python
class WriterFactory:
    """Builds one FRESH, isolated writer Agent per documentation task.

    Strands rejects concurrent ``invoke_async`` on a single Agent instance
    (``concurrent_invocation_mode`` defaults to THROW), so every concurrently
    running task gets its own Agent sharing model, tools, and steering
    runtime. Never cache an Agent here.
    """

    def __init__(
        self,
        *,
        model: Any,
        tools: list[Any],
        runtime: SteeringRuntime | None = None,
        builder: Any = None,
    ) -> None:
        self.model = model
        self.tools = tools
        self.runtime = runtime
        self._builder = builder or build_writer_agent

    def create(self, task: DocumentationTask) -> Agent:
        return self._builder(
            self.model,
            self.tools,
            runtime=self.runtime,
            agent_id="documentation.writer",
            node_id="document",
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/agents/test_writer_factory.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/agents/documentation/writer.py draftly-agent-backend/tests/unit/agents/test_writer_factory.py
git commit -m "feat: WriterFactory yields an isolated Agent per docs task"
```

---

### Task 5: Fan-out deterministic helpers (`render_task_prompt`, `validate_page`)

**Files:**
- Create: `draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py`
- Test: `draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py` (create)

**Interfaces:**
- Consumes: `DocumentationTask`, `DraftRepository` (duck-typed via `get_path_latest`).
- Produces:
  - `render_task_prompt(task: DocumentationTask) -> str` — plain-text per-task prompt (path, action, reason, symbols, requirements, scoped evidence).
  - `validate_page(task: DocumentationTask, drafts_repo: Any | None, run_id: str | None) -> tuple[bool, list[str]]` — `(True, [])` when drafts_repo is None; else checks a sealed, non-empty revision exists at `get_path_latest(run_id, task.path)`.

- [ ] **Step 1: Write the failing test**

`tests/unit/orchestration/test_fan_out_node.py`:

```python
"""render_task_prompt + validate_page contract tests."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from draftly.agents.schemas import DocumentationTask, EvidenceItem
from draftly.orchestration.nodes.fan_out import render_task_prompt, validate_page


def _task(**overrides) -> DocumentationTask:
    data = dict(
        id="docs/a.md",
        path="docs/a.md",
        action="update",
        reason="behavior changed",
        related_symbols=["Widget"],
        evidence=[EvidenceItem(id="docs/a.md", topic="widgets")],
        requirements=["do not document internals"],
    )
    data.update(overrides)
    return DocumentationTask(**data)


def test_render_task_prompt_carries_path_action_and_scoped_evidence() -> None:
    prompt = render_task_prompt(_task())
    assert "docs/a.md" in prompt
    assert "update" in prompt
    assert "Widget" in prompt
    assert "do not document internals" in prompt
    assert "docs/a.md" in prompt


async def test_validate_page_passes_when_sealed_non_empty() -> None:
    store = SimpleNamespace(
        get_path_latest=_async_get(SimpleNamespace(content="## Guide\n\nbody"))
    )
    ok, reasons = await validate_page(_task(), store, "run-1")
    assert ok is True
    assert reasons == []


async def test_validate_page_fails_when_not_sealed() -> None:
    store = SimpleNamespace(get_path_latest=_async_get(None))
    ok, reasons = await validate_page(_task(), store, "run-1")
    assert ok is False
    assert "no sealed draft" in reasons[0]


async def test_validate_page_fails_on_empty_content() -> None:
    store = SimpleNamespace(get_path_latest=_async_get(SimpleNamespace(content="  ")))
    ok, reasons = await validate_page(_task(), store, "run-1")
    assert ok is False
    assert "empty" in reasons[0]


async def test_validate_page_skips_when_no_store() -> None:
    ok, reasons = await validate_page(_task(), None, "run-1")
    assert ok is True
    assert reasons == []


async def _async_get(value):
    async def get_path_latest(*, run_id: str, path: str):
        return value

    return get_path_latest
```

Note: `test_render_task_prompt_carries_path_action_and_scoped_evidence` intentionally asserts `"docs/a.md"` twice — path and the evidence id. When the task carries no related symbols/requirements the prompt omits those sections; the evidence section always renders.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/orchestration/test_fan_out_node.py -q`
Expected: FAIL — `ModuleNotFoundError: no module named 'draftly.orchestration.nodes.fan_out'`.

- [ ] **Step 3: Write minimal implementation**

`src/draftly/orchestration/nodes/fan_out.py`:

```python
"""Deterministic helpers for the documentation fan-out node."""

from __future__ import annotations

import structlog
from draftly.agents.schemas import DocumentationTask

logger = structlog.get_logger(__name__)


def render_task_prompt(task: DocumentationTask) -> str:
    """One isolated writer prompt for a single page/bundle.

    Scoped to this task's path, action, reason, symbols, requirements, and
    path-matched evidence — other pages' evidence deliberately absent so
    attention never competes across pages.
    """
    lines = [
        f"Documentation task: {task.id}",
        f"Path: {task.path}",
        f"Action: {task.action}",
        f"Reason: {task.reason or 'see evidence'}",
    ]
    if task.related_symbols:
        lines.append("Related symbols: " + ", ".join(task.related_symbols))
    if task.requirements:
        lines.append("Requirements (do not document anything else):")
        lines += [f"- {req}" for req in task.requirements]
    if task.evidence:
        lines.append("Evidence scoped to this page:")
        lines += [
            f"- {item.id}: {item.model_dump(exclude={'id'}, exclude_none=True)}"
            for item in task.evidence
        ]
    return "\n".join(lines)


async def validate_page(
    task: DocumentationTask,
    drafts_repo: object | None,
    run_id: str | None,
) -> tuple[bool, list[str]]:
    """Deterministic per-page gate: a sealed, non-empty draft exists.

    ``drafts_repo is None`` (offline fixtures/harness) skips the store check;
    per-task validation otherwise rejects unsealed or empty pages.
    """
    if drafts_repo is None:
        return True, []
    latest = await drafts_repo.get_path_latest(run_id=run_id, path=task.path)
    if latest is None:
        return False, ["no sealed draft for this page"]
    if not (latest.content or "").strip():
        return False, ["sealed draft is empty"]
    return True, []
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/orchestration/test_fan_out_node.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py
git commit -m "feat: deterministic fan-out prompt and per-page validation helpers"
```

---

### Task 6: `FanOutWriterNode` (semaphore, isolation, retry, aggregation, progress)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py`
- Test: `draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py` (extend)

**Interfaces:**
- Consumes: `parse_node_input`/`agent_result` (`orchestration/nodes/base.py`), `plan_tasks` (`planning.py`), `WriterFactory`, `render_task_prompt`/`validate_page` (this module), `ImpactAnalysis`/`EvidenceBundle`/`DocChangePlan` (schemas).
- Produces:
  - `FanOutWriterNode(name="document", *, writer_factory, write_concurrency=3, limits=None, drafts_repo=None, progress_sink=None)`
  - `invoke_async(task, invocation_state=None, **kwargs) -> MultiAgentResult` — per-task `Agent.invoke_async(render_task_prompt(task), invocation_state=..., limits=...)` under a semaphore; one retry per failed task; payload per Global Constraints. Correction deps (`From review:`) restrict the run to `corrections[].task_id`.
  - Result payload keys: `repository`, `branch`, `commit_message`, `summary`, `files`, `tasks`, `task_count`, `failed_tasks`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/orchestration/test_fan_out_node.py`:

```python
"""FanOutWriterNode behavior tests (scripted agents, no real model)."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from draftly.agents.schemas import DocChangePlan
from draftly.orchestration.nodes.fan_out import FanOutWriterNode


class _FakeAgent:
    def __init__(self, plan) -> None:
        self.plan = plan
        self.invoked: list[str] = []

    async def invoke_async(self, prompt: str, invocation_state=None, **kwargs):
        self.invoked.append(prompt)
        if isinstance(self.plan, Exception):
            raise self.plan
        return self.plan


class _FakeFactory:
    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.agents: list[_FakeAgent] = []

    def create(self, task):
        plan = self.script.pop(0)
        agent = _FakeAgent(plan)
        self.agents.append(agent)
        return agent


def _plan(path: str, action: str = "update") -> DocChangePlan:
    return DocChangePlan(
        repository="acme/api",
        branch="docs/fanout",
        commit_message="docs",
        summary="fan-out",
        files=[{"path": path, "action": action}],
    )


def _input(impact: dict, review: dict | None = None) -> list[dict]:
    lines = ["Original Task: {}", "Inputs from previous nodes:"]
    lines.append("From impact:")
    lines.append(f"  - Agent: {json.dumps(impact)}")
    if review is not None:
        lines.append("From review:")
        lines.append(f"  - Agent: {json.dumps(review)}")
    return [{"text": "\n".join(lines)}]


def _impact(paths: list[str]) -> dict:
    return {
        "action": "update",
        "affected_documents": paths,
        "tasks": [{"id": p, "path": p, "action": "update"} for p in paths],
        "rationale": "behavior changed",
    }


async def test_node_aggregates_two_successful_tasks() -> None:
    factory = _FakeFactory([_plan("docs/a.md"), _plan("docs/b.md", "create")])
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None)

    result = await node.invoke_async(_input(_impact(["docs/a.md", "docs/b.md"])), {"run_id": "run-1"})

    payload = json.loads(result.results["document"].result.message["content"][0]["text"])
    assert payload["task_count"] == 2
    assert {t["path"] for t in payload["tasks"]} == {"docs/a.md", "docs/b.md"}
    assert all(t["ok"] is True for t in payload["tasks"])
    assert {f["path"] for f in payload["files"]} == {"docs/a.md", "docs/b.md"}
    assert payload["failed_tasks"] == []
    assert payload["repository"] == "acme/api"
    assert len(factory.agents) == 2
    assert all(len(agent.invoked) == 1 for agent in factory.agents)


async def test_node_bounds_concurrency() -> None:
    active = 0
    peak = 0

    async def _invoke(prompt: str, invocation_state=None, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return _plan("docs/x.md")

    class _SlowAgent:
        async def invoke_async(self, *a, **k):
            return await _invoke(*a, **k)

    class _SlowFactory:
        def create(self, task):
            return _SlowAgent()

    node = FanOutWriterNode(writer_factory=_SlowFactory(), write_concurrency=2, drafts_repo=None)
    await node.invoke_async(
        _input(_impact(["docs/1.md", "docs/2.md", "docs/3.md", "docs/4.md"])), {"run_id": "run-1"}
    )
    assert peak <= 2


async def test_node_retries_only_the_failed_task_once() -> None:
    class _FailOnceAgent:
        def __init__(self, path: str) -> None:
            self.path = path
            self.failed = path == "docs/a.md"
            self.invoked: list[str] = []

        async def invoke_async(self, prompt: str, invocation_state=None, **kwargs):
            self.invoked.append(prompt)
            if self.failed:
                self.failed = False
                raise RuntimeError("boom")
            return _plan(self.path)

    class _FailOnceFactory:
        def __init__(self) -> None:
            self.created: list[str] = []

        def create(self, task):
            self.created.append(task.path)
            return _FailOnceAgent(task.path)

    factory = _FailOnceFactory()
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None)
    result = await node.invoke_async(
        _input(_impact(["docs/a.md", "docs/b.md"])), {"run_id": "run-1"}
    )

    payload = json.loads(result.results["document"].result.message["content"][0]["text"])
    assert factory.created.count("docs/a.md") == 2  # failed once, then retried
    assert factory.created.count("docs/b.md") == 1
    assert payload["failed_tasks"] == []
    assert all(t["ok"] is True for t in payload["tasks"])


async def test_node_marks_permanently_failed_task_and_keeps_siblings() -> None:
    class _AlwaysBoom:
        async def invoke_async(self, prompt: str, invocation_state=None, **kwargs):
            raise RuntimeError("always")

    class _AlwaysBoomFactory:
        def create(self, task):
            return _AlwaysBoom()

    node = FanOutWriterNode(writer_factory=_AlwaysBoomFactory(), drafts_repo=None)
    result = await node.invoke_async(
        _input(_impact(["docs/a.md", "docs/b.md"])), {"run_id": "run-1"}
    )

    payload = json.loads(result.results["document"].result.message["content"][0]["text"])
    assert payload["failed_tasks"] == ["docs/a.md", "docs/b.md"]
    assert all(t["ok"] is False for t in payload["tasks"])
    assert [t["reasons"][0].startswith("writer failed after retry") for t in payload["tasks"]] == [True, True]


async def test_node_emits_progress_for_each_task() -> None:
    emitted: list[dict] = []

    async def sink(progress: dict) -> None:
        emitted.append(dict(progress))

    factory = _FakeFactory([_plan("docs/a.md"), _plan("docs/b.md")])
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None, progress_sink=sink)
    await node.invoke_async(_input(_impact(["docs/a.md", "docs/b.md"])), {"run_id": "run-1"})

    assert [e["status"] for e in emitted] == ["running", "running", "completed", "completed"]
    assert all(e["total"] == 2 for e in emitted)
    assert {e["task_id"] for e in emitted} == {"docs/a.md", "docs/b.md"}


async def test_node_corrections_restrict_to_corrected_tasks() -> None:
    factory = _FakeFactory([_plan("docs/b.md")])
    node = FanOutWriterNode(writer_factory=factory, drafts_repo=None)
    review = {"verdict": "correct", "corrections": [{"task_id": "docs/b.md", "path": "docs/b.md", "instructions": ["tighten"]}]}

    await node.invoke_async(
        _input(_impact(["docs/a.md", "docs/b.md"]), review=review), {"run_id": "run-1"}
    )

    assert len(factory.agents) == 1  # only the corrected page was re-dispatched
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/orchestration/test_fan_out_node.py -q`
Expected: FAIL — `ImportError: cannot import name 'FanOutWriterNode'`.

- [ ] **Step 3: Write minimal implementation**

Append `FanOutWriterNode` to `src/draftly/orchestration/nodes/fan_out.py`:

```python
import asyncio
from typing import Any

from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status

from draftly.agents.schemas import DocChangePlan, EvidenceBundle, ImpactAnalysis
from draftly.orchestration.nodes.base import agent_result, parse_node_input
from draftly.agents.documentation.planning import plan_tasks
from draftly.agents.documentation.writer import WriterFactory


class FanOutWriterNode(MultiAgentBase):
    """Deterministic fan-out: one isolated writer Agent per documentation task.

    Expands the impact task plan, dispatches tasks under a bounded semaphore,
    retries each failed task ONCE (isolating failure to its own page), and
    returns an aggregated per-task payload. One shared ``DraftScope`` per node
    execution (set by NextGenerationHook) is preserved — this node never
    re-sets it — so concurrent writers share ``(run_id, org_id, generation)``
    and write disjoint paths.
    """

    def __init__(
        self,
        name: str = "document",
        *,
        writer_factory: WriterFactory,
        write_concurrency: int = 3,
        limits: Any = None,
        drafts_repo: Any = None,
        progress_sink: Any = None,
    ) -> None:
        self.name = name
        self._factory = writer_factory
        self.write_concurrency = write_concurrency
        self.limits = limits
        self.drafts_repo = drafts_repo
        self.progress_sink = progress_sink

    async def invoke_async(
        self,
        task: Any,
        invocation_state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> MultiAgentResult:
        deps = parse_node_input(task)
        impact = ImpactAnalysis.model_validate(deps.get("impact") or {})
        evidence = _evidence_bundle(deps.get("research"))
        tasks = plan_tasks(impact, evidence)
        corrections = deps.get("review") or {}
        if corrections.get("corrections"):
            ids = {
                c["task_id"]
                for c in corrections["corrections"]
                if isinstance(c, dict) and c.get("task_id")
            }
            tasks = [t for t in tasks if t.id in ids]

        total = len(tasks)
        if total == 0:
            return self._result(
                self._payload(impact, [], total, []), invocation_state
            )

        sem = asyncio.Semaphore(self.write_concurrency)
        settled = 0

        async def _run_task(
            task_item: Any,
            index: int,
        ) -> tuple[Any, DocChangePlan | None, str | None]:
            nonlocal settled
            async with sem:
                await self._emit(
                    task_item, "running", index + 1, total, invocation_state
                )
                plan, error = await self._attempt(task_item, invocation_state)
                settled += 1
                await self._emit(
                    task_item,
                    "completed" if error is None else "failed",
                    settled,
                    total,
                    invocation_state,
                )
                return task_item, plan, error

        outcomes = await asyncio.gather(
            *[_run_task(t, i) for i, t in enumerate(tasks)],
            return_exceptions=True,
        )

        results: list[dict[str, Any]] = []
        plans: list[DocChangePlan] = []
        for i, outcome in enumerate(outcomes):
            task_item = tasks[i]
            if isinstance(outcome, BaseException):
                results.append(_task_row(task_item, ok=False, reasons=[str(outcome)]))
                continue
            task_item, plan, error = outcome
            results.append(
                _task_row(task_item, ok=error is None, reasons=[error] if error else [])
            )
            if plan is not None:
                plans.append(plan)

        return self._result(self._payload(impact, results, total, plans), invocation_state)

    async def _attempt(
        self, task_item: Any, invocation_state: dict[str, Any] | None
    ) -> tuple[DocChangePlan | None, str | None]:
        plan: DocChangePlan | None = None
        try:
            plan = await self._invoke(task_item, invocation_state)
        except Exception as exc:  # noqa: BLE001 - one retry, then attribution
            # Independent, one-step retry: only this task pays twice.
            try:
                plan = await self._invoke(task_item, invocation_state)
            except Exception as exc2:  # noqa: BLE001
                return None, f"writer failed after retry: {exc2}"
        if plan is None:
            return None, "writer produced no plan"
        ok, reasons = await validate_page(
            task_item, self.drafts_repo, (invocation_state or {}).get("run_id")
        )
        if not ok:
            return plan, "; ".join(reasons)
        return plan, None

    async def _invoke(
        self, task_item: Any, invocation_state: dict[str, Any] | None
    ) -> DocChangePlan | None:
        agent = self._factory.create(task_item)
        kwargs: dict[str, Any] = {}
        if self.limits is not None:
            kwargs["limits"] = self.limits
        result = await agent.invoke_async(
            render_task_prompt(task_item),
            invocation_state=invocation_state,
            **kwargs,
        )
        return getattr(result, "structured_output", None)

    async def _emit(
        self,
        task_item: Any,
        status: str,
        position: int,
        total: int,
        invocation_state: dict[str, Any] | None,
    ) -> None:
        if self.progress_sink is None:
            return
        try:
            await self.progress_sink(
                {
                    "node_id": self.name,
                    "task_id": task_item.id,
                    "path": task_item.path,
                    "action": task_item.action,
                    "status": status,
                    "position": position,
                    "total": total,
                }
            )
        except Exception:  # noqa: BLE001 - best-effort, never fail the node
            logger.warning(
                "progress_publish_failed",
                run_id=(invocation_state or {}).get("run_id"),
                task_id=task_item.id,
                exc_info=True,
            )

    def _payload(
        self,
        impact: ImpactAnalysis,
        results: list[dict[str, Any]],
        total: int,
        plans: list[DocChangePlan],
    ) -> dict[str, Any]:
        files: list[dict[str, str]] = []
        repository = branch = commit_message = ""
        summary = impact.rationale or ""
        for plan in plans:
            plan_dict = plan.model_dump() if hasattr(plan, "model_dump") else dict(plan)
            repository = repository or str(plan_dict.get("repository") or "")
            branch = branch or str(plan_dict.get("branch") or "")
            commit_message = commit_message or str(plan_dict.get("commit_message") or "")
            summary = summary or str(plan_dict.get("summary") or "")
            for entry in plan_dict.get("files") or []:
                if isinstance(entry, dict):
                    path, action = str(entry.get("path") or ""), str(entry.get("action") or "")
                else:
                    path, action = str(getattr(entry, "path", "")), str(getattr(entry, "action", ""))
                if path and path not in {f["path"] for f in files}:
                    files.append({"path": path, "action": action})
        return {
            "repository": repository,
            "branch": branch,
            "commit_message": commit_message,
            "summary": summary,
            "files": files,
            "tasks": results,
            "task_count": total,
            "failed_tasks": [r["task_id"] for r in results if not r["ok"]],
        }

    def _result(
        self, payload: dict[str, Any], invocation_state: dict[str, Any] | None
    ) -> MultiAgentResult:
        logger.info("document_node", run_id=(invocation_state or {}).get("run_id"), **payload)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={self.name: NodeResult(result=agent_result(payload))},
        )


def _task_row(task_item: Any, *, ok: bool, reasons: list[str]) -> dict[str, Any]:
    return {
        "task_id": task_item.id,
        "path": task_item.path,
        "action": task_item.action,
        "ok": ok,
        "reasons": reasons,
        "evidence_refs": [ev.id for ev in task_item.evidence],
    }


def _evidence_bundle(payload: Any) -> EvidenceBundle | None:
    if not payload:
        return None
    try:
        return EvidenceBundle.model_validate(payload)
    except Exception:  # noqa: BLE001 - degrade safely on odd research payloads
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/orchestration/test_fan_out_node.py -q`
Expected: PASS (all six node tests + the five helper tests from Task 5 in the same file). The retry test is order-independent (FailOnce per path): a.md must be created exactly twice and b.md once, with `failed_tasks == []`. If it fails, fix the TEST to that documented semantics — do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/nodes/fan_out.py draftly-agent-backend/tests/unit/orchestration/test_fan_out_node.py
git commit -m "feat: FanOutWriterNode with bounded concurrency and per-task retry"
```

---

## Phase C — Graph integration of the `document` node

### Task 7: Conditions, draft-generation hook, evaluate dep-id, delivery gate

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/routing/conditions.py:84-114` (`generated`, add new conditions) and `:171-197` (`delivery_content_ready`)
- Modify: `draftly-agent-backend/src/draftly/orchestration/hooks/draft_generation.py` (WRITER_NODE_IDS)
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/evaluate.py:277,283` (dep ids)
- Test: `draftly-agent-backend/tests/conditions/test_conditions.py` (extend), `draftly-agent-backend/tests/unit/orchestration/test_draft_generation_hook.py` (modify), `draftly-agent-backend/tests/nodes/test_evaluator.py` (modify dep-id fixtures)

**Interfaces:**
- Consumes: `safe_node_data` (base.py), existing conditions conventions.
- Produces:
  - `route_to_write_of(node_id="impact") -> Callable[[GraphState], bool]` and module const `route_to_write` — true when impact action ∈ {update, create}.
  - `generated` now includes `"document"` in its checked node ids (backward compatible for issue/support graphs, which keep update/create).
  - `eval_ready(state) -> bool` — answer ran, OR review ran and verdict == "clean".
  - `needs_correction(state) -> bool` — review in results and verdict == "correct".
  - `review_clean(state) -> bool` — review in results and verdict == "clean" (content-supply gate for `document → evaluate`).
  - `delivery_content_ready` treats `document` like `update`/`create` for the has_drafts gate.
  - `NextGenerationHook.WRITER_NODE_IDS = ("document",)` — NOT consts changed elsewhere.
  - Evaluator dep scan ids become `("answer", "document")`.

- [ ] **Step 1: Write the failing tests**

Extend `tests/conditions/test_conditions.py`:

```python
from draftly.orchestration.routing.conditions import (
    eval_ready,
    generated,
    needs_correction,
    review_clean,
    route_to_write,
)

def _results(state_results: dict) -> SimpleNamespace:
    return SimpleNamespace(results=state_results, task="")


def test_route_to_write_matces_update_and_create() -> None:
    assert route_to_write(_results({"impact": SimpleNamespace(result=SimpleNamespace(structured_output=ImpactAnalysis(action="update", affected_documents=["d.md"])))}))
    impact = ImpactAnalysis(action="none", affected_documents=[])
    assert route_to_write(_results({"impact": SimpleNamespace(result=SimpleNamespace(structured_output=impact))})) is False


def test_generated_includes_document() -> None:
    assert generated(_results({"document": sentinel_result()})) is True


def test_eval_ready_true_for_answer_only() -> None:
    assert eval_ready(_results({"answer": sentinel_result()})) is True


def test_eval_ready_false_until_review_clean() -> None:
    state = _results({"document": sentinel_result()})
    assert eval_ready(state) is False
    state.results["review"] = SimpleNamespace(result=SimpleNamespace(structured_output=ReviewVerdict(verdict="correct")))
    assert eval_ready(state) is False
    state.results["review"] = SimpleNamespace(result=SimpleNamespace(structured_output=ReviewVerdict(verdict="clean")))
    assert eval_ready(state) is True


def test_needs_correction_and_review_clean_are_verdict_conditions() -> None:
    correct = _results({"review": SimpleNamespace(result=SimpleNamespace(structured_output=ReviewVerdict(verdict="correct")))})
    clean = _results({"review": SimpleNamespace(result=SimpleNamespace(structured_output=ReviewVerdict(verdict="clean")))})
    assert needs_correction(correct) is True and review_clean(correct) is False
    assert needs_correction(clean) is False and review_clean(clean) is True
```

```python
# helper for the above
def sentinel_result():
    return SimpleNamespace(structured_output=object())
```

Note: `ReviewVerdict` does not exist yet (Task 9). To keep this task green WITHOUT Task 9, replace every `ReviewVerdict(...)` constructor in this file's new tests with `SimpleNamespace(verdict="correct")`. The `eval_ready`/`needs_correction`/`review_clean` implementations read `.get("verdict")` from `safe_node_data` dicts, so any verdict-bearing result works. Remove the `ReviewVerdict` import.

Modify `tests/unit/orchestration/test_draft_generation_hook.py`: change the module-local `WRITER_NODE_IDS = ("answer", "update", "create")` at line 23 to `("document",)`, and swap every `"update"`/`"create"` `_event(...)` node-id argument to `"document"` (keep reader-node/idempotency tests as-is).

Modify `tests/nodes/test_evaluator.py`: every dependency fixture that feeds a `From update:` / `From create:` section into the evaluator becomes `From document:` (grep for `"update"`/`"create"` in that file and rename the dep-id labels; adjust nothing else).

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/conditions/test_conditions.py tests/unit/orchestration/test_draft_generation_hook.py tests/nodes/test_evaluator.py -q`
Expected: FAIL — `ImportError: cannot import name 'eval_ready'` (and hook tests fail on `"document"` not in WRITER_NODE_IDS).

- [ ] **Step 3: Write minimal implementation**

In `conditions.py`:

```python
def route_to_write_of(node_id: str = "impact"):
    """Factory: route to the fan-out writer node when a write is required."""

    def check(state: GraphState) -> bool:
        data = safe_node_data(state, node_id)
        return data is not None and data.get("action") in ("update", "create")

    return check


route_to_write = route_to_write_of()
```

Change `generated` to:

```python
def generated(state: GraphState) -> bool:
    """Any of answer/update/create/document has produced output."""
    return any(
        nid in state.results for nid in ("answer", "update", "create", "document")
    )
```

Add after `needs_revision_of`:

```python
def _review_verdict(state: GraphState) -> str | None:
    if "review" not in state.results:
        return None
    data = safe_node_data(state, "review")
    if data is None:
        return None
    return str(data.get("verdict") or "")


def eval_ready(state: GraphState) -> bool:
    """Evaluation may run: the answer path completed, or the review verdict
    accepted the fan-out draft (clean). Gates docs-graph edges so evaluation
    never runs mid-correction."""
    if "answer" in state.results:
        return True
    return _review_verdict(state) == "clean"


def needs_correction(state: GraphState) -> bool:
    """Review found targeted corrections; re-dispatch only corrected tasks."""
    return _review_verdict(state) == "correct"


def review_clean(state: GraphState) -> bool:
    """Review accepted the draft (content-supply gate for document → evaluate)."""
    return _review_verdict(state) == "clean"
```

Change `delivery_content_ready`'s draft gate at `conditions.py:193`:

```python
    if any(nid in state.results for nid in ("update", "create", "document")):
        evaluation = safe_node_data(state, "evaluate")
        if isinstance(evaluation, dict) and evaluation.get("has_drafts") is False:
            return False
```

In `draft_generation.py`, set `WRITER_NODE_IDS = ("document",)` (keep `READER_NODE_IDS = ("deliver",)`).

In `evaluate.py`, replace both `for dep_id in ("answer", "update", "create"):` loops (lines 277 and 283) with `for dep_id in ("answer", "document"):`.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/conditions/test_conditions.py tests/unit/orchestration/test_draft_generation_hook.py tests/nodes/test_evaluator.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/routing/conditions.py draftly-agent-backend/src/draftly/orchestration/hooks/draft_generation.py draftly-agent-backend/src/draftly/orchestration/nodes/evaluate.py draftly-agent-backend/tests/conditions/test_conditions.py draftly-agent-backend/tests/unit/orchestration/test_draft_generation_hook.py draftly-agent-backend/tests/nodes/test_evaluator.py
git commit -m "feat: route and gate the document fan-out node"
```

---

### Task 8: Wire `FanOutWriterNode` into the documentation graph (+ stubs/fixtures)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py:281-305` (writer construction), `:368-410` (nodes/edges), signature adds `progress_sink=None`
- Modify: `draftly-agent-backend/tests/graph/conftest.py` (ImpactAnalysis stub gains `tasks`; FakeDrafts gains `get_path_latest`), `draftly-agent-backend/tests/graph/test_documentation_graph.py` (fixtures/assertions referencing `update`/`create`)
- Modify: `draftly-agent-backend/tests/unit/test_phase4_routing_and_hooks.py` (any `update`/`create` node expectations → `document`)
- Test: existing graph e2e + `tests/unit/test_graph_role_resolution.py`

**Interfaces:**
- Consumes: `FanOutWriterNode`, `WriterFactory` (from Task 4/6), the existing `writer_model`, `writer_tools`, `writer_builder = getattr(registry, "writer_agent", None) or build_writer_agent`, `drafts_repo` param.
- Produces: `build_documentation_graph(..., progress_sink: Any | None = None)`; graph nodes `document` (replacing `update`/`create`), no `update_writer`/`create_writer`; edges `impact → answer` (route_to_answer), `impact → document` (route_to_write), `answer → evaluate`/`document → evaluate`/`context → evaluate`/`research → evaluate` (eval_ready), `evaluate → answer` (needs_revision_of("answer")), `evaluate → document` (needs_revision_of("document")), delivery content edges `document → deliver`/`answer → deliver`/`changelog → deliver` (delivery_content_ready), `changelog_evaluate → deliver` (delivery_content_ready).

- [ ] **Step 1: Write the failing test**

Modify `tests/graph/conftest.py`:
1. Add to the `ImpactAnalysis` stub in `stub_model()` (line 66-70):

```python
            ImpactAnalysis: {
                "action": "update",
                "affected_documents": ["docs/widgets.md"],
                "rationale": "behavior changed",
                "tasks": [
                    {"id": "docs/widgets.md", "path": "docs/widgets.md", "action": "update"}
                ],
            },
```

2. Add `get_path_latest` to the `FakeDrafts` class (after `get_latest`, ~line 160):

```python
    async def get_path_latest(self, *, run_id: str, path: str):
        for r in self.revisions:
            if r["path"] == path:
                return SimpleNamespace(
                    path=r["path"], action=r["action"], content=r["content"]
                )
        return None
```

Modify `tests/graph/test_documentation_graph.py`: grep for `"update"`/`"create"` node ids and swap them for `"document"` in assert statements and edge expectations (e.g., `"update" in graph.nodes` → `"document" in graph.nodes`). Add:

```python
def test_graph_uses_document_fanout_node_not_update_create(
        doc_graph_fixture,  # use the existing graph fixture name in this file
) -> None:
    graph = doc_graph_fixture.graph
    assert "document" in graph.nodes
    assert "update" not in graph.nodes
    assert "create" not in graph.nodes
```

(Use the actual fixture name the file already provides for a built docs graph — adjust `doc_graph_fixture` to it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/graph/test_documentation_graph.py -q`
Expected: FAIL — nodes `update`/`create` still present, `document` absent.

- [ ] **Step 3: Write minimal implementation**

In `documentation_graph.py`, replace the writer construction block (lines 291-305) with:

```python
    writer_builder = getattr(registry, "writer_agent", None) or build_writer_agent
    writer_factory = WriterFactory(
        model=writer_model,
        tools=writer_tools,
        runtime=steering_runtime,
        builder=writer_builder,
    )
    document_node = FanOutWriterNode(
        "document",
        writer_factory=writer_factory,
        write_concurrency=write_concurrency,
        drafts_repo=drafts_repo,
        progress_sink=progress_sink,
    )
```

Add `write_concurrency: int = 3` and `progress_sink: Any | None = None` to `build_documentation_graph`'s signature; pass `write_concurrency=WRTIE_CONCURRENCY` — do not invent a constant: wire it straight through `build_graph_for_run` by adding `**graph_kwargs` override `document_graph_kwargs` if the integration layer is updated (Task 13). For THIS task, keep `write_concurrency` as the signature default `3` and pass it through verbatim.

Replace the generation-fan-out block (lines 368-374) with:

```python
    # Generation fan-out (mutually exclusive conditions)
    builder.add_node(answer_agent, "answer")
    builder.add_node(document_node, "document")
    builder.add_edge("impact", "answer", condition=route_to_answer)
    builder.add_edge("impact", "document", condition=route_to_write)
```

Replace the evaluation edges (lines 397-410) with:

```python
    builder.add_node(evaluator, "evaluate")
    builder.add_edge("answer", "evaluate", condition=eval_ready)
    builder.add_edge("document", "evaluate", condition=eval_ready)
    builder.add_edge("context", "evaluate", condition=eval_ready)
    builder.add_edge("research", "evaluate", condition=eval_ready)

    # Revise loop — scoped to whichever generation node actually ran
    builder.add_edge("evaluate", "answer", condition=needs_revision_of("answer"))
    builder.add_edge("evaluate", "document", condition=needs_revision_of("document"))
```

Replace the delivery content edges (lines 445-447) with:

```python
    builder.add_edge("document", "deliver", condition=delivery_content_ready)
    builder.add_edge("answer", "deliver", condition=delivery_content_ready)
    builder.add_edge("changelog", "deliver", condition=delivery_content_ready)
```

Update imports in `documentation_graph.py`: add `FanOutWriterNode` (from `draftly.orchestration.nodes.fan_out`), `WriterFactory` (from `draftly.agents.documentation.writer`), and switch the conditions import to include `route_to_write`, `eval_ready` (drop `generated` and `route_to_update`/`route_to_create` if now unused elsewhere in this module).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/graph -q`
Expected: PASS (all graph e2e tests with `document` substituted).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py draftly-agent-backend/tests/graph/conftest.py draftly-agent-backend/tests/graph/test_documentation_graph.py draftly-agent-backend/tests/unit/test_phase4_routing_and_hooks.py
git commit -m "feat: wire document fan-out node into the documentation graph"
```

---

## Phase D — Targeted global review

### Task 9: Review schemas + `build_review_agent` + deterministic page summaries

**Files:**
- Modify: `draftly-agent-backend/src/draftly/agents/schemas.py` (`ReviewCorrection`, `ReviewVerdict`)
- Create: `draftly-agent-backend/src/draftly/agents/documentation/reviewer.py`
- Create: `draftly-agent-backend/src/draftly/orchestration/nodes/review.py` (module with `page_summaries`)
- Test: `draftly-agent-backend/tests/unit/agents/test_review_schemas.py` (create), `draftly-agent-backend/tests/unit/agents/test_reviewer_builder.py` (create), `draftly-agent-backend/tests/unit/orchestration/test_review_node.py` (create — summaries only in this task)

**Interfaces:**
- Consumes: `REVIEWER_PROMPT` (`prompts.py:851`), `build_prompt`, `build_draftly_agent`, `load_skills`, `AgentRole.GRADER` (verify the role name in `steering/decisions.py` — use the same role `build_writer_agent` would for a reviewer, currently `AgentRole.GRADER` per the grader builder; if no reviewer role exists use `AgentRole.GRADER`).
- Produces:
  - `ReviewCorrection(task_id, path, instructions: list[str])`
  - `ReviewVerdict(verdict: Literal["clean","correct"] = "clean", corrections: list[ReviewCorrection])`
  - `build_review_agent(model, tools=None, *, runtime=None, agent_id=None, node_id=None) -> Agent` with `structured_output_model=ReviewVerdict`, no skills/tools dependency on writer tools.
  - `page_summaries(drafts_repo, run_id, tasks: list[dict]) -> list[dict]` — deterministic per-page summary built from sealed content: heading list, extracted links, first paragraph, `## References` reference count, char length; `[]` when drafts_repo is None.

- [ ] **Step 1: Write the failing tests**

`tests/unit/agents/test_review_schemas.py`:

```python
from __future__ import annotations

from pydantic import ValidationError
import pytest

from draftly.agents.schemas import ReviewCorrection, ReviewVerdict


def test_review_verdict_defaults_to_clean() -> None:
    verdict = ReviewVerdict()
    assert verdict.verdict == "clean"
    assert verdict.corrections == []


def test_review_verdict_rejects_bad_verdict() -> None:
    with pytest.raises(ValidationError):
        ReviewVerdict(verdict="maybe")


def test_review_correction_holds_instructions() -> None:
    correction = ReviewCorrection(task_id="docs/a.md", path="docs/a.md", instructions=["tighten prose"])
    assert correction.instructions == ["tighten prose"]
```

`tests/unit/agents/test_reviewer_builder.py`:

```python
"""build_review_agent produces a REVIEWER agent with ReviewVerdict output."""

from __future__ import annotations

from typing import Any

from draftly.agents.documentation.reviewer import build_review_agent
from draftly.agents.schemas import ReviewVerdict


def test_review_agent_uses_structured_output_for_review_verdict(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def fake_draftly_agent(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr("draftly.agents.factory.build_draftly_agent", fake_draftly_agent)
    agent = build_review_agent(object())
    assert captured["structured_output_model"] is ReviewVerdict
    assert agent is not None
    assert captured["node_id"] == "review"
```

`tests/unit/orchestration/test_review_node.py` (this task adds the `page_summaries` tests only):

```python
"""ReviewNode deterministic summary derivation tests."""

from __future__ import annotations

from types import SimpleNamespace

from draftly.orchestration.nodes.review import page_summaries


_CONTENT = (
    "# Widgets Guide\n\nwidgets intro paragraph.\n\n"
    "[usage](/#usage) and [api](/#api)\n\n"
    "## References\n\n1. [docs/widgets.md](docs/widgets.md)\n"
    "2. [docs/api.md](docs/api.md)\n"
)


def _store() -> SimpleNamespace:
    async def get_latest(*, run_id: str):
        return [SimpleNamespace(path="docs/widgets.md", content=_CONTENT)]

    return SimpleNamespace(get_latest=get_latest)


async def test_page_summaries_extract_heading_links_first_para_refs() -> None:
    summaries = await page_summaries(
        _store(), "run-1",
        [{"task_id": "docs/widgets.md", "path": "docs/widgets.md"}],
    )
    assert len(summaries) == 1
    summary = summaries[0]
    assert summary["path"] == "docs/widgets.md"
    assert summary["headings"] == ["Widgets Guide"]
    assert summary["links"] == ["/#usage", "/#api"]
    assert "widgets intro paragraph." in summary["first_paragraph"]
    assert summary["references"] == 2
    assert summary["char_length"] == len(_CONTENT)


async def test_page_summaries_empty_without_store() -> None:
    assert await page_summaries(None, "run-1", []) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/agents/test_review_schemas.py tests/unit/agents/test_reviewer_builder.py tests/unit/orchestration/test_review_node.py -q`
Expected: FAIL — imports missing (`ReviewVerdict`, `build_review_agent`, `page_summaries`).

- [ ] **Step 3: Write minimal implementation**

In `schemas.py` (after `DocumentationTask`):

```python
class ReviewCorrection(BaseModel):
    """One targeted page correction from the global review pass."""

    task_id: str
    path: str
    instructions: list[str] = Field(default_factory=list)


class ReviewVerdict(BaseModel):
    """Global cross-page coherence verdict."""

    verdict: Literal["clean", "correct"] = "clean"
    corrections: list[ReviewCorrection] = Field(default_factory=list)
```

(Add `Literal` to the typing import if `from typing import Literal` is not already present.)

`src/draftly/agents/documentation/reviewer.py`:

```python
"""Global documentation reviewer agent (targeted corrections, no tools)."""

from __future__ import annotations

from typing import Any

from strands import Agent

from draftly.agents.factory import build_draftly_agent
from draftly.agents.prompts import REVIEWER_PROMPT, build_prompt
from draftly.agents.schemas import ReviewVerdict
from draftly.steering.context import SteeringRuntime
from draftly.steering.decisions import AgentRole


def build_review_agent(
    model: Any,
    tools: list[Any] | None = None,
    *,
    runtime: SteeringRuntime | None = None,
    agent_id: str | None = None,
    node_id: str | None = None,
) -> Agent:
    """Build the global reviewer: reads compact summaries, returns corrections."""
    return build_draftly_agent(
        role=AgentRole.GRADER,
        system_prompt=build_prompt(REVIEWER_PROMPT, output_model=ReviewVerdict),
        model=model,
        tools=tools or [],
        structured_output_model=ReviewVerdict,
        runtime=runtime or SteeringRuntime.disabled(),
        agent_id=agent_id or "documentation.reviewer",
        node_id=node_id or "review",
        name="documentation_reviewer",
        description="Reviews a coherent docs change set and returns targeted corrections.",
    )
```

`src/draftly/orchestration/nodes/review.py` (summaries helper; node added in Task 10):

```python
"""Global review node helpers for the documentation graph."""

from __future__ import annotations

import re
from typing import Any

_FIRST_HEADING = re.compile(r"^#+\s+(.+)$", re.MULTILINE)
_LINKS = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


async def page_summaries(
    drafts_repo: Any | None, run_id: str | None, tasks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Deterministic, LLM-free page summaries from sealed store content."""
    if drafts_repo is None:
        return []
    by_path = {f.path: f.content for f in await drafts_repo.get_latest(run_id=run_id) or []}
    summaries: list[dict[str, Any]] = []
    for task in tasks:
        path = str(task.get("path") or "")
        content = by_path.get(path, "")
        if not content:
            continue
        summaries.append(
            {
                "path": path,
                "headings": _FIRST_HEADING.findall(content)[:8],
                "links": _LINKS.findall(content)[:10],
                "first_paragraph": _first_paragraph(content),
                "references": len(re.findall(r"(?m)^\s*1\.\s", content)),
                "char_length": len(content),
            }
        )
    return summaries


def _first_paragraph(content: str) -> str:
    body = _FIRST_HEADING.sub("", content, count=1).strip()
    for para in body.split("\n\n"):
        if para.strip():
            return " ".join(para.split())[:400]
    return ""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/agents/test_review_schemas.py tests/unit/agents/test_reviewer_builder.py tests/unit/orchestration/test_review_node.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/agents/schemas.py draftly-agent-backend/src/draftly/agents/documentation/reviewer.py draftly-agent-backend/src/draftly/orchestration/nodes/review.py draftly-agent-backend/tests/unit/agents/test_review_schemas.py draftly-agent-backend/tests/unit/agents/test_reviewer_builder.py draftly-agent-backend/tests/unit/orchestration/test_review_node.py
git commit -m "feat: review verdict schema, reviewer agent, page summaries"
```

---

### Task 10: `ReviewNode`

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/nodes/review.py`
- Test: `draftly-agent-backend/tests/unit/orchestration/test_review_node.py` (extend)

**Interfaces:**
- Consumes: `parse_node_input`/`agent_result` (base.py), `page_summaries` (this module), `build_review_agent` and the reviewer `Agent`.
- Produces:
  - `ReviewNode(name="review", *, reviewer_factory: Any | None = None)` — `MultiAgentBase`; when `reviewer_factory` is None it uses `lambda: build_review_agent(model=None)` — but the graph (Task 11) always injects a factory built from `reviewer_model`. Node invokes the factory's agent with a prompt built from `page_summaries` + the forwarded fan-out tasks, reads `.structured_output` (a `ReviewVerdict`), and returns:
    `{"verdict", "corrections": [{task_id, path, instructions}], "repository", "branch", "commit_message", "summary", "files", "tasks", "task_count", "failed_tasks"}` (forwarding the document-plan keys so `document` content still reaches `evaluate`/`deliver`).
  - Corrections are filtered to task ids present in `document.tasks`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/orchestration/test_review_node.py`:

```python
"""ReviewNode behavior tests (scripted reviewer agent)."""

from __future__ import annotations

import json
from types import SimpleNamespace

from draftly.agents.schemas import ReviewCorrection, ReviewVerdict
from draftly.orchestration.nodes.review import ReviewNode


class _FakeReviewer:
    def __init__(self, verdict: ReviewVerdict) -> None:
        self.verdict = verdict
        self.prompt: str | None = None

    async def invoke_async(self, prompt: str, invocation_state=None, **kwargs):
        self.prompt = prompt
        return SimpleNamespace(structured_output=self.verdict)


def _document_payload() -> dict:
    return {
        "repository": "acme/api",
        "branch": "docs/fanout",
        "commit_message": "docs",
        "summary": "fan-out",
        "files": [{"path": "docs/a.md", "action": "update"}],
        "tasks": [
            {"task_id": "docs/a.md", "path": "docs/a.md", "action": "update", "ok": True, "reasons": [], "evidence_refs": []}
        ],
        "task_count": 1,
        "failed_tasks": [],
    }


def _input(document: dict) -> list[dict]:
    return [{"text": "Original Task: {}\nInputs from previous nodes:\nFrom document:\n  - Agent: " + json.dumps(document)}]


async def test_review_node_clean_verdict_forwards_plan() -> None:
    reviewer = _FakeReviewer(ReviewVerdict(verdict="clean"))
    node = ReviewNode(reviewer_factory=lambda: reviewer)

    result = await node.invoke_async(_input(_document_payload()), {"run_id": "run-1"})

    payload = json.loads(result.results["review"].result.message["content"][0]["text"])
    assert payload["verdict"] == "clean"
    assert payload["corrections"] == []
    assert payload["repository"] == "acme/api"
    assert payload["files"] == [{"path": "docs/a.md", "action": "update"}]
    assert reviewer.prompt is not None
    assert "docs/a.md" in reviewer.prompt


async def test_review_node_filters_corrections_to_known_tasks() -> None:
    reviewer = _FakeReviewer(
        ReviewVerdict(
            verdict="correct",
            corrections=[
                ReviewCorrection(task_id="docs/a.md", path="docs/a.md", instructions=["tighten"]),
                ReviewCorrection(task_id="docs/ghost.md", path="docs/ghost.md", instructions=["nope"]),
            ],
        )
    )
    node = ReviewNode(reviewer_factory=lambda: reviewer)

    result = await node.invoke_async(_input(_document_payload()), {"run_id": "run-1"})

    payload = json.loads(result.results["review"].result.message["content"][0]["text"])
    assert payload["verdict"] == "correct"
    assert [c["task_id"] for c in payload["corrections"]] == ["docs/a.md"]


async def test_review_node_degrades_to_clean_without_verdict() -> None:
    class _EmptyReviewer:
        async def invoke_async(self, prompt: str, invocation_state=None, **kwargs):
            return SimpleNamespace(structured_output=None)

    node = ReviewNode(reviewer_factory=_EmptyReviewer)
    result = await node.invoke_async(_input(_document_payload()), {"run_id": "run-1"})

    payload = json.loads(result.results["review"].result.message["content"][0]["text"])
    assert payload["verdict"] == "clean"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/orchestration/test_review_node.py -q`
Expected: FAIL — `ImportError: cannot import name 'ReviewNode'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/draftly/orchestration/nodes/review.py`:

```python
import structlog
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status

from draftly.orchestration.nodes.base import agent_result, parse_node_input

logger = structlog.get_logger(__name__)


def _render_review_prompt(
    tasks: list[dict[str, Any]], summaries: list[dict[str, Any]], summary: str
) -> str:
    lines = [
        "Review the documentation change set for cross-page coherence.",
        f"Change-set summary: {summary or '(none)'}",
        "",
        "Generated pages:",
    ]
    for task in tasks:
        lines.append(f"- {task['path']} ({task['action']}, ok={task['ok']})")
    lines.append("")
    lines.append("Compact per-page summaries:")
    for blob in summaries:
        lines.append("- " + json.dumps(blob, sort_keys=True))
    lines.append("")
    lines.append(
        "Return verdict 'clean' when coherent, or 'correct' with targeted "
        "per-page instructions keyed by task_id. Never rewrite pages."
    )
    return "\n".join(lines)


class ReviewNode(MultiAgentBase):
    """Targeted global review of the fan-out change set.

    Deterministic composition of compact summaries -> one reviewer LLM ->
    targeted corrections keyed by task_id. Forwards the document-plan keys so
    evaluate/deliver still receive the fan-out payload via the review edge.
    """

    def __init__(
        self,
        name: str = "review",
        *,
        reviewer_factory: Any | None = None,
        drafts_repo: Any | None = None,
    ) -> None:
        self.name = name
        self._reviewer_factory = reviewer_factory or (lambda: None)
        self.drafts_repo = drafts_repo

    async def invoke_async(
        self,
        task: Any,
        invocation_state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> MultiAgentResult:
        deps = parse_node_input(task)
        document = deps.get("document") or {}
        tasks = document.get("tasks") or []
        run_id = (invocation_state or {}).get("run_id")
        summaries = await page_summaries(self.drafts_repo, run_id, tasks)
        prompt = _render_review_prompt(
            tasks, summaries, str(document.get("summary") or "")
        )
        reviewer = self._reviewer_factory()
        verdict = None
        if reviewer is not None:
            result = await reviewer.invoke_async(prompt, invocation_state=invocation_state)
            verdict = getattr(result, "structured_output", None)
        if verdict is None:
            logger.info("review_verdict_degraded", run_id=run_id, reason="no_verdict")
            verdict = SimpleNamespace(verdict="clean", corrections=[])

        known = {t.get("task_id") for t in tasks}
        corrections = [
            {"task_id": c.task_id, "path": c.path, "instructions": list(c.instructions)}
            for c in getattr(verdict, "corrections", []) or []
            if c.task_id in known
        ]

        payload: dict[str, Any] = {
            "verdict": getattr(verdict, "verdict", "clean") or "clean",
            "corrections": corrections,
        }
        for key in (
            "repository", "branch", "commit_message", "summary",
            "files", "tasks", "task_count", "failed_tasks",
        ):
            if key in document:
                payload[key] = document[key]

        return MultiAgentResult(
            status=Status.COMPLETED,
            results={self.name: NodeResult(result=agent_result(payload))},
        )
```

Add `import json` and `from types import SimpleNamespace` to the module imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/orchestration/test_review_node.py -q`
Expected: PASS (6 tests total — 3 summaries + 3 node).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/nodes/review.py draftly-agent-backend/tests/unit/orchestration/test_review_node.py
git commit -m "feat: ReviewNode emits targeted per-page corrections"
```

---

### Task 11: Wire the `review` node into the graph (correction loop)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py`
- Modify: `draftly-agent-backend/tests/graph/test_documentation_graph.py`, `draftly-agent-backend/tests/graph/conftest.py` (add `ReviewVerdict`/`review` stub to `stub_model()` and `ReviewVerdict` to the imports)
- Test: existing graph e2e + `tests/conditions/test_conditions.py`

**Interfaces:**
- Consumes: `ReviewNode`, `build_review_agent`, `reviewer_model = resolve_model_for_role(model, "documentation_reviewer")`.
- Produces: graph adds `review` node and edges:
  - `document → review` (plain)
  - `review → evaluate` (eval_ready)
  - `document → evaluate` (eval_ready) — content-supply gate; stays false during correction
  - `review → document` (needs_correction) — re-dispatches corrected tasks
  - `review → deliver` (delivery_content_ready)
  - `review → changelog` is NOT added (evaluate still gates changelog via `eval_passed`).

- [ ] **Step 1: Write the failing test**

In `tests/graph/conftest.py` `stub_model()`, add the review output (and import `ReviewVerdict` at the top):

```python
            ReviewVerdict: {
                "verdict": "clean",
                "corrections": [],
            },
```

In `tests/graph/test_documentation_graph.py` add:

```python
def test_graph_runs_review_between_document_and_evaluate(
        # use the file's existing built-graph fixture
) -> None:
    assert "review" in graph.nodes
    # evaluation is gated on the review verdict, never on document alone
```

Also add to `tests/conditions/test_conditions.py` an edge-contract test that needs_correction/review_clean behave (already added in Task 7 — nothing new here).

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/graph/test_documentation_graph.py -q`
Expected: FAIL — `review` node absent (or graph build errors from missing `review` edges at `eval_ready`).

- [ ] **Step 3: Write minimal implementation**

In `documentation_graph.py`:
1. Build the reviewer agent alongside the writer factory (near line 291):

```python
    reviewer_builder = getattr(registry, "review_agent", None) or build_review_agent

    def _reviewer_factory() -> Any:
        return reviewer_builder(
            reviewer_model,
            [],
            runtime=steering_runtime,
            agent_id="documentation.reviewer",
            node_id="review",
        )
```

(Set `reviewer_model = resolve_model_for_role(model, "documentation_reviewer")` in the model-resolution block — it already resolves `grader_model`; reuse `grader_model` as `reviewer_model` if the role names map to the same resolver value.)

2. Add the node and edges after the evaluation block (after line `builder.add_edge("evaluate", "document", condition=needs_revision_of("document"))`):

```python
    # Global review: fan-out → targeted review → (clean → evaluate | correct → re-dispatch)
    review_node = ReviewNode("review", reviewer_factory=_reviewer_factory, drafts_repo=drafts_repo)
    builder.add_node(review_node, "review")
    builder.add_edge("document", "review")
    builder.add_edge("review", "evaluate", condition=eval_ready)
    builder.add_edge("review", "document", condition=needs_correction)
    builder.add_edge("review", "deliver", condition=delivery_content_ready)
```

3. Update the delivery content-edge list to include `review → deliver` (the `review` edge feeds the deliver prompt with the forwarded plan).

Add imports for `build_review_agent` and `ReviewNode`, and `needs_correction` to the conditions import.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/graph tests/conditions -q`
Expected: PASS. Additionally run the full routing/hook unit surface to catch cross-graph regressions:

Run: `uv run pytest tests/unit/test_phase4_routing_and_hooks.py tests/unit/test_graph_role_resolution.py tests/graph/test_audit_graph_rows.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py draftly-agent-backend/tests/graph/conftest.py draftly-agent-backend/tests/graph/test_documentation_graph.py
git commit -m "feat: wire review node with targeted-correction loop into docs graph"
```

---

## Phase E — Progress streaming & delivery

### Task 12: `task_progress` envelope builder

**Files:**
- Modify: `draftly-agent-backend/src/draftly/events/stream_envelope.py`
- Test: `draftly-agent-backend/tests/events/test_progress_events.py` (create)

**Interfaces:**
- Consumes: `StreamEnvelope` (same module).
- Produces: `task_progress_envelope(*, run_id="", surface="", node_id=None, task_id="", path="", action="", status="", position=0, total=0) -> StreamEnvelope` with `type="task_progress"` and payload `{schema_version, task_id, path, action, status, position, total}`.

- [ ] **Step 1: Write the failing test**

`tests/events/test_progress_events.py`:

```python
"""task_progress envelope shaping tests."""

from __future__ import annotations

from draftly.events.stream_envelope import StreamEnvelope, task_progress_envelope


def test_task_progress_envelope_shape() -> None:
    env = task_progress_envelope(
        run_id="run-1",
        surface="pull_request",
        node_id="document",
        task_id="docs/a.md",
        path="docs/a.md",
        action="update",
        status="running",
        position=1,
        total=3,
    )
    assert env.type == "task_progress"
    assert env.run_id == "run-1"
    assert env.surface == "pull_request"
    assert env.node_id == "document"
    assert env.payload == {
        "schema_version": "1",
        "task_id": "docs/a.md",
        "path": "docs/a.md",
        "action": "update",
        "status": "running",
        "position": 1,
        "total": 3,
    }


def test_task_progress_envelope_round_trips_through_json() -> None:
    env = task_progress_envelope(
        run_id="run-1",
        surface="pull_request",
        node_id="document",
        task_id="docs/b.md",
        path="docs/b.md",
        action="create",
        status="completed",
        position=2,
        total=2,
    )
    restored = StreamEnvelope.from_json(env.to_json())
    assert restored.type == env.type
    assert restored.payload == env.payload


def test_task_progress_envelope_defaults() -> None:
    env = task_progress_envelope(task_id="t", path="p")
    assert env.type == "task_progress"
    assert env.run_id == ""
    assert env.seq == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/events/test_progress_events.py -q`
Expected: FAIL — `ImportError: cannot import name 'task_progress_envelope'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/draftly/events/stream_envelope.py` after `steering_envelope`:

```python
def task_progress_envelope(
    *,
    run_id: str = "",
    surface: str = "",
    node_id: str | None = None,
    task_id: str = "",
    path: str = "",
    action: str = "",
    status: str = "",
    position: int = 0,
    total: int = 0,
) -> StreamEnvelope:
    """Shape one per-task progress envelope from the fan-out writer node.

    Safe fields only (task/path/action/status/position/total); never carries
    draft content or model messages. Consumed by `filter_graph_event`-free
    out-of-band publishing (see runner progress sink).
    """
    return StreamEnvelope(
        type="task_progress",
        run_id=run_id,
        surface=surface,
        node_id=node_id,
        payload={
            "schema_version": "1",
            "task_id": task_id,
            "path": path,
            "action": action,
            "status": status,
            "position": position,
            "total": total,
        },
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/events/test_progress_events.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/events/stream_envelope.py draftly-agent-backend/tests/events/test_progress_events.py
git commit -m "feat: task_progress envelope for per-page writer progress"
```

---

### Task 13: Runner progress sink + graph-builder forwarding

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py` (`_progress_event_sink` after `_steering_event_sink`; wire in `_default_graph_factory`)
- Modify: `draftly-agent-backend/src/draftly/integrations/strands/graph.py` (`build_graph_for_run` gains `progress_sink: Any | None = None`; forward only for pull_request, pop otherwise)
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py` (already accepts `progress_sink`; no change needed if Task 8 wired it — verify the pass-through from `build_graph_for_run` reaches it)
- Test: `draftly-agent-backend/tests/workflows/test_progress_sink.py` (create)

**Interfaces:**
- Consumes: `task_progress_envelope`, `_RunStreamSeq`, publisher, metrics/logger helpers used by `_steering_event_sink`.
- Produces:
  - `_progress_event_sink(*, publisher, run_id, surface, stream_seq) -> Callable[[dict], Awaitable[None]]` — accepts the node's progress dict, sets `seq = stream_seq.next()`, publishes; on failure increments `draftly_progress_publish_failures_total` and logs, never raising.
  - `build_graph_for_run(..., progress_sink=None)` forwards it for the `pull_request` surface.

- [ ] **Step 1: Write the failing test**

`tests/workflows/test_progress_sink.py`:

```python
"""Runner progress sink contract tests."""

from __future__ import annotations

from types import SimpleNamespace

from draftly.workflows.runner import _RunStreamSeq, _progress_event_sink


class _RecordingPublisher:
    def __init__(self) -> None:
        self.published: list = []

    async def publish(self, envelope) -> None:
        self.published.append(envelope)


async def test_progress_sink_publishes_monotonic_task_progress() -> None:
    publisher = _RecordingPublisher()
    seq = _RunStreamSeq()
    sink = _progress_event_sink(
        publisher=publisher, run_id="run-1", surface="pull_request", stream_seq=seq
    )
    await sink(
        {
            "node_id": "document",
            "task_id": "docs/a.md",
            "path": "docs/a.md",
            "action": "update",
            "status": "completed",
            "position": 1,
            "total": 2,
        }
    )
    await sink(
        {
            "node_id": "document",
            "task_id": "docs/b.md",
            "path": "docs/b.md",
            "action": "create",
            "status": "failed",
            "position": 2,
            "total": 2,
        }
    )

    assert [e.type for e in publisher.published] == ["task_progress", "task_progress"]
    assert [e.seq for e in publisher.published] == [1, 2]
    assert publisher.published[0].run_id == "run-1"
    assert publisher.published[1].payload["status"] == "failed"


async def test_progress_sink_survives_publisher_failure() -> None:
    class _BoomPublisher:
        async def publish(self, envelope) -> None:
            raise RuntimeError("down")

    sink = _progress_event_sink(
        publisher=_BoomPublisher(), run_id="run-1", surface="pull_request", stream_seq=_RunStreamSeq()
    )
    await sink({"task_id": "docs/a.md", "path": "docs/a.md", "status": "running", "position": 1, "total": 1})  # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/workflows/test_progress_sink.py -q`
Expected: FAIL — `ImportError: cannot import name '_progress_event_sink'`.

- [ ] **Step 3: Write minimal implementation**

In `runner.py`, after `_steering_event_sink` (after line 250):

```python
def _progress_event_sink(
    *,
    publisher: Any,
    run_id: str,
    surface: str,
    stream_seq: _RunStreamSeq,
) -> Callable[..., Any]:
    """Wire ONE redacted task-progress envelope per writer-task transition."""

    async def sink(progress: dict[str, Any]) -> None:
        envelope = task_progress_envelope(
            run_id=run_id,
            surface=surface,
            node_id=progress.get("node_id"),
            task_id=str(progress.get("task_id") or ""),
            path=str(progress.get("path") or ""),
            action=str(progress.get("action") or ""),
            status=str(progress.get("status") or ""),
            position=int(progress.get("position") or 0),
            total=int(progress.get("total") or 0),
        )
        envelope.seq = stream_seq.next()
        try:
            await publisher.publish(envelope)
        except Exception:
            _metrics.increment("draftly_progress_publish_failures_total")
            logger.warning(
                "progress_event_publish_failed",
                run_id=run_id,
                seq=envelope.seq,
                exc_info=True,
            )

    return sink
```

In `_default_graph_factory` (near `steering_runtime` wiring, ~line 294), after the steering block:

```python
        publisher = getattr(context, "publisher", None)
        progress_sink = None
        if publisher is not None:
            progress_sink = _progress_event_sink(
                publisher=publisher,
                run_id=run_id,
                surface=surface,
                stream_seq=stream_seq,
            )
```

(Note: the steering branch already binds a local `publisher`; hoist that binding before both sinks and reuse it.) Pass `progress_sink=progress_sink` into `build_graph_for_run(...)`.

In `integrations/strands/graph.py`: add `progress_sink: Any | None = None` to the `build_graph_for_run` signature; in the `surface == "pull_request"` branch add `graph_kwargs["progress_sink"] = progress_sink`; and for every other surface drop it: `graph_kwargs.pop("progress_sink", None)` (extend the existing `_BUILDERS`-guarded pop for `research_plan`, or add a parallel pop). Confirm `documentation_graph.py` accepts it (Task 8 did) and passes it into `FanOutWriterNode(progress_sink=progress_sink)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/workflows/test_progress_sink.py -q`
Expected: PASS.

Run the runner event surface to confirm no regression:
Run: `uv run pytest tests/workflows/test_phase5_runner_events.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add draftly-agent-backend/src/draftly/workflows/runner.py draftly-agent-backend/src/draftly/integrations/strands/graph.py draftly-agent-backend/src/draftly/orchestration/graphs/documentation_graph.py draftly-agent-backend/tests/workflows/test_progress_sink.py
git commit -m "feat: stream task-progress envelopes on the run stream"
```

---

### Task 14: Full-suite verification + docs status note

**Files:**
- Modify: `docs/writer-agent-latency.md`
- No source changes expected (only fixes discovered by verification).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the full backend unit suite**

Run: `uv run pytest -q` (from `draftly-agent-backend/`)
Expected: PASS. Investigate any failure as a bug in the affected task; fix in-place and re-run.

- [ ] **Step 2: Run linters and type-check**

Run: `uv run ruff check . && uv run mypy src`
Expected: PASS (mypy `src` with existing strictness config; ignore no-new-errors exceptions only if pre-existing).

- [ ] **Step 3: Update the latency doc with an implementation-status note**

Append to `docs/writer-agent-latency.md`:

```markdown
## Status

Implemented as of 2026-09-20 per `docs/superpowers/specs/2026-09-20-writer-fanout-design.md`.
The graph now runs `impact → document (fan-out) → review → evaluate → changelog → deliver`;
writer execution is one isolated Agent per task under bounded concurrency with per-task
retry, and progress streams via `task_progress` envelopes.
```

- [ ] **Step 4: Update the project knowledge graph**

Run: `graphify update .` from the repository root (`/Applications/Projects/hackathon/draftly-docs-engineer`).
Expected: graph refreshed without errors. (Dirty graphify-out files are expected; do not skip on that basis.)

- [ ] **Step 5: Commit**

```bash
git add docs/writer-agent-latency.md
git commit -m "docs: note writer fan-out implementation status"
```

---

## Self-review notes

- The `review_clean`/`eval_ready` distinction: `eval_ready` gates evaluation scheduling entirely (answer path or clean review); `review_clean` is the content-supply gate on `document → evaluate` so evaluation never runs mid-correction. Both read results, never mutate.
- `generated` was widened (answer/update/create/document) rather than narrowed so the shared `issue_graph`/`support_graph` keep their current behavior.
- `FanOutWriterNode` never re-sets `DraftScope`; `draft_generation.py` (`WRITER_NODE_IDS = ("document",)`) publishes the single scope the node relies on.
- Corrections re-dispatch only the named tasks (Task 6 `corrections` branch) and per-path supersession (Task 3) keeps siblings intact; the graph's `max_node_executions` rail bounds the review-correction and evaluate-revision loops.
- Task 10 forwards the document-plan keys so the `review → evaluate`/`review → deliver` edges carry the same payload `document → evaluate` did, keeping offline fixtures and the deliver prompt contract unchanged.
- The Task 6 retry test is order-independent (`_FailOnceFactory` fails only a.md's first invoke): a.md must be created exactly twice (one failed attempt + one retry), b.md once, and `failed_tasks == []` — do not weaken these assertions when implementing.