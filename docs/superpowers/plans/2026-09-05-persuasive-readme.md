# Persuasive Draftly README Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Execute sequentially; delegation is unnecessary for this documentation change.

**Goal:** Restructure the backend README so hackathon judges can quickly understand Draftly's audience, demonstrated value, Strands implementation, and supporting evidence, while developers retain a clear setup path.

**Architecture:** Keep the backend README as the entry point and link the frontend and existing engineering guides. Lead with the product outcome and evidence, then explain implementation and reproduction. Consolidate repeated explanations without changing application behavior.

**Tech Stack:** Markdown, GitHub-rendered Mermaid, existing Python/FastAPI/Strands backend and Next.js frontend documentation.

**Spec:** The user's README analysis and persuasion requests in this conversation; the self-contained requirements below capture that direction. Judging reference: https://agentsforhumans.devpost.com/.

## Global constraints

- Audience: hackathon judges first, developers reproducing the demonstration second.
- Position Draftly for SDK maintainers and developer teams; identify Professional Agents as the intended track, without claiming submission or acceptance.
- Scope: documentation only. Do not modify agents, datasets, integrations, application behavior, dependencies, or deployment state.
- Preserve existing user changes. The workspace root is not a Git repository; inspect the backend repository directly.
- Never invent demonstration URLs, screenshots, evaluation results, time savings, cost figures, or successful executions.
- Distinguish implemented capabilities, observed results, illustrative examples, and future work. Do not describe automatic prompt or skill improvement without implementation evidence.
- No new root README, frontend rewrite, cloud deployment, public posting, or paid evaluation campaign is required.
- Use only existing verified artifacts. If demonstration evidence is absent, publish an explicitly illustrative walkthrough and state the evidence limitation; do not add empty links or pretend the demonstration ran.
- Target 180–250 nonblank lines in the README. Prioritize completeness of the recommended setup over the length target.

## Files and responsibilities

- Modify `draftly-agent-backend/README.md`: product introduction, evidence, implementation overview, and developer entry point.
- Create `draftly-agent-backend/docs/readme-evidence-audit.md`: claim-to-source mapping and actual verification results; exclude secrets and private configuration values.
- Modify `draftly-agent-backend/docs/deployment/redis.md` and `draftly-agent-backend/docs/deployment/production.md`: preserve useful operational instructions removed from the README, integrating with existing sections rather than duplicating them.
- Reference, without rewriting, `draftly-agent-frontend/README.md`, backend architecture guides, source files, datasets, and `draftly-agent-backend/LICENSE`.

## Task 1: Establish the evidence and content inventory

**Deliverable:** An evidence audit that determines exactly which claims and artifacts the rewrite can publish.

- [x] Run `git -C draftly-agent-backend status --short` and read the current README and applicable repository instructions. Preserve all existing edits.
- [x] If `graphify-out/graph.json` exists, run `graphify query "How do Draftly documentation workflows use Strands agents, evaluation, review gates and delivery?"` before source exploration. Use the wiki index for broad navigation if present.
- [x] Inspect the published hackathon page for current judging criteria and submission requirements. Attribute competition requirements to the page; do not imply that README quality guarantees an award.
- [x] Inspect `src/draftly/orchestration/graphs/documentation_graph.py`, `src/draftly/agents/shared/research.py`, `src/draftly/orchestration/hooks/review_gate.py`, and the linked delivery and evaluation implementations under the backend. Record actual Strands responsibilities and the human approval boundary.
- [x] Inspect memory and model-routing implementation before retaining claims about feedback-driven improvement. Record separately what changes automatically and what a developer changes manually.
- [x] Search README files, existing reports, documentation assets, and Authly scenarios for demo links, screenshots, source PRs, output PRs, review records, and evaluation reports. Dataset expected outputs are not execution evidence.
- [x] Create the audit with columns `Claim or artifact`, `Source`, `Evidence class`, and `README treatment`. Evidence classes are `implementation`, `observed run`, `illustration`, and `unverified`. Exclude unverified claims from affirmative product copy.
- [x] Include a setup checklist in the audit covering environment management, database initialization, Redis, model access, worker topology, authentication, integration credentials, frontend startup, and the first observable result. Derive requirements from source and configuration examples; do not read secret values into the report.

**Acceptance:** Every proposed performance claim and demonstration link has inspectable evidence or is explicitly excluded. The audit distinguishes API startup requirements from full integrated workflow requirements.

## Task 2: Rewrite the product narrative and evidence sections

**Deliverable:** A README whose first screen explains the audience and result and provides the best available evidence.

- [x] Replace the opening category-heavy paragraph with this factual product framing, adjusting verbs only if the audit requires a narrower capability claim:

  > Draftly helps SDK maintainers and developer teams keep documentation aligned with their code. It watches GitHub changes and developer questions, researches the project, and prepares documentation updates for review, so maintainers can focus on decisions instead of repeatedly investigating and rewriting docs.

- [x] Identify Strands Agents SDK in the opening and add a compact navigation row with valid links to demonstration evidence when available, setup, architecture, evaluation, and the frontend README.
- [x] Use this section order: `See Draftly in action`, `Who it helps`, `From code change to reviewed documentation`, `Core capabilities`, `Built with Strands Agents`, `Architecture`, `Evaluation and evidence`, `Run Draftly`, `Current limitations`, `Development and documentation`, `Hackathon and license`.
- [x] In the first section, embed one existing verified screenshot showing a documentation diff or review decision, if available, with descriptive alt text and a caption explaining the result. Link the verified video or output PR when available. Otherwise provide the walkthrough anchor and explicitly state that a recorded demonstration is not included.
- [x] Explain the maintainer's recurring task in one short paragraph. Avoid unsupported market-size or time-savings numbers and the broad traditional-versus-AI comparison table.
- [x] Replace the hypothetical authentication diagram with one Authly case: trigger, affected documentation, retrieved evidence, proposed diff, reviewer decision, and delivery. Use observed artifacts when present; otherwise label the entire case `Illustrative walkthrough` and describe expected behavior without claims of execution.
- [x] Keep at most five core capabilities: event-triggered documentation maintenance, grounded support, research with evidence, configurable human review, and feedback with persistent memory. Connect each to its user benefit.
- [x] Consolidate `The Documentation Engineering Loop`, `How Draftly Works`, and the repeated evaluation-learning diagrams into a single concise product flow. Move glossary detail to links to existing explanation guides.

**Acceptance:** A reader can identify the audience, trigger, output, and remaining human decision from the opening and walkthrough. No illustration can be mistaken for a measured success.

## Task 3: Show technical depth and bounded evaluation evidence

**Deliverable:** Traceable implementation explanation and an honest quality assessment.

- [x] Add a compact Strands table mapping research, orchestration, evaluation, and review handling to their actual implementation files. Distinguish SDK capabilities from Draftly application logic; explain why the division of responsibilities is useful.
- [x] Retain one Mermaid architecture diagram. Include the Next.js/Clerk frontend, FastAPI, event dispatch and workers, Strands workflows, research and storage, evaluation, review, and delivery. Match control-flow arrows to the inspected implementation, including any route-specific evaluation or review bypasses.
- [x] Link expanded infrastructure and provider explanations to existing architecture guides. Do not give provider lists more prominence than the core workflow.
- [x] Lead evaluation with available observed results. Use columns `Scenario`, `Cases and runs`, `Completion`, `Review-gate checks`, `Runtime and cost`, and `Report`. Include only observed values; use `Not measured` for unavailable fields in an otherwise real report.
- [x] If no qualifying report exists, replace the results table with an explicit statement that the README does not yet provide measured results, followed by verified evaluation coverage and reproduction instructions.
- [x] Separate LLM-judged quality metrics from deterministic workflow checks. For cited results, include dataset, commit, model, date, and sample size when recorded; state missing provenance rather than inferring it.
- [x] Explain that Authly is an evaluation project and that results on its scenarios do not establish general performance across repositories.
- [x] Link the dataset directory and preserve one supported evaluation command in the README. Link the architecture evaluation guide for the other commands. State that live runs use real model calls and require configured services.

**Acceptance:** Every technical assertion is supported by the audit. Metrics, dataset expectations, and human observations are clearly distinguished. Mermaid includes the frontend and accurately depicts approval and delivery.

## Task 4: Make reproduction and supporting documentation coherent

**Deliverable:** One recommended setup path and no lost operational instructions.

- [x] Read `main.py`, `.env.example`, the dependency manifest, worker configuration, database setup scripts, and existing deployment guides to choose the documented development topology. Prefer native API plus its supported in-process execution and a Redis container when the current implementation supports that combination; otherwise document the required separate RQ worker explicitly.
- [x] Write setup in execution order: enter the backend directory, `uv sync`, copy the environment example, configure the required services, initialize the database with the existing supported command, start Redis, start the necessary worker process if separate, then `uv run python main.py`.
- [x] Include the actual health endpoint and expected response from its route implementation, then link `http://localhost:8000/docs`. Distinguish this API check from proof of agent execution.
- [x] Link `../draftly-agent-frontend/README.md` for frontend configuration and startup. Identify additional Clerk and GitHub configuration required to reproduce the integrated review experience.
- [x] End setup with the chosen walkthrough's actual trigger and observable output if verified. Otherwise state that integrated execution remains unverified and link the supported scenario instructions without asserting success.
- [x] Move standalone worker-container and Redis networking alternatives to `docs/deployment/redis.md`; move API-container deployment instructions to `docs/deployment/production.md`. Preserve caveats about environment files and GitHub private-key mounts without embedding credentials.
- [x] Retain concise development commands, source-directory navigation, and links to architecture, how-to, and reference guides. Link `LICENSE` and confirm its actual license type. Identify the intended hackathon track and link the official page; include build-story and live-demo links only if verified.
- [x] Add limitations supported by the audit: unavailable measurements, unverified integrated setup, required external services, and any known demonstrated workflow boundaries. Keep future work separate from current capabilities.

**Acceptance:** Required and optional services are unambiguous. A developer has a single recommended startup sequence. Removed operational content remains reachable, and the backend README acknowledges the frontend experience.

## Task 5: Verify the documentation and review the final diff

**Deliverable:** A checked rewrite with an honest record of verification.

- [x] Run `git -C draftly-agent-backend diff --check` and fix whitespace errors. Inspect the diff and newly created files directly; confirm only the planned documentation files changed relative to the starting state.
- [x] Check every local Markdown link relative to its containing document and every heading anchor against the rewritten target. Open public demonstration and artifact URLs; replace inaccessible evidence with an honest availability statement.
- [x] Preview the README in a GitHub-compatible Markdown renderer. Inspect table wrapping, navigation, screenshot readability and alt text, and Mermaid rendering. If rendering is unavailable, record that limitation and do not claim visual verification.
- [x] Verify setup commands against actual script names, command-line help, and configuration. Run safe local checks when services are available. Do not start external delivery workflows or incur evaluation costs solely to validate prose; mark unexecuted integrated steps explicitly.
- [x] Search the rewritten README for unsupported guarantees, invented results, empty links, outdated section references, and claims that feedback automatically changes skills or prompts. Resolve each against the evidence audit.
- [x] Record verification commands, their observed outcomes, and remaining evidence gaps in `docs/readme-evidence-audit.md`. Do not claim application tests passed unless actually executed.
- [x] Review from a judge's perspective: the opening names a user and outcome; the walkthrough shows or labels evidence; Strands has inspectable implementation links; quality claims are bounded; the frontend and human decision are visible; reproduction and license are reachable.

**Completion boundary:** The implementation is complete when the README and supporting documentation satisfy these checks. Producing new benchmark results, recording a video, deploying a demo, and publishing a hackathon submission are separate work, not implied by this documentation plan. No application API, type, schema, or runtime behavior changes are required. Graphify updates are required if execution later changes code; this plan authorizes documentation edits only.


## Execution record — 2026-09-05

Completed the README, evidence audit, and two deployment guide updates in the existing development checkout. All five tasks are complete; conditional evidence steps used the plan's explicit unavailable-evidence alternatives. Verification and remaining project evidence gaps are recorded in `draftly-agent-backend/docs/readme-evidence-audit.md`. No code, datasets, credentials, or license contents were changed. No live workflow or publication was initiated.
