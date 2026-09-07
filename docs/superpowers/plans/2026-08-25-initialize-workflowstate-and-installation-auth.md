# Initialize WorkflowState Contract + Installation Auth Implementation Plan

Fixes the live `/onboarding/initialize` incident: `AttributeError: 'WorkflowState' object has no
attribute 'get'` at `routes/onboarding.py:374`, masking an underlying GitHub 401 from the
initialization workflow (`api.github.com/repos/TheGreatBonnie/authly`).

## Root causes (verified)

1. **Contract mismatch:** `worker.run_task()` returns the task's `WorkflowState`
   dataclass (`src/draftly/workflows/state.py:24`; fields `status/errors/result…`,
   `.to_dict()`, no `.get()`) — not a dict. Route line 374 calls `result.get(...)`.
   The `.get()` assumption predates Task 4 of the hardening plan; unit tests masked it
   by mocking plain dicts. Crash fires *after* the try/except, so the FAILED conversion
   never runs → row can strand in INITIALIZING.
2. **Structural 401:** `GitHubClient.get_repository(client.py:435)` takes no `token`
   param and rides the constructor-time Authorization header. The init workflow builds
   its client via sentinel `_build_github()` (`workflows/onboarding/initialize.py:27-37`):
   `GitHubClient()` on stale env `GITHUB_TOKEN` (dead `ghp_` PAT) with fake
   `"installation-token-auth"` fallback. `SyncService.sync()` mints a valid installation
   token (sync_service.py:72-76) but its `get_repository` call (sync_service.py:79)
   cannot receive it. Same disease previously fixed in routes/discover.
   Related latent instance: bare `GitHubClient()` at `workflows/documentation/documentation_sync.py:45`.

## Global Constraints

- NO git commits (standing directive). Plan includes deferred commit steps — SKIP all.
- Baseline before work: full suite GREEN (605 passed / 4 skipped), ruff clean on touched files. Keep it green.
- TDD per task: RED evidence before implementation, GREEN + full suite + ruff after.
- Don't touch sibling dirty files outside scope (`.env.example`, `.gitignore`,
  `routes/github.py`, `tests/api/test_github_routes.py`).
- Ledger: `.superpowers/sdd/2026-08-25-init-workflow-contract-auth/progress.md`.

## Authoring rulings (vetoable)

- R-A: Route accepts both shapes. `isinstance(raw, WorkflowState)` → map:
  `status == FAILED` → upsert FAILED + `failure={step,detail}` + raise 502 "Initialization failed";
  any other terminal status → respond `{"state": "COMPLETED", "result": raw.to_dict()}`
  (workflow itself already persists COMPLETED + marks step on success — initialize.py:78-90).
  Non-WorkflowState dict → legacy passthrough `{"state": result.get("state", "COMPLETED"), ...}`.
- R-B: ALL post-run shaping lives inside the try; `except HTTPException: raise` MUST precede
  `except Exception` (HTTPException subclasses Exception — wrong order double-wraps the
  FAILED path into a second upsert).
- R-C: Auth fix is two layers: (1) thread token through `get_repository` +
  sync_service call site; (2) delete sentinel `_build_github` and build the client with a real
  installation token resolved in the workflow (defense-in-depth; constructor header becomes valid too).
- R-D: `documentation_sync.py:45` gets the identical treatment (same bug, different trigger path).
- R-E: Live recovery AFTER code is green: set org row to FAILED with explanatory failure detail so
  `/initialize/retry` (now robust) exercises the fixed path end-to-end.

## Target Contracts

- `_execute_initialization(repos, org_id, worker, selected_repository) -> dict` — never raises
  anything but HTTPException(502) on failure; never leaves row INITIALIZING once run_task returned.
- `GitHubClient.get_repository(repository: str, token: str | None = None) -> dict` — optional
  per-call override forwarded to `_request` (mirrors get_tree pattern).
- `SyncService.sync(...)` — every GitHub call authenticated per-call with the minted installation token.
- `run_onboarding_initialize(...)` — client built from installation credentials only;
  missing/unresolvable installation → clean WorkflowState.FAILED error (no env-PAT fallback).

---

### Task 1: Route contract fix (Bug A)

**Files:** `src/draftly/app/api/routes/onboarding.py` (`_execute_initialization`);
`tests/api/test_onboarding_routes.py` (`TestInitializeRobustness`).

- [ ] Step 1 (RED): rework/add tests mocking `worker.run_task` with REAL-shaped values:
  - import `WorkflowState, WorkflowStatus` from `draftly.workflows.state`;
  - success: `AsyncMock(return_value=WorkflowState(run_id="r1").finish(WorkflowStatus.DELIVERED))`
    → 200, body `{"state": "COMPLETED", "result": {...to_dict keys...}}`;
  - workflow-failed: `finish(WorkflowStatus.FAILED)` with `errors=["boom"]` → 502,
    last upsert kwargs `state="FAILED"`, `failure["detail"]` contains "boom";
  - legacy dict passthrough case kept green;
  - post-run shape crash: object whose `.status` property raises → 502 AND row upserted FAILED
    (stranding regression guard);
  - keep existing worker-None→503 and unknown-task→404 cases unchanged.
- [ ] Step 2: verify RED (success case currently AttributeErrors).
- [ ] Step 3: implement per Target Contract + rulings R-A/R-B (local import of WorkflowState
  types, matching file style).
- [ ] Step 4: GREEN + full suite + ruff.
- [ ] Step 5: Commit — SKIP (DEFERRED): `fix(onboarding): map WorkflowState results; never strand INITIALIZING`

### Task 2: get_repository token threading

**Files:** `src/draftly/integrations/github/client.py` (`get_repository`);
`src/draftly/documentation/sync_service.py:79`.

- [ ] Step 1 (RED): test asserting `get_repository("o/r", token="t")` forwards token to the
  transport (follow existing client-test patterns for get_tree token override); sync-service
  test asserting its internal `get_repository` call received the minted token.
- [ ] Step 2: verify RED.
- [ ] Step 3: add `token: str | None = None` param, forward to `_request`; pass `token` at
  sync_service call site.
- [ ] Step 4: GREEN + full suite + ruff on touched files.
- [ ] Step 5: Commit — SKIP (DEFERRED): `fix(github): allow per-call token on get_repository; use it in sync`

### Task 3: Kill sentinel auth in workflows

**Files:** `src/draftly/workflows/onboarding/initialize.py` (`_build_github` removal),
`src/draftly/workflows/documentation/documentation_sync.py:45`; their tests.

- [ ] Step 0: locate existing workflow tests referencing these paths (grep `_build_github`,
  `run_onboarding_initialize`, `documentation_sync` under tests/) and inventory expectations first.
- [ ] Step 1 (RED): adjust/add tests: workflow resolves installation via
  `context.repositories.github_installations.first_for_org(org_id)` + `app_auth.get_installation_token`,
  constructs `GitHubClient(auth=GitHubAuth(token=tok))`; unresolvable installation →
  WorkflowState FAILED with clear error, zero env-PAT construction attempts.
- [ ] Step 2: verify RED.
- [ ] Step 3: implement; delete `_build_github` sentinel entirely; apply same construction
  pattern in documentation_sync (R-D).
- [ ] Step 4: GREEN + full suite + ruff.
- [ ] Step 5: Commit — SKIP (DEFERRED): `fix(workflows): authenticate init/docs-sync with installation tokens`

### Task 4: Live data recovery (manual, after Tasks 1–3 green)

- [ ] Reset stranded row for `org_3IL8BdUnvi6qVtBkhHyMKHSV5L9`: inspect current state first
  (`SELECT state, failure FROM onboarding WHERE org_id='...'`), then set
  `state='FAILED'`, `failure='{"step":"initialization","detail":"pre-fix init attempt crashed route"}'`
  (idempotent regardless of current stranded value).
- [ ] User walkthrough: retry initialization through UI; expect clean 502-on-real-failure or
  COMPLETED on success — no AttributeError, no stuck INITIALIZING.
- [ ] Hygiene reminder: rotate/remove dead `GITHUB_TOKEN=ghp_…` from `.env` (root enabler).

## Self-review checklist (authoring time)

- Route: HTTPException-before-Exception ordering explicit; FAILED path raises inside try →
  caught by HTTPException handler → re-raised without second upsert. ✔
- Success path reports to_dict (serializable), frontend expects `{state, result}` — preserved. ✔
- get_repository default token=None keeps all existing callers byte-compatible. ✔
- Workflow success still self-persists COMPLETED before route maps response — no double-write
  conflicts (route does not rewrite row on success). ✔
- Recovery uses FAILED (retry-eligible) not NOT_STARTED — avoids re-running paid steps. ✔
