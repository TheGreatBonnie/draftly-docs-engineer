# GitHub Setup-Redirect Return-To Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the GitHub App setup-redirect handshake so that installing the Draftly GitHub App from onboarding returns the user to `/onboarding/github?installation_id=N` (and installs started elsewhere land on `/integrations/github`), with both sides committed to git and covered by tests.

**Architecture:** `GET /api/github/install-url` plants a short-lived, allowlisted `gh_install_return_to` cookie when the caller passes a `return_to` path. After install, GitHub redirects the browser to the App's registered Setup URL (`GET /api/github/setup-callback`), which reads that cookie to decide where to 307 the user, forwards `installation_id`, and consumes the cookie. The frontend sends `return_to=/onboarding/github`, then links immediately when the redirect delivers `?installation_id=` — no polling wait.

**Tech Stack:** FastAPI + Starlette responses/cookies (backend, pytest + TestClient); Next.js client components (frontend, vitest + testing-library).

**Spec:** Analysis in this session established the contract; official behavior is defined by GitHub docs cited in "Official GitHub Documentation Basis" below. Root cause evidence: every committed version of `setup-callback` hardcodes `/integrations/github`; a prior uncommitted implementation of this exact feature was lost before commit (`git log --all -S RETURN_TO_COOKIE` empty in both repos).

## Official GitHub Documentation Basis

Every mechanism in this plan maps to documented GitHub Apps behavior:

| Mechanism | Official doc | Documented behavior |
|---|---|---|
| Install request URL | [Installing a GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party) | "The URL will look something like `https://github.com/apps/APP-NAME/installations/new`" — exactly what `/install-url` returns |
| Post-install redirect | [About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url) | "When users install your GitHub App, they are redirected to the setup URL" and it "includes an `installation_id` query parameter" |
| Spoofed installation_id warning | Same page, WARNING block | "Bad actors can hit this URL with a spoofed `installation_id`. Therefore, you should not rely on the validity of the `installation_id` parameter." |
| Our mitigation | Same page + [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) | Server validates the id against the JWT-authed `GET /app/installations/{id}` before persisting anything (spoofed ids fail lookup); conflict check prevents cross-org claiming. Known limitation (out of scope): full user↔installation verification per docs would use OAuth user tokens via "Request user authorization (OAuth) during installation". |
| Installation lifecycle webhooks | Webhook events for GitHub Apps | `installation.created` / `installation.deleted` handled at `POST /api/github/webhook` with required HMAC-SHA256 `X-Hub-Signature-256` validation (already implemented, unchanged). |

**Known deviation (documented, not fixed here):** GitHub's recommended defense against spoofed setup-redirect ids is verifying the installing *user* owns the installation via a user access token. This plan keeps the existing server-side validation (id must resolve via App JWT API + org-conflict check) and records the OAuth flow as follow-up work.

## Global Constraints

- Cookie name: `gh_install_return_to` (exact).
- Allowlist: `frozenset({"/onboarding/github", "/integrations/github"})` — any other value → HTTP 400 from install-url; unknown cookie value → fallback target.
- Cookie flags: `max_age=600, httponly=True, samesite="lax", path="/api"` (exact).
- Fallback redirect target when cookie missing/invalid: `/integrations/github` (exact).
- Setup URL registered on the GitHub App: `https://grit-flagstone-recreate.ngrok-free.dev/api/github/setup-callback` (user-provided).
- **Topology constraint (hard requirement):** the ngrok tunnel MUST forward to the Next.js dev server (`http://localhost:3000`), NOT directly to FastAPI (`localhost:8000`). The cookie is planted on whatever origin serves the app pages; GitHub's top-level redirect lands on the tunnel origin. Single origin = cookie present. If the tunnel targets :8000 while pages are served from another origin, the handshake cannot work regardless of code.
- During install testing, browse the app through the tunnel origin (`https://grit-flagstone-recreate.ngrok-free.dev/onboarding/workspace`), not `http://localhost:3000`.
- Backend env must set `FRONTEND_URL=https://grit-flagstone-recreate.ngrok-free.dev` so setup-callback redirects land on the same origin as the planted cookie.
- Two separate git repos: backend commits run in `draftly-agent-backend/`, frontend commits in `draftly-agent-frontend/`.
- No new dependencies. No Next.js-specific APIs beyond what these files already import (per frontend AGENTS.md, verify against `node_modules/next/dist/docs/` if unsure).
- **Polling is retained by design (do not remove).** Linking is layered: (1) setup-redirect handoff links immediately when `?installation_id=` arrives; (2) the GitHub tab GitHub redirects also carries the cookie, so it lands back on `/onboarding/github` with the id too; (3) the 5s poll remains the fallback that observes installations persisted by the signed `installation.created` webhook when the cookie was lost/expired (>600s), the origin mismatched, or the redirected tab closed early; (4) manual "Retry connection" covers webhook+cookie both failing. Removing polling strands users on "Waiting for installation…" after any single cookie failure. Existing test "keeps polling while no installation exists" pins this behavior.

---

### Task 1: Backend — plant allowlisted return-to cookie on GET /github/install-url

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py:36-40` (route) and imports at `github.py:4`
- Create: `draftly-agent-backend/tests/api/test_github_routes.py`

**Interfaces:**
- Consumes: existing `get_verified_token` dependency, module-level `settings = get_settings()` (line 25), `settings.github_app_slug`.
- Produces: constants `RETURN_TO_COOKIE = "gh_install_return_to"` and `ALLOWED_RETURN_TO = frozenset({"/onboarding/github", "/integrations/github"})`; route signature `github_install_url(response: Response, return_to: str | None, token: dict) -> dict[str, str]`. Task 2 consumes `RETURN_TO_COOKIE`/`ALLOWED_RETURN_TO`.

- [ ] **Step 1: Write the failing test**

Create `draftly-agent-backend/tests/api/test_github_routes.py`:

```python
"""Tests for GitHub App setup-redirect routing (return-to cookie handshake)."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from draftly.app.api.routes import github


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(github.router)
    from draftly.app.api.auth import get_verified_token

    app.dependency_overrides[get_verified_token] = lambda: {
        "sub": "tester",
        "org_id": "test-org",
    }
    return TestClient(app)


@pytest.fixture()
def pinned_settings(monkeypatch):
    """Pin Settings attributes on the shared singleton the routes read."""
    from draftly.app.config import get_settings

    monkeypatch.setattr(get_settings(), "github_app_slug", "draftly")
    monkeypatch.setattr(get_settings(), "frontend_url", "http://testfrontend")


class TestInstallUrl:
    def test_returns_documented_request_page_url(self, client, pinned_settings):
        res = client.get("/github/install-url")
        assert res.status_code == 200
        assert res.json()["install_url"] == (
            "https://github.com/apps/draftly/installations/new"
        )

    def test_valid_return_to_plants_cookie(self, client, pinned_settings):
        res = client.get("/github/install-url?return_to=/onboarding/github")
        assert res.status_code == 200
        cookie = res.headers["set-cookie"]
        assert "gh_install_return_to=/onboarding/github" in cookie
        assert "HttpOnly" in cookie
        assert "SameSite=lax" in cookie
        assert "Path=/api" in cookie
        assert "Max-Age=600" in cookie

    def test_no_return_to_means_no_cookie(self, client, pinned_settings):
        res = client.get("/github/install-url")
        assert res.status_code == 200
        assert "set-cookie" not in res.headers

    def test_off_allowlist_return_to_rejected(self, client, pinned_settings):
        res = client.get("/github/install-url?return_to=https://evil.example")
        assert res.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `draftly-agent-backend/`): `python -m pytest tests/api/test_github_routes.py -v`
Expected: FAIL — `test_valid_return_to_plants_cookie` and `test_off_allowlist_return_to_rejected` fail (no `return_to` handling); `test_returns_documented_request_page_url` may pass only if `GITHUB_APP_SLUG=draftly` is already set, otherwise it fails on slug missing — either way proceed.

- [ ] **Step 3: Write minimal implementation**

In `draftly-agent-backend/src/draftly/app/api/routes/github.py`:

Add `Response` to the fastapi import on line 4:

```python
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
```

Replace lines 36-40 with:

```python
RETURN_TO_COOKIE = "gh_install_return_to"
ALLOWED_RETURN_TO = frozenset({"/onboarding/github", "/integrations/github"})


@router.get("/install-url")
async def github_install_url(
    response: Response,
    return_to: str | None = None,
    token: dict = Depends(get_verified_token),
) -> dict[str, str]:
    if not settings.github_app_slug:
        raise HTTPException(status_code=500, detail="GitHub App slug not configured")
    if return_to is not None:
        if return_to not in ALLOWED_RETURN_TO:
            raise HTTPException(status_code=400, detail="Invalid return_to path")
        response.set_cookie(
            RETURN_TO_COOKIE,
            return_to,
            max_age=600,
            httponly=True,
            samesite="lax",
            path="/api",
        )
    return {"install_url": f"https://github.com/apps/{settings.github_app_slug}/installations/new"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/api/test_github_routes.py -v`
Expected: all `TestInstallUrl` tests PASS

- [ ] **Step 5: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/github.py tests/api/test_github_routes.py
git commit -m "feat: plant allowlisted gh_install_return_to cookie on install-url"
```

---

### Task 2: Backend — setup-callback honors cookie, falls back, consumes it

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py:148-157`
- Modify: `draftly-agent-backend/tests/api/test_github_routes.py`

**Interfaces:**
- Consumes: `RETURN_TO_COOKIE`, `ALLOWED_RETURN_TO` (Task 1), `settings.frontend_url`, Starlette `Request.cookies` / `RedirectResponse.delete_cookie`.
- Produces: `github_setup_callback(request: Request, installation_id: int | None, setup_action: str | None) -> RedirectResponse` — redirects to `{frontend_url}{return_to}` (+ `?installation_id=N` when present). Frontend Tasks 4-5 consume `?installation_id=` on the redirected page.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_github_routes.py`:

```python
class TestSetupCallback:
    COOKIE = {"cookies": {"gh_install_return_to": "/onboarding/github"}}

    def test_cookie_routes_back_to_onboarding_with_installation_id(
        self, client, pinned_settings
    ):
        res = client.get(
            "/github/setup-callback?installation_id=42&setup_action=install",
            follow_redirects=False,
            **self.COOKIE,
        )
        assert res.status_code == 307
        location = res.headers["location"]
        assert location == (
            "http://testfrontend/onboarding/github?installation_id=42"
        )
        # Cookie consumed after use (Starlette sets empty value + Max-Age=0).
        set_cookie = res.headers.get("set-cookie", "")
        assert "gh_install_return_to=" in set_cookie
        assert "Max-Age=0" in set_cookie

    def test_missing_cookie_falls_back_to_integrations(self, client, pinned_settings):
        res = client.get(
            "/github/setup-callback?installation_id=42",
            follow_redirects=False,
        )
        assert res.status_code == 307
        assert res.headers["location"] == (
            "http://testfrontend/integrations/github?installation_id=42"
        )

    def test_unknown_cookie_value_falls_back(self, client, pinned_settings):
        res = client.get(
            "/github/setup-callback",
            cookies={"gh_install_return_to": "/somewhere/else"},
            follow_redirects=False,
        )
        assert res.status_code == 307
        assert res.headers["location"] == "http://testfrontend/integrations/github"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/api/test_github_routes.py::TestSetupCallback -v`
Expected: FAIL — current handler hardcodes `/integrations/github` and ignores cookies.

- [ ] **Step 3: Write minimal implementation**

Replace `github_setup_callback` (currently `github.py:148-157`) with:

```python
@router.get("/setup-callback")
async def github_setup_callback(
    request: Request,
    installation_id: int | None = None,
    setup_action: str | None = None,
) -> RedirectResponse:
    """GitHub App post-install redirect (official setup URL contract).

    GitHub redirects here after installation with ?installation_id= (and
    setup_action=install). Per GitHub docs this parameter is spoofable, so
    nothing is persisted from it here — the authenticated link happens later
    via POST /onboarding/github/connect, which validates the installation
    through the App-JWT-authed GitHub API before storing it. This endpoint
    only routes the browser back to where the install was initiated.
    """
    settings = get_settings()
    return_to = request.cookies.get(RETURN_TO_COOKIE)
    if return_to not in ALLOWED_RETURN_TO:
        return_to = "/integrations/github"
    frontend_url = f"{settings.frontend_url}{return_to}"
    if installation_id:
        frontend_url += f"?installation_id={installation_id}"
    response = RedirectResponse(url=frontend_url)
    response.delete_cookie(RETURN_TO_COOKIE, path="/api")
    return response
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/api/test_github_routes.py -v`
Expected: ALL tests PASS (Tasks 1 + 2)

- [ ] **Step 5: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/github.py tests/api/test_github_routes.py
git commit -m "feat: setup-callback honors return-to cookie with integrations fallback"
```

---

### Task 3: Backend — org-scope GET /github/installations

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py:54-58`
- Modify: `draftly-agent-backend/tests/api/test_github_routes.py`

**Interfaces:**
- Consumes: `request.app.state.draftly.dependencies.repositories.github_installations.list_by_org(org_id)` — exists today (`GitHubInstallationsRepository.list_by_org`, wired in `src/draftly/app/dependencies.py:273,316`). Pattern mirrors `routes/onboarding.py:_repos`.
- Produces: `GET /github/installations -> list[dict]` scoped to the caller's Clerk org. Fixes the current global leak (`list_github_installations()` returns every row) which also makes the frontend's poll/link path ambiguous (`installs[0]`).

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_github_routes.py`:

```python
class TestInstallations:
    def test_lists_only_caller_org_installations(self, monkeypatch):
        from unittest.mock import AsyncMock, MagicMock

        app = FastAPI()
        app.include_router(github.router)
        from draftly.app.api.auth import get_verified_token

        app.dependency_overrides[get_verified_token] = lambda: {
            "sub": "tester",
            "org_id": "org_2abc",
        }
        state = MagicMock()
        repos = state.dependencies.repositories
        repos.github_installations.list_by_org = AsyncMock(
            return_value=[{"installation_id": 42, "github_org": "acme"}]
        )
        app.state.draftly = state
        client = TestClient(app)

        res = client.get("/github/installations")

        assert res.status_code == 200
        assert res.json() == [{"installation_id": 42, "github_org": "acme"}]
        repos.github_installations.list_by_org.assert_awaited_once_with("org_2abc")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/api/test_github_routes.py::TestInstallations -v`
Expected: FAIL — current handler calls global `list_github_installations()` and ignores org.

- [ ] **Step 3: Write minimal implementation**

Replace `github_installations` (currently `github.py:54-58`) with:

```python
@router.get("/installations")
async def github_installations(request: Request, token: dict = Depends(get_verified_token)) -> list[dict]:
    repos = request.app.state.draftly.dependencies.repositories
    return await repos.github_installations.list_by_org(token.get("org_id") or "")
```

(`Request` is already imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/api/test_github_routes.py -v`
Expected: ALL tests PASS (Tasks 1-3)

- [ ] **Step 5: Run the wider suite to catch regressions**

Run: `python -m pytest tests/api -v`
Expected: PASS — no other route tests depend on the global listing.

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-backend
git add src/draftly/app/api/routes/github.py tests/api/test_github_routes.py
git commit -m "fix: scope installations listing to caller's organization"
```

---

### Task 4: Frontend — getInstallUrl accepts returnTo; component requests /onboarding/github

**Files:**
- Modify: `draftly-agent-frontend/api/github.ts:7-10`
- Modify: `draftly-agent-frontend/components/onboarding/github-connect.tsx:29-32`
- Modify: `draftly-agent-frontend/tests/components/github-connect.test.tsx`

**Interfaces:**
- Consumes: backend `GET /github/install-url?return_to=…` (Task 1).
- Produces: `getInstallUrl(returnTo?: string): Promise<GitHubInstallUrl>` — Task 5's page-level flow relies on the component calling it with `"/onboarding/github"` so the backend plants the cookie.

- [ ] **Step 1: Write the failing test**

In `tests/components/github-connect.test.tsx`, add inside `describe("GitHubConnect", …)`:

```tsx
  it("requests the install URL with return_to=/onboarding/github", async () => {
    vi.mocked(listInstallations).mockResolvedValue([installation(42)]);
    render(<GitHubConnect />);

    await waitFor(() =>
      expect(vi.mocked(getInstallUrl)).toHaveBeenCalledWith("/onboarding/github")
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `draftly-agent-frontend/`): `pnpm vitest run tests/components/github-connect.test.tsx`
Expected: FAIL — component calls `getInstallUrl()` with no argument.

- [ ] **Step 3: Write minimal implementation**

`api/github.ts` — replace `getInstallUrl` (lines 7-10):

```ts
/** Fetch the GitHub App install URL. When returnTo is provided, the backend
 *  plants a short-lived cookie so /setup-callback redirects back to that route
 *  after the install completes on github.com. */
export async function getInstallUrl(returnTo?: string): Promise<GitHubInstallUrl> {
  const qs = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
  return request<GitHubInstallUrl>(`/github/install-url${qs}`);
}
```

`components/onboarding/github-connect.tsx` — change line 30 inside `attempt`:

```ts
      getInstallUrl("/onboarding/github").catch(() => null),
```

(The integrations page `app/(app)/integrations/github/page.tsx:21` calls `getInstallUrl()` bare — unchanged by design: its fallback default is correct there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/github-connect.test.tsx`
Expected: ALL tests PASS (3 existing + new one)

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-frontend
git add api/github.ts components/onboarding/github-connect.tsx tests/components/github-connect.test.tsx
git commit -m "feat: send return_to=/onboarding/github when fetching install URL"
```

---

### Task 5: Frontend — consume ?installation_id= from setup redirect and link immediately

**Files:**
- Modify: `draftly-agent-frontend/components/onboarding/github-connect.tsx` (props + attempt logic)
- Modify: `draftly-agent-frontend/app/(onboarding)/onboarding/github/page.tsx:18-22,68`
- Modify: `draftly-agent-frontend/tests/components/github-connect.test.tsx`

**Interfaces:**
- Consumes: `connectGitHub({ installation_id })` from `@/api/onboarding` (exists); backend setup-callback redirect format `{frontend}/onboarding/github?installation_id=N` (Task 2).
- Produces: `<GitHubConnect installationId={number | null} onConnectedChange={(b: boolean) => void} pollIntervalMs?=number />` — public component contract used by the github onboarding page.

- [ ] **Step 1: Write the failing tests**

Add to `tests/components/github-connect.test.tsx` inside the describe block:

```tsx
  it("links the setup-redirect installation immediately without polling", async () => {
    const onConnectedChange = vi.fn();
    render(<GitHubConnect installationId={42} onConnectedChange={onConnectedChange} />);

    await waitFor(() => expect(onConnectedChange).toHaveBeenCalledWith(true));
    expect(vi.mocked(connectGitHub)).toHaveBeenCalledWith({ installation_id: 42 });
    // No polling wait: listInstallations never needed.
    expect(vi.mocked(listInstallations)).not.toHaveBeenCalled();
  });

  it("does not re-link a stale prop id on later renders", async () => {
    const { rerender } = render(<GitHubConnect installationId={42} />);
    await waitFor(() => expect(connectGitHub).toHaveBeenCalledTimes(1));

    rerender(<GitHubConnect installationId={null} />);
    expect(connectGitHub).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/github-connect.test.tsx`
Expected: FAIL — `GitHubConnect` has no `installationId` prop (TS error at compile of test / runtime never calls connectGitHub with 42).

- [ ] **Step 3: Write minimal implementation**

`components/onboarding/github-connect.tsx`:

Props (replace lines 13-19):

```tsx
export function GitHubConnect({
  onConnectedChange,
  pollIntervalMs = POLL_INTERVAL_MS,
  /** Installation id captured from ?installation_id= (setup redirect) —
   *  connects immediately instead of waiting for the poll to observe it. */
  installationId,
}: {
  onConnectedChange?: (connected: boolean) => void;
  pollIntervalMs?: number;
  installationId?: number | null;
}) {
```

Refs (after line 25):

```tsx
  const pendingInstallRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (installationId != null) pendingInstallRef.current = installationId;
  }, [installationId]);
```

Extract linking into its own callback (insert before `attempt`):

```tsx
  const linkInstallation = useCallback(
    async (id: number): Promise<void> => {
      setPhase("connecting");
      try {
        await connectGitHub({ installation_id: id });
        if (!cancelledRef.current) {
          setPhase("linked");
          onConnectedChange?.(true);
        }
      } catch (e) {
        if (!cancelledRef.current) {
          setPhase("error");
          setErrorMsg(
            e instanceof ApiError
              ? e.message
              : "Failed to connect your GitHub installation."
          );
        }
      }
    },
    [onConnectedChange]
  );
```

Inside `attempt`, after `setInstallUrl(...)` (line 34), insert the handoff branch; replace the inline connect block (current lines 45-61) with a call to `linkInstallation`:

```tsx
    // Setup-redirect handoff: link right away, no polling wait.
    const pendingId = pendingInstallRef.current;
    if (pendingId != null) {
      pendingInstallRef.current = null;
      await linkInstallation(pendingId);
      return;
    }

    if (installs.length === 0) {
      setPhase("awaiting-install");
      timerRef.current = setTimeout(() => void attemptRef.current(), pollIntervalMs);
      return;
    }

    await linkInstallation(installs[0].installation_id);
  }, [linkInstallation, pollIntervalMs]);
```

Keep the comment above the `setTimeout` self-scheduling line (lines 38-40) — still applies.

`app/(onboarding)/onboarding/github/page.tsx` — restore handoff consumption. Replace imports line 3 and the component head (lines 18-21), and update the JSX usage (line 68):

```tsx
import { useEffect, useState } from "react";
```

```tsx
export default function GitHubPage() {
  useStepGuard("github");
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [installationId, setInstallationId] = useState<number | null>(null);

  // Setup-redirect handoff: /setup-callback lands here with
  // ?installation_id= — consume it once and clean the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("installation_id");
    if (!raw) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) setInstallationId(parsed);
    window.history.replaceState({}, "", "/onboarding/github");
  }, []);
```

```tsx
          <GitHubConnect
            installationId={installationId}
            onConnectedChange={setConnected}
          />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/components/github-connect.test.tsx`
Expected: ALL PASS (existing 3 + Task 4's + 2 new)

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: clean

- [ ] **Step 6: Commit**

```bash
cd draftly-agent-frontend
git add components/onboarding/github-connect.tsx "app/(onboarding)/onboarding/github/page.tsx" tests/components/github-connect.test.tsx
git commit -m "feat: link installation immediately from setup-redirect handoff"
```

---

### Task 6: Wiring & end-to-end verification (ngrok topology)

**Files:**
- Modify: `draftly-agent-backend/.env` (local only — do not commit secrets; `.env.example` gets the new key documented)
- Modify: `draftly-agent-backend/.env.example` (add `FRONTEND_URL` entry)
- No code changes.

**Interfaces:**
- Consumes: Tasks 1-5 merged locally; running stack: uvicorn :8000, `next dev` :3000, ngrok tunnel `grit-flagstone-recreate.ngrok-free.dev`.

- [ ] **Step 1: Configure topology**

1. Restart ngrok pointed at the frontend dev server: `ngrok http 3000` (verify it serves `https://grit-flagstone-recreate.ngrok-free.dev/` — if the hostname differs, use the actual one everywhere below and in the GitHub App settings).
2. In `draftly-agent-backend/.env` set:
   ```
   FRONTEND_URL=https://grit-flagstone-recreate.ngrok-free.dev
   ```
   Restart uvicorn afterwards (settings load at startup).
3. In `draftly-agent-backend/.env.example`, add under Database section:
   ```
   # Public origin of the frontend; setup-callback redirects land here.
   FRONTEND_URL=http://localhost:3000
   ```

- [ ] **Step 2: Verify GitHub App registration matches official contract**

At GitHub → Settings → Developer settings → GitHub Apps → Draftly:
- Setup URL = `https://grit-flagstone-recreate.ngrok-free.dev/api/github/setup-callback` (user-provided value).
- Webhook URL points at the tunnel's `/api/github/webhook` with the configured secret (existing `verify_webhook_signature` expects HMAC-SHA256 per GitHub's webhook docs).

- [ ] **Step 3: Curl-probe the live handshake (cookie honored end-to-end)**

```bash
# Through the SAME origin the cookie will be planted on:
curl -si 'https://grit-flagstone-recreate.ngrok-free.dev/api/github/setup-callback?installation_id=42' \
  -H 'Cookie: gh_install_return_to=/onboarding/github' | grep -i '^location'
```
Expected: `location: https://grit-flagstone-recreate.ngrok-free.dev/onboarding/github?installation_id=42`

Without the cookie:
```bash
curl -si 'https://grit-flagstone-recreate.ngrok-free.dev/api/github/setup-callback?installation_id=42' | grep -i '^location'
```
Expected: `... /integrations/github?installation_id=42`

Note: ngrok free tier shows a one-time interstitial page on first browser visit per session ("You are about to visit"); click through once — subsequent top-level redirects go straight through.

- [ ] **Step 4: Browser walkthrough (happy path)**

1. Browse the app via the tunnel: sign in, start onboarding, create workspace, reach `/onboarding/github`.
2. Click "Install GitHub App"; complete install on github.com for your org.
3. Expected: GitHub redirects through the registered Setup URL back to `/onboarding/github?installation_id=N`, the address bar is cleaned, "Connecting…" → "GitHub Connected" appears within ~1s (no 5s poll wait).
4. Continue wizard: repository → documentation sources → initialize → complete lands on dashboard.
5. Regression check: from `/integrations/github` (signed in, onboarding complete), "Install GitHub App" flow should land back on `/integrations/github` connected state (fallback path exercises when no onboarding tab planted the cookie — expected per design).

If step 3 instead lands on `/integrations/github`: the cookie didn't survive — confirm you browsed via the tunnel origin (not localhost:3000) and that ngrok forwards to port 3000 (Global Constraint).

- [ ] **Step 5: Keep everything committed**

Both repos must show clean `git status` after Tasks 1-5. This feature previously died as uncommitted work; do not leave any task uncommitted.

---

## Self-Review Notes

- Spec coverage: cookie plant (T1), honor+fallback+consume (T2), org scoping regression fix (T3), return_to param (T4), immediate-link handoff (T5), real-world topology given user's ngrok Setup URL (T6). Official-docs table maps each mechanism; spoofing mitigation documented as known limitation with OAuth follow-up.
- Placeholders: none — every code step contains full code.
- Type consistency: `getInstallUrl(returnTo?: string)` matches component call `getInstallUrl("/onboarding/github")`; `GitHubConnect installationId?: number | null` matches page state `useState<number | null>(null)`; backend constants match between T1 producer and T2 consumer.
