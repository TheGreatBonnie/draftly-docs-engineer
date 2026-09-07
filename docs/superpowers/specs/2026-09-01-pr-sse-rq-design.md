# PR Event Workflow: Per-run SSE + Hybrid RQ — Design

## Goal

Make PR runs visible and streamable like onboarding initialization runs by adding
(1) a per-run SSE stream (`GET /workflows/{run_id}/events`) backed by a jobs row and
SSE ticket, and (2) hybrid RQ dispatch (RQ when enabled, in-process fallback), on the
GitHub PR event workflow.

## Decisions (confirmed with user)

1. **Hybrid RQ**: enqueue to RQ when `settings.rq_enabled` AND `rq_queues`/`task_handlers`
   are present on `app_state.draftly`; otherwise fall back to the in-process worker
   (`worker.run_task`). Mirrors onboarding's `_execute_initialization` exactly.
2. **Per-run PR stream only**: wire the per-run stream (jobs row + ticket + graph stream
   envelopes + terminal `workflow_result`). Do **not** emit dashboard lifecycle events
   (`job_started`/`job_completed`/`run_completed`) — that's a separate, unproduced
   contract out of scope, matching onboarding which also does not emit them.
3. **Jobs row + ticket created in the webhook route** after the merged gate, before enqueue.

## Scope note (graph vs. onboarding stages)

Onboarding emits onboarding-specific envelopes (`stage_manifest`, `stage_progress`,
`overall_progress`) driven by a stage manifest. The PR workflow is a single Strands graph
with **no stage manifest**, so we use the graph's **native stream envelopes**
(`node_start`, `tool_progress`, `node_stop`, `handoff`, `workflow_result`) already produced
by `WorkflowRunner._invoke_streaming` + `filter_graph_event`. We do **not** invent a fake
stage manifest. The per-run stream is delivered correctly as long as:
- a jobs row exists for the run (`/workflows/{run_id}/stream-ticket` requires it), and
- the runner used by the PR workflow is publisher-capable.

## Architecture

### Dispatch (webhook route)

```
POST /webhooks/github
  → normalize_github → event (event["event_id"] == run_id)
  → [merged gate] (existing; skip non-merged, don't create a job)
  → issue SSE ticket: _tickets(request).issue(run_id, org_id=org_id)
  → create jobs row: repos.jobs.upsert_on_conflict(run_id, ...)
  → if rq_enabled && rq_queues && task_handlers:
      enqueue_job(queues=rq_queues, task_handlers=task_handlers,
                  task_name="github_pr.enqueue", event=event, run_id=run_id)
    else:
      worker.run_task("github_pr.enqueue", event=event, run_id=run_id)  # in-process
  → return WebhookResponse to GitHub
```

The **same registered task handler** serves both RQ and the in-process fallback, exactly as
onboarding does. The handler is the wrapped `run_pull_request_workflow(context, event, run_id)`.

### Task registration

- Add `"github_pr.enqueue": "github_pr"` to `TASK_REGISTRY` in
  `src/draftly/app/composition/workers.py`.
- `run_pull_request_workflow` is already registered in the workflow registry
  (`src/draftly/app/composition/workflows.py:128`), and `QUEUE_MAP` already maps
  `"github_pr": "webhooks"` (`rq_jobs.py`). The `webhooks` queue already exists in
  `build_rq_queues`, and the RQ worker already listens on it and registers handlers.
  So RQ works once the task is in `TASK_REGISTRY` and the workflow is registered.

### Workflow function (`github_pr_workflow.py`)

Refactor `run_pull_request_workflow` to:
- Accept `run_id` from the task kwargs (fall back to `event["event_id"]`).
- Build a **publisher-capable runner**: `WorkflowRunner(context, publisher=context.publisher)`
  so graph stream envelopes + terminal `workflow_result` flow over the per-run channel.
- Set job status via `context.repositories.jobs.update_status(job_id=run_id, status=...)`:
  `"running"` at start, `"completed"` / `"failed"` on the terminal paths (mirrors
  onboarding `_set_job_status`; never raises — best-effort bookkeeping).

## Files touched

| File | Change |
|------|--------|
| `src/draftly/app/api/routes/github.py` | create jobs row + issue SSE ticket + hybrid RQ/in-process enqueue after merged gate |
| `src/draftly/app/composition/workers.py` | add `"github_pr.enqueue"` to `TASK_REGISTRY` |
| `src/draftly/workflows/documentation/github_pr_workflow.py` | publisher-capable runner + job-status bookkeeping |
| Tests | webhook enqueue/fallback, jobs-row creation, job-status transitions, terminal envelope |

## Error handling

- Job-status updates are **best-effort** (never fail the workflow) — mirror onboarding.
- Jobs-row creation failure in the webhook is **fatal** (500) — without a backing jobs row,
  `/workflows/{run_id}/stream-ticket` would 404 (mirror onboarding).
- Non-merged PR events skip before job creation — no jobs row, no ticket, no enqueue
  (preserves the existing skip semantics).
