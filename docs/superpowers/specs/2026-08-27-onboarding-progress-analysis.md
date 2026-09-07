# Onboarding Initialization Progress — Analysis Spec

## Problem Statement

The onboarding initialize page (`/onboarding/initialize`) has dynamic stage mapping and animated progress that don't work correctly. The progress bar stays at 0% for ALL stages, including `repository_ingestion`.

## Root Causes

### 1. `repository_ingestion` progress is conditional on sync callback

In `initialize.py:91-106`, `_flush_progress` only emits `stage_progress` if `_latest_progress` is non-empty:

```python
async def _flush_progress() -> None:
    if _latest_progress:  # ← only emits if _on_sync_progress was called
        await _publish("stage_progress", {
            "stage": "repository_ingestion",
            "progress": progress,
            ...
        })
```

`_latest_progress` is only populated by the `_on_sync_progress` callback during the sync. If the sync completes before any callback fires (fast sync, small repo), `_latest_progress` stays empty and **no `stage_progress` event is ever published for `repository_ingestion`**. The progress bar shows 0%.

### 2. Stages 2-5 never emit `stage_progress`

Only `repository_ingestion` has any `stage_progress` logic at all (via `_flush_progress`). The other 4 stages (`knowledge_construction`, `initial_evaluation`, `health_report`, `recommendations`) have zero `stage_progress` emissions. `stageProgress[stage]` is always `undefined` → defaults to `0`.

### 3. API pre-fetch race condition

Two independent sources set `stageManifest`:
- `getInitializeStatus()` API call on mount (reads from NeonDB)
- SSE `stage_manifest` event from the workflow

These can arrive in any order, causing brief flicker or stale data if `STAGES` changed between workspace creation and initialization.

## Proposed Fixes

| Issue | Fix | Scope |
|-------|-----|-------|
| Progress 0% for ALL stages | Emit unconditional `stage_progress` at stage boundaries for all 5 stages | Backend |
| API race condition | Remove `getInitializeStatus` useEffect | Frontend |

## Data Flow (Correct State)

```
Backend workflow
  → _emit_stage_progress("knowledge_construction", 10)
  → _publish("stage_progress", { stage, progress })
  → RedisStreamBus.publish(StreamEnvelope)
  → Redis Stream XADD draftly:stream:{run_id}

SSE endpoint
  → bus.subscribe(run_id)  [XREAD from Redis Stream]
  → _format_envelope(envelope)
  → StreamingResponse (text/event-stream)
  → event: stage_progress\ndata: {"stage":"knowledge_construction","progress":10}\n\n

Frontend
  → EventSource.addEventListener("stage_progress", handler)
  → apply() → setEvents()
  → useMemo: setStageProgress({ knowledge_construction: 10 })
  → InitializationProgress receives stageProgress prop
  → TaskRow renders progress bar at 10%
```

## Acceptance Criteria

1. All 5 stages emit `stage_progress` events (backend test confirms)
2. Frontend progress bar animates from 0-100% for each stage
3. No API pre-fetch race condition (removed entirely)
4. All existing tests pass
5. No new lint errors
