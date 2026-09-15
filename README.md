# Draftly

**Autonomous documentation engineering platform.**

Draftly watches GitHub, Slack, and Discord for code changes and developer questions, researches your project, and prepares documentation updates for human review.

## Quick Start

> **Cloning this repo:** the backend, UI, and authly benchmark are git submodules, so clone with
> `git clone --recurse-submodules git@github.com:TheGreatBonnie/draftly-docs-engineer.git`
> (or run `git submodule update --init --recursive` after a plain clone).

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

## Authly scenario worktrees

`authly-scenarios/NNN-*` are not part of the clone. Each directory is a **git worktree
of the `authly` submodule** checked out on its feature branch (`feat/001-oauth-login`,
`feat/002-pkce`, … `feat/010-migration-guide`). Materialize them from the root:

```bash
git -C authly fetch origin
git -C authly worktree add ../authly-scenarios/001-oauth-login feat/001-oauth-login
git -C authly worktree add ../authly-scenarios/010-migration-guide feat/010-migration-guide
```

Repeat the last command for each scenario you need. The scenario content lives on the
`feat/*` branches of the `authly` repo (reachable through the submodule), so this is
recoverable on any clone. See [docs/RUN_PR_WORKFLOW.md](docs/RUN_PR_WORKFLOW.md) Part 2
for how the PR-documentation workflow runs a scenario.

## Architecture

See [ARCHITECTURE-DIAGRAM.md](ARCHITECTURE-DIAGRAM.md) for the full system overview.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/README.enhanced.md](docs/README.enhanced.md) | Full project documentation |
| [draftly-agent-backend/README.md](draftly-agent-backend/README.md) | Backend architecture & API |
| [draftly-agent-ui/README.md](draftly-agent-ui/README.md) | UI components & routes |
| [docs/RUN_PR_WORKFLOW.md](docs/RUN_PR_WORKFLOW.md) | How to run the PR documentation workflow |
| [docs/docs/index.md](docs/docs/index.md) | Documentation navigation |
| [authly/](authly/) | Authly benchmark application (submodule) |
| [authly-scenarios/](authly-scenarios/) | Authly scenario git worktrees (create with the one-liner above) |

## Tech Stack

- **Backend:** Python 3.11, FastAPI, Strands Agents SDK, PostgreSQL/pgvector, Redis/RQ
- **Frontend:** Next.js 16, React 19, TypeScript, Tailwind CSS, Clerk auth
- **Infra:** AWS (ECS/Lambda), Terraform, Docker

## License

MIT — see [draftly-agent-backend/LICENSE](draftly-agent-backend/LICENSE)
