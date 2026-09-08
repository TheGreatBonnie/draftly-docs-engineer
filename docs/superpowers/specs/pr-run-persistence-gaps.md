# PR-Run Persistence Gaps (Analysis + Fix Requirements)

Status: agreed for implementation. Fix list from the in-session analysis of the
complete GitHub pull-request run (webhook → claim → graph → terminal → memory).

## Background

Every persistence write on the live PR path is fail-open **except** the two
that can strand a run: the events *claim* (by design — idempotency gate) and the
terminal `events.mark_status`, which today runs **after** the delivery side effect
and is unguarded. A DB error there makes the RQ job fail, `Retry(max=3)` replays
the *same* delivery, the claim returns `False`, the runner returns `DUPLICATE`,
and `run_pull_request_workflow` intentionally leaves the jobs row at `running`.
End state: content delivered, every read-model still says `running`.

Additionally, status is fanned out to four tables (`events.status`, `jobs.status`,
`github_workflows.status`, `agent_runs.status`) with no reconciliation, and the
live-path evaluation verdict is embedded rather than first-class.

## Gap inventory (what we are fixing)

### G1 — Terminal events write is non-fail-open and after the side effect
`WorkflowRunner._finish_result` (src/draftly/workflows/runner.py:448-516):

- COMPLETED branch: `_persist_document_changes` → `_persist_delivery_result` →
  `_mark(event, "completed")` → `_persist_lifecycle("completed")` →
  `_post_run_memory` → broadcast.
- FAILED branch: `_mark(event, "failed")` → `_persist_lifecycle("failed")`.
- `_mark` (runner.py:987-994) calls `events.mark_status` unguarded.

Because `_mark` runs before `_persist_lifecycle`, a mark failure also prevents the
durable jobs terminal row (which carries the evaluation) from ever being written.

**Fix:** make `_mark` fail-open (log `event_status_persist_failed`, never raise),
and reorder every branch so `_persist_lifecycle(<terminal>)` runs **before**
`_mark`. The jobs row (with the embedded evaluation) becomes the durable terminal
record; the events status becomes a best-effort mirror.

### G3a — No reconciliation of the fanned-out status rows
`run_pull_request_workflow` (src/draftly/workflows/documentation/github_pr_workflow.py:58-62)
leaves `jobs.status` at `running` on `DUPLICATE`/`SKIPPED` "for replay coherence".
A replay of an already-terminal event therefore stays stuck at `running`, and any
pre-existing skew (events terminal, jobs `running`) is never healed.

**Fix:** add `reconcile_run(context, run_id)` treating the **events row as the
source of truth**: when its status is terminal (`completed`, `failed`,
`pending_review`, `skipped`), align `jobs` and `github_workflows` to it.
Best-effort, idempotent. Wire into the `DUPLICATE` replay branch.

### G3b — No backfill/sweep for pre-existing stuck rows
No maintenance path exists to heal rows stuck at `running` from before the fix.

**Fix:** add `EventRepository.list_recent_runs(limit)` and
`reconcile_stale_runs(context, limit)` sweeping recent events, plus a
`scripts/reconcile_runs.py` CLI (same bootstrap pattern as `scripts/run_workflow.py`).

### E1/E2 — Evaluation verdict is not first-class and has a single point of failure
The gate verdict `{passed, score, reasons, iteration}` (evaluate node) is persisted
only embedded in `jobs.result["evaluation"]` (one best-effort write) plus the
episodic record. The dedicated `evaluations` store and `feedback_outcomes` are
written **only** by the scheduled `evaluation_loop` (documentation_evaluation.py),
never by the live PR run. Aggregating quality telemetry means parsing JSONB.

**Fix:** on the terminal PR branches, write the verdict to
`repositories.evaluations.create(...)` (`evaluation_type="evaluation_gate"`,
idempotency via run-keyed choice is N/A — `create` inserts) and
`repositories.feedback_outcomes.save_outcome(org_id, "evaluation_gate", run_id,
payload)` (already upsert-keyed by `(org_id, source_type, source_id)` — idempotent
per run). Both already wired into the app composition (app/dependencies.py:297, 315).
Fail-open like every other write. Skip when no evaluation payload or no `org_id`.

### E3 — Verdict absent from the jobs row at pause time
`PENDING_REVIEW` calls `_persist_lifecycle(...)` with no `result` (runner.py:460),
so the paused run's jobs row carries no evaluation even though the review record
does.

**Fix:** in the `INTERRUPTED` branch build
`lifecycle_result = {"status": "PENDING_REVIEW"}` and include
`lifecycle_result["evaluation"]` when the verdict is available.

## Out of scope (deliberately deferred)

The following items surfaced in the analysis but are intentionally excluded from
this plan. Each is explained so a future plan can pick it up without re-deriving
the context:

### G2 — Delivery-receipt conditional writes for local/harness runs
Handling this properly requires defining a **local-delivery receipt model** — a
new domain concept: when the harness "delivers" docs to a local folder, what
counts as a receipt, and who owns its lifecycle? No such model exists, and
inventing it here expands scope into product design. The webhook PR path has a
real receipt (the GitHub PR), so G1's terminal-ordering fix fully covers the
failure mode under discussion. Defer until a local-delivery receipt concept is
designed.

### G4 — `workflow_events` DB log vs Redis "primary" mislabel
The `workflow_events` table is a write-ahead/audit log of stream envelopes; Redis
is the de-facto ephemeral queue for in-flight envelopes. The mislabel is a
naming/observability concern, **not** a durability hole on the PR path — no data
is lost either way, and the DB table still gets every event for Last-Event-ID
replay. Renaming or migrating either store is cosmetic and risks touching the SSE
replay path for no correctness gain. Defer until the streaming subsystem needs a
documented "primary vs log" contract.

### G5 — `agent_runs` fire-and-forget flush durability
`agent_runs` is an audit/observability log owned by the agents-page subsystem, not
part of the PR run's correctness path. Making its flush durable would add latency
to a non-critical store, and its rows are reproducible from `jobs.status` +
`events.status`. Defer until `agent_runs` has a documented consumption/consistency
contract that justifies the durability spend.

### E4 — Verdict absent from the envelope stream
The stream envelope is a **transport** concern, not a persistence store — its
shape is governed by the frontend live-view contract. The verdict remains on the
durable jobs row and becomes first-class in the stores via E1/E2, so no telemetry
is lost by deferring the streamed copy. Defer; revisit if the frontend needs the
verdict while the run is still streaming.

### E5 — Episode-copy wholesale drop
The episodic blob duplicates the verdict but is owned by the experiment-tracking
subsystem and still used for debugging/analytics history. Dropping it would touch
a separate data contract and risk losing history. It is redundant custody only —
not a new durability failure mode — so it ranks last. Defer.

---

Clean-up note for a future plan: G4/G5/E5 each become one-liners **once their
owning subsystems define the contracts above**; G2 additionally needs the
local-delivery receipt model designed first.

## Fix invariants

1. After the claim, **no** write on the live PR path may raise out of the workflow —
   every write is fail-open with a logged warning. (Exception: none.)
2. Terminal ordering everywhere: `_persist_lifecycle(<terminal>)` before
   `_mark(<terminal>)`, so the durable jobs row is written first.
3. The events row is the source of truth for reconciliation; reject non-terminal
   events.
4. Evaluation rows are written only on terminal branches (so paused runs don't
   double-insert into `evaluations` on resume).
5. Org-scoping preserved: `org_id` from `event["project_id"]`; skip when absent.
6. No new dependencies, no new migrations (all tables exist).