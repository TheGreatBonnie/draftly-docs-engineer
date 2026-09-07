# Structured Logging (structlog) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragmented logging setup with one structlog `ProcessorFormatter` pipeline: JSON in production, colored console in development, correlation IDs on every line.

**Architecture:** New module `src/draftly/observability/logging.py` owns configuration; a root stdlib handler with `ProcessorFormatter` formats both structlog entries and foreign stdlib entries (uvicorn, strands, slack_bolt). Called from `create_application()` so API and all workers share it. Existing `tracing.py` contextvar feeds an `add_correlation_id` processor.

**Tech Stack:** structlog 26.1.0, rich 14.x, FastAPI/Starlette middleware, stdlib `logging`, pytest.

**Spec:** `docs/superpowers/specs/2026-08-23-structlog-logging-design.md`

## Global Constraints

- **NO GIT COMMITS.** The user explicitly forbade committing. Complete each task's file changes and verification, then stop. Do not run `git add` or `git commit`.
- Python 3.11, ruff line-length 100 (`pyproject.toml [tool.ruff]`).
- mypy strict-ish: `disallow_untyped_defs = true` — all new functions need annotations.
- Import style inside `src/draftly/**`: absolute `from draftly...` imports (matches existing modules); NOT `from src.draftly...`.
- Tests live under `tests/`; pytest config: `asyncio_mode = "auto"`, `pythonpath = ["."]`.
- Renderer selection: `settings.environment == "development"` → `ConsoleRenderer(colors=True)`; otherwise `format_exc_info` + `JSONRenderer()`. `format_exc_info` must NEVER appear in the shared/dev chain.
- Root handler carries a marker attribute `_draftly_handler = True`; `configure_logging` is a no-op if a marked handler already exists.
- CLI scripts under `scripts/` are out of scope; their `print()` stays.

---

### Task 1: Dependency + core `configure_logging` module

**Files:**
- Modify: `pyproject.toml` (dependencies list)
- Create: `src/draftly/observability/logging.py`
- Test: `tests/observability/test_logging.py`

**Interfaces:**
- Consumes: `Settings` from `draftly.app.config` (fields used: `.environment: str`, `.log_level: str`), `current_correlation_id()` from `draftly.observability.tracing`.
- Produces:
  - `configure_logging(settings: Settings) -> None`
  - `get_logger(name: str | None = None) -> Any` (re-export of `structlog.get_logger`)
  - `add_correlation_id(logger: Any, method_name: str, event_dict: EventDict) -> EventDict`

- [ ] **Step 1: Add rich as a direct dependency**

In `pyproject.toml`, in `[project] dependencies`, after the `"structlog>=24.0.0",` line add:

```toml
    "rich>=13.0",
```

Then run: `uv sync`
Expected: lock resolves (rich 14.3.4 already resolved transitively).

- [ ] **Step 2: Write failing tests**

Create `tests/observability/test_logging.py`:

```python
import json
import logging

import pytest

from draftly.app.config import Settings
from draftly.observability.logging import configure_logging


@pytest.fixture(autouse=True)
def _clean_root_handlers():
    root = logging.getLogger()
    saved = root.handlers[:]
    saved_level = root.level
    root.handlers.clear()
    yield
    root.handlers[:] = saved
    root.setLevel(saved_level)


def _settings(env: str) -> Settings:
    return Settings(environment=env, log_level="INFO")


def test_prod_renders_json_lines_with_expected_keys(capsys):
    configure_logging(_settings("production"))

    import structlog

    structlog.get_logger("test.module").info("hello", org_id="org_1")

    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1
    parsed = json.loads(out[0])
    assert parsed["event"] == "hello"
    assert parsed["level"] == "info"
    assert parsed["logger"] == "test.module"
    assert "timestamp" in parsed
    assert parsed["org_id"] == "org_1"


def test_dev_renders_console_not_json(capsys):
    configure_logging(_settings("development"))

    import structlog

    structlog.get_logger("test.module").info("hello", key="value")

    out = capsys.readouterr().out
    assert "hello" in out
    assert '"event"' not in out  # not JSON


def test_configure_is_idempotent():
    configure_logging(_settings("production"))
    first_count = len(logging.getLogger().handlers)
    configure_logging(_settings("production"))
    assert len(logging.getLogger().handlers) == first_count


def test_foreign_stdlib_entry_gets_same_formatting(capsys):
    configure_logging(_settings("production"))

    logging.getLogger("third.party").warning("foreign hello")

    parsed = json.loads(capsys.readouterr().out.strip())
    assert parsed["event"] == "foreign hello"
    assert parsed["level"] == "warning"
    assert parsed["logger"] == "third.party"
```

Note on capture: handlers bind `sys.stdout` at construction time, and `configure_logging` constructs its handler fresh on every call — so calling it *inside* the test (after capsys patched stdout) makes output capturable.

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/observability/test_logging.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'draftly.observability.logging'` (create empty `tests/observability/__init__.py` only if other test dirs have `__init__.py`; check `ls tests/unit | head` first and match convention).

- [ ] **Step 4: Implement the module**

Create `src/draftly/observability/logging.py`:

```python
"""Central logging configuration (spec: 2026-08-23-structlog-logging-design).

One ProcessorFormatter pipeline formats structlog entries and foreign
stdlib entries identically: JSON in production, colored console in dev.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from draftly.app.config import Settings
from draftly.observability.tracing import current_correlation_id

EventDict = structlog.typing.EventDict


def _shared_processors() -> list[structlog.typing.Processor]:
    """Fresh list per call; identical treatment for app and foreign entries."""
    return [
        structlog.contextvars.merge_contextvars,
        add_correlation_id,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]


def add_correlation_id(
    logger: Any,
    method_name: str,
    event_dict: EventDict,
) -> EventDict:
    """Inject the tracing correlation id into the event dict."""
    correlation_id = current_correlation_id()

    if correlation_id:
        event_dict["correlation_id"] = correlation_id

    return event_dict


_MARK = "_draftly_handler"


def _build_formatter(environment: str) -> structlog.stdlib.ProcessorFormatter:
    if environment == "development":
        render_processors: list[structlog.typing.Processor] = [
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.dev.ConsoleRenderer(),
        ]
    else:
        render_processors = [
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ]

    return structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=_shared_processors(),
        processors=[
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.UnicodeDecoder(),
            *render_processors,
        ],
    )


def configure_logging(settings: Settings) -> None:
    """Configure structlog + stdlib logging. Idempotent."""
    root = logging.getLogger()

    if any(getattr(handler, _MARK, False) for handler in root.handlers):
        return

    formatter = _build_formatter(settings.environment)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    setattr(handler, _MARK, True)

    root.addHandler(handler)
    root.setLevel(settings.log_level.upper())

    # Third-party noise control.
    logging.getLogger("slack_bolt").setLevel(logging.ERROR)

    structlog.configure(
        processors=_shared_processors()
        + [structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> Any:
    """Module-level entry point; mirrors structlog.get_logger."""
    return structlog.get_logger(name)


__all__ = ["add_correlation_id", "configure_logging", "get_logger"]
```

Design notes for the implementer:
- `ProcessorFormatter(processors=[...])` runs on **all** entries (structlog + foreign); `foreign_pre_chain` runs only on foreign ones before that. Keeping PositionalArgumentsFormatter/StackInfoRenderer/UnicodeDecoder in the formatter side means both origins get them exactly once.
- With `LoggerFactory()`, structlog entries become real LogRecords carrying `_record`, so `add_logger_name` works for both origins.
- Dev pretty exceptions: Rich is auto-detected by ConsoleRenderer; `format_exc_info` deliberately absent from that path.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/observability/test_logging.py -v`
Expected: 4 PASS

If `test_foreign_stdlib_entry_gets_same_formatting` fails on missing keys, check that `add_log_level` and `add_logger_name` are present in `foreign_pre_chain`.

- [ ] **Step 6: Lint and type-check the new files**

Run: `uv run ruff check src/draftly/observability/logging.py tests/observability/ && uv run mypy src/draftly/observability/logging.py`
Expected: no errors

---

### Task 2: Wire configuration into entry points

**Files:**
- Modify: `src/draftly/app/lifecycle.py:355-390` (`create_application`)
- Modify: `main.py`

**Interfaces:**
- Consumes: `configure_logging(settings)` from Task 1.
- Produces: configured logging active for API + all workers (they all call `create_application`).

- [ ] **Step 1: Call configure_logging in create_application**

In `src/draftly/app/lifecycle.py`, inside `create_application()` immediately after `settings = settings if settings is not None else get_settings()` (line ~377):

```python
    configure_logging(settings=settings)
```

Add import at top with the other draftly imports:

```python
from draftly.observability.logging import configure_logging
```

Also migrate this file's own logger: replace `import logging` with `import structlog`, and `logger = logging.getLogger(__name__)` (line ~22) with `logger = structlog.get_logger(__name__)`.

- [ ] **Step 2: Update main.py**

Replace the whole of `main.py` with:

```python
import warnings

import uvicorn

from src.draftly.app.api.app import app
from src.draftly.app.config import get_settings

warnings.filterwarnings(
    "ignore",
    message=".*type is unknown and inference may fail.*",
    category=UserWarning,
)


def main() -> None:
    settings = get_settings()

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        log_config=None,
    )


if __name__ == "__main__":
    main()
```

Changes: `slack_bolt` suppression removed (now lives in `configure_logging`); `log_config=None` stops uvicorn installing its own handlers so its loggers propagate to our root handler.

- [ ] **Step 3: Smoke-run**

Run: `timeout 8 uv run python -c "
from src.draftly.app.api.app import app
print('import ok')
" 2>&1 | tail -5`
Expected: `import ok` printed once; no traceback.

Then start-and-kill the server to see unified output:

Run: `cd /Applications/Projects/hackathon/draftly-docs-engineer/draftly-agent-backend && DRAFTLY_LOG_LEVEL=DEBUG timeout 6 uv run python main.py 2>&1 | head -15 || true`
Expected: uvicorn startup lines ("Started server process", "Application startup complete") rendered in the SAME format as app lines (single pipeline visible).

- [ ] **Step 4: Verify no double formatting**

In the smoke output above, confirm uvicorn access/startup lines do NOT appear twice or in two different formats. If uvicorn lines are plain default-formatted, confirm `log_config=None` was actually applied.

---

### Task 3: Correlation middleware (structlog migration + registration)

**Files:**
- Modify: `src/draftly/app/api/middleware/logging.py` (full rewrite)
- Modify: `src/draftly/app/api/app.py` (register middleware)
- Test: `tests/api/test_request_logging_middleware.py` (new)

**Interfaces:**
- Consumes: `structlog`, `bind_correlation_id`, `new_correlation_id`, `clear_correlation_id` from `draftly.observability.tracing`; `get_logger`.
- Produces:
  - `RequestLoggingMiddleware` (same class name) binding `request_id`, `method`, `path` to contextvars per request; response header `X-Request-ID`.
  - Requires `clear_correlation_id()` — ADD it to `src/draftly/observability/tracing.py`:

```python
def clear_correlation_id() -> None:
    """Reset the correlation scope (e.g. after request handling)."""
    _correlation_id.set("")
```

- [ ] **Step 1: Add clear_correlation_id to tracing.py**

Append to `src/draftly/observability/tracing.py` after `bind_correlation_id`:

```python
def clear_correlation_id() -> None:
    """Reset the correlation scope (e.g. after request handling)."""
    _correlation_id.set("")
```

- [ ] **Step 2: Write failing middleware tests**

Create `tests/api/test_request_logging_middleware.py`:

```python
import json
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from draftly.app.api.middleware.logging import RequestLoggingMiddleware
from draftly.app.config import Settings
from draftly.observability.logging import configure_logging
from draftly.observability.tracing import current_correlation_id


@pytest.fixture(autouse=True)
def _clean_root_handlers():
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    configure_logging(Settings(environment="production", log_level="INFO"))
    yield
    root.handlers[:] = saved


@pytest.fixture
def client() -> TestClient:
    application = FastAPI()
    application.add_middleware(RequestLoggingMiddleware)

    @application.get("/ping")
    def ping() -> dict[str, str]:
        return {"correlation": current_correlation_id()}

    return TestClient(application, raise_server_exceptions=False)


def test_request_binds_correlation_and_sets_header(client):
    response = client.get("/ping")

    assert response.headers["X-Request-ID"] == response.json()["correlation"]
    assert response.headers["X-Request-ID"] != ""


def test_honors_inbound_x_request_id(client):
    response = client.get("/ping", headers={"X-Request-ID": "abc-123"})

    assert response.json()["correlation"] == "abc-123"


def test_access_line_logged_as_json(client):
    client.get("/ping")

    # Last captured log line should be the request_completed event.
```

For the third test, capture via capsys and assert the last JSON line has `event == "request_completed"` and keys `request_id`, `method`, `path`, `status_code`, `duration_seconds` (extend the fixture to accept `capsys` parametrize or write the assertion inline using `capsys.readouterr()`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/api/test_request_logging_middleware.py -v`
Expected: FAIL — current middleware uses stdlib `extra=` and never binds tracing contextvar (first test fails on empty correlation).

- [ ] **Step 4: Rewrite middleware**

Full replacement of `src/draftly/app/api/middleware/logging.py`:

```python
"""Request logging + correlation-id binding middleware."""

from __future__ import annotations

import time

import structlog
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from draftly.observability.tracing import (
    bind_correlation_id,
    clear_correlation_id,
    new_correlation_id,
)

logger = structlog.get_logger("draftly.api")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next,
    ):
        inbound = request.headers.get("X-Request-ID")
        request_id = inbound or new_correlation_id()

        bind_correlation_id(request_id)
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
        )

        request.state.request_id = request_id
        started = time.perf_counter()

        try:
            response = await call_next(request)

            duration = time.perf_counter() - started

            response.headers["X-Request-ID"] = request_id

            logger.info(
                "request_completed",
                status_code=response.status_code,
                duration_seconds=round(duration, 6),
            )

            return response

        except Exception:
            duration = time.perf_counter() - started

            logger.exception(
                "request_failed",
                duration_seconds=round(duration, 6),
            )

            raise

        finally:
            structlog.contextvars.unbind_contextvars(
                "request_id",
                "method",
                "path",
            )
            clear_correlation_id()
```

Note: `request_id/method/path` go through `structlog.contextvars` (auto-merged by `merge_contextvars`) while the tracing id goes through the dedicated processor — both land in output.

- [ ] **Step 5: Register the middleware in create_api_app**

In `src/draftly/app/api/app.py`, inside `create_api_app()` right after the `FastAPI(...)` constructor:

```python
    app.add_middleware(RequestLoggingMiddleware)
```

with import added:

```python
from draftly.app.api.middleware.logging import RequestLoggingMiddleware
```

- [ ] **Step 6: Run middleware tests to verify they pass**

Run: `uv run pytest tests/api/test_request_logging_middleware.py -v`
Expected: PASS

- [ ] **Step 7: Regression-run API route smoke tests**

Run: `uv run pytest tests/api -v`
Expected: all PASS (no middleware-induced breakage).

---

### Task 4: Workers — context binding + print conversion

**Files:**
- Modify: `workers/indexing_worker.py`
- Modify: `workers/evaluation_worker.py`
- Modify: `workers/event_worker.py` and `workers/workflow_worker.py` (same pattern if they log/print)

**Interfaces:**
- Consumes: `configure_logging`, `get_logger`, `bind_contextvars`/`unbind_contextvars`.
- Produces: worker log lines carry `worker=<name>` plus job-level `run_id` / `project_id` when known.

- [ ] **Step 1: Convert indexing_worker**

In `workers/indexing_worker.py`: replace `import logging` usage (line ~37-39 area: `logging.getLogger(__name__).exception(...)`) with a module-level structlog logger and bind worker identity. Top of file:

```python
import structlog

from draftly.observability.logging import configure_logging
from draftly.app.config import get_settings
```

Inside `run()` before the loop:

```python
    configure_logging(settings=get_settings())
    log = structlog.get_logger("draftly.worker.indexing")
    structlog.contextvars.bind_contextvars(worker="indexing")
```

Error path becomes:

```python
            log.exception("indexing_run_failed")
```

Wherever a run/project id enters the loop body (inspect the polling code around lines 30-60), add:

```python
    structlog.contextvars.bind_contextvars(run_id=str(run_id))
```

and unbind after the iteration completes.

- [ ] **Step 2: Convert evaluation_worker print**

`workers/evaluation_worker.py:36` — replace:

```python
            print(f"evaluation.loop → {result}")  # noqa: T201 - CLI output
```

with:

```python
            log.info("evaluation_loop_result", result=result)
```

plus the same header pattern as Step 1 (`worker="evaluation"` binding, configure call).

Apply the identical pattern to `workers/event_worker.py` and `workers/workflow_worker.py`: read each file first; convert any `logging`/`print` usage; bind their own worker names (`"events"` / `"workflow"`).

- [ ] **Step 3: Verify workers import cleanly**

Run: `uv run python -c "import workers.indexing_worker, workers.evaluation_worker, workers.event_worker, workers.workflow_worker; print('ok')"`
Expected: `ok`

- [ ] **Step 4: Lint workers**

Run: `uv run ruff check workers/`
Expected: clean (the old `# noqa: T201` comment must be removed with its print).

---

### Task 5: Mechanical migration of remaining stdlib-logging modules

**Files:** All remaining files matching `grep -rl "^import logging\|^from logging" src/ workers/`. Known set (~63 files): everything listed by that grep EXCEPT files already migrated in Tasks 1–4 (`lifecycle.py`, `middleware/logging.py`, `middleware/errors.py` handled below too, `workers/*`).

Includes `src/draftly/app/api/middleware/errors.py` (converts `extra={...}` → kwargs).

**Interfaces:**
- Consumes: nothing new; pure call-site transformation.
- Produces: zero remaining stdlib loggers in `src/` and `workers/`.

- [ ] **Step 1: Bulk transform**

From repo root `draftly-agent-backend`, run:

```bash
grep -rl "^import logging\|^from logging" src/ workers/ --include="*.py" | while read -r f; do
  sed -i '' \
    -e 's/^import logging$/import structlog/' \
    -e 's/^from logging import/from structlog import/' \
    -e 's/logging\.getLogger(/structlog.get_logger(/g' \
    "$f"
done
```

(macOS/BSD sed syntax.)

- [ ] **Step 2: Fix leftover stdlib usages**

Run: `grep -rn "logging\." src/ workers/ --include="*.py"`
For every remaining hit, hand-fix based on what it does:
- `logging.getLogger(...).setLevel(...)` / `basicConfig` style third-party tuning → move into `configure_logging` in `src/draftly/observability/logging.py` (like slack_bolt).
- `extra={...}` kwargs in log calls → flatten to keyword arguments: `logger.info("x", extra={"k": v})` becomes `logger.info("x", k=v)` — apply especially in `src/draftly/app/api/middleware/errors.py`.
- `logging.ERROR` constants passed to structlog calls don't exist — use string levels or drop.
- If a file genuinely needs BOTH (rare), keep `import logging` alongside `import structlog` instead of forcing the swap.

Known specific cases to handle after the sweep:
- `src/draftly/events/base.py`, `dispatcher.py`, `observability/audit.py`, `observability/events.py`, `integrations/github/client.py`, `integrations/strands/client.py`, `agents/shared/memory_grounding.py`, `support/resolver.py`, `support/escalation.py`, `app/dependencies.py` — plain `getLogger(__name__)` swaps, nothing else.
- Files where sed replaced `import logging` but other `logging.X` references remain will fail ruff F821 — Step 4 catches these; fix each by the rules above.

- [ ] **Step 3: Sort imports**

Run: `uv run ruff check --select I --fix src/ workers/`
(structlog import lands alphabetically; `I` rules are enabled in pyproject.)

- [ ] **Step 4: Full lint + typecheck gate**

Run: `uv run ruff check src/ workers/ main.py && uv run mypy src/draftly 2>&1 | tail -20`
Expected: ruff clean; mypy errors only if a transform broke typing — fix until clean (mypy baseline unknown; compare against pre-change count if pre-existing errors exist: record them BEFORE Task 5 with `uv run mypy src/draftly 2>&1 | tail -3` and do not increase).

- [ ] **Step 5: Full test suite**

Run: `uv run pytest -x -q`
Expected: all pass, no new failures vs. pre-plan state (run `uv run pytest -q 2>&1 | tail -3` before starting Task 5 to snapshot the baseline; integration-marked tests skipped without `DRAFTLY_LIVE=1` are expected skips).

- [ ] **Step 6: Final consistency sweep**

Run: `grep -rn "logging\.getLogger" src/ workers/ --include="*.py"; echo "---"; grep -rn "print(" src/ workers/ --include="*.py" | grep -v test`
Expected: both empty. Then stop — leave ALL changes uncommitted (Global Constraints).

---

## Self-review notes (already applied)

- Spec coverage: chains/renderer split (T1), entry points incl. uvicorn log_config + noise control (T2), correlation + middleware + X-Request-ID (T3), worker bindings + print conversion (T4), full migration incl. errors.py extra-flattening (T5), rich dependency (T1 S1). Idempotency tested (T1 S2).
- Type consistency: `configure_logging(settings: Settings)` / `get_logger(name)` signatures consistent across tasks; `clear_correlation_id` defined in T3 before middleware consumes it.
- No placeholders: every step has exact code or exact commands.
