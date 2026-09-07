# Agents Page Live Data — remaining execution (resumed after partial prior work)

## Backend (Tasks 1-3) — DONE & tests pass
- [x] GET /api/agents route + catalog (agents.py, registered, app.py)
- [x] Audit hook detail + per-step SSE publisher streaming
- [x] jobs-row ticket resolution on run_start
- [x] Backend suite: tests/api + tests/orchestration/hooks = pass
- [x] Committed (3 commits: Task 1, Task 2, Task 3)

## Frontend (Task 4) — API wrappers + types — DONE
- [x] api/types.ts AgentSummary/RunSummary types
- [x] api/agents.ts listAgents
- [x] api/runs.ts listRuns/getRunSteps
- [x] tsc clean
- [x] Committed

## Frontend (Task 5) — rewrite agents page (strict SSE) — DONE
- [x] api types + wrappers verified
- [x] agent-icons.tsx (role->icon map + module-scope AgentIcon)
- [x] hooks/use-agent-runs.ts (wraps useWorkflowEvents via .events)
- [x] agents.tsx (catalog + per-run live detail)
- [x] agent-list.tsx (real data + live run rows)
- [x] agent-detail.tsx (live per-run SSE detail; fixed lint rule)
- [x] agent-filters.tsx (derived counts)
- [x] __tests__/agents.test.tsx (strict-SSE + no-polling tests)
- [x] tsc clean; eslint clean (0 errors/0 warnings) on changed files
- [x] DELETE components/agents/data.tsx
- [x] Confirm no `./data` imports remain
- [x] Committed

## Task 6 — Verification
- [x] Backend full regression re-run (tests/api + tests/orchestration/hooks) — pass (157 passed, 1 skip)
- [x] Backend Task 2/3 regression (test_runs_routes, test_audit_hook, test_workers_register) — pass (11 passed)
- [x] Frontend verification re-run (tsc clean; eslint clean on changed files)
- [x] Frontend agents page test — 2 passed (catalog render + no-polling)
- [x] Frontend full vitest suite — 173 passed, 1 failed (`doc-article.test.tsx` HMAC multi-match, PRE-EXISTING, unrelated to this plan)
- [x] Commits: backend 3 + frontend 3 (test fix committed separately)

## Final
- [x] Final report