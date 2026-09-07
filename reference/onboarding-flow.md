Yes. For **production-ready Draftly**, I would make onboarding more than a UI wizard: it should be a **durable workspace initialization workflow** spanning the frontend, backend, integrations, repository ingestion, agent orchestration, and persistent state.

The README gives us the current frontend boundaries: Next.js App Router, Clerk authentication, server-side API proxying, and existing GitHub/Slack/Discord, documentation, evaluation, knowledge, review, and workflow surfaces.

## 1. The production onboarding experience

I recommend this flow:

```text
                         ┌──────────────┐
                         │   Sign Up    │
                         │    /Sign In  │
                         └──────┬───────┘
                                │
                                ▼
                     ┌────────────────────┐
                     │ Onboarding Status  │
                     └─────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                incomplete             complete
                    │                     │
                    ▼                     ▼
              /onboarding             /dashboard
                    │
                    ▼
          ┌──────────────────────┐
          │ 1. Create Workspace │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ 2. Connect GitHub   │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ 3. Select Repository │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ 4. Configure Docs   │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ 5. Connect Sources  │
          │   Slack / Discord   │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ 6. Review Settings  │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ 7. Initialize       │
          │    Draftly          │
          └──────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │ Documentation Health │
          │      Overview        │
          └──────────┬───────────┘
                     ▼
                 Dashboard
```

The critical difference from a typical SaaS onboarding is that **Step 7 is an actual Draftly initialization process**, not a fake loading screen.

---

# 2. Step 0 — Authentication

Your current frontend already uses Clerk and has:

```text
app/(marketing)/
├── sign-in/[[...sign-in]]/
└── sign-up/[[...sign-up]]/
```

and the README currently sends both flows toward `/dashboard`.

For production, change the conceptual behavior to:

```text
Sign up
   │
   ▼
/onboarding

Sign in
   │
   ▼
onboarding status
   │
   ├── incomplete → /onboarding
   └── complete   → /dashboard
```

Do **not** permanently hard-code `/dashboard` as the post-auth destination.

---

# 3. Step 1 — Workspace creation

The first screen should establish Draftly's tenancy boundary.

```text
Create your workspace

Your workspace is where Draftly manages your project,
documentation, integrations, evaluations, and workflows.

Workspace name
[ Authly                              ]

Description
[ Authentication infrastructure       ]

                     [Continue →]
```

The underlying model should conceptually be:

```text
Organization / User
       │
       ▼
   Workspace
       │
       ├── repositories
       ├── documentation
       ├── integrations
       ├── knowledge
       ├── evaluations
       ├── reviews
       ├── workflows
       └── agents
```

This is important because Draftly is going to become a multi-tenant system.

---

# 4. Step 2 — GitHub connection

This should be the **primary onboarding integration**.

Your existing frontend already has:

```text
app/(app)/integrations/github/page.tsx
api/github.ts
components/integrations/github-detail-content.tsx
```

Reuse those underlying APIs/components rather than implementing another GitHub integration specifically for onboarding.

The onboarding screen should be simpler:

```text
Connect GitHub

Draftly needs access to your repository to understand
your codebase and keep documentation synchronized.

        ┌────────────────────────────┐
        │     Connect GitHub         │
        └────────────────────────────┘

You can disconnect GitHub at any time.
```

After OAuth:

```text
GitHub connected ✓

Signed in as @TheGreatBonnie

                    [Continue →]
```

---

# 5. Step 3 — Repository selection

After OAuth, don't immediately assume the first repository.

Fetch the accessible repositories and let the user select one.

```text
Choose your project

Which repository should Draftly manage?

Search repositories
[ authly                         ]

┌─────────────────────────────────────┐
│ ○ TheGreatBonnie/authly             │
│   Authentication infrastructure     │
│   Python · main                     │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ ○ TheGreatBonnie/other-project     │
│   ...                               │
└─────────────────────────────────────┘

                    [Continue →]
```

Then configure:

```text
Repository

TheGreatBonnie/authly

Default branch
[ main ▼ ]

Documentation directory
[ docs/ ▼ ]

[ Continue ]
```

The directory should preferably be **auto-detected**, with manual override.

---

# 6. Step 4 — Documentation discovery

This is where onboarding starts feeling like Draftly.

After repository selection:

```text
Analyzing Authly

Draftly is discovering your existing documentation.

✓ Repository connected
✓ Repository structure analyzed
✓ README detected
✓ Documentation directory detected
✓ API documentation detected
✓ Changelog detected

Found:

27 documentation sources
143 knowledge candidates
12 API references
8 guides
```

Then allow the user to confirm the scope:

```text
Documentation sources

☑ README.md
☑ docs/
☑ CONTRIBUTING.md
☑ API reference
☑ examples/

Exclude
[ + Add path ]

                         [Continue →]
```

This creates the initial **documentation inventory**.

---

# 7. Step 5 — Communication integrations

Now introduce Slack and Discord.

Your README already exposes these as separate integrations.

The onboarding UI should make them optional:

```text
Connect your team's conversations

Draftly can use engineering and support conversations
to detect documentation gaps and answer developer questions.

GitHub                         ✓ Connected

Slack                          Connect
Discord                        Connect

                 Skip for now →
```

If Slack is connected:

```text
Select Slack sources

☑ #engineering
☑ #developers
☑ #support
☐ #random

                    [Continue →]
```

Same principle for Discord:

```text
Select Discord channels

☑ #developers
☑ #help
☐ #general
```

**Do not ingest everything by default.**

Source selection is important for privacy, cost, relevance, and signal quality.

---

# 8. Step 6 — Draftly configuration

Now configure the behavior of the documentation agent.

I recommend three groups.

### Documentation behavior

```text
Documentation style

○ Technical
● Developer-focused
○ Conversational
```

### Review policy

```text
Changes requiring human review

● All documentation changes
○ Medium/high-risk changes
○ Only high-risk changes
```

### Automation

```text
Automation

☑ Detect documentation drift
☑ Evaluate documentation changes
☑ Suggest documentation updates
☐ Automatically publish low-risk changes
```

For the first experience, I'd default to **human review enabled**.

That fits the Draftly architecture we've been building and prevents an initial agent configuration from immediately modifying production documentation.

---

# 9. Step 7 — Initialization

This is the most important part.

Instead of:

```text
Loading...
```

create an actual initialization workflow.

```text
Initializing Draftly

We're building your project's documentation context.

✓ Workspace created
✓ GitHub connected
✓ Repository indexed
✓ Documentation discovered
✓ Documentation inventory created
◉ Building knowledge base
○ Running initial evaluation
○ Calculating documentation health
○ Preparing recommendations
```

Behind the scenes:

```text
Onboarding API
      │
      ▼
Initialization Workflow
      │
      ├── Repository ingestion
      │
      ├── Documentation extraction
      │
      ├── Knowledge extraction
      │
      ├── Embedding/indexing
      │
      ├── Documentation evaluation
      │
      ├── Health calculation
      │
      └── Initial recommendations
```

This should be a **durable backend workflow**, not something the browser orchestrates.

If the user closes the browser:

```text
Browser closed
      │
      ▼
Backend workflow continues
      │
      ▼
User returns
      │
      ▼
GET /onboarding/status
      │
      ▼
Resume UI
```

That is a production-level implementation.

---

# 10. Don't use a single `onboarding_completed` boolean

For Draftly, I'd use a state machine.

```text
NOT_STARTED
     │
     ▼
WORKSPACE_CREATED
     │
     ▼
GITHUB_CONNECTED
     │
     ▼
REPOSITORY_SELECTED
     │
     ▼
DOCUMENTATION_DISCOVERED
     │
     ▼
INTEGRATIONS_CONFIGURED
     │
     ▼
PREFERENCES_CONFIGURED
     │
     ▼
INITIALIZING
     │
     ├── FAILED
     │     │
     │     └── RETRY
     │     │
     └── COMPLETED
             │
             ▼
          DASHBOARD
```

Persist every transition.

This allows:

- refresh-safe onboarding;
- browser/tab recovery;
- retries;
- partial completion;
- analytics;
- debugging;
- support;
- idempotency.

---

# 11. Frontend project structure

Given the current README structure, I'd extend it to:

```text
draftly-agent-frontend/
│
├── api/
│   ├── client.ts
│   ├── discord.ts
│   ├── github.ts
│   ├── reviewers.ts
│   ├── slack.ts
│   ├── onboarding.ts              # NEW
│   └── types.ts
│
├── app/
│   │
│   ├── (marketing)/
│   │   ├── sign-in/
│   │   ├── sign-up/
│   │   └── ...
│   │
│   ├── (onboarding)/              # NEW
│   │   └── onboarding/
│   │       ├── page.tsx
│   │       ├── workspace/
│   │       │   └── page.tsx
│   │       ├── github/
│   │       │   └── page.tsx
│   │       ├── repository/
│   │       │   └── page.tsx
│   │       ├── documentation/
│   │       │   └── page.tsx
│   │       ├── integrations/
│   │       │   └── page.tsx
│   │       ├── preferences/
│   │       │   └── page.tsx
│   │       ├── initialize/
│   │       │   └── page.tsx
│   │       ├── complete/
│   │       │   └── page.tsx
│   │       └── layout.tsx
│   │
│   └── (app)/
│       ├── agents/
│       ├── dashboard/
│       ├── documentation/
│       ├── evaluations/
│       ├── integrations/
│       ├── knowledge/
│       ├── reviewers/
│       ├── reviews/
│       └── workflows/
│
├── components/
│   │
│   ├── onboarding/                # NEW
│   │   ├── onboarding-shell.tsx
│   │   ├── onboarding-header.tsx
│   │   ├── onboarding-progress.tsx
│   │   ├── onboarding-footer.tsx
│   │   ├── workspace-form.tsx
│   │   ├── github-connect.tsx
│   │   ├── repository-picker.tsx
│   │   ├── documentation-discovery.tsx
│   │   ├── documentation-sources.tsx
│   │   ├── integration-picker.tsx
│   │   ├── preferences-form.tsx
│   │   ├── initialization-progress.tsx
│   │   ├── initialization-error.tsx
│   │   └── onboarding-complete.tsx
│   │
│   ├── integrations/
│   ├── dashboard/
│   ├── documentation/
│   └── ...
│
├── lib/
│   └── onboarding/                # NEW
│       ├── constants.ts
│       ├── types.ts
│       ├── steps.ts
│       ├── validation.ts
│       └── navigation.ts
│
└── proxy.ts
```

The existing README's authenticated application structure can remain intact.

---

# 12. Use a shared onboarding shell

Every step should use the same shell.

```text
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  DRAFTLY                               Step 3 of 7      │
│                                                         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                         │
│  Choose your repository                                 │
│  Select the project Draftly should manage.              │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │                                                   │  │
│  │                 Step content                      │  │
│  │                                                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ← Back                                  Continue →     │
│                                                         │
│  You can change these settings later                   │
└─────────────────────────────────────────────────────────┘
```

Keep it visually separate from the normal dashboard sidebar.

The user should feel like they're **setting up a system**, not navigating the product.

---

# 13. Onboarding should have a server-side guard

You currently have:

```text
proxy.ts
```

for Clerk request interception.

I'd use three layers:

```text
                    Request
                       │
                       ▼
                    proxy.ts
                       │
               Is authenticated?
                  │         │
                 No        Yes
                  │         │
             /sign-in      ▼
                      application
                       │
                       ▼
               onboarding guard
                       │
              ┌────────┴────────┐
              ▼                 ▼
         incomplete          complete
              │                 │
              ▼                 ▼
        /onboarding          /dashboard
```

The guard should obtain onboarding state from the backend.

Avoid putting business logic such as "does this workspace have a repository?" directly into every React page.

---

# 14. API design

Add:

```text
api/onboarding.ts
```

with operations conceptually corresponding to:

```text
GET  /api/onboarding/status

POST /api/onboarding/workspace

POST /api/onboarding/github/connect

GET  /api/onboarding/github/repositories

POST /api/onboarding/repository

POST /api/onboarding/documentation/discover

POST /api/onboarding/sources

POST /api/onboarding/preferences

POST /api/onboarding/initialize

GET  /api/onboarding/initialize/status

POST /api/onboarding/initialize/retry

POST /api/onboarding/complete
```

The frontend API client should use the existing `api/client.ts` authentication mechanism rather than implementing separate token handling. The README explicitly identifies `api/client.ts` as the base client responsible for token handling and request wrapping.

---

# 15. Make every onboarding operation idempotent

This is critical.

Imagine the user clicks:

```text
[Start synchronization]
```

twice.

You don't want:

```text
Sync #1
Sync #2
Sync #3
```

running against the same repository.

Instead:

```text
POST initialize
        │
        ▼
Existing initialization?
   │              │
  Yes             No
   │               │
   ▼               ▼
Return existing   Create
workflow ID       workflow
```

The same principle applies to:

- GitHub connection;
- repository registration;
- documentation discovery;
- knowledge indexing;
- initialization;
- onboarding completion.

---

# 16. The initialization screen should expose real workflow state

Because Draftly already has a dedicated **Workflows** area, initialization can eventually become a specialized workflow execution.

The README already contains:

```text
components/workflows/
├── active-execution.tsx
├── artifacts-panel.tsx
├── event-log.tsx
├── execution-graph.tsx
├── stage-pipeline.tsx
├── workflow-detail.tsx
└── ...
```

That is extremely useful.

Instead of creating a completely separate workflow visualization, onboarding can use a simplified version of the existing execution infrastructure:

```text
Initialize Authly

Repository ingestion          ✓
Documentation extraction      ✓
Knowledge construction         ◉
Vector indexing                ◯
Initial evaluation             ◯
Health report                  ◯
```

Eventually, the completed initialization can link directly to the full workflow:

> **View initialization workflow →**

---

# 17. Completion screen

Don't just redirect to the dashboard.

Give the user a useful summary:

```text
You're ready 🎉

Draftly is now monitoring:

Authly
TheGreatBonnie/authly
main

Documentation
27 sources

Knowledge
143 entries

Initial health
87%

Potential improvements
8

GitHub
Connected

Slack
Connected

Discord
Not connected


              [Open Dashboard]
```

This gives the dashboard a meaningful starting state.

---

# 18. What happens after onboarding

The important lifecycle is:

```text
                    ONBOARDING
                        │
                        ▼
                 Initial baseline
                        │
                        ▼
              ┌──────────────────┐
              │ Draftly monitors  │
              │ project evolution │
              └────────┬─────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
      GitHub          Slack         Discord
        │              │              │
        └──────────────┼──────────────┘
                       ▼
                  Signal intake
                       │
                       ▼
                  Context graph
                       │
                       ▼
                 Agent workflow
                       │
                       ▼
                  Evaluation
                       │
                       ▼
                 Human review
                       │
                       ▼
                 Documentation
                       │
                       ▼
                    Delivery
```

This is why onboarding should establish the **initial context and baseline**, not just collect preferences.

---

# 19. Production failure handling

Every step needs explicit failure states.

For example:

### GitHub OAuth fails

```text
We couldn't connect GitHub.

Your authorization wasn't completed.

[Try again]
```

### Repository unavailable

```text
Repository unavailable

Draftly can no longer access this repository.

[Reconnect GitHub]
```

### Documentation discovery fails

```text
We couldn't finish analyzing the repository.

Your repository is still connected.

[Retry]
[Continue manually]
```

### Initialization fails

```text
Initialization paused

Draftly couldn't complete the initial analysis.

Your workspace and GitHub connection are safe.

Error:
Documentation indexing timed out.

[Retry initialization]
[View details]
```

Never leave the user stuck on an infinite spinner.

---

# 20. Resume behavior

Production onboarding must support:

```text
User starts onboarding
       │
       ▼
Step 4
       │
       ▼
Browser closes
       │
       ▼
Two days later
       │
       ▼
Sign in
       │
       ▼
"Continue setting up Authly"
       │
       ▼
Step 4
```

The onboarding landing page should therefore inspect server state and say:

```text
Welcome back

Your Authly workspace is almost ready.

GitHub             ✓
Repository         ✓
Documentation      ✓
Integrations       ◉
Initialization     ○

[Continue setup]
```

---

# 21. Skip behavior

Don't allow users to skip **everything**.

Recommended:

| Step                    | Required?     |
| ----------------------- | ------------- |
| Workspace               | Yes           |
| GitHub                  | Yes           |
| Repository              | Yes           |
| Documentation discovery | Yes           |
| Slack                   | No            |
| Discord                 | No            |
| Preferences             | No — defaults |
| Initialization          | Yes           |

So the minimum onboarding path is:

```text
Workspace
   ↓
GitHub
   ↓
Repository
   ↓
Documentation discovery
   ↓
Initialization
   ↓
Dashboard
```

That is only five meaningful actions.

---

# 22. The key architectural rule

I would structure Draftly onboarding around this principle:

> **The frontend owns the onboarding experience; the backend owns onboarding truth.**

Meaning:

```text
Frontend
────────
UI
Navigation
Forms
Progress
Loading states
Error states
Optimistic UX

Backend
───────
Workspace state
Integration state
Repository state
Documentation inventory
Initialization workflow
Progress
Retries
Idempotency
Completion state
```

Never make the frontend the source of truth.

---

# 23. Recommended final architecture

Putting everything together:

```text
                         CLERK
                           │
                           ▼
                    Authentication
                           │
                           ▼
                    Onboarding Guard
                           │
                           ▼
                 ┌───────────────────┐
                 │    ONBOARDING     │
                 │                   │
                 │ Workspace         │
                 │      ↓            │
                 │ GitHub             │
                 │      ↓            │
                 │ Repository         │
                 │      ↓            │
                 │ Documentation     │
                 │      ↓            │
                 │ Integrations      │
                 │      ↓            │
                 │ Preferences       │
                 └────────┬──────────┘
                          │
                          ▼
                 Initialization API
                          │
                          ▼
                Durable Workflow Engine
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
      Repository      Documentation    Integrations
       Ingestion       Processing       Processing
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                   Knowledge Layer
                          │
                          ▼
                    Initial Eval
                          │
                          ▼
                  Documentation Health
                          │
                          ▼
                    ONBOARDING COMPLETE
                          │
                          ▼
                      DASHBOARD
```

## What I would build for Draftly

For the **production version**, I would therefore implement onboarding as a dedicated bounded frontend feature:

```text
app/(onboarding)/
components/onboarding/
api/onboarding.ts
lib/onboarding/
```

backed by a persistent onboarding state machine and a durable initialization workflow.

The most important design decision is **not to make onboarding a collection of seven client-side pages**. It should be the **guided UI for initializing a Draftly workspace**, with GitHub/repository discovery and the first documentation-analysis workflow forming the core of the experience.

That also makes the Authly scenario particularly strong: when you connect the Authly GitHub repository, onboarding can genuinely discover its existing docs, construct the initial knowledge context, run the first evaluation, and hand the user a populated Draftly dashboard rather than an empty SaaS shell.
