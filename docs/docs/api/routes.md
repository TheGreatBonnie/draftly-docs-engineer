# API Routes Reference

> **Status:** Implemented
> **Date:** 2026-08-25
> **Scope:** Complete REST API route reference — all endpoints, methods, auth requirements, and response formats

## 1. Overview

Draftly exposes a FastAPI application with all routes mounted under the `/api` prefix. The API serves three audiences: frontend applications (user-facing CRUD and onboarding), external platforms (webhook ingestion), and internal services (health checks, metrics). Authentication is enforced per-route via Clerk JWT verification, API key headers, or platform-specific webhook signatures.

All responses use JSON unless otherwise noted. Errors follow the standard FastAPI format: `{"detail": "<message>"}` with appropriate HTTP status codes. The global error handler catches unhandled exceptions and returns `500` with a `request_id` for correlation.

## 2. Route Groups

### 2.1 Health

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/health` | None | Liveness check — returns `{"status": "ok", "service": "draftly"}` |
| `GET` | `/api/health/ready` | None | Readiness check — verifies database, memory, and evaluation store connectivity. Returns `503` if any dependency is unavailable |

### 2.2 Metrics

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/metrics` | None | Prometheus-format metrics exposition (`text/plain; version=0.0.4`). Excluded from OpenAPI schema |
| `GET` | `/api/metrics/snapshot` | None | JSON snapshot of all process-local counters and gauges |

### 2.3 GitHub

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/github/install-url` | JWT | Returns the GitHub App installation URL. Accepts `?return_to=` query (whitelisted paths only) |
| `GET` | `/api/github/setup-callback` | None | GitHub App post-install redirect. Reads `gh_install_return_to` cookie to route browser back to the correct frontend page |
| `POST` | `/api/github/link` | JWT | Links a GitHub App installation to the current Clerk organization. Body: `{"installation_id": int}` |
| `GET` | `/api/github/installations` | JWT | Lists GitHub installations for the current org |
| `DELETE` | `/api/github/installations/{installation_id}` | JWT | Removes a GitHub installation link |
| `POST` | `/api/github/webhook` | None | GitHub webhook ingestion. Verifies `X-Hub-Signature-256`, normalizes events, dispatches to workflow runner |
| `POST` | `/api/github/review/{run_id}` | JWT | Resumes a paused workflow after human review decision. Body: `ReviewDecision` (approved, comment) |

### 2.4 Slack

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/slack/install-url` | JWT | Returns the Slack OAuth authorize URL with required scopes |
| `POST` | `/api/slack/link` | JWT | Links a Slack workspace to the current Clerk organization. Body: `{"team_id": str}` |
| `GET` | `/api/slack/installations` | JWT | Lists all Slack installations |
| `DELETE` | `/api/slack/installations/{team_id}` | JWT | Removes a Slack installation link |
| `GET` | `/api/slack/oauth/callback` | None | Slack OAuth callback — exchanges authorization code for tokens, saves installation, redirects to frontend |
| `POST` | `/api/slack/events` | None | Slack Events API webhook — handled via Bolt's `AsyncSlackRequestHandler` |
| `POST` | `/api/slack/interactivity` | None | Slack interactivity webhook — button clicks, dropdowns, modals |

**Operational contract for Slack:**

- **OAuth installation** begins at `/api/slack/install-url`, which returns a
  scoped authorize URL (`chat:write`, channel history/read scopes). Completing
  OAuth hits `/api/slack/oauth/callback`, which stores the workspace bot token
  in the Slack installation store and redirects the browser back to the
  frontend. A workspace is only routable once its `team_id` is linked to a
  Clerk org via `/api/slack/link`.
- **Ingress** arrives on `/api/slack/events`. The Bolt handler normalizes each
  message (adding an 👀 reaction to acknowledge), then calls
  `enrich_support_event` to resolve `team_id` → Clerk org. Unlinked workspaces
  are dropped. The event is dispatched through the durable worker path.
- **Outbound credentials** are selected by workspace installation
  (`team_id`), not only the environment fallback — each Slack delivery uses the
  token for the originating workspace.
- **Review actions** on Slack (button clicks/modals from `interactivity`)
  resume the paused graph through the shared review-resume helper.

### 2.5 Discord

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/discord/invite-url` | None | Returns the Discord bot invite URL with required permissions (View Channels, Send Messages, etc.) |
| `POST` | `/api/discord/link` | JWT | Links a Discord guild to the current Clerk organization. Body: `{"guild_id": str}` |
| `GET` | `/api/discord/status` | JWT | Returns Discord connection status and guild ID for the current org |
| `GET` | `/api/discord/channels` | JWT | Fetches text channels from the linked Discord guild |
| `GET` | `/api/discord/trigger-channels` | JWT | Returns configured trigger channels for the current org |
| `POST` | `/api/discord/trigger-channels` | JWT | Sets trigger channels. Body: `{"channels": [str]}` |
| `DELETE` | `/api/discord/link` | JWT | Removes the Discord guild link from the current organization |
| `POST` | `/api/discord/interactions` | None | Discord component interactions — Ed25519 signature verification, review decisions via button clicks |

**Operational contract for Discord:**

- **Guild linking** is a two-step flow: the bot is added to a guild via the
  invite URL, then the guild is linked to a Clerk org via `/api/discord/link`.
  Trigger channels restrict which channels the bot answers in.
- **Ingress** arrives on `/api/discord/interactions` (message-create). The
  normalizer runs, `enrich_support_event` resolves `guild_id` → Clerk org, and
  the event is dispatched through the durable worker path.
- **Delivery** validates guild ownership and configured target channels before
  posting to the originating thread.
- **Review actions** from component buttons resume the paused graph through the
  shared review-resume helper.

### 2.6 Documentation

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `POST` | `/api/documentation/sync` | JWT | Submits a documentation sync job. Body: `{"repository_full_name": str, "include": [str]?, "exclude": [str]?}`. Returns `202` with `job_id` |
| `GET` | `/api/documentation/sync/{job_id}` | JWT | Looks up a sync job's status and record |
| `GET` | `/api/documentation/baseline?repository=` | JWT | Returns the current indexed state for a repository (document count, latest commit SHA, stale count) |
| `GET` | `/api/documentation?repository=` | JWT | Lists generated documentation for a repository |
| `GET` | `/api/documentation/{document_id}` | JWT | Fetches one generated document by ID |

### 2.7 Knowledge

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/knowledge` | JWT | Lists the current organization’s curated Knowledge items. Query: `?status=verified|needs-verification|stale&limit=25&cursor=`; limit is bounded to 1–100 |
| `GET` | `/api/knowledge/stats` | JWT | Returns organization-scoped totals for all, verified, needs-verification, and stale items |
| `GET` | `/api/knowledge/search` | JWT | Runs bounded semantic search. Query: `?q=&limit=` (maximum 300-character query and 50 results); returns scalar similarity only |
| `GET` | `/api/knowledge/{item_id}` | JWT | Returns one organization-scoped item with safe provenance, related links, and feedback |
| `GET` | `/api/knowledge/sources` | JWT | Aggregates persisted provenance evidence by source type and repository; this is not connection health |
| `GET` | `/api/knowledge/graph` | JWT | Returns bounded organization-scoped Knowledge nodes and links |
| `GET` | `/api/knowledge/topics` | JWT | Aggregates topic metadata stored on organization-scoped Knowledge items |
| `GET` | `/api/knowledge/embeddings` | JWT | Returns embedding coverage and model names without exposing vectors |

All Knowledge reads require a non-empty `org_id` claim from the verified Clerk token. SQL predicates, including related links and feedback, enforce that organization boundary. List pagination uses an opaque keyset cursor ordered by `updated_at DESC, id DESC`. The response models exclude raw embedding vectors, prompts, credentials, and unrestricted memory metadata.

### 2.7 Evaluations

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/evaluations` | JWT | Lists evaluation runs for the current org. Query: `?evaluation_type=&limit=` (default 50, max 200) |
| `POST` | `/api/evaluations/run` | JWT | Triggers the evaluation loop workflow. Returns status and run ID |

### 2.8 Jobs

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `POST` | `/api/jobs/run` | JWT | Enqueues a registered job for background execution. Body: `{"job_name": str, "arguments": dict}` |
| `GET` | `/api/jobs` | JWT | Lists active background jobs |
| `GET` | `/api/jobs/{job_id}` | JWT | Gets job detail by ID |

### 2.9 Observability

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/observability/routing-decisions` | JWT | Recent model-routing decisions with reason codes. Query: `?limit=` (default 100, max 200) |
| `GET` | `/api/observability/model-performance` | JWT | Per-task/model EMA performance aggregates backing quality gates |
| `GET` | `/api/jobs` | JWT | Currently active background jobs (alias for `/api/jobs`) |

### 2.10 Onboarding

The onboarding flow enforces a linear state machine: `NOT_STARTED` → `WORKSPACE_CREATED` → `GITHUB_CONNECTED` → `REPOSITORY_SELECTED` → `DOCUMENTATION_DISCOVERED` → `INTEGRATIONS_CONFIGURED` → `PREFERENCES_CONFIGURED` → `INITIALIZING` → `COMPLETED`. Same-state replays are idempotent; skipping states returns `409`.

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/onboarding/status` | JWT | Returns current onboarding state, completed steps, and any failure info |
| `POST` | `/api/onboarding/workspace` | JWT | Creates workspace. Body: `{"name": str, "description": str?}` |
| `POST` | `/api/onboarding/github/connect` | JWT | Connects GitHub installation. Body: `{"installation_id": int}` |
| `GET` | `/api/onboarding/github/repositories` | JWT | Lists repositories accessible via the linked installation |
| `POST` | `/api/onboarding/repository` | JWT | Selects a repository. Body: `{"full_name": str, "default_branch": str}` |
| `POST` | `/api/onboarding/documentation/discover` | JWT | Discovers documentation candidates in the selected repository |
| `POST` | `/api/onboarding/sources` | JWT | Confirms documentation sources. Body: `{"include": [str]?, "exclude": [str]?}` |
| `POST` | `/api/onboarding/integrations` | JWT | Configures integrations. Body: `{"slack": bool, "discord": bool}` |
| `POST` | `/api/onboarding/preferences` | JWT | Configures preferences. Body: `{"style": str?, "review_policy": str, "auto_publish": bool}` |
| `POST` | `/api/onboarding/initialize` | JWT | Starts the initialization workflow. Returns `run_id` and SSE ticket |
| `GET` | `/api/onboarding/initialize/status` | JWT | Returns initialization state, stage, and failure details |
| `POST` | `/api/onboarding/initialize/retry` | JWT | Retries a failed initialization |
| `POST` | `/api/onboarding/complete` | JWT | Finalizes onboarding. Requires all steps completed and indexed documents |

### 2.11 Reviewers

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/reviewers/org-members` | Admin | Lists Clerk org members with roles |
| `POST` | `/api/reviewers/assign-role` | Admin | Assigns a role to an org member. Body: `{"user_id": str, "role": str}` |
| `POST` | `/api/reviewers/self` | Reviewer | Registers the current user as a reviewer. Body: `{"slack_user_id": str?, "discord_user_id": str?, ...}` |
| `POST` | `/api/reviewers` | Admin | Creates a new reviewer. Body: `CreateReviewerRequest` |
| `GET` | `/api/reviewers` | JWT | Lists reviewers for the current org. Query: `?org_id=&active_only=true` |
| `GET` | `/api/reviewers/{reviewer_id}` | JWT | Gets a reviewer by ID |
| `PUT` | `/api/reviewers/{reviewer_id}` | JWT | Updates a reviewer. Admin: any reviewer. Reviewer: own profile only (notification prefs + platform IDs) |
| `DELETE` | `/api/reviewers/{reviewer_id}` | Admin | Deletes a reviewer |

### 2.12 Reviews

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/reviews` | JWT | Lists reviews for the current org. Query: `?status=&limit=` (default 100, max 200) |
| `GET` | `/api/reviews/{review_id}` | JWT | Gets a single review by ID (org-scoped) |

### 2.13 Runs

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/runs` | JWT | Lists audit runs for the current org. Query: `?status=&limit=` (default 50, max 200) |
| `GET` | `/api/runs/{run_id}` | JWT | Gets a single audit run by ID (org-scoped) |
| `GET` | `/api/runs/{run_id}/steps` | JWT | Lists ordered agent/tool steps for a run |

### 2.14 Support

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/api/support/questions` | JWT | Lists recent support questions. Query: `?platform=&limit=` (default 50, max 200) |
| `GET` | `/api/support/questions/{question_id}` | JWT | Gets one support thread by ID |

### 2.15 Workflows

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `POST` | `/api/workflows/{run_id}/stream-ticket` | JWT | Issues a single-use SSE ticket for streaming workflow events. Returns `{"ticket": str}` |
| `GET` | `/api/workflows/{run_id}/events?ticket=` | Ticket | SSE stream of workflow events. Heartbeat every 15s. Supports `Last-Event-ID` for replay |
| `POST` | `/api/workflows/dashboard-ticket` | JWT | Issues a single-use SSE ticket for dashboard events |
| `GET` | `/api/workflows/events/dashboard?ticket=` | Ticket | SSE stream of dashboard-wide events (reviews, jobs, runs) |

### 2.16 Clerk

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `POST` | `/api/clerk/webhook` | Svix HMAC | Receives Clerk organization lifecycle events (created, deleted, updated) |

## 3. Auth Requirements Summary

| Auth Type | Mechanism | Used By |
|-----------|-----------|---------|
| None | — | Health, metrics, webhook endpoints |
| Clerk JWT | `Authorization: Bearer <token>` | All user-facing CRUD endpoints |
| Clerk JWT + Admin role | JWT with `org_role == "admin"` | Reviewer management, role assignment |
| Clerk JWT + Reviewer role | JWT with `org_role in ("reviewer", "admin")` | Reviewer self-registration |
| API Key | `X-Draftly-API-Key` header | Internal service-to-service calls (optional, via middleware) |
| Platform signature | Platform-specific | GitHub (`X-Hub-Signature-256`), Slack (Bolt signing), Discord (`X-Signature-Ed25519`), Clerk (`svix-signature`) |
| SSE Ticket | Single-use ticket from Redis | Workflow and dashboard SSE streams |

## 4. Rate Limiting

Rate limiting is configured at the Redis layer but applied selectively:

| Surface | Limiting | Notes |
|---------|----------|-------|
| Webhook endpoints | Idempotency via `try_claim` | Duplicate event IDs are rejected, not rate-limited |
| SSE streams | Single-use tickets | Tickets expire after 60 seconds and are consumed on first use |
| Onboarding | State machine enforcement | Sequential state transitions prevent rapid re-initialization |
| API endpoints | Configurable via Redis | Rate limit headers are not currently returned |

## 5. Error Responses

All error responses follow a consistent structure:

| Status Code | Meaning | Example |
|-------------|---------|---------|
| `400` | Bad request / invalid input | Missing required fields, invalid `return_to` path |
| `401` | Authentication failure | Missing/invalid JWT, invalid webhook signature, bad API key |
| `403` | Authorization failure | Insufficient role, cross-org access, invalid SSE ticket |
| `404` | Resource not found | Unknown run, document, reviewer, or job |
| `409` | Conflict / invalid state transition | Onboarding state machine violation, duplicate reviewer registration |
| `422` | Unprocessable entity | Unhandled webhook event type, invalid repository name format |
| `500` | Internal server error | Unhandled exception (includes `request_id`) |
| `502` | Upstream failure | Initialization workflow failed, Discord channel fetch failed |
| `503` | Service unavailable | Runtime not started, store unavailable, Redis unavailable |

## 6. File Reference

| File | Lines | Role |
|------|-------|------|
| `src/draftly/app/api/app.py` | 123 | FastAPI app factory, router registration under `/api` |
| `src/draftly/app/api/auth.py` | 102 | Clerk JWT verification, role-gated dependencies |
| `src/draftly/app/api/routes/health.py` | 89 | Health and readiness checks |
| `src/draftly/app/api/routes/github.py` | 439 | GitHub webhooks, installation management, review resume |
| `src/draftly/app/api/routes/slack.py` | 164 | Slack events, interactivity, OAuth |
| `src/draftly/app/api/routes/discord.py` | 394 | Discord interactions, guild management |
| `src/draftly/app/api/routes/clerk.py` | 100 | Clerk organization lifecycle webhooks |
| `src/draftly/app/api/routes/documentation.py` | 167 | Documentation sync, baseline, listing |
| `src/draftly/app/api/routes/evaluations.py` | 66 | Evaluation runs and triggers |
| `src/draftly/app/api/routes/jobs.py` | 107 | Background job management |
| `src/draftly/app/api/routes/metrics.py` | 24 | Prometheus metrics and snapshots |
| `src/draftly/app/api/routes/observability.py` | 48 | Routing decisions, model performance, active jobs |
| `src/draftly/app/api/routes/onboarding.py` | 498 | Onboarding state machine and initialization |
| `src/draftly/app/api/routes/reviewers.py` | 276 | Reviewer CRUD and role management |
| `src/draftly/app/api/routes/reviews.py` | 81 | Review queue listing |
| `src/draftly/app/api/routes/runs.py` | 69 | Agent run audit trail |
| `src/draftly/app/api/routes/support.py` | 74 | Support question listing |
| `src/draftly/app/api/routes/workflows.py` | 240 | SSE ticketing and event streaming |
| `src/draftly/app/api/middleware/auth.py` | 37 | API key middleware |
| `src/draftly/app/api/middleware/errors.py` | 37 | Global error handler |
| `src/draftly/app/api/middleware/logging.py` | 72 | Request logging and correlation |
