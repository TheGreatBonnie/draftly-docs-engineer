# Draftly Documentation Gap Analysis & Usability Report

**Date:** September 15, 2026
**Scope:** `draftly-agent-backend/`, `draftly-agent-ui/`, project root, `docs/`, `reference/`

---

## Executive Summary

Draftly is a sophisticated AI documentation agent with a FastAPI backend (1,973 tests, 22 skills, 59 SQL migrations, 25+ workflows) and a Next.js 16 frontend (45 tests, 17 API modules, 21 hooks). The codebase is substantial (~27,600 lines of documentation across 132 files), but the **documentation is deeply buried with no navigation, critical setup gaps block new contributors, and several components are broken or misleading.**

**Severity ratings:** 🔴 Critical (blocks use/contribution) | 🟡 Important (degrades experience) | 🟢 Nice-to-have

---

## Part 1: Critical Usability Blockers

### 1.1 No Root README.md
**Impact:** Anyone cloning the repo sees nothing at the top level.
- `docs/README.enhanced.md` (1,140 lines) is the real README but lives in a subdirectory
- Root directory contains only workflow analysis files and architecture diagrams
- **Fix:** Add root `README.md` that links to `docs/README.enhanced.md` or move the enhanced README to root

### 1.2 API Docker Image Cannot Boot
**File:** `draftly-agent-backend/docker/Dockerfile.api`
- Runtime stage copies `.venv` and `src/` but **never copies `main.py`** (line 41 runs `CMD ["python", "main.py"]`)
- README line 388 candidly documents this ("the current API Dockerfile runs main.py without copying it") — but it's a shipping bug
- **Fix:** Add `COPY main.py ./` before the `CMD` line

### 1.3 Post-Sign-In 404 in UI
**File:** `draftly-agent-ui/.env.local` (lines 3-4)
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard` — **no `/dashboard` route exists**
- Signed-in users land on `not-found.tsx`
- **Fix:** Change to `/overview` or add a redirect page at `/dashboard`

### 1.4 Broken `lint` Script in UI
**File:** `draftly-agent-ui/package.json` (line 9)
- `lint` script runs `next lint` — Next.js 16 removed this command
- ESLint is not installed at all
- **No linting is possible** in the UI project
- **Fix:** Install ESLint 9 + `eslint-config-next`, or switch to `tsc --noEmit` for type checking

### 1.5 Dead `/activity` Routes in UI
**Files:** `draftly-agent-ui/app/(dashboard)/activity/` — 6 subdirectories, all empty (zero `page.tsx` files)
- Shell navigation and README reference `/activity/*` routes
- Every `/activity*` URL returns 404
- **Fix:** Either implement the routes or remove the empty directories and navigation references

### 1.6 Garbage Imports in Backend Config
**File:** `draftly-agent-backend/src/draftly/app/config.py` (lines 1-2)
```python
from draftly.app.api.evaluation_schemas import T
from sympy.physics.quantum.trace import Tr
```
- Both are unused; `sympy` is only a transitive lockfile dependency (never declared)
- Will break if the transitive dependency tree changes
- **Fix:** Delete both import lines

---

## Part 2: Documentation Gaps

### 2.1 Missing Critical Documents

| Document | Status | Impact |
|----------|--------|--------|
| Root `README.md` | **Missing** | No entry point for new users |
| `LICENSE` | **Missing** (README claims it exists) | Legal blocker for open-source use |
| `CONTRIBUTING.md` | **Empty** (0 bytes) | No guidance for human contributors |
| `CHANGELOG.md` | **Empty** (0 bytes) | No release history |
| `SECURITY.md` | **Empty** (0 bytes) | No security policy |
| `.env.example` (UI) | **Missing** | New devs must reverse-engineer 11 required vars |

### 2.2 Stale/Misleading Content in Backend README

| Issue | Location | Detail |
|-------|----------|--------|
| "LICENSE file is empty" | `draftly-agent-backend/README.md:389,418` | LICENSE now contains full MIT license |
| "17 bundled skills" | `draftly-agent-backend/README.md:129` | 22 `SKILL.md` files actually exist |
| 13 dead `docs/` links | `draftly-agent-backend/README.md` (lines 17, 218, 246, 375, 379, 381, 412) | Paths like `docs/architecture/overview.md` don't exist |
| Config table references env vars not in `.env.example` | `README:295-307` | `RQ_ENABLED`, `VECTOR_SEARCH_BACKEND`, `SEMANTIC_CACHE_ENABLED` missing from example |
| "Continue with..." at line 412 | Links to non-existent documentation pages |

### 2.3 Stale Content in UI README

| Issue | Location | Detail |
|-------|----------|--------|
| "`/` — Overview dashboard" | `draftly-agent-ui/README.md:30` | `/` is the marketing landing page; Overview is `/overview` |
| Lists `/activity` and `/activity/[id]` | `README.md:33,78` | All 404 (empty directories) |
| Omits setup prerequisites | `README.md:26` | Doesn't mention: backend must be running, `.env.local` needed, Clerk JWT template `Draftly` required |
| No env-var reference | Entire README | 11 required env vars undocumented |
| No Node.js version requirement | Entire README | Requires Node ≥22.6 (test script uses `--experimental-strip-types`) |

### 2.4 Missing Navigation & Index

**`docs/docs/`** has 36 files across 6 subdirectories but **no `index.md` or table of contents**. A reader has no guidance on:
- Which file to read first
- How the architecture docs relate to each other
- The intended reading order

**`reference/`** has 12 files totaling 16,851 lines with **no README explaining what each file covers** or when to consult it.

### 2.5 Missing Documentation Topics

| Topic | Status | Notes |
|-------|--------|-------|
| Quickstart guide | **Missing** | "Getting Started" is buried in a 1,140-line README |
| Environment variable reference | **Incomplete** | `.env.example` has vars, but no centralized docs explaining each one |
| Test documentation | **Missing** | No guide for writing tests, running the suite, or understanding fixtures |
| Troubleshooting guide | **Missing** | Only `RUN_PR_WORKFLOW.md` has a troubleshooting table |
| Docker deployment guide | **Missing** | Covered in README but not in `docs/docs/deployment/` |
| Content production docs | **Stub** (23 lines) | Referenced from README but barely written |
| UI component documentation | **Missing** | 60+ components with no usage docs or Storybook |
| API reference docs | **Missing** | FastAPI auto-generates OpenAPI at `/docs` but no static export |

---

## Part 3: Code Quality Issues Affecting Usability

### 3.1 Backend Issues

| Issue | File:Line | Detail |
|-------|-----------|--------|
| `reload=True` hardcoded | `main.py:34` | Unsafe for production containers |
| Inconsistent imports | `main.py:13` | Uses `from src.draftly.*` while all other modules use `draftly.*` |
| Dead YAML config files | `config/*.yaml` | Never loaded; contradict code defaults (timeout 600 vs 3600) |
| Duplicate dev deps | `pyproject.toml:45-54` and `91-100` | Two overlapping dev dependency declarations |
| Failing tests (2) | `tests/unit/app/test_evaluator_budget.py:48`, `tests/evaluation/test_online.py:762` | Stale config expectation + dataset coupling |
| No CI pipeline | Root | No `.github/workflows/` — lint/typecheck/tests not wired to any pipeline |
| Makefile inconsistency | Lines 24,30,35,56 | Some targets use bare `python`, others `uv run` |
| `docker-compose.redis.yml` stray comments | Lines 2-7 | Documents a removed `realpr` compose override |

### 3.2 UI Issues

| Issue | File:Line | Detail |
|-------|-----------|--------|
| Hardcoded badge count | `components/dashboard/shell.tsx:86` | Reviews always shows `12` |
| Hardcoded notifications | `components/dashboard/shell.tsx:355-394` | Static notification list |
| Hardcoded command results | `components/dashboard/shell.tsx:435-460` | Search results are mock data |
| No `.env.example` | Root | 11 required vars with no template |
| No `typecheck` script | `package.json` | No TypeScript checking beyond IDE |
| No component tests | `tests/` | Zero React component or hook tests |
| `NEXT_PUBLIC_API_URL` unused | `.env.local:10` | Only `API_URL` is read by `next.config.ts` |

### 3.3 Undocumented Scripts (Backend)

| Script | Purpose | Documented? |
|--------|---------|-------------|
| `backfill_workflow_resources.py` | Reconcile canonical workflow rows | No |
| `reconcile_runs.py` | Heal stale PR-run statuses | No |
| `reindex.py` | Trigger doc reindex | No |
| `run_workflow.py` | Run a workflow by name | No |
| `seed_demo.py` | Load Authly demo corpus | No |
| `pr_opened.json` | Sample GitHub webhook payload | No |

---

## Part 4: Recommendations — Making Draftly Easier to Use & Run

### Priority 1: Fix Broken Things (Immediate)

1. **Fix API Dockerfile** — Add `COPY main.py ./` to `docker/Dockerfile.api`
2. **Fix UI post-sign-in 404** — Change redirect URL to `/overview`
3. **Fix UI lint** — Install ESLint 9 or replace with `tsc --noEmit`
4. **Remove garbage imports** in `config.py` lines 1-2
5. **Fix 2 failing tests** — Update stale config expectation, fix dataset coupling
6. **Remove or load `config/*.yaml`** — Delete dead files or wire them into the settings

### Priority 2: Fill Documentation Gaps (This Week)

7. **Add root `README.md`** — Either move `docs/README.enhanced.md` to root or add a pointer
8. **Add `LICENSE` file** — The MIT license text exists in `draftly-agent-backend/LICENSE`
9. **Add UI `.env.example`** — Document all 11 required variables with descriptions
10. **Update stale README claims** — Fix the 13 dead links, "17 skills" → 22, "LICENSE empty" → MIT
11. **Add `docs/docs/index.md`** — Navigation hub for the 36 architecture/workflow/API files
12. **Fill or remove `content-production.md`** — It's a 23-line stub referenced from the main README
13. **Add `reference/README.md`** — Index explaining what each of the 12 design docs covers

### Priority 3: Improve Developer Experience (This Sprint)

14. **Add quickstart guide** — 5-minute setup: clone → env → install → run backend → run UI → verify
15. **Add env-var reference** — Centralized table: name, required/optional, default, description
16. **Document the 5 undocumented scripts** — Add Makefile targets + README entries
17. **Add `typecheck` script to UI** — `tsc --noEmit` for quick type verification
18. **Wire CI** — `.github/workflows/` for backend (`ruff`, `mypy`, `pytest`) and UI (`tsc`, `next build`, `test`)
19. **Fix Makefile consistency** — Use `uv run` everywhere or document why some targets differ
20. **Add full-stack `make dev` target** — Start Redis + worker + API + UI with one command

### Priority 4: Polish (Backlog)

21. **Resolve `/activity` routes** — Implement or remove the 6 empty directories
22. **Replace hardcoded UI values** — Badge counts, notifications, search results → API calls
23. **Add component/hook tests** — UI has zero React testing; add `@testing-library/react`
24. **Fill `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`** — Even minimal content is better than 0 bytes
25. **Add `docs/docs/deployment/docker.md`** — Docker is covered in README but missing from deployment docs
26. **Deduplicate `reference/` files** — `draftly-project-structure.md` and `project-structure.md` overlap significantly
27. **Fix `project-story.md` typos** — "dauntinng", "Fortunitely", "Drafly" on lines 131-133

---

## Appendix: Current Documentation Inventory

| Location | Files | Lines | Quality |
|----------|-------|-------|---------|
| Root-level docs | 8 | ~1,700 | Good (README is top-tier but misplaced) |
| `docs/docs/` | 36 | ~9,070 | Good breadth, missing index/navigation |
| `docs/superpowers/` | 76 | ~??? | Excellent dev journal, internal-only |
| `reference/` | 12 | ~16,850 | Deep designs, no reading-order guidance |
| `draftly-agent-backend/README.md` | 1 | ~418 | Comprehensive but has stale claims |
| `draftly-agent-ui/README.md` | 1 | ~180 | Good but missing key setup info |
| **Total** | **~134** | **~28,000+** | **Substantial but unorganized** |

---

*Report generated by graphify knowledge graph analysis + parallel sub-agent deep dives into backend (281 test files, 1,973 tests), UI (20 test files, 45 tests), and all project documentation.*
