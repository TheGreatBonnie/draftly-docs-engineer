# Onboarding Public Documentation Source — UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the `draftly-agent-ui` gap for the new `public_documentation` onboarding source mode introduced in `draftly-agent-backend` commit `b15adf4`, so a user can select a public documentation root, confirm discovered URL candidates, and manually sync the corpus.

**Architecture:** The backend kept the same onboarding state machine and five init stages; it only added a second source mode to the repository/documentation steps plus one new endpoint. The UI follows suit: extend the API layer and types, add pure, node-tested helpers for payload building/validation/URL display, add a source-mode toggle to the repository step with a public-docs URL form, and make the documentation step mode-aware (render URL candidates, add a "Sync documentation" action).

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5.7. Tests: Node 22 `node:test` via `node --experimental-strip-types --test tests/*.test.ts` (no jsdom — components are not unit-tested in this repo; logic lives in pure modules that are).

**Spec:** `docs/superpowers/specs/2026-09-20-tavily-rag-design.md` (`# Stage 0 / source configuration`, `# Freshness lifecycle`; acceptance criteria #2)

## Global Constraints

- Backend `RepositoryRequest` fields: `full_name: str`, `default_branch: str = "main"`, `source_type: str = "github_repository"`, `documentation_config: dict | None`. `PublicDocumentationConfig`: `root_url: HttpUrl` (HTTPS only, no embedded credentials), `include_paths: list[str]`, `exclude_paths: list[str]`, `crawl_instructions: str | None`.
- Backend `POST /onboarding/documentation/discover` returns `{candidates: string[], count: number}` for public mode (no `total_files`).
- Backend `POST /onboarding/documentation/refresh` requires `{urls: string[]}` and returns `{skipped, replaced, failed, deleted}` counts.
- The onboarding state machine still requires the GitHub connect step before repository selection; do **not** reorder or hide the `github` step.
- Do not change GitHub-mode behavior (types, payloads, routes) — it must stay byte-identical at the wire level.
- Follow existing file/export patterns: `lib/onboarding/*`, `components/onboarding/*`, tests in `draftly-agent-ui/tests/*.test.ts` importing with `.ts` extensions.
- Frontend progress UI for init stages is untouched by the spec; do not modify initialize pages.
- Run commands from the `draftly-agent-ui/` directory (submodule, branch `main`).

---

### Task 1: Types, validation, and pure source-mode helpers

**Files:**
- Modify: `draftly-agent-ui/lib/onboarding/types.ts`
- Modify: `draftly-agent-ui/lib/onboarding/validation.ts`
- Create: `draftly-agent-ui/lib/onboarding/source-model.ts`
- Test: `draftly-agent-ui/tests/onboarding-source-model.test.ts`

**Interfaces:**
- Produces:
  - `type SourceType = "github_repository" | "public_documentation"`
  - `interface PublicDocumentationConfig { root_url: string; include_paths?: string[]; exclude_paths?: string[]; crawl_instructions?: string }`
  - `interface RepositoryPayload { full_name: string; default_branch?: string; source_type?: SourceType; documentation_config?: PublicDocumentationConfig }`
  - `interface RefreshResult { skipped: number; replaced: number; failed: number; deleted: number }`
  - `DiscoveryResult.total_files` becomes optional (`total_files?: number`)
  - `interface PublicDocsDraft { rootUrl: string; includePaths: string[]; excludePaths: string[]; crawlInstructions: string }`
  - `function isPublicDocumentation(sourceType?: string): boolean`
  - `function buildRepositoryPayload(draft: PublicDocsDraft): RepositoryPayload`
  - `function candidateLabel(candidate: string): string`
  - `function validatePublicDocsRootUrl(value: string): string | null`
  - `function parsePathList(value: string): string[]`

- [ ] **Step 1: Write the failing tests**

Create `draftly-agent-ui/tests/onboarding-source-model.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRepositoryPayload,
  candidateLabel,
  isPublicDocumentation,
} from "../lib/onboarding/source-model.ts";
import {
  parsePathList,
  validatePublicDocsRootUrl,
} from "../lib/onboarding/validation.ts";

test("isPublicDocumentation matches the backend enum string", () => {
  assert.equal(isPublicDocumentation("public_documentation"), true);
  assert.equal(isPublicDocumentation("github_repository"), false);
  assert.equal(isPublicDocumentation(undefined), false);
});

test("buildRepositoryPayload emits source_type and documentation_config", () => {
  const payload = buildRepositoryPayload({
    rootUrl: "https://docs.example.com",
    includePaths: ["docs/**"],
    excludePaths: ["docs/archived/**"],
    crawlInstructions: "Follow the reference pages first",
  });
  assert.equal(payload.source_type, "public_documentation");
  assert.equal(payload.full_name, "docs.example.com");
  assert.deepEqual(payload.documentation_config, {
    root_url: "https://docs.example.com",
    include_paths: ["docs/**"],
    exclude_paths: ["docs/archived/**"],
    crawl_instructions: "Follow the reference pages first",
  });
});

test("buildRepositoryPayload omits empty crawl_instructions", () => {
  const payload = buildRepositoryPayload({
    rootUrl: "https://docs.example.com",
    includePaths: [],
    excludePaths: [],
    crawlInstructions: "   ",
  });
  assert.equal("crawl_instructions" in (payload.documentation_config ?? {}), false);
});

test("candidateLabel shows file name for repo paths", () => {
  assert.equal(candidateLabel("docs/guides/auth.md"), "auth.md");
});

test("candidateLabel shows last path segment or hostname for URLs", () => {
  assert.equal(candidateLabel("https://docs.example.com/getting-started"), "getting-started");
  assert.equal(candidateLabel("https://docs.example.com"), "docs.example.com");
});

test("validatePublicDocsRootUrl rejects empty, non-https, and credentialed roots", () => {
  assert.ok(validatePublicDocsRootUrl(""));
  assert.ok(validatePublicDocsRootUrl("http://docs.example.com"));
  assert.ok(validatePublicDocsRootUrl("https://user:pass@docs.example.com"));
  assert.equal(validatePublicDocsRootUrl("https://docs.example.com"), null);
});

test("parsePathList splits on newlines and commas and trims", () => {
  assert.deepEqual(parsePathList("docs/**\n, guides/** , "), ["docs/**", "guides/**"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test tests/onboarding-source-model.test.ts` (from `draftly-agent-ui/`)
Expected: FAIL — `Error: Cannot find module '../lib/onboarding/source-model.ts'`

- [ ] **Step 3: Add types**

In `draftly-agent-ui/lib/onboarding/types.ts`, after `WorkspacePayload`:

```ts
export type SourceType = "github_repository" | "public_documentation";

export interface PublicDocumentationConfig {
  root_url: string;
  include_paths?: string[];
  exclude_paths?: string[];
  crawl_instructions?: string;
}

export interface RefreshResult {
  skipped: number;
  replaced: number;
  failed: number;
  deleted: number;
}
```

Replace `export interface RepositoryPayload {` ... `}` with:

```ts
export interface RepositoryPayload {
  full_name: string;
  default_branch?: string;
  source_type?: SourceType;
  documentation_config?: PublicDocumentationConfig;
}
```

Change `DiscoveryResult` to `total_files?: number; // GitHub-only; absent for public_documentation` (keep `candidates`/`count`).

- [ ] **Step 4: Add validation functions**

In `draftly-agent-ui/lib/onboarding/validation.ts`:

```ts
export function validatePublicDocsRootUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Documentation URL is required";
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") return "Documentation URL must start with https://";
    if (u.username || u.password) return "Documentation URL must not contain credentials";
    if (!u.hostname) return "Enter a valid URL (e.g. https://docs.example.com)";
    return null;
  } catch {
    return "Enter a valid URL (e.g. https://docs.example.com)";
  }
}

export function parsePathList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 5: Create the source-model helpers**

Create `draftly-agent-ui/lib/onboarding/source-model.ts`:

```ts
import type {
  PublicDocumentationConfig,
  RepositoryPayload,
} from "./types";

export interface PublicDocsDraft {
  rootUrl: string;
  includePaths: string[];
  excludePaths: string[];
  crawlInstructions: string;
}

export function isPublicDocumentation(sourceType?: string): boolean {
  return sourceType === "public_documentation";
}

export function hostnameForUrl(value: string): string {
  try {
    return new URL(value.trim()).hostname || "public-docs";
  } catch {
    return "public-docs";
  }
}

export function buildRepositoryPayload(draft: PublicDocsDraft): RepositoryPayload {
  const config: PublicDocumentationConfig = {
    root_url: draft.rootUrl.trim(),
    include_paths: draft.includePaths,
    exclude_paths: draft.excludePaths,
  };
  if (draft.crawlInstructions.trim()) {
    config.crawl_instructions = draft.crawlInstructions.trim();
  }
  return {
    full_name: hostnameForUrl(draft.rootUrl),
    source_type: "public_documentation",
    documentation_config: config,
  };
}

export function candidateLabel(candidate: string): string {
  if (/^https?:\/\//.test(candidate)) {
    try {
      const u = new URL(candidate);
      const last = u.pathname.split("/").filter(Boolean).pop();
      return last || u.hostname;
    } catch {
      return candidate;
    }
  }
  return candidate.split("/").filter(Boolean).pop() ?? candidate;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test tests/onboarding-source-model.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 7: Commit**

```bash
git -C draftly-agent-ui add lib/onboarding/types.ts lib/onboarding/validation.ts lib/onboarding/source-model.ts tests/onboarding-source-model.test.ts
git -C draftly-agent-ui commit -m "feat(onboarding): add public documentation source types and helpers"
```

---

### Task 2: API layer — refresh endpoint and payload passthrough

**Files:**
- Modify: `draftly-agent-ui/api/onboarding.ts`
- Test: `draftly-agent-ui/tests/onboarding-api.test.ts`

**Interfaces:**
- Consumes: `RefreshResult` from `lib/onboarding/types.ts` (Task 1).
- Produces: `export async function refreshDocumentation(urls: string[]): Promise<RefreshResult>` posting `{ urls }` to `/onboarding/documentation/refresh`. `selectRepository` already forwards the full `RepositoryPayload` body — verified by test, no code change.

- [ ] **Step 1: Write the failing test**

Create `draftly-agent-ui/tests/onboarding-api.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { setApiToken } from "../api/client.ts";
import { refreshDocumentation, selectRepository } from "../api/onboarding.ts";

test("refreshDocumentation posts urls to /onboarding/documentation/refresh", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;
  setApiToken("test-token");
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body as string | undefined,
    });
    return new Response(
      JSON.stringify({ skipped: 1, replaced: 2, failed: 0, deleted: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await refreshDocumentation([
      "https://docs.example.com/a",
      "https://docs.example.com/b",
    ]);
    assert.deepEqual(result, { skipped: 1, replaced: 2, failed: 0, deleted: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].url, "/onboarding/documentation/refresh");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body ?? "{}"), {
    urls: ["https://docs.example.com/a", "https://docs.example.com/b"],
  });
});

test("selectRepository forwards source_type and documentation_config", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;
  setApiToken("test-token");
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body as string | undefined,
    });
    return new Response(JSON.stringify({ state: "REPOSITORY_SELECTED", repository: "docs.example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await selectRepository({
      full_name: "docs.example.com",
      source_type: "public_documentation",
      documentation_config: {
        root_url: "https://docs.example.com",
        include_paths: ["docs/**"],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body ?? "{}"), {
    full_name: "docs.example.com",
    source_type: "public_documentation",
    documentation_config: { root_url: "https://docs.example.com", include_paths: ["docs/**"] },
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test tests/onboarding-api.test.ts`
Expected: FAIL — `refreshDocumentation is not a function` (not exported yet)

- [ ] **Step 3: Add the API function + type import**

In `draftly-agent-ui/api/onboarding.ts`:
- Add `RefreshResult` to the existing `import type { ... } from "@/lib/onboarding/types"` block.
- Append:

```ts
export async function refreshDocumentation(
  urls: string[],
): Promise<RefreshResult> {
  return request("/onboarding/documentation/refresh", {
    method: "POST",
    body: JSON.stringify({ urls }),
  });
}
```

(`selectRepository` needs no change — it already sends `JSON.stringify(payload)`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test tests/onboarding-api.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git -C draftly-agent-ui add api/onboarding.ts tests/onboarding-api.test.ts
git -C draftly-agent-ui commit -m "feat(onboarding): add documentation refresh API and source payload passthrough"
```

---

### Task 3: Repository step — source-mode choice with public-docs form

**Files:**
- Create: `draftly-agent-ui/components/onboarding/public-docs-source.tsx`
- Modify: `draftly-agent-ui/app/(onboarding)/onboarding/repository/page.tsx`

**Interfaces:**
- Consumes: `PublicDocsDraft` + `buildRepositoryPayload` (Task 1); `validatePublicDocsRootUrl`/`parsePathList` (Task 1); `RepositoryPicker` (existing); `selectRepository` (existing); `useStepDraft("repository", ...)`; `useAsyncAction`.
- Produces: `PublicDocsSource({ formRef?, onSubmit })` — a form mirroring `WorkspaceForm`: footer `Next` triggers `formRef.current?.requestSubmit()`; on submit it validates, parses include/exclude text into `PublicDocsDraft`, and calls `onSubmit(draft)`.

- [ ] **Step 1: Create `public-docs-source.tsx`**

Mirror `WorkspaceForm` styling (label/input recipes copied verbatim below):

```tsx
"use client";
import { useState } from "react";
import { Globe } from "lucide-react";
import { useStepDraft } from "@/lib/onboarding/use-draft";
import type { PublicDocsDraft } from "@/lib/onboarding/source-model";
import { parsePathList, validatePublicDocsRootUrl } from "@/lib/onboarding/validation";

interface Props {
  onSubmit: (draft: PublicDocsDraft) => void;
  formRef?: React.Ref<HTMLFormElement>;
}

const formLabel = "mb-[9px] mt-[22px] block text-[13px] font-bold text-[#101a43]";
const inputRecipe =
  "w-full border-0 bg-transparent text-[13px] outline-0 placeholder:text-[#8a97b0]";
const boxRecipe =
  "flex flex-col items-stretch gap-2.5 rounded-lg border border-[#cdd8ea] px-[13px] py-[11px] text-[#657494] focus-within:border-brand";

const emptyDraft: PublicDocsDraft = {
  rootUrl: "",
  includePaths: [],
  excludePaths: [],
  crawlInstructions: "",
};

export function PublicDocsSource({ onSubmit, formRef }: Props) {
  const [draft, setDraft] = useStepDraft<PublicDocsDraft>("repository", emptyDraft);
  const [includeText, setIncludeText] = useState(draft.includePaths.join("\n"));
  const [excludeText, setExcludeText] = useState(draft.excludePaths.join("\n"));
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validatePublicDocsRootUrl(draft.rootUrl);
    if (err) {
      setError(err);
      return;
    }
    onSubmit({
      ...draft,
      includePaths: parsePathList(includeText),
      excludePaths: parsePathList(excludeText),
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="max-w-[560px]">
      <label htmlFor="public-docs-url" className={formLabel}>
        Documentation URL
      </label>
      <div className={boxRecipe}>
        <input
          id="public-docs-url"
          type="text"
          value={draft.rootUrl}
          onChange={(e) => setDraft({ ...draft, rootUrl: e.target.value })}
          placeholder="https://docs.example.com"
          aria-invalid={!!error}
          aria-describedby={error ? "public-docs-url-error" : undefined}
          className={inputRecipe}
        />
      </div>
      {error && (
        <p id="public-docs-url-error" aria-live="polite" className="mt-1.5 text-xs text-red-500">
          {error}
        </p>
      )}

      <label htmlFor="include-paths" className={formLabel}>
        Include paths <span className="font-normal text-[#71809b]">(optional, one per line)</span>
      </label>
      <div className={boxRecipe}>
        <textarea
          id="include-paths"
          value={includeText}
          onChange={(e) => setIncludeText(e.target.value)}
          rows={3}
          placeholder={"docs/**\nreference/**"}
          className={inputRecipe}
        />
      </div>

      <label htmlFor="exclude-paths" className={formLabel}>
        Exclude paths <span className="font-normal text-[#71809b]">(optional, one per line)</span>
      </label>
      <div className={boxRecipe}>
        <textarea
          id="exclude-paths"
          value={excludeText}
          onChange={(e) => setExcludeText(e.target.value)}
          rows={3}
          placeholder={"docs/archived/**"}
          className={inputRecipe}
        />
      </div>

      <label htmlFor="crawl-instructions" className={formLabel}>
        Crawl instructions <span className="font-normal text-[#71809b]">(optional)</span>
      </label>
      <div className={boxRecipe}>
        <textarea
          id="crawl-instructions"
          value={draft.crawlInstructions}
          onChange={(e) => setDraft({ ...draft, crawlInstructions: e.target.value })}
          rows={2}
          placeholder="Focus on API reference pages first"
          className={inputRecipe}
        />
      </div>

      <p className="mt-[18px] flex items-center gap-2 text-xs leading-[1.5] text-[#53648e]">
        <Globe size={15} className="text-brand" />
        Draftly crawls public pages only. Private repositories are never sent to Tavily.
      </p>
    </form>
  );
}
```

- [ ] **Step 2: Rewrite the repository page to add the mode toggle**

Replace the body of `draftly-agent-ui/app/(onboarding)/onboarding/repository/page.tsx` so it:

- Adds `SourceMode = "github" | "public"` state (default `"github"`).
- Renders a two-button segmented toggle above the grid (both keep the GitHub "What Draftly will access" side card; swap the copy rows by mode).
- GitHub mode: footer `Next` calls `handleGitHubNext` (unchanged logic); `isNextDisabled={!selected}`.
- Public mode: renders `PublicDocsSource`; footer `Next` calls `publicFormRef.current?.requestSubmit()`; on submit → `selectRepository(buildRepositoryPayload(draft))` → `router.push("/onboarding/documentation")`.

```tsx
"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, GitPullRequest, Globe, Layers, ShieldCheck, Tag } from "lucide-react";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { RepositoryPicker } from "@/components/onboarding/repository-picker";
import { PublicDocsSource } from "@/components/onboarding/public-docs-source";
import { ErrorBanner } from "@/components/onboarding/error-banner";
import { InfoRow, cardBase, tileBubble } from "@/components/onboarding/design/info-row";
import { selectRepository } from "@/api/onboarding";
import { useAsyncAction } from "@/lib/onboarding/use-async-action";
import { useStepGuard } from "@/lib/onboarding/use-step-guard";
import {
  buildRepositoryPayload,
  type PublicDocsDraft,
} from "@/lib/onboarding/source-model";
import { cn } from "@/lib/utils";

type SourceMode = "github" | "public";

const modeButton =
  "inline-flex items-center gap-2 rounded-lg border border-[#cdd8ea] bg-white px-[14px] py-[9px] text-[13px] font-semibold text-[#465574] transition-colors";

export default function RepositoryPage() {
  useStepGuard("repository");
  const router = useRouter();
  const [mode, setMode] = useState<SourceMode>("github");
  const [selected, setSelected] = useState<string | null>(null);
  const publicFormRef = useRef<HTMLFormElement>(null);
  const { run, loading, error, clearError } = useAsyncAction();

  async function handleGitHubNext() {
    if (!selected) return;
    const ok = await run(() => selectRepository({ full_name: selected }));
    if (ok) router.push("/onboarding/documentation");
  }

  async function handlePublicNext(draft: PublicDocsDraft) {
    const ok = await run(() => selectRepository(buildRepositoryPayload(draft)));
    if (ok) router.push("/onboarding/documentation");
  }

  function handleNext() {
    if (mode === "github") void handleGitHubNext();
    else publicFormRef.current?.requestSubmit();
  }

  const accessRow = "py-[7px]";

  return (
    <OnboardingShell
      currentStep="repository"
      onNext={handleNext}
      isNextDisabled={mode === "github" ? !selected : false}
      isNextLoading={loading}
    >
      <h1 className="mb-[11px] mt-8 text-[32px] font-extrabold leading-[1.2] tracking-[-1.2px] text-[#101a43]">
        Choose a documentation source
      </h1>
      <p className="text-[15px] leading-[1.55] text-[#53648e]">
        Select a GitHub repository Draftly monitors, or point Draftly at
        <br /> public documentation to keep in sync.
      </p>
      {error && <div className="mt-4"><ErrorBanner message={error} onDismiss={clearError} /></div>}

      <div className="mb-6 flex gap-2.5">
        <button
          type="button"
          onClick={() => setMode("github")}
          aria-pressed={mode === "github"}
          className={cn(modeButton, mode === "github" && "border-brand bg-[#f5f8ff] text-brand")}
        >
          <GitPullRequest size={16} /> GitHub repository
        </button>
        <button
          type="button"
          onClick={() => setMode("public")}
          aria-pressed={mode === "public"}
          className={cn(modeButton, mode === "public" && "border-brand bg-[#f5f8ff] text-brand")}
        >
          <Globe size={16} /> Public documentation
        </button>
      </div>

      <div className="mb-8 grid grid-cols-[minmax(0,1fr)_280px] gap-[35px] max-[900px]:grid-cols-1">
        {mode === "github" ? (
          <RepositoryPicker onSelect={setSelected} selected={selected} />
        ) : (
          <PublicDocsSource formRef={publicFormRef} onSubmit={handlePublicNext} />
        )}
        <div className={`${cardBase} px-5 py-[22px] max-[900px]:order-2`}>
          <h3 className="mb-2 text-base text-[#101a43]">What Draftly will access</h3>
          {mode === "github" ? (
            <>
              <InfoRow className={accessRow} bubbleClassName={tileBubble} icon={<GitPullRequest size={17} />} title="Issues & pull requests" text="To understand changes" />
              <InfoRow className={`${accessRow} border-t border-[#e6ebf3]`} bubbleClassName={tileBubble} icon={<Layers size={17} />} title="Commits & code" text="To detect documentation drift" />
              <InfoRow className={`${accessRow} border-t border-[#e6ebf3]`} bubbleClassName={tileBubble} icon={<Tag size={17} />} title="Releases" text="To track product evolution" />
              <InfoRow className={`${accessRow} border-t border-[#e6ebf3]`} bubbleClassName={tileBubble} icon={<FileText size={17} />} title="Documentation files" text="To analyze and improve" />
            </>
          ) : (
            <>
              <InfoRow className={accessRow} bubbleClassName={tileBubble} icon={<Globe size={17} />} title="Public documentation" text="URLs Draftly will crawl" />
              <InfoRow className={`${accessRow} border-t border-[#e6ebf3]`} bubbleClassName={tileBubble} icon={<FileText size={17} />} title="Canonical pages" text="Discovered and indexed via Tavily" />
              <InfoRow className={`${accessRow} border-t border-[#e6ebf3]`} bubbleClassName={tileBubble} icon={<ShieldCheck size={17} />} title="No GitHub installation" text="Public pages only, read-only" />
            </>
          )}
          <div className="rounded-[9px] bg-[#f0f5ff] p-[15px] text-xs leading-[1.5] text-[#263a6f]">
            <ShieldCheck size={20} className="float-left mr-2.5 box-content rounded-lg bg-[#dce8fd] p-1.5 text-brand" />
            <b>Read-only access</b>
            <p className="mt-1.5 text-[11px] text-[#50618a]">
              Draftly never writes to your sources or repositories.
            </p>
          </div>
        </div>
      </div>
    </OnboardingShell>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run lint` (script is `tsc --noEmit`)
Expected: no errors

- [ ] **Step 4: Verify test suite still passes**

Run: `npm test`
Expected: PASS (all tests including `tests/onboarding-source-model.test.ts` and `tests/onboarding-api.test.ts`)

- [ ] **Step 5: Commit**

```bash
git -C draftly-agent-ui add components/onboarding/public-docs-source.tsx "app/(onboarding)/onboarding/repository/page.tsx"
git -C draftly-agent-ui commit -m "feat(onboarding): add public documentation source mode to repository step"
```

---

### Task 4: Documentation step — URL candidates and sync action

**Files:**
- Modify: `draftly-agent-ui/components/onboarding/documentation-sources.tsx`
- Modify: `draftly-agent-ui/app/(onboarding)/onboarding/documentation/page.tsx`

**Interfaces:**
- Consumes: `getOnboardingStatus`, `refreshDocumentation` (Task 2), `isPublicDocumentation`/`candidateLabel` (Task 1), `ApiError` from `@/api/client`, `DesignButton`, `AlertTriangle`/`RefreshCw` lucide icons.
- Produces: mode-aware candidate rendering + a `RefreshResult` summary block; `documentation/page.tsx` copy is neutralized (no longer claims a repository was scanned).

- [ ] **Step 1: Modify `documentation-sources.tsx`**

Replace the current component body:

```tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import { discoverDocumentation, getOnboardingStatus, refreshDocumentation } from "@/api/onboarding";
import { ApiError } from "@/api/client";
import { AlertTriangle, BookOpen, Braces, FileText, History, RefreshCw, ShieldCheck, SquareCode } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStepDraft } from "@/lib/onboarding/use-draft";
import { InfoRow, cardBase, tileBubble } from "@/components/onboarding/design/info-row";
import { DesignButton } from "@/components/onboarding/design/button";
import { candidateLabel, isPublicDocumentation } from "@/lib/onboarding/source-model";
import type { DiscoveryResult, RefreshResult } from "@/lib/onboarding/types";

interface Props {
  onConfirm: (include: string[], exclude: string[]) => void;
  loading?: boolean;
}

const formLabel = "mb-[9px] mt-[22px] block text-[13px] font-bold text-[#101a43]";

export function DocumentationSources({ onConfirm, loading = false }: Props) {
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [publicSource, setPublicSource] = useState(false);
  const [excludedList, setExcludedList] = useStepDraft<string[]>("documentation", []);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<RefreshResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const excluded = useMemo(() => new Set(excludedList), [excludedList]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getOnboardingStatus().catch(() => null),
      discoverDocumentation(),
    ])
      .then(([status, result]) => {
        if (cancelled) return;
        setPublicSource(isPublicDocumentation(status?.selected_repository?.source_type as string | undefined));
        setDiscovery(result);
      })
      .catch(() => setDiscovery(null))
      .finally(() => setDiscoveryLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSync() {
    if (!discovery) return;
    setSyncLoading(true);
    setSyncError(null);
    try {
      setSyncResult(await refreshDocumentation(discovery.candidates));
    } catch (e) {
      setSyncError(e instanceof ApiError ? e.message : "Documentation sync failed.");
    } finally {
      setSyncLoading(false);
    }
  }

  if (discoveryLoading)
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-[#53648e]">
        <span className="size-4 animate-spin rounded-full border-2 border-dotted border-[#814ef0]" />
        Discovering documentation...
      </div>
    );
  if (!discovery)
    return <p className="py-8 text-sm text-red-500">Failed to discover documentation.</p>;

  function toggle(path: string) {
    setExcludedList(
      excludedList.includes(path)
        ? excludedList.filter((p) => p !== path)
        : [...excludedList, path],
    );
  }

  const include = discovery.candidates.filter((p) => !excluded.has(p));
  const exclude = [...excluded];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-[35px] max-[900px]:grid-cols-1">
      <div>
        <label className={formLabel}>
          {publicSource ? "Documentation site" : "Documentation directory (recommended)"}{""}
          <span className="ml-1 font-normal text-[#71809b]">ⓘ</span>
        </label>
        <div className="flex items-center justify-between gap-2.5 rounded-lg border border-[#cdd8ea] px-[13px] py-[11px] text-[#657494]">
          {publicSource ? "Public documentation URLs" : "docs/"} <FileText size={18} />
        </div>
        <label className={formLabel}>
          Include in scan{" "}
          <span className="text-[11px] font-medium text-[#32ae70]">{discovery.count} found</span>
        </label>
        <div className="max-h-72 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1 max-[560px]:grid-cols-1">
            {discovery.candidates.map((path) => {
              const checked = !excluded.has(path);
              return (
                <button
                  key={path}
                  type="button"
                  aria-pressed={!excluded.has(path)}
                  aria-label={`${!excluded.has(path) ? "Exclude" : "Include"} ${path}`}
                  onClick={() => toggle(path)}
                  className={cn(
                    "rounded-[9px] border border-[#d9e1f0] bg-white p-[13px] text-left",
                    checked && "border-[#a9c3ff] bg-[#f4f7ff]",
                  )}>
                  <span
                    className={cn(
                      "float-left mr-2 grid size-[15px] place-items-center rounded-[3px] border border-[#b7c5da]",
                      checked && "border-brand bg-brand text-white",
                    )}>
                    {checked && (
                      <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M2.5 6.5l2.5 2.5L9.5 4" />
                      </svg>
                    )}
                  </span>
                  <b className="flex items-center gap-[7px] text-xs text-[#101a43]">
                    <i className="inline-flex shrink-0 not-italic text-brand">
                      <FileText size={15} />
                    </i>
                    {candidateLabel(path)}
                  </b>
                  <small className="mt-1.5 flex items-center gap-1.5 text-xs break-all text-[#53648e]">
                    {path}
                  </small>
                </button>
              );
            })}
          </div>
        </div>

        {publicSource && (
          <div className="mt-[22px]">
            <div className="flex flex-wrap items-center gap-3">
              <DesignButton primary onClick={handleSync} disabled={syncLoading}>
                {syncLoading ? "Syncing…" : "Sync documentation"} <RefreshCw size={16} />
              </DesignButton>
              {syncResult && (
                <span className="text-xs text-[#50618a]">
                  {syncResult.skipped} skipped · {syncResult.replaced} replaced ·{" "}
                  {syncResult.failed} failed · {syncResult.deleted} deleted
                </span>
              )}
            </div>
            {syncError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
                <AlertTriangle size={13} /> {syncError}
              </p>
            )}
          </div>
        )}

        <DesignButton
          primary
          className="mt-[22px]"
          disabled={loading}
          onClick={() => onConfirm(include, exclude)}>
          Confirm sources
        </DesignButton>
      </div>
      <div className={`${cardBase} px-5 py-[22px] max-[900px]:order-2`}>
        <h3 className="mb-2 text-base text-[#101a43]">What we&apos;ll discover</h3>
        <InfoRow className="py-[7px]" bubbleClassName={tileBubble} icon={<FileText size={17} />} title="Documentation files" text="Markdown, guides, references" />
        <InfoRow className="border-t border-[#e6ebf3] py-[7px]" bubbleClassName={tileBubble} icon={<Braces size={17} />} title="API references" text="OpenAPI, endpoints, schemas" />
        <InfoRow className="border-t border-[#e6ebf3] py-[7px]" bubbleClassName={tileBubble} icon={<BookOpen size={17} />} title="Architecture docs" text="Diagrams, ADRs, design docs" />
        <InfoRow className="border-t border-[#e6ebf3] py-[7px]" bubbleClassName={tileBubble} icon={<SquareCode size={17} />} title="Examples & tutorials" text="Usage, code examples, how-tos" />
        <InfoRow className="border-t border-[#e6ebf3] py-[7px]" bubbleClassName={tileBubble} icon={<History size={17} />} title="Changelogs" text="Releases and version history" />
        <div className="rounded-[9px] bg-[#f0f5ff] p-[15px] text-xs leading-[1.5] text-[#263a6f]">
          <ShieldCheck size={20} className="float-left mr-2.5 box-content rounded-lg bg-[#dce8fd] p-1.5 text-brand" />
          <b>Safe & read-only</b>
          <p className="mt-1.5 text-[11px] text-[#50618a]">
            Draftly only reads content you&apos;ve authorized.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Neutralize the documentation page copy**

In `draftly-agent-ui/app/(onboarding)/onboarding/documentation/page.tsx`, change the subtitle from `Draftly scanned your repository and detected documentation\n<br /> files, directories, and knowledge sources.` to:

```tsx
      <p className="text-[15px] leading-[1.55] text-[#53648e]">
        We discovered the documentation sources you configured.
        <br />
        Review and confirm them, or run a sync to refresh.
      </p>
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run lint`
Expected: no errors

- [ ] **Step 4: Verify test suite still passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Manual sanity check**

Run: `npm run dev`, complete onboarding as a GitHub-mode user.
Expected: GitHub flow renders exactly as before (no `Sync documentation` button, file-path labels). Optionally repeat with a `public_documentation` root via the new toggle (URL candidates + sync button appear; sync returns the count summary).

- [ ] **Step 6: Commit**

```bash
git -C draftly-agent-ui add components/onboarding/documentation-sources.tsx "app/(onboarding)/onboarding/documentation/page.tsx"
git -C draftly-agent-ui commit -m "feat(onboarding): render URL candidates and add sync action in documentation step"
```

---

## Self-Review

**Spec coverage:**
- "Selected-repository payload gains `source_type`; public mode posts `PublicDocumentationConfig`" → Task 1 (types) + Task 3 (repository page builds it); selectRepository verified in Task 2.
- "Discovery route: Map → canonical URL candidates → user confirmation" → Task 4 displays URL candidates (`candidateLabel`, full-URL subtitle) and keeps the existing `confirmSources` confirmation.
- "Manual 'Sync documentation' action in Draftly" → Task 2 (endpoint) + Task 4 (button + result summary).
- Acceptance #2 ("discovered, confirmed, ingested, initialized through the same five visible stages") → Tasks 3–4 feed the unchanged init stages; no stage/step reordering (Global Constraints).
- Non-goal "frontend progress UI is untouched" → no initialize-page changes.

**Placeholder scan:** All steps carry concrete code; no TBDs.

**Type consistency:** `PublicDocsDraft` (Task 1) is the param of `PublicDocsSource.onSubmit` (Task 3) and `buildRepositoryPayload` (Task 1); `RefreshResult` is consumed by both `refreshDocumentation` (Task 2) and the sync block (Task 4); `candidateLabel` used in Task 4 matches Task 1's signature; `PublicDocumentationConfig`/`RepositoryPayload` names match the backend schema (`root_url`, `include_paths`, `exclude_paths`, `crawl_instructions`, `source_type`, `full_name`).