# Preferences Form Design Alignment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `PreferencesForm` and `PreferencesPage` components in line with the design mockup's `Configure` component (step 7).

**Architecture:** Expand the preferences form to include all three sections (Documentation Style, Review Policy, Automation), add a right sidebar with contextual info, and update the data model/API to carry the new fields.

**Tech Stack:** React, Next.js, Tailwind CSS, lucide-react icons, existing `useStepDraft` hook for localStorage persistence.

**Spec:** The design mockup is in `onboarding-flow-designs/draftly/app/tailwind/page.tsx` lines 1547-1791 (`Configure` component).

## Global Constraints

- Use existing design system tokens (`cardBase`, `sideBubble`, `InfoRow`, `DesignButton`, etc.) from `components/onboarding/design/`
- Follow existing patterns: `useStepDraft` for localStorage, `validateReviewPolicy` for validation, `cn()` for class merging
- All new icons from `lucide-react` (already installed)
- No new dependencies

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `lib/onboarding/types.ts` | Modify | Add `style` and `automation` fields to `PreferencesPayload` |
| `lib/onboarding/validation.ts` | Modify | Add `validateDocStyle` and `validateAutomation` helpers |
| `components/onboarding/preferences-form.tsx` | Modify | Add Documentation Style section, expand Automation to 5 toggles, update Review Policy options, add right sidebar |
| `app/(onboarding)/onboarding/preferences/page.tsx` | Modify | Pass new fields through `handleSubmit` to API |

---

### Task 1: Update Types and Validation

**Files:**
- Modify: `lib/onboarding/types.ts:50-54`
- Modify: `lib/onboarding/validation.ts:19-22`

**Interfaces:**
- Consumes: existing `PreferencesPayload` type
- Produces: expanded `PreferencesPayload` with `style` and `automation` fields; new validation functions

- [ ] **Step 1: Update PreferencesPayload type**

In `lib/onboarding/types.ts`, replace the `PreferencesPayload` interface:

```typescript
export interface PreferencesPayload {
  style?: string;
  review_policy?: string;
  auto_publish?: boolean;
  automation?: {
    detect_drift: boolean;
    evaluate_docs: boolean;
    suggest_improvements: boolean;
    reply_to_questions: boolean;
    auto_publish_low_risk: boolean;
  };
}
```

- [ ] **Step 2: Add validation helpers**

In `lib/onboarding/validation.ts`, add after the existing `validateReviewPolicy`:

```typescript
export function validateDocStyle(style: string): string | null {
  const valid = ["technical", "developer-focused", "conversational"];
  if (!valid.includes(style)) return `Documentation style must be one of: ${valid.join(", ")}`;
  return null;
}
```

- [ ] **Step 3: Update validateReviewPolicy to match design options**

Change the valid values in `validateReviewPolicy` to match the design:

```typescript
export function validateReviewPolicy(policy: string): string | null {
  const valid = ["always", "medium-high", "auto-low"];
  if (!valid.includes(policy)) return `Review policy must be one of: ${valid.join(", ")}`;
  return null;
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/onboarding/types.ts lib/onboarding/validation.ts
git commit -m "feat: expand preferences payload with style and automation fields"
```

---

### Task 2: Rebuild PreferencesForm with All Three Sections + Sidebar

**Files:**
- Modify: `components/onboarding/preferences-form.tsx` (full rewrite)

**Interfaces:**
- Consumes: updated `PreferencesPayload` type, `validateDocStyle`, `validateReviewPolicy`
- Produces: `onSubmit(style, reviewPolicy, autoPublish, automation)` with all fields

- [ ] **Step 1: Rewrite PreferencesForm**

Replace the entire content of `components/onboarding/preferences-form.tsx` with:

```tsx
"use client";
import { useState } from "react";
import {
  FileText,
  Code2,
  MessageCircle,
  Pencil,
  ShieldCheck,
  Zap,
  Sparkles,
  Users,
  CalendarClock,
  LockKeyhole,
  ArrowRight,
} from "lucide-react";
import { validateReviewPolicy, validateDocStyle } from "@/lib/onboarding/validation";
import { useStepDraft } from "@/lib/onboarding/use-draft";
import { cn } from "@/lib/utils";
import { DesignButton } from "@/components/onboarding/design/button";
import { InfoRow, sideBubble, cardBase } from "@/components/onboarding/design/info-row";

interface Props {
  onSubmit: (
    style: string,
    reviewPolicy: string,
    autoPublish: boolean,
    automation: boolean[],
  ) => void;
  loading?: boolean;
}

const secHead = "mb-1 mt-[27px] flex items-center gap-3 text-base text-[#101a43]";
const secIcon = "grid size-[38px] shrink-0 place-items-center rounded-full p-2";
const secSub = "mb-3 ml-[50px] text-xs text-[#53648e] max-[900px]:ml-0";

const STYLE_OPTIONS = [
  {
    value: "technical",
    label: "Technical",
    desc: "Detailed, formal, and comprehensive.",
    icon: <FileText size={16} />,
  },
  {
    value: "developer-focused",
    label: "Developer-focused",
    desc: "Clear, practical, and easy to implement.",
    icon: <Code2 size={16} />,
  },
  {
    value: "conversational",
    label: "Conversational",
    desc: "Friendly, approachable, and easy to read.",
    icon: <MessageCircle size={16} />,
  },
];

const REVIEW_OPTIONS = [
  {
    value: "always",
    label: "Always require review",
    desc: "All documentation changes require human approval.",
  },
  {
    value: "medium-high",
    label: "Review medium & high risk",
    desc: "Only medium and high risk changes need review.",
  },
  {
    value: "auto-low",
    label: "Auto-publish low risk",
    desc: "Low risk changes are published automatically.",
  },
];

const AUTOMATION_OPTIONS = [
  { label: "Detect documentation drift", desc: "Monitor code and docs for gaps" },
  { label: "Evaluate documentation", desc: "Run quality checks automatically" },
  { label: "Suggest improvements", desc: "Create suggestions and PRs" },
  { label: "Reply to questions", desc: "Answer in Slack & Discord" },
  { label: "Auto-publish low risk changes", desc: "Publish changes that are safe" },
];

function RadioDot({ on, size = "size-4" }: { on: boolean; size?: string }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full border-[1.5px] border-[#b7c5da]",
        size,
        on && "border-brand",
      )}>
      <span
        className={cn(
          "size-[9px] rounded-full bg-brand",
          on ? "opacity-100" : "opacity-0",
        )}
      />
    </span>
  );
}

export function PreferencesForm({ onSubmit, loading = false }: Props) {
  const [draft, setDraft] = useStepDraft("preferences", {
    style: "developer-focused",
    reviewPolicy: "always",
    autoPublish: false,
    automation: [true, true, true, true, false],
  });
  const { style, reviewPolicy, autoPublish, automation } = draft;
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    const styleErr = validateDocStyle(style);
    const reviewErr = validateReviewPolicy(reviewPolicy);
    if (styleErr || reviewErr) {
      setError(styleErr || reviewErr);
      return;
    }
    setError(null);
    onSubmit(style, reviewPolicy, autoPublish, automation);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-[35px] max-[900px]:grid-cols-1">
      {/* Main content */}
      <div>
        {/* Documentation Style */}
        <h3 className={secHead}>
          <span className={cn(secIcon, "bg-[#f1eaff] text-[#7042e9]")}>
            <Pencil />
          </span>{" "}
          Documentation style
        </h3>
        <p className={secSub}>How Draftly writes and improves documentation.</p>
        <div className="ml-[50px] grid grid-cols-3 gap-[13px] max-[900px]:ml-0 max-[900px]:grid-cols-1">
          {STYLE_OPTIONS.map(({ value, label, desc, icon }) => {
            const selected = style === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setDraft({ ...draft, style: value })}
                className={cn(
                  "min-h-[102px] rounded-[9px] border border-[#d9e1f0] bg-white p-[14px] text-left [@media(max-height:820px)]:min-h-[84px]",
                  selected && "border-brand bg-[#eef4ff] shadow-[0_0_0_1px_#1260ed44]",
                )}>
                <span className="mb-2.5 flex items-center justify-between">
                  <span className="grid place-items-center text-[#44507a]">{icon}</span>
                  <RadioDot on={selected} />
                </span>
                <b className="block text-xs text-[#101a43]">{label}</b>
                <small className="mt-2 block text-xs leading-[1.5] text-[#53648e]">
                  {desc}
                </small>
              </button>
            );
          })}
        </div>

        {/* Review Policy */}
        <h3 className={secHead}>
          <span className={cn(secIcon, "bg-[#e7f8f0] text-[#19a36d]")}>
            <ShieldCheck />
          </span>{" "}
          Review policy
        </h3>
        <p className={secSub}>Choose when human review is required.</p>
        <div className="ml-[50px] grid grid-cols-3 gap-[13px] max-[900px]:ml-0 max-[900px]:grid-cols-1">
          {REVIEW_OPTIONS.map(({ value, label, desc }) => {
            const selected = reviewPolicy === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setDraft({ ...draft, reviewPolicy: value })}
                className={cn(
                  "min-h-[102px] rounded-[9px] border border-[#d9e1f0] bg-white p-[14px] text-left [@media(max-height:820px)]:min-h-[84px]",
                  selected && "border-brand bg-[#eef4ff] shadow-[0_0_0_1px_#1260ed44]",
                )}>
                <span className="mb-2.5 flex items-center justify-end">
                  <RadioDot on={selected} />
                </span>
                <b className="block text-xs text-[#101a43]">{label}</b>
                <small className="mt-2 block text-xs leading-[1.5] text-[#53648e]">
                  {desc}
                </small>
              </button>
            );
          })}
        </div>

        {/* Automation */}
        <h3 className={secHead}>
          <span className={cn(secIcon, "bg-[#fef3e8] text-[#e8742a]")}>
            <Zap />
          </span>{" "}
          Automation
        </h3>
        <p className={secSub}>Control what Draftly automatically does for you.</p>
        <div className="ml-[50px] grid grid-cols-3 overflow-hidden rounded-lg border border-[#d9e1f0] bg-white max-[900px]:ml-0 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
          {AUTOMATION_OPTIONS.map(({ label, desc }, i) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                const next = [...automation];
                next[i] = !next[i];
                setDraft({ ...draft, automation: next });
              }}
              className={cn(
                "min-h-[69px] border-b border-r border-[#d9e1f0] bg-white p-3 text-left",
                (i % 3 === 2 || (i === AUTOMATION_OPTIONS.length - 1 && i % 3 === 1)) &&
                  "border-r-0",
                i >= 3 && "border-b-0",
              )}>
              <span
                className={cn(
                  "mr-1.5 inline-grid size-[15px] place-items-center rounded-[3px] border border-[#afbdd3]",
                  automation[i] && "border-brand bg-brand text-white",
                )}>
                {automation[i] && (
                  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2.5 6.5l2.5 2.5L9.5 4" />
                  </svg>
                )}
              </span>
              <b className="text-[11px] text-[#101a43]">{label}</b>
              <small className="ml-[21px] mt-[5px] block text-[11px] text-[#53648e]">
                {desc}
              </small>
            </button>
          ))}
        </div>

        {error && <p aria-live="polite" className="mt-3 text-[11px] text-red-500">{error}</p>}
        <DesignButton primary className="mt-[22px]" disabled={loading} onClick={handleSubmit}>
          Continue
        </DesignButton>
      </div>

      {/* Right sidebar */}
      <div className={cn(cardBase, "px-5 py-[22px] max-[900px]:order-2")}>
        <h3 className="mb-4 text-base text-[#101a43]">What this means</h3>
        <InfoRow
          className="py-[10px]"
          bubbleClassName={sideBubble}
          icon={<Sparkles />}
          title="Draftly becomes your doc assistant"
          text="We'll watch your project, conversations, and docs to keep everything accurate."
          tone="purple"
        />
        <InfoRow
          className="border-t border-[#e6ebf3] py-[10px]"
          bubbleClassName={sideBubble}
          icon={<Users />}
          title="You stay in control"
          text="Important changes go through review so your docs stay trustworthy."
          tone="purple"
        />
        <InfoRow
          className="border-t border-[#e6ebf3] py-[10px]"
          bubbleClassName={sideBubble}
          icon={<CalendarClock />}
          title="Works in the background"
          text="Draftly runs continuously and keeps your docs up to date."
          tone="green"
        />
        <div className="mt-[10px] rounded-[9px] border border-[#e7dcfb] bg-[#f7f3ff] p-[15px] text-xs leading-[1.5] text-[#263a6f]">
          <LockKeyhole
            size={20}
            className="float-left mr-2.5 box-content size-[18px] rounded-lg bg-[#7042e9] p-1.5 text-white"
          />
          <b className="text-[#3b56d8]">We respect your data</b>
          <p className="mt-1.5 text-[11px] text-[#50618a]">
            We only access what you connect and never train on your private data.
          </p>
          <span className="clear-both mt-[9px] flex items-center gap-[5px] text-[11px] font-bold text-[#7042e9]">
            Learn more about privacy <ArrowRight size={12} />
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the component compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors related to `preferences-form.tsx`

- [ ] **Step 3: Commit**

```bash
git add components/onboarding/preferences-form.tsx
git commit -m "feat: rebuild preferences form with style, review, automation sections and sidebar"
```

---

### Task 3: Update PreferencesPage to Pass New Fields

**Files:**
- Modify: `app/(onboarding)/onboarding/preferences/page.tsx:16-24`

**Interfaces:**
- Consumes: new `onSubmit` signature from PreferencesForm
- Produces: updated `configurePreferences` call with all fields

- [ ] **Step 1: Update handleSubmit signature and API call**

In `app/(onboarding)/onboarding/preferences/page.tsx`, replace the `handleSubmit` function and the `PreferencesForm` usage:

```tsx
  async function handleSubmit(
    style: string,
    reviewPolicy: string,
    autoPublish: boolean,
    automation: boolean[],
  ) {
    const ok = await run(() =>
      configurePreferences({
        style,
        review_policy: reviewPolicy,
        auto_publish: autoPublish,
        automation: {
          detect_drift: automation[0],
          evaluate_docs: automation[1],
          suggest_improvements: automation[2],
          reply_to_questions: automation[3],
          auto_publish_low_risk: automation[4],
        },
      })
    );
    if (ok) {
      clearOnboardingDraft("preferences");
      router.push("/onboarding/initialize");
    }
  }
```

- [ ] **Step 2: Verify the page compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors related to `preferences/page.tsx`

- [ ] **Step 3: Commit**

```bash
git add "app/(onboarding)/onboarding/preferences/page.tsx"
git commit -m "feat: pass style and automation fields through preferences page"
```

---

### Task 4: Visual Verification

- [ ] **Step 1: Run dev server and navigate to preferences step**

Run: `npm run dev` (or equivalent)
Navigate to: `/onboarding/preferences`

- [ ] **Step 2: Verify all three sections render**

Check that the page shows:
1. "Documentation style" section with 3 radio cards (Technical, Developer-focused, Conversational)
2. "Review policy" section with 3 radio cards (Always require review, Review medium & high risk, Auto-publish low risk)
3. "Automation" section with 5 toggle checkboxes in a grid
4. Right sidebar with "What this means" info and privacy callout

- [ ] **Step 3: Verify interactions work**

- Clicking style cards selects one at a time
- Clicking review policy cards selects one at a time
- Clicking automation checkboxes toggles individually
- "Continue" button submits all fields
- Error validation works for invalid states

- [ ] **Step 4: Commit any final tweaks**

```bash
git add -A
git commit -m "fix: visual tweaks for preferences form alignment"
```
