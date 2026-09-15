# Draftly Documentation

Start here to understand and work with Draftly.

## Getting Started

- [System Design](architecture/system-design.md) — startup order, lifecycle, composition root
- [AWS Deployment](deployment/aws.md) — container images, env vars, scaling

## Architecture

- [System Design](architecture/system-design.md) — application lifecycle and composition
- [Memory](architecture/memory.md) — episodic, procedural, and documentation memory
- [Models Router](architecture/models-router.md) — adaptive model routing
- [Orchestration](architecture/orchestration.md) — Strands graphs and workflow execution
- [Persistence](architecture/persistence.md) — migrations, repositories, stores
- [Redis](architecture/redis.md) — event streaming and caching
- [Security](architecture/security.md) — authentication, authorization, secrets
- [Review](architecture/review.md) — human-in-the-loop review gates
- [Observability](architecture/observability.md) — logging, metrics, audit trail
- [Delivery](architecture/delivery.md) — PR creation, Slack/Discord delivery
- [Evaluation](architecture/evaluation.md) — golden datasets, rubric grading
- [Integrations](architecture/integrations.md) — GitHub, Slack, Discord, Clerk

## API

- [Routes](api/routes.md) — endpoint reference
- [Webhooks](api/webhooks.md) — GitHub, Slack, Discord, Clerk webhook handlers

## Workflows

- [Overview](workflows/overview.md) — workflow types and lifecycle
- [GitHub PR](workflows/github-pr.md) — pull request documentation flow
- [GitHub Issue](workflows/github-issue.md) — issue triage and response
- [Support](workflows/support.md) — Slack/Discord support responses
- [Feedback](workflows/feedback.md) — user feedback collection
- [Docs Sync](workflows/docs-sync.md) — documentation synchronization

## Agents

- [Overview](agents/agent-overview.md) — agent catalog and roles
- [Skills](agents/skills.md) — bundled agent skills
- [Subagents](agents/subagents.md) — agent decomposition patterns

## Deployment

- [AWS](deployment/aws.md) — ECS, Lambda, environment variables
- [Redis](deployment/redis.md) — event streaming setup
- [Production](deployment/production.md) — production checklist
- [CockroachDB](deployment/cockroachdb.md) — database setup
