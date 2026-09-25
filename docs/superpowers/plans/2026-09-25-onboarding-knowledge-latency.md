# Onboarding Knowledge Construction Latency Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement and verify each task. Keep the Tavily research path unchanged.

**Goal:** Reduce first-run knowledge construction time for a 20-page documentation corpus while preserving per-chunk extraction coverage.

**Architecture:** Pack chunks from one page into bounded extraction groups, give each independent Strands request a fresh agent, process groups with eight workers, and persist validated results as they complete.

**Tech Stack:** Python, asyncio, Strands Agents, Pydantic, pytest.

## Global constraints

- Preserve the public onboarding event payloads and result counts.
- Keep `LLM_MAX_CONCURRENCY` at its default of eight until provider throttling measurements justify a change.
- Preserve source chunk IDs for failure attribution; reject a grouped result before storage if IDs are missing, duplicated, or unexpected.
- Do not alter the separate Tavily research extraction path.

## Tasks

### 1. Establish a controlled baseline and observability

- [ ] Run a 20-page, four-chunk-per-page fixture with a fixed-latency fake provider and record wall time, request count, fact count, and failures.
- [ ] Log per-request latency and input/output tokens, plus stage request count, throttling count, total duration, and persistence duration.
- [ ] Log embedding and database time separately inside `DomainMemoryRepository.store_batch`.

### 2. Extract with independent agents and bounded groups

- [ ] Add a structured group output whose items each carry a source `chunk_id`.
- [ ] Group up to four chunks from one page, with at most 6,000 content characters per group; leave unattributed and empty chunks independent.
- [ ] Construct a new extraction writer agent for each request, retaining the existing routed model and system prompt.
- [ ] Validate that grouped output has exactly one item per expected chunk ID before persisting any of it; retry invalid groups per chunk.

### 3. Persist and report completed work

- [ ] Process groups through eight bounded workers rather than waiting for a 50-chunk extraction batch.
- [ ] Flush completed results in small batches; publish progress only after persistence and keep stage progress within the existing tick budget.
- [ ] Preserve failed chunk IDs, relationship and candidate counts, and storage timeout behavior.

### 4. Verify and document

- [ ] Test grouping limits, fresh-agent isolation, invalid-output fallback, empty chunks, concurrency, and progress while another group is slow.
- [ ] Run the onboarding stage, public stage, and memory tests; run Ruff on touched Python files.
- [ ] Repeat the controlled 20-page fixture and compare request count, wall time, fact coverage, and failures against baseline.
- [ ] Update the initialization-stage documentation to describe the new extraction behavior.

## Acceptance

The controlled 20-page fixture makes fewer LLM requests and completes faster while retaining 80 extracted facts with no failed chunks. Live provider latency and throttling require a separate measured run before changing concurrency or timeout defaults.
