# GitHub Workflow Persistence Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make GitHub workflow persistence tenant-safe, lifecycle-complete, durable for delivery outcomes, and consistent across PR and release workflows.

**Architecture:** Preserve the existing event/job/workflow-event read model, but carry the resolved organization ID into the normalized event at the webhook boundary. Centralize terminal persistence in the runner and audit/delivery hooks, inject the application database client into every repository, and make the workflow list query parameterized and event-type aware.

**Tech Stack:** Python, FastAPI, asyncpg-compatible `DatabaseClient`, pytest, structlog, PostgreSQL.

**Spec:** Current source analysis and the GitHub workflow persistence requirements in the user request.

## Global Constraints

- Preserve webhook idempotency keyed by the GitHub delivery/run ID.
- Keep persistence failures observable and do not silently lose tenant identity.
- Do not weaken existing review-gate or workflow execution behavior.
- Use parameterized SQL for externally derived identifiers.
- Add regression tests before production changes.

### Task 1: Propagate organization identity into normalized events

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py`
- Test: `draftly-agent-backend/tests/app/api/test_github_webhook_persistence.py` or the closest existing GitHub route test module

- [x] Add a failing test proving a normalized webhook passed to the task contains the resolved `project_id`.
- [x] Run that test and confirm it fails because the normalized event has no organization ID.
- [x] Set `event["project_id"] = org_id` immediately after identity resolution and before job/runner dispatch.
- [x] Run the focused webhook tests.

### Task 2: Complete job and workflow lifecycle persistence

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/database/jobs_store.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/github.py`
- Test: existing job/runner persistence tests plus new focused tests

- [x] Add failing tests for `started_at`, `completed_at`, `error`, and `result` updates.
- [x] Extend job status persistence with lifecycle fields while retaining the current repository interface compatibility.
- [x] Have the runner mark jobs running before graph execution and completed/failed after execution.
- [x] Update `github_workflows` status by run/workflow ID on pending, running, completed, and failed transitions.
- [x] Make workflow registration update all identity fields on conflict.
- [x] Run focused runner and persistence tests.

### Task 3: Use the shared database client for workflow events

**Files:**
- Modify: `draftly-agent-backend/src/draftly/app/dependencies.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/workflow_events.py`
- Test: repository dependency construction tests

- [x] Add a failing construction test asserting the workflow-event repository receives the application database client.
- [x] Pass `database` through `WorkflowEventsStore`/`WorkflowEventRepositoryImpl`.
- [x] Run the dependency and workflow-event tests.

### Task 4: Persist delivery receipts and document changes

**Files:**
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py` or the delivery integration boundary
- Modify: `draftly-agent-backend/src/draftly/delivery/github.py` and/or delivery tool adapters as required by existing interfaces
- Test: delivery repository and workflow delivery tests

- [x] Add failing tests proving a successful commit/PR delivery writes its delivery records with `org_id` and run linkage where the schema supports it.
- [x] Connect the existing `DeliveryRepository` to the delivery execution boundary without changing the GitHub API tool contract.
- [x] Persist document updates through the existing document repository only where the workflow has a concrete document path/content record.
- [x] Run delivery and workflow tests.

### Task 5: Harden and generalize the workflow read model

**Files:**
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/github.py`
- Test: workflow list repository tests

- [x] Add failing tests for parameterized run-ID queries and release workflow labels/stages.
- [x] Replace interpolated `IN (...)` SQL with `= ANY($1)` parameters.
- [x] Include event type/surface in the read model and use release-specific display data when present.
- [x] Ensure terminal state remains consistent when workflow events are missing but jobs/workflow rows contain lifecycle state.
- [x] Run the focused workflow list tests.

### Task 6: Full verification and graph refresh

**Files:**
- Modify: `graphify-out/` via `graphify update .`

- [x] Run the complete relevant backend test suite and lint/type checks available in the project.
- [x] Inspect the final changed surfaces for unrelated changes.
- [x] Run `graphify update .`.
- [x] Report verification evidence and any remaining environment-only limitations.
