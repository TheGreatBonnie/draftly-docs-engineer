# Documentation workflow hard cutover

This page describes how to verify that no in-flight documentation workflow
remains on the legacy loop and how to run the read-only gate before and during
the hard cutover. Run it any time you want to confirm the replacement is safe
to finish deploying.

The gate script is read-only. It never updates, cancels, or pauses runs; it
only reports the runs that would still be touching the legacy behavior so an
operator can resolve them through the normal surfaces.

## Before you start

- The backend must be reachable. The script reads `DATABASE_URL` (or
  `NEON_DATABASE_URL`) from the environment.
- Have an operator shell ready with API access to `workflow_runs` so you can
  resolve any listed runs.

## The cutover gate

```bash
cd draftly-agent-backend
DATABASE_URL='postgresql://...' uv run python scripts/check_documentation_cutover.py
```

Exit codes:

- `0` — no documentation workflow is in a nonterminal status. Safe to proceed.
- `1` — at least one documentation workflow is `queued`, `running`,
  `pending_review`, or `pending_intervention`. The script prints a table of
  the blocking run IDs and statuses.

Nonterminal statuses the gate watches:

| Status | Meaning |
| --- | --- |
| `queued` | admitted but not started |
| `running` | executing on the legacy branch or the new workflow |
| `pending_review` | awaiting human approval |
| `pending_intervention` | blocked and waiting on an operator |

The gate identifies documentation workflows by the workflow definitions that
build from the documentation graph: `github_pr`, `github_release`,
`documentation_sync`, and `documentation_audit`.

## Staging cutover rehearsal

Apply migration `060_documentation_page_workflow.sql` while the old release is
still serving, then follow this sequence:

1. Pause admission of new documentation runs (pause the webhook/scheduled
   intake so no new `github_pr`/`github_release` runs are admitted).
2. Run the gate:

   ```bash
   uv run python scripts/check_documentation_cutover.py
   ```

3. For every run the gate lists, resolve it:
   - `pending_review` runs: approve via the review surface.
   - `pending_intervention` runs: resume or reject via the steering surface.
   - `running`/`queued` runs with no recovery path: cancel via
     `POST /workflow-runs/{run_id}/cancel`.
4. Rerun the gate and repeat until it exits `0`.
5. Deploy the replacement backend and UI.
6. Run a two-page smoke workflow where one page requires a revision.
7. Confirm, for the smoke run: one revision, one evaluation per artifact, no
   passing-page rewrite, visible page results, successful approval, and
   complete delivery.
8. Reopen documentation-run admission.

Once step 8 admits the first new run, recovery is forward-only; do not
redeploy the old loop against new page-workflow state.

## What the gate reports on

The script queries `workflow_runs` joined to `workflow_definitions`, filtered
by the four nonterminal statuses. Rows whose joined `workflow_key` matches a
documentation key are reported; rows covered by any other surface (issue,
support, content) are ignored.

## Related

- [Page-level evaluation](./page-level-eval.md)
- [Agents execution methods](./agents-execution-methods.md)