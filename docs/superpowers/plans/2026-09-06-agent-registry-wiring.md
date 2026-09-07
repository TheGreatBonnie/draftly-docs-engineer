# Agent Registry Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent factory registry the real dependency used by per-run graph construction without creating shared live agents.

**Architecture:** Lifecycle composition creates a registry of factories. The registry travels through `WorkflowContext`, `WorkflowRunner`, and `build_graph_for_run`; surface graphs use injected factories for shared and specialized agents while retaining per-run model and tool arguments.

**Tech Stack:** Python, dataclasses, Strands GraphBuilder, pytest.

**Spec:** Recommended registry-as-real-dependency design from the approved workflow architecture discussion.

## Global Constraints

- Factories only; never store live Strands agents in the registry.
- Every graph run must continue creating fresh agents with run-specific models and scoped tools.
- Preserve graph behavior when no registry is supplied by using the current direct factory defaults.
- Verify with focused tests and the full backend suite.

### Task 1: Define the registry contract

**Files:**
- Modify: `src/draftly/app/composition/agents.py`
- Test: `tests/unit/agents/test_agents.py`

- [x] Add specialized documentation, issue, and support factory fields.
- [x] Add a test that the registry exposes every factory required by active graphs.
- [x] Run the focused registry test and confirm it fails before implementation.
- [x] Implement the fields and factory assignments.
- [x] Run the focused registry test and confirm it passes.

### Task 2: Pass the registry through runtime composition

**Files:**
- Modify: `src/draftly/workflows/context.py`
- Modify: `src/draftly/app/composition/workflows.py`
- Modify: `src/draftly/workflows/runner.py`
- Modify: `src/draftly/integrations/strands/graph.py`
- Test: `tests/composition/test_workflows_composition.py`

- [x] Add an `agents` dependency to `WorkflowContext`.
- [x] Preserve the registry in `build_workflows()` instead of discarding it.
- [x] Forward it from the default runner graph factory to `build_graph_for_run()`.
- [x] Add a test proving the same registry reaches the graph factory.
- [x] Run the focused composition test and confirm it passes.

### Task 3: Resolve graph agents through injected factories

**Files:**
- Modify: `src/draftly/orchestration/graphs/documentation_graph.py`
- Modify: `src/draftly/orchestration/graphs/issue_graph.py`
- Modify: `src/draftly/orchestration/graphs/support_graph.py`
- Test: `tests/graph/test_documentation_graph.py`
- Test: `tests/graph/test_surface_graphs.py`

- [x] Add optional registry parameters to graph builders.
- [x] Use registry factories for shared and specialized agents while retaining current defaults.
- [x] Add a graph construction test with sentinel factories.
- [x] Run graph tests and then the full backend suite.

### Task 4: Refresh the graph and verify

- [x] Run `graphify update .`.
- [x] Run `git diff --check` on changed source and tests.
- [x] Report exact test results and any unrelated warnings.
