# GitHub Org Persistence Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the onboarding `connect_github` endpoint durably persist the installation↔org relationship (`github_installations` row + `organizations.github_org`) immediately after GitHub validates it, so step 4's FK insert can never dangle regardless of webhook delivery order or failure.

**Architecture:** One surgical addition inside `connect_github` — the only point where GitHub's API has just attested the `installation_id`. Reuse the two existing writers that the legacy `/github/link` route already uses (`store_github_installation`, `update_org_github`); both are idempotent upserts, so double-writes from webhook + connect are harmless. The strict webhook handler stays untouched.

**Tech Stack:** FastAPI route (async), asyncpg-backed repository functions, pytest + TestClient + AsyncMock.

**Spec:** Diagnosis captured in this conversation and ledgered in `.superpowers/sdd/2026-08-25-github-setup-redirect-return-to/progress.md`. Root cause chain (all verified against live code + DB):

1. Webhook `_handle_installation_event` (`routes/github.py:287-296`) refuses to store until `get_org_by_github_org(...)` finds a match — but nothing creates that match until after connect → 400 "Organization not found" on every fresh workspace install.
2. Onboarding `connect_github` (`routes/onboarding.py:113-125`) fetches `github_org` from GitHub's API but writes it ONLY into the onboarding state JSONB blob via `repos.onboarding.upsert(...)` — never to canonical tables.
3. Step 4 `select_repository` inserts into `repositories` with FK to `github_installations` → empty table → `ForeignKeyViolationError`.

## Global Constraints

- Standing user directive: **NO git commits** — all changes stay uncommitted; commit steps below are written but deferred until the user lifts this.
- No new dependencies.
- Follow the target file's existing **function-local import** style; this is also what makes collaborators monkeypatchable at their source modules.
- Do NOT modify `_handle_installation_event` (webhook handler in `routes/github.py`) or the `/github/link` route — out of scope by design.
- Known-broken baseline: exactly 3 pre-existing failures exist in `tests/api/test_onboarding_routes.py`; they are unrelated to connect-route persistence and must remain the only failures after this change.
- Design decisions (surfaced to user, unobjected):
  - **D1:** `update_org_github` writes unconditionally (no cross-org 409 during onboarding); the link route's 409-on-conflict stays untouched.
  - **D2:** do NOT fetch/persist the installation's repository list at connect time (step 4 lists repos live via the installation token; no consumer needs a stored copy).
- Persistence errors propagate as HTTP 500 rather than being swallowed — silently continuing would re-create the dangling-FK bug this fix eliminates.
- Backend venv interpreter: `draftly-agent-backend/.venv/bin/python`. Run all commands from `draftly-agent-backend/`.
- Route path note: router prefix is `/onboarding` (`routes/onboarding.py:13`), so tests POST to `/onboarding/github/connect`.

---

### Task 1: Persist installation + org mapping in connect_github

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py:113-118` (add function-local imports + two persistence calls)
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py` (append `TestConnectGithub` class at end of file)

**Interfaces:**
- Consumes:
  - `store_github_installation(*, org_id: str, installation_id: int, github_org: str, repositories: list[dict] | None = None, db: DatabaseClient | None = None) -> str` — defined at `src/draftly/persistence/repositories/github.py:70`, upsert semantics (safe when webhook also writes).
  - `update_org_github(*, org_id: str, github_org: str, db: DatabaseClient | None = None) -> None` — defined at `src/draftly/persistence/repositories/organizations.py:14`.
  - `get_installation_info(installation_id: int) -> dict` — defined at `src/draftly/integrations/github/app_auth.py:81`; returns GitHub API payload with `account.login`.
  - TestClient fixture `client()` from `tests/api/test_onboarding_routes.py` (overrides `get_verified_token` → `{"sub": "tester", "org_id": "test-org"}`; mocks repositories bundle at `client.app.state.draftly.dependencies.repositories`).
- Produces: unchanged HTTP contract `200 {"state": "GITHUB_CONNECTED", "github_org": <str>}` — frontend unaffected. Side effect (new): durable rows in `github_installations` + `organizations.github_org` backfill.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_onboarding_routes.py`:

```python
class TestConnectGithub:
    """connect_github must persist installation + org mapping (self-heal fix)."""

    INSTALLATION_INFO = {"account": {"login": "acme"}}
    CONNECT_BODY = {"installation_id": 156346003}

    @pytest.fixture()
    def patches(self):
        with ExitStack() as stack:
            info = stack.enter_context(
                patch(
                    "draftly.integrations.github.app_auth.get_installation_info",
                    new=AsyncMock(return_value=self.INSTALLATION_INFO),
                )
            )
            store = stack.enter_context(
                patch(
                    "draftly.persistence.repositories.github.store_github_installation",
                    new=AsyncMock(),
                )
            )
            upd = stack.enter_context(
                patch(
                    "draftly.persistence.repositories.organizations.update_org_github",
                    new=AsyncMock(),
                )
            )
            yield store, upd

    def _set_state(self, client, state: str):
        client.app.state.draftly.dependencies.repositories.onboarding.get.return_value = {
            "state": state,
        }

    def _post(self, client):
        return client.post("/onboarding/github/connect", json=self.CONNECT_BODY)

    def test_connect_persists_installation_and_org_mapping(self, client, patches):
        store, upd = patches
        self._set_state(client, "WORKSPACE_CREATED")

        resp = self._post(client)

        assert resp.status_code == 200
        assert resp.json() == {"state": "GITHUB_CONNECTED", "github_org": "acme"}
        store.assert_awaited_once_with(
            org_id="test-org", installation_id=156346003, github_org="acme"
        )
        upd.assert_awaited_once_with(org_id="test-org", github_org="acme")

    def test_connect_upserts_selected_repository_blob(self, client, patches):
        self._set_state(client, "WORKSPACE_CREATED")
        repos = client.app.state.draftly.dependencies.repositories

        resp = self._post(client)

        assert resp.status_code == 200
        blob = repos.onboarding.upsert.await_args.kwargs["selected_repository"]
        assert blob["github_org"] == "acme"
        assert blob["installation_id"] == 156346003

    def test_reconnect_is_idempotent(self, client, patches):
        store, upd = patches
        self._set_state(client, "GITHUB_CONNECTED")

        first = self._post(client)
        second = self._post(client)

        assert first.status_code == 200
        assert second.status_code == 200
        assert store.await_count == 2
        assert upd.await_count == 2

    def test_persistence_failure_propagates(self, client, patches):
        store, _ = patches
        store.side_effect = RuntimeError("db down")
        self._set_state(client, "WORKSPACE_CREATED")

        with pytest.raises(RuntimeError, match="db down"):
            self._post(client)
```

Notes for the implementer:
- `patch`, `AsyncMock`, `ExitStack`, `pytest` are already imported at the top of this test file — add nothing there.
- Patching the SOURCE modules works because `connect_github` imports these names inside its function body at call time (existing local-import style); keep that style in the implementation.

- [ ] **Step 2: Run tests to verify RED**

Run: `.venv/bin/python -m pytest tests/api/test_onboarding_routes.py::TestConnectGithub -v`
Expected:
- `test_connect_persists_installation_and_org_mapping` FAILS (`store.assert_awaited_once_with` sees 0 calls)
- `test_connect_upserts_selected_repository_blob` PASSES (blob write already existed pre-fix — this test locks it in)
- `test_reconnect_is_idempotent` FAILS (0 calls vs expected 2)
- `test_persistence_failure_propagates` PASSES trivially today (nothing to raise); it guards the no-swallow contract going forward

- [ ] **Step 3: Implement**

In `src/draftly/app/api/routes/onboarding.py`, inside `connect_github`, replace:

```python
    from draftly.integrations.github.app_auth import get_installation_info

    info = await get_installation_info(body.installation_id)
    github_org = (info.get("account") or {}).get("login", "unknown")
```

with:

```python
    from draftly.integrations.github.app_auth import get_installation_info
    from draftly.persistence.repositories.github import store_github_installation
    from draftly.persistence.repositories.organizations import update_org_github

    info = await get_installation_info(body.installation_id)
    github_org = (info.get("account") or {}).get("login", "unknown")
    await store_github_installation(
        org_id=org_id,
        installation_id=body.installation_id,
        github_org=github_org,
    )
    await update_org_github(org_id=org_id, github_org=github_org)
```

Everything downstream (the `repos.onboarding.upsert(selected_repository={...})` blob write, `mark_step`, and the `return {"state": "GITHUB_CONNECTED", ...}`) stays byte-identical. Do not reorder the two new calls relative to each other; do not wrap them in try/except.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `.venv/bin/python -m pytest tests/api/test_onboarding_routes.py::TestConnectGithub -v`
Expected: PASS ×4.

- [ ] **Step 5: Run the full backend API suite**

Run: `.venv/bin/python -m pytest tests/api/ -q`
Expected: everything passes EXCEPT exactly the 3 known pre-existing failures in `tests/api/test_onboarding_routes.py` (unrelated baseline). Any NEW failure is a regression — stop and investigate.

- [ ] **Step 6: Lint touched files**

Run: `.venv/bin/python -m ruff check src/draftly/app/api/routes/onboarding.py tests/api/test_onboarding_routes.py`
Expected: clean (or identical to pre-existing findings on untouched lines only).

- [ ] **Step 7: Commit (DEFERRED per standing no-commit directive)**

```bash
git add src/draftly/app/api/routes/onboarding.py tests/api/test_onboarding_routes.py
git commit -m "fix(onboarding): persist installation + org mapping on connect"
```

Do not run while the user's no-commit directive stands; stage nothing either.

---

### Task 2: Live verification walkthrough

**Files:** none modified — verification only. Requires backend uvicorn running with current code, ngrok tunnel up, Next dev server running with `allowedDevOrigins` (already applied earlier this session).

**Interfaces:**
- Consumes: Task 1's implemented route; user-driven browser flow through `https://grit-flagstone-recreate.ngrok-free.dev/onboarding`.

- [ ] **Step 1: Fresh-workspace install flow**

Have the user (or drive via browser automation): create a brand-new workspace → click Connect GitHub → install the App on `TheGreatBonnie` → land back on `/onboarding/github` → proceed to repository selection (step 4).

Expected outcomes:
- No `ForeignKeyViolationError` anywhere in uvicorn logs.
- ngrok request log shows either webhook `installation.created` returning 200 (if it arrives after connect healed the tables) or still 400 pre-connect — both are acceptable; the invariant is that CONNECT itself now heals.
- Step 4 lists repositories normally.

- [ ] **Step 2: Read-only DB sanity**

Run from `draftly-agent-backend/`:

```bash
.venv/bin/python - <<'EOF'
import asyncio
from draftly.app.config import get_settings
from draftly.integrations.database.client import DatabaseClient

async def main():
    s = get_settings()
    db = DatabaseClient(s.database_url)
    await db.start()
    installs = await db.fetch_all("SELECT installation_id, org_id, github_org FROM github_installations")
    print("github_installations:", [dict(r) for r in installs])
    orgs = await db.fetch_all("SELECT clerk_org_id, github_org FROM organizations WHERE github_org IS NOT NULL")
    print("linked organizations:", [dict(r) for r in orgs])
    await db.close()

asyncio.run(main())
EOF
```

Expected: newest `installation_id` present WITHOUT any manual repair script; matching org row has non-null `github_org`.

### Task 3: Authenticate discover_documentation as the App installation

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/onboarding.py` (`discover_documentation`, replace the `try/except` client construction ~lines 216-222)
- Test: `draftly-agent-backend/tests/api/test_onboarding_routes.py` (append `TestDiscoverDocumentationAuth` class)

**Interfaces:**
- Consumes: `get_installation_token(installation_id: int) -> str` (`integrations/github/app_auth.py`); `GitHubClient(auth=...)` construction-time Authorization header (`integrations/github/client.py:44`); `GitHubAuth(token: str)` dataclass/model (`integrations/github/auth.py`); fixture `client()` from the test module.
- Produces: unchanged HTTP contract `200 {"candidates": [...], "count": int, "total_files": int}`; behavioral change: every GitHub call in this route authenticates with the minted installation token instead of env `GITHUB_TOKEN`.

**Background:** live 401 on `GET /repos/TheGreatBonnie/authly` — route minted a valid `ghs_…` installation token into `tok` but only passed it to `get_tree`; `get_repository` rode the client's constructor auth built from stale `.env` `GITHUB_TOKEN=ghp_…`.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_onboarding_routes.py`:

```python
class TestDiscoverDocumentationAuth:
    """discover_documentation must authenticate all calls as the App installation."""

    INSTALLATION_TOKEN = "ghs_test_123"

    @pytest.fixture()
    def patches(self):
        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    "draftly.integrations.github.app_auth.get_installation_token",
                    new=AsyncMock(return_value=self.INSTALLATION_TOKEN),
                )
            )
            auth_cls = stack.enter_context(
                patch("draftly.integrations.github.auth.GitHubAuth")
            )
            client_cls = stack.enter_context(
                patch("draftly.integrations.github.client.GitHubClient")
            )
            gh = client_cls.return_value
            gh.get_repository = AsyncMock(return_value={"default_branch": "main"})
            gh.get_tree = AsyncMock(
                return_value=[{"type": "blob", "path": "README.md"}]
            )
            yield auth_cls, client_cls

    def _set_selected_repository(self, client):
        client.app.state.draftly.dependencies.repositories.onboarding.get.return_value = {
            "state": "REPOSITORY_SELECTED",
            "selected_repository": {
                "full_name": "TheGreatBonnie/authly",
                "installation_id": 156354594,
            },
        }

    def test_all_github_calls_use_installation_token(self, client, patches):
        auth_cls, client_cls = patches
        self._set_selected_repository(client)

        resp = client.post("/onboarding/documentation/discover")

        assert resp.status_code == 200
        auth_cls.assert_called_once_with(token=self.INSTALLATION_TOKEN)
        client_cls.assert_called_once_with(auth=auth_cls.return_value)
        gh = client_cls.return_value
        gh.get_repository.assert_awaited_once_with("TheGreatBonnie/authly")
        gh.get_tree.assert_awaited_once_with(
            "TheGreatBonnie", "authly", "main", self.INSTALLATION_TOKEN
        )
        body = resp.json()
        assert body["count"] >= 1
        assert body["total_files"] == 1
        assert any(c["path"] == "README.md" for c in body["candidates"])
```

(The `discover()` helper imported by the route is pure path filtering — left unpatched deliberately so the assertion covers real candidate output.)

Patch targets work because the route imports `get_installation_token`, `GitHubClient`, and (post-fix) `GitHubAuth` inside its function body at call time — existing local-import style.

- [ ] **Step 2: Run test to verify RED**

Run: `.venv/bin/python -m pytest tests/api/test_onboarding_routes.py::TestDiscoverDocumentationAuth -v`
Expected: FAIL — today the route constructs `GitHubClient()` with no kwargs, so `client_cls.assert_called_once_with(auth=...)` sees a zero-kwarg call (and/or `GitHubAuth` never called).

- [ ] **Step 3: Implement**

In `discover_documentation`, replace:

```python
    tok = await get_installation_token(int(installation_id))
    try:
        github = GitHubClient()
    except RuntimeError:
        from draftly.integrations.github.auth import GitHubAuth

        github = GitHubClient(auth=GitHubAuth(token="installation-token-auth"))
```

with:

```python
    from draftly.integrations.github.auth import GitHubAuth

    tok = await get_installation_token(int(installation_id))
    github = GitHubClient(auth=GitHubAuth(token=tok))
```

Do not touch anything else in the route; the later `get_tree(owner, repo, default_branch, tok)` call stays (redundant-but-harmless token override with the identical credential).

- [ ] **Step 4: Run test to verify GREEN**

Run: `.venv/bin/python -m pytest tests/api/test_onboarding_routes.py::TestDiscoverDocumentationAuth -v`
Expected: PASS.

- [ ] **Step 5: Full suite + lint**

Run: `.venv/bin/python -m pytest tests/api/ -q` then `.venv/bin/python -m ruff check src/draftly/app/api/routes/onboarding.py tests/api/test_onboarding_routes.py`
Expected: only the 3 known pre-existing failures remain; ruff clean.

## Self-Review Checklist (completed at authoring time)

1. **Spec coverage:** root cause (missing canonical writes at connect) → Task 1; recurrence risk across fresh workspaces → Tasks 1+2; webhook + link routes deliberately untouched per Global Constraints. ✔
2. **Placeholder scan:** no TBDs; every code step carries verbatim content. ✔
3. **Type consistency:** signatures match `persistence/repositories/github.py:70` (`store_github_installation(*, org_id, installation_id, github_org, ...)`) and `persistence/repositories/organizations.py:14` (`update_org_github(*, org_id, github_org, ...)`) exactly; response contract unchanged; test path uses router prefix `/onboarding` verified at `routes/onboarding.py:13`. ✔
