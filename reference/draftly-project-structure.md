Yes. Based on the workflows in your handwritten designs, the production architecture we established, and Draftly's goal of turning **GitHub issues + Slack/Discord support questions into a continuous documentation feedback loop**, I would structure the codebase as a **production-oriented event-driven monorepo**.

The key architectural decision is:

> **Draftly is not just a documentation generator. It is a Documentation Intelligence System.**
> Product changes, support questions, GitHub issues, documentation changes, and user feedback continuously flow into a shared knowledge/memory layer, which drives documentation updates and future answers.

That means the codebase should separate **events, workflows, agents, tools, memory, integrations, evaluation, and delivery** rather than putting everything inside one giant agent.

# 1. Complete Draftly project structure

```text
draftly-backend/
│
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── Makefile
├── pyproject.toml
├── uv.lock
├── .env.example
├── .gitignore
├── .dockerignore
│
├── docker/
│   ├── Dockerfile
│   ├── Dockerfile.worker
│   └── Dockerfile.api
│
├── config/
│   ├── development.yaml
│   ├── staging.yaml
│   └── production.yaml
│
├── context/
│   ├── README.md
│   ├── project_context.md
│   ├── architecture.md
│   ├── documentation_policy.md
│   ├── support_policy.md
│   ├── repository_rules.md
│   ├── writing_style.md
│   ├── diagram_rules.md
│   ├── security_rules.md
│   ├── human_review_policy.md
│   └── evaluation_rules.md
│
├── src/
│   └── draftly/
│       │
│       ├── __init__.py
│       ├── version.py
│       ├── config.py
│       ├── logging.py
│       ├── telemetry.py
│       ├── errors.py
│       └── constants.py
│
│       ├── api/
│       │   ├── __init__.py
│       │   ├── app.py
│       │   │
│       │   ├── routes/
│       │   │   ├── health.py
│       │   │   ├── webhooks.py
│       │   │   ├── projects.py
│       │   │   ├── documents.py
│       │   │   ├── support.py
│       │   │   ├── issues.py
│       │   │   ├── reviews.py
│       │   │   └── evaluations.py
│       │   │
│       │   ├── middleware/
│       │   │   ├── auth.py
│       │   │   ├── request_id.py
│       │   │   └── error_handler.py
│       │   │
│       │   └── schemas/
│       │       ├── requests.py
│       │       └── responses.py
│       │
│       ├── events/
│       │   ├── __init__.py
│       │   ├── base.py
│       │   ├── types.py
│       │   ├── envelope.py
│       │   ├── dispatcher.py
│       │   │
│       │   ├── github/
│       │   │   ├── pull_request.py
│       │   │   ├── issue.py
│       │   │   ├── release.py
│       │   │   └── push.py
│       │   │
│       │   ├── support/
│       │   │   ├── slack.py
│       │   │   └── discord.py
│       │   │
│       │   └── documentation/
│       │       ├── document_changed.py
│       │       ├── review_completed.py
│       │       └── publish_completed.py
│       │
│       ├── workflows/
│       │   ├── __init__.py
│       │   ├── registry.py
│       │   ├── runner.py
│       │   ├── state.py
│       │   │
│       │   ├── documentation/
│       │   │   ├── github_pr_workflow.py
│       │   │   ├── github_release_workflow.py
│       │   │   ├── documentation_sync.py
│       │   │   └── documentation_audit.py
│       │   │
│       │   ├── support/
│       │   │   ├── slack_support_workflow.py
│       │   │   ├── discord_support_workflow.py
│       │   │   └── support_resolution.py
│       │   │
│       │   ├── github/
│       │   │   ├── issue_resolution.py
│       │   │   └── issue_feedback.py
│       │   │
│       │   ├── feedback/
│       │   │   ├── documentation_feedback_loop.py
│       │   │   ├── knowledge_update.py
│       │   │   └── feedback_prioritization.py
│       │   │
│       │   └── evaluation/
│       │       ├── documentation_evaluation.py
│       │       └── support_evaluation.py
│       │
│       ├── orchestration/
│       │   ├── __init__.py
│       │   │
│       │   ├── graphs/
│       │   │   ├── documentation_graph.py
│       │   │   ├── support_graph.py
│       │   │   ├── issue_graph.py
│       │   │   ├── feedback_graph.py
│       │   │   └── evaluation_graph.py
│       │   │
│       │   ├── nodes/
│       │   │   ├── analyze.py
│       │   │   ├── research.py
│       │   │   ├── retrieve.py
│       │   │   ├── generate.py
│       │   │   ├── review.py
│       │   │   ├── evaluate.py
│       │   │   ├── publish.py
│       │   │   └── respond.py
│       │   │
│       │   ├── routing/
│       │   │   ├── conditions.py
│       │   │   ├── classifiers.py
│       │   │   └── policies.py
│       │   │
│       │   └── state/
│       │       ├── documentation.py
│       │       ├── support.py
│       │       ├── issue.py
│       │       └── feedback.py
│       │
│       ├── agents/
│       │   ├── __init__.py
│       │   ├── draftly_agent.py
│       │   ├── subagents.py
│       │   ├── prompts.py
│       │   ├── schemas.py
│       │   │
│       │   ├── documentation/
│       │   │   ├── analyzer.py
│       │   │   ├── researcher.py
│       │   │   ├── writer.py
│       │   │   ├── reviewer.py
│       │   │   └── auditor.py
│       │   │
│       │   ├── support/
│       │   │   ├── question_analyzer.py
│       │   │   ├── solution_researcher.py
│       │   │   ├── answer_writer.py
│       │   │   └── support_reviewer.py
│       │   │
│       │   ├── github/
│       │   │   ├── issue_analyzer.py
│       │   │   ├── issue_researcher.py
│       │   │   └── issue_responder.py
│       │   │
│       │   └── shared/
│       │       ├── deepeval.py
│       │       ├── github_delivery.py
│       │       ├── memory_curator.py
│       │       └── research.py
│       │
│       ├── skills/
│       │   ├── __init__.py
│       │   │
│       │   ├── documentation/
│       │   │   ├── analyze_docs.py
│       │   │   ├── generate_docs.py
│       │   │   ├── update_docs.py
│       │   │   ├── create_docs.py
│       │   │   └── audit_docs.py
│       │   │
│       │   ├── repository/
│       │   │   ├── inspect_repository.py
│       │   │   ├── inspect_diff.py
│       │   │   ├── find_related_code.py
│       │   │   └── map_code_to_docs.py
│       │   │
│       │   ├── support/
│       │   │   ├── classify_question.py
│       │   │   ├── find_previous_question.py
│       │   │   ├── retrieve_solution.py
│       │   │   ├── generate_answer.py
│       │   │   └── detect_documentation_gap.py
│       │   │
│       │   ├── github/
│       │   │   ├── inspect_issue.py
│       │   │   ├── find_issue_history.py
│       │   │   └── generate_issue_response.py
│       │   │
│       │   ├── memory/
│       │   │   ├── retrieve_memory.py
│       │   │   ├── store_memory.py
│       │   │   ├── update_knowledge.py
│       │   │   └── detect_conflicts.py
│       │   │
│       │   ├── evaluation/
│       │   │   ├── run_deepeval.py
│       │   │   ├── evaluate_answer.py
│       │   │   ├── evaluate_document.py
│       │   │   └── analyze_failures.py
│       │   │
│       │   └── delivery/
│       │       ├── create_pr.py
│       │       ├── update_pr.py
│       │       ├── publish_documentation.py
│       │       ├── reply_slack.py
│       │       ├── reply_discord.py
│       │       └── reply_github.py
│       │
│       ├── tools/
│       │   ├── __init__.py
│       │   │
│       │   ├── github/
│       │   │   ├── get_pull_request.py
│       │   │   ├── get_issue.py
│       │   │   ├── get_diff.py
│       │   │   ├── get_files.py
│       │   │   ├── create_comment.py
│       │   │   ├── create_branch.py
│       │   │   ├── create_commit.py
│       │   │   └── create_pull_request.py
│       │   │
│       │   ├── slack/
│       │   │   ├── search_messages.py
│       │   │   ├── get_thread.py
│       │   │   └── post_message.py
│       │   │
│       │   ├── discord/
│       │   │   ├── search_messages.py
│       │   │   ├── get_thread.py
│       │   │   └── post_message.py
│       │   │
│       │   ├── repository/
│       │   │   ├── filesystem.py
│       │   │   ├── git.py
│       │   │   └── code_search.py
│       │   │
│       │   ├── documentation/
│       │   │   ├── markdown.py
│       │   │   ├── frontmatter.py
│       │   │   ├── links.py
│       │   │   └── structure.py
│       │   │
│       │   └── search/
│       │       ├── semantic_search.py
│       │       ├── keyword_search.py
│       │       └── hybrid_search.py
│       │
│       ├── integrations/
│       │   ├── __init__.py
│       │   │
│       │   ├── github/
│       │   │   ├── client.py
│       │   │   ├── webhooks.py
│       │   │   └── auth.py
│       │   │
│       │   ├── slack/
│       │   │   ├── client.py
│       │   │   ├── events.py
│       │   │   └── auth.py
│       │   │
│       │   ├── discord/
│       │   │   ├── client.py
│       │   │   ├── events.py
│       │   │   └── auth.py
│       │   │
│       │   ├── strands/
│       │   │   ├── client.py
│       │   │   ├── models.py
│       │   │   ├── tools.py
│       │   │   └── graph.py
│       │   │
│       │   └── deepeval/
│       │       ├── client.py
│       │       ├── datasets.py
│       │       └── evaluators.py
│       │
│       ├── memory/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── repository.py
│       │   ├── embeddings.py
│       │   ├── retrieval.py
│       │   ├── ranking.py
│       │   │
│       │   ├── models/
│       │   │   ├── project.py
│       │   │   ├── document.py
│       │   │   ├── conversation.py
│       │   │   ├── question.py
│       │   │   ├── solution.py
│       │   │   ├── feedback.py
│       │   │   ├── issue.py
│       │   │   └── knowledge.py
│       │   │
│       │   └── migrations/
│       │       ├── 001_initial.sql
│       │       ├── 002_vectors.sql
│       │       ├── 003_feedback.sql
│       │       └── 004_evaluations.sql
│       │
│       ├── persistence/
│       │   ├── __init__.py
│       │   ├── database.py
│       │   ├── transactions.py
│       │   ├── repositories/
│       │   │   ├── projects.py
│       │   │   ├── documents.py
│       │   │   ├── questions.py
│       │   │   ├── issues.py
│       │   │   ├── conversations.py
│       │   │   ├── feedback.py
│       │   │   └── evaluations.py
│       │   └── models/
│       │       └── ...
│       │
│       ├── feedback/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── classifier.py
│       │   ├── deduplication.py
│       │   ├── prioritization.py
│       │   ├── gap_detector.py
│       │   ├── knowledge_updater.py
│       │   └── models.py
│       │
│       ├── documentation/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── analyzer.py
│       │   ├── generator.py
│       │   ├── updater.py
│       │   ├── validator.py
│       │   ├── indexer.py
│       │   └── models.py
│       │
│       ├── support/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── classifier.py
│       │   ├── resolver.py
│       │   ├── answer.py
│       │   ├── escalation.py
│       │   └── models.py
│       │
│       ├── review/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── queue.py
│       │   ├── policies.py
│       │   ├── approvals.py
│       │   ├── rejection.py
│       │   └── models.py
│       │
│       ├── evaluation/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── datasets/
│       │   │   ├── documentation.json
│       │   │   ├── support.json
│       │   │   └── github_issues.json
│       │   ├── evaluators/
│       │   │   ├── correctness.py
│       │   │   ├── relevance.py
│       │   │   ├── completeness.py
│       │   │   ├── groundedness.py
│       │   │   └── documentation_quality.py
│       │   ├── deepeval_runner.py
│       │   └── failure_analyzer.py
│       │
│       ├── delivery/
│       │   ├── __init__.py
│       │   ├── service.py
│       │   ├── github.py
│       │   ├── slack.py
│       │   ├── discord.py
│       │   └── documentation.py
│       │
│       ├── security/
│       │   ├── __init__.py
│       │   ├── secrets.py
│       │   ├── permissions.py
│       │   ├── webhook_verification.py
│       │   ├── redaction.py
│       │   └── audit.py
│       │
│       └── observability/
│           ├── __init__.py
│           ├── tracing.py
│           ├── metrics.py
│           ├── audit.py
│           └── events.py
│
├── workers/
│   ├── event_worker.py
│   ├── workflow_worker.py
│   ├── evaluation_worker.py
│   └── indexing_worker.py
│
├── scripts/
│   ├── bootstrap.py
│   ├── seed_demo.py
│   ├── run_workflow.py
│   ├── run_evaluation.py
│   └── reindex.py
│
├── tests/
│   ├── unit/
│   │   ├── agents/
│   │   ├── workflows/
│   │   ├── skills/
│   │   ├── memory/
│   │   ├── documentation/
│   │   ├── support/
│   │   └── feedback/
│   │
│   ├── integration/
│   │   ├── github/
│   │   ├── slack/
│   │   ├── discord/
│   │   ├── cockroachdb/
│   │   ├── strands/
│   │   └── deepeval/
│   │
│   ├── workflow/
│   │   ├── test_pr_workflow.py
│   │   ├── test_issue_workflow.py
│   │   ├── test_support_workflow.py
│   │   └── test_feedback_loop.py
│   │
│   ├── evaluation/
│   │   ├── test_documentation_quality.py
│   │   ├── test_support_accuracy.py
│   │   └── test_groundedness.py
│   │
│   └── fixtures/
│       ├── github/
│       ├── slack/
│       ├── discord/
│       └── repositories/
│
├── simulation/
│   ├── README.md
│   ├── roadmap.md
│   │
│   ├── scenarios/
│   │   ├── 001_oauth.md
│   │   ├── 002_pkce.md
│   │   ├── 003_api_key_deprecation.md
│   │   ├── 004_rbac.md
│   │   ├── 005_token_rotation.md
│   │   └── 006_sdk_breaking_change.md
│   │
│   ├── github/
│   │   ├── prs/
│   │   ├── issues/
│   │   └── releases/
│   │
│   ├── slack/
│   │   ├── support/
│   │   └── engineering/
│   │
│   └── discord/
│       ├── help/
│       └── developers/
│
├── infra/
│   ├── aws/
│   │   ├── terraform/
│   │   │   ├── main.tf
│   │   │   ├── variables.tf
│   │   │   ├── outputs.tf
│   │   │   ├── iam.tf
│   │   │   ├── networking.tf
│   │   │   ├── ecs.tf
│   │   │   ├── lambda.tf
│   │   │   ├── api_gateway.tf
│   │   │   ├── secrets.tf
│   │   │   └── monitoring.tf
│   │   │
│   │   └── diagrams/
│   │       └── architecture.md
│   │
│   ├── cockroachdb/
│   │   ├── schema.sql
│   │   ├── indexes.sql
│   │   └── migrations/
│   │
│   └── observability/
│       ├── dashboards/
│       └── alerts/
│
└── docs/
    ├── architecture/
    │   ├── overview.md
    │   ├── system-design.md
    │   ├── multi-agent.md
    │   ├── event-driven.md
    │   ├── memory.md
    │   └── feedback-loop.md
    │
    ├── workflows/
    │   ├── github-pr.md
    │   ├── github-issue.md
    │   ├── support.md
    │   ├── documentation-sync.md
    │   └── feedback-loop.md
    │
    ├── agents/
    │   ├── agent-overview.md
    │   ├── subagents.md
    │   └── skills.md
    │
    ├── deployment/
    │   ├── aws.md
    │   ├── cockroachdb.md
    │   └── production.md
    │
    └── api/
        └── webhooks.md
```

---

# 2. The most important architectural distinction

I would **not** make this:

```text
GitHub → Draftly Agent → LLM → Documentation
```

That is too simplistic for the system you're building.

Instead:

```text
                 ┌───────────────────────────┐
                 │       External Events      │
                 │                           │
                 │ GitHub PRs / Issues        │
                 │ GitHub Releases            │
                 │ Slack Support              │
                 │ Discord Support            │
                 └─────────────┬─────────────┘
                               │
                               ▼
                 ┌───────────────────────────┐
                 │       Event Layer         │
                 │                           │
                 │ Normalize                 │
                 │ Validate                  │
                 │ Deduplicate               │
                 │ Persist                   │
                 └─────────────┬─────────────┘
                               │
                               ▼
                 ┌───────────────────────────┐
                 │     Workflow Router       │
                 └─────────────┬─────────────┘
                               │
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
       Documentation       Support          GitHub Issue
          Graph              Graph              Graph
              │                │                 │
              └────────────────┼─────────────────┘
                               ▼
                 ┌───────────────────────────┐
                 │   Shared Knowledge Layer  │
                 │                           │
                 │ Documents                 │
                 │ Questions                 │
                 │ Solutions                 │
                 │ Issues                    │
                 │ Conversations             │
                 │ Feedback                   │
                 │ Evaluations               │
                 └─────────────┬─────────────┘
                               │
                               ▼
                 ┌───────────────────────────┐
                 │ Human Review / Evaluation │
                 └─────────────┬─────────────┘
                               │
                               ▼
                 ┌───────────────────────────┐
                 │        Delivery           │
                 │                           │
                 │ GitHub PR                 │
                 │ GitHub comment            │
                 │ Slack reply               │
                 │ Discord reply             │
                 │ Documentation publish     │
                 └───────────────────────────┘
```

This distinction makes the project much easier to reason about.

---

# 3. `events/` — everything starts with an event

The event layer converts external activity into a common internal representation.

For example:

```text
GitHub PR opened
       ↓
PullRequestEvent
```

or:

```text
Slack question
       ↓
SupportQuestionEvent
```

or:

```text
GitHub issue created
       ↓
GitHubIssueEvent
```

The event should contain things such as:

```python
class EventEnvelope:
    event_id: str
    event_type: str
    source: str
    project_id: str
    timestamp: datetime
    payload: dict
    metadata: dict
```

This gives you:

- idempotency
- replayability
- auditability
- event tracing
- workflow routing
- easier testing

---

# 4. `workflows/` — business processes

This is where your handwritten workflows become actual production workflows.

For example:

```text
workflows/
├── documentation/
├── support/
├── github/
├── feedback/
└── evaluation/
```

The workflow shouldn't contain all the LLM logic.

Instead it orchestrates agents, tools and services.

For example:

```text
github_pr_workflow.py
```

could conceptually do:

```text
PR Event
   ↓
Analyze PR
   ↓
Inspect diff
   ↓
Identify affected documentation
   ↓
Retrieve existing docs
   ↓
Generate/update documentation
   ↓
Evaluate
   ↓
Human Review
   ↓
Create Documentation PR
   ↓
Publish
   ↓
Update Knowledge Layer
```

---

# 5. `orchestration/` — Strands Graph

This is one of the most important parts of the architecture.

Since you're using the **Strands Agents SDK Graph multi-agent pattern**, keep Graph orchestration separate from your actual agents.

For example:

```text
orchestration/
│
├── graphs/
│   ├── documentation_graph.py
│   ├── support_graph.py
│   ├── issue_graph.py
│   ├── feedback_graph.py
│   └── evaluation_graph.py
│
├── nodes/
│   ├── analyze.py
│   ├── research.py
│   ├── retrieve.py
│   ├── generate.py
│   ├── review.py
│   ├── evaluate.py
│   ├── publish.py
│   └── respond.py
```

Think of the Graph as the **orchestration state machine**, while agents are the **specialists performing individual tasks**.

---

# 6. Draftly's documentation Graph

The central documentation graph becomes:

```text
                ┌───────────────┐
                │ GitHub PR     │
                │ / Release     │
                └───────┬───────┘
                        ↓
                 ┌─────────────┐
                 │   Analyze   │
                 └──────┬──────┘
                        ↓
                 ┌─────────────┐
                 │   Research  │
                 └──────┬──────┘
                        ↓
              ┌─────────┴─────────┐
              ↓                   ↓
      Existing docs?        New feature?
              │                   │
              ↓                   ↓
        Update docs          Create docs
              │                   │
              └─────────┬─────────┘
                        ↓
                 ┌─────────────┐
                 │   Evaluate  │
                 └──────┬──────┘
                        ↓
                 ┌─────────────┐
                 │ Human Review│
                 └──────┬──────┘
                        ↓
                 ┌─────────────┐
                 │   Publish   │
                 └──────┬──────┘
                        ↓
                 Knowledge Layer
```

The graph should also support retry/revision:

```text
Evaluate
   │
   ├── PASS ─────────→ Review
   │
   └── FAIL
         ↓
    Analyze failure
         ↓
      Revise
         ↓
      Evaluate
```

This is much more production-ready than a linear chain.

---

# 7. Support Graph

Your second handwritten workflow maps directly into:

```text
Slack / Discord question
          ↓
      Analyze
          ↓
   Search previous
      questions
          ↓
    ┌─────┴─────┐
    │           │
   YES          NO
    │           │
    ↓           ↓
Retrieve      Search
solution      documentation
    │           │
    │           ↓
    │       Generate answer
    │           │
    └─────┬─────┘
          ↓
      Evaluate
          ↓
    Documentation
       gap?
      /       \
    yes        no
     │          │
     ↓          ↓
Create       Respond
feedback     directly
     │
     ↓
Human Review
     │
     ↓
Respond
     │
     ↓
Update Knowledge
```

This is where Draftly becomes significantly more interesting than a normal documentation agent.

---

# 8. The Documentation Intelligence feedback loop

The support system should **not stop after answering a question**.

Suppose someone asks:

> "How do I rotate an API key?"

Draftly discovers that:

- the question has never been asked
- documentation doesn't explain rotation
- the code supports rotation
- the answer requires several assumptions

Draftly should record:

```text
Support Question
      ↓
Documentation Gap
      ↓
Knowledge Gap
      ↓
Documentation Candidate
      ↓
Human Review
      ↓
Documentation Update
```

Then the next person asks the same question.

Instead of generating a new answer from scratch:

```text
Question
   ↓
Semantic retrieval
   ↓
Previous question
   ↓
Approved solution
   ↓
Current documentation
   ↓
Answer
```

That creates a genuine feedback loop.

---

# 9. GitHub Issue Graph

The GitHub issue workflow becomes another source of documentation intelligence.

```text
GitHub Issue
     ↓
Analyze Issue
     ↓
Search issue history
     ↓
Search documentation
     ↓
     ┌───────────────┐
     │ Existing      │
     │ solution?     │
     └───────┬───────┘
             │
        ┌────┴────┐
        ↓         ↓
       YES        NO
        │         │
        ↓         ↓
   Retrieve      Research
   solution      solution
        │         │
        └────┬────┘
             ↓
       Generate response
             ↓
          Evaluate
             ↓
        Human Review
             ↓
        GitHub Reply
             ↓
      Update Knowledge
             ↓
       Detect doc gap
             ↓
       Documentation
         workflow
```

The important part is this:

```text
GitHub Issue
     │
     ├──────────────→ Issue Resolution
     │
     └──────────────→ Documentation Intelligence
```

A GitHub issue therefore becomes both:

1. a support interaction
2. a signal about documentation quality

---

# 10. `agents/` should contain specialists

Your `draftly_agent.py` should be the top-level agent/factory rather than a 2,000-line mega-agent.

Conceptually:

```text
Draftly
   │
   ├── Documentation specialists
   │
   ├── Support specialists
   │
   ├── GitHub specialists
   │
   └── Shared specialists
```

For example:

```text
agents/documentation/
├── analyzer.py
├── researcher.py
├── writer.py
├── reviewer.py
└── auditor.py
```

Each agent has one responsibility.

---

# 11. Shared agents

The shared agents you previously defined fit naturally here:

```text
agents/shared/
├── deepeval.py
├── github_delivery.py
├── memory_curator.py
└── research.py
```

Their responsibilities are different from workflow nodes.

### `research.py`

Answers:

> What information do we need to know?

### `memory_curator.py`

Answers:

> What should Draftly remember?

### `deepeval.py`

Answers:

> Is this output actually good enough?

### `github_delivery.py`

Answers:

> How should the approved artifact be delivered to GitHub?

This keeps the architecture clean.

---

# 12. `skills/` are reusable capabilities

This is where the actual capabilities of your agents live.

For example:

```text
skills/support/
├── classify_question.py
├── find_previous_question.py
├── retrieve_solution.py
├── generate_answer.py
└── detect_documentation_gap.py
```

The support agent doesn't need to know how semantic search works.

It invokes:

```text
find_previous_question()
```

Likewise, the documentation writer can invoke:

```text
generate_docs()
```

This makes skills reusable across multiple graphs.

---

# 13. `tools/` are infrastructure capabilities

Keep a strict distinction:

```text
Agent
   ↓
Skill
   ↓
Tool
   ↓
External system
```

For example:

```text
Support Agent
      ↓
retrieve_solution skill
      ↓
hybrid_search tool
      ↓
CockroachDB
```

Or:

```text
GitHub Delivery Agent
      ↓
create_pr skill
      ↓
create_pull_request tool
      ↓
GitHub API
```

This is an important production boundary.

---

# 14. `memory/` is the heart of Documentation Intelligence

Draftly's memory shouldn't just store chat history.

It should store **product knowledge**.

A useful conceptual model is:

```text
Project
 │
 ├── Repository
 │
 ├── Documents
 │
 ├── Code entities
 │
 ├── Questions
 │
 ├── Solutions
 │
 ├── GitHub Issues
 │
 ├── Conversations
 │
 ├── Feedback
 │
 ├── Documentation gaps
 │
 └── Evaluations
```

For example:

```text
Question
   ↓
Solution
   ↓
Evidence
   ↓
Documentation
   ↓
Evaluation
   ↓
Feedback
```

This allows Draftly to build a continuously improving project knowledge graph.

---

# 15. CockroachDB becomes the system of record

Your persistence layer should separate:

```text
persistence/
```

from:

```text
memory/
```

because they have different responsibilities.

### Persistence

Stores authoritative application state:

```text
projects
documents
issues
questions
reviews
evaluations
events
```

### Memory

Provides intelligence-oriented operations:

```text
retrieve relevant knowledge
search previous questions
find similar issues
find related documentation
store learned information
detect conflicts
```

This allows CockroachDB to function as both:

```text
Transactional database
+
Vector/semantic memory layer
```

which fits your Draftly architecture particularly well.

---

# 16. Feedback becomes a first-class domain

This is important enough that I would **not** hide it inside support.

You should have:

```text
feedback/
├── classifier.py
├── deduplication.py
├── prioritization.py
├── gap_detector.py
└── knowledge_updater.py
```

Because feedback can come from:

```text
Slack
Discord
GitHub Issues
GitHub PRs
Documentation reviews
Documentation evaluations
Human corrections
```

All of those become signals.

---

# 17. Documentation gap detection

This is arguably one of Draftly's strongest features.

For every support interaction:

```text
Question
   ↓
Can existing documentation answer this?
```

If:

```text
YES
```

then:

```text
Answer user
```

If:

```text
NO
```

then:

```text
Create documentation gap
```

The gap should contain something like:

```text
DocumentationGap
├── project_id
├── source
├── question
├── affected_feature
├── missing_information
├── evidence
├── frequency
├── severity
├── confidence
└── suggested_documentation
```

Now Draftly can prioritize documentation work based on actual user pain.

---

# 18. Human review should be its own domain

Don't embed human review inside an agent.

Instead:

```text
review/
├── service.py
├── queue.py
├── policies.py
├── approvals.py
├── rejection.py
└── models.py
```

The graph can pause at:

```text
GENERATED
   ↓
EVALUATED
   ↓
WAITING_FOR_REVIEW
```

Then:

```text
APPROVED
   ↓
DELIVERY
```

or:

```text
REJECTED
   ↓
REVISION
   ↓
EVALUATION
```

This is much easier to make reliable.

---

# 19. DeepEval belongs inside the build loop

Given the evaluation approach you've been developing for Draftly, don't make DeepEval merely a final test.

Use it like this:

```text
Generate
   ↓
Evaluate
   ↓
FAIL
   ↓
Analyze failure
   ↓
Retrieve better evidence
   ↓
Revise
   ↓
Evaluate
   ↓
PASS
   ↓
Human Review
```

So:

```text
DeepEval
```

becomes a **feedback mechanism for the agent**, not simply a CI test.

Your structure supports that:

```text
evaluation/
├── deepeval_runner.py
├── failure_analyzer.py
└── evaluators/
```

---

# 20. Documentation quality evaluation

I would evaluate generated documentation on at least:

```text
Correctness
Completeness
Groundedness
Relevance
Consistency
Actionability
```

For support answers:

```text
Correctness
Groundedness
Relevance
Completeness
Context awareness
```

The result becomes another memory object:

```text
Documentation
      ↓
Evaluation
      ↓
Quality signal
      ↓
Knowledge layer
```

---

# 21. Delivery layer

Draftly shouldn't directly call Slack/GitHub from an agent.

Instead:

```text
Agent
 ↓
Skill
 ↓
Delivery service
 ↓
Integration
```

For example:

```text
github_delivery
      ↓
delivery/github.py
      ↓
integrations/github/client.py
      ↓
GitHub API
```

This provides a clean boundary between AI decisions and external side effects.

---

# 22. Integration layer

The integration layer should contain **API clients and event adapters**, not business logic.

```text
integrations/
├── github/
├── slack/
├── discord/
├── strands/
└── deepeval/
```

For example:

```text
GitHub webhook
      ↓
integrations/github/webhooks.py
      ↓
events/github/pull_request.py
      ↓
workflow router
```

This is much cleaner than having GitHub webhook parsing inside an agent.

---

# 23. Production deployment structure

The `infra/` directory allows you to deploy Draftly to AWS without mixing infrastructure with application code.

A production topology could be:

```text
                    Internet
                       │
                       ▼
                ┌──────────────┐
                │ API Gateway  │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ Draftly API  │
                └──────┬───────┘
                       │
              ┌────────┴─────────┐
              │                  │
              ▼                  ▼
        Event Queue        Workflow Workers
              │                  │
              └────────┬─────────┘
                       ▼
              Strands Graph
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      GitHub        Support     Documentation
       Agents        Agents        Agents
          │            │            │
          └────────────┼────────────┘
                       ▼
                Knowledge Layer
                       │
                       ▼
                 CockroachDB
                       │
            ┌──────────┴─────────┐
            ▼                    ▼
       Transactional          Vectors
          State              / Memory
```

---

# 24. Why `workers/` matters

Don't make your webhook request wait for the entire agent workflow.

Bad:

```text
GitHub webhook
     ↓
run LLM workflow
     ↓
generate documentation
     ↓
wait 90 seconds
     ↓
HTTP response
```

Instead:

```text
GitHub webhook
     ↓
Validate
     ↓
Persist event
     ↓
Queue event
     ↓
Return 200
```

Then:

```text
Event Worker
     ↓
Workflow Worker
     ↓
Strands Graph
```

This makes Draftly much more production-ready.

---

# 25. `simulation/` is extremely valuable for the hackathon

Your simulation environment should behave like a fake real-world startup.

For example:

```text
simulation/
├── github/
│   ├── prs/
│   ├── issues/
│   └── releases/
├── slack/
│   └── support/
└── discord/
    └── help/
```

Then:

```text
Scenario 001
   ↓
OAuth feature introduced
   ↓
GitHub PR
   ↓
Draftly detects affected documentation
   ↓
Documentation update
```

Later:

```text
User asks Slack:
"How does OAuth PKCE work?"
```

Draftly can detect whether the documentation already answers it.

This gives you a **repeatable demonstration of the feedback loop**.

---

# 26. A complete end-to-end Draftly lifecycle

The final system should effectively implement this:

```text
                    ┌──────────────────────┐
                    │   SOFTWARE PROJECT   │
                    └──────────┬───────────┘
                               │
                ┌──────────────┼───────────────┐
                │              │               │
                ▼              ▼               ▼
             GitHub          Slack           Discord
                │              │               │
                ▼              ▼               ▼
             Events          Events           Events
                │              │               │
                └──────────────┼───────────────┘
                               ▼
                       Event Normalization
                               │
                               ▼
                       Workflow Router
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
     Documentation          Support            GitHub Issue
        Graph                Graph                Graph
          │                    │                    │
          └────────────────────┼────────────────────┘
                               ▼
                      Research + Retrieval
                               │
                               ▼
                       Knowledge Layer
                               │
                               ▼
                          Generation
                               │
                               ▼
                           DeepEval
                         /          \
                      FAIL           PASS
                       │              │
                       ▼              ▼
                    Revise       Human Review
                       │          /        \
                       │       reject      approve
                       │          │           │
                       └──────────┘           ▼
                                         Delivery
                                      /      |       \
                                    GitHub  Slack   Discord
                                       │
                                       ▼
                                  New knowledge
                                       │
                                       ▼
                              Documentation Gap
                                       │
                                       ▼
                              Documentation Work
                                       │
                                       ▼
                                Updated Docs
                                       │
                                       └───────────┐
                                                   │
                                                   ▼
                                          Knowledge Layer
```

That is the architecture I would implement.

---

# 27. The four major Graphs

Your Strands Graph architecture therefore becomes:

| Graph                   | Trigger                          | Main purpose                                         |
| ----------------------- | -------------------------------- | ---------------------------------------------------- |
| **Documentation Graph** | PR, release, code change         | Keep docs synchronized with software                 |
| **Support Graph**       | Slack/Discord question           | Resolve developer/user questions                     |
| **Issue Graph**         | GitHub issue                     | Resolve issues and extract documentation signals     |
| **Feedback Graph**      | Question/issue/review/evaluation | Convert interactions into documentation intelligence |

And optionally:

| Graph                | Purpose                                          |
| -------------------- | ------------------------------------------------ |
| **Evaluation Graph** | Run quality evaluation and iterative improvement |

This is better than creating one massive universal Graph.

---

# 28. The key relationship between everything

The most important design principle is:

```text
                 ┌──────────────────┐
                 │      Agents      │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │      Skills      │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │      Tools       │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │ External Systems │
                 └──────────────────┘
```

while:

```text
Events
  ↓
Workflows
  ↓
Strands Graph
  ↓
Agents
  ↓
Skills
  ↓
Tools
```

and:

```text
                    ┌─────────────┐
                    │  Cockroach  │
                    │     DB      │
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
        App State       Memory        Feedback
```

And finally:

```text
GitHub ──────┐
             │
Slack ───────┼──→ Documentation Intelligence
             │             │
Discord ─────┘             ▼
                       Knowledge
                           │
                           ▼
                    Better answers
                           │
                           ▼
                    Better docs
                           │
                           ▼
                    Better knowledge
```

**That last loop is the core differentiator for Draftly.**

It transforms Draftly from an "AI documentation writer" into an **autonomous documentation engineering and intelligence platform**: software changes update documentation, real user questions expose documentation gaps, GitHub issues provide additional product feedback, human reviewers provide authoritative corrections, and those signals continuously improve the project's knowledge base.
