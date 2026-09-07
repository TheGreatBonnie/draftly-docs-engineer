# Graph Report - draftly-ui-updated  (2026-09-07)

## Corpus Check
- 73 files · ~749,600 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 329 nodes · 612 edges · 22 communities (14 shown, 8 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d48d58d4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Card
- devDependencies
- compilerOptions
- settings/page.tsx
- app/page.tsx
- agents/page.tsx
- settings/[section]/page.tsx
- ActivitySubpage
- section-subpage.tsx
- EvaluationsSubpage
- ui.tsx
- DocumentationSubpage
- ReviewsSubpage
- reviews/page.tsx
- WorkflowsSubpage
- Draftly UI — Next.js + TypeScript + Tailwind CSS
- integrations/page.tsx
- [slug]/page.tsx
- next.config.ts
- next-env.d.ts

## God Nodes (most connected - your core abstractions)
1. `Card()` - 29 edges
2. `Button()` - 27 edges
3. `PageHeader()` - 26 edges
4. `Tabs()` - 24 edges
5. `IconTile()` - 22 edges
6. `Badge()` - 21 edges
7. `compilerOptions` - 17 edges
8. `Progress()` - 15 edges
9. `MetricCard()` - 10 edges
10. `SelectPill()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `ActivityChart()` --calls--> `chartDataForRange()`  [EXTRACTED]
  app/page.tsx → lib/dashboard-state.ts
- `Shell()` --calls--> `useTheme()`  [EXTRACTED]
  components/shell.tsx → components/theme-provider.tsx
- `ThemeSwitcher()` --calls--> `useTheme()`  [EXTRACTED]
  components/theme-switcher.tsx → components/theme-provider.tsx

## Import Cycles
- None detected.

## Communities (22 total, 8 thin omitted)

### Community 0 - "Card"
Cohesion: 0.09
Nodes (18): iconMap, providers, tabs, steps, steps, Badge(), Card(), IconTile() (+10 more)

### Community 1 - "devDependencies"
Cohesion: 0.06
Nodes (33): autoprefixer, lucide-react, next, dependencies, lucide-react, next, react, react-dom (+25 more)

### Community 2 - "compilerOptions"
Cohesion: 0.07
Nodes (27): dom, dom.iterable, esnext, next-env.d.ts, .next/types/**/*.ts, node_modules, **/*.ts, **/*.tsx (+19 more)

### Community 3 - "settings/page.tsx"
Cohesion: 0.11
Nodes (13): metadata, nav, Shell(), useDismissibleMenu(), applyTheme(), getSystemTheme(), ResolvedTheme, Theme (+5 more)

### Community 4 - "app/page.tsx"
Cohesion: 0.11
Nodes (16): ActivityChart(), attentionItems, changeItems, statusItems, workflowItems, activity14, ActivityPoint, activitySeries (+8 more)

### Community 5 - "agents/page.tsx"
Cohesion: 0.10
Nodes (17): agentIcons, agentTones, Page(), slug(), runs, TrendRange, trendRanges, trendSeries (+9 more)

### Community 8 - "section-subpage.tsx"
Cohesion: 0.24
Nodes (4): AgentsSubpage(), docRows, evalRuns, Section

### Community 10 - "ui.tsx"
Cohesion: 0.11
Nodes (14): graphLegend, graphNodes, knowledgeSources, SourceProvider, topics, ReviewActions(), Button(), EmptyState() (+6 more)

### Community 13 - "reviews/page.tsx"
Cohesion: 0.25
Nodes (4): reviewAccent, StatusBadge(), tone(), reviews

### Community 15 - "Draftly UI — Next.js + TypeScript + Tailwind CSS"
Cohesion: 0.25
Nodes (7): Core routes, Dark mode and semantic design tokens, Draftly UI — Next.js + TypeScript + Tailwind CSS, Notes, Responsive route-backed section tabs, Run, UI improvements included

### Community 16 - "integrations/page.tsx"
Cohesion: 0.33
Nodes (5): available, connected, Page(), slug(), integrations

### Community 17 - "[slug]/page.tsx"
Cohesion: 0.33
Nodes (3): activity, quality, toc

## Knowledge Gaps
- **96 isolated node(s):** `iconMap`, `agentIcons`, `agentTones`, `toc`, `quality` (+91 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Button()` connect `ui.tsx` to `Card`, `settings/page.tsx`, `app/page.tsx`, `agents/page.tsx`, `settings/[section]/page.tsx`, `section-subpage.tsx`, `reviews/page.tsx`, `integrations/page.tsx`, `[slug]/page.tsx`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `Card()` connect `Card` to `settings/page.tsx`, `app/page.tsx`, `agents/page.tsx`, `settings/[section]/page.tsx`, `section-subpage.tsx`, `ui.tsx`, `reviews/page.tsx`, `integrations/page.tsx`, `[slug]/page.tsx`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `PageHeader()` connect `Card` to `settings/page.tsx`, `app/page.tsx`, `agents/page.tsx`, `settings/[section]/page.tsx`, `section-subpage.tsx`, `ui.tsx`, `reviews/page.tsx`, `integrations/page.tsx`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **What connects `iconMap`, `agentIcons`, `agentTones` to the rest of the system?**
  _96 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Card` be split into smaller, more focused modules?**
  _Cohesion score 0.09049773755656108 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.058823529411764705 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._