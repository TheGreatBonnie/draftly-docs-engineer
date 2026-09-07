# Onboarding Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every HIGH/MEDIUM defect found in the onboarding API audit so the wizard's backend is production-ready: enforced state machine, install-scoped repository authorization, crash-proof initialization, uniform auth guards, and no latent stale-PAT call sites.

**Architecture:** Defense-in-depth mirroring of the existing frontend model — the UI already enforces a linear step order via `useStepGuard` + `lib/onboarding/constants.ts` (`STEP_ORDER`, `STATE_TO_STEP`); this plan makes the API refuse what the UI merely redirects away from. All changes stay inside `routes/onboarding.py` + its test module; shared client/repo code is consumed, not modified.

**Tech Stack:** FastAPI (async routes), pytest + TestClient + AsyncMock, ruff.

**Spec:** `docs/superpowers/specs/2026-08-22-docs-sync-onboarding-design.md` §5.2 (state machine + API contract), read by executors before Task 2. Audit findings source: controller analysis of `routes/onboarding.py` @ HEAD, 2026-08-25 (issues H1–H3, M1–M4, L1–L4).

## Global Constraints

- Standing directive: **NO git commits** — everything stays uncommitted; commit steps are written but skipped.
- Backend venv interpreter: `.venv/bin/python`; run from `draftly-agent-backend/`.
- Baseline at authoring: full API suite **fully green** (`71 passed`) — keep it green after every task; any new failure is a regression to fix before proceeding.
- Do NOT touch these dirty sibling files: `.env.example`, `.gitignore`, `src/draftly/app/api/routes/github.py`, `tests/api/test_github_routes.py`.
- Follow the file's function-local import style; patch collaborators at their SOURCE modules in tests (proven pattern in `TestConnectGithub` / `TestDiscoverDocumentationAuth`).
- Frontend contract is frozen: request/response shapes may gain fields but never lose or rename; error codes per table below.
- Authoring rulings (vetoable by human partner):
  - **R1 Scope:** HIGH + MEDIUM all fixed; LOW items only where listed (L1, L3-comment, L4-helper). File splitting (L5) deferred.
  - **R2 (H2):** ownership validated EAGERLY at select time — one `get_installation_repositories` round trip; no caching.
  - **R3 (H1):** strict linear machine exactly mirroring `STATE_TO_STEP`; same-state replays allowed (idempotent); violations get `409` with detail `Cannot <action> from <state>`.
  - **R4 (M1):** worker-guard runs BEFORE the `INITIALIZING` write; if `run_task` raises, persist `state="FAILED"`, `failure={"step": "initialization", "detail": str(exc)[:300]}` (matches frontend `failure: {step, detail}` type), then raise `HTTPException(502, "Initialization failed")`.
  - **R5 (L1):** `/initialize/status` returns `failure` normalized to `{"step": ..., "detail": ...}` with `detail` truncated to 300 chars.

## Target State Machine (authoritative)

```text
NOT_STARTED          --POST /workspace-->            WORKSPACE_CREATED
WORKSPACE_CREATED    --POST /github/connect-->       GITHUB_CONNECTED
GITHUB_CONNECTED     --POST /repository-->           REPOSITORY_SELECTED   (replay from REPOSITORY_SELECTED ok)
REPOSITORY_SELECTED  --POST /sources-->              DOCUMENTATION_DISCOVERED  (replay ok)
DOCUMENTATION_DISCOVERED --POST /integrations-->     INTEGRATIONS_CONFIGURED   (replay ok)
INTEGRATIONS_CONFIGURED  --POST /preferences-->      PREFERENCES_CONFIGURED    (replay ok)
PREFERENCES_CONFIGURED   --POST /initialize-->       INITIALIZING -> COMPLETED | FAILED
FAILED                   --POST /initialize/retry--> INITIALIZING
GET /documentation/discover : read-only, requires REPOSITORY_SELECTED or later, never mutates state
GET /complete               : unchanged semantics (marks gate), reachable from PREFERENCES_CONFIGURED/COMPLETED
```

---

### Task 1: Shared org guard + selected_repository helper (M2, L4)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py`
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py`

**Interfaces:**
- Produces: `_org_id(token: dict) -> str` raising `HTTPException(401, "Missing organization ID")` when `org_id` missing/non-str; `_selected(current: dict | None) -> dict` returning `(current or {}).get("selected_repository") or {}`. Every route uses them. No behavior change beyond replacing ad-hoc reads.

- [ ] **Step 1:** Add the two module-level helpers directly under `_repos()`:

```python
def _org_id(token: dict) -> str:
    org_id = token.get("org_id")
    if not isinstance(org_id, str):
        raise HTTPException(status_code=401, detail="Missing organization ID")
    return org_id


def _selected(current: dict | None) -> dict:
    return ((current or {}).get("selected_repository") or {})
```

- [ ] **Step 2:** Replace every inline occurrence across ALL endpoints: the three existing isinstance-guards (get_status, create_workspace, connect_github) become `org_id = _org_id(token)`; the ten bare `token.get("org_id")` sites become the same; replace all eight `((current or {}).get("selected_repository") or {})` expressions with `_selected(current)`; delete the misplaced late checks in `start_initialization`/`retry_initialize` (the helper covers them).
- [ ] **Step 3:** Tests — append one parametrized guard test:

```python
@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/onboarding/status"),
        ("post", "/onboarding/workspace"),
        ("post", "/onboarding/github/connect"),
        ("get", "/onboarding/github/repositories"),
        ("post", "/onboarding/repository"),
        ("post", "/onboarding/documentation/discover"),
        ("post", "/onboarding/sources"),
        ("post", "/onboarding/integrations"),
        ("post", "/onboarding/preferences"),
        ("post", "/onboarding/initialize"),
        ("get", "/onboarding/initialize/status"),
        ("post", "/onboarding/initialize/retry"),
        ("post", "/onboarding/complete"),
    ],
)
def test_missing_org_id_rejected_uniformly(self, client, method, path):
    app.dependency_overrides[get_verified_token] = lambda: {"sub": "tester"}
    kwargs = {"json": {}} if method == "post" else {}
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Missing organization ID"}
```

(Place inside a new class `TestOrgGuards`; import `app` from the fixture via `client.app`. Bodies needing valid JSON like connect accept `{}` — validation happens after the guard.)

- [ ] **Step 4:** RED check first: run the new test class BEFORE Step 1-2 edits — expect failures on endpoints lacking guards. Then implement, expect GREEN: `.venv/bin/python -m pytest tests/api/test_onboarding_routes.py -v`
- [ ] **Step 5:** Full suite green + ruff clean:
`.venv/bin/python -m pytest tests/api/ -q && .venv/bin/python -m ruff check src/draftly/app/api/routes/onboarding.py tests/api/test_onboarding_routes.py`
- [ ] **Step 6:** Commit — SKIP (standing no-commit directive): `git commit -m "refactor(onboarding): uniform org guard + selected helper"` ← DEFERRED

### Task 2: Linear state-machine guards (H1, L3-comment)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py`
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py`

**Interfaces:**
- Consumes: Task 1 helpers; `repos.onboarding.get/upsert/mark_step` mocks from fixture.
- Produces: transition map constant + guard behavior per Target State Machine table. Read spec §5.2 first; confirm it agrees with the table — if it contradicts, STOP and report NEEDS_CONTEXT (spec is binding authority over this table).

- [ ] **Step 0:** Read `docs/superpowers/specs/2026-08-22-docs-sync-onboarding-design.md` section 5.2 and `draftly-agent-frontend/lib/onboarding/constants.ts`. The table above mirrors `STATE_TO_STEP`; reconcile any mismatch in favor of the spec.
- [ ] **Step 1:** Failing tests (new class `TestStateMachineGuards`). Fixture pattern: set `repos.onboarding.get.return_value = {"state": X, "completed_steps": [...]}`, POST, assert:

```python
FORBIDDEN_EXAMPLES = [
    # (endpoint, body, state_from_which_it_must_fail)
    ("sources", {}, "GITHUB_CONNECTED"),
    ("sources", {}, "NOT_STARTED"),
    ("integrations", {"slack": False, "discord": False}, "DOCUMENTATION_DISCOVERED"),  # see note
    ("preferences", {"review_policy": "always"}, "REPOSITORY_SELECTED"),
]
```

NOTE on integrations floor: frontend order is documentation→integrations→preferences, so floor for `/integrations` is `DOCUMENTATION_DISCOVERED`; floor for `/preferences` is `INTEGRATIONS_CONFIGURED`. Also assert regression rejection: from `PREFERENCES_CONFIGURED`, POST `/sources` → 409; and replay acceptance: from `DOCUMENTATION_DISCOVERED`, POST `/sources` → 200.
- [ ] **Step 2:** RED — run new class, expect 409-expectation failures everywhere guards are absent today.
- [ ] **Step 3:** Implement. Module-level constant + guard helper:

```python
_TRANSITIONS: dict[str, tuple[str, ...]] = {
    # endpoint path suffix -> states from which POSTing is allowed
    "workspace": ("NOT_STARTED", "WORKSPACE_CREATED"),
    "github/connect": ("WORKSPACE_CREATED", "GITHUB_CONNECTED"),
    "repository": ("GITHUB_CONNECTED", "REPOSITORY_SELECTED"),
    "sources": ("REPOSITORY_SELECTED", "DOCUMENTATION_DISCOVERED"),
    "integrations": ("DOCUMENTATION_DISCOVERED", "INTEGRATIONS_CONFIGURED"),
    "preferences": ("INTEGRATIONS_CONFIGURED", "PREFERENCES_CONFIGURED"),
}
```

Each guarded endpoint starts with:

```python
    current = await repos.onboarding.get(org_id)
    current_state = (current or {}).get("state", "NOT_STARTED")
    if current_state not in _TRANSITIONS["sources"]:
        raise HTTPException(status_code=409, detail=f"Cannot confirm sources from {current_state}")
```

(adapting verb text per route: create/connect/select/confirm/configure integrations/configure preferences). Existing guards on workspace/connect/repository fold into the same map. Add the comment near the two optional-step `mark_step` calls: `# integrations/preferences are marked but intentionally NOT in REQUIRED_STEPS (spec §5.2: optional personalization)`.
- [ ] **Step 4:** GREEN focused, then full suite + ruff (commands as Task 1 Step 5).
- [ ] **Step 5:** Commit — SKIP (DEFERRED): `git commit -m "feat(onboarding): enforce linear state machine server-side"`

### Task 3: Install-scoped repository selection (H2, H3)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` (`select_repository`, `discover_documentation`)
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py`

**Interfaces:**
- Consumes: `get_installation_token(int)` (source-patchable), `GitHubClient.get_installation_repositories(token) -> list[dict]` (each dict has `full_name`).
- Produces: `/repository` rejects names outside the installation's repo list with `422 {"detail": "Repository <name> is not accessible via this installation"}`; malformed `full_name` (no `/`) rejected with `422 {"detail": "full_name must be 'owner/repo'"}` BEFORE any persistence; `discover_documentation` keeps a defensive identical split-check → 409.

- [ ] **Step 1:** Failing tests (class `TestRepositorySelectionGuard`): patch `get_installation_token` → `"ghs_test"` and `GitHubClient` (mock whose `get_installation_repositories` returns `[{"full_name": "TheGreatBonnie/authly"}]`), state `GITHUB_CONNECTED`:
  - selecting `TheGreatBonnie/authly` → 200, `repository_config.upsert` awaited once;
  - selecting `other/private` → 422, `repository_config.upsert` NOT called, onboarding state NOT mutated;
  - selecting `noshlash` → 422, zero GitHub calls made;
  - discovery defense: state `REPOSITORY_SELECTED` with `full_name="broken"`, POST discover → 409 (no GitHub calls).
- [ ] **Step 2:** RED verification.
- [ ] **Step 3:** Implement in `select_repository` after the state guard, before `repository_config.upsert`: malformed-name check; mint token; fetch list; membership check; then proceed unchanged. In `discover_documentation`, add the same malformed-name 409 before splitting. Keep local-import style.
- [ ] **Step 4:** GREEN + full suite + ruff (as before).
- [ ] **Step 5:** Commit — SKIP (DEFERRED): `git commit -m "feat(onboarding): validate repository belongs to installation"`

### Task 4: Crash-proof initialization (M1)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` (`start_initialization`, `retry_initialize`, `_run_initialize`)
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py`

**Interfaces:**
- Consumes: fixture mocks `state.worker.task_runner.has_task`, `worker.run_task`; setting `state.worker = None` must yield 503 (fixture default sets a MagicMock — tests override).
- Produces: (a) worker unavailable → `503` AND row state UNCHANGED (still `PREFERENCES_CONFIGURED` / `FAILED`); (b) unknown task name → `404` with row unchanged; (c) `run_task` raising → row becomes `state="FAILED"`, `failure={"step": "initialization", "detail": "<msg>[:300]"}`, endpoint responds `502 {"detail": "Initialization failed"}`; (d) success paths byte-identical to today.

- [ ] **Step 1:** Failing tests (class `TestInitializeRobustness`) covering a–d for BOTH `/initialize` (from `PREFERENCES_CONFIGURED`) and `/initialize/retry` (from `FAILED`).
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement: hoist `worker = _worker(request)` + `has_task` check into the two endpoints BEFORE their `upsert(state="INITIALIZING")`; wrap `result = await _run_initialize(...)` in try/except Exception that performs `upsert(state="FAILED", failure={...})` then `raise HTTPException(502, "Initialization failed") from exc`. Leave happy-path returns untouched.
- [ ] **Step 4:** GREEN + full suite + ruff.
- [ ] **Step 5:** Commit — SKIP (DEFERRED): `git commit -m "fix(onboarding): initialize never strands INITIALIZING"`

### Task 5: Latent-PAT removal + hardening odds (M3, M4, L1)

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` (`list_github_repositories`, `complete_onboarding`, `get_initialize_status`)
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py`

**Interfaces:**
- Consumes: Task 1 helpers; patterns from `TestDiscoverDocumentationAuth`.
- Produces: `list_github_repositories` builds `GitHubClient(auth=GitHubAuth(tok))` (sentinel try/except deleted), casts `int(installation_id)`, and its mock asserts auth construction exactly like the discover test; `/complete` tolerates corrupted `completed_steps` string (treats as empty → natural 409 listing all missing steps, no 500); `/initialize/status` normalizes failure per R5.

- [ ] **Step 1:** Failing tests (class `TestRepositoriesAndCompleteHardening`): repositories endpoint asserts `GitHubAuth(token="ghs_test")` + `GitHubClient(auth=...)` construction and 200 passthrough of repo list; `/complete` with `completed_steps="not json[` returns 409 mentioning missing steps (not 500); `/initialize/status` with `failure={"step": "initialization", "detail": "x" * 999}` returns detail length ≤ 300.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement the three changes; wrap json.loads in try/except json.JSONDecodeError → `steps = []`.
- [ ] **Step 4:** GREEN + full suite + ruff.
- [ ] **Step 5:** Commit — SKIP (DEFERRED): `git commit -m "fix(onboarding): remove stale-PAT fallback, harden complete/status"`

---

## Self-Review Checklist (completed at authoring time)

1. **Coverage:** H1→T2, H2/H3→T3, M1→T4, M2→T1, M3/M4/L1→T5, L3-comment→T2, L4-helper→T1. L2 int-cast folded into T5 (same endpoint). L5 deferred per R1. ✔
2. **Placeholders:** none — every task carries concrete transitions, assertions, and commands; unknowns resolved into Step-0 spec reconciliation instead of TBDs. ✔
3. **Type consistency:** `_org_id/_selected/_TRANSITIONS/failure{step,detail}` referenced identically across tasks; frontend `failure` DTO shape honored (types.ts:26). ✔
4. **Sequencing dependency flagged:** Tasks 2/3/5 edit the same regions of onboarding.py — execute strictly in numeric order, single implementer session preferred.
