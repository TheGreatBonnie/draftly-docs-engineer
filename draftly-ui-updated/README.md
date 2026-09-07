# Draftly UI — Next.js + TypeScript + Tailwind CSS

High-fidelity mock frontend for Draftly, based on the supplied UI designs. All product data is local mock data; no backend or credentials are required.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Core routes

- `/` — Overview dashboard
- `/knowledge` — Knowledge overview
- `/knowledge/documents`, `/knowledge/sources`, `/knowledge/graph`, `/knowledge/topics`, `/knowledge/embeddings`
- `/activity` and `/activity/[id]`
- `/reviews` and `/reviews/[id]`
- `/evaluations`, `/evaluations/runs/[runId]`, `/evaluations/test-cases/[caseId]`
- `/documentation`, `/documentation/[slug]`, `/documentation/[slug]/edit`
- `/workflows`, `/workflows/new`, `/workflows/[id]`, `/workflows/[id]/runs/[runId]`
- `/agents`, `/agents/new`, `/agents/[id]`
- `/integrations`, `/integrations/add`, `/integrations/[provider]`
- `/settings` plus organization, models, GitHub, notifications, security, billing, advanced, and audit subpages
- `/system` — system health
- `/onboarding` — first-run setup flow

## UI improvements included

- Responsive horizontal tabs with touch scrolling on every tabbed page
- Responsive mobile navigation drawer
- Global command/search overlay and notification panel
- Provider-specific and role-specific Lucide icons matching the visual language of the designs
- Workflow detail and run trace pages
- Agent detail and create-agent pages
- Evaluation run and test-case detail pages using Strands Eval SDK-oriented mock data
- Activity event detail pages
- Integration configuration and add-integration flow
- Knowledge documents, sources, graph, topics, and embeddings pages
- Settings subpages for organization, model routing, GitHub, notifications, security, billing, advanced configuration, and audit logs
- Documentation detail editor with preview, evidence, and AI suggestions
- Review action confirmation/feedback dialogs
- System status and onboarding pages
- Global loading, error, and not-found states
- Mock datasets in `lib/mock-data.ts`

## Notes

This is a frontend prototype. Actions mutate local UI state only and do not persist. Replace the mock data and actions with Draftly API calls when integrating the production backend.


## Dark mode and semantic design tokens

The UI now uses a persisted `light | dark | system` theme with an inline pre-hydration theme script to avoid flashing the wrong theme. Semantic tokens live in `app/globals.css` and are exposed through Tailwind in `tailwind.config.ts` for backgrounds, surfaces, foregrounds, borders, brand, status colors, inputs, code surfaces, chart grids, rings, and shadows. The header theme button toggles light/dark mode, while Settings → General exposes Light, Dark, and System choices.

Prefer semantic utilities for new UI (`bg-background`, `bg-surface`, `text-foreground`, `text-foreground-muted`, `border-border`, `bg-brand-soft`, `text-brand`) instead of hard-coded slate/white values. A compatibility bridge in `globals.css` also darkens the existing screenshot-matched Tailwind utilities.

## Responsive route-backed section tabs

The following top-level areas use horizontally scrollable responsive tabs that map to real routes and mock-driven subpages:

- Activity: `/activity/document-changes`, `/activity/workflow-runs`, `/activity/evaluations`, `/activity/support`, `/activity/system`
- Reviews: `/reviews/pending`, `/reviews/needs-attention`, `/reviews/approved`, `/reviews/rejected`
- Evaluations: `/evaluations/runs`, `/evaluations/test-cases`, `/evaluations/datasets`, `/evaluations/evaluators`, `/evaluations/trends`
- Documentation: `/documentation/by-repository`, `/documentation/by-topic`, `/documentation/outdated`, `/documentation/recently-updated`
- Workflows: `/workflows/active`, `/workflows/paused`, `/workflows/drafts`, `/workflows/templates`
- Agents: `/agents/active`, `/agents/idle`, `/agents/templates`

The shared route configuration is in `components/section-tabs.tsx`; reusable mock subpage presentations are in `components/section-subpage.tsx`.
