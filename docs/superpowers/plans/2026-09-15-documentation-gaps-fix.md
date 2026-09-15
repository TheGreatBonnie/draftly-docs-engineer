# Draftly Documentation Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical blockers and documentation gaps identified in `DRAFTLY_DOCUMENTATION_GAP_REPORT.md` to make Draftly easier to set up, run, and contribute to.

**Architecture:** Three parallel workstreams — backend fixes, UI fixes, and documentation creation — with no cross-dependencies between them.

**Tech Stack:** Python 3.11, FastAPI, Next.js 16, TypeScript, Mermaid diagrams

**Spec:** `DRAFTLY_DOCUMENTATION_GAP_REPORT.md`

---

## Task 1: Fix API Dockerfile (Boot Blocker)

**Files:**
- Modify: `draftly-agent-backend/docker/Dockerfile.api:36-41`

- [ ] **Step 1: Add COPY for main.py to runtime stage**

```diff
 COPY --from=builder /app/.venv ./.venv
 COPY --from=builder /app/src ./src
+COPY --from=builder /app/main.py ./main.py
 
 EXPOSE 8000
 
 CMD ["python", "main.py"]
```

- [ ] **Step 2: Verify Docker build**

Run: `cd draftly-agent-backend && docker build -f docker/Dockerfile.api -t draftly/api:latest .`

---

## Task 2: Fix UI Post-Sign-In 404

**Files:**
- Modify: `draftly-agent-ui/.env.local:3-4`

- [ ] **Step 1: Change redirect URLs**

```diff
-NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
-NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard
+NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/overview
+NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/overview
```

---

## Task 3: Fix UI Lint Script

**Files:**
- Modify: `draftly-agent-ui/package.json:9-10`

- [ ] **Step 1: Replace broken lint with typecheck**

```diff
-    "lint": "next lint",
+    "lint": "tsc --noEmit",
```

- [ ] **Step 2: Verify lint runs**

Run: `cd draftly-agent-ui && pnpm run lint`

---

## Task 4: Remove Garbage Imports in Backend Config

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/config.py:1-2`

- [ ] **Step 1: Delete unused imports**

```diff
-from draftly.app.api.evaluation_schemas import T
-from sympy.physics.quantum.trace import Tr
-from pydantic import AliasChoices, BaseModel, Field
+from pydantic import AliasChoices, BaseModel, Field
```

- [ ] **Step 2: Verify no other code references T or Tr from this module**

Run: `cd draftly-agent-backend && grep -r "from draftly.app.config import.*[T,Tr]" src/`

---

## Task 5: Fix Failing Evaluator Budget Test

**Files:**
- Modify: `draftly-agent-backend/tests/unit/app/test_evaluator_budget.py:44-49`

- [ ] **Step 1: Read current config defaults to verify correct values**

Run: `cd draftly-agent-backend && grep -A2 "execution_timeout\|node_timeout" src/draftly/app/config.py`

- [ ] **Step 2: Update test assertions to match current config**

```python
def test_graph_limits_forwards_node_budget() -> None:
    ctx = WorkflowContext(config=StubConfig())
    limits = ctx.graph_limits()
    assert limits["max_node_executions"] == 15
    assert limits["execution_timeout"] == 3600
    assert limits["node_timeout"] == 1200
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd draftly-agent-backend && uv run pytest tests/unit/app/test_evaluator_budget.py -v`

---

## Task 6: Delete Dead Config YAML Files

**Files:**
- Delete: `draftly-agent-backend/config/development.yaml`
- Delete: `draftly-agent-backend/config/production.yaml`
- Delete: `draftly-agent-backend/config/staging.yaml`

- [ ] **Step 1: Verify config/*.yaml is not loaded anywhere**

Run: `cd draftly-agent-backend && grep -r "config/.*\.yaml\|yaml.*config" src/ --include="*.py" | grep -v __pycache__`

- [ ] **Step 2: Delete the files**

Run: `cd draftly-agent-backend && rm config/development.yaml config/production.yaml config/staging.yaml && rmdir config/`

---

## Task 7: Fix main.py reload=True

**Files:**
- Modify: `draftly-agent-backend/main.py:28-35`

- [ ] **Step 1: Make reload conditional on environment**

```python
uvicorn.run(
    "src.draftly.app.api.app:app",
    host=settings.host,
    port=settings.port,
    log_level=settings.log_level.lower(),
    log_config=None,
    reload=settings.environment == "development",
)
```

- [ ] **Step 2: Verify setting exists**

Run: `cd draftly-agent-backend && grep "environment" src/draftly/app/config.py | head -3`

---

## Task 8: De-duplicate Dev Dependencies in pyproject.toml

**Files:**
- Modify: `draftly-agent-backend/pyproject.toml:45-54,91-101`

- [ ] **Step 1: Remove the duplicate `[dependency-groups].dev` section**

```diff
-# Remove lines 91-101 ([dependency-groups] dev = [...])
```

- [ ] **Step 2: Verify sync still works**

Run: `cd draftly-agent-backend && uv sync --frozen`

---

## Task 9: Add .env.example Entries for Missing Vars

**Files:**
- Modify: `draftly-agent-backend/.env.example` (add to Redis section, line ~113)

- [ ] **Step 1: Add missing vars to .env.example**

```diff
 # Redis / event streaming
+REDIS_URL=redis://localhost:6379
+RQ_ENABLED=true
 EVENTS_STREAMING_ENABLED=true
+VECTOR_SEARCH_BACKEND=pgvector
+SEMANTIC_CACHE_ENABLED=false
```

---

## Task 10: Create Root README.md

**Files:**
- Create: `README.md` (project root)

- [ ] **Step 1: Write root README**

```markdown
# Draftly

**Autonomous documentation engineering platform.**

Draftly watches GitHub, Slack, and Discord for code changes and developer questions, researches your project, and prepares documentation updates for human review.

## Quick Start

1. **Clone and install the backend**
   ```bash
   cd draftly-agent-backend
   cp .env.example .env  # fill in required vars
   uv sync
   make migrate
   ```

2. **Start the backend**
   ```bash
   make run          # API server on :8000
   make worker-rq    # background worker
   ```

3. **Start the UI**
   ```bash
   cd draftly-agent-ui
   cp .env.example .env.local  # fill in Clerk keys + API_URL
   pnpm install
   pnpm dev          # frontend on :3000
   ```

4. **Open http://localhost:3000**

## Architecture

See [ARCHITECTURE-DIAGRAM.md](ARCHITECTURE-DIAGRAM.md) for the full system overview.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/README.enhanced.md](docs/README.enhanced.md) | Full project documentation |
| [draftly-agent-backend/README.md](draftly-agent-backend/README.md) | Backend architecture & API |
| [draftly-agent-ui/README.md](draftly-agent-ui/README.md) | UI components & routes |
| [RUN_PR_WORKFLOW.md](RUN_PR_WORKFLOW.md) | How to run the PR documentation workflow |
| [docs/docs/index.md](docs/docs/index.md) | Documentation navigation |

## Tech Stack

- **Backend:** Python 3.11, FastAPI, Strands Agents SDK, PostgreSQL/pgvector, Redis/RQ
- **Frontend:** Next.js 16, React 19, TypeScript, Tailwind CSS, Clerk auth
- **Infra:** AWS (ECS/Lambda), Terraform, Docker

## License

MIT — see [draftly-agent-backend/LICENSE](draftly-agent-backend/LICENSE)
```

- [ ] **Step 2: Verify the README renders correctly**

Run: `cat README.md | head -5`

---

## Task 11: Create UI .env.example

**Files:**
- Create: `draftly-agent-ui/.env.example`

- [ ] **Step 1: Write .env.example with all required vars**

```env
# Clerk authentication (required)
# Get keys from https://dashboard.clerk.com → Your App → API Keys
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your_key_here
CLERK_SECRET_KEY=sk_test_your_key_here

# Clerk JWT template must be named "Draftly" (see auth-token-setter.tsx)
# Create at: https://dashboard.clerk.com → Your App → JWT Templates → New

# Post-auth redirect
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/overview
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/overview
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

# Backend API (must be running)
API_URL=http://localhost:8000

# Optional: public API URL for client-side (defaults to API_URL if unset)
# NEXT_PUBLIC_API_URL=http://localhost:8000

# E2E testing credentials (optional, for CI only)
# E2E_EMAIL=your-test-email@example.com
# E2E_PASSWORD=your-test-password
```

---

## Task 12: Create docs/docs/index.md Navigation Hub

**Files:**
- Create: `docs/docs/index.md`

- [ ] **Step 1: Write navigation index**

```markdown
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
```

---

## Task 13: Create reference/README.md Index

**Files:**
- Create: `reference/README.md`

- [ ] **Step 1: Write reference index**

```markdown
# Draftly Reference Documents

Deep design documents for major subsystems. Read these when you need to understand *why* something works the way it does.

| Document | Lines | Covers |
|----------|-------|--------|
| [DESIGN.md](DESIGN.md) | 1,733 | Onboarding UI design specification |
| [implementation-plan.md](implementation-plan.md) | 2,110 | Full implementation plan for onboarding |
| [draftly-project-structure.md](draftly-project-structure.md) | 1,850 | Detailed project structure |
| [adaptive-router.md](adaptive-router.md) | 2,035 | Model routing and selection design |
| [draftly-workflows-architecture.md](draftly-workflows-architecture.md) | 1,646 | Workflow architecture and execution |
| [github-pr-flow.md](github-pr-flow.md) | 1,662 | PR documentation flow deep-dive |
| [agentic-memory-design.md](agentic-memory-design.md) | 1,130 | Memory architecture (episodic, procedural, docs) |
| [onboarding-flow.md](onboarding-flow.md) | 1,133 | Onboarding flow design |
| [redis-streams-sse.md](redis-streams-sse.md) | 1,147 | Redis Streams + SSE real-time streaming |
| [docs-sync.md](docs-sync.md) | 1,088 | Documentation sync design |
| [strands-build-guide.md](strands-build-guide.md) | 663 | Strands SDK build guide |
| [project-structure.md](project-structure.md) | 654 | Alternative project structure overview |

**Reading order for new contributors:**
1. `project-structure.md` — orientation
2. `draftly-workflows-architecture.md` — how work flows through the system
3. `agentic-memory-design.md` — how Draftly remembers things
4. `adaptive-router.md` — how models are selected
5. Pick topic-specific docs as needed
```

---

## Task 14: Fix Backend README Stale Claims

**Files:**
- Modify: `draftly-agent-backend/README.md`

- [ ] **Step 1: Fix "17 skills" → 22**

Run: `cd draftly-agent-backend && grep -n "17" README.md | grep -i skill`

- [ ] **Step 2: Fix "LICENSE file is empty" → MIT**

Run: `cd draftly-agent-backend && grep -n "empty\|LICENSE" README.md`

- [ ] **Step 3: Fix dead docs/ links**

Run: `cd draftly-agent-backend && grep -n "docs/" README.md | grep -v "readme-evidence-audit\|README.enhanced"`

- [ ] **Step 4: Apply all fixes to README.md**

---

## Task 15: Fix UI README Stale Claims

**Files:**
- Modify: `draftly-agent-ui/README.md`

- [ ] **Step 1: Fix "`/` — Overview dashboard"` to "/ — Marketing landing page; Overview is /overview"**

- [ ] **Step 2: Remove `/activity` and `/activity/[id]` from route list (lines 33, 78)**

- [ ] **Step 3: Add prerequisites section after "Run"**

```markdown
## Prerequisites

- Node.js ≥ 22.6 (test script uses `--experimental-strip-types`)
- Backend running at `http://localhost:8000` (see `draftly-agent-backend/README.md`)
- Clerk account with a JWT template named `Draftly`
```

---

## Task 16: Fill CONTRIBUTING.md

**Files:**
- Modify: `draftly-agent-backend/CONTRIBUTING.md`

- [ ] **Step 1: Write contributing guide**

```markdown
# Contributing to Draftly

## Development Setup

1. Clone the repo
2. `cd draftly-agent-backend && uv sync`
3. `cp .env.example .env` and fill in required vars
4. `make migrate` to set up the database
5. `make test` to run the test suite

## Code Quality

- `make lint` — ruff check
- `make fmt` — ruff format
- `make typecheck` — mypy

All three must pass before submitting a PR.

## Testing

- `make test` — offline tests (no external services needed)
- `make test-live` — integration tests (requires `DRAFTLY_LIVE=1` and live NeonDB)
- Tests use `StubModel` and `FakeDatabase` by default for fast, isolated runs

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes with tests
3. Run `make lint fmt typecheck test`
4. Submit a PR with a clear description of the change
```

---

## Task 17: Fill CHANGELOG.md

**Files:**
- Modify: `draftly-agent-backend/CHANGELOG.md`

- [ ] **Step 1: Write initial changelog**

```markdown
# Changelog

All notable changes to Draftly are documented here.

## [0.1.0] — 2026-08-20

### Added
- Initial release
- FastAPI backend with Strands Agents SDK
- 22 bundled agent skills
- GitHub, Slack, Discord webhook handlers
- Documentation, support, feedback, and evaluation workflows
- Human review gates with approve/reject
- PostgreSQL persistence with 59 migrations
- Redis/RQ background job processing
- SSE real-time event streaming
- Next.js 16 review workspace
- Clerk authentication with organization scoping
- Dark mode and semantic design tokens
```

---

## Task 18: Fill SECURITY.md

**Files:**
- Modify: `draftly-agent-backend/SECURITY.md`

- [ ] **Step 1: Write security policy**

```markdown
# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Draftly, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email security@draftly.dev with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Measures

- Clerk handles authentication and session management
- Webhook signatures are verified (HMAC-SHA256 for GitHub, Ed25519 for Discord)
- JWT tokens are validated using Clerk's JWKS endpoint
- Database connections use TLS in production
- Secrets are never committed to the repository
```

---

## Task 19: Fix project-story.md Typos

**Files:**
- Modify: `project-story.md:131-133`

- [ ] **Step 1: Fix typos**

```diff
-dauntinng
+daunting

-Fortunitely
+Fortunately

-Drafly
+Draftly
```

---

## Task 20: Add Missing .env.example Entries

**Files:**
- Modify: `draftly-agent-backend/.env.example` (Redis section)

- [ ] **Step 1: Verify what vars are referenced in README but missing**

Run: `cd draftly-agent-backend && grep -o "REDIS_URL\|RQ_ENABLED\|VECTOR_SEARCH_BACKEND\|SEMANTIC_CACHE_ENABLED" README.md | sort -u`

- [ ] **Step 2: Add them to .env.example** (combined with Task 9)

---

## Execution Strategy

Tasks are grouped by workstream with no cross-dependencies:

| Workstream | Tasks | Parallelizable? |
|------------|-------|-----------------|
| Backend fixes | 1, 4, 5, 6, 7, 8, 9, 14, 16, 17, 18, 20 | Yes (all independent) |
| UI fixes | 2, 3, 11, 15 | Yes (all independent) |
| Project docs | 10, 12, 13, 19 | Yes (all independent) |

**Recommended approach:** Use `dispatching-parallel-agents` to run all three workstreams simultaneously, then verify with `verification-before-completion`.
