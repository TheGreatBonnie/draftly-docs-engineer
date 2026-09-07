# Onboarding Design Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace draftly-agent-frontend's onboarding visuals with the approved Tailwind design system while keeping route-per-step URLs, Clerk auth, and all API logic verbatim.

**Architecture:** Port the converted reference (`onboarding-flow-designs/draftly/app/tailwind/page.tsx`) into scoped `components/onboarding/design/*` primitives, re-render `OnboardingShell` as SideRail + panel chrome, then swap each step page's visual component one route at a time. `OnboardingShell`'s props API never changes, so callers only change their rendered subtree.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (`@theme` tokens), lucide-react, Clerk, clsx + tailwind-merge (new deps).

**Spec:** `docs/superpowers/specs/2026-08-24-onboarding-design-migration-design.md`

## Global Constraints

- No git repo at workspace root → **no commit steps**; each task ends with verification instead.
- **No test framework** in this project → each task verifies via: `pnpm exec tsc --noEmit` AND `pnpm exec eslint <changed-files>` AND (milestone tasks) `pnpm build`. Visual checks via screenshots against `http://localhost:3000/tailwind` reference.
- All work happens in `/Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-frontend/` (paths below relative to it).
- Design components are light-only: never add `dark:` variants inside `components/onboarding/design/`.
- Never modify: `lib/onboarding/constants.ts` STATE_TO_STEP semantics, any `api/*.ts` file, any page's handler/API call sequence.
- Brand hexes (exact): brand `#1260ed`, success `#40b879`, ink `#101a43`.
- Reference file for all visuals: `../onboarding-flow-designs/draftly/app/tailwind/page.tsx`.

---

### Task 1: Foundation — cn(), tokens, font

**Files:**
- Modify: `package.json` (add clsx, tailwind-merge)
- Create: `lib/utils.ts`
- Modify: `app/globals.css` (append @theme block)
- Modify: `app/layout.tsx` (font variable)

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` at `@/lib/utils`; CSS utilities `bg-brand text-brand border-brand ring-brand bg-success text-success bg-ink text-ink`; CSS var `--font-jakarta`.

- [ ] **Step 1: Install deps**

```bash
cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-frontend && pnpm add clsx tailwind-merge
```

(If pnpm workspace conflicts with package-lock.json, fall back to `npm install clsx tailwind-merge`.)

- [ ] **Step 2: Create `lib/utils.ts`**

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 3: Append tokens to `app/globals.css`** (after the imports, before `@custom-variant`)

```css
/* Draftly onboarding design tokens */
@theme {
  --color-brand: #1260ed;
  --color-success: #40b879;
  --color-ink: #101a43;
}
```

- [ ] **Step 4: Add font to `app/layout.tsx`**

```tsx
import { Plus_Jakarta_Sans } from "next/font/google";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
});
```

and change `<body>` to `<body className={jakarta.variable}>` (variable only — do NOT set it as the global font).

- [ ] **Step 5: Verify**

```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: both clean.

---

### Task 2: Design primitives

**Files:**
- Create: `components/onboarding/design/brand-mark.tsx`
- Create: `components/onboarding/design/glyphs.tsx`
- Create: `components/onboarding/design/button.tsx`
- Create: `components/onboarding/design/info-row.tsx`

**Interfaces:**
- Produces:
  - `BrandMark({ size?: number })`
  - `GithubIcon({ size?: number; className?: string })`, `SlackGlyph({ size?: number })`, `DiscordGlyph({ size?: number })`
  - `DesignButton({ children, primary?, onClick?, className?, disabled?, type? }: { children: React.ReactNode; primary?: boolean; onClick?: () => void; className?: string; disabled?: boolean; type?: "button" | "submit" })`
  - `InfoRow({ icon, title, text, tone?: "blue"|"green"|"purple", className?, bubbleClassName? })`

- [ ] **Step 1: Port SVG components** — copy `BrandMark`, `GithubIcon` (with added optional `className` param merged onto `<svg className={className}`), `SlackGlyph`, `DiscordGlyph` verbatim from reference file lines 76–232 into the two glyph files ("use client" not required — pure SVG).
- [ ] **Step 2: Create button.tsx**

```tsx
import { cn } from "@/lib/utils";

const btnBase =
  "flex items-center gap-[11px] rounded-[7px] border border-[#d9e1f0] bg-white px-[15px] py-[10px] text-[13px] font-semibold text-[#101a43]";

export function DesignButton({
  children,
  primary = false,
  onClick,
  className = "",
  disabled = false,
  type = "button",
}: {
  children: React.ReactNode;
  primary?: boolean;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        btnBase,
        primary && "border-brand bg-brand text-white shadow-[0_4px_9px_#1260ed26]",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}>
      {children}
    </button>
  );
}
```

- [ ] **Step 3: Create info-row.tsx** — port InfoRow + recipes (`introRow`, `sideBubble`, `tileBubble`) from reference (search `function InfoRow` and `const introRow`). Export all four.
- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit && pnpm exec eslint components/onboarding/design/` clean.

---

### Task 3: Step map + chrome components

**Files:**
- Create: `lib/onboarding/design-steps.ts`
- Create: `components/onboarding/design/progress-stepper.tsx`
- Create: `components/onboarding/design/side-rail.tsx`
- Create: `components/onboarding/design/footer-bar.tsx`
- Create: `components/onboarding/design/orbit.tsx`

**Interfaces:**
- Consumes: `cn`, glyphs, `Check`/`ArrowRight` from lucide.
- Produces:
  - `DESIGN_STEPS: { slug: string; label: string; subByStep… }` — see Step 1.
  - `ProgressStepper({ currentSlug }: { currentSlug: string })`
  - `SideRail({ currentSlug }: { currentSlug: string })` — nav via `useRouter().push("/onboarding/" + slug)`
  - `FooterBar({ onBack?, onNext?, isNextLoading?, isNextDisabled?, nextLabel? = "Continue", sticky? = true })`
  - `Orbit()` — GitHub orbit illustration, self-contained.

- [ ] **Step 1: `design-steps.ts`** — slug/index/label/subtitle tables:

```ts
export const DESIGN_STEP_ORDER = [
  "welcome", "workspace", "github", "repository",
  "documentation", "integrations", "preferences", "initialize",
] as const;
export type DesignSlug = (typeof DESIGN_STEP_ORDER)[number];
export const DESIGN_STEP_NUMBER: Record<DesignSlug, number> = {
  welcome: 1, workspace: 2, github: 3, repository: 4,
  documentation: 5, integrations: 6, preferences: 7, initialize: 8,
};
export const DESIGN_STEP_LABELS: Record<DesignSlug, string> = {
  welcome: "Welcome", workspace: "Workspace", github: "Connect GitHub",
  repository: "Select Repository", documentation: "Discover Docs",
  integrations: "Connect Sources", preferences: "Configure Draftly",
  initialize: "Review & Finish",
};
```

- [ ] **Step 2: Port Progress → `ProgressStepper`** from reference `function Progress`: same stepper markup/classes (node states, connectors, labels); props `{ currentSlug }`; compute `step = DESIGN_STEP_NUMBER[currentSlug]`; render total "Step {n} of 8"; drop `compactLabel` (always default size); keep `max-[900px]:` responsive classes.
- [ ] **Step 3: Port SideRail** from reference `function SideRail`: replace `setStep(i + 1)` with `router.push("/onboarding/" + DESIGN_STEP_ORDER[i])`; `currentSlug` drives selected/done states (`DESIGN_STEP_NUMBER[currentSlug]`); keep railSubs/note logic verbatim; hide on `max-[900px]:hidden` stays.
- [ ] **Step 4: FooterBar** — sticky Back/Continue pair from any reference step footer:

```tsx
export function FooterBar({
  onBack, onNext, isNextLoading, isNextDisabled,
  nextLabel = "Continue", sticky = true,
}: {
  onBack?: () => void; onNext?: () => void;
  isNextLoading?: boolean; isNextDisabled?: boolean;
  nextLabel?: string; sticky?: boolean;
}) {
  return (
    <div className={cn(
      "z-[2] mt-[14px] flex items-center justify-between border-t border-[#e2e8f1] bg-white pt-[14px]",
      sticky && "sticky bottom-0",
    )}>
      {onBack ? (
        <DesignButton onClick={onBack}><ArrowLeft size={17} /> Back</DesignButton>
      ) : <span />}
      <DesignButton primary onClick={onNext} disabled={isNextDisabled || isNextLoading}>
        {isNextLoading ? "Working…" : nextLabel}
        {!isNextLoading && <ArrowRight size={18} />}
      </DesignButton>
    </div>
  );
}
```

- [ ] **Step 5: Orbit** — port the GithubStep orbit block (container with `before:` ring, 4 satellite chips, center BrandMark disc, 4 sparkle svgs) from reference `function GithubStep` into `Orbit()`.
- [ ] **Step 6: Verify** — tsc + eslint clean.

---

### Task 4: Shell swap (OnboardingShell internals)

**Files:**
- Modify: `components/onboarding/onboarding-shell.tsx` (keep Props interface byte-identical)
- Modify: `"app/(onboarding)/onboarding/layout.tsx"` (light wrapper + font scope)

**Interfaces:**
- Consumes: SideRail, ProgressStepper, FooterBar, DESIGN_STEP_NUMBER.
- Produces: unchanged `OnboardingShell` props; children area is now left-aligned wide panel content.

- [ ] **Step 1: Rewrite shell render tree**

```tsx
<div className="flex min-h-screen bg-[#f4f7fc] font-[family-name:var(--font-jakarta)]">
  <SideRail currentSlug={currentStep} />
  <div className="flex min-w-0 flex-1 flex-col p-3 max-[900px]:p-0">
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-l-0 border-[#e1e7f0] bg-white px-[38px] pb-[22px] pt-[34px] shadow-[0_5px_22px_#cbd5e633] max-[900px]:rounded-none max-[900px]:border">
      <ProgressStepper currentSlug={currentStep} />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      <OnboardingFooter currentStep={currentStep} onNext={onNext} onBack={onBack}
        onSkip={onSkip} isNextDisabled={isNextDisabled} isNextLoading={isNextLoading} showSkip={showSkip} />
    </div>
  </div>
</div>
```

Note: `currentStep` (an `OnboardingStep` slug) is passed straight to SideRail/Stepper — slugs match `DesignSlug` except `complete` (never routed through shell).

- [ ] **Step 2: Restyle OnboardingFooter in place** (same file) to wrap FooterBar behavior: Back hidden when `currentStep === "workspace"`, Skip renders ghost DesignButton when `showSkip`, Next honors loading/disabled. Keep exported name/signature.
- [ ] **Step 3: Verify** — run dev server; open `/onboarding/workspace`: SideRail visible, stepper shows "Step 2 of 8", old slate content readable inside new panel. tsc/eslint/build clean.

---

### Task 5: Welcome route (new)

**Files:**
- Create: `"app/(onboarding)/onboarding/welcome/page.tsx"`
- Modify: `app/(onboarding)/onboarding/page.tsx` (entry: allow landing on welcome when state NOT_STARTED — optional, default remains workspace)

**Interfaces:**
- Produces: route `/onboarding/welcome`; "Get started" → `router.push("/onboarding/workspace")`.

- [ ] **Step 1: Port Welcome split-screen** from reference `function Welcome` (brand panel, pill, gradient h1, feature list, illustration tiles/card, help bar, intro card, actions row). Client component; `Get started` button calls `router.push("/onboarding/workspace")`; "Contact support" is a non-op button. Wrap in `OnboardingShell currentStep="welcome"` WITHOUT FooterBar usage — actually render standalone (full-bleed, no shell chrome) exactly like reference step 1: root `<main className="flex h-dvh overflow-hidden p-3">` containing the two-panel layout; Progress embedded as in reference (`<Progress step={1}>` equivalent → `<ProgressStepper currentSlug="welcome" />` with `mt-[41px] mb-[25px] w-full max-w-none` wrapper classes).
- [ ] **Step 2: Entry redirect (optional flag)** — leave default redirect untouched unless testing shows users need welcome; document decision in PR description.
- [ ] **Step 3: Verify** — visit `/onboarding/welcome` signed-in; compare vs `http://localhost:3000/tailwind` at 1440×900. tsc/build clean.

---

### Task 6: Workspace step

**Files:**
- Modify: `components/onboarding/workspace-form.tsx` (restyle only; Props unchanged: `onSubmit(name, description)`, `initialName?`, `initialDescription?`)
- Modify: `"app/(onboarding)/onboarding/workspace/page.tsx"` (heading styles only; handler untouched)

- [ ] **Step 1: Restyle form** to design Workspace recipe: label `mb-[9px] mt-[22px] block text-[13px] font-bold` (+ `small` variant `font-normal text-[#53648e]`); input wrapper `flex flex-col items-stretch gap-2.5 rounded-lg border border-[#cdd8ea] px-[13px] py-[11px] text-[#657494]` with inner input `w-full border-0 bg-transparent text-[13px] outline-0`; textarea `min-h-[80px] w-full resize-y rounded-lg border border-[#cdd8ea] px-[13px] py-[11px] text-[13px] text-[#101a43] outline-none focus:border-brand`; hints `mt-2 text-[11px] text-[#53648e]`; error line `text-[11px] text-red-500`. Keep validation + submit flow identical. Wrap form region in `max-w-[560px]`.
- [ ] **Step 2: Page heading** — h2 becomes design h1 style: `text-[32px] font-extrabold leading-[1.2] tracking-[-1.2px]`; subtitle uses `text-[15px] leading-[1.55] text-[#53648e]`. Add right-hand `cardBase` side card ("What is a workspace?" with 3 InfoRows, `sideBubble` recipe) in `grid grid-cols-[minmax(0,1fr)_280px] gap-[35px] max-[900px]:grid-cols-1` matching reference Workspace layout.
- [ ] **Step 3: Verify** — submit flows to `/onboarding/github`; screenshot parity check.

---

### Task 7: GitHub step

**Files:**
- Modify: `components/onboarding/github-connect.tsx` (restyle; logic untouched)
- Modify: `"app/(onboarding)/onboarding/github/page.tsx"` (centered layout + Orbit)

- [ ] **Step 1: Page layout** — adopt reference GithubStep composition: centered column `mx-auto flex w-full max-w-[900px] flex-1 flex-col justify-center pb-1 pt-1 text-center`; service icon tile `mx-auto grid size-[clamp(46px,6.2vh,58px)] place-items-center rounded-xl border border-[#d9e1f0] bg-white shadow-[0_4px_12px_#8798b51c]` containing `<GithubIcon className="size-[clamp(24px,3.2vh,30px)]" />`; clamp-based h1/p classes from reference.
- [ ] **Step 2: Card** — grid card from reference GithubStep (`grid-cols-[1fr_1fr] … gap-x-[clamp(18px,2.8vw,32px)] gap-y-[clamp(10px,1.6vh,22px)] px-[clamp(26px,5vw,58px)] … shadow-[0_7px_20px_#8193b51a] max-[900px]:grid-cols-1`): left cell `<Orbit />`, right cell benefits (3 InfoRows `py-[clamp(6px,1.35vh,13px)]` + bubble `size-[clamp(34px,4.6vh,43px)]`), spanning dark connect button `col-span-full mx-auto mt-[clamp(4px,1vh,10px)] flex w-[min(300px,100%)] items-center justify-center gap-2.5 rounded-lg bg-[#17191f] px-6 py-[clamp(10px,1.5vh,14px)] text-[clamp(13px,1.75vh,16px)] font-bold text-white` labeled per connection state, plus small print row `col-span-full mt-[2px] flex items-center justify-center gap-2 text-[clamp(11px,1.5vh,13px)] text-[#647397]`.
- [ ] **Step 3: Wire existing states** — loading spinner text, connected confirmation, and installation-linking effect stay exactly as-is; only classNames/markup change. Connect button opens `installUrl` when present, else shows connected state.
- [ ] **Step 4: Verify** — with backend running, connect flow still records GITHUB_CONNECTED; visual parity vs `/tailwind` step 3.

---

### Task 8: Repository step

**Files:**
- Modify: `components/onboarding/repository-picker.tsx` (restyle; Props unchanged: `onSelect(fullName)`, `selected`)
- Modify: `"app/(onboarding)/onboarding/repository/page.tsx"` (heading + side card)

- [ ] **Step 1: List styling** — search row `mb-[18px] mt-[31px] flex gap-3.5 max-[560px]:flex-col`; input recipe from Task 6 horizontal variant `flex flex-1 items-center gap-2.5 …`; repo rows `mb-[9px] flex w-full items-center gap-[15px] rounded-xl border border-[#e0e6f0] bg-white p-[17px] text-left` with chosen state `border-brand bg-[#f5f8ff] shadow-[0_0_0_1px_#1260ed33]`; radio circle `grid size-5 shrink-0 place-items-center rounded-full border border-[#bccae0]` + inner dot `size-[9px] rounded-full bg-brand` when selected; meta pills `inline-flex items-center gap-1.5 rounded-md bg-[#f1f4f8] px-[9px] py-1 text-[#465574]`; stats `flex gap-10 text-[11px] text-[#50618a] max-[900px]:hidden`.
- [ ] **Step 2: Real data mapping** — API returns `{ full_name: string; id: number }[]`. Render `owner / name` by splitting `full_name` on `"/"`; derive language pill only if data exists (omit otherwise); omit star/fork counts if absent — show `default_branch` pill when provided. Do NOT fabricate mock stats.
- [ ] **Step 3: Side card** — "What Draftly will access": 5 tile InfoRows + read-only soft box `rounded-[9px] bg-[#f0f5ff] p-[15px] text-xs leading-[1.5] text-[#263a6f]` with chip icon `float-left mr-2.5 box-content rounded-lg bg-[#dce8fd] p-1.5 text-brand`, in the 280px column (`max-[900px]:order-2`).
- [ ] **Step 4: Verify** — select persists via `selected` prop; Continue still calls `selectRepository`; empty/error/loading states styled minimally (`py-8 text-center text-sm text-[#53648e]`).

---

### Task 9: Documentation discovery step

**Files:**
- Modify: `components/onboarding/documentation-sources.tsx` (restyle; Props unchanged: `onConfirm(include[], exclude[])`)
- Modify: `"app/(onboarding)/onboarding/documentation/page.tsx"` (heading + banner)

- [ ] **Step 1: Banner + config** — repo banner bar `mb-[27px] mt-[31px] flex items-center gap-[13px] rounded-[10px] border border-[#d9e1f0] px-5 py-[15px]` with black circle badge `grid size-11 shrink-0 place-items-center rounded-full bg-[#111] text-white`; path input `flex items-center justify-between gap-2.5 rounded-lg border border-[#cdd8ea] px-[13px] py-[11px] text-[#657494]`; include/exclude checkboxes become design check-grid buttons: `rounded-[9px] border border-[#d9e1f0] bg-white p-[13px] text-left` checked `border-[#a9c3ff] bg-[#f4f7ff]`, checkbox square `float-left mr-2 grid size-[15px] place-items-center rounded-[3px] border border-[#b7c5da]` checked `border-brand bg-brand text-white`, in `grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-1`. Labels `mb-[9px] mt-[22px] block text-[13px] font-bold` with badge span `text-[11px] font-medium text-[#32ae70]`.
- [ ] **Step 2: Map discovery result** — render discovered files list from `DiscoveryResult` inside the checked-state pattern (one toggle row per discovered group/file); include/exclude arrays feed `onConfirm` unchanged.
- [ ] **Step 3: Side card** — "What we'll discover": 5 tile InfoRows + soft box (same recipes as Task 8).
- [ ] **Step 4: Verify** — confirm still routes to integrations with correct payload.

---

### Task 10: Integrations step

**Files:**
- Modify: `components/onboarding/integration-picker.tsx` (restyle; Props unchanged: `onSubmit(slack, discord)`)
- Modify: `"app/(onboarding)/onboarding/integrations/page.tsx"` (heading + access bar)

- [ ] **Step 1: Source rows** — checkbox pairs become design source rows: `mb-[17px] flex items-center gap-4 rounded-[10px] border border-[#d9e1f0] p-[18px] max-[560px]:flex-wrap max-[560px]:items-start`; logo cell colors GitHub `text-[#111]`, Slack `text-[#ed4f76]` (SlackGlyph keeps own colors), Discord `text-[#5665ec]`; status pill `ml-2 rounded-[5px] px-2 py-[5px] text-[11px]` off `bg-[#eef1f5] text-[#465574]` on `bg-[#e8f8ef] text-[#169957]`; connect action uses DesignButton `border-[#b9d0fb] text-brand`.
- [ ] **Step 2: Access bar** — static "What Draftly can access" strip below grid: `mt-5 rounded-[10px] border border-[#d9e1f0] px-[17px] py-[15px] text-xs` with blue circle badge, `ml-auto inline-flex items-center gap-1.5 text-[#243258]` mode label, and `mt-3.5 grid grid-cols-5 gap-3.5 border-t border-[#e6ebf3] pt-[15px]` of icon+label items (`i` cell: `grid size-[30px] shrink-0 place-items-center rounded-full bg-[#f1f4f8] not-italic`).
- [ ] **Step 3: Side card** — purple "Why connect sources?" card: title `flex items-center gap-[7px] text-sm text-[#7042e9]`; purple soft box `rounded-[9px] border border-[#e7dcfb] bg-[#f7f3ff] p-[15px] …` with `b` in `text-[#3b56d8]` and chip icon `float-left mr-2.5 box-content size-[18px] rounded-lg bg-[#7042e9] p-1.5 text-white`.
- [ ] **Step 4: Verify** — toggles still produce `{ slack, discord }` payload; Continue → preferences.

---

### Task 11: Preferences step

**Files:**
- Modify: `components/onboarding/preferences-form.tsx` (restyle; Props unchanged: `onSubmit(reviewPolicy, autoPublish)`)
- Modify: `"app/(onboarding)/onboarding/preferences/page.tsx"` (heading)

- [ ] **Step 1: Choice grids** — review-policy radio group becomes design `choice-grid`: container `ml-[50px] grid grid-cols-3 gap-[13px] max-[900px]:ml-0 max-[900px]:grid-cols-1`; cards `min-h-[102px] rounded-[9px] border border-[#d9e1f0] bg-white p-[14px] text-left [@media(max-height:820px)]:min-h-[84px]` selected `border-brand bg-[#eef4ff] shadow-[0_0_0_1px_#1260ed44]`; head row `mb-2.5 flex items-center justify-between` with lead icon `grid place-items-center text-[#44507a]` + radio `grid shrink-0 place-items-center rounded-full border-[1.5px] border-[#b7c5da] size-4` (dot `size-[9px] rounded-full bg-brand opacity-0`, on: `opacity-100 border-brand`).
- [ ] **Step 2: Automation toggles** — autoPublish (plus any booleans) rendered as design automation grid: `overflow-hidden rounded-lg border border-[#d9e1f0] bg-white` cells `min-h-[69px] border-b border-r border-[#d9e1f0] bg-white p-3 text-left` with index-based `border-r-0`/`border-b-0` rules (`i % 3 === 2 → border-r-0`, `i >= 3 → border-b-0`); checkbox square `mr-1.5 inline-grid size-[15px] place-items-center rounded-[3px] border border-[#afbdd3]` on: `border-brand bg-brand text-white`.
- [ ] **Step 3: Value mapping preserved** — internal values `"always" | "risk" | "autopublish"` (whatever exists today) drive selection; `configurePreferences` payload unchanged. Section headers get colored icon chips: `grid size-[38px] place-items-center rounded-full p-2` purple `bg-[#f1eaff] text-[#7042e9]`, orange `bg-[#fef3e8] text-[#e8742a]`; header row `mb-1 mt-[27px] flex items-center gap-3 text-base`; explainer `mb-3 ml-[50px] text-xs text-[#53648e] max-[900px]:ml-0`.
- [ ] **Step 4: Verify** — submit payload identical; visual check of selected states.

---

### Task 12: Initialize + Complete steps

**Files:**
- Modify: `components/onboarding/initialization-progress.tsx` (task-list visual driven by `stage` prop + polling already in page)
- Modify: `components/onboarding/initialization-error.tsx` (restyle)
- Modify: `components/onboarding/onboarding-complete.tsx` (metrics screen; Props unchanged: `documentCount?`, `chunkCount?`)
- Modify: `"app/(onboarding)/onboarding/initialize/page.tsx"` and `"…/complete/page.tsx"` (layout wrappers only)

- [ ] **Step 1: Progress task list** — map live stage → design Initialize list: rows `relative grid grid-cols-[30px_1fr_auto_auto] items-center gap-x-3 gap-y-1.5 py-[11px] text-[13px] max-[560px]:grid-cols-[24px_1fr]`; done state `grid size-[22px] place-items-center rounded-full bg-success text-white` + Check; active `mx-auto size-[18px] rounded-full border-2 border-dotted border-[#814ef0]` with indeterminate bar row `col-start-2 col-end-[-1] mt-0.5 flex items-center gap-2.5` (track `relative block h-1.5 flex-1 overflow-hidden rounded-[4px] bg-[#e6ddff] not-italic` + animated fill `absolute inset-y-0 left-0 rounded-[4px] bg-[#814ef0] animate-pulse` — width indeterminate since backend gives stage names, not %); pending `size-3.5 rounded-full border border-[#bdcbe0]`. Status ems: ok `text-[#32a86d]`, prog `font-semibold text-[#7142ed]`, pend `text-[#8a97b0]`.
- [ ] **Step 2: Error restyle** — InitializationError becomes red soft-box `rounded-[9px] border border-red-200 bg-red-50 p-[15px] text-xs text-red-700` with retry DesignButton; retry handler untouched.
- [ ] **Step 3: Complete screen** — metrics row from reference Complete: centered `flex justify-center gap-2` tiles (`flex-1 rounded-[9px] p-2.5 text-left text-[10px] text-[#4a5a80]` + tinted backgrounds `#f1eaff/#eaf1ff/#fef3e8/#e7f8f0`, white icon chips, `b mb-[3px] block text-[17px] text-[#101a43]`); green check hero `inline-grid size-20 place-items-center rounded-full bg-[#e7f8f0] text-[#19a36d]` with `<CheckCircle2 size={44} />`; CTA DesignButton primary `min-w-[200px] justify-center px-[28px] py-[14px] text-[15px]` calling existing dashboard navigation. Feed `documentCount`/`chunkCount` into tiles; sources tile only if data available.
- [ ] **Step 4: Verify** — run initialize against backend: pending→active→done transitions reflect polled stages; failure path shows restyled error; completion lands on metrics screen and dashboard CTA works.

---

### Task 13: Final cross-cutting verification

- [ ] **Step 1:** `pnpm exec tsc --noEmit && pnpm exec eslint . && pnpm build` — all clean.
- [ ] **Step 2:** Screenshot sweep at 1440×900 and 900×700: `/onboarding/welcome`, `workspace`, `github`, `repository`, `documentation`, `integrations`, `preferences`, `initialize`, `complete` vs `/tailwind` reference steps 1–9. Log deviations >4px.
- [ ] **Step 3:** Dark-mode spot check: enable `.dark` on html — onboarding stays light, dashboard unaffected.
- [ ] **Step 4:** Resume check: mid-onboarding refresh redirects to correct step via STATE_TO_STEP (URLs unchanged).

## Self-Review

- **Spec coverage:** Foundation ✓(T1) chrome ✓(T3–4) all 9 routes ✓(T5–12) deviations honored (flow scroll T4, real data T8/T12, polling T12) verification ✓(per task + T13). Welcome-route entry-redirect flagged optional in T5 ✓ matches spec wording.
- **Placeholder scan:** none — every restyle cites exact class strings or named reference anchors; ambiguous data cases have explicit rules (T8 Step 2, T12 Step 1).
- **Type consistency:** `DesignSlug`/`DESIGN_STEP_NUMBER` defined T3, consumed T4/T5; `DesignButton` signature fixed T2, reused everywhere; shell props untouched per spec.
