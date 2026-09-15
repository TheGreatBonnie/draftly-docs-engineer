# How to Create the Draftly Architecture Diagram for a Hackathon

**Hackathon:** Agents for Humans (AgentsForHumans.devpost.com)
**Related assets:** `../hackathon-architecture-diagram.md` (this guide's output), `../hackathon-demo-video-script.md`
**Source material:** `draftly-agent-backend/README.md` · `draftly-agent-backend/docs/architecture/*` · `docs/docs/architecture/*`

Devpost requires an **Architecture Diagram** as part of the submission. This guide is the method used to produce the diagram in `../hackathon-architecture-diagram.md` — it applies to any agent project, not just Draftly.

---

## 1. Know what the diagram must do

A hackathon architecture diagram is judged by the same rubric as the project. Score it against the Devpost criteria before drawing a single box:

| Criterion | What the diagram must do |
| --- | --- |
| **Technological Implementation** (first-listed) | Make Strands Agents usage *visible*: graphs, steering, skills, evaluation, hooks. If a judge can't tell an SDK powering the system, the diagram failed. |
| **Design** | Read like a product architecture: coherent layers, one legend, consistent direction of flow. |
| **Presentation** | Legible at slide size in ≤ 5 seconds; one idea per arrow path; self-contained caption. |

Rules of thumb that follow:
- **Draw the SDK as a layer, not a footnote.** Dedicated colored band (teal) with *Strands feature callouts* (steering, skills, evals) pasted beside the nodes they affect.
- **One diagram, three jobs.** Flow (left→right or top→bottom), *layers* (bands), and *annotations* (dotted lines) — do all three but in different visual treatments so nothing collapses into a hairball.
- **Color is semantics.** Strands vs. app-owned vs. external vs. human — one legend, used consistently. This also pre-answers "what did you build vs. what did the SDK give you."

## 2. Inventory the system first (30 minutes)

Extract a box list from the README architecture section and the docs tree before drawing:

1. **Event surfaces** — every inbound trigger: GitHub webhooks (PR / issue / release), Slack, Discord, scheduled/cron.
2. **Execution path** — ingress → any queue/worker → runner that launches the agent work. (Draftly: FastAPI → RQ → worker → `WorkflowRunner`.)
3. **The agent pipeline** — the graph nodes in order, plus loops and branches. (Draftly: `classify → context → research → impact → update/create/answer → evaluate ⇄ revise → changelog → deliver`, plus the `notify` branch.)
4. **Cross-cutting SDK plugins** — steering, skills, model routing, hooks, session/interrupts. These become the callouts, not full boxes.
5. **State** — databases, vector stores, caches, queues.
6. **External integrations** — APIs the agents act on.
7. **Human surfaces** — auth, review/approval UI, live-progress views.

Sources: `draftly-agent-backend/README.md` (has a usable Mermaid skeleton), `docs/docs/architecture/overview.md` (5-layer diagram), `docs/docs/architecture/system-design.md` (composition, request flow, Strands runtime integration).

## 3. Choose the format: C4-lite layered bands

For a hackathon, prefer **C4-lite with horizontal layer bands** over a pure dependency/flow diagram:

```
Events & Input
  → Ingestion & Execution
  → STRANDS ORCHESTRATION (your agent graph, drawn large)
  → Persistence & Integrations
  → Human layer
```

Why this wins with judges:
- The **agent graph is the centerband** — put the SDK surface in the middle where the eye lands.
- Layers answer "is this resilient / production-shaped?" (queues, retries, persistence) faster than a node soup.
- You can show a full platform (📄 *documentation*, 🐛 *issues*, 🗨️ *support*) by drawing **one flagship graph** and noting the parallel graphs share the same stack — full platform story, single-slide legibility.

Trade-off: if your whole submission is one linear agent, a single left→right flow beats bands. Bands pay off when there are 2+ surfaces, background workers, or real state.

## 4. Draw the layers, then the graph

1. Lay down the five bands (empty subgraphs).
2. Put events on top, humans on the bottom, state/integrations along the edge.
3. Draw the graph nodes inside the orchestration band **in execution order** with `direction TB`.
4. Add loops/branches explicitly — the revise loop and the human review interrupt are the two things reviewers (and demo viewers) must see. Use `== thick ==` for the human pause/resume boundary so it can't be missed.
5. Only now add cross-cutting plugins as **dotted callout** edges to a representative node, with a one-line label ("on every tool call / model turn"). Do not give each plugin a box inside the graph flow.

## 5. Surface Strands features deliberately (score the #1 criterion)

Map feature → Strands construct → code path, then decide how each appears:

| Strands feature | Appears in diagram as | Draftly code reference |
| --- | --- | --- |
| Graphs (`GraphBuilder`, conditions, session) | The orchestration band + `Session Manager` box | `orchestration/graphs/*_graph.py` |
| Agents & Swarms | Graph nodes; `research (Strands Swarm)` labeled explicitly | `agents/*/research_swarm.py` |
| Skills (`AgentSkills`) | Dotted callout, "17 bundled skills" | `agents/documentation/researcher.py` |
| Steering (`Guide/Interrupt/Proceed`) | Dotted callout alongside every agent | `steering/handler.py` |
| Hooks / HITL | The thick pause/resume arrow into the human layer | `orchestration/hooks/review_gate.py` |
| Evaluation (`Case`/`Experiment`) | `EvaluatorNode` in the graph + evals in the caption | `evaluation/runner.py` |
| Model routing | `Model Router` box feeding the graph | `integrations/strands/models.py` |

Label boxes with **the SDK's vocabulary** (`SteeringHandler`, `AgentSkills`, `GraphBuilder`, `EvaluatorNode`). Judges skim for these exact terms.

## 6. Write the caption (it is part of the diagram)

A 100–150 word caption travels with the image into Devpost, slides, and the video. It must cover *problem → how it flows → where Strands is → where the human is*, in one paragraph. Steal the structure from `../hackathon-architecture-diagram.md`'s Caption section. No implementation claims a saved run didn't demonstrate (see the repo's evidence-audit stance) — the diagram and caption must not overstate.

## 7. Validate and iterate

1. **Render it** (Mermaid renders natively on GitHub; `mermaid.live` for export).
2. **The 5-second test** — show it for 5 seconds: can a stranger point at the Strands band and the human gate?
3. **The zoom test** — legible on a 1080p slide, text ≥ 11px after raster export.
4. **The criteria test** — does a judge see Graphs, Steering, Skills, Evals, Hooks in one glance? Any one missing means an annotation pass, not a redesign.
5. **The consistency test** — box names match the code and the demo video narrative (`hackathon-demo-video-script.md` names the same nodes). Rename a node only if the code/marketing doc also changes.

## 8. Pitfalls checklist

- ❌ Hiding Strands behind app names (use SDK vocabulary on SDK boxes).
- ❌ Two arrows meaning different things rendered identically (flow vs. annotation vs. interaction need three styles).
- ❌ More than ~40 nodes — a judge won't parse it at slide size.
- ❌ Color used decoratively instead of semantically (colors must map 1:1 to a legend).
- ❌ Omitting the human-in-the-loop — the theme's whole pitch is "surfaces only when there's a real decision," and the interrupt is the plot point of the demo video.
- ❌ Overtracking: Mermaid-only is fine. Excalidraw/Figma are worth it only if you'll keep it maintained through the submission.

## Tooling summary

| Tool | Use |
| --- | --- |
| Mermaid (this repo) | Source of truth; versioned with code |
| mermaid.live | Quick edit + PNG/SVG export for slides |
| `@mermaid-js/mermaid-cli` | High-quality export from the repo file |
| GitHub | Native rendering in READMEs |
| Excalidraw / Figma | Only for a one-off presentation polish pass |