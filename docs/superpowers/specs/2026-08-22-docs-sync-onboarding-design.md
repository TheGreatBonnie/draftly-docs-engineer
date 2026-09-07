# Draftly Docs Sync + Onboarding — Design Spec

Date: 2026-08-22
Status: Approved design, pending implementation plan
Scope: `draftly-agent-backend` + `draftly-agent-frontend`

## 1. Summary

Implement two subsystems per the approved reference designs (`reference/docs-sync.md`, `reference/onboarding-flow.md`):

1. **Documentation sync engine** (backend): GitHub App–authenticated ingestion of an organization's existing repository documentation into Draftly's document store + pgvector memory index, establishing a baseline against which future changes are evaluated.
2. **Onboarding** (backend + frontend): a durable, server-owned onboarding state machine exposed through a REST API, driven by a 7-step frontend wizard whose final step runs a real initialization workflow built on the sync engine.

Critical distinction preserved throughout: **sync ≠ generation**. Initial import is ingestion-only (no writer agent); generated content enters later via PROPOSED → human review.

## 2. Current State (verified)

### Backend (`draftly-agent-backend`)
- GitHub App auth complete: `integrations/github/app_auth.py` (installation token, installation repos, webhook signature verification); `app/api/routes/github.py` implements `/link`, `/installations`, `/setup-callback`, webhook handling incl. `installation created/deleted`.
- Persistence: `github_installations` table (migration `016`); `documentation` table (migration `010`) already has `commit_sha`, `source_hash`, `status`, `metadata JSONB`, unique `(org_id, path)`.
- `documentation/indexer.py`: single-document upsert w/ topics/keywords/links metadata. No fetching, chunking, or embedding.
- `workflows/documentation/documentation_sync.py`: stub (lists documents, logs count).
- `workflows/documentation/documentation_audit.py`: freshness scan only.
- Memory: `EmbeddingService.embed/embed_batch`, `DomainMemoryRepository` with pgvector search, namespaces.
- Jobs/workers: task runner, `/api/jobs/run`, `workers/indexing_worker.py` running `documentation.sync` every 300s.
- `GitHubClient`: PR/issue/release/repo methods; **no** tree listing or file-content fetch.
- Embeddings are **not wired** into documentation composition.
- No onboarding code anywhere.

### Frontend (`draftly-agent-frontend`)
- All onboarding scaffolding exists as empty files: `app/(onboarding)/onboarding/{page,workspace,github,repository,documentation,integrations,preferences,initialize,complete}` (9 pages + layout), 14 components in `components/onboarding/`, 5 files in `lib/onboarding/`, empty `api/onboarding.ts`.

## 3. Architecture Overview

```
ONBOARDING (frontend wizard)            DOCS SYNC (backend engine)
──────────────────────────              ─────────────────────────────
7 steps → state machine persisted       GitHub App token → tree walk
server-side; drives initialization      → deterministic discovery
workflow on the backend                 → parse → chunk → embed
                                        → baseline → audit
                    ──────────────────────────────►
        initialization workflow chains:
        register repo → sync → knowledge → eval → health
```

## 4. Backend Design — Docs Sync Engine

### 4.1 New modules under `src/draftly/documentation/`

| Module | Responsibility |
|---|---|
| `parser.py` | Parse Markdown into heading tree (H1/H2/H3+) with source line offsets; extract title from first H1. |
| `chunker.py` | Produce heading-bounded chunks. Each chunk: `{heading, heading_path, content, start_line, end_line}`. Oversized sections split on paragraph boundaries at max-char limit (default ~1200 chars). |
| `discovery.py` | Deterministic classification of tree paths into documentation vs other. Include globs: `README.md`, `docs/**`, `*.md`, `*.mdx`, `CHANGELOG.md`, `CONTRIBUTING.md`. Excludes: `node_modules/**`, `dist/**`, `build/**`, `vendor/**`, `.git/**`. Pure function of (path list, include/exclude config). |
| `baseline.py` | Snapshot record after successful sync: commit SHA, document count, section count, indexed chunk count, paths config, synced-at. Stored as JSONB on the sync job record + org-scoped query endpoint. |
| `sync_service.py` | Orchestrator. Steps below. |

### 4.2 `GitHubClient` extensions (`integrations/github/client.py`)

- `async get_tree(owner, repo, ref) -> list[TreeEntry]` — Git trees API (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`), paginated.
- `async get_file_contents(owner, repo, path, ref) -> str` — Contents API; base64 decode; guard size limits (>1 MB skip with warning).
Both accept an installation access token.

### 4.3 Sync orchestrator (`sync_service.py`)

```
resolve installation (org_id → github_installations)
→ mint short-lived installation token (cache ≤ 60 min, never persist)
→ get default branch + head commit SHA (get_repository)
→ get_tree(recursive)
→ discovery.filter(paths, include/exclude)
→ for each candidate: get_file_contents
    → sha256(content) == stored source_hash ⇒ SKIP (unchanged)
    → else upsert document row (status='source', commit_sha, source_hash,
      metadata: {source_url, branch})
→ parser.parse + chunker.chunk each changed doc
→ embed chunks (EmbeddingService.embed_batch)
→ store chunks as memory items, namespace 'documentation',
   metadata {document_id, path, heading_path, start_line, end_line, commit_sha}
   (delete stale chunks for re-indexed documents first)
→ mark documents status='indexed'
→ write baseline snapshot; enqueue initial audit
```

Idempotency: keyed on `(org_id, path)` unique constraint + content-hash skip. Re-running a completed sync yields zero-op.

Document states use existing `status` column: `source` → `indexed`; `proposed` reserved for future review-gated generation.

### 4.4 Chunk storage decision

Chunks live in the **existing pgvector memory store** (`DomainMemoryRepository`), namespace `documents` (the existing `MemoryNamespaces.DOCUMENTS` constant) — chosen over a new `document_chunks` table because embedding + semantic search plumbing already exists there and no new migration/vector code is required. Chunk lifecycle is managed by deleting existing items whose metadata `document_id` matches before re-inserting a re-indexed document.

### 4.5 API surface (extend `app/api/routes/documentation.py`)

```
POST /api/documentation/sync
  body: {repository_full_name, include?: [globs], exclude?: [globs]}
  → creates job via task runner ('documentation.sync_repository')
  → 202 {job_id, repository, status:'queued'}

GET /api/documentation/sync/{job_id}
  → {status: queued|running|completed|failed, counts:{documents,sections,chunks},
     baseline?, error?}

GET /api/documentation/baseline?repository=…
  → latest baseline snapshot
```

Task registered alongside existing scheduled tasks so both the HTTP trigger and `workers/indexing_worker.py` can run it.

### 4.6 Audit upgrade

`run_documentation_audit` extended beyond freshness: broken internal links (analyzer output vs known paths), orphaned docs (no inbound links), missing coverage candidates (code files w/o referencing doc, best-effort via search_code), duplicate headings. Output persisted with the baseline; surfaced via API. Still advisory-only — findings require human review; nothing auto-modifies the repository.

## 5. Backend Design — Onboarding

### 5.1 State machine (new migration `024_onboarding.sql`)

```sql
CREATE TABLE onboarding_state (
    org_id TEXT PRIMARY KEY REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'NOT_STARTED',
    completed_steps JSONB NOT NULL DEFAULT '[]'::JSONB,
    failure JSONB,                      -- {step, detail} when FAILED
    selected_repository JSONB,          -- {full_name, branch, doc_paths}
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

States (linear, persisted per transition):
`NOT_STARTED → WORKSPACE_CREATED → GITHUB_CONNECTED → REPOSITORY_SELECTED → DOCUMENTATION_DISCOVERED → INTEGRATIONS_CONFIGURED → PREFERENCES_CONFIGURED → INITIALIZING → COMPLETED`
`INITIALIZING` may transition to `FAILED` (stores failure detail) and back to `INITIALIZING` via retry.

New migration `025_repositories.sql`: `repositories` table for the org's selected repo connection (full_name, default_branch, doc include/exclude config, installation FK).

### 5.2 API (`app/api/routes/onboarding.py`, mounted under `/onboarding`)

| Endpoint | Behavior |
|---|---|
| `GET /status` | Current state + completed steps + failure detail |
| `POST /workspace` | Create/update workspace name+description; state ≥ WORKSPACE_CREATED. Idempotent |
| `POST /github/connect` | Delegates to existing `/github/link` logic; advances state |
| `GET /github/repositories` | List installation repos (existing app_auth helpers) |
| `POST /repository` | Persist selected repo + branch (+ auto-detected doc dir); REPOSITORY_SELECTED |
| `POST /documentation/discover` | Run tree fetch + discovery (no full sync); returns candidate sources w/ counts |
| `POST /sources` | Confirm include/exclude paths; DOCUMENTATION_DISCOVERED |
| `POST /integrations` | Slack/Discord optional selection (may be skipped); INTEGRATIONS_CONFIGURED |
| `POST /preferences` | Style/review policy/automation toggles; defaults applied if skipped; PREFERENCES_CONFIGURED |
| `POST /initialize` | If init already queued/running → return existing (idempotent). Else create init job; INITIALIZING |
| `GET /initialize/status` | Stage-by-stage progress for UI pipeline |
| `POST /initialize/retry` | Only from FAILED; resets to INITIALIZING, re-runs same idempotent workflow |
| `POST /complete` | Verify COMPLETED prerequisites; finalizes |

Every transition validated against the state machine (no skipping required steps); every POST idempotent.

### 5.3 Initialization workflow

Registered task `onboarding.initialize` in workflow/task composition:

```
register repository connection
→ docs sync (§4.3 engine)              stage: repository_ingestion/indexing
→ knowledge extraction summary         stage: knowledge_construction
→ initial evaluation (existing loop)   stage: initial_evaluation
→ health calculation                   stage: health_report
→ recommendations (audit findings)     stage: recommendations
→ mark COMPLETED
```

Each stage writes progress to the job record so `GET /initialize/status` reflects real state; browser-close safe. On stage failure: persist failure detail, state → FAILED.

Preferences (style, review policy, automation) stored on workspace/org config; defaults: human review ON for all changes, drift detection ON, auto-publish OFF.

## 6. Frontend Design

Fill the existing empty scaffolding only; no new routes.

- `lib/onboarding/types.ts` — step ids mirroring §5.2 states; shared DTOs.
- `lib/onboarding/constants.ts` — step order, labels.
- `lib/onboarding/steps.ts` — step registry (component key, validation fn, next/prev).
- `lib/onboarding/validation.ts` — plain TypeScript validators (frontend has no validation library; deps are Clerk/Next/Tailwind/lucide only).
- `lib/onboarding/navigation.ts` — route builders + guard helper.
- `api/onboarding.ts` — typed client using existing `api/client.ts` wrapping (no separate auth logic).
- `components/onboarding/*` — shell (header/progress/footer), per-step forms/pickers, initialization-progress polling `initialize/status`, initialization-error w/ retry, completion summary.
- Pages render shell + step component; `layout.tsx` provides wizard chrome outside dashboard sidebar.
- Guard: Clerk post-auth URLs (`afterSelectOrganizationUrl` etc.) point at `/onboarding`; the onboarding entry page + dashboard use a shared client-side guard hook that fetches `GET /onboarding/status` and redirects (incomplete → first incomplete step; complete → `/dashboard`). Post-auth destination never hard-coded to `/dashboard`.
- Required steps: workspace, github, repository, documentation discovery, initialization. Optional: slack, discord, preferences (defaults).

Failure UX per reference §19: explicit retry/manual-continue states for OAuth fail, repo unavailable, discovery fail, init fail. No infinite spinners.

Completion screen shows real numbers from baseline/eval/health endpoints.

## 7. Error Handling Summary

- Sync: partial failures recorded per-file; job continues; failed files listed in job result. Hard failures (auth/tree fetch) fail the job cleanly.
- Init: any stage failure → FAILED w/ detail; retry restarts idempotently (hash-skip makes re-sync cheap).
- All API errors follow existing middleware error envelope.

## 8. Testing

Backend: pytest + pytest-asyncio (existing suites under `tests/unit`, `tests/api`, `tests/integration`).
- Unit: parser (fixture markdown → expected heading tree/line ranges), chunker (split behavior incl. oversized), discovery (glob include/exclude matrix), state-machine transition table, idempotency rules (double initialize, double sync).
- Integration: sync against fixture repo payloads (mocked GitHub responses) → assert document rows + chunk embeddings retrievable via semantic search; audit checks on seeded fixtures.
- Route tests: onboarding happy path through all steps; invalid transitions rejected; double-click idempotency.
- E2E smoke (manual/scripted): workspace → connect → select repo → discover → initialize → health screen populated.

## 9. Out of Scope (this pass)

- Continuous webhook-driven incremental re-sync beyond what push events already route today.
- Writer-agent generation during onboarding (explicitly excluded by design).
- Slack/Discord message ingestion pipelines (connection/selection only).
- Multi-repo per org UI (data model allows; UI selects one).
