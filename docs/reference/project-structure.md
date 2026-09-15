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
│       │   │   ├── github.py
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
            │
            ├── documentation-research/
            │   ├── SKILL.md
            │   └── references/
            │       ├── evidence-policy.md
            │       ├── documentation-impact.md
            │       ├── repository-analysis.md
            │       └── research-output.md
            │
            ├── documentation-generation/
            │   ├── SKILL.md
            │   ├── references/
            │   │   ├── documentation-style-guide.md
            │   │   ├── documentation-standards.md
            │   │   ├── technical-writing-rules.md
            │   │   └── code-example-guidelines.md
            │   └── assets/
            │       ├── api-reference-template.md
            │       ├── tutorial-template.md
            │       ├── how-to-template.md
            │       └── conceptual-template.md
            │
            ├── documentation-update/
            │   ├── SKILL.md
            │   └── references/
            │       ├── change-management.md
            │       └── backward-compatibility.md
            │
            ├── documentation-audit/
            │   ├── SKILL.md
            │   └── references/
            │       ├── audit-checklist.md
            │       ├── freshness-rules.md
            │       ├── completeness-rules.md
            │       └── consistency-rules.md
            │
            ├── repository-analysis/
            │   ├── SKILL.md
            │   └── references/
            │       ├── repository-conventions.md
            │       ├── source-of-truth-policy.md
            │       └── code-to-doc-mapping.md
            │
            ├── support-triage/
            │   ├── SKILL.md
            │   └── references/
            │       ├── support-taxonomy.md
            │       ├── severity-rules.md
            │       ├── confidence-rules.md
            │       └── escalation-rules.md
            │
            ├── support-answering/
            │   ├── SKILL.md
            │   └── references/
            │       ├── answer-policy.md
            │       ├── citation-policy.md
            │       └── uncertainty-policy.md
            │
            ├── documentation-gap-detection/
            │   ├── SKILL.md
            │   └── references/
            │       ├── gap-detection-rules.md
            │       ├── recurring-question-rules.md
            │       └── signal-weighting.md
            │
            ├── github-issue-analysis/
            │   ├── SKILL.md
            │   └── references/
            │       ├── issue-taxonomy.md
            │       ├── issue-history-analysis.md
            │       └── documentation-signal-rules.md
            │
            ├── github-pr-analysis/
            │   ├── SKILL.md
            │   └── references/
            │       ├── pr-analysis-rules.md
            │       ├── change-impact-rules.md
            │       └── documentation-impact.md
            │
            ├── github-release-analysis/
            │   ├── SKILL.md
            │   └── references/
            │       ├── release-impact-rules.md
            │       └── changelog-rules.md
            │
            ├── support-feedback-analysis/
            │   ├── SKILL.md
            │   └── references/
            │       ├── feedback-classification.md
            │       ├── recurring-problem-rules.md
            │       └── documentation-signal-rules.md
            │
            ├── memory-retrieval/
            │   ├── SKILL.md
            │   └── references/
            │       ├── memory-retrieval-policy.md
            │       └── relevance-rules.md
            │
            ├── memory-curation/
            │   ├── SKILL.md
            │   └── references/
            │       ├── knowledge-curation-policy.md
            │       ├── conflict-resolution.md
            │       └── memory-quality.md
            │
            ├── documentation-evaluation/
            │   ├── SKILL.md
            │   └── references/
            │       ├── evaluation-criteria.md
            │       ├── factuality-rules.md
            │       ├── completeness-rules.md
            │       └── groundedness-rules.md
            │
            ├── support-evaluation/
            │   ├── SKILL.md
            │   └── references/
            │       ├── answer-quality.md
            │       ├── groundedness.md
            │       └── resolution-quality.md
            │
            ├── evaluation-failure-analysis/
            │   ├── SKILL.md
            │   └── references/
            │       ├── failure-taxonomy.md
            │       └── remediation-rules.md
            │
            ├── github-delivery/
            │   ├── SKILL.md
            │   └── references/
            │       ├── branch-policy.md
            │       ├── commit-policy.md
            │       ├── pull-request-policy.md
            │       └── delivery-checklist.md
            │
            ├── support-delivery/
            │   ├── SKILL.md
            │   └── references/
            │       ├── slack-response-policy.md
            │       ├── discord-response-policy.md
            │       └── github-response-policy.md
            │
            └── documentation-feedback-loop/
                ├── SKILL.md
                ├── references/
                │   ├── feedback-loop-model.md
                │   ├── signal-prioritization.md
                │   ├── documentation-intelligence.md
                │   └── feedback-to-change-policy.md
                └── assets/
                    └── documentation-gap-report.md

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
├── docs/
│   ├── architecture/
│   │   ├── overview.md
│   │   ├── system-design.md
│   │   ├── multi-agent.md
│   │   ├── event-driven.md
│   │   ├── memory.md
│   │   └── feedback-loop.md
│   │
│   ├── workflows/
│   │   ├── github-pr.md
│   │   ├── github-issue.md
│   │   ├── support.md
│   │   ├── documentation-sync.md
│   │   └── feedback-loop.md
│   │
│   ├── agents/
│   │   ├── agent-overview.md
│   │   ├── subagents.md
│   │   └── skills.md
│   │
│   ├── deployment/
│   │   ├── aws.md
│   │   ├── cockroachdb.md
│   │   └── production.md
│   │
│   └── api/
│       └── webhooks.md
│
└
```
