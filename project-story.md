## Inspiration

Documentation rarely becomes outdated all at once.

A pull request renames a parameter. A release changes the recommended setup. An old code example still works, but no longer reflects the best way to use the product. Each change is small, and each one creates a little more distance between the code and the documentation.

Eventually, a developer follows the docs and gets an error.

The problem is usually described as stale documentation, but the cost spreads much further. Developers lose confidence in the documentation. Support teams repeatedly answer questions that a clear guide should have prevented. Writers discover product changes after the surrounding context has disappeared, then reconstruct decisions from pull requests, release notes, issues, and conversations scattered across different tools.

The real challenge starts before a page becomes visibly outdated. Documentation teams must continuously discover what changed, decide whether it affects users, find every page that needs attention, gather reliable evidence, draft an update, and validate each instruction against the current codebase.

Then they have to do it again after the next release.

As a technical writer, I wanted to explore whether an agent could take responsibility for this continuous investigation. That idea became **Draftly**, an autonomous documentation engineering platform that watches how a software project changes and turns those changes into reviewed documentation work.

Draftly is built around a simple principle: **when the product changes, the documentation process should begin automatically—and when developers reveal a documentation problem, that signal should not be lost.**

## What Draftly does

Draftly helps developer-tool teams keep their documentation aligned with the product they are shipping.

The lifecycle begins by helping Draftly understand the project. During onboarding, a team connects its GitHub repository and selects the documentation it wants Draftly to manage. Draftly discovers the documentation, parses it into structured sections, builds searchable knowledge with source provenance, runs an initial evaluation, calculates a documentation-health score, and produces prioritized recommendations. The team starts with a baseline instead of waiting for the next event to reveal what Draftly knows.

After onboarding, Draftly continuously monitors signals such as GitHub pull requests, releases, issues, scheduled audits, and developer conversations in Slack and Discord. A signal starts an investigation; it does not automatically authorize a change.

Suppose a pull request changes how OAuth clients are configured in Authly, the fictional authentication platform I created to demonstrate Draftly. The code is merged, but the getting-started guide still shows the previous configuration.

Draftly analyzes the event, examines the changed files, searches the existing documentation and project knowledge, and identifies the pages that may now be inaccurate. It gathers supporting evidence and decides whether the correct action is to answer a question, update an existing page, create new documentation, prepare a changelog, or make no documentation change at all.

When an update is justified, Draftly prepares the content, checks it for grounding and completeness, and revises it when evaluation fails. Under the hackathon review policy, the graph then pauses before delivery.

A reviewer can see what triggered the workflow, which agents and tools handled it, which sources Draftly used, what it wants to change, and why. They can inspect the proposed artifact and evaluation results before approving or rejecting it. Approval allows the delivery agent to open a pull request or post a response; it does not merge a repository change on the maintainer’s behalf.

The process creates a continuous feedback loop:

**Product change → documentation impact analysis → grounded draft → automated evaluation → human review → documentation update**

Support questions extend that loop. Draftly can answer a GitHub, Slack, or Discord question using grounded project context, while repeated questions become evidence for a separate feedback workflow. That workflow can group related signals, identify and prioritize documentation gaps, update project knowledge, and start new documentation or content work from the accumulated evidence.

Reviewed evidence can also support release communication and channel-specific content. Draftly can turn a validated opportunity into a blog draft or social variant while preserving the same grounding, evaluation, and review boundaries. Content production is therefore downstream of trusted project knowledge rather than an unrelated text-generation feature.

Draftly also audits the documentation corpus directly. Scheduled checks can surface stale pages, broken internal links, orphaned documents, and duplicate content even when no individual pull request points to the problem.

The workspace keeps this activity visible. Maintainers can inspect agent runs, workflow steps, generated artifacts, pending interventions, documentation knowledge, and live progress. Failed or cancelled runs remain explicit operational objects that can be investigated or retried.

This allows documentation work to begin where evidence of the problem first appears—and lets the team follow that evidence until it becomes a reviewed outcome.

## How I built it

I built Draftly with the **Strands Agents SDK** using a graph-based multi-agent workflow.

Documentation maintenance involves several different kinds of judgment, so I separated the workflow into focused responsibilities.

The GitHub intelligence agent investigates repository events and determines whether a change has documentation impact. The documentation engineer studies the available evidence and prepares an update. The documentation reviewer checks whether the proposed content is supported, complete, and consistent with the rest of the documentation.

I used Strands `GraphBuilder` to make those responsibilities an explicit workflow rather than a sequence hidden inside one prompt. Conditional edges route the work to an answer, an update, a new document, or no documentation change. Evaluator nodes can send a failed result back to the writer with specific feedback, while execution limits and node timeouts keep revision loops bounded. Strands session management preserves the graph state when a run pauses and later resumes.

Research is also multi-agent. A Strands Swarm can assign focused researchers to the repository, existing documentation, and connected sources, then return a shared evidence bundle to the rest of the graph. Reusable `AgentSkills` give each role documentation-specific procedures without expanding every system prompt. This structure reflects how documentation teams already work: research, writing, and review are connected, but they are not the same task.

Strands supplies the agents, graph, Swarm, Skills, sessions, and interrupt hooks. Draftly supplies the domain tools, evidence model, routing conditions, review policies, persistence, and delivery integrations around them. Every production agent is created through a shared factory that installs a Draftly steering handler. The handler can **Proceed** with a valid action, **Guide** the agent when an action needs correction, or **Interrupt** work that crosses a safety boundary.

Draftly uses Python and FastAPI for its backend and a Next.js workspace for viewing workflow activity, documentation changes, evaluations, and pending reviews. PostgreSQL with pgvector, hosted on Neon for this project, stores workflow state, evidence, reviews, evaluations, and project memory. Redis-backed RQ workers move long-running agent work out of the HTTP request path. Redis Streams and server-sent events let the interface show progress while a workflow is running.

I used **Strands Evals** to run golden datasets against documentation, release, GitHub issue, Slack, Discord, and feedback workflows. These evaluations check output quality, required tool use, routing behavior, and whether a workflow reaches the expected human-review state. Separate runtime evaluator nodes check each proposed document before it can advance through the graph.

For deployment, Draftly includes an Amazon Bedrock AgentCore-compatible runtime entrypoint, container configuration, Terraform infrastructure, CloudWatch logging, and OpenTelemetry environment wiring. These pieces let the same composed Strands workflows run behind a production-oriented invocation boundary rather than only from a local script.

## Why this needs an agent

Finding stale documentation is not a single automation rule.

A changed file does not always require a documentation update. An internal refactor may have no effect on users, while a one-line change to a default value may invalidate several guides. A release note might announce a feature without explaining how developers should adopt it. A support question might reveal missing documentation, or it might simply come from someone overlooking an existing page.

Retrieval alone cannot resolve that ambiguity. A search system can find a relevant page, but it does not decide what evidence is missing, inspect the implementation, reconcile conflicting sources, choose an action, revise failed work, or carry the task through review and delivery.

Draftly has to gather context across code, documentation, releases, issues, and support conversations; decide whether documentation work is needed; and choose an appropriate action. It must also recognize when the evidence supports no action. That combination of investigation, judgment, tool use, memory, and follow-through made it a strong fit for an agent-based system.

The agent is useful because it owns the process without owning the final authority. It does more than alert a writer that “something changed.” It turns a scattered signal into a grounded, reviewable outcome while keeping the consequential decision visible to a person.

## Challenges I faced

The first challenge was **determining documentation impact**. Detecting that code changed is easy; deciding whether the change affects users, which pages are involved, and what those pages should say is not. I separated detection from investigation so an event starts research but does not authorize a change. Draftly gathers context and routes the result to an answer, update, new page, changelog, or no-change outcome.

The second challenge was **grounding and evaluation**. Clear writing can still be wrong. Draftly keeps structured evidence connected to each proposal, checks citation coverage and completeness at runtime, and returns failed work to the responsible writer. Strands Evals examines the wider process against golden cases, including expected concepts, tool calls, actions, and review interruptions. I learned to evaluate the path an agent took, not only the prose it produced.

Grounding also had to work at repository scale. Sending an entire codebase and documentation set to one model would be expensive, slow, and noisy. Draftly discovers only relevant documentation, parses and chunks it with source locations, stores embeddings and provenance, and combines semantic, keyword, and hybrid retrieval so agents can collect focused context instead of treating one oversized prompt as memory.

The third challenge was **controlling nondeterministic tool use**. Prompts can describe a boundary, but a production system must enforce it. Draftly’s steering policies check arguments, repository and filesystem scope, required evidence, delivery destinations, and idempotency metadata. Read-only work can be guided back toward a valid action; unsafe side effects create a durable interruption. An optional isolated model judge can refine guidance, but it cannot override a deterministic safety decision.

The fourth challenge was **making long-running work durable**. Webhooks can arrive twice, workers can restart, model calls can time out, and a human response may arrive after the original request has ended. Draftly claims events before graph execution, records canonical runs, separates webhook and scheduled work into queues, and uses bounded retries. Strands sessions preserve graph state across interruptions, while replayed, conflicting, expired, or incomplete responses are handled without silently restarting delivery.

The fifth challenge was **balancing visibility, privacy, and control**. Maintainers need live progress and enough evidence to trust a decision, but raw credentials and unrestricted tool arguments must not leak into logs or the browser. Draftly filters streamed events, records structured audit data, scopes APIs to the authenticated organization, verifies webhook signatures, and redacts secret-shaped values. The hackathon workflow then pauses before delivery so a person approves the change; opening a pull request still does not merge it for the maintainer.

Building the Authly demo taught me one final lesson: platform breadth can obscure the main story. I reduced the demonstration to a small number of scenarios that clearly show how a signal becomes a reviewed documentation outcome.

## Accomplishments that I’m proud of

I am most proud that Draftly turns documentation drift into an active engineering workflow. It does more than generate a draft: it traces a change to its evidence, coordinates specialized agents, evaluates the proposed artifact, pauses for human judgment, and preserves the outcome for future work. Documentation investigation can now begin with the same urgency as tests after code changes.

I am also proud of the production-oriented controls built around that intelligence. Using Strands graphs, sessions, interrupts, Skills, Steering, and Evals, Draftly can bound revision loops, persist execution state, pause before consequential actions, and resume the exact workflow a maintainer reviewed. Idempotent event handling, scoped tools, audit trails, and live run visibility make autonomy inspectable instead of hiding it behind a loading spinner.

Finally, what began as one pull-request documentation graph became a reusable agent platform. GitHub pull requests, releases and issues, Slack and Discord conversations, feedback analysis, content generation, and evaluation workflows share the same orchestration, model routing, curated memory, persistence, review, and observability foundations.

That combination—a useful workflow, visible human control, and reusable infrastructure—is the accomplishment that gives Draftly a credible path beyond the hackathon.

## What I learned

The biggest lesson was that building a production-ready agent is not mainly a prompting problem. It is a systems problem. The model can reason about ambiguous documentation work, but the application must still control identity, state, permissions, timeouts, retries, budgets, and side effects.

Strands gave me the primitives to make those responsibilities explicit: graphs for controlled execution, sessions and interrupts for pause and resume, Skills for reusable agent behavior, Steering for runtime intervention, and Evals for repeatable assessment. Building Draftly taught me to place nondeterministic reasoning inside deterministic boundaries. Events must be claimed idempotently, revision loops must be bounded, tools must be scoped, and consequential actions must stop for review.

I also learned that human oversight and observability are part of the architecture. A reviewer needs the trigger, evidence, artifact, evaluation, and agent path—not merely an approval button. Interrupted work must resume the exact session that was reviewed, while failures and duplicate requests must remain safe and traceable.

Finally, production readiness is evidence, not a collection of architectural features. Reliability must be demonstrated through recovery tests, evaluations, security boundaries, deployment verification, cost tracking, and measurable human outcomes.

## What’s next for Draftly

The next step is proving that Draftly remains useful and safe beyond the hackathon environment. I want to evaluate it across repositories with different languages, documentation structures, and contribution patterns, including difficult cases such as gradual drift, contradictory sources, removed behavior, and situations where no update is the correct decision.

In parallel, I want to harden the platform for production: complete the AgentCore deployment path and container packaging, test recovery from interrupted and duplicated work, exercise the system under load, and verify its security, observability, latency, and cost boundaries.

I also plan to publish portable evaluation datasets and benchmarks covering grounding, artifact quality, reviewer acceptance, false-positive rates, research time saved, and cost per accepted change. Those results should feed back into Draftly’s steering policies, model routing, and curated memory.

Longer term, recurring support questions, rejected drafts, and knowledge contradictions can become documentation-health signals that help maintainers prioritize work before drift becomes user confusion.

Software will continue to change. Draftly’s goal is to make documentation improvement a continuous, measurable engineering process.

**Draftly helps the documentation move with the code.**

When code changes are pushed into a repo, the documentation might become outdated or fail to cover new changes and features. For that reason, developers or docs team is required to find the affected docs, update them, update examples or create new docs for the new features.

However, ensuring docs keep up with the codebase changes can become repetitive and a daunting task. Fortunately, this is where Draftly comes in to help developers keep their docs in sync with the frequent code changes.
