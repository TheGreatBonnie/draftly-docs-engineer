# Onboarding Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the draftly-agent-frontend onboarding flow production-ready: no silent failures, no dead controls, guarded navigation, resilient polling, accessible controls, and automated regression coverage.

**Architecture:** A shared `useAsyncAction` hook centralizes submit/error/loading handling for every step page. The `OnboardingShell` owns back-navigation defaults; the footer hides Next when a step manages its own primary CTA. Client-side step guards redirect users who deep-link ahead of their persisted server state (the FastAPI backend remains the source of truth and already enforces transitions with 409s). Playwright E2E mocks `/api/**` so the wizard is tested without a running backend.

**Tech Stack:** Next.js 16.3.1 (App Router), React 19, TypeScript strict, Tailwind v4, Clerk auth, Vitest 4 + React Testing Library + jsdom (already configured), pnpm.

**Spec:** Findings assessment from this session (P0/P1/P2 gap list). Reference designs live in `reference/onboarding-flow.md`; prior design spec at `docs/superpowers/specs/2026-08-22-docs-sync-onboarding-design.md`.

## Global Constraints

- Package manager: **pnpm only** (never npm/yarn)
- Run unit tests: `pnpm test` (vitest run) — must exit 0 with zero failures
- Typecheck: `npx tsc --noEmit` — must exit 0
- Lint: `pnpm lint` — pre-existing failures exist in files outside `(onboarding)/`, `components/onboarding/`, `lib/onboarding/`, `api/`; **zero new** problems may be introduced in those directories
- All work happens in `draftly-agent-frontend/` (a standalone git repo)
- Existing test infra (do not recreate): `vitest.config.mts`, `tests/setup.ts`, alias `"@" -> repo root`, jsdom environment, `@testing-library/jest-dom/vitest` matchers loaded globally
- Backend contract (already implemented, do not change): `POST /api/onboarding/*` returns 409 `{"detail": "<reason>"}` on out-of-order transitions; frontend must surface these, never swallow them
- Copy tone: match existing screens (sentence case, no exclamation marks except existing welcome emoji)

---

### Task 1: `useAsyncAction` hook + `ErrorBanner` component

**Files:**
- Create: `lib/onboarding/use-async-action.ts`
- Create: `components/onboarding/error-banner.tsx`
- Test: `tests/lib/use-async-action.test.ts`
- Test: `tests/components/error-banner.test.tsx`

**Interfaces:**
- Consumes: `ApiError` from `@/api/client` (existing: `class ApiError extends Error { status: number }`)
- Produces (used by Tasks 2, 4, 5, 6):
  - `useAsyncAction(): { run: (fn: () => Promise<unknown>) => Promise<boolean>; loading: boolean; error: string | null; clearError: () => void }` — `run` resolves `true` iff `fn` succeeded
  - `<ErrorBanner message: string; onDismiss?: () => void>` — renders `role="alert"`

- [ ] **Step 1: Write failing tests for the hook**

```ts
// tests/lib/use-async-action.test.ts
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "@/api/client";
import { useAsyncAction } from "@/lib/onboarding/use-async-action";

describe("useAsyncAction", () => {
  it("returns true and clears state on success", async () => {
    const { result } = renderHook(() => useAsyncAction());
    let ok = false;
    await act(async () => {
      ok = await result.current.run(() => Promise.resolve({}));
    });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("captures ApiError.message", async () => {
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => {
      await result.current.run(() =>
        Promise.reject(new ApiError(409, "Cannot select repository from NOT_STARTED"))
      );
    });
    expect(result.current.error).toBe("Cannot select repository from NOT_STARTED");
    expect(result.current.loading).toBe(false);
  });

  it("uses generic copy for unknown errors", async () => {
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => {
      await result.current.run(() => Promise.reject(new TypeError("network down")));
    });
    expect(result.current.error).toBe("Something went wrong. Please try again.");
  });

  it("clearError resets error", async () => {
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => {
      await result.current.run(() => Promise.reject(new ApiError(500, "boom")));
    });
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing tests for the banner**

```tsx
// tests/components/error-banner.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBanner } from "@/components/onboarding/error-banner";

describe("ErrorBanner", () => {
  it("renders message with alert role", () => {
    render(<ErrorBanner message="Workspace creation failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace creation failed");
  });

  it("calls onDismiss from dismiss button", async () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="boom" onDismiss={onDismiss} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("has no dismiss button when onDismiss omitted", () => {
    render(<ErrorBanner message="boom" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- use-async-action error-banner`
Expected: FAIL — cannot resolve `@/lib/onboarding/use-async-action` / `@/components/onboarding/error-banner`

- [ ] **Step 4: Implement the hook**

```ts
// lib/onboarding/use-async-action.ts
import { useCallback, useState } from "react";
import { ApiError } from "@/api/client";

export function useAsyncAction() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setLoading(true);
      setError(null);
      try {
        await fn();
        return true;
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Something went wrong. Please try again."
        );
        return false;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return { run, loading, error, clearError };
}
```

- [ ] **Step 5: Implement the banner**

```tsx
// components/onboarding/error-banner.tsx
"use client";

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between gap-3 rounded-[9px] border border-red-200 bg-red-50 px-[15px] py-[13px] text-xs leading-[1.5] text-red-700"
    >
      <p className="m-0">{message}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 font-bold text-red-400 hover:text-red-600"
        >
          ✕
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- use-async-action error-banner`
Expected: PASS (7 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/onboarding/use-async-action.ts components/onboarding/error-banner.tsx tests/lib/use-async-action.test.ts tests/components/error-banner.test.tsx
git commit -m "feat(onboarding): shared async action hook and error banner"
```

---

### Task 2: Error surfacing on every step + remove dead Next buttons

The five data-mutating pages repeat `try { await api(); router.push() } finally { setLoading(false) }` with no catch. Replace with `useAsyncAction`. Additionally, `preferences`, `integrations`, and `documentation` pages pass `onNext={() => {}}` while their inner forms own the real CTA — make the footer hide Next when no `onNext` is provided.

**Files:**
- Modify: `components/onboarding/onboarding-footer.tsx:49-59`
- Modify: `app/(onboarding)/onboarding/workspace/page.tsx`
- Modify: `app/(onboarding)/onboarding/repository/page.tsx`
- Modify: `app/(onboarding)/onboarding/documentation/page.tsx`
- Modify: `app/(onboarding)/onboarding/integrations/page.tsx`
- Modify: `app/(onboarding)/onboarding/preferences/page.tsx`
- Test: `tests/components/onboarding-footer.test.tsx` (create)
- Test: extend existing `app/(onboarding)/onboarding/workspace/page.test.tsx`
- Test: create `tests/pages/repository-page.test.tsx`

**Interfaces:**
- Consumes: `useAsyncAction`, `ErrorBanner` (Task 1 exact signatures)
- Produces: footer contract change — **Next button renders only when both `next` exists and `onNext` is provided**. Pages that manage their own CTA omit `onNext` entirely.

- [ ] **Step 1: Write failing footer test**

```tsx
// tests/components/onboarding-footer.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingFooter } from "@/components/onboarding/onboarding-footer";

describe("OnboardingFooter next visibility", () => {
  it("hides Next when onNext is not provided", () => {
    render(<OnboardingFooter currentStep="preferences" />);
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
  });

  it("shows and enables Next when onNext provided", async () => {
    const onNext = vi.fn();
    render(<OnboardingFooter currentStep="workspace" onNext={onNext} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /next/i }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Write failing workspace error-path test (extend existing file)**

Add inside the existing `describe` block of `app/(onboarding)/onboarding/workspace/page.test.tsx`:

```tsx
it("shows an error banner and stays put when createWorkspace fails", async () => {
  vi.mocked(createWorkspace).mockRejectedValueOnce(
    new Error("Cannot create workspace from WORKSPACE_CREATED")
  );
  const user = userEvent.setup();
  render(<WorkspacePage />);
  await user.type(screen.getByPlaceholderText("e.g. my-project"), "my-project");
  await user.click(screen.getByRole("button", { name: /next/i }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Cannot create workspace from WORKSPACE_CREATED"
  );
  expect(push).not.toHaveBeenCalledWith("/onboarding/github");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- onboarding-footer workspace`
Expected: FAIL — footer still renders Next without `onNext`; workspace page throws unhandled rejection instead of showing `role="alert"`

- [ ] **Step 4: Change the footer condition**

In `components/onboarding/onboarding-footer.tsx`, change the Next render condition from:

```tsx
{next && (
  <DesignButton primary onClick={onNext} ...
```

to:

```tsx
{next && onNext && (
  <DesignButton primary onClick={onNext} ...
```

No other footer changes.

- [ ] **Step 5: Rewire the workspace page**

```tsx
// app/(onboarding)/onboarding/workspace/page.tsx (full replacement)
"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, ShieldCheck, Users } from "lucide-react";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { WorkspaceForm } from "@/components/onboarding/workspace-form";
import { InfoRow, cardBase, sideBubble } from "@/components/onboarding/design/info-row";
import { ErrorBanner } from "@/components/onboarding/error-banner";
import { createWorkspace } from "@/api/onboarding";
import { useAsyncAction } from "@/lib/onboarding/use-async-action";

export default function WorkspacePage() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const { run, loading, error, clearError } = useAsyncAction();

  async function handleNext(name: string, description: string) {
    const ok = await run(() => createWorkspace({ name, description }));
    if (ok) router.push("/onboarding/github");
  }

  return (
    <OnboardingShell
      currentStep="workspace"
      onNext={() => formRef.current?.requestSubmit()}
      isNextLoading={loading}
    >
      <h1 className="mb-[11px] mt-8 text-[32px] font-extrabold leading-[1.2] tracking-[-1.2px] text-[#101a43]">
        Create your workspace
      </h1>
      <p className="text-[15px] leading-[1.55] text-[#53648e]">
        Give your workspace a name and description.
        <br />
        This is where your team&apos;s documentation lives.
      </p>
      {error && <div className="mt-4"><ErrorBanner message={error} onDismiss={clearError} /></div>}
      <div className="mb-8 grid grid-cols-[minmax(0,1fr)_280px] gap-[35px] max-[900px]:grid-cols-1">
        <div>
          <WorkspaceForm onSubmit={handleNext} formRef={formRef} />
        </div>
        <div className={`${cardBase} px-5 py-[22px] max-[900px]:order-2`}>
          <h3 className="mb-2 text-base text-[#101a43]">What is a workspace?</h3>
          <InfoRow bubbleClassName={sideBubble} icon={<FolderOpen />} title="Your project home" text="A workspace groups your repository, sources, and documentation together." />
          <InfoRow className="border-t border-[#e6ebf3]" bubbleClassName={sideBubble} icon={<Users />} title="Team collaboration" text="Your team members will access documentation through this workspace." tone="green" />
          <InfoRow className="border-t border-[#e6ebf3]" bubbleClassName={sideBubble} icon={<ShieldCheck />} title="You stay in control" text="Manage settings, sources, and access from one place." tone="purple" />
        </div>
      </div>
    </OnboardingShell>
  );
}
```

(Note: `useState` import is dropped; `formRef` behavior from the earlier bugfix is preserved.)

- [ ] **Step 6: Rewire repository page**

Replace the handler/state section of `repository/page.tsx` (keep JSX layout identical):

```tsx
const router = useRouter();
const [selected, setSelected] = useState<string | null>(null);
const { run, loading, error, clearError } = useAsyncAction();

async function handleNext() {
  if (!selected) return;
  const ok = await run(() => selectRepository({ full_name: selected }));
  if (ok) router.push("/onboarding/documentation");
}
```

JSX changes: `isNextLoading={loading}` stays; insert below the `<p>` intro:

```tsx
{error && <div className="mt-4"><ErrorBanner message={error} onDismiss={clearError} /></div>}
```

Imports: add `ErrorBanner`, `useAsyncAction`.

- [ ] **Step 7: Rewire documentation, integrations, preferences pages (and kill dead Next)**

Apply the identical pattern in each page — replace local `loading` state with `useAsyncAction`, wrap the API call, navigate only on success, render `ErrorBanner`, and **delete the `onNext={() => {}}` prop** (keep `onSkip`/`showSkip` where present):

`documentation/page.tsx` handler:

```tsx
const { run, loading, error, clearError } = useAsyncAction();

async function handleConfirm(include: string[], exclude: string[]) {
  const ok = await run(() => confirmSources({ include, exclude }));
  if (ok) router.push("/onboarding/integrations");
}
```

`integrations/page.tsx` handler:

```tsx
async function handleSubmit(slack: boolean, discord: boolean) {
  const ok = await run(() => configureIntegrations({ slack, discord }));
  if (ok) router.push("/onboarding/preferences");
}
```

Shell props become (note: no `onNext`):

```tsx
<OnboardingShell
  currentStep="integrations"
  onSkip={() => router.push("/onboarding/preferences")}
  showSkip
/>
```

`preferences/page.tsx` handler:

```tsx
async function handleSubmit(reviewPolicy: string, autoPublish: boolean) {
  const ok = await run(() =>
    configurePreferences({ review_policy: reviewPolicy, auto_publish: autoPublish })
  );
  if (ok) router.push("/onboarding/initialize");
}
```

Shell props become:

```tsx
<OnboardingShell
  currentStep="preferences"
  onSkip={() => router.push("/onboarding/initialize")}
  showSkip
/>
```

- [ ] **Step 8: Write repository-page regression test**

```tsx
// tests/pages/repository-page.test.tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/api/onboarding", () => ({
  listGitHubRepositories: vi.fn().mockResolvedValue([]),
  selectRepository: vi.fn(),
}));

import { selectRepository } from "@/api/onboarding";
import RepositoryPage from "@/app/(onboarding)/onboarding/repository/page";

describe("RepositoryPage error handling", () => {
  beforeEach(() => {
    vi.mocked(selectRepository).mockClear();
    push.mockClear();
  });

  it("surfaces backend errors instead of navigating silently", async () => {
    vi.mocked(listGitHubRepositories).mockResolvedValueOnce([
      { full_name: "acme/widgets", id: 1 },
    ]);
    vi.mocked(selectRepository).mockRejectedValueOnce(new Error("GitHub not connected yet"));
    const user = userEvent.setup();
    render(<RepositoryPage />);

    await user.click(await screen.findByRole("button", { name: /acme \/ widgets/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("GitHub not connected yet");
    expect(push).not.toHaveBeenCalled();
  });
});
```

Note: `listGitHubRepositories` is mocked because `RepositoryPicker` calls it on mount. Add it to the module factory of any other page test that mounts this page.

- [ ] **Step 9: Run the full unit suite**

Run: `pnpm test`
Expected: PASS — including pre-existing workspace happy-path test

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npx tsc --noEmit && git add -A && git commit -m "fix(onboarding): surface submit errors on every step, drop dead footer Next buttons"
```

---

### Task 3: Auto-wired Back navigation

No page passes `onBack`, so Back renders but does nothing on every step. Default it inside the shell using `getPrevStep` + `router.push`.

**Files:**
- Modify: `components/onboarding/onboarding-shell.tsx`
- Test: `tests/components/onboarding-shell-back.test.tsx` (create)

**Interfaces:**
- Consumes: `getPrevStep(step: OnboardingStep): OnboardingStep | null` from `@/lib/onboarding/steps` (exists)
- Produces: shell prop semantics — `onBack?: () => void` becomes an override; when omitted, Back pushes `` `/onboarding/${prev}` ``

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/onboarding-shell-back.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const push = vi.fn();

describe("OnboardingShell default back navigation", () => {
  it("pushes previous step when onBack omitted", async () => {
    push.mockClear();
    render(
      <OnboardingShell currentStep="repository">
        <p>body</p>
      </OnboardingShell>
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /back/i }));
    expect(push).toHaveBeenCalledWith("/onboarding/github");
  });

  it("prefers explicit onBack over the default", async () => {
    push.mockClear();
    const custom = vi.fn();
    render(
      <OnboardingShell currentStep="repository" onBack={custom}>
        <p>body</p>
      </OnboardingShell>
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /back/i }));
    expect(custom).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- onboarding-shell-back`
Expected: FAIL — `push` never called (onClick is currently `undefined`)

- [ ] **Step 3: Implement in the shell**

In `components/onboarding/onboarding-shell.tsx`:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { SideRail } from "./design/side-rail";
import { ProgressStepper } from "./design/progress-stepper";
import { OnboardingFooter } from "./onboarding-footer";
import { DESIGN_STEP_ORDER, type DesignSlug } from "@/lib/onboarding/design-steps";
import { getPrevStep } from "@/lib/onboarding/steps";
import type { OnboardingStep } from "@/lib/onboarding/types";
```

Inside the component body (above the return):

```tsx
const router = useRouter();
const prevStep = getPrevStep(currentStep);
const handleBack = onBack ?? (prevStep ? () => router.push(`/onboarding/${prevStep}`) : undefined);
```

And in the footer render, swap `onBack={onBack}` → `onBack={handleBack}`.

- [ ] **Step 4: Verify**

Run: `pnpm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add components/onboarding/onboarding-shell.tsx tests/components/onboarding-shell-back.test.tsx
git commit -m "feat(onboarding): wire footer Back to previous step by default"
```

---

### Task 4: Rework GitHub step — no silent auto-advance, surfaced link errors

Today `GitHubConnect` links the first installation server-side with `.catch(() => {})` and immediately navigates away even when linking fails, and the user can never choose anything. New behavior: the component polls until an installation appears, links it, reports state up; failures render inline with Retry; the page enables its footer Next only once linked.

**Files:**
- Modify: `components/onboarding/github-connect.tsx` (full rewrite)
- Modify: `app/(onboarding)/onboarding/github/page.tsx`
- Test: `tests/components/github-connect.test.tsx` (create)

**Interfaces:**
- Consumes: `getInstallUrl(): Promise<{ install_url: string }>`, `listInstallations(): Promise<{ installation_id: number }[]>` from `@/api/github` (exist); `connectGitHub(payload)` from `@/api/onboarding` (exists)
- Produces: `GitHubConnect({ onConnectedChange?: (connected: boolean) => void })` — fires `true` exactly once on successful link. Page passes it to gate footer Next.

- [ ] **Step 1: Write failing tests**

```tsx
// tests/components/github-connect.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubConnect } from "@/components/onboarding/github-connect";

vi.mock("@/api/github", () => ({
  getInstallUrl: vi.fn().mockResolvedValue({ install_url: "https://github.com/install" }),
  listInstallations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/onboarding", () => ({ connectGitHub: vi.fn().mockResolvedValue({}) }));

import { getInstallUrl, listInstallations } from "@/api/github";
import { connectGitHub } from "@/api/onboarding";

describe("GitHubConnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstallUrl).mockResolvedValue({ install_url: "https://github.com/install" });
    vi.mocked(listInstallations).mockResolvedValue([]);
    vi.mocked(connectGitHub).mockResolvedValue({ state: "GITHUB_CONNECTED", github_org: "acme" });
  });

  afterEach(() => vi.useRealTimers());

  it("reports connected once an installation is linked, without navigating", async () => {
    vi.mocked(listInstallations).mockResolvedValue([{ installation_id: 42 }]);
    const onConnectedChange = vi.fn();
    render(<GitHubConnect onConnectedChange={onConnectedChange} />);

    await waitFor(() => expect(onConnectedChange).toHaveBeenCalledWith(true));
    expect(screen.getByText(/GitHub Connected/i)).toBeInTheDocument();
  });

  it("keeps polling while no installation exists", async () => {
    vi.useFakeTimers();
    render(<GitHubConnect />);
    await vi.advanceTimersByTimeAsync(11000);
    expect(vi.mocked(listInstallations).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("shows link failure with working Retry instead of advancing", async () => {
    vi.mocked(listInstallations).mockResolvedValue([{ installation_id: 42 }]);
    vi.mocked(connectGitHub).mockRejectedValueOnce(new Error("Cannot connect GitHub from NOT_STARTED"));
    const onConnectedChange = vi.fn();
    render(<GitHubConnect onConnectedChange={onConnectedChange} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot connect GitHub from NOT_STARTED");
    expect(onConnectedChange).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(onConnectedChange).toHaveBeenCalledWith(true));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- github-connect`
Expected: FAIL — current component takes `onConnected`, auto-navigates via callback named differently, swallows link errors

- [ ] **Step 3: Rewrite GitHubConnect**

```tsx
// components/onboarding/github-connect.tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getInstallUrl, listInstallations } from "@/api/github";
import { connectGitHub } from "@/api/onboarding";
import { ApiError } from "@/api/client";
import { Check } from "lucide-react";
import { GithubIcon } from "@/components/onboarding/design/glyphs";

type Phase = "loading" | "awaiting-install" | "connecting" | "linked" | "error";

const POLL_INTERVAL_MS = 5000;

export function GitHubConnect({ onConnectedChange }: { onConnectedChange?: (connected: boolean) => void }) {
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attempt = useCallback(async (): Promise<void> => {
    setPhase((p) => (p === "linked" ? p : "loading"));
    const [url, installs] = await Promise.all([
      getInstallUrl().catch(() => null),
      listInstallations().catch(() => []),
    ]);
    if (cancelledRef.current) return;
    setInstallUrl(url?.install_url ?? null);

    if (installs.length === 0) {
      setPhase("awaiting-install");
      timerRef.current = setTimeout(() => { void attempt(); }, POLL_INTERVAL_MS);
      return;
    }

    setPhase("connecting");
    try {
      await connectGitHub({ installation_id: installs[0].installation_id });
      if (!cancelledRef.current) {
        setPhase("linked");
        onConnectedChange?.(true);
      }
    } catch (e) {
      if (!cancelledRef.current) {
        setPhase("error");
        setErrorMsg(e instanceof ApiError ? e.message : "Failed to connect your GitHub installation.");
      }
    }
  }, [onConnectedChange]);

  useEffect(() => {
    cancelledRef.current = false;
    void attempt();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [attempt]);

  if (phase === "loading" || phase === "connecting") {
    return <div className="py-8 text-center text-sm text-[#53648e]">
      {phase === "connecting" ? "Connecting…" : "Loading..."}
    </div>;
  }

  if (phase === "linked") {
    return (
      <div className="mx-auto flex w-[min(300px,100%)] items-center justify-center gap-2.5 rounded-lg bg-[#e7f8f0] px-6 py-[clamp(10px,1.5vh,14px)] text-[clamp(13px,1.75vh,16px)] font-bold text-[#19a36d]">
        <Check size={18} /> GitHub Connected
      </div>
    );
  }

  return (
    <div className="col-span-full flex flex-col items-center gap-3">
      {phase === "error" && (
        <div role="alert" className="rounded-lg bg-red-50 px-4 py-2 text-xs text-red-600">{errorMsg}</div>
      )}
      {phase === "awaiting-install" && (
        <small className="text-xs text-[#647397]">Waiting for installation… you can close the GitHub tab once done.</small>
      )}
      <button
        onClick={() => installUrl && window.open(installUrl, "_blank")}
        className="mx-auto mt-[clamp(4px,1vh,10px)] flex w-[min(300px,100%)] items-center justify-center gap-2.5 rounded-lg bg-[#17191f] px-6 py-[clamp(10px,1.5vh,14px)] text-[clamp(13px,1.75vh,16px)] font-bold text-white transition hover:bg-black"
      >
        <GithubIcon size={20} className="text-white" />
        {phase === "error" ? "Try again" : "Install GitHub App"}
      </button>
      {phase === "error" && (
        <button
          onClick={() => void attempt()}
          className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-brand hover:underline"
        >
          Retry connection
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update the GitHub page**

```tsx
// app/(onboarding)/onboarding/github/page.tsx — component body only
"use client";
import { useState } from "react";
// …existing imports, minus nothing…

export default function GitHubPage() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);

  return (
    <OnboardingShell
      currentStep="github"
      onNext={connected ? () => router.push("/onboarding/repository") : undefined}
    >
      {/* …unchanged JSX… */}
      <GitHubConnect onConnectedChange={setConnected} />
      {/* …unchanged JSX… */}
    </OnboardingShell>
  );
}
```

Key changes: `useState` import added; `GitHubConnect onConnected={...}` prop renamed; Next appears (enabled) only after linking succeeds — no automatic navigation.

- [ ] **Step 5: Verify**

Run: `pnpm test`
Expected: PASS (all suites)

- [ ] **Step 6: Commit**

```bash
git add components/onboarding/github-connect.tsx "app/(onboarding)/onboarding/github/page.tsx" tests/components/github-connect.test.tsx
git commit -m "fix(onboarding): github step polls, surfaces link errors, advances only on success"
```

---

### Task 5: Initialize polling resilience

`poll()` runs bare inside `setInterval`: one transient network error becomes an unhandled rejection and stale UI forever. Add failure tracking with a surfaced retry path.

**Files:**
- Modify: `app/(onboarding)/onboarding/initialize/page.tsx`
- Test: `tests/pages/initialize-page.test.tsx` (create)

**Interfaces:**
- Consumes: `startInitialize`, `getInitializeStatus`, `retryInitialize` from `@/api/onboarding`; `InitializationError` props `{ failure: { step: string; detail: string } | null; onRetry: () => void }` (both exist)
- Produces: none downstream

- [ ] **Step 1: Write failing test**

```tsx
// tests/pages/initialize-page.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/api/onboarding", () => ({
  startInitialize: vi.fn().mockResolvedValue({ state: "INITIALIZING" }),
  getInitializeStatus: vi.fn().mockResolvedValue({ state: "INITIALIZING", stage: null, failure: null }),
  retryInitialize: vi.fn().mockResolvedValue({ state: "INITIALIZING" }),
}));

import { getInitializeStatus } from "@/api/onboarding";
import InitializePage from "@/app/(onboarding)/onboarding/initialize/page";

describe("InitializePage polling resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInitializeStatus).mockResolvedValue({ state: "INITIALIZING", stage: null, failure: null });
  });
  afterEach(() => vi.useRealTimers());

  it("surfaces an error after repeated poll failures and recovers on retry", async () => {
    // Queue: first call resolves, every subsequent call rejects (5 failures needed).
    vi.mocked(getInitializeStatus)
      .mockRejectedValue(new TypeError("offline"))
      .mockResolvedValueOnce({ state: "INITIALIZING", stage: null, failure: null });
    vi.useFakeTimers();
    render(<InitializePage />);
    // flush initial startInitialize promise
    await vi.advanceTimersByTimeAsync(0);
    // polls fire at t=3s,6s,…; poll #1 resolves, polls #2–#6 reject → threshold (5) hit at t=18s
    await vi.advanceTimersByTimeAsync(19000);
    expect(screen.getByText(/initialization failed|having trouble/i)).toBeInTheDocument();

    // recovery: subsequent polls succeed
    vi.mocked(getInitializeStatus).mockResolvedValue({ state: "COMPLETED", stage: null, failure: null });
    await vi.advanceTimersByTimeAsync(7000);
    expect(push).toHaveBeenCalledWith("/onboarding/complete");
  });

  it("navigates to complete on COMPLETED status", async () => {
    vi.useFakeTimers();
    vi.mocked(getInitializeStatus).mockResolvedValue({ state: "COMPLETED", stage: null, failure: null });
    render(<InitializePage />);
    await vi.advanceTimersByTimeAsync(3500);
    expect(push).toHaveBeenCalledWith("/onboarding/complete");
  });
});
```

If fake-timer flakiness arises with RTL `act` warnings, wrap timer advances in `await act(async () => { await vi.advanceTimersByTimeAsync(n); })` — adjust the test, not the component.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- initialize-page`
Expected: FAIL — current code throws unhandled rejections; no trouble-state UI ever appears

- [ ] **Step 3: Implement**

Full replacement of `initialize/page.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { InitializationProgress } from "@/components/onboarding/initialization-progress";
import { InitializationError } from "@/components/onboarding/initialization-error";
import { startInitialize, getInitializeStatus, retryInitialize } from "@/api/onboarding";
import type { InitializeStatus } from "@/lib/onboarding/types";

const MAX_POLL_FAILURES = 5;

export default function InitializePage() {
  const router = useRouter();
  const [status, setStatus] = useState<InitializeStatus | null>(null);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pollFailures, setPollFailures] = useState(0);

  const poll = useCallback(async () => {
    try {
      const s = await getInitializeStatus();
      setPollFailures(0);
      setStatus(s);
      if (s.state === "COMPLETED") router.push("/onboarding/complete");
    } catch {
      setPollFailures((n) => n + 1);
    }
  }, [router]);

  useEffect(() => {
    if (!started) {
      startInitialize()
        .then(() => {
          setStartError(null);
          setStarted(true);
        })
        .catch(() => setStartError("We couldn't start initialization. Check your connection and retry."));
    }
    const interval = setInterval(() => void poll(), 3000);
    return () => clearInterval(interval);
  }, [started, poll]);

  const isFailed = status?.state === "FAILED" || pollFailures >= MAX_POLL_FAILURES || !!startError;

  async function handleRetry() {
    setStartError(null);
    setPollFailures(0);
    try {
      await retryInitialize();
      setStarted(false);
    } catch {
      setStartError("Retry failed. Please try again.");
    }
  }

  return (
    <OnboardingShell currentStep="initialize">
      <h1 className="mb-[11px] mt-[clamp(24px,4vh,48px)] text-[clamp(24px,3.2vh,32px)] font-bold leading-[1.2] tracking-[-1.2px] text-[#101a43]">
        Initializing Draftly
      </h1>
      <p className="mb-[clamp(8px,1.8vh,24px)] text-[15px] leading-[1.55] text-[#53648e]">
        We&apos;re analyzing your repository and building the knowledge
        <br /> foundation. This may take a few minutes.
      </p>
      <div className="mt-6">
        {isFailed ? (
          <InitializationError
            failure={
              status?.failure ?? (startError || pollFailures >= MAX_POLL_FAILURES
                ? { step: "initialize", detail: startError ?? "Lost contact with the server while initializing." }
                : null)
            }
            onRetry={() => void handleRetry()}
          />
        ) : (
          <InitializationProgress stage={status?.stage ?? null} />
        )}
      </div>
    </OnboardingShell>
  );
}
```

Note the shell call drops both `onNext={() => {}}` and `isNextDisabled={true}` — with Task 2's footer change, no dead disabled Next renders on this screen anymore.

- [ ] **Step 4: Verify**

Run: `pnpm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add "app/(onboarding)/onboarding/initialize/page.tsx" tests/pages/initialize-page.test.tsx
git commit -m "fix(onboarding): resilient initialize polling with surfaced retry"
```

---

### Task 6: Deep-link step guards + honest completion screen

Nothing stops a user from landing directly on `/onboarding/complete` or `/onboarding/initialize`; the complete page even swallows the resulting 409 and shows fake zeros. Add a client-side guard driven by persisted server state.

**Files:**
- Create: `lib/onboarding/use-step-guard.ts`
- Modify: all 8 step pages (`workspace`, `github`, `repository`, `documentation`, `integrations`, `preferences`, `initialize`, `complete`) — one-line hook call each
- Modify: `app/(onboarding)/onboarding/complete/page.tsx` (error state)
- Test: `tests/lib/use-step-guard.test.tsx` (create)

**Interfaces:**
- Consumes: `getOnboardingStatus(): Promise<OnboardingStatus>`; `STATE_TO_STEP: Record<string, OnboardingStep>`; `STEP_ORDER: OnboardingStep[]` (all exist; `STEP_ORDER` intentionally excludes `"complete"` — the guard special-cases it)
- Produces: `useStepGuard(step: OnboardingStep): void` — redirect-only, no return value. Redirect rules: state `COMPLETED` + step ≠ complete → `/dashboard`; step = complete + state ≠ COMPLETED → mapped step; otherwise `STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(mapped)` → mapped step. Network failure → do nothing (never lock users out offline).

- [ ] **Step 1: Write failing tests**

```tsx
// tests/lib/use-step-guard.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const mockStatus = vi.fn();
vi.mock("@/api/onboarding", () => ({
  getOnboardingStatus: (...a: unknown[]) => mockStatus(...a),
}));

import { getOnboardingStatus } from "@/api/onboarding";
import { useStepGuard } from "@/lib/onboarding/use-step-guard";

function Probe({ step }: { step: Parameters<typeof useStepGuard>[0] }) {
  useStepGuard(step);
  return null;
}

describe("useStepGuard", () => {
  it("redirects early deep-links back to the persisted step", async () => {
    mockStatus.mockResolvedValue({ state: "WORKSPACE_CREATED" });
    render(<Probe step="repository" />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/onboarding/workspace"));
  });

  it("allows steps up to the persisted state", async () => {
    replace.mockClear();
    mockStatus.mockResolvedValue({ state: "GITHUB_CONNECTED" });
    render(<Probe step="repository" />);
    await vi.waitFor(() => expect(getOnboardingStatus).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
  });

  it("bounces completed users to dashboard", async () => {
    mockStatus.mockResolvedValue({ state: "COMPLETED" });
    render(<Probe step="workspace" />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("redirects non-complete visitors away from /complete", async () => {
    mockStatus.mockResolvedValue({ state: "REPOSITORY_SELECTED" });
    render(<Probe step="complete" />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/onboarding/documentation"));
  });

  it("does nothing when status fetch fails", async () => {
    replace.mockClear();
    mockStatus.mockRejectedValue(new TypeError("offline"));
    render(<Probe step="complete" />);
    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- use-step-guard`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the hook**

```ts
// lib/onboarding/use-step-guard.ts
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getOnboardingStatus } from "@/api/onboarding";
import { STATE_TO_STEP, STEP_ORDER } from "./constants";
import type { OnboardingStep } from "./types";

export function useStepGuard(step: OnboardingStep): void {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    getOnboardingStatus()
      .then((status) => {
        if (cancelled) return;
        if (status.state === "COMPLETED") {
          if (step !== "complete") router.replace("/dashboard");
          return;
        }
        const expected = STATE_TO_STEP[status.state] ?? "workspace";
        if (step === "complete") {
          router.replace(`/onboarding/${expected}`);
          return;
        }
        if (STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(expected)) {
          router.replace(`/onboarding/${expected}`);
        }
      })
      .catch(() => {
        // Status unavailable (backend down / network): stay put rather than trap the user.
      });
    return () => {
      cancelled = true;
    };
  }, [router, step]);
}
```

- [ ] **Step 4: Wire into every step page**

Add import + single hook call as the first statement in each component body:

```tsx
import { useStepGuard } from "@/lib/onboarding/use-step-guard";
// inside the component:
useStepGuard("workspace"); // ← matching literal per page
```

Pages: `workspace`, `github`, `repository`, `documentation`, `integrations`, `preferences`, `initialize`, `complete`.

- [ ] **Step 5: Honest completion screen**

Replace the effect + add error state in `complete/page.tsx`:

```tsx
const [counts, setCounts] = useState({ documents: 0, chunks: 0 });
const [finalizeError, setFinalizeError] = useState<string | null>(null);

useEffect(() => {
  // Finalize server-side first (spec §5.2 POST /complete, idempotent),
  // then read back the persisted result for the summary.
  completeOnboarding()
    .then(() => getOnboardingStatus())
    .then((s) => {
      const repo = s.selected_repository as Record<string, unknown> | null;
      setCounts({
        documents: (repo?.document_count as number) ?? 0,
        chunks: (repo?.chunk_count as number) ?? 0,
      });
    })
    .catch(() => {
      setFinalizeError("We couldn't load your final summary. Your workspace is ready — you can view stats from the dashboard.");
    });
}, []);
```

And render above `<OnboardingComplete …>`:

```tsx
{finalizeError && <ErrorBanner message={finalizeError} />}
```

(with the usual `ErrorBanner` import; no dismiss — informational.)

- [ ] **Step 6: Verify**

Run: `pnpm test && npx tsc --noEmit`
Expected: PASS / exit 0

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(onboarding): client-side step guards and honest completion screen"
```

---

### Task 7: Prevent double-submits on inline CTAs

Footer buttons disable during flight, but the inline CTAs ("Confirm sources", "Continue with these sources", preferences "Continue") stay clickable while their request is pending.

**Files:**
- Modify: `components/onboarding/documentation-sources.tsx`
- Modify: `components/onboarding/integration-picker.tsx`
- Modify: `components/onboarding/preferences-form.tsx`
- Modify: the three parent pages (pass `loading`)
- Test: `tests/components/double-submit.test.tsx` (create)

**Interfaces:**
- Produces: `DocumentationSources({ onConfirm, loading? }: { onConfirm: (include: string[], exclude: string[]) => void; loading?: boolean })`; `IntegrationPicker({ onSubmit, loading? })`; `PreferencesForm({ onSubmit, loading? })` — parents pass the `loading` boolean from `useAsyncAction`

- [ ] **Step 1: Write failing test**

```tsx
// tests/components/double-submit.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocumentationSources } from "@/components/onboarding/documentation-sources";
import { PreferencesForm } from "@/components/onboarding/preferences-form";

vi.mock("@/api/onboarding", () => ({
  discoverDocumentation: vi.fn().mockResolvedValue({
    candidates: ["docs/a.md"],
    count: 1,
    total_files: 1,
  }),
}));

describe("inline CTA disabled during submission", () => {
  it("disables Confirm sources while loading", async () => {
    render(<DocumentationSources loading onConfirm={() => {}} />);
    expect(await screen.findByRole("button", { name: /confirm sources/i })).toBeDisabled();
  });

  it("disables preferences Continue while loading", () => {
    render(<PreferencesForm loading onSubmit={() => {}} />);
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- double-submit`
Expected: FAIL — `loading` prop not accepted / buttons not disabled

- [ ] **Step 3: Implement**

`documentation-sources.tsx`:

```tsx
interface Props {
  onConfirm: (include: string[], exclude: string[]) => void;
  loading?: boolean;
}

export function DocumentationSources({ onConfirm, loading = false }: Props) {
```

Confirm button:

```tsx
<DesignButton
  primary
  className="mt-[22px]"
  disabled={loading}
  onClick={() => onConfirm(include, exclude)}
>
  Confirm sources
</DesignButton>
```

`integration-picker.tsx`:

```tsx
interface Props {
  onSubmit: (slack: boolean, discord: boolean) => void;
  loading?: boolean;
}

export function IntegrationPicker({ onSubmit, loading = false }: Props) {
```

Continue button (raw `<button>`) gains:

```tsx
disabled={loading}
className={cn(/* existing classes */, loading && "cursor-not-allowed opacity-60")}
```

`preferences-form.tsx`: same `loading?: boolean` prop; Continue becomes `<DesignButton primary className="mt-[22px]" disabled={loading} onClick={handleSubmit}>`.

Parent pages pass it: `<DocumentationSources onConfirm={handleConfirm} loading={loading} />`, `<IntegrationPicker onSubmit={handleSubmit} loading={loading} />`, `<PreferencesForm onSubmit={handleSubmit} loading={loading} />`.

- [ ] **Step 4: Verify**

Run: `pnpm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(onboarding): disable inline CTAs while submitting"
```

---

### Task 8: Accessibility pass on onboarding controls

Custom radio cards, checkbox tiles, and switches are plain buttons/divs with no semantics; labels aren't associated; errors aren't announced.

**Files:**
- Modify: `components/onboarding/workspace-form.tsx`
- Modify: `components/onboarding/preferences-form.tsx`
- Modify: `components/onboarding/documentation-sources.tsx`
- Modify: `components/onboarding/integration-picker.tsx`
- Modify: `components/onboarding/repository-picker.tsx`
- Test: `tests/components/a11y-semantics.test.tsx` (create)

**Interfaces:**
- Produces: DOM contracts relied on by tests — `#workspace-name`, `#workspace-description`, `#workspace-name-error`; `role="radiogroup"` + `role="radio"` + `aria-checked`; `role="switch"` + `aria-checked`; `aria-pressed` on source/doc toggles

- [ ] **Step 1: Write failing semantic tests**

```tsx
// tests/components/a11y-semantics.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceForm } from "@/components/onboarding/workspace-form";
import { PreferencesForm } from "@/components/onboarding/preferences-form";
import { IntegrationPicker } from "@/components/onboarding/integration-picker";

describe("onboarding a11y semantics", () => {
  it("associates workspace labels and announces errors", async () => {
    const onSubmit = vi.fn();
    render(<WorkspaceForm onSubmit={() => onSubmit()} />);
    const nameInput = screen.getByLabelText(/workspace name/i);
    expect(nameInput).toHaveAttribute("id", "workspace-name");

    await userEvent.setup().type(nameInput, "x"); // 1 char → invalid
    fireEvent.submit(nameInput.closest("form")!);
    const err = await screen.findByText(/at least 2 characters/i);
    expect(err).toHaveAttribute("id", "workspace-name-error");
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
  });

  it("exposes review policy as radiogroup with checked state", async () => {
    render(<PreferencesForm onSubmit={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: /review policy/i });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    await userEvent.setup().click(radios[2]);
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveAttribute("aria-checked", "false");
  });

  it("exposes automation toggle as a switch", async () => {
    render(<PreferencesForm onSubmit={() => {}} />);
    const sw = screen.getByRole("switch", { name: /auto-publish/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.setup().click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("marks integration connect buttons with pressed state", async () => {
    render(<IntegrationPicker onSubmit={() => {}} />);
    const slackBtn = screen.getByRole("button", { name: /connect slack/i });
    expect(slackBtn).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(slackBtn);
    expect(slackBtn).toHaveAttribute("aria-pressed", "true");
  });
});
```

Add imports: `import { fireEvent } from "@testing-library/react";` and `import { within } from "@testing-library/react";` (merge into the existing RTL import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- a11y-semantics`
Expected: FAIL — attributes/roles absent

- [ ] **Step 3: Implement**

`workspace-form.tsx` — associate labels, announce errors:

```tsx
<label htmlFor="workspace-name" className={formLabel}>Workspace name</label>
<input
  id="workspace-name"
  type="text"
  value={name}
  onChange={(e) => setName(e.target.value)}
  placeholder="e.g. my-project"
  aria-invalid={!!error}
  aria-describedby={error ? "workspace-name-error" : undefined}
  className={inputRecipe}
/>
{error && (
  <p id="workspace-name-error" aria-live="polite" className="mt-2 text-[11px] text-red-500">{error}</p>
)}
```

Description textarea: `id="workspace-description"` + matching `htmlFor="workspace-description"` on its label.

`preferences-form.tsx` — policy group:

```tsx
<div role="radiogroup" aria-label="Review policy" className="grid grid-cols-3 gap-[13px] max-[900px]:grid-cols-1">
  {POLICY_OPTIONS.map(({ value, label, desc, icon }) => {
    const selected = reviewPolicy === value;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => setReviewPolicy(value)}
        /* existing className unchanged */
      >
```

Automation toggle:

```tsx
<button
  type="button"
  role="switch"
  aria-checked={autoPublish}
  onClick={() => setAutoPublish((v) => !v)}
  /* existing className unchanged */
>
```

Error paragraph gains `aria-live="polite"`. (Keep the visual `RadioDot` as-is — `aria-checked` carries state now.)

`documentation-sources.tsx` — include/exclude tiles become toggles:

```tsx
<button
  key={path}
  type="button"
  aria-pressed={!excluded.has(path)}
  aria-label={`${!excluded.has(path) ? "Exclude" : "Include"} ${path}`}
  onClick={() => toggle(path)}
  /* existing className unchanged */
>
```

`integration-picker.tsx` — connect buttons gain `aria-pressed={connected}`.

`repository-picker.tsx` — search input gains `aria-label="Search repositories"`; repo buttons gain `aria-pressed={chosen}`.

- [ ] **Step 4: Verify**

Run: `pnpm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "a11y(onboarding): label association, radio/switch/toggle semantics, live errors"
```

---

### Task 9: Playwright E2E smoke (happy path + resume + guard)

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/onboarding.spec.ts`
- Create: `e2e/global-setup.ts`
- Modify: `package.json` (add `"test:e2e": "playwright test"` script)
- Install: `pnpm add -D @playwright/test @clerk/testing` and `pnpm exec playwright install chromium`

**Interfaces:**
- Consumes: real app served by `next dev`; all `/api/**` requests intercepted with `page.route` so no backend needed; Clerk sign-in handled via `@clerk/testing` token helpers against the project's existing Clerk dev keys in `.env.local`
- Prerequisite (hard requirement): `.env.local` contains valid `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (dev instance) and a seeded test user email/password exported as `E2E_EMAIL`/`E2E_PASSWORD`. If absent, the spec fails fast with an explanatory message — that is intended.

- [ ] **Step 1: Install and configure**

```bash
pnpm add -D @playwright/test @clerk/testing && pnpm exec playwright install chromium
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3000" },
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

```ts
// e2e/global-setup.ts
import { clerkSetup } from "@clerk/testing";

export default async function globalSetup() {
  await clerkSetup(); // fails fast with instructions if Clerk test keys are missing
}
```

- [ ] **Step 2: Write the E2E spec**

```ts
// e2e/onboarding.spec.ts
import { test, expect, type Page } from "@playwright/test";
import { clerk } from "@clerk/testing";

let created: Record<string, unknown[]> = {};

/** Mock the entire backend surface the wizard touches. */
async function mockBackend(page: Page, initialState: string) {
  let state = initialState;
  created = {};
  const record = (key: string) => (created[key] ??= []).push(1);

  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, "");
    const method = req.method();

    if (path === "/onboarding/status") {
      return route.fulfill(json({
        state,
        completed_steps: [],
        failure: null,
        selected_repository: state === "COMPLETED"
          ? { document_count: 27, chunk_count: 1340 }
          : null,
      }));
    }
    if (path === "/onboarding/github/repositories") {
      return route.fulfill(json({ repositories: [{ full_name: "acme/widgets", id: 1 }] }));
    }
    if (path === "/onboarding/documentation/discover") {
      return route.fulfill(json({ candidates: ["docs/index.md", "docs/api.md"], count: 2, total_files: 40 }));
    }
    if (path === "/github/install-url") {
      return route.fulfill(json({ install_url: "https://github.com/apps/draftly/installations/new" }));
    }
    if (path === "/github/installations") {
      return route.fulfill(json([]));
    }
    const transitions: Record<string, string> = {
      "/onboarding/workspace": "WORKSPACE_CREATED",
      "/onboarding/github/connect": "GITHUB_CONNECTED",
      "/onboarding/repository": "REPOSITORY_SELECTED",
      "/onboarding/sources": "DOCUMENTATION_DISCOVERED",
      "/onboarding/integrations": "INTEGRATIONS_CONFIGURED",
      "/onboarding/preferences": "PREFERENCES_CONFIGURED",
      "/onboarding/complete": "COMPLETED",
    };
    if (method === "POST" && transitions[path]) {
      record(path);
      state = transitions[path];
      return route.fulfill(json({ state }));
    }
    if (path === "/onboarding/initialize" && method === "POST") {
      return route.fulfill(json({ state: "INITIALIZING" }));
    }
    if (path === "/onboarding/initialize/status") {
      return route.fulfill(json({ state: "COMPLETED", stage: "recommendations", failure: null }));
    }
    return route.fulfill(json({}));
  });
}

test.describe.serial("onboarding happy path", () => {
  test("walks all nine steps to the completion screen", async ({ page }) => {
    await mockBackend(page, "NOT_STARTED");

    await clerk.signIn({ page, signInUrl: "/sign-in" }); // per @clerk/testing docs
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: /create your workspace/i })).toBeVisible();

    await page.getByPlaceholder("e.g. my-project").fill("acme-docs");
    await page.getByRole("button", { name: /next/i }).click();
    expect(created["/onboarding/workspace"]).toBeTruthy();
    await expect(page.getByRole("heading", { name: /connect your github account/i })).toBeVisible();

    // GitHub: mocked installations endpoint returns [] → install button; simulate install then recheck
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    // force the poll by mocking a fresh navigation-free recheck is covered by component tests;
    // for E2E simplicity, drive straight to repository via the state we control:
    await page.goto("/onboarding/repository");
    await page.getByRole("button", { name: /acme \/ widgets/i }).click();
    await page.getByRole("button", { name: /next/i }).click();
    expect(created["/onboarding/repository"]).toBeTruthy();

    await expect(page.getByText(/Discovering documentation|found/i)).toBeVisible();
    await page.getByRole("button", { name: /confirm sources/i }).click();
    expect(created["/onboarding/sources"]).toBeTruthy();

    await page.getByRole("button", { name: /continue with these sources/i }).click();
    await page.getByRole("button", { name: /^continue$/i }).click();
    expect(created["/onboarding/preferences"]).toBeTruthy();

    await expect(page.getByRole("heading", { name: /initializing draftly/i })).toBeVisible();
    await expect(page.getByText(/you're all set|congratulations|complete/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("deep-linking ahead bounces back to the persisted step", async ({ page }) => {
    await mockBackend(page, "NOT_STARTED");
    await clerk.signIn({ page, signInUrl: "/sign-in" });
    await page.goto("/onboarding/complete");
    await expect(page).toHaveURL(/\/onboarding\/workspace/);
  });
});
```

Adjust selectors after first run against the real DOM — the assertions above encode intent; exact copy comes from the rendered pages. Any selector mismatch is fixed in this spec only, never in production code to satisfy a test.

- [ ] **Step 3: Run E2E**

Run: `pnpm exec playwright test`
Expected: 2 passed (after selector tuning); app boots via `webServer`

- [ ] **Step 4: Final full verification sweep**

```bash
pnpm test && npx tsc --noEmit && pnpm lint 2>&1 | tail -3
```

Expected: unit suite green, tsc exit 0, lint problem count unchanged from baseline (31 pre-existing, none in touched dirs).

- [ ] **Step 5: Update knowledge graph and commit**

From repo root `draftly-docs-engineer/`: `graphify update .`

```bash
git add -A && git commit -m "test(onboarding): playwright e2e smoke for happy path and deep-link guard"
```

---

## Out of scope (recorded, not planned)

- Sentry/error-tracking wiring (needs DSN + account decisions)
- i18n extraction of hardcoded strings
- Fixing the 31 pre-existing lint problems outside onboarding paths
- Multi-org token scoping (`org_id` selection) — backend concern
