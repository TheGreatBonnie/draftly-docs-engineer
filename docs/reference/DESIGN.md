# Draftly Onboarding — UI Design Specification

## 1. Overview

The Draftly onboarding experience guides a new user from an authenticated account to a fully initialized documentation workspace.

The onboarding should not feel like a generic SaaS setup wizard.

It should communicate that Draftly is actively:

- connecting to the user's software project;
- understanding the repository;
- discovering existing documentation;
- connecting engineering communication sources;
- configuring documentation automation;
- building the initial project context;
- evaluating documentation health.

The onboarding flow consists of seven primary pages:

1. Workspace
2. Connect GitHub
3. Select Repository
4. Discover Documentation
5. Connect Sources
6. Configure Draftly
7. Initialize Draftly

After initialization completes, the user is taken to the documentation health / dashboard experience.

---

# 2. Design Principles

## 2.1 Product-first

Every onboarding screen should reinforce Draftly's core value:

> Draftly understands how your software evolves and keeps your documentation aligned with it.

Avoid unnecessary profile questions, surveys, or marketing content.

---

## 2.2 Developer-focused

Draftly is a developer tool.

The interface should feel closer to:

- Vercel
- Linear
- GitHub
- modern developer platforms

than to a consumer onboarding wizard.

Use technical information as useful visual content:

- repository names;
- branches;
- documentation paths;
- source counts;
- indexing status;
- evaluation status;
- documentation health.

---

## 2.3 Progressive disclosure

Only expose information required for the current step.

Do not overwhelm the user with:

- advanced configuration;
- agent settings;
- workflow configuration;
- evaluation configuration;
- model configuration.

Those belong in the main application.

---

## 2.4 Safe defaults

The user should be able to complete onboarding without understanding Draftly's entire configuration model.

The user should primarily have to:

1. create a workspace;
2. connect GitHub;
3. select a repository;
4. confirm documentation sources;
5. optionally connect communication sources;
6. confirm Draftly behavior;
7. initialize.

---

## 2.5 Transparent automation

Whenever Draftly performs an operation, show what is happening.

Avoid generic:

> Loading...

Prefer:

> Analyzing repository structure

> Discovering documentation

> Building knowledge context

> Running initial evaluation

This is particularly important for AI-powered operations.

---

## 2.6 Persistent state

Onboarding must be resumable.

If the user:

- refreshes the page;
- closes the browser;
- loses connection;
- signs out;
- returns later;

their onboarding progress must remain available.

The frontend should reflect server-side onboarding state rather than treating React state as the source of truth.

---

# 3. Overall Flow

```text
Authentication
      │
      ▼
┌──────────────────┐
│ 1. Workspace     │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 2. GitHub        │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 3. Repository    │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 4. Documentation │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 5. Sources       │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 6. Configure     │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 7. Initialize    │
└────────┬─────────┘
         ▼
┌────────────────────────┐
│ Documentation Health   │
└────────────┬───────────┘
             ▼
         Dashboard
```

---

# 4. Onboarding Shell

All seven pages use the same onboarding shell.

## Layout

```text
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  DRAFTLY                              Step 3 of 7           │
│                                                             │
│  ●━━━━━━━━●━━━━━━━━●━━━━━━━━○━━━━━━━━○━━━━━━━━○━━━━━━━━○  │
│                                                             │
│                                                             │
│                 Page heading                               │
│                 Supporting description                      │
│                                                             │
│             ┌─────────────────────────────┐                 │
│             │                             │                 │
│             │       Page content         │                 │
│             │                             │                 │
│             └─────────────────────────────┘                 │
│                                                             │
│                                                             │
│  ← Back                                      Continue →     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Shell requirements

- Full viewport height.
- Centered content.
- Maximum content width: `960px`.
- Primary content width: `680px–760px`.
- Generous vertical spacing.
- No dashboard sidebar.
- No application navigation.
- Draftly logo/wordmark at top.
- Step indicator below header.
- Primary action aligned bottom-right.
- Secondary/back action aligned bottom-left.
- Responsive on desktop, tablet, and mobile.

## Background

Use the same base background as the Draftly application.

Avoid large decorative gradients.

A very subtle background treatment is acceptable, but content must remain dominant.

---

# 5. Step Indicator

The onboarding progress indicator communicates where the user is in the setup process.

```text
●━━━━━━━━●━━━━━━━━●━━━━━━━━○━━━━━━━━○━━━━━━━━○━━━━━━━━○
1        2        3        4        5        6        7
```

States:

### Completed

- Filled circle.
- Primary accent.
- Connecting line marked complete.

### Current

- Filled or emphasized circle.
- Primary accent.
- Slight visual emphasis.

### Upcoming

- Neutral outline.
- Muted text.

### Failed

- Error indicator.
- Do not silently advance.

The progress indicator should not imply that optional steps are mandatory if they can be skipped.

---

# 6. Step 1 — Workspace

## Purpose

Create the Draftly workspace that will contain:

- repositories;
- documentation;
- integrations;
- knowledge;
- evaluations;
- reviews;
- workflows.

## Page heading

**Create your workspace**

Supporting text:

> Your workspace is where Draftly manages your project, documentation, integrations, and automation.

## Layout

```text
                 Create your workspace

       Your workspace is where Draftly manages
       your project and documentation.

       Workspace name

       ┌─────────────────────────────────────────┐
       │ Authly                                  │
       └─────────────────────────────────────────┘

       Description (optional)

       ┌─────────────────────────────────────────┐
       │ Authentication infrastructure           │
       │                                         │
       └─────────────────────────────────────────┘


                                  Continue →
```

## Fields

### Workspace name

Required.

Placeholder:

```text
e.g. Authly
```

### Description

Optional.

Placeholder:

```text
What does this project do?
```

## Validation

Workspace name:

- required;
- trimmed;
- reasonable length limit;
- no whitespace-only values.

Continue should remain disabled until the required field is valid.

## Interaction

On submit:

1. Create workspace.
2. Persist onboarding state.
3. Move to GitHub step.

The operation must be idempotent.

If a workspace already exists for the current onboarding session, do not create another one.

---

# 7. Step 2 — Connect GitHub

## Purpose

Connect GitHub because Draftly's primary source of truth is the software repository.

## Page heading

**Connect GitHub**

Supporting text:

> Give Draftly access to your codebase so it can understand how your project evolves and keep your documentation synchronized.

## Primary UI

```text
                    Connect GitHub

        Draftly works by understanding your
        repository and documentation.

        ┌───────────────────────────────────────┐
        │                                       │
        │               GitHub                  │
        │                                       │
        │       Connect your GitHub account     │
        │                                       │
        │          [ Connect GitHub ]           │
        │                                       │
        └───────────────────────────────────────┘

        Draftly only accesses repositories
        you authorize.
```

## Connected state

```text
                    GitHub connected

        ✓ GitHub account connected

        @username

        Draftly can now access your
        authorized repositories.

                            Continue →
```

## Loading state

```text
              Connecting to GitHub...

              ◌ Opening authorization
```

## Error state

```text
              GitHub connection failed

        We couldn't complete the GitHub
        authorization.

                 [Try again]
```

## Security messaging

Keep security copy concise.

Use:

> Draftly only accesses repositories you authorize.

Do not overload the page with OAuth implementation details.

---

# 8. Step 3 — Select Repository

## Purpose

Choose the software project Draftly will manage.

## Page heading

**Choose your repository**

Supporting text:

> Select the project Draftly should monitor and keep documented.

## Layout

```text
                    Choose your repository

        Select the project Draftly should manage.

        ┌───────────────────────────────────────┐
        │ 🔍  Search repositories               │
        └───────────────────────────────────────┘


        YOUR REPOSITORIES

        ┌───────────────────────────────────────┐
        │ ●  TheGreatBonnie / authly            │
        │                                       │
        │    Authentication infrastructure      │
        │                                       │
        │    Python · main · Updated 2h ago     │
        └───────────────────────────────────────┘

        ┌───────────────────────────────────────┐
        │ ○  TheGreatBonnie / relayops          │
        │                                       │
        │    Infrastructure automation          │
        │                                       │
        │    Python · main · Updated yesterday  │
        └───────────────────────────────────────┘
```

## Repository card

Each card should contain:

- selection indicator;
- repository name;
- owner;
- description;
- primary language;
- default branch;
- optional last-updated metadata.

## Selected state

Selected repository:

- primary border;
- subtle background;
- filled radio/selection indicator.

Do not use excessive shadows.

## Search

Search should filter repositories client-side where possible.

For large repository lists, use server-side search/pagination.

## Empty state

```text
                 No repositories found

        We couldn't find a repository matching
        your search.

                    [Clear search]
```

## No accessible repositories

```text
             No repositories available

        Your GitHub account doesn't currently
        have access to repositories Draftly can use.

                 [Reconnect GitHub]
```

## Continue

Disabled until a repository is selected.

---

# 9. Step 4 — Discover Documentation

This is the first distinctly Draftly-specific onboarding experience.

## Purpose

Analyze the selected repository and discover existing documentation.

Draftly should identify potential sources such as:

- README files;
- `docs/`;
- contributing guides;
- API references;
- tutorials;
- examples;
- changelogs;
- architecture documentation.

## Page heading

**Discover your documentation**

Supporting text:

> Draftly is analyzing your repository to understand your existing documentation.

## Analysis state

```text
                  Discovering your documentation

        Draftly is analyzing Authly.

        ┌────────────────────────────────────────┐
        │                                        │
        │ ✓ Repository structure                 │
        │ ✓ README.md                            │
        │ ✓ Documentation directory              │
        │ ✓ API reference                        │
        │ ◉ Documentation relationships           │
        │ ○ Knowledge candidates                  │
        │                                        │
        └────────────────────────────────────────┘

                    27 sources discovered
```

## Progress states

Possible states:

```text
queued
scanning
discovering
analyzing
completed
failed
```

Do not fabricate progress percentages.

Show actual known state.

## Results state

```text
              We found 27 documentation sources

        Review what Draftly should manage.

        ┌────────────────────────────────────────┐
        │ ☑ README.md                            │
        │ ☑ docs/                                │
        │ ☑ CONTRIBUTING.md                      │
        │ ☑ API reference                        │
        │ ☑ examples/                            │
        └────────────────────────────────────────┘

        + Add exclusion

        Draftly will use these sources to build
        your initial documentation context.
```

## Source selection

Every discovered source can be:

- included;
- excluded.

Allow path exclusions.

Example:

```text
Ignore:
┌──────────────────────────────┐
│ node_modules/                │
└──────────────────────────────┘
```

## Important behavior

The browser must not perform the repository analysis itself.

The backend should perform discovery and return persisted results.

The user can safely refresh the page.

---

# 10. Step 5 — Connect Sources

## Purpose

Connect additional communication sources that provide context about engineering and developer-support conversations.

Primary optional sources:

- Slack;
- Discord.

GitHub remains connected from Step 2.

## Page heading

**Connect your team's sources**

Supporting text:

> Draftly can learn from the conversations where engineering and support happen.

## Layout

```text
               Connect your team's sources

        Choose where Draftly should gather
        additional project context.


        ┌────────────────────────────────────────┐
        │ GitHub                                 │
        │ Repository changes and issues          │
        │                              ✓ Connected│
        └────────────────────────────────────────┘


        ┌────────────────────────────────────────┐
        │ Slack                                  │
        │ Engineering and support conversations │
        │                             [Connect]  │
        └────────────────────────────────────────┘


        ┌────────────────────────────────────────┐
        │ Discord                                │
        │ Developer community conversations     │
        │                             [Connect]  │
        └────────────────────────────────────────┘


                         Skip for now →
```

## Integration card states

### Disconnected

```text
Connect
```

### Connecting

```text
Connecting...
```

### Connected

```text
✓ Connected
```

### Error

```text
Connection failed
[Retry]
```

## Slack channel selection

After Slack connection:

```text
                 Choose Slack sources

        Select the conversations Draftly should monitor.

        🔍 Search channels


        ENGINEERING

        ☑ #engineering
        ☑ #developers
        ☐ #backend
        ☐ #frontend


        SUPPORT

        ☑ #support
        ☐ #customer-success


        Draftly won't access channels you don't select.
```

## Discord channel selection

Use the same interaction model.

## Privacy

Clearly communicate scope:

> Draftly won't access channels you don't select.

Never imply Draftly has access to all conversations when only selected channels are authorized.

---

# 11. Step 6 — Configure Draftly

## Purpose

Give the user a small amount of control over Draftly behavior without exposing the complete agent configuration system.

## Page heading

**Configure Draftly**

Supporting text:

> Choose how Draftly should work with your team.

---

## Documentation style

Use selectable cards.

```text
Documentation style

┌────────────────────┐  ┌────────────────────┐
│ Technical          │  │ Developer-focused  │
│                    │  │              ✓     │
│ Detailed and       │  │ Clear, direct,     │
│ precise            │  │ practical          │
└────────────────────┘  └────────────────────┘
```

Recommended default:

**Developer-focused**

---

## Review policy

```text
Review policy

◉ Always require review

○ Review medium/high-risk changes

○ Automatically publish low-risk changes
```

Recommended onboarding default:

**Always require review**

This establishes a safe initial automation posture.

---

## Automation

```text
Automation

☑ Detect documentation drift
☑ Evaluate documentation
☑ Suggest documentation improvements
```

Avoid exposing advanced workflow configuration here.

---

## Advanced configuration

Do not expose:

- model selection;
- agent routing;
- evaluation thresholds;
- memory configuration;
- workflow graph configuration;
- prompt configuration.

Those belong to the main application or administrative settings.

---

# 12. Step 7 — Initialize Draftly

This is the most important onboarding page.

## Purpose

Initialize the workspace using the repository and selected sources.

The page must represent an actual backend workflow.

It must not be a decorative loading screen.

## Page heading

**Setting up Draftly**

Supporting text:

> We're building an understanding of your project and documentation.

## Layout

```text
                    Setting up Draftly

        We're building an understanding of Authly.

        ┌────────────────────────────────────────────┐
        │                                            │
        │ ✓ Workspace created                        │
        │ ✓ GitHub connected                         │
        │ ✓ Repository indexed                       │
        │ ✓ Documentation discovered                 │
        │ ◉ Building knowledge context                │
        │ ○ Running initial evaluation                │
        │ ○ Calculating documentation health          │
        │                                            │
        │                                            │
        │  ━━━━━━━━━━━━━━━━━━━━━━━░░░░░░              │
        │                                            │
        └────────────────────────────────────────────┘

        You can safely leave this page.
        Draftly will continue processing in the background.
```

## Initialization stages

Recommended stages:

```text
workspace
repository
repository_ingestion
documentation_discovery
documentation_indexing
knowledge_construction
vector_indexing
initial_evaluation
health_calculation
recommendations
completed
```

The UI should map backend states into human-readable labels.

Example:

```text
repository_ingestion
→ Indexing repository

knowledge_construction
→ Building project context

initial_evaluation
→ Evaluating documentation

health_calculation
→ Calculating documentation health
```

Never expose internal agent names or implementation details.

---

# 13. Initialization Failure

Never leave the user on an indefinite spinner.

## Error UI

```text
                 Initialization paused

        Draftly couldn't complete the initial
        project analysis.

        Your workspace and GitHub connection
        are safe.

        Error
        Documentation indexing timed out.


        [Retry initialization]

        View technical details
```

## Retry behavior

Retries must be idempotent.

Do not start duplicate initialization workflows.

If an existing initialization workflow is retryable, resume or retry that workflow.

---

# 14. Initialization Completion

When initialization completes, transition to a completion summary.

This can be rendered at the bottom of Step 7 or as a dedicated completion state.

## Layout

```text
                  Authly is ready.

        Draftly is now watching your project.


        ┌────────────────┐  ┌────────────────┐
        │ 27             │  │ 143            │
        │ Sources        │  │ Knowledge      │
        └────────────────┘  └────────────────┘


        ┌────────────────┐  ┌────────────────┐
        │ 87%            │  │ 8              │
        │ Health         │  │ Opportunities  │
        └────────────────┘  └────────────────┘


        GitHub                       ✓ Connected
        Documentation                27 sources
        Knowledge                    143 entries


                    [Open Dashboard]
```

The metrics must come from the actual initialization result.

Do not use placeholder metrics in production.

---

# 15. Navigation Rules

## Back

Users may navigate backward through completed configuration steps.

However, changing an earlier step may invalidate later state.

Example:

```text
Repository changed
      ↓
Documentation discovery invalidated
      ↓
Initialization invalidated
```

The UI should clearly communicate this.

Example:

> Changing the repository will require Draftly to rediscover your documentation.

---

## Continue

Continue should:

1. validate the current step;
2. persist the step state;
3. perform the required backend action;
4. update onboarding state;
5. navigate to the next valid step.

Do not navigate optimistically when the server operation is required for correctness.

---

## Skip

Optional steps should use:

```text
Skip for now →
```

rather than:

```text
Skip
```

This communicates that the feature can be configured later.

---

# 16. Responsive Design

## Desktop

Primary target:

```text
1440 × 900
```

Use:

- centered content;
- maximum width;
- generous whitespace;
- large repository/source cards.

## Tablet

Collapse horizontal content.

Cards become full-width.

## Mobile

Use:

```text
100% viewport width
16px–24px horizontal padding
```

Progress indicator can become:

```text
Step 3 of 7
━━━━━━━━━━━━━━
```

rather than seven circles.

Buttons become full-width when appropriate.

---

# 17. Accessibility

All onboarding pages must support:

- keyboard navigation;
- visible focus states;
- semantic headings;
- accessible form labels;
- screen-reader status updates;
- sufficient contrast;
- disabled-state communication;
- accessible modal/dialog behavior.

For long-running initialization:

Use an accessible live region for status updates.

Example:

```text
aria-live="polite"
```

Status updates should communicate:

> Building knowledge context.

rather than continuously changing numerical percentages.

---

# 18. Motion

Motion should be subtle.

Use animation for:

- page transitions;
- step completion;
- progress state;
- repository selection;
- initialization status.

Avoid:

- excessive parallax;
- bouncing elements;
- large animated backgrounds;
- distracting AI effects.

Recommended transition duration:

```text
150ms–250ms
```

---

# 19. Visual Language

## Colors

Use Draftly's existing product palette.

Primary:

```text
#2563EB
```

Secondary:

```text
#4F46E5
```

Cyan:

```text
#06B6D4
```

Success:

```text
#10B981
```

Use neutral slate tones for:

- borders;
- secondary text;
- backgrounds;
- disabled controls.

Color should communicate state, not decorate every component.

---

# 20. Typography

Use the existing Draftly typography system.

Recommended hierarchy:

```text
Page heading:
32–40px
font-weight: 600

Page description:
15–17px
line-height: 1.6

Section heading:
18–20px
font-weight: 600

Body:
14–15px

Label:
13–14px
font-weight: 500

Metadata:
12–13px
```

Keep headings short.

Examples:

Good:

> Choose your repository

Avoid:

> Let's get started by selecting the GitHub repository that you would like Draftly to use for managing your documentation

---

# 21. Components

Create a dedicated onboarding component system.

```text
components/
└── onboarding/
    ├── onboarding-shell.tsx
    ├── onboarding-header.tsx
    ├── onboarding-progress.tsx
    ├── onboarding-footer.tsx
    ├── workspace-form.tsx
    ├── github-connect.tsx
    ├── repository-picker.tsx
    ├── repository-card.tsx
    ├── documentation-discovery.tsx
    ├── documentation-source-list.tsx
    ├── integration-card.tsx
    ├── source-selector.tsx
    ├── preferences-form.tsx
    ├── initialization-progress.tsx
    ├── initialization-error.tsx
    └── onboarding-complete.tsx
```

Components should be reusable and independent from page routing.

---

# 22. Frontend State

Create:

```text
lib/
└── onboarding/
    ├── types.ts
    ├── steps.ts
    ├── navigation.ts
    ├── validation.ts
    └── constants.ts
```

The frontend should represent server state such as:

```ts
type OnboardingStatus =
  | "not_started"
  | "workspace_created"
  | "github_connected"
  | "repository_selected"
  | "documentation_discovered"
  | "sources_configured"
  | "preferences_configured"
  | "initializing"
  | "completed"
  | "failed";
```

The backend remains the source of truth.

---

# 23. API

Create:

```text
api/
└── onboarding.ts
```

Conceptual API operations:

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

The API should use the existing authenticated API client.

---

# 24. Routing

Recommended route structure:

```text
app/
├── (marketing)/
│
├── (onboarding)/
│   └── onboarding/
│       ├── page.tsx
│       ├── workspace/
│       │   └── page.tsx
│       ├── github/
│       │   └── page.tsx
│       ├── repository/
│       │   └── page.tsx
│       ├── documentation/
│       │   └── page.tsx
│       ├── sources/
│       │   └── page.tsx
│       ├── configure/
│       │   └── page.tsx
│       ├── initialize/
│       │   └── page.tsx
│       └── layout.tsx
│
└── (app)/
    ├── dashboard/
    ├── documentation/
    ├── evaluations/
    ├── integrations/
    ├── knowledge/
    ├── reviewers/
    ├── reviews/
    └── workflows/
```

---

# 25. Route Protection

Authentication and onboarding state are separate concerns.

Flow:

```text
Request
   │
   ▼
Authenticated?
   │
   ├── No ──────► Sign in
   │
   └── Yes
        │
        ▼
   Onboarding complete?
        │
        ├── No ─────► /onboarding
        │
        └── Yes ────► /dashboard
```

Do not put complex onboarding business logic inside authentication middleware.

The backend should determine onboarding state.

---

# 26. Persistence Requirements

Persist:

```text
workspace_id

current_step

completed_steps

github_connection_id

repository_id

repository_branch

documentation_sources

source_connections

source_channels

documentation_preferences

initialization_workflow_id

initialization_status

initialization_error

completed_at
```

The exact database schema belongs to the backend architecture.

The frontend should consume the resulting API model.

---

# 27. Idempotency

Every onboarding operation must be safe to retry.

Examples:

```text
Create workspace
Connect GitHub
Register repository
Discover documentation
Create source configuration
Initialize project
Complete onboarding
```

The user should never accidentally create duplicate:

- workspaces;
- repository registrations;
- integrations;
- initialization workflows.

---

# 28. Onboarding Guard

If the user enters:

```text
/dashboard
```

before completing onboarding:

```text
/dashboard
     │
     ▼
onboarding incomplete
     │
     ▼
/onboarding
```

If onboarding is complete:

```text
/onboarding
     │
     ▼
completed
     │
     ▼
/dashboard
```

The redirect should preserve intended destinations where appropriate.

---

# 29. Error Handling

Every asynchronous operation must have:

1. loading state;
2. success state;
3. failure state;
4. retry action;
5. useful user-facing message.

Never show raw backend exceptions by default.

Instead:

```text
We couldn't connect to GitHub.
```

rather than:

```text
OAuthCallbackError: invalid_grant...
```

Technical details can be available through:

```text
View technical details
```

for debugging.

---

# 30. Analytics

Track onboarding events for product observability.

Suggested events:

```text
onboarding_started

workspace_created

github_connect_started
github_connected
github_connection_failed

repository_selection_started
repository_selected

documentation_discovery_started
documentation_discovery_completed
documentation_discovery_failed

source_connection_started
source_connected

preferences_completed

initialization_started
initialization_completed
initialization_failed

onboarding_completed
```

Also track:

```text
time_to_complete
step_duration
step_abandonment
retry_count
```

Do not collect sensitive repository contents through analytics.

---

# 31. Design Anti-Patterns

Avoid:

### Generic SaaS wizard

```text
Welcome!
Tell us about yourself...
What's your role?
What's your team size?
What's your industry?
```

These questions do not contribute directly to Draftly initialization.

### Fake progress

Do not show:

```text
87%
```

if there is no meaningful underlying progress signal.

### Infinite spinner

Every asynchronous operation needs a timeout/error state and recovery path.

### Giant marketing illustrations

The onboarding should demonstrate Draftly through real project information.

### Overconfiguration

Do not expose the entire Draftly agent architecture during onboarding.

### Frontend-only state

Do not make local React state the source of truth.

### Browser-controlled initialization

Do not orchestrate repository ingestion, indexing, evaluation, and knowledge construction through a chain of browser requests.

The backend owns the workflow.

---

# 32. Final Experience

The user should experience Draftly as:

```text
I created a workspace
        ↓
I connected my GitHub
        ↓
Draftly found my project
        ↓
Draftly discovered my existing docs
        ↓
I chose additional sources
        ↓
I told Draftly how I want it to behave
        ↓
Draftly analyzed my project
        ↓
Draftly evaluated my documentation
        ↓
I received a documentation health report
        ↓
My dashboard is already populated
```

The key emotional transition is:

```text
EMPTY ACCOUNT
      │
      ▼
CONNECTED PROJECT
      │
      ▼
UNDERSTOOD PROJECT
      │
      ▼
EVALUATED PROJECT
      │
      ▼
ACTIONABLE DOCUMENTATION
```

That is the core design goal of Draftly onboarding.
