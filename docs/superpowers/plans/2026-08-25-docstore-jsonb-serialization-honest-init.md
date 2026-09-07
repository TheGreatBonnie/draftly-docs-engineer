# Documentation Store JSONB Serialization + Honest Init Outcomes Implementation Plan

Fixes two defects exposed by the first initialization run that reached persistence:

1. `DataError: invalid input for query argument $4 ... (expected str, got dict)` —
   `DocumentStore.upsert_document`'s INSERT branch passes a raw `metadata` dict to asyncpg,
   which requires pre-serialized strings for JSONB columns. Its own UPDATE branch
   (`document_store.py:280-281`) does `json.dumps(metadata)` correctly; the legacy
   `insert()` method (~line 240) has the same raw-dict bug.
2. Misleading success: per-file sync errors are swallowed into `SyncResult.failed_files`;
   the workflow then marks the onboarding row COMPLETED even when **zero** documents were
   stored. Verified live: row is `COMPLETED`, `document_count=0`, `documentation` table empty,
   stale 401 detail attached.

Why latent until now: every earlier run died at GitHub auth before reaching the DB, and
unit tests inject `FakeDocuments`, so real store paths were never exercised.

## Global Constraints

- NO git commits (standing directive). Commit steps written below — SKIP all.
- Baseline: full suite GREEN (614 passed / 4 skipped); ruff clean on touched files. Keep green.
- TDD per task: RED evidence before implementation.
- Ledger: `.superpowers/sdd/2026-08-25-docstore-jsonb-and-honest-init/progress.md`.
- Don't touch sibling dirty files outside scope.

## Authoring rulings (vetoable)

- R-A: Mirror the proven UPDATE-branch pattern — `json.dumps(metadata)` plus an explicit
  `::jsonb` cast on that placeholder (deterministic regardless of asyncpg type inference).
- R-B: Plain `json.dumps` (no `default=`) — metadata payloads here are str/int only;
  matches most sibling stores.
- R-C: Failure threshold for init = `document_count == 0 AND failed_files non-empty`.
  All-skipped re-runs (0 docs, 0 failures) stay DELIVERED — that's a legitimate idempotent replay.
- R-D: Partial failures (≥1 doc stored) remain DELIVERED; surface
  `failed_files_count` in the workflow result payload for visibility. No new states.
- R-E: `commit_sha='unknown'` derivation deferred (needs an extra API call; `source_hash`
  already powers skip logic). Recorded as known data-quality gap.
- R-F: Recovery resets the poisoned row to `FAILED` with accurate detail AFTER Tasks 1–2 are
  green, so the UI retry button drives the fixed path end-to-end.

---

### Task 1: Serialize JSONB on documentation write paths

**Files:** `src/draftly/integrations/database/document_store.py` (`upsert_document` INSERT
branch ~line 170, legacy `insert()` ~line 240);
`tests/unit/documentation/test_document_store*.py`.

- [ ] Step 0: read existing store tests; identify the client-stub pattern used to capture
  `fetch_one` calls (extend it rather than inventing a new one).
- [ ] Step 1 (RED): tests asserting, for BOTH write paths, that the captured metadata
  argument is a `str` whose `json.loads` equals the original dict, and the SQL casts that
  placeholder to `::jsonb`. Expect RED (dict arrives today).
- [ ] Step 2: verify RED output.
- [ ] Step 3: implement per R-A/R-B in both branches.
- [ ] Step 4: GREEN + full suite + ruff on touched files.
- [ ] Step 5: Commit — SKIP (DEFERRED): `fix(persistence): serialize metadata for jsonb inserts`

### Task 2: Initialization fails honestly when sync stores nothing

**Files:** `src/draftly/workflows/onboarding/initialize.py` (`run_onboarding_initialize`,
success block ~lines 71-98); `tests/unit/workflows/test_onboarding_initialize.py`.

- [ ] Step 1 (RED):
  - zero-progress failure: mock `SyncService.sync` returning
    `SyncResult(document_count=0, chunk_count=0, failed_files=["a.md", "b.md"])` →
    expect `WorkflowStatus.FAILED`, `mark_failed` awaited once, workflow errors mention
    the failed-file count. Today: returns DELIVERED → RED.
  - partial-success visibility: `document_count=1, failed_files=["x.md"]` → still
    DELIVERED, `state.result["failed_files_count"] == 1`.
  - existing completes-test (2 docs, no failures) must stay green byte-for-byte.
- [ ] Step 2: verify RED.
- [ ] Step 3: implement per R-C/R-D inside the try block so the existing except path
  performs `mark_failed` + FAILED finish (no new error handling).
- [ ] Step 4: GREEN + full suite + ruff.
- [ ] Step 5: Commit — SKIP (DEFERRED): `fix(onboarding): fail initialization when sync stores zero documents`

### Task 3: Live recovery (manual, after Tasks 1–2 green)

- [ ] Inspect then reset the poisoned row:
  `UPDATE onboarding_state SET state='FAILED', failure='{"step":"initialization","detail":"pre-fix init attempt: all files failed on jsonb serialization bug"}'::jsonb WHERE org_id='org_3IL8BdUnvi6qVtBkhHyMKHSV5L9';`
  (clears misleading COMPLETED + stale 401 detail; restores retry eligibility).
- [ ] Verify via SELECT; user retries through UI; expect either clean COMPLETED with
  `document_count > 0` or honest FAILED with actionable detail.
- [ ] Confirm `documentation` table row count > 0 for the org afterwards.
- [ ] Hygiene reminder: rotate/remove dead `GITHUB_TOKEN=ghp_…` from `.env`.

## Self-review checklist (authoring time)

- INSERT placeholders are built generically — cast applied by targeting the metadata index,
  not string-replacing the whole SQL. Implementation must compute the placeholder number
  from the columns list. ✔ design
- `upsert_document` UPDATE branch untouched (already correct). ✔ scope
- Task 2 raise happens INSIDE try → reuses mark_failed/except flow; route side needs no
  changes (FAILED mapping shipped earlier today). ✔ blast radius
- Skipped-everything edge keeps DELIVERED (R-C) — avoids breaking idempotent replays. ✔
- Recovery ordered last; retry exercises fixed serialization immediately. ✔ sequencing
