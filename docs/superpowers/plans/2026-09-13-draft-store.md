# Draft Store Implementation Plan — no file bytes through the model's tool-input JSON

## Why

The documentation writer emits `DocChangePlan.files[]` entries with full markdown inline
in one structured-output JSON (schemas.py:65-76, writer.py:39). Past a size threshold the
payload is truncated mid-string by the streaming parser
(`failed to parse tool input json, defaulting to empty dict`), which `plan_guard.py`
patched by hard-capping plans at 2 files / 12k chars/file / 16k total. That cap is a
symptom — it silently limits how many documents a run can propose (the live PR #11 review
showed 2 docs while 16 topics were flagged by the evaluator).

Spec: `docs/superpowers/specs/2026-09-13-draft-store-design.md` (approved). This plan
implements the Draft Store: file bytes travel from the writer to a durable store through
small append tools (data plane), while `DocChangePlan` carries control-plane metadata only.
Review, evaluation, and delivery all read the store.

## Outcomes

- No file bytes in the documentation writers' structured-output JSON. `MAX_FILES_PER_PLAN`
  and per-file content caps are removed (per-message `MAX_CHUNK_BYTES = 24_000` bound on
  `append_chunk` replaces them).
- `draft_revisions` + `draft_chunks` tables persist drafts; versioned generations. Each
  writer node execution opens exactly one generation; consumers
  (`evaluate`, review-gate hydration, delivery) read the latest generation.
- `reviews.detail.document.files[]` JSONB shape unchanged → frontend
  (`review-detail-page.tsx`, `review-document.tsx`, `lib/reviews.ts`) needs no change.
- `ChangelogEntry.raw_markdown`, content-variant writers, and `answer`'s inline `content`
  are untouched (bounded, out of scope).
- Full suite stays green: `1848 passed, 1 failed (pre-existing unrelated),
  6 skipped` on `draftly-agent-backend/.venv/bin/pytest`.

## Reference facts (verified)

- Writer agent: `build_writer_agent` (writer.py) → `structured_output_model=DocChangePlan`,
  tools from `_scope_writer_tools(reg.documentation_engineer, reg.documentation)` in
  `documentation_graph.build_documentation_graph` (`writer_tools`, line ~266).
- `plan_guard.py`: `MAX_FILE_CONTENT_CHARS=12_000`, `MAX_FILES_PER_PLAN=2`,
  `MAX_TOTAL_CONTENT_CHARS=16_000`, `chunk_content`, `validate_plan_dict`
  (content caps), `parse_plan_json_strict`. Also imported by
  `DeliveryService`-adjacent `delivery/documentation.py:29` (`validate_plan_dict`).
- Evaluator reads drafts from graph input: `evaluate.py:240-247`
  (`deps["update"/"create"]["files"]`, `_draft_text` at :44). `EvaluatorNode` is
  constructed in the graph (:355) with `rubric_grader`; run_id available from
  `invocation_state` (:319).
- Review gate `_collect_document` (review_gate.py:74-118) builds `document` from
  `safe_node_data(graph_state, node_id)["files"]` — content inline today. `gate()` is a
  SYNC hook; run_id and classification come from `event.invocation_state` (:137).
- Persistence: runner `WorkflowContext.repositories.<duck>`; `_enrich_review_reason`
  (:1896-1965) is the async step that adds `original_content` before
  `reviews.store_interrupt`. MemoryScope / SteeringScope contextvars set around graph
  invocation by the runner are the pattern for run-scoped tool state
  (`memory/scope.py`, `workflows/steering_scope.py`).
- Migration numbering: next is `058_draft_store.sql` (last used `057_*`).
- `DatabaseClient` API for repos: `execute/fetch_one/fetch_all/transaction`
  (mirror `persistence/repositories/reviews.py`).
- Delivery is the **LLM deliver agent** with `github_delivery` tools
  (create_branch/create_commit/create_pull_request); it reads `From update:` node input
  (graph `_build_node_input`) and opens the PR (DELIVERY_PROMPT rules incl. the
  changelog two-commit flow). Runner only records the receipt
  (`delivery_receipt_from_result`, `_persist_delivery_receipt`). This is a deliberate
  refinement of the spec's "runner builds changes" wording: the model (not the runner)
  is the delivery actor today, so the deliver agent gains a read-only
  `get_drafted_docs` tool instead.
- Retry page / resume: graph resume re-runs the writer nodes via the revision loop;
  generations keyed by node execution count keep rejections immutable.

## Execution model

TDD per task: write the RED test first, watch it fail for the right reason, then implement,
then watch GREEN. Run targeted tests after each task; run the full suite before
finalization. Files are `draftly-agent-backend/...` unless noted.

Checklist is the todo list (tracked with todowrite at execution time).

---

## Task 1 — Migration + `DraftRepository`

Files:
- `src/draftly/persistence/migrations/058_draft_store.sql` (new)
- `src/draftly/persistence/repositories/drafts.py` (new)
- `tests/unit/persistence/test_draft_repository.py` (new)

RED:
- `test_draft_repository.py`: against an in-memory fake `DatabaseClient` (same test
  double style as `tests/unit/persistence` reviewers — verify the local fake class; use a
  small `asyncpg`-shaped stub or reuse an existing in-memory db fixture if present —
  check `conftest.py` in `tests/unit` first), assert:
  - `create_revision(run_id, org_id, generation, path, action) -> DraftRevision(id, sealed=False, content_size=0)`
  - `append_chunk(draft_id, content)` returns new `ReceivedChunks` count; content stored
    by `chunk_index`; order preserved.
  - `finalize(draft_id)` sets `sealed=True`, computes `content_size`, sets `sealed_at`;
    `append_chunk` on sealed id raises `ValueError`.
  - `get_generation(run_id, generation)` returns only sealed revisions with assembled
    `content = ''.join(chunks ordered by chunk_index)`; unsealed rows excluded.
  - `get_latest(run_id)` returns highest generation that has ≥1 sealed revision; files
    ordered by `path`.
  - `list_revisions(run_id, generation=None)` returns rows (sealed incl. content_size).
  - `next_generation(run_id)`: 1 when empty; else max(generation)+1.
  - `gc(run_id)`: keeps latest `KEEP_GENERATIONS=3`; deletes older **sealed** generations
    (their `draft_revisions` + `draft_chunks` rows); never deletes the current open
    generation or any unsealed row.

GREEN: implement.

Migration `058_draft_store.sql`:

```sql
CREATE TABLE IF NOT EXISTS draft_revisions (
    id            text PRIMARY KEY,
    run_id        text NOT NULL,
    org_id        text NOT NULL,
    generation    integer NOT NULL,
    path          text NOT NULL,
    action        text NOT NULL,
    sealed        boolean NOT NULL DEFAULT FALSE,
    content_size  integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    sealed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS draft_revisions_run_gen
    ON draft_revisions (run_id, generation);

CREATE TABLE IF NOT EXISTS draft_chunks (
    draft_id      text NOT NULL REFERENCES draft_revisions (id) ON DELETE CASCADE,
    chunk_index   integer NOT NULL,
    content       text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (draft_id, chunk_index)
);
```

Repository contract (`DraftRevision` dataclass like `ReviewRecord`; `KEEP_GENERATIONS=3`
module constant documented in the docstring). `get_generation` / `get_latest` assemble
content with a single `fetch_all` ordered by `(chunk_index)`; raise on
after-finalize append and on unknown `draft_id`.

Verification: `pytest tests/unit/persistence/test_draft_repository.py`.

---

## Task 2 — Writer draft tools

Files:
- `src/draftly/tools/documentation/drafts.py` (new)
- `src/draftly/agents/documentation/draft_scope.py` (new: run-scoped contextvar)
- `src/draftly/workflows/runner.py` (set/reset scope around graph invocations where
  `set_memory_scope` is called — :396, :429, :581, :824)
- `tests/unit/tools/test_draft_tools.py` (new)

Plain `@tool` async functions (mirror `tools/search/keyword_search.py`), building a
`DraftRepository()` (DatabaseClient) lazily and reading run_id/org_id from a
`DraftScope` contextvar (`draftly/agents/documentation/draft_scope.py`, mirrors
`memory/scope.py`). Generation is NOT a parameter the model chooses — a
`NextGenerationHook` (Task 4) publishes the current generation into the scope.

RED (`test_draft_tools.py`):
- `start_draft(repository, path, action) -> {"draft_id": ...}`; with no active scope the
  tool raises (clear error).
- `append_chunk(draft_id, content, chunk_size=None)`:
  - accepted when `1 <= len(content) <= MAX_CHUNK_BYTES (24_000)`;
  - `chunk_size` given and != `len(content)` → `ValueError`;
  - empty content → `ValueError`;
  - content > `MAX_CHUNK_BYTES` → `ValueError`;
  - sealed or unknown `draft_id` → `ValueError`.
- `finalize_draft(draft_id) -> {"sealed": True, "size_bytes": N, "path": ...}`; unknown /
  already-sealed id → `ValueError`.
- `start_draft` path validation: rejects `..`, absolute paths, symlink-escape, path-fragment
  normalization failures; normalizes and returns the normalized path in the response.

GREEN: implement. Define `MAX_CHUNK_BYTES = 24_000` here and import it in
`plan_guard.py` for the bound documentation (single source of truth). All errors are
`ValueError` with actionable messages so the steering judge surfaces them to the model.

Verification: `pytest tests/unit/tools/test_draft_tools.py`.

---

## Task 3 — `DocChangePlan` metadata-only + plan_guard rightsizing

Files:
- `src/draftly/agents/schemas.py`
- `src/draftly/agents/documentation/plan_guard.py`
- `src/draftly/agents/prompts.py` (WRITER_PROMPT drafting instructions)
- `tests/unit/agents/test_doc_change_plan_guard.py`
- `tests/unit/agents/test_prompts.py` (if it asserts plan content shape — audit first)

RED:
- `schemas.py`: `DocChangePlan.files` field description drops `content`; keep
  `[{path, action: create|update}]`, `min_length=1`. `files` stays
  `list[dict[str, Any]]` so Pydantic tolerates runtime `content` — but add a
  `model_validator(mode="after")` that **rejects** plans whose first file carries a
  non-empty `content` key (enforces the new invariant, fails loudly like the truncation
  fix did). Update `DocChangePlan` usages/tests accordingly.
- `plan_guard.py`:
  - delete `MAX_FILE_CONTENT_CHARS`, `MAX_FILES_PER_PLAN`, `MAX_TOTAL_CONTENT_CHARS`,
    `chunk_content`;
  - `validate_plan_dict`: keep ≥1-file + path checks and the truncation error message;
    drop content-size caps; add "files must not carry content (drafts are streamed via
    start_draft/append_chunk tools)";
  - keep `parse_plan_json_strict`.
  - import `MAX_CHUNK_BYTES` from `draftly.tools.documentation.drafts` for the message.
- Update `test_doc_change_plan_guard.py`: drop oversized-content test; add
  "plan with inline content is rejected" and "plan with N>2 metadata-only files is
  accepted" tests.
- `WRITER_PROMPT`: instruct writer to (1) call `start_draft`/`append_chunk`/
  `finalize_draft` for every file before returning, (2) emit a metadata-only
  `DocChangePlan` (paths/actions only), (3) keep `commit_message`/`summary`/`repository`/
  `branch`. Keep it terse; the prompt is inline policy (prompts.py).

GREEN: implement. Grep for other `DocChangePlan(...)`, `.files` `.get("content")`, and
`MAX_FILE_CONTENT_CHARS` usages across `src/` and update (e.g. graph tests fixtures,
evaluation fixtures, `delivery/documentation.py` which calls `validate_plan_dict` on
assembled `changes` — that call stays valid because assembled changes DO carry content and
no longer trip a size cap).

Verification: `pytest tests/unit/agents/test_doc_change_plan_guard.py
tests/unit/agents/test_prompts.py`.

---

## Task 4 — Graph wiring: draft tools + generation hook + evaluator drafts param

Files:
- `src/draftly/orchestration/hooks/draft_generation.py` (new:
  `NextGenerationHook(HookProvider)`)
- `src/draftly/orchestration/graphs/documentation_graph.py`
- `src/draftly/orchestration/nodes/evaluate.py`
- `src/draftly/orchestration/routing/conditions.py` (`delivery_content_ready` content
  check → drafts store, per spec)
- migration runner wiring if the graph builder needs the repo injected — check whether
  `build_documentation_graph` should accept `drafts_repo` (default `None` → build
  `DraftRepository()` lazily) to keep offline fixtures repo-free.

RED (extend existing graph/evaluator tests — `tests/graph/test_documentation_graph.py`,
`tests/nodes/test_evaluator.py`):
- Hooks: `NextGenerationHook` increments a per-`(run_id, node_id)` counter on
  `BeforeNodeCallEvent` for `update`/`create` and publishes the generation into
  `DraftScope`. New generation starts at 1 per run; each subsequent writer-node execution
  for the same run bumps it. Test: two writer-node calls for one run id produce
  generation 1 then 2; another run id restarts at 1.
- Graph: `update`/`create` writer agents receive the three draft tools appended to
  `writer_tools`; the hook is registered with the builder's hook providers (same
  mechanism as `ReviewGate` at :418). Only `update`/`create` get them; `answer`,
  content-variant writers, and changelog do not.
- Evaluator (`EvaluatorNode`): add `drafts_repo: Any = None` constructor param. When set,
  `files_present` = `get_latest(run_id)` returns ≥1 sealed revision, and `_draft_text`
  is fed assembled content; when `None`, keep the legacy inline-`files` path so existing
  fixtures/eval tests stay green. Run_id from `invocation_state`.
- `delivery_content_ready`: preserve `changelog_eval_passed` AND require the drafts store
  (latest generation has ≥1 sealed revision) when a docs writer completed; other
  surfaces unaffected.

GREEN: implement. Audit `tests/graph/conftest.py` stub_model `DocChangePlan`
fixture (has inline `content`) — evaluator with `drafts_repo=None` keeps it passing; add a
graph-level test asserting the deliver-gate path uses drafts when repo is injected.

Verification: `pytest tests/nodes/test_evaluator.py tests/graph/test_documentation_graph.py`.

---

## Task 5 — Review-gate hydration from drafts

Files:
- `src/draftly/workflows/runner.py` (`_enrich_review_reason`)
- `tests/workflows/` (review-gate enrichment tests; mirror the pre-existing
  `test_runner_terminal_persistence.py` style)

RED:
- `_enrich_review_reason`: for `update`/`create` files whose plan metadata path appears in
  `DraftRepository.get_latest(run_id)`, set `file["content"] = assembled` and
  `file["content_available"] = True` (new key, additive so frontend is untouched; keep the
  existing `original_content` / `original_content_available` behavior). Files absent from
  the latest sealed generation keep `content_available: False`.
- Persisted `reviews.detail.document` keeps the exact JSONB shape the frontend reads
  (`files: [{path, action, content, original_content, original_content_available, ...}]`).
- `_collect_document` (review_gate.py) is unchanged structurally: it returns the
  metadata-only plan from `state.results`; content hydration happens in the runner.

GREEN: implement. The `ReviewGate` stays sync; no async in the hook.

Note: `tests/workflows` graph fixtures may inject writer payloads with inline `content`;
with draft repo absent the gate still persists `content_available: False` — assert that
degradation only where the drafts store is genuinely missing.

Verification: targeted workflow review/persistence tests.

---

## Task 6 — Evaluator + online-eval fixture updates (drafts-seeded)

Files:
- `tests/evaluation/test_online.py`
- `tests/graph/conftest.py` / any `RecordingStubModel`-style fixtures that assert files
  inline (audit `tests/graph` and `tests/evaluation`)

RED:
- Update online-eval environment builders that inject writer `files[]` with inline
  content to seed a `FakeDraftRepository` (the drafts repo param) and emit
  metadata-only plans. Assertions that check `files_present` / plan scope now read sealed
  drafts. The existing `test_build_online_task_env_state_carries_real_diff` pre-existing
  failure stays untouched (out of scope, unrelated).
- Any `DocChangePlan` fixture with inline content in `tests/graph/conftest.py` is moved to
  "metadata-only plan + seeded drafts" for the graph-level assertions that go through
  evaluate/review; keep a legacy fixture for the `drafts_repo=None` fallback path.

GREEN: implement. Run `pytest tests/graph tests/evaluation` and confirm only the known
pre-existing failure remains.

---

## Task 7 — Delivery reads the store (get_drafted_docs)

Files:
- `src/draftly/tools/documentation/drafts.py` (add `get_drafted_docs`)
- `src/draftly/orchestration/graphs/documentation_graph.py` (append tool to the delivery
  agent's tool set)
- `src/draftly/agents/prompts.py` (DELIVERY_PROMPT docs-draft path: fetch bodies via
  `get_drafted_docs`, never expect `files[].content`)
- `tests/unit/tools/test_draft_tools.py`, `tests/workflows/` delivery test

RED:
- `get_drafted_docs(run_id) -> [{path, action, content, content_available}]` reads
  `DraftRepository.get_latest(run_id)`, marking `content_available: False` for metadata
  paths with no sealed revision. No mutation.
- DELIVERY_PROMPT: replace any reliance on inline file content with
  "call `get_drafted_docs` first; commit the bodies it returns". Changelog two-commit and
  source-PR head-branch rules unchanged.
- Delivery code path: `delivery/documentation.py` `validate_plan_dict` still passes for
  assembled `changes` (content present, no size cap). Delivery receipt semantics and
  `is_blocked_delivery` unchanged.

GREEN: implement.

Verification: `pytest tests/unit/tools/test_draft_tools.py` + the delivery workflow test.

---

## Finalization

1. Full suite: `draftly-agent-backend/.venv/bin/pytest` — expect
   `1848 passed, 1 failed (pre-existing unrelated), 6 skipped`.
2. `graphify update .` (AST-only) to keep the knowledge graph current.
3. Commit on the nested `development` branch (feature branch workflow; tests pass).
4. Update the ledger `.superpowers/sdd/2026-09-12-pr-workflow-error-hardening/progress.md`
   and mark this plan complete.

## Risks / decisions to confirm

- **Delivery actor is the LLM agent, not the runner** (spec's Section 5 wording
  "runner builds changes" refined): a read-only `get_drafted_docs` tool keeps Bytes out of
  tool-INPUT JSON while the model still performs commits. If the team instead wants
  deterministic runner-side delivery, that is a separate, larger change (delivery node →
  runner post-graph step) left out of this plan.
- **Generation source**: hook-based node-execution counter (deterministic) rather than a
  model-supplied `generation` arg, per spec. Keeps "each writer visit = new generation"
  without trusting the model to count.
- **Schema validator rejects inline content** holds the invariant loudly instead of
  silently re-capping.
- Watch typecheck + lint (if configured) before each commit.