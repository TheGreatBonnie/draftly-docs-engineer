# Draft Store Design — Stop Transporting File Bytes Through the Model's Tool-Input JSON

## Context and problem

The documentation writer currently emits a `DocChangePlan` as a single
`structured_output` JSON tool call where each `files[]` entry carries the
full markdown body inline (schemas.py:65-76, writer.py:39). When that
payload grows it can exceed the streaming parser budget and be truncated
mid-string, producing `failed to parse tool input json, defaulting to
empty dict` and an empty plan downstream.

`plan_guard.py` was the mitigation: it hard-caps each plan at 2 files, 12k
chars/file, and 16k total (plan_guard.py:22-58). That cap is a symptom,
not a fix — it limits how many documents a single run can propose, so a
review round for a multi-file change surfaces only the consolidated subset
(the live PR #11 review showed 2 docs while 16 topics were flagged missing
by the evaluator).

The real fix is architectural: stop transporting file bytes through the
model's tool-input JSON entirely by separating the **control plane** (the
plan: which paths, what action, commit message, summary) from the **data
plane** (the file bytes, written incrementally by the model through small
tools into a durable draft store).

## Goals

- No file bytes ever appear in a tool-input JSON or a structured-output
  payload for the documentation writers.
- A single run can propose an arbitrary number of files; the 2-file cap is
  removed in favor of per-message size bounds.
- Review, evaluation, and delivery all read the same authoritative
  snapshot of draft content from the store, not from fragile graph-state
  pass-throughs.
- Retries and the existing evaluate→writer revision loop are safe:
  revisions become new immutable generations, never mutations.

## Non-goals

- `ChangelogEntry.raw_markdown` stays as-is (it is bounded, ~1KB).
  Converted later, not in this change.
- Content-variant writers (`content_blog`, `content_linkedin`,
  `content_x`) and the `answer` node's inline `content` are unaffected.
- Historical runs keep working; old `detail.document.files` JSONB remains
  readable without migration.
- No delivery of content back through the model — delivery reads the store.

## Architecture

"`Draft Store` (data plane) → separated from → `DocChangePlan` (control plane)"

```
writer (Agent)
  ├─ tools:  start_draft(repository, path, action) -> {draft_id}
  │           append_chunk(draft_id, content, chunk_size)  # small, validated max
  │           finalize_draft(draft_id)                      # immutable seal
  │           (chunk_size is the model's choice, validated against a max)
  └─ structured_output: DocChangePlan = metadata ONLY
        files: [{path, action}]        # no content
        repository, branch, commit_message, summary

review gate ──┐
evaluator    ──┼── read from DraftRepository: get_latest(run_id) -> generation N
deliver      ──┘
```

- Chunks land in `draft_chunks`, revisions in `draft_revisions`, via the
  existing DB client (same pattern as `reviews.py`).
- Multiple generations per run: each writer visit seals a new generation
  (g1, g2, ...). Consumers read the latest generation. Rejections spawn a
  newer generation instead of mutating.

### Component responsibilities

| Component | Responsibility |
|---|---|
| `draft_revisions` table | One row per sealed file per generation. Immutable after seal. |
| `draft_chunks` table | One row per append; ordered by `chunk_index`; assembled at read time. |
| `DraftRepository` | CRUD + assembly + GC. Single source of truth for proposed bytes. |
| Writer tools | `start_draft`, `append_chunk`, `finalize_draft` — small payloads. |
| `DocChangePlan` (schemas) | Metadata only; `files[]` drops `content`. |
| Evaluator (`evaluate.py`) | `files_present` from sealed drafts; checklist consumes assembled content. |
| Review gate (`review_gate.py`) | Hydrates `document.files[]` from drafts; frontend JSONB shape unchanged. |
| Runner / delivery | Builds `changes=[{path, content, action}]` from sealed drafts + plan metadata. |

## Data model

### `draft_revisions`

```
id            text PK           # draft_id (uuid)
run_id        text NOT NULL
org_id        text NOT NULL
generation    int  NOT NULL     # 1, 2, ... per run
path          text NOT NULL
action        text NOT NULL     # update | create
sealed        boolean NOT NULL  # false while writer still appending
content_size  int               # total assembled size at seal
created_at    timestamptz
sealed_at     timestamptz
```

### `draft_chunks`

```
draft_id      text NOT NULL     # FK -> draft_revisions.id
chunk_index   int  NOT NULL
content       text NOT NULL
created_at    timestamptz
PRIMARY KEY (draft_id, chunk_index)
```

### Assembly rule

`get_generation(run_id, generation)` returns sealed revisions only, each
with `content = ''.join(chunks ordered by chunk_index)`. `get_latest(run_id)`
returns the highest generation that has ≥1 sealed revision, with files
ordered by `path`.

## Writer tools

Registered on the documentation writer agents (`update`, `create`, `answer`
per current node wiring). Each returns a small JSON.

```
start_draft(repository, path, action, generation) -> {draft_id}

append_chunk(draft_id, content, chunk_size=None)  -> {received_chunks, sealed: false}
  # content validated: 1 <= len(content) <= MAX_CHUNK_BYTES (24_000)
  # chunk_size optional; when provided, must equal len(content)

finalize_draft(draft_id) -> {sealed: true, size_bytes, path}
  # after this, append_chunk on draft_id returns a validation error sent to
  # the steering judge as a model error (never silent success)
```

Tool input validation (each enforced, error surfaced to the steering
judge, never silent):

- `content` empty or longer than `MAX_CHUNK_BYTES` → error.
- `append_chunk` against a sealed `draft_id` → error.
- `append_chunk` against an unknown `draft_id` → error.
- `start_draft` path fails normalization (`..`, absolute path, symlink
  escape) → error.
- `chunk_size` provided but != `len(content)` → error.

## `DocChangePlan` schema change

`schema.DocChangePlan.files` keeps `[{path, action}]` and drops inline
`content`. `plan_guard.validate_plan_dict` no longer enforces
`MAX_FILE_CONTENT_CHARS` / `MAX_TOTAL_CONTENT_CHARS`; it keeps requiring
≥1 file and valid paths, and adds a per-file `content`-absence guarantee
(rebuild from drafts at delivery).

## Consumer changes

### Evaluator

`evaluate.py` currently inspects the writer structured output for
`files[].content` (evaluate.py:51-53, 241-246). Change:

- `files_present` = latest generation has ≥1 sealed revision.
- The eval checklist receives assembled content from
  `DraftRepository.get_latest(run_id)`.
- The checklist's per-file evidence cites `path` plus assembled content
  (same shape the model receives today, now sourced from the store).

### Review gate

`review_gate.py:_collect_document` currently reads
`state.results[node_id]["files"]` with content inline. Change to:

- Read the metadata plan from graph state (paths + actions).
- Hydrate each entry's `content` from `DraftRepository.get_latest(run_id)`.
- Emit the same `document` shape as today:
  `{kind, files: [{path, action, content, original_content, original_content_available}], commit_message, summary, branch, repository}`.
- Frontend components (`review-detail-page`, `review-document.tsx`,
  `lib/reviews.ts` normalizeFiles) require **no change** — the JSONB shape
  is preserved.

### Delivery

Runner (`runner.py`) builds `changes` for `DocumentationDelivery.deliver_plan`
from `DraftRepository.get_latest(run_id)` joined with the plan's
`repository`, `branch`, `commit_message`, `summary`. `delivery/documentation.py`
is unchanged — it already consumes `[{path, content, action}]`.

`delivery_content_ready` graph condition keeps gating delivery; its
content check points at the drafts store rather than `state.results`.

## Generations and retries

- Each writer visit starts at `generation = max(existing for run) + 1`.
- `start_draft` is idempotent: same `(run_id, generation, path)` returns
  the existing `draft_id`.
- Worker crash mid-append: partial rows unsealed → invisible to
  `get_latest` → writer restarts a new generation.
- GC: on `finalize_draft`, delete generations at/below
  `latest_generation - KEEP_GENERATIONS` (default 3). Sealed+superseded
  generations are removed; sealed+latest and any unsealed rows from the
  current generation are kept until finalize of that generation or
  timeout.

## Safety rails

- `MAX_CHUNK_BYTES = 24_000` — module-level constant in
  `draftly/agents/documentation/draft_store.py`.
  Per-message bound is the replacement for the removed plan cap.
- Path allow-list: normalized, relative, no `..`, must not escape the repo
  root; enforced in `start_draft`.
- Immutability: `append_chunk` after seal, and `finalize_draft` on an
  already-sealed id, reject. Version change requires a new generation.
- No delivery of content back through tool JSON.

## Testing

- `DraftRepository` unit tests: create/append/finalize/get_latest assembly
  order, idempotent start, after-finalize reject, generation isolation, GC.
- Writer tool tests: chunk bounds, path allow-list, sealed immutability,
  known/unknown draft_id, chunk_size consistency.
- Evaluator tests: `files_present` reflects sealed drafts; assembled
  content reaches checklist.
- Review-gate tests: `_collect_document` hydrates from drafts; JSONB shape
  unchanged (existing review tests stay green).
- Delivery tests: runner builds `changes` from drafts; blocked-delivery
  semantics hold.
- Graph integration: `tests/graph/test_documentation_graph.py` fixtures
  (`RecordingStubModel`) emit `start_draft`/`append_chunk`/
  `finalize_draft` + metadata plan; end-to-end writer → evaluate →
  changelog → deliver assertions run against a faked
  `DraftRepository`.
- Online evaluation: `tests/evaluation/test_online.py` seeds drafts rather
  than structured-output files.

## Rollout

- Ships with the rq-worker orchestration; no migration of historical runs.
- Old `reviews.detail.document.files` rows remain readable (frontend reads
  persisted JSONB).
- `KEEP_GENERATIONS` GC runs on finalize; tuning constant documented in the
  DraftRepository module docstring.