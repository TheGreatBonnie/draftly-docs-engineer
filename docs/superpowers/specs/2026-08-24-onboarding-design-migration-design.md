# Onboarding Design Migration — draftly-agent-frontend

**Date:** 2026-08-24
**Status:** Approved in chat (user approved design + both key decisions)
**Source of visuals:** `onboarding-flow-designs/draftly/app/tailwind/page.tsx` (fully Tailwind-converted reference, route `/tailwind`)

## Decisions

1. **Full design look, keep routing** — port SideRail, Progress, brand palette, illustrations into `components/onboarding/design/`; restyle each step page. Route-per-step URLs, Clerk gating, API wiring, and resume logic remain untouched.
2. **Scoped light-only tokens** — add `--color-brand/success/ink` to `@theme`; onboarding renders light-only (design hexes carry no `dark:` variants). Rest of app and dark mode unaffected.

## Foundation

| File | Change |
|---|---|
| `app/globals.css` | Append `@theme { --color-brand: #1260ed; --color-success: #40b879; --color-ink: #101a43; }` |
| `lib/utils.ts` | New: `cn()` (clsx + tailwind-merge; add both deps) |
| `app/layout.tsx` | Plus Jakarta Sans via `next/font/google`, `variable: "--font-jakarta"`; applied only inside onboarding subtree |

## Shared chrome (`components/onboarding/design/`)

- `brand-mark.tsx`, `glyphs.tsx` (Github/Slack/Discord), `button.tsx`, `info-row.tsx` (+ bubble recipes), `progress-stepper.tsx`, `side-rail.tsx`, `orbit.tsx`, `footer-bar.tsx`.
- `OnboardingShell` keeps its props API (`currentStep, onNext, onBack, onSkip, isNextDisabled, isNextLoading, showSkip`) but renders: flex row → SideRail (288px) + white rounded panel (ProgressStepper + children + FooterBar).
- Step-index↔slug map: welcome=1, workspace=2, github=3, repository=4, documentation=5, integrations=6, preferences=7, initialize=8; complete = terminal (no stepper).
- Side rail navigation: `setStep(i)` → `router.push("/onboarding/<slug>")`.

## Page swaps (logic verbatim)

| Route | Old component | New visual | API preserved |
|---|---|---|---|
| `/onboarding/welcome` (new) | — | Welcome split-screen → routes to workspace | none |
| `workspace` | WorkspaceForm | Design form styles | `createWorkspace` |
| `github` | GitHubConnect | Orbit card | `getInstallUrl`, `listInstallations`, `connectGitHub` |
| `repository` | RepositoryPicker | Searchable repo list | real repo data replaces mock array |
| `documentation` | DocumentationDiscovery | Check-grid config | existing discovery payload |
| `integrations` | IntegrationPicker | Source rows + access grid | existing integrations payload |
| `preferences` | PreferencesForm | Choice grids + automation toggles | existing preferences payload |
| `initialize` | InitializationProgress(+Error) | Task list driven by status polling | status polling |
| `complete` | OnboardingComplete | Metrics card screen | none |

Entry page gains optional redirect target for `welcome`; `STATE_TO_STEP` otherwise unchanged.

## Deliberate deviations from pixel parity

1. Viewport-lock dropped: shell uses document flow (`min-h-screen`), short viewports scroll.
2. Mock data replaced by live API responses.
3. Initialize progress maps real job states → done/in-progress/pending visuals.

## Verification per task + final

`tsc --noEmit`, `eslint`, `next build`; screenshots vs `/tailwind` reference at 1440px and 900px.

## Risks

- Repository picker data reshaping is the largest single chunk.
- lucide-react icon subset exists in both versions (verified visually by build).
- No git repo at workspace root: no commits possible; changes tracked as files only.

## Self-review

- No placeholders/TBDs.
- Consistent with approved chat design; decisions recorded.
- Scope: single frontend project, one migration — appropriately bounded for one plan.
- Ambiguity check: welcome route marked new+optional with explicit routing behavior; shell API compatibility specified.
