# Running the Pull Request Documentation Workflow

This guide explains how to run the Draftly pull-request documentation workflow **two ways**:

1. **Locally, without touching GitHub** — POST a hand-crafted `pull_request.opened` webhook payload
   to `POST /api/github/webhook`. This verifies the ingest path (signature verification, event
   normalization, the PR admission gate, dispatch, the runner gate, and graph startup) end-to-end.
2. **With a real GitHub PR** — push an `authly` feature branch and open a PR so GitHub's webhook
   drives the workflow with real PR/diff evidence.

For the deep architecture of every step (normalization, gates, idempotency, graph lifecycle,
persistence), see [`GITHUB_PR_EVENT_WORKFLOW_ANALYSIS.md`](./GITHUB_PR_EVENT_WORKFLOW_ANALYSIS.md).
This document is the practical _how to_ for that pipeline.

---

## How the trigger works (30-second mental model)

The workflow is **not** GitHub Actions. GitHub only notifies Draftly; Draftly does the rest.

```
GitHub webhook (or crafted local request)
   │  POST /api/github/webhook
   ▼
verify X-Hub-Signature-256 (HMAC-SHA256 of raw body)      → 401 on mismatch
   ▼
normalize payload → event_type = "pull_request.opened"   → 422 if unhandled
   ▼
reserve identity: organizations.github_org == repo owner → 422 "not linked" if absent
   ▼
ROUTE GATE  pull_request.*  that is NOT .opened  → 200 "skipped, not opened"
   ▼
persist jobs row + github_workflows row (run-scoped)
   ▼
dispatch  RQ "webhooks" queue (github_pr.enqueue)   or  in-process BackgroundTasks
   ▼
RUNNER GATE  (authoritative) same .opened filter  → SKIPPED if other action
   ▼
idempotency claim → build per-run graph → run → ReviewGate → pending_review / delivered
```

The PR admission gate (only `pull_request.opened` runs the graph) is enforced
**twice**: at the route edge (`draftly-agent-backend/src/draftly/app/api/routes/github.py:313-321`) and
authoritatively in the runner (`draftly-agent-backend/src/draftly/workflows/runner.py:296-304`).

---

## Prerequisites (both flows)

All commands below assume the backend lives in `draftly-agent-backend`.

| Item         | What you need                                                 | Notes                                                                                                              |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Dependencies | `make sync` (uv)                                              | Python 3.x, `uv` installed                                                                                         |
| `.env`       | `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`                       | Plus `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_PRIVATE_KEY_PATH` for real-GitHub runs                            |
| Database     | `make migrate` (runs `scripts/bootstrap.py`)                  | Neon (serverless Postgres) at `DATABASE_URL`; creates `organizations`, `jobs`, `github_workflows`, etc.            |
| Redis        | Up at `REDIS_URL` (default `redis://localhost:6379/0`)        | Only required for the RQ dispatch path; without it the API falls back to in-process execution                      |
| Org identity | A row in `organizations` with `github_org = 'TheGreatBonnie'` | Without it, every webhook is rejected with **422 "GitHub organization 'TheGreatBonnie' is not linked to Draftly"** |
| LLM keys     | OpenAI/Anthropic-compatible keys in `.env`                    | Only needed for the graph to actually reason/generate                                                             |
| Checkout     | Real `authly` worktree with `.git`, mounted at `/tmp/repos/TheGreatBonnie/authly` | Lets Part 1 ground in `local` mode; the docker worker mount provides it automatically. Host workers need the symlink/`DRAFTLY_REPO_CHECKOUT_ROOT` from the Part 1 caveats |

### Load your environment

```bash
cd draftly-agent-backend
set -a; source .env; set +a
```

---

## Part 1 — Local run with a crafted webhook (gate verification)

Goal: prove that a `pull_request.opened` event passes both gates, gets dispatched, and starts the
documentation graph — **without** a real GitHub PR, installation, or git push.

### Step 1.1 Start the API and the RQ worker

Two terminals.

Terminal A — API server (receives webhook, persists, enqueues):

```bash
cd draftly-agent-backend
make run        # python main.py → uvicorn 0.0.0.0:8000 (reload)
```

Terminal B — RQ worker (executes the job; the runner gate and graph run here). Two options:

Host worker:

```bash
cd draftly-agent-backend
make worker-rq  # python -m workers.rq_worker (queues: scheduled, webhooks, default)
```

Docker worker (**recommended for Part 1** — mounts the `authly` checkout so the run grounds on the
real worktree; the API still runs on the host):

```bash
cd draftly-agent-backend
docker compose -f docker-compose.redis.yml up -d --build rq-worker
#  redis      → redis:7-alpine on :6379
#  rq-worker  → `python -m workers.rq_worker` (starts after redis healthcheck)
```

The compose file already mounts `../authly` to `/tmp/repos/TheGreatBonnie/authly`
([`docker-compose.redis.yml`](draftly-agent-backend/docker-compose.redis.yml)) — exactly the path the
runner probes for a local checkout, so the run grounds in `local` mode automatically. Container
gotchas: `DATABASE_URL` is passed into the container verbatim, so it must resolve **from inside** the
container (a public Neon URL works; `localhost` would mean the container itself); and
`secrets/private-key.pem` must exist for the image build.

If you do **not** want Redis/RQ for the smoke test, set `RQ_ENABLED=false` in `.env` and restart;
the webhook will then dispatch through FastAPI `BackgroundTasks` (log marker
`github_webhook_dispatch_inprocess` instead of `github_webhook_enqueued`).

Check the config that governs dispatch:

```bash
grep -E "RQ_ENABLED|REDIS_URL" .env   # leave RQ_ENABLED unset/true for RQ dispatch
```

### Step 1.2 Link the org identity (one-time)

`seed_demo.py` creates `demo-org` but does not set `github_org`. Link it so webhooks from
`TheGreatBonnie` resolve to that organization:

```bash
psql "$DATABASE_URL" -c \
  "UPDATE organizations SET github_org='TheGreatBonnie' WHERE clerk_org_id='demo-org';"
```

Verify the row exists:

```bash
psql "$DATABASE_URL" -c \
  "SELECT clerk_org_id, github_org FROM organizations WHERE github_org='TheGreatBonnie';"
```

### Step 1.3 Create the payload

GitHub webhooks are JSON. The normalizer (`PullRequestProcessor`,
`draftly-agent-backend/src/draftly/events/github/pull_request.py`) reads `action`, `pull_request`,
`repository.full_name`, `sender.login`, and (recommended) `installation.id`.

A ready-to-use `pull_request.opened` payload for `TheGreatBonnie/authly` is committed at
`draftly-agent-backend/scripts/pr_opened.json` (head `feat/001-oauth-login@b0d7fb8`). Use it, or
generate a custom one:

```bash
cat > scripts/pr_opened.json <<'EOF'
{
  "action": "opened",
  "number": 1,
  "pull_request": {
    "id": 123456,
    "number": 1,
    "state": "open",
    "title": "feat: add OAuth login with authorization-code exchange",
    "body": "Adds OAuth authorization-code exchange (OAuthClient.exchange_code) with a deterministic per-provider identity user, plus an OAuth-backed login path (AuthService.login_with_oauth).",
    "html_url": "https://github.com/TheGreatBonnie/authly/pull/1",
    "head": { "ref": "feat/001-oauth-login", "sha": "b0d7fb8" },
    "base": { "ref": "master", "sha": "9a8581c" },
    "labels": [],
    "merged": false,
    "user": { "login": "scenario-bot" }
  },
  "repository": { "full_name": "TheGreatBonnie/authly" },
  "sender": { "login": "scenario-bot" },
  "installation": { "id": 42 }
}
EOF
```

> **The committed payload already carries the real evidence.** `scripts/pr_opened.json` ships
> `changed_files`, `changed_file_details`, `file_actions`, and `diff` computed from the
> `001-oauth-login` scenario diff (base `9a8581c` → head `b0d7fb8`). `PullRequestProcessor`
> (`src/draftly/events/github/pull_request.py`) forwards these into the normalized event, so
> downstream candidate/memory extraction sees the true changed files. If you hand-craft a payload you
> may include them the same way; omitting them still runs, just with sparser post-run memory.

> **Signature matters — hash the exact bytes.** The HMAC is computed over the raw request body
> (`verify_webhook_signature`, `src/draftly/integrations/github/app_auth.py:74`, header required as
> `X-Hub-Signature-256: sha256=<hex>`), so any whitespace change invalidates it. Always
> `--data-binary @file` and compute the signature from the same file.

### Step 1.4 Sign and POST

```bash
cd draftly-agent-backend
set -a; source .env; set +a

SIG=$(python3 - <<'PY'
import hmac, hashlib, os
body = open("scripts/pr_opened.json", "rb").read()
print("sha256=" + hmac.new(os.environ["GITHUB_WEBHOOK_SECRET"].encode(), body, hashlib.sha256).hexdigest())
PY
)

DELIVERY=$(uuidgen)
curl -i -X POST http://localhost:8000/api/github/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: $DELIVERY" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary @scripts/pr_opened.json
```

### Step 1.5 Confirm the gate passed and the graph started

**HTTP response:** `200` with `{"status":"pull_request.opened (run_id=$DELIVERY)"}` proves the
**route gate admitted `.opened`** (a `pull_request.edited`/closed payload instead returns
`"pull_request.edited (skipped, not opened)"`).

**API log (Terminal A):**

```
github_webhook_received event_type=pull_request delivery_id=<delivery>
github_webhook_enqueued  task_name=github_pr.enqueue run_id=<delivery> rq_job_id=...
      # or, without RQ: github_webhook_dispatch_inprocess task_name=github_pr.enqueue run_id=<delivery>
```

**Worker log (Terminal B) — this is the runner gate + graph:**

```
workflow_started event_type=pull_request.opened surface=pull_request run_id=<delivery>
```

You must **not** see `workflow_skipped_pr_not_merged` (that marker means the runner gate rejected it).

**Grounding — how the run chooses its evidence** (`src/draftly/workflows/grounding.py`):

- **local** — a real git checkout exists at `<checkout-root>/TheGreatBonnie/authly` (`checkout-root`
  is `DRAFTLY_REPO_CHECKOUT_ROOT` or `/tmp/repos`). `repo_dir` is injected into the event and the doc
  context/research swarm read the real worktree (git/read tools); the GitHub API is never called. A
  `.git` dir must be present in the mount — a plain file copy is deliberately ignored.
- **github** — no checkout, but an `installation_id` is present: GitHub-first prompt + read-only
  GitHub API tools.
- **docs** — neither: documentation-store search only.

With the docker worker the mount exists, so this run is **local**-grounded. Verify:

```bash
docker compose -f docker-compose.redis.yml exec rq-worker ls /tmp/repos/TheGreatBonnie/authly/.git
```

**Where it ends:** with the default `STRANDS_REVIEW_POLICY=always`, the graph stops at the
**ReviewGate interrupt** and the run lands in `pending_review`. That is the expected terminal for a
full local run — it proves the runner accepted and executed the opened PR. Set
`STRANDS_REVIEW_POLICY=never` (and restart) to let the graph attempt delivery instead.

**DB artifacts** — grep the delivery id to confirm persistence:

```bash
psql "$DATABASE_URL" -c \
  "SELECT run_id, name, schedule FROM jobs WHERE run_id='$DELIVERY';"
psql "$DATABASE_URL" -c \
  "SELECT workflow_id, event_type FROM github_workflows WHERE workflow_id='$DELIVERY';"
```

### Step 1.6 Negative and idempotency checks

With the same `$SIG` mechanism:

| Test                   | Action                                                     | Expected                                                                  |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Wrong signature        | Send a bogus `X-Hub-Signature-256`                         | **401** `Invalid signature`                                               |
| Non-admitted PR action | Re-sign a payload with `"action": "edited"`                | **200** `"pull_request.edited (skipped, not opened)"`                     |
| Org not linked         | Temporarily `UPDATE organizations SET github_org=NULL ...` | **422** `"GitHub organization 'TheGreatBonnie' is not linked to Draftly"` |
| Replay                 | Re-POST the **same** `$DELIVERY`                           | Not reprocessed — runner idempotency claim returns `DUPLICATE`            |

### Step 1.7 Cleanup

```bash
psql "$DATABASE_URL" -c "UPDATE organizations SET github_org=NULL WHERE clerk_org_id='demo-org';"
# scripts/pr_opened.json is committed in the repo — no temp file to clean up
```

### Part 1 caveats

- The fabricated PR **does not exist on GitHub** — but that only matters in `github` grounding mode
  (when no local checkout is mounted). With the docker worker, the `../authly` mount makes grounding
  `local`, so evidence comes from the real worktree and the GitHub API is never called — Part 1 is
  then a **real, fully grounded** end-to-end run, not just gate wiring.
- Delivery tools post to a GitHub PR, so they only run if you set `STRANDS_REVIEW_POLICY=never`; on a
  fabricated PR they will degrade/error. Leave the policy at its default (`always`) and the run
  terminates at the `pending_review` ReviewGate as expected.
- The committed payload ships the real changed-file evidence (`changed_files`,
  `changed_file_details`, `file_actions`, `diff`) computed from the `001-oauth-login` scenario diff
  (base `9a8581c` → head `b0d7fb8`); `PullRequestProcessor` forwards these into the run, so post-run
  memory/candidate extraction works from the true diff — even when no checkout is available.
- With a **host** worker (`make worker-rq`) and no checkout at `/tmp/repos/TheGreatBonnie/authly`,
  the run falls back to `github` grounding (fabricated `installation.id = 42`) and GitHub API calls
  degrade cleanly. To ground locally on the host, mirror the mount:
  `mkdir -p /tmp/repos/TheGreatBonnie && ln -s "$(pwd)/../authly" /tmp/repos/TheGreatBonnie/authly`
  or point `DRAFTLY_REPO_CHECKOUT_ROOT` at a directory containing the checkout.

---

## Part 2 — Real GitHub PR (full production flow)

Goal: open a real PR on `TheGreatBonnie/authly` so GitHub's webhook drives the workflow with actual
diff, files, and comments — the fully credentialed path.

### Step 2.0 Run the worker WITHOUT the local checkout mount (github grounding)

The Part-1 docker worker mounts `../authly` onto `/tmp/repos/TheGreatBonnie/authly`
(`docker-compose.redis.yml:25`), so the runner always grounds `local` on that checkout — even for a
real PR, and the mounted checkout is the base clone, not the PR head. Real-PR runs must instead
ground `github` (fetch the actual diff via the App installation token). Restart the worker with the
`docker-compose.realpr.yml` override, which resets `rq-worker.volumes` to none:

```bash
cd draftly-agent-backend
docker compose -f docker-compose.redis.yml -f docker-compose.realpr.yml up -d --build rq-worker
# verify the mount is gone in the merged file:
docker compose -f docker-compose.redis.yml -f docker-compose.realpr.yml config --format json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['services']['rq-worker'].get('volumes'))"
#   expect: None
```

Then confirm grounding in the worker log on the next event:
`grounding_mode ... mode=github repo_dir=None installation_id=157868703` (instead of `mode=local`).
Requires Docker Compose v2.23+ for the `!reset` tag. Part 1 keeps using the base
`docker-compose.redis.yml` (with the mount) so its runs still ground `local`.

### Step 2.1 Expose the webhook endpoint publicly

GitHub must be able to reach the endpoint. For a local backend, run one ngrok tunnel to the
**frontend** dev server — Next.js rewrites every `/api/*` request to FastAPI (`next.config.ts`), so a
single tunnel origin serves pages, webhooks, and the GitHub App OAuth handshake:

```bash
ngrok http 3000          # → https://<slug>.ngrok-free.dev
# Webhook URL you will configure: https://<slug>.ngrok-free.dev/api/github/webhook
# GitHub App Setup URL:        https://<slug>.ngrok-free.dev/api/github/setup-callback
```

Do **not** tunnel directly to `localhost:8000`. It is redundant (the rewrite already proxies `/api`)
and it breaks the install handshake: the auth cookie is planted on whatever origin serves the app
pages, and the setup-callback must land on that same origin. The rewrite passes the request body and
signing headers through unchanged, so `X-Hub-Signature-256` verification is unaffected — the same
tunnel also serves the Clerk, Slack, and Discord webhooks. See
`draftly-agent-backend/docs/api/webhooks.md`.

Register the tunnel origin everywhere it must match:

- GitHub App webhook URL → `https://<slug>.ngrok-free.dev/api/github/webhook`
- GitHub App Setup URL → `https://<slug>.ngrok-free.dev/api/github/setup-callback`
- Backend `FRONTEND_URL` → `https://<slug>.ngrok-free.dev` (setup-callback redirects land back on the
  origin that planted the cookie)
- Backend CORS + Next `allowedDevOrigins`: when the host differs from the hardcoded default, set
  `ALLOWED_ORIGINS` (draftly-agent-backend) and `ALLOWED_DEV_ORIGINS` (draftly-agent-ui) to the
  tunnel host, comma-separated.

ngrok's free tier shows a one-time "You are about to visit" interstitial per browser session; click
through once — later top-level redirects go straight through.

For a deployed backend, use the instance's HTTPS base URL.

### Step 2.2 The GitHub App must be installed on the repo/account

The App is identified by `GITHUB_APP_SLUG` in `.env`. Get the install URL from the API (Clerk
authenticated):

```
GET /api/github/install-url
```

then complete the install in the browser. GitHub then posts an `installation` webhook (handled by
`_handle_installation_event` in `routes/github.py:427`) and/or you link it explicitly in Step 2.3.

Configure the App so the `pull_request` and `installation` webhook events are delivered with a
secret matching `GITHUB_WEBHOOK_SECRET` (this is what signs `X-Hub-Signature-256` on the real
deliveries).

### Step 2.3 Link the installation to the organization

The authoritative link is `POST /api/github/link` (Clerk token, `require_reviewer_role`-style auth —
see Step 2.5): it validates the installation through GitHub's API, stores the installation record,
and sets `organizations.github_org = 'TheGreatBonnie'` on your Clerk org.

```jsonc
POST /api/github/link
{ "installation_id": 12345678 }
```

If this step is skipped, the webhook is rejected with **422 "not linked"** — same as Part 1.

### Step 2.4 Push the feature branch and open the PR

Scenario branches exist as local git worktrees under `authly-scenarios/NNN-*` (e.g.
`001-oauth-login` on `feat/001-oauth-login`). Only `master` is on `origin` today, so this pushes a
branch for the first time.

Before pushing, confirm the branch is clean and CI checks pass locally (the feature must be
**committed**, not just staged — pushing staged-only changes produces a PR with no feature code):

```bash
cd authly-scenarios/001-oauth-login

# 1) Check nothing is staged/unstaged and we are on the feature branch
git status --short          # expect empty (clean)
git rev-parse --abbrev-ref HEAD        # expect feat/001-oauth-login

# 2) Local CI checks (mirrors .github/workflows/tests.yml)
uv sync --extra dev
uv run ruff check .
uv run pytest
uv run python scripts/check_docs.py

# 3) Confirm the branch is ahead of the remote base (feature commits present)
git log --oneline origin/master..HEAD   # expect the feat commit(s)
```

Then push the branch and open the PR:

```bash
git push -u origin feat/001-oauth-login

gh pr create --repo TheGreatBonnie/authly \
  --base master --head feat/001-oauth-login \
  --title "feat: add OAuth login with authorization-code exchange" \
  --body "Adds OAuth authorization-code exchange (OAuthClient.exchange_code) with a \
deterministic per-provider identity user, plus an OAuth-backed login path \
(AuthService.login_with_oauth)."
# or open it manually in the browser
```

> **Repo hygiene:** never commit `__pycache__/*.pyc` or other build artifacts — the
> `.gitignore` already excludes them, and they were untracked from the index during this PR.
> Keep the PR diff to source + tests only.

`action: opened` is now admitted by both gates (this project's change), so the workflow runs
immediately — no merge required.

### Step 2.5 Verify the real end-to-end run

**API log:**

```
github_webhook_received event_type=pull_request delivery_id=<gh-delivery>
github_webhook_enqueued  task_name=github_pr.enqueue run_id=<gh-delivery> rq_job_id=...
```

**Worker log:**

```
workflow_started event_type=pull_request.opened surface=pull_request run_id=<gh-delivery>
```

Because the PR now genuinely exists, the graph's research nodes fetch the real diff/files from
GitHub through the App installation token, generate documentation changes, and stop at the
ReviewGate for human approval (default `STRANDS_REVIEW_POLICY=always`).

**Approving / rejecting the pending review:**

```
POST /api/github/review/<run_id>
{ "approved": true, "comment": "Looks good" }     # or "approved": false to reject
```

This resumes the paused graph; on approval it proceeds to delivery (a comment / docs update on the
real PR), and the run's terminal status becomes `delivered`.

**Monitoring points:**

- Run lifecycle rows for `run_id` in the `workflows`/audit tables
- `github_workflows` row (`event_type`, `installation_id`, `issue_number`, `actor`)
- HITL notifications via `REVIEW_DASHBOARD_URL` (or Slack/Discord if `SLACK_BOT_TOKEN` /
  `DISCORD_BOT_TOKEN` are configured)

---

## Troubleshooting

| Symptom                                                        | Likely cause                                                                                 | Fix                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `401 Invalid signature`                                        | Wrong/absent `X-Hub-Signature-256` or body changed between signing and POST                  | Recompute the hash over the exact file bytes; use `--data-binary @file`             |
| `422 GitHub organization '<owner>' is not linked to Draftly`   | No `organizations` row with `github_org = owner`                                             | Step 1.2 (local) or Step 2.3 (`/api/github/link`, real)                             |
| `422 unhandled` on POST                                        | `X-GitHub-Event` header missing, unknown event type, or malformed payload                    | Ensure `X-GitHub-Event: pull_request` and a valid `pull_request` object             |
| Response says `(skipped, not opened)`                         | Payload `action` is not `opened` (e.g. `edited`, `closed`)              | Use `"action": "opened"`                                                            |
| `workflow_skipped_pr_not_merged` in worker                     | Runner gate rejected the event (defense-in-depth)                                            | Same fix as above; event never reaches the graph                                    |
| Run stuck at `pending_review`                                  | ReviewGate await (default policy `always`)                                                   | Approve via `POST /api/github/review/<run_id>` or set `STRANDS_REVIEW_POLICY=never` |
| `github_webhook_dispatch_inprocess` instead of `enqueued`      | Redis/RQ not connected or `RQ_ENABLED=false`                                                 | Start Redis + `make worker-rq`, or accept the in-process fallback                   |
| `503 Jobs store unavailable` / `Background worker is disabled` | Runtime not fully started (DB/RQ/worker boot failure)                                        | Check startup logs; `make migrate` must succeed; worker must be running             |
| GitHub API errors from research tools                          | Run in `github` grounding mode (no mounted checkout) and the PR is fabricated               | Mount the checkout (docker worker) so grounding is `local`; then no GitHub API is called |
| Worker cannot reach the database (docker)                      | `DATABASE_URL` points at `localhost`, which resolves to the container itself                | Use a public URL or `host.docker.internal` if Postgres runs on the host                |

---

## Quick reference

**Endpoints** (`POST /api` mounted router — `src/draftly/app/api/app.py:64-67`):

| Method & path                           | Purpose                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/github/webhook`              | Webhook receiver (GitHub or crafted)                                 |
| `GET /api/github/install-url`           | GitHub App install URL (+ optional `return_to`)                      |
| `POST /api/github/link`                 | Link an installation to the Clerk org (`{"installation_id": N}`)     |
| `GET /api/github/installations`         | List linked installations                                            |
| `DELETE /api/github/installations/{id}` | Disconnect an installation                                           |
| `POST /api/github/review/{run_id}`      | Approve/reject a paused graph (`{"approved": bool, "comment": str}`) |

**Webhook headers required:**

```
X-GitHub-Event: pull_request
X-GitHub-Delivery: <unique-id>          # becomes the run_id / idempotency key
X-Hub-Signature-256: sha256=<hmac-hex>  # HMAC-SHA256 of raw body using GITHUB_WEBHOOK_SECRET
```

**Dispatch map** (`src/draftly/app/composition/rq_jobs.py QUEUE_MAP`):

```
github_pr.enqueue  → queue "webhooks"   # consumed by workers/rq_worker.py
```

**Key settings** (`src/draftly/app/config.py`): `host=0.0.0.0`, `port=8000`, `REDIS_URL`
(default `redis://localhost:6379/0`), `rq_enabled=true`, `rq_worker_queues=["scheduled","webhooks",
"default"]`, `strands_review_policy` (`always`/`risky`/`never`).

**Graphic of the whole flow can be found in `GITHUB_PR_EVENT_WORKFLOW_ANALYSIS.md`** — this
repository's `GITHUB_ISSUE_EVENT_WORKFLOW_ANALYSIS.md` and `SUPPORT_EVENT_WORKFLOW_ANALYSIS.md`
cover the sibling issue and chat-support pipelines.
