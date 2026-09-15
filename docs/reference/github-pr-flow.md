Yes. With the **actual Draftly structure** and the simulated **Authly PR #101**, we can trace one complete production flow rather than discussing the architecture abstractly.

The simulated PR is:

> `feat: add OAuth authentication`

It adds OAuth authorization URL generation, GitHub/Google providers, callback handling, authorization-code exchange, and OAuth configuration. It affects several source files and explicitly identifies five documentation areas as likely affected. It also contains two important review comments: redirect-URI configuration is undocumented, and the SDK example should demonstrate the complete OAuth flow.

The complete Draftly flow should therefore look like this:

```text
GitHub PR #101
      │
      ▼
GitHub webhook
      │
      ▼
API / webhook validation
      │
      ▼
Event normalization
      │
      ▼
Event dispatch
      │
      ▼
GitHub PR workflow
      │
      ▼
Documentation Graph
      │
      ├── Analyze PR
      ├── Inspect diff
      ├── Map code → docs
      ├── Retrieve existing knowledge
      ├── Research repository/history
      ├── Generate documentation changes
      ├── Evaluate changes
      │
      ▼
Human review
      │
      ├── Reject → revise
      │
      └── Approve
            │
            ▼
      Create documentation PR
            │
            ▼
      Documentation merged
            │
            ▼
      Update Draftly memory
            │
            ▼
      Documentation intelligence
```

---

# 1. PR #101 enters Draftly

The process begins outside Draftly.

Authly's GitHub repository receives PR #101:

```text
feat: add OAuth authentication
```

The PR says the change introduces:

- OAuth authorization URL generation
- GitHub and Google providers
- OAuth callback handling
- authorization-code exchange
- OAuth configuration

It affects:

```text
src/authly/oauth.py
src/authly/auth.py
src/authly/client.py
tests/test_oauth.py
```

and potentially:

```text
docs/oauth.md
docs/authentication.md
docs/getting-started.md
docs/troubleshooting.md
docs/security.md
```

The PR is already merged, so in a real deployment Draftly could receive this either from the PR event itself or from the corresponding merge/release event.

### Draftly files involved

```text
src/draftly/api/routes/webhooks.py
src/draftly/integrations/github/webhooks.py
src/draftly/events/github/pull_request.py
```

---

# 2. GitHub sends the webhook

GitHub sends something conceptually like:

```json
{
  "action": "closed",
  "pull_request": {
    "number": 101,
    "title": "feat: add OAuth authentication",
    "merged": true
  },
  "repository": {
    "name": "authly"
  }
}
```

Draftly does **not** immediately start the AI workflow inside the HTTP request.

Instead:

```text
GitHub
   │
   ▼
POST /webhooks/github
   │
   ▼
validate
   │
   ▼
normalize
   │
   ▼
dispatch event
   │
   ▼
202 Accepted
```

### Files

**`src/draftly/api/routes/webhooks.py`**

Receives the HTTP request.

**`src/draftly/integrations/github/webhooks.py`**

Handles GitHub webhook-specific processing.

**`src/draftly/security/webhook_verification.py`**

Verifies that the webhook actually came from GitHub.

**`src/draftly/api/middleware/request_id.py`**

Creates a request/correlation ID.

**`src/draftly/observability/tracing.py`**

Starts the trace.

---

# 3. GitHub event becomes a Draftly event

Draftly should never make the rest of the application understand GitHub's raw webhook schema.

Instead:

```text
GitHub payload
      │
      ▼
GitHubPullRequestEvent
```

The event might conceptually contain:

```python
{
    "event_id": "...",
    "event_type": "github.pull_request",
    "project_id": "authly",
    "repository": "authly",
    "pull_request_number": 101,
    "action": "merged",
    "commit_sha": "...",
    "correlation_id": "..."
}
```

### Files

```text
events/base.py
events/types.py
events/envelope.py
events/github/pull_request.py
```

### Why these files exist

`base.py`

Defines common event behavior.

`types.py`

Defines event types such as:

```text
GITHUB_PULL_REQUEST
GITHUB_ISSUE
GITHUB_RELEASE
SLACK_SUPPORT
DISCORD_SUPPORT
```

`envelope.py`

Wraps the event with metadata.

`github/pull_request.py`

Converts GitHub's webhook payload into Draftly's internal PR event.

---

# 4. Event dispatcher decides what workflow to run

The normalized event reaches:

```text
src/draftly/events/dispatcher.py
```

The dispatcher effectively asks:

> "What Draftly workflow handles `github.pull_request`?"

The workflow registry answers:

```text
github.pull_request
        ↓
github_pr_workflow
```

### Files

```text
events/dispatcher.py
workflows/registry.py
workflows/runner.py
```

The separation is important:

```text
dispatcher
    ↓
find workflow

registry
    ↓
identify workflow

runner
    ↓
execute workflow
```

---

# 5. GitHub PR workflow starts

The selected workflow is:

```text
src/draftly/workflows/documentation/github_pr_workflow.py
```

This is the **business workflow**.

It doesn't contain every AI operation itself.

Instead, it prepares the workflow state and launches:

```text
orchestration/graphs/documentation_graph.py
```

Conceptually:

```text
GitHub PR Workflow
        │
        ▼
Documentation Graph
```

### Files

```text
workflows/documentation/github_pr_workflow.py
workflows/state.py
orchestration/graphs/documentation_graph.py
orchestration/state/documentation.py
```

The state might start as:

```python
{
    "project_id": "authly",
    "repository": "authly",
    "pr_number": 101,
    "commit_sha": "...",
    "event": ...,
    "documentation_candidates": [],
    "research": [],
    "draft": None,
    "evaluation": None,
    "review": None
}
```

---

# 6. The Documentation Graph takes control

Now we enter the **Strands multi-agent orchestration layer**.

The graph is:

```text
src/draftly/orchestration/graphs/documentation_graph.py
```

The graph coordinates:

```text
Analyze
   ↓
Retrieve
   ↓
Research
   ↓
Generate
   ↓
Evaluate
   ↓
Review
   ↓
Publish
```

The graph itself doesn't necessarily perform the intelligence.

It connects the appropriate nodes.

In Strands, each node **is** an executor — an `Agent`, a `Swarm`, or a custom
`MultiAgentBase` subclass — registered via `builder.add_node(executor, node_id)`.
The `orchestration/nodes/*.py` files are thin composition wrappers around the
`agents/*.py` definitions; they are not separate SDK constructs.

---

# 7. Node 1 — Analyze the PR

First:

```text
orchestration/nodes/analyze.py
```

This node invokes:

```text
agents/github/pr_analyzer.py
```

or, depending on the final implementation, the documentation analyzer:

```text
agents/documentation/analyzer.py
```

The agent receives PR #101.

It determines:

```text
Feature:
OAuth authentication

Changed capabilities:
- authorization URL
- providers
- callback
- code exchange
- configuration

Likely documentation areas:
- OAuth
- authentication
- getting started
- troubleshooting
- security
```

The PR itself already provides these candidate documentation areas.

### Files involved

```text
orchestration/nodes/analyze.py
agents/github/pr_analyzer.py
agents/documentation/analyzer.py
agents/prompts.py
agents/schemas.py
```

---

# 8. Node 2 — Inspect the actual code

Draftly shouldn't trust only the PR description.

It needs evidence from the repository.

The graph enters:

```text
orchestration/nodes/retrieve.py
```

This invokes repository skills/tools.

### Skills (markdown, not code)

Skills are **markdown** — a directory per capability containing a `SKILL.md`
with YAML frontmatter (`name`, `description`) and markdown instructions, loaded via
`Skill.from_directory()` or the `AgentSkills` plugin (`strands.vended_plugins.skills`).
They are instructions in the agent's context (description up front, body loaded on
demand), not executable code. The executable layer is `tools/` (Python `@tool`
functions). The scaffold groups the repository capabilities per topic:

```text
skills/repository-analysis/SKILL.md
skills/github-pr-analysis/SKILL.md
```

### GitHub tools

```text
tools/github/get_pull_request.py
tools/github/get_diff.py
tools/github/get_files.py
```

### Repository tools

```text
tools/repository/filesystem.py
tools/repository/git.py
tools/repository/code_search.py
```

Draftly retrieves:

```text
src/authly/oauth.py
src/authly/auth.py
src/authly/client.py
tests/test_oauth.py
```

and the actual PR diff.

This is critical because Draftly needs to determine what the code **actually does**, not merely repeat the PR description.

---

# 9. Node 3 — Map code changes to documentation

Next:

```text
orchestration/nodes/retrieve.py
```

uses:

```text
skills/repository-analysis/SKILL.md
```

Draftly creates a relationship:

```text
src/authly/oauth.py
        ↓
docs/oauth.md

src/authly/auth.py
        ↓
docs/authentication.md

src/authly/client.py
        ↓
docs/getting-started.md
```

It may also discover:

```text
docs/security.md
docs/troubleshooting.md
```

The documentation domain helps with this:

```text
documentation/analyzer.py
documentation/indexer.py
documentation/models.py
```

---

# 10. Node 4 — Retrieve Draftly's existing knowledge

Now Draftly asks:

> "What do we already know about Authly OAuth?"

This is where the memory system becomes important.

The node:

```text
orchestration/nodes/retrieve.py
```

uses:

```text
skills/memory-retrieval/SKILL.md
```

which uses:

```text
memory/service.py
memory/retrieval.py
memory/ranking.py
memory/embeddings.py
```

Draftly can retrieve:

```text
Existing OAuth documentation
Previous OAuth discussions
Previous GitHub issues
Previous support questions
Previous documentation reviews
Previous evaluation results
```

The persistent records come from:

```text
memory/models/document.py
memory/models/conversation.py
memory/models/question.py
memory/models/solution.py
memory/models/issue.py
memory/models/knowledge.py
```

and persistence:

```text
persistence/repositories/documents.py
persistence/repositories/questions.py
persistence/repositories/issues.py
persistence/repositories/conversations.py
```

---

# 11. Node 5 — Research

Now the dedicated research phase begins.

```text
orchestration/nodes/research.py
```

invokes:

```text
agents/documentation/researcher.py
```

The researcher uses:

```text
agents/shared/research.py
skills/repository-analysis/SKILL.md
skills/memory-retrieval/SKILL.md
```

and GitHub tools.

The agent is looking for evidence such as:

```text
How is OAuth configured?

What redirect URI does the implementation expect?

Which providers are supported?

How does callback handling work?

How does authorization-code exchange work?

What SDK API should developers use?

Are there security considerations?
```

---

# 12. The PR's review comments become high-value evidence

This is where the simulated PR becomes particularly interesting.

The PR contains:

> "Do we have documentation for configuring the redirect URI?"

and the response:

> "Not yet. I'll add it in a follow-up."

It also says:

> "The SDK example should probably show the complete OAuth flow rather than only generating the authorization URL."

Draftly should detect these as **documentation requirements**, not merely comments.

So the research output could become:

```text
Documentation gaps:

1. Redirect URI configuration
2. Complete OAuth SDK example

Documentation candidates:

docs/oauth.md
docs/authentication.md
docs/getting-started.md
```

This is exactly where Draftly starts behaving like a **documentation intelligence system**.

---

# 13. Research state is persisted

The research results should be stored rather than existing only inside the agent's context window.

Relevant files:

```text
memory/service.py
memory/repository.py
memory/models/knowledge.py

persistence/repositories/documents.py
persistence/repositories/questions.py
persistence/repositories/issues.py
```

Draftly can therefore remember:

```text
OAuth
→ redirect URI undocumented
→ complete SDK flow example needed
```

This becomes useful later when someone asks the same question in Slack or Discord.

---

# 14. Node 6 — Generate documentation

Now the graph reaches:

```text
orchestration/nodes/generate.py
```

This invokes:

```text
agents/documentation/writer.py
```

The writer gets:

```text
PR changes
+
source-code evidence
+
existing documentation
+
research findings
+
project writing rules
+
documentation policy
```

The context files are especially important:

```text
context/documentation_policy.md
context/repository_rules.md
context/writing_style.md
context/security_rules.md
```

The writer might propose:

```text
docs/oauth.md
```

with:

```markdown
# OAuth Authentication

...

## Configure the Redirect URI

...

## Complete OAuth Flow

1. Configure provider
2. Generate authorization URL
3. Redirect user
4. Handle callback
5. Exchange authorization code
6. Create authenticated session
```

---

# 15. Skills perform the documentation operation

The agent doesn't need to directly manipulate Markdown.

It can use:

```text
skills/documentation-generation/SKILL.md
skills/documentation-update/SKILL.md
```

which ultimately use:

```text
tools/documentation/markdown.py
tools/documentation/frontmatter.py
tools/documentation/links.py
tools/documentation/structure.py
```

This separation gives you:

```text
Writer Agent
     ↓
Documentation Skill
     ↓
Documentation Tools
     ↓
Markdown files
```

> In Strands, the "Skill" layer is markdown (a `SKILL.md` per capability, loaded via
> `Skill.from_directory()` / the `AgentSkills` plugin), the "Tools" layer is Python
> (`@tool`-decorated functions the agent can call), and the Agent decides which
> skill/tool combination applies — a skill never executes code itself.

---

# 16. Node 7 — Validate the proposed documentation

Before evaluation, Draftly can perform deterministic validation through:

```text
documentation/validator.py
```

It can check:

```text
valid Markdown
valid links
correct frontmatter
no broken references
expected structure
```

Relevant tools:

```text
tools/documentation/links.py
tools/documentation/structure.py
tools/documentation/frontmatter.py
```

This catches simple failures before spending evaluation resources.

---

# 17. Node 8 — Evaluate the documentation

Now:

```text
orchestration/nodes/evaluate.py
```

invokes:

```text
evaluation/service.py
```

and:

```text
evaluation/deepeval_runner.py
```

The evaluation datasets are:

```text
evaluation/datasets/documentation.json
evaluation/datasets/support.json
evaluation/datasets/github_issues.json
```

The evaluators include:

```text
correctness.py
relevance.py
completeness.py
groundedness.py
documentation_quality.py
```

For PR #101, Draftly might evaluate:

```text
Correctness        0.94
Groundedness       0.97
Completeness       0.88
Relevance          0.95
Documentation      0.91
```

The exact numbers are illustrative; the important point is that the output becomes structured evaluation data.

---

# 18. What happens if evaluation fails?

This is where your architecture becomes an actual **agentic build loop**.

Suppose DeepEval determines:

```text
FAIL

Reason:
OAuth callback documentation doesn't explain
authorization-code exchange.
```

Then:

```text
evaluation
     ↓
failure_analyzer.py
     ↓
identify missing information
     ↓
research again
     ↓
writer revises
     ↓
evaluate again
```

Relevant files:

```text
evaluation/failure_analyzer.py
agents/shared/deepeval.py
skills/evaluation-failure-analysis/SKILL.md
skills/documentation-evaluation/SKILL.md
orchestration/nodes/evaluate.py
```

So the workflow becomes:

```text
Generate
   ↓
Evaluate
   ↓
FAIL
   ↓
Analyze failure
   ↓
Research
   ↓
Rewrite
   ↓
Evaluate
   ↓
PASS
```

This is much stronger than simply saying "Draftly uses DeepEval."

---

# 19. Node 9 — Determine whether human review is required

Once the output passes evaluation:

```text
orchestration/nodes/review.py
```

consults:

```text
review/policies.py
```

and:

```text
context/human_review_policy.md
```

Because this is a public documentation change, Draftly should probably require human approval.

The review service:

```text
review/service.py
review/queue.py
review/models.py
```

creates:

```text
ReviewRequest
```

> In Strands the native pattern for this gate is an interrupt: a `BeforeNodeCallEvent`
> hook on the publish node calls `event.interrupt(...)`, the graph halts with
> `Status.INTERRUPTED`, and the caller resumes with the reviewer's decision (see
> §21–22). The `review/service.py` + `review/queue.py` layer is the application's
> queueing and UI around that interrupt — keep the two distinct.

containing:

```text
PR #101
documentation changes
research evidence
evaluation results
confidence
risk
affected files
```

---

# 20. Human reviewer sees the proposal

The human should see something like:

```text
Documentation Update

Source:
PR #101 — feat: add OAuth authentication

Affected docs:
✓ docs/oauth.md
✓ docs/authentication.md
✓ docs/getting-started.md

Detected gaps:
✓ Redirect URI configuration
✓ Complete SDK OAuth example

Evaluation:
✓ Correctness
✓ Groundedness
✓ Completeness
✓ Relevance

Evidence:
src/authly/oauth.py
src/authly/auth.py
src/authly/client.py
```

The review is then:

```text
APPROVE
REJECT
REQUEST CHANGES
```

---

# 21. If rejected

Suppose the reviewer says:

> "Don't modify security.md yet. The security guidance needs a separate review."

Draftly records:

```text
review/rejection.py
```

and the graph can return to generation:

```text
Human feedback
      ↓
Research
      ↓
Generate
      ↓
Evaluate
      ↓
Review
```

This is another feedback loop.

---

# 22. If approved

Suppose the reviewer approves.

The graph reaches:

```text
orchestration/nodes/publish.py
```

which invokes:

```text
delivery/service.py
```

and:

```text
delivery/github.py
```

The delivery skill:

```text
skills/github-delivery/SKILL.md
```

uses GitHub tools:

```text
tools/github/create_branch.py
tools/github/create_commit.py
tools/github/create_pull_request.py
```

Draftly creates something like:

```text
docs: update OAuth authentication documentation
```

with the generated documentation changes.

---

# 23. Draftly creates a documentation PR

The resulting GitHub workflow is:

```text
Draftly
   │
   ├── create branch
   │
   ├── write docs
   │
   ├── commit
   │
   └── create PR
             │
             ▼
       Authly GitHub
```

Relevant files:

```text
skills/github-delivery/SKILL.md
tools/github/create_branch.py
tools/github/create_commit.py
tools/github/create_pull_request.py
delivery/github.py
```

The PR should reference the original PR:

```text
Documentation update for #101
```

This gives developers traceability:

```text
Code change
    ↓
Documentation analysis
    ↓
Documentation PR
```

---

# 24. Documentation PR gets merged

Once the documentation PR is merged, GitHub generates another event.

Draftly receives:

```text
documentation change
```

through:

```text
events/documentation/document_changed.py
```

Potentially followed by:

```text
events/documentation/publish_completed.py
```

This is where Draftly closes the loop.

---

# 25. Draftly updates its memory

The knowledge updater records:

```text
OAuth documentation updated
Redirect URI configuration documented
Complete OAuth flow documented
```

Relevant files:

```text
memory/service.py
memory/repository.py
memory/models/knowledge.py
```

and:

```text
feedback/knowledge_updater.py
skills/memory-curation/SKILL.md
```

Now if someone asks:

> "How do I configure the OAuth redirect URI?"

Draftly has a much better answer available.

---

# 26. The PR review comments also become feedback

Remember this:

```text
@alex:
Do we have documentation for configuring the redirect URI?

@maya:
Not yet. I'll add it in a follow-up.
```

Draftly should preserve this as a historical documentation signal.

That can become:

```text
Feedback
├── source: GitHub PR review
├── topic: OAuth
├── gap: redirect URI
├── resolution: documented
└── status: resolved
```

Relevant files:

```text
feedback/service.py
feedback/classifier.py
feedback/gap_detector.py
feedback/knowledge_updater.py
memory/models/feedback.py
```

---

# 27. This is where Draftly becomes a documentation intelligence system

The workflow doesn't end at:

```text
Documentation PR created
```

Instead:

```text
PR #101
   │
   ▼
Documentation gap
   │
   ▼
Documentation update
   │
   ▼
Knowledge updated
   │
   ▼
Future support questions
   │
   ▼
Feedback
```

For example, a few days later someone asks in Slack:

> "Where do I configure the OAuth redirect URI?"

Draftly can now search its memory and documentation.

The support flow:

```text
Slack
 ↓
events/support/slack.py
 ↓
slack_support_workflow.py
 ↓
support_graph.py
 ↓
question_analyzer
 ↓
retrieve_solution
 ↓
documentation
 ↓
answer_writer
 ↓
support_reviewer
 ↓
Slack response
```

And if people **continue asking the same question**, Draftly can detect that the documentation is still insufficient.

---

# 28. The complete file-level flow

Here is the entire PR #101 lifecycle condensed into one map.

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. GITHUB                                                   │
│                                                             │
│ PR #101 — feat: add OAuth authentication                    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. INGESTION                                                │
│                                                             │
│ api/routes/webhooks.py                                      │
│ integrations/github/webhooks.py                             │
│ security/webhook_verification.py                            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. EVENT                                                    │
│                                                             │
│ events/github/pull_request.py                               │
│ events/envelope.py                                          │
│ events/dispatcher.py                                        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. WORKFLOW                                                 │
│                                                             │
│ workflows/documentation/github_pr_workflow.py               │
│ workflows/registry.py                                       │
│ workflows/runner.py                                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. STRANDS GRAPH                                            │
│                                                             │
│ orchestration/graphs/documentation_graph.py                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
        analyze node     retrieve node     research node
              │                │                 │
              ▼                ▼                 ▼
        PR Analyzer       Repository        Researcher
           Agent            tools              Agent
              │                │                 │
              └────────────────┼─────────────────┘
                               │
                               ▼
                       generate node
                               │
                               ▼
                       Writer Agent
                               │
                               ▼
                      Documentation
                         skills/tools
                               │
                               ▼
                       validate node
                               │
                               ▼
                       evaluate node
                               │
                               ▼
                        DeepEval
                               │
                         ┌─────┴─────┐
                         │           │
                       FAIL         PASS
                         │           │
                         ▼           ▼
                    research     review node
                    + rewrite         │
                         │             ▼
                         └──────► Human Review
                                       │
                                 ┌─────┴─────┐
                                 │           │
                              REJECT       APPROVE
                                 │           │
                                 ▼           ▼
                              revise      publish
                                             │
                                             ▼
                                      GitHub Delivery
                                             │
                                             ▼
                                      Documentation PR
                                             │
                                             ▼
                                         MERGED
                                             │
                                             ▼
                                    Knowledge Update
                                             │
                                             ▼
                                     Feedback System
```

---

# 29. Which files are actually doing the "thinking"?

This is worth clarifying because the structure is large.

### AI reasoning

```text
agents/
```

Examples:

```text
agents/github/pr_analyzer.py
agents/documentation/researcher.py
agents/documentation/writer.py
agents/documentation/reviewer.py
```

### Workflow control

```text
orchestration/
workflows/
```

### Capabilities

```text
skills/
```

### External actions

```text
tools/
integrations/
```

### Persistent intelligence

```text
memory/
persistence/
```

### Quality control

```text
evaluation/
```

### Human control

```text
review/
```

### Documentation intelligence

```text
feedback/
documentation/
```

### External output

```text
delivery/
```

---

# 30. The most important architectural relationship

For this specific PR, the dependency chain should look like:

```text
GitHub
  │
  ▼
API
  │
  ▼
Event
  │
  ▼
Workflow
  │
  ▼
Graph
  │
  ▼
Node
  │
  ▼
Agent
  │
  ├──────► Skill
  │          │
  │          ▼
  │         Tool
  │          │
  │          ▼
  │      Integration
  │          │
  │          ▼
  │      External System
  │
  ├──────► Memory
  │
  ├──────► Evaluation
  │
  └──────► Review
                 │
                 ▼
              Delivery
                 │
                 ▼
              GitHub
```

That separation is what makes the system production-oriented.

---

# 31. What the user ultimately experiences

Despite all these files, the actual Draftly experience is simple:

```text
Developer merges PR
        ↓
Draftly notices it
        ↓
Draftly understands the change
        ↓
Draftly finds affected documentation
        ↓
Draftly researches the repository
        ↓
Draftly detects the redirect-URI gap
        ↓
Draftly detects the incomplete OAuth example
        ↓
Draftly writes the documentation
        ↓
Draftly evaluates it
        ↓
Human approves it
        ↓
Draftly creates documentation PR
        ↓
Documentation gets merged
        ↓
Draftly remembers the new knowledge
```

And that knowledge subsequently powers the **support system**.

So the deeper architecture isn't merely:

```text
GitHub → AI → Documentation
```

It is:

```text
                    ┌───────────────┐
                    │     CODE      │
                    └───────┬───────┘
                            │
                            ▼
                     ┌─────────────┐
                     │   DRAFTLY   │
                     │   AGENTS    │
                     └──────┬──────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
          Documentation             Support
                │                       │
                ▼                       ▼
          Documentation           Developer
             updates              questions
                │                       │
                └───────────┬───────────┘
                            ▼
                    ┌──────────────┐
                    │   FEEDBACK   │
                    │ INTELLIGENCE │
                    └──────┬───────┘
                           │
                           ▼
                    Knowledge gaps
                           │
                           ▼
                    Documentation
                       workflows
                           │
                           └──────► ...
```

**That feedback loop is the real product.** The OAuth PR is simply the event that demonstrates how Draftly starts the loop. The five documentation candidates and the two explicit documentation gaps in PR #101 make it an especially good simulation for demonstrating this behavior.

The repository structure supports this end-to-end architecture: webhook/event ingestion, workflow orchestration, Strands graphs and nodes, specialized agents, skills/tools, memory, feedback, evaluation, review, delivery, workers, simulations, and tests are all explicitly separated in the provided structure.
