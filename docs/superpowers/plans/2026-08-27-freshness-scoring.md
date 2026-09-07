# Plan: Per-File Freshness Scoring

## Context

The `run_health_report` stage hardcodes `freshness: 1.0` (`stages.py:278`). This plan replaces it with actual per-file commit dates fetched from GitHub during sync, stored in the `documentation` table, and averaged in the health report.

**Key reuse:** `DocumentationValidator.check_freshness()` (`validator.py:40`) already computes days-since-update from a timestamp. We call it instead of reimplementing decay logic. `STALE_DAYS = 90` (`validator.py:13`) defines the decay window.

**Rate limit strategy:** Cap per-file commit fetching at 200 files per sync. Beyond that, use `None` (neutral 0.5 score). Extra cost: ≤200 calls/sync, <4% of GitHub's 5,000/hour authenticated limit.

---

## Task 1: Migration — add `last_committed_at` column

**Create:** `draftly-agent-backend/src/draftly/persistence/migrations/034_documentation_last_committed_at.sql`

```sql
-- 034_documentation_last_committed_at.sql
-- Stores the GitHub commit date of the most recent commit that touched
-- each document file. Used by the health report freshness dimension.

ALTER TABLE documentation
ADD COLUMN IF NOT EXISTS last_committed_at TIMESTAMPTZ DEFAULT NULL;
```

No foreign keys, no index needed (queried only via existing `(org_id, path)` index during upsert).

---

## Task 2: GitHub client — add `get_last_commit_date`

**Modify:** `draftly-agent-backend/src/draftly/integrations/github/client.py`

Add import at line 3 (after `import base64`):

```python
from datetime import UTC, datetime
```

Add method to `GitHubClient` class (after `get_file_contents` at line 433):

```python
async def get_last_commit_date(
    self,
    owner: str,
    repo: str,
    path: str,
    ref: str,
    token: str,
) -> datetime | None:
    """Return the commit date of the most recent commit touching `path`, or None."""
    try:
        data = await self._request(
            "GET",
            f"/repos/{owner}/{repo}/commits",
            params={"path": path, "sha": ref, "per_page": 1},
            token=token,
        )
        if not data:
            return None
        date_str = data[0]["commit"]["committer"]["date"]
        return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except Exception:
        logger.warning("get_last_commit_date_failed owner=%s repo=%s path=%s", owner, repo, path)
        return None
```

**Why `None` on error:** Rate limits (403), missing files (404), or network errors should never abort the sync. A missing date means freshness defaults to neutral (0.5).

**GitHub API response shape:**
```json
[{
  "commit": {
    "committer": {
      "date": "2026-08-27T10:30:00Z"
    }
  }
}]
```

---

## Task 3: DocumentStore — accept and persist `last_committed_at`

**Modify:** `draftly-agent-backend/src/draftly/integrations/database/document_store.py`

### 3a. Add to `_DOCUMENT_COLUMNS` (line 9-29)

Add `last_committed_at` after `updated_at` (line 28):

```python
_DOCUMENT_COLUMNS = """
    id,
    org_id,
    repository,
    path,
    title,
    content,
    document_type,
    version,
    commit_sha,
    source_hash,
    status,
    metadata,
    stale,
    outdated,
    incomplete,
    broken_links,
    unsupported_claims,
    created_at,
    updated_at,
    last_committed_at
"""
```

### 3b. Add parameter to `upsert_document` signature (line 105-118)

Add `last_committed_at` after `source_hash` (line 117):

```python
async def upsert_document(
    self,
    *,
    org_id: str | None = None,
    repository: str,
    path: str,
    content: str,
    metadata: dict[str, Any] | None = None,
    title: str | None = None,
    document_type: str | None = None,
    status: str | None = None,
    commit_sha: str | None = None,
    source_hash: str | None = None,
    last_committed_at: datetime | None = None,  # NEW
) -> dict[str, Any]:
```

Add import at top (after `from typing import Any`):

```python
from datetime import datetime
```

### 3c. Add to UPDATE path (lines 146-153)

After the existing `for column, value in (("status", ...), ("commit_sha", ...), ("source_hash", ...)):` block at line 146-153, add:

```python
if last_committed_at is not None:
    fields.append(f"last_committed_at = ${len(params) + 1}::timestamptz")
    params.append(last_committed_at)
```

### 3d. Add to INSERT path (lines 171-181)

Add to the `for column, value in (...)` loop at line 171:

```python
("last_committed_at", last_committed_at),
```

### 3e. Add to INSERT ON CONFLICT (lines 207-215)

Add to the conflict set builder loop:

```python
("last_committed_at", last_committed_at),
```

**Modify:** `draftly-agent-backend/src/draftly/persistence/repositories/documents.py`

### 3f. Pass through in `upsert()` wrapper (line 56-81)

Add `last_committed_at` parameter to `upsert()` signature and pass to `self.store.upsert_document()`:

```python
async def upsert(
    self,
    *,
    org_id: str | None = None,
    repository: str,
    path: str,
    content: str,
    metadata: dict[str, Any] | None = None,
    title: str | None = None,
    document_type: str | None = None,
    status: str | None = None,
    commit_sha: str | None = None,
    source_hash: str | None = None,
    last_committed_at: datetime | None = None,  # NEW
) -> dict[str, Any]:
    return await self.store.upsert_document(
        org_id=org_id,
        repository=repository,
        path=path,
        content=content,
        metadata=metadata,
        title=title,
        document_type=document_type,
        status=status,
        commit_sha=commit_sha,
        source_hash=source_hash,
        last_committed_at=last_committed_at,  # NEW
    )
```

Add import at top: `from datetime import datetime`

### 3g. Add `last_committed_at` to `_row_to_dict` return dict (line 436-463)

Add after `updated_at` in the return dict:

```python
"last_committed_at": row["last_committed_at"],
```

---

## Task 4: SyncService — fetch and store per-file commit dates

**Modify:** `draftly-agent-backend/src/draftly/documentation/sync_service.py`

### 4a. Add `last_committed_dates` to `SyncResult` (line 26-37)

Add field after `baseline` (line 37):

```python
@dataclass
class SyncResult:
    """Result of a documentation sync operation."""

    commit_sha: str
    repository: str
    document_count: int = 0
    section_count: int = 0
    chunk_count: int = 0
    skipped_count: int = 0
    failed_files: list[str] = field(default_factory=list)
    baseline: BaselineSnapshot | None = None
    last_committed_dates: list[datetime | None] = field(default_factory=list)  # NEW
```

Add import: `from datetime import datetime`

### 4b. Add `COMMIT_DATE_CAP` constant (after `ProgressCallback` at line 23)

```python
COMMIT_DATE_CAP = 200  # max files to fetch per-file commit dates for
```

### 4c. Modify sync loop (lines 102-192)

After `get_file_contents` at line 104-106, before the content-hash skip at line 110, add commit date fetching:

```python
                content = await self.github.get_file_contents(
                    owner, repo, path, default_branch, token
                )
                if not content:
                    continue

                # --- NEW: fetch per-file commit date (capped) ---
                file_count = result.document_count + result.skipped_count + len(result.failed_files)
                commit_date: datetime | None = None
                if file_count < COMMIT_DATE_CAP:
                    commit_date = await self.github.get_last_commit_date(
                        owner, repo, path, default_branch, token,
                    )
                elif file_count == COMMIT_DATE_CAP:
                    logger.warning(
                        "freshness_cap_reached count=%d cap=%d",
                        file_count, COMMIT_DATE_CAP,
                    )
                result.last_committed_dates.append(commit_date)
                # --- END NEW ---
```

### 4d. Pass `last_committed_at` to upsert (line 131-146)

Add `last_committed_at=commit_date` to the `documents.upsert()` call at line 131:

```python
                document_record = await documents.upsert(
                    org_id=org_id,
                    repository=repository_full_name,
                    path=path,
                    title=parse_result.title,
                    content=content,
                    status="indexed",
                    commit_sha=commit_sha,
                    source_hash=content_hash,
                    last_committed_at=commit_date,  # NEW
                    metadata={
                        "source_url": f"https://github.com/{repository_full_name}/blob/{default_branch}/{path}",
                        "branch": default_branch,
                        "section_count": len(parse_result.headings),
                        "chunk_count": len(chunks),
                    },
                )
```

---

## Task 5: Replace hardcoded freshness in `run_health_report`

**Modify:** `draftly-agent-backend/src/draftly/workflows/onboarding/stages.py`

### 5a. Add `last_committed_dates` parameter (line 258-263)

```python
def run_health_report(
    *,
    eval_result: EvaluationResult,
    document_count: int,
    section_count: int,
    last_committed_dates: list[datetime | None] | None = None,  # NEW
) -> HealthResult:
```

Add import: `from datetime import datetime`

### 5b. Replace hardcoded freshness (lines 275-280)

Replace:
```python
    dimensions = {
        "coverage": eval_result.dimensions.get("coverage", 0.0),
        "structure": eval_result.dimensions.get("structure", 0.0),
        "freshness": 1.0,  # TODO: compute from last-updated timestamps in doc metadata
        "completeness": eval_result.dimensions.get("completeness", 0.0),
    }
```

With:
```python
    # Compute freshness from per-file commit dates
    from draftly.documentation.validator import DocumentationValidator, STALE_DAYS

    validator = DocumentationValidator()
    dates = last_committed_dates or []
    days_list = [
        d for d in (validator.check_freshness(dt) for dt in dates)
        if d is not None
    ]
    if days_list:
        avg_days = sum(days_list) / len(days_list)
        freshness = max(0.0, 1.0 - avg_days / STALE_DAYS)
    else:
        freshness = 0.5  # unknown = neutral

    dimensions = {
        "coverage": eval_result.dimensions.get("coverage", 0.0),
        "structure": eval_result.dimensions.get("structure", 0.0),
        "freshness": freshness,
        "completeness": eval_result.dimensions.get("completeness", 0.0),
    }
```

**Freshness formula:** `max(0.0, 1.0 - avg_days / 90)`. A doc committed today = 1.0. A doc committed 90+ days ago = 0.0. Unknown dates are excluded from the average; if all dates are unknown, defaults to 0.5.

---

## Task 6: Wire dates from SyncResult into `run_health_report`

**Modify:** `draftly-agent-backend/src/draftly/workflows/onboarding/initialize.py`

At lines 194-198, change:

```python
        health_result = run_health_report(
            eval_result=eval_result,
            document_count=sync_result.document_count,
            section_count=sync_result.baseline.section_count if sync_result.baseline else 0,
        )
```

To:

```python
        health_result = run_health_report(
            eval_result=eval_result,
            document_count=sync_result.document_count,
            section_count=sync_result.baseline.section_count if sync_result.baseline else 0,
            last_committed_dates=sync_result.last_committed_dates,
        )
```

---

## Task 7: Update tests

### 7a. Modify existing health report tests

**File:** `tests/unit/workflows/test_onboarding_stages.py`

**`test_health_report_aggregates_scores` (line 158-180):** Change assertion from `== 1.0` to `== 0.5` (no dates passed = neutral). Add `last_committed_dates` to the call.

```python
    result = run_health_report(
        eval_result=eval_result,
        document_count=25,
        section_count=75,
        last_committed_dates=[],
    )
    ...
    assert result.dimensions["freshness"] == 0.5  # no dates = neutral
```

**`test_health_report_sync_not_async` (line 183-188):** No change needed (signature change has default).

**`test_recommendations_generates_suggestions` (line 191-222):** Update `health_result` fixture — `"freshness": 1.0` becomes `"freshness": 0.8` (or any value, doesn't affect recs).

**`test_recommendations_handles_llm_failure` (line 225-249):** Same fixture update.

### 7b. Modify existing initialize tests

**File:** `tests/unit/workflows/test_onboarding_initialize.py`

In `test_initialize_stores_stage_results` and `test_publishes_stage_change_events`, the mock `SyncResult` needs `last_committed_dates`:

```python
sync_result = SyncResult(
    commit_sha="abc123",
    repository="owner/repo",
    document_count=5,
    chunk_count=20,
    last_committed_dates=[datetime.now(UTC), datetime.now(UTC)],  # NEW
    baseline=BaselineSnapshot(...),
)
```

Add import: `from datetime import UTC, datetime`

### 7c. Add new freshness tests

**File:** `tests/unit/workflows/test_onboarding_stages.py`

```python
from datetime import UTC, datetime, timedelta


def test_health_report_fresh_docs():
    """All recent dates → freshness near 1.0."""
    from draftly.workflows.onboarding.stages import EvaluationResult, run_health_report

    eval_result = EvaluationResult(score=0.7, dimensions={
        "coverage": 0.8, "completeness": 0.6, "structure": 0.7, "length": 0.7,
    })
    recent = datetime.now(UTC) - timedelta(days=5)
    result = run_health_report(
        eval_result=eval_result,
        document_count=10,
        section_count=30,
        last_committed_dates=[recent, recent, recent],
    )
    assert result.dimensions["freshness"] > 0.9


def test_health_report_stale_docs():
    """All old dates → freshness near 0.0."""
    from draftly.workflows.onboarding.stages import EvaluationResult, run_health_report

    eval_result = EvaluationResult(score=0.7, dimensions={
        "coverage": 0.8, "completeness": 0.6, "structure": 0.7, "length": 0.7,
    })
    old = datetime.now(UTC) - timedelta(days=120)
    result = run_health_report(
        eval_result=eval_result,
        document_count=10,
        section_count=30,
        last_committed_dates=[old, old],
    )
    assert result.dimensions["freshness"] < 0.1


def test_health_report_mixed_dates():
    """Fresh + stale → average in between."""
    from draftly.workflows.onboarding.stages import EvaluationResult, run_health_report

    eval_result = EvaluationResult(score=0.7, dimensions={
        "coverage": 0.8, "completeness": 0.6, "structure": 0.7, "length": 0.7,
    })
    fresh = datetime.now(UTC) - timedelta(days=10)
    stale = datetime.now(UTC) - timedelta(days=80)
    result = run_health_report(
        eval_result=eval_result,
        document_count=10,
        section_count=30,
        last_committed_dates=[fresh, stale],
    )
    assert 0.2 < result.dimensions["freshness"] < 0.9


def test_health_report_no_dates():
    """All None → freshness 0.5 (neutral)."""
    from draftly.workflows.onboarding.stages import EvaluationResult, run_health_report

    eval_result = EvaluationResult(score=0.7, dimensions={
        "coverage": 0.8, "completeness": 0.6, "structure": 0.7, "length": 0.7,
    })
    result = run_health_report(
        eval_result=eval_result,
        document_count=10,
        section_count=30,
        last_committed_dates=[None, None, None],
    )
    assert result.dimensions["freshness"] == 0.5
```

### 7d. Add GitHub client test

**File:** `tests/unit/integrations/github/test_client.py` (if exists, or create)

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.mark.asyncio
async def test_get_last_commit_date_returns_date():
    from draftly.integrations.github.client import GitHubClient

    client = GitHubClient()
    mock_data = [{"commit": {"committer": {"date": "2026-08-27T10:30:00Z"}}}]
    with patch.object(client, "_request", new=AsyncMock(return_value=mock_data)):
        result = await client.get_last_commit_date("owner", "repo", "README.md", "main", "tok")
    assert result is not None
    assert result.year == 2026
    assert result.month == 8


@pytest.mark.asyncio
async def test_get_last_commit_date_returns_none_on_error():
    from draftly.integrations.github.client import GitHubClient

    client = GitHubClient()
    with patch.object(client, "_request", new=AsyncMock(side_effect=RuntimeError("rate limit"))):
        result = await client.get_last_commit_date("owner", "repo", "README.md", "main", "tok")
    assert result is None
```

---

## Task 8: Verify

```bash
cd draftly-agent-backend
.venv/bin/python -m pytest tests/unit/workflows/test_onboarding_stages.py tests/unit/workflows/test_onboarding_initialize.py -x -v
graphify update .
```

---

## Files Modified

| File | Change |
|------|--------|
| `migrations/034_documentation_last_committed_at.sql` | **Create** — add `last_committed_at TIMESTAMPTZ` |
| `integrations/github/client.py:3,433` | Add `datetime` import + `get_last_commit_date()` method |
| `integrations/database/document_store.py:4,9-29,105-118,146-153,171-181,207-215` | Add `datetime` import, `last_committed_at` to columns/params/SQL |
| `persistence/repositories/documents.py:3,56-81` | Add `datetime` import, pass through `last_committed_at` |
| `documentation/sync_service.py:8,23-26,102-146` | Add `datetime` import, `COMMIT_DATE_CAP`, `last_committed_dates` field, fetch logic |
| `workflows/onboarding/stages.py:10,258-283` | Add `datetime` import, `last_committed_dates` param, compute freshness |
| `workflows/onboarding/initialize.py:194-198` | Pass `last_committed_dates` to `run_health_report` |
| `tests/unit/workflows/test_onboarding_stages.py` | Update existing assertions, add 4 new freshness tests |
| `tests/unit/workflows/test_onboarding_initialize.py` | Add `last_committed_dates` to mock SyncResults |

## Execution Order

```
Task 1 (migration) ──────────┐
                              ├─→ Task 4 (sync) ─→ Task 6 (wire) ─→ Task 7 (tests) ─→ Task 8
Task 2 (github client) ──────┘         ↑
                                       │
Task 5 (stages) ──────────────────────┘
```

Tasks 1, 2, 5 can run in parallel. Task 3 must follow Task 1. Task 4 must follow Tasks 2+3. Task 6 must follow Tasks 4+5.
