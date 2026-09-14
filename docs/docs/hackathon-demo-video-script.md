# Draftly Hackathon Demo Video Script

**Hackathon:** Agents for Humans  
**Track:** Professional Agents  
**Target length:** 4 minutes 45 seconds  
**Maximum allowed length:** 5 minutes  
**Format:** Screen recording with voice-over  
**Primary scenario:** A merged Authly OAuth pull request triggers a reviewed documentation update

## Recording goal

Demonstrate that Draftly performs a real documentation-maintenance workflow end to end:

1. A code change creates a documentation gap.
2. Draftly detects the event and starts a Strands agent workflow.
3. Specialized agents research the repository and documentation.
4. Draftly writes and evaluates a documentation update.
5. The workflow pauses for a genuine human decision.
6. Approval allows a delivery agent to open a GitHub pull request.

Do not describe an illustrative or mocked result as a completed live run. Record the final video only after the workflow reaches the states shown in this script.

## Assets to prepare

- A clean browser profile with only the required tabs open.
- The Draftly architecture diagram.
- The Authly repository and a merged OAuth-related pull request.
- The Draftly workflow dashboard.
- The pending review page with the generated documentation diff.
- The final GitHub documentation pull request.
- Optional terminal or code tabs showing the Strands graph and review hook.
- Public repository and live-demo URLs for the closing frame.

Use synthetic Authly data. Hide browser bookmarks, credentials, tokens, private repository names, terminal environment variables, and unrelated notifications.

## Script

### 0:00–0:25 — Problem, audience, and promise

**On screen**

- Show the Draftly title card and tagline.
- Transition to a split view of an API code change and outdated documentation.

**Narration**

> Shipping an API change creates a second job: finding every affected guide, researching the new behavior, updating examples, and answering developers who still see the old instructions. Draftly handles that repetitive work for SDK maintainers and developer teams. It keeps documentation aligned with code and asks a person to step in only when a publication decision is needed.

**Evidence checkpoint**

- The audience is explicit: SDK maintainers and developer teams.
- The problem is explicit: documentation drift after product changes.
- Do not make numerical time-saving or accuracy claims unless measured evidence is displayed.

### 0:25–0:55 — Architecture and Strands implementation

**On screen**

- Display the architecture diagram.
- Highlight the path from event sources to the final output.
- Visually emphasize the Strands graph, agent swarm, tools, evaluation loop, and human-review gate.

**Narration**

> Draftly is an event-driven agent platform built with the Strands Agents SDK. GitHub, Slack, and Discord events enter a FastAPI service and are dispatched to background workers through Redis. For each run, Draftly constructs a Strands graph of specialized agents. The agents use scoped repository and documentation tools, route work to a research swarm, produce structured output, evaluate it, and revise it when necessary. PostgreSQL and vector search provide project memory, while the review workspace streams progress and captures human decisions. Amazon Bedrock can provide the models through Strands' native Bedrock integration.

**Evidence checkpoint**

- Show `Strands Agents SDK`, `GraphBuilder`, `Swarm`, and the review interrupt in the diagram or code labels.
- Say “can provide” unless the recorded run demonstrably uses Bedrock.
- Do not claim an AgentCore deployment unless one is running and shown.

### 0:55–1:20 — Trigger the real workflow

**On screen**

- Open the Authly pull request that adds OAuth authentication.
- Briefly show the changed authorization URL, callback, or token-exchange code.
- Show that the pull request is merged.
- Switch to Draftly and show the new workflow run.

**Narration**

> Here, Authly has added OAuth authentication. The implementation introduces authorization URLs, callback handling, code exchange, and a new login flow, but the existing documentation does not explain them. When this pull request is merged, Draftly receives the GitHub event, validates it, and creates an idempotent background workflow.

**Evidence checkpoint**

- The GitHub event and Draftly run should share recognizable repository and pull-request identifiers.
- Avoid editing database state manually during the recording.

### 1:20–2:20 — Research and agent execution

**On screen**

- Open the workflow-detail view.
- Show live or persisted stages: classification, context, research, impact analysis, and writing.
- Open the evidence panel and show references to relevant Authly code and documentation.
- Briefly show agent identities and tool calls without exposing raw secrets or oversized payloads.

**Narration**

> This is not a single prompt wrapped in a dashboard. Draftly first classifies the event and builds project context. A Strands research swarm then gathers evidence from the repository and existing documentation. The impact agent decides what coverage is missing, and the writer receives a restricted tool set: it can author a structured change plan, but it cannot publish to GitHub. Every step is persisted so maintainers can inspect which agent ran, what evidence it used, and how the workflow reached its result.

**Evidence checkpoint**

- Show at least one real repository source and one documentation source.
- Show agent or node names rather than only a generic loading animation.
- If execution is too slow for the video, record the trigger and then cut to the same persisted run. Do not imply the cut is real-time.

### 2:20–3:15 — Draft, evaluation, and revision

**On screen**

- Display the generated documentation change.
- Highlight OAuth provider setup, authorization URL construction, callback handling, code exchange, and login usage.
- Show evaluation dimensions or a visible revision pass.

**Narration**

> The writer turns the evidence into a concrete documentation change covering provider setup, authorization URL construction, callback handling, code exchange, and OAuth-backed login. Draftly then evaluates the result for groundedness, correctness, completeness, and relevance. If the draft misses required coverage, the graph routes it back for a targeted revision instead of publishing an unchecked answer.

**Evidence checkpoint**

- Prefer showing an actual before-and-after diff.
- If the demonstrated run did not require revision, describe the revision branch as supported behavior and show the completed evaluation result.
- Do not present dataset expectations as measured production performance.

### 3:15–4:00 — Human review and controlled delivery

**On screen**

- Show the run paused in `pending_review`.
- Open the review page and inspect the proposed files, evidence, and changelog.
- Click **Approve**.
- Show the workflow resuming and entering delivery.

**Narration**

> Publication is a separate security boundary. With the review policy set to always, a Strands before-node hook interrupts the graph before the delivery agent runs. The maintainer can inspect the evidence and exact diff, then approve or reject it. I will approve this change. Draftly resumes the persisted session and grants the separate delivery agent access to the GitHub mutation tools. Approval opens a pull request; it does not merge it, so the repository owner retains final control.

**Evidence checkpoint**

- Show a genuine paused state before clicking approve.
- Keep the approval click and resumed workflow in the same sequence.
- Confirm that no delivery occurred before approval.

### 4:00–4:30 — Delivered result

**On screen**

- Open the GitHub pull request created by Draftly.
- Show the changed documentation files and changelog.
- Return briefly to the Draftly run and show its delivery receipt or terminal status.

**Narration**

> Draftly has now opened a reviewable documentation pull request grounded in the code change that caused it. The workflow records the delivery receipt and preserves the research, evaluation, and human decision behind the result. The maintainer can review and merge through the team's normal GitHub process.

**Evidence checkpoint**

- The pull request must be publicly accessible to judges or reproduced in the provided test environment.
- Show the author, branch, changed files, and successful Draftly delivery status.

### 4:30–4:45 — Closing pitch

**On screen**

- Return to the Draftly title card.
- Display the public source repository and optional live-demo URL.
- Show “Professional Agents” and “Built with Strands Agents SDK.”

**Narration**

> Draftly turns documentation maintenance from a recurring investigation into an observable, reviewable agent workflow. It works where engineering signals already happen, completes the repetitive research and drafting, and reserves human attention for the decision that matters. Draftly: documentation that keeps up with your code.

## Suggested title and description

**Video title**

> Draftly — Agents for Humans Hackathon Demo

**Video description**

> Draftly is a Professional Agent built with the Strands Agents SDK. It watches engineering events, researches code and documentation, drafts and evaluates updates, pauses for human review, and delivers approved changes through GitHub.
>
> Source: `<PUBLIC_REPOSITORY_URL>`  
> Live demo: `<LIVE_DEMO_URL_OR_REMOVE_THIS_LINE>`

## Recording checklist

Before recording:

- [ ] The demonstrated workflow completes from trigger through GitHub delivery.
- [ ] The generated pull request is accessible to judges.
- [ ] The architecture diagram reflects only services actually used.
- [ ] The repository and live-demo URLs are final.
- [ ] All secrets, personal data, bookmarks, and notifications are hidden.
- [ ] Demo accounts contain only synthetic or public data.
- [ ] Browser zoom and terminal font sizes are readable at 1080p.

Before uploading:

- [ ] The final duration is no more than 5:00.
- [ ] The first 25 seconds state the problem, audience, and value.
- [ ] The video shows a working project, not only slides or source code.
- [ ] The Strands implementation is named and visibly demonstrated.
- [ ] The human-review interruption and approval are visible.
- [ ] The delivered GitHub pull request is visible.
- [ ] Unsupported numerical claims and mock placeholders have been removed.
- [ ] The video is uploaded publicly to YouTube or Vimeo.
- [ ] Captions are enabled and submission materials are in English.
- [ ] The public video URL works in a signed-out browser.

## Contingency plan

If a live model call is too slow or unreliable during recording:

1. Record the real event trigger.
2. Cut to the persisted run created by that exact event.
3. State with an on-screen caption that processing time was shortened in the edit.
4. Continue with the real evidence, draft, review decision, delivery, and GitHub pull request.

Do not substitute mocked workflow states for the required working demonstration.
