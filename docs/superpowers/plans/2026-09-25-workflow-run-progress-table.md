# Workflow Progress Table with Redis SSE

**Goal:** Keep the four workflows stats cards and show the progress of actual runs in a table.

**Architecture:** Persist node transitions in canonical run state, derive the observed node order from durable workflow events, and use the existing Redis dashboard SSE stream to refresh the run list. The run detail keeps its per-run SSE connection.

**Branches:** `draftly-agent-ui` on `develop`; `draftly-agent-backend` on `feature/documentation-workflow-replacement`; root stays on `main`. Preserve unrelated working-tree changes.

## Backend

- Project `node_start` and `node_stop` events into `current_stage` and `stage_states` when the durable event insert succeeds.
- Return `stage_sequence` in first-seen node order on run list and detail responses; project old runs from stored events in one query per page.
- Broadcast `workflow:changed` to the organization Redis dashboard stream after node transitions so the UI refreshes during execution.
- Test persisted progress, historical projection, node result status, API response, and dashboard notifications.

## UI

- Keep the existing stats cards and summary source. Replace definition cards with a responsive run table under the workflows tabs.
- Map each run to display status, current-stage label, and its observed stage sequence; queued runs show no invented stage dots.
- Search loaded rows, load later pages by cursor, and keep loaded pages during SSE refresh. Link every run to a detail page, including runs without a definition.
- Verify the API and view model tests, TypeScript check, and production build.
