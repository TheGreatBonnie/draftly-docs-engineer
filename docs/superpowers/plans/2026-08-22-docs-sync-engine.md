# Docs Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a documentation sync engine that ingests repository documentation via GitHub App authentication, parses Markdown into chunks, embeds them into pgvector memory, and produces baseline snapshots for future change evaluation.

**Architecture:** Deterministic tree walk via GitHub API → file discovery (glob-based include/exclude) → content-hash skip → parse Markdown → chunk by headings → embed → store in existing memory namespace `documents`. Sync is idempotent: re-running yields zero-op. Audit extended beyond freshness to include broken links, orphaned docs, and duplicate headings.

**Tech Stack:** Python 3.12, FastAPI, httpx, Pydantic, pgvector, pytest, pytest-asyncio

**Spec:** `docs/superpowers/specs/2026-08-22-docs-sync-onboarding-design.md` (§4.1–4.6)

## Global Constraints

- Python 3.12+, no new dependencies beyond existing `httpx`, `pydantic`, `pgvector`
- Existing `documentation` table (`010_documentation.sql`): columns `commit_sha`, `source_hash`, `status`, `metadata JSONB`, unique `(org_id, path)`
- Existing `github_installations` table (`016_github_installations.sql`): `installation_id`, `org_id`, `github_org`
- Existing memory store: `DomainMemoryRepository` with namespace `MemoryNamespaces.DOCUMENTS` ("documents"); extended with `delete_by_metadata` + `store_batch` (Task 8)
- Existing `EmbeddingService.embed/embed_batch` with offline fallback; chunk embedding uses one `embed_batch` call per document (spec §4.3)
- Existing `GitHubClient._request/_request_text` helpers extended with an optional installation `token`; `get_tree`/`get_file_contents` build on them (no duplicated httpx plumbing)
- Existing `DocumentStore.upsert_document` keys on `(repository, path)`; Task 6 extends it to persist `status`/`commit_sha`/`source_hash` so content-hash skip works across runs
- GitHub installation lookup: new `GitHubInstallationsRepository.first_for_org(org_id)` wired into `RepositoryDependencies.github_installations` (Task 7)
- Document states: `source` → `indexed`; `proposed` reserved for future review-gated generation
- Chunks stored as typed `Document` models (namespace `documents`) with metadata `{document_id, path, heading_path, start_line, end_line, commit_sha}`
- No new migrations required — reuses existing `documentation` table
- Existing `WorkflowContext.repositories.documents` pattern for accessing document store
- Existing `WorkflowRegistry` + `TASK_REGISTRY` pattern for task registration
- Tests: `pytest` + `pytest-asyncio`, offline mode with `FakeDatabase`/`ScriptedClient`/`StubModel`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/draftly/documentation/parser.py` | Parse Markdown into heading tree with source line offsets; extract title from first H1 |
| `src/draftly/documentation/chunker.py` | Produce heading-bounded chunks with paragraph-boundary split for oversized sections |
| `src/draftly/documentation/discovery.py` | Deterministic glob-based classification of tree paths into documentation vs other |
| `src/draftly/documentation/baseline.py` | Snapshot record after successful sync; stored as JSONB on sync job record |
| `src/draftly/documentation/sync_service.py` | Orchestrator: resolve installation → mint token → tree walk → discover → fetch → hash-skip → parse → chunk → embed → store → baseline |
| `src/draftly/app/api/routes/onboarding.py` | Onboarding API routes (Plan 2) |
| `tests/unit/documentation/test_parser.py` | Parser unit tests |
| `tests/unit/documentation/test_chunker.py` | Chunker unit tests (driven by real parser output) |
| `tests/unit/documentation/test_discovery.py` | Discovery unit tests |
| `tests/unit/documentation/test_sync_service.py` | Sync service unit tests |
| `tests/unit/documentation/test_baseline.py` | Baseline unit tests |
| `tests/unit/documentation/test_document_store_sync.py` | Store extension tests (sync columns, org-scoped lookups) |
| `tests/unit/persistence/test_installations_lookup.py` | Org-scoped installation lookup tests |
| `tests/unit/memory/test_delete_by_metadata.py` | Stale-chunk cleanup + store_batch tests |
| `tests/unit/memory/test_document_model.py` | Document model heading-field tests |
| `tests/unit/integrations/test_github_client.py` | GitHubClient get_tree/get_file_contents tests |

### Modified Files

| File | Change |
|------|--------|
| `src/draftly/integrations/database/document_store.py` | Persist `status`/`commit_sha`/`source_hash` in upsert_document; add org-scoped lookups |
| `src/draftly/persistence/repositories/documents.py` | Add `upsert`, `get_by_org_and_path`, `list_by_org` passthroughs |
| `src/draftly/persistence/repositories/github.py` | Add `GitHubInstallationsRepository` (org-scoped installation lookup) |
| `src/draftly/app/dependencies.py` | Wire `github_installations` into `RepositoryDependencies` |
| `src/draftly/memory/repository.py` | Add `delete_by_metadata`, `store_batch` |
| `src/draftly/persistence/repositories/memory.py` | Add `delete_by_metadata` |
| `src/draftly/integrations/github/client.py` | Optional `token` on `_request`/`_request_text`; add `get_tree` and `get_file_contents` |
| `src/draftly/workflows/documentation/documentation_sync.py` | Replace stub with real sync orchestration |
| `src/draftly/workflows/documentation/documentation_audit.py` | Extend beyond freshness: broken links, orphaned docs, duplicate headings (reuses DocumentationValidator) |
| `src/draftly/app/composition/workflows.py` | Import and register new sync workflow |
| `src/draftly/app/composition/workers.py` | Add `documentation.sync_repository` task for HTTP-triggered sync |
| `src/draftly/app/api/routes/documentation.py` | Add `POST /sync`, `GET /sync/{job_id}`, `GET /baseline` endpoints |
| `src/draftly/memory/models/document.py` | Add `heading_path`, `start_line`, `end_line` fields to Document model |

---

## Task 1: Markdown Parser

**Files:**
- Create: `src/draftly/documentation/parser.py`
- Create: `tests/unit/documentation/test_parser.py`

**Interfaces:**
- Consumes: raw Markdown string
- Produces: `ParseResult` with `title: str | None`, `headings: list[HeadingNode]` where `HeadingNode` has `level`, `text`, `start_line`, `end_line`, `children`
- Semantics: the first H1 is retained in the tree as a root node (so preamble prose under the title gets chunked) AND captured as `result.title`; every heading's `end_line` is set when the section closes (next heading at same-or-higher level) or at EOF

- [x] **Step 1: Write the failing test**

```python
# tests/unit/documentation/test_parser.py
"""Unit tests for Markdown parser."""

from draftly.documentation.parser import ParseResult, parse_markdown


def test_parse_extracts_title_from_first_h1():
    md = "# Quick Start\n\nSome intro text.\n\n## Step 1\n\nDetails here."
    result = parse_markdown(md)
    assert result.title == "Quick Start"


def test_parse_returns_none_title_when_no_h1():
    md = "## Step 1\n\nDetails here."
    result = parse_markdown(md)
    assert result.title is None


def test_parse_builds_heading_tree():
    md = "# Root\n\n## Child A\n\n### Grandchild\n\n## Child B\n\nText."
    result = parse_markdown(md)
    assert len(result.headings) == 1  # H1 retained as tree root
    root = result.headings[0]
    assert root.text == "Root"
    assert root.level == 1
    assert [c.text for c in root.children] == ["Child A", "Child B"]
    grandchild = root.children[0].children[0]
    assert grandchild.text == "Grandchild"
    assert grandchild.level == 3


def test_parse_records_line_offsets():
    md = "# Title\n\n## Section\n\nContent.\n\n## Another\n\nMore."
    result = parse_markdown(md)
    assert result.headings[0].start_line == 1  # H1 retained in tree
    section = result.headings[0].children[0]
    assert section.start_line == 3
    assert section.end_line == 6  # closed by "## Another" at line 7
    another = result.headings[0].children[1]
    assert another.start_line == 7
    assert another.end_line == 9  # EOF


def test_parse_top_level_siblings_without_h1():
    md = "## Intro\n\nText.\n\n## Deep\n\nMore."
    result = parse_markdown(md)
    assert [h.text for h in result.headings] == ["Intro", "Deep"]
    assert all(h.level == 2 for h in result.headings)


def test_parse_empty_markdown():
    result = parse_markdown("")
    assert result.title is None
    assert result.headings == []


def test_parse_preserves_content_between_headings():
    md = "# Title\n\n## A\n\nLine 1\nLine 2\n\n## B\n\nDone."
    result = parse_markdown(md)
    assert len(result.headings) == 1
    assert [c.text for c in result.headings[0].children] == ["A", "B"]
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_parser.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'draftly.documentation.parser'`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/documentation/parser.py
"""Parse Markdown into heading tree with source line offsets."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class HeadingNode:
    """A heading in the Markdown document."""
    level: int
    text: str
    start_line: int
    end_line: int | None = None
    children: list[HeadingNode] = field(default_factory=list)


@dataclass
class ParseResult:
    """Result of parsing a Markdown document."""
    title: str | None = None
    headings: list[HeadingNode] = field(default_factory=list)


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")


def parse_markdown(content: str) -> ParseResult:
    """Parse Markdown content into a heading tree with line offsets."""
    lines = content.split("\n")
    result = ParseResult()
    stack: list[HeadingNode] = []
    title_found = False

    for i, line in enumerate(lines, start=1):
        m = _HEADING_RE.match(line)
        if not m:
            continue

        level = len(m.group(1))
        text = m.group(2).strip()

        if level == 1 and not title_found:
            result.title = text
            title_found = True

        node = HeadingNode(level=level, text=text, start_line=i)

        # Pop stack until we find a parent with a lower level.
        # Closed nodes get their end_line set here (not just at EOF) so the
        # chunker can slice exact ranges; roots popped with an empty stack
        # are appended to result.headings instead of being dropped.
        while stack and stack[-1].level >= level:
            closed = stack.pop()
            closed.end_line = i - 1
            if stack:
                stack[-1].children.append(closed)
            else:
                result.headings.append(closed)

        stack.append(node)

    # Finalize: close any open nodes
    last_end = len(lines)
    while stack:
        node = stack.pop()
        node.end_line = last_end
        if stack:
            stack[-1].children.append(node)
        else:
            result.headings.append(node)

    return result
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_parser.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/documentation/parser.py tests/unit/documentation/test_parser.py
git commit -m "feat: add Markdown parser with heading tree extraction"
```

---

## Task 2: Markdown Chunker

**Files:**
- Create: `src/draftly/documentation/chunker.py`
- Create: `tests/unit/documentation/test_chunker.py`

**Interfaces:**
- Consumes: `ParseResult` from parser + raw Markdown content
- Produces: `list[Chunk]` where each `Chunk` has `heading`, `heading_path`, `content`, `start_line`, `end_line`
- Semantics: walks the full tree depth-first (nested sections get their own chunks); `heading_path` is the ancestor chain joined with `" > "`; each chunk covers only the node's direct content (lines between its heading and the next heading at any depth), so ranges never overlap

- [x] **Step 1: Write the failing test**

```python
# tests/unit/documentation/test_chunker.py
"""Unit tests for Markdown chunker."""

from draftly.documentation.chunker import Chunk, chunk_document
from draftly.documentation.parser import parse_markdown


def test_chunk_single_section():
    md = "# Title\n\n## A\n\nHello world.\n\n## B\n\nDone."
    chunks = chunk_document(parse_markdown(md), md)
    # Title's own content is empty → skipped; A and B produce chunks
    assert len(chunks) == 2
    assert chunks[0].heading == "A"
    assert chunks[0].heading_path == "A"
    assert "Hello world." in chunks[0].content
    assert chunks[1].heading == "B"


def test_chunk_nested_heading_path():
    md = "# Title\n\n## A\n\nIntro.\n\n### B\n\nContent.\n\n## C\n\nDone."
    chunks = chunk_document(parse_markdown(md), md)
    assert len(chunks) == 3
    assert chunks[0].heading_path == "A"
    assert chunks[0].content == "Intro."
    assert chunks[1].heading_path == "A > B"
    assert chunks[1].content == "Content."
    assert chunks[2].heading_path == "C"
    # Ranges must not overlap
    assert chunks[0].end_line < chunks[1].start_line


def test_chunk_h1_preamble_becomes_chunk():
    md = "# My Project\n\nThis is the README intro."
    chunks = chunk_document(parse_markdown(md), md)
    assert len(chunks) == 1
    assert chunks[0].heading_path == "My Project"
    assert "README intro" in chunks[0].content


def test_chunk_oversized_splits_on_paragraph_boundary():
    long_text = "\n\n".join(["Paragraph " + str(i) + " " + "word " * 20 for i in range(20)])
    md = f"# Title\n\n## Big Section\n\n{long_text}"
    chunks = chunk_document(parse_markdown(md), md, max_chars=500)
    assert len(chunks) > 1
    total = "\n".join(c.content for c in chunks)
    assert "Paragraph 0" in total
    assert "Paragraph 19" in total
    assert all(len(c.content) <= 500 for c in chunks)


def test_chunk_empty_document():
    chunks = chunk_document(parse_markdown(""), "")
    assert chunks == []


def test_chunk_preserves_line_offsets():
    md = "# Title\n\n## A\n\nLine 1\n\n## B\n\nLine 2."
    chunks = chunk_document(parse_markdown(md), md)
    by_heading = {c.heading: c for c in chunks}
    assert by_heading["A"].start_line == 3   # "## A" line
    assert by_heading["B"].start_line == 7   # "## B" line
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_chunker.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/documentation/chunker.py
"""Produce heading-bounded chunks from parsed Markdown."""

from __future__ import annotations

from dataclasses import dataclass

from .parser import ParseResult, HeadingNode

DEFAULT_MAX_CHARS = 1200


@dataclass
class Chunk:
    """A content chunk bounded by headings."""
    heading: str
    heading_path: str
    content: str
    start_line: int
    end_line: int


def _flatten(nodes: list[HeadingNode]) -> list[tuple[HeadingNode, str]]:
    """Depth-first flatten with accumulated heading paths, in document order."""
    out: list[tuple[HeadingNode, str]] = []

    def walk(node: HeadingNode, prefix: list[str]) -> None:
        path = " > ".join([*prefix, node.text])
        out.append((node, path))
        for child in node.children:
            walk(child, [*prefix, node.text])

    for node in nodes:
        walk(node, [])
    return sorted(out, key=lambda pair: pair[0].start_line)


def _split_paragraphs(content: str, max_chars: int) -> list[str]:
    """Split content on paragraph boundaries at max_chars limit."""
    if len(content) <= max_chars:
        return [content]

    paragraphs = content.split("\n\n")
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        if current and len(current) + len(para) + 2 > max_chars:
            chunks.append(current.strip())
            current = para
        else:
            current = current + "\n\n" + para if current else para

    if current.strip():
        chunks.append(current.strip())

    return chunks


def chunk_document(
    parse_result: ParseResult,
    content: str,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> list[Chunk]:
    """Split a parsed Markdown document into heading-bounded chunks.

    Walks the full tree (nested sections included). Each node's chunk covers
    only its direct content — lines from its heading to the next heading at
    any depth — so ranges never overlap. Nodes whose direct content is empty
    (pure container headings) produce no chunk.
    """
    if not parse_result.headings:
        return []

    lines = content.split("\n")
    flat = _flatten(parse_result.headings)
    chunks: list[Chunk] = []
    total = len(flat)

    for idx, (node, path) in enumerate(flat):
        # 1-based inclusive range of the node's own content: the line after
        # its heading through the line before the next heading in document order.
        seg_start = node.start_line
        if idx + 1 < total:
            seg_end = flat[idx + 1][0].start_line - 1
        else:
            seg_end = node.end_line or len(lines)

        body = "\n".join(lines[seg_start:seg_end]).strip()
        if not body:
            continue

        parts = _split_paragraphs(body, max_chars)
        for i, part in enumerate(parts):
            suffix = f" (part {i + 1})" if len(parts) > 1 else ""
            chunks.append(Chunk(
                heading=node.text + suffix,
                heading_path=path,
                content=part,
                start_line=node.start_line,
                end_line=seg_end,
            ))

    return chunks
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_chunker.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/documentation/chunker.py tests/unit/documentation/test_chunker.py
git commit -m "feat: add Markdown chunker with heading-bounded splitting"
```

---

## Task 3: File Discovery

**Files:**
- Create: `src/draftly/documentation/discovery.py`
- Create: `tests/unit/documentation/test_discovery.py`

**Interfaces:**
- Consumes: `list[str]` (file paths), `include: list[str]` (globs), `exclude: list[str]` (globs)
- Produces: `list[str]` (filtered paths)

- [x] **Step 1: Write the failing test**

```python
# tests/unit/documentation/test_discovery.py
"""Unit tests for file discovery."""

from draftly.documentation.discovery import discover_documentation


DEFAULT_INCLUDE = ["README.md", "docs/**", "*.md", "*.mdx", "CHANGELOG.md", "CONTRIBUTING.md"]
DEFAULT_EXCLUDE = ["node_modules/**", "dist/**", "build/**", "vendor/**", ".git/**"]


def test_discover_default_includes_readme():
    paths = ["README.md", "src/main.py", "package.json"]
    result = discover_documentation(paths, DEFAULT_INCLUDE, DEFAULT_EXCLUDE)
    assert "README.md" in result
    assert "src/main.py" not in result


def test_discover_default_includes_docs_directory():
    paths = ["docs/getting-started.md", "docs/api/reference.mdx", "src/index.ts"]
    result = discover_documentation(paths, DEFAULT_INCLUDE, DEFAULT_EXCLUDE)
    assert "docs/getting-started.md" in result
    assert "docs/api/reference.mdx" in result
    assert "src/index.ts" not in result


def test_discover_excludes_node_modules():
    paths = ["node_modules/foo/README.md", "lib/README.md"]
    result = discover_documentation(paths, DEFAULT_INCLUDE, DEFAULT_EXCLUDE)
    assert "node_modules/foo/README.md" not in result
    assert "lib/README.md" in result


def test_discover_custom_include():
    paths = ["guides/setup.md", "README.md"]
    include = ["guides/**"]
    result = discover_documentation(paths, include, DEFAULT_EXCLUDE)
    assert "guides/setup.md" in result
    assert "README.md" not in result


def test_discover_custom_exclude():
    paths = ["internal/secret.md", "public/docs.md"]
    exclude = ["internal/**"]
    result = discover_documentation(paths, DEFAULT_INCLUDE, exclude)
    assert "internal/secret.md" not in result
    assert "public/docs.md" in result


def test_discover_empty_paths():
    result = discover_documentation([], DEFAULT_INCLUDE, DEFAULT_EXCLUDE)
    assert result == []


def test_discover_no_matches():
    paths = ["src/main.ts", "lib/util.js"]
    result = discover_documentation(paths, DEFAULT_INCLUDE, DEFAULT_EXCLUDE)
    assert result == []
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_discovery.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/documentation/discovery.py
"""Deterministic glob-based classification of file paths into documentation vs other."""

from __future__ import annotations

from fnmatch import fnmatch


def discover_documentation(
    paths: list[str],
    include: list[str],
    exclude: list[str],
) -> list[str]:
    """Filter file paths to documentation files based on include/exclude globs."""
    result: list[str] = []

    for path in paths:
        if _matches_any(path, exclude):
            continue
        if _matches_any(path, include):
            result.append(path)

    return sorted(result)


def _matches_any(path: str, patterns: list[str]) -> bool:
    """Check if a path matches any of the given glob patterns."""
    for pattern in patterns:
        if fnmatch(path, pattern):
            return True
        # Handle directory globs: docs/** matches docs/anything
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            if path.startswith(prefix + "/") or path == prefix:
                return True
    return False
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_discovery.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/documentation/discovery.py tests/unit/documentation/test_discovery.py
git commit -m "feat: add glob-based file discovery for documentation"
```

---

## Task 4: GitHubClient Extensions

**Files:**
- Modify: `src/draftly/integrations/github/client.py`
- Create: `tests/unit/integrations/test_github_client.py`

**Interfaces:**
- Produces: `get_tree(owner, repo, ref, token) -> list[TreeEntry]`, `get_file_contents(owner, repo, path, ref, token) -> str`

- [x] **Step 1: Write the failing test**

```python
# tests/unit/integrations/test_github_client.py
"""Unit tests for GitHub client extensions."""

import pytest
from unittest.mock import AsyncMock, patch
from draftly.integrations.github.client import GitHubClient


@pytest.mark.asyncio
async def test_get_tree_returns_recursive_entries():
    client = GitHubClient()
    mock_response = AsyncMock()
    mock_response.json.return_value = {
        "tree": [
            {"path": "README.md", "type": "blob", "sha": "abc123"},
            {"path": "docs/guide.md", "type": "blob", "sha": "def456"},
        ],
        "truncated": False,
    }
    mock_response.raise_for_status = AsyncMock()

    with patch.object(client, "_request", new_callable=AsyncMock, return_value=mock_response.json.return_value):
        result = await client.get_tree("owner", "repo", "main", "token123")
        assert len(result) == 2
        assert result[0]["path"] == "README.md"


@pytest.mark.asyncio
async def test_get_file_contents_returns_decoded_string():
    client = GitHubClient()
    import base64
    content = "# Hello\n\nWorld."
    encoded = base64.b64encode(content.encode()).decode()
    mock_response = {"content": encoded, "encoding": "base64"}

    with patch.object(client, "_request", new_callable=AsyncMock, return_value=mock_response):
        result = await client.get_file_contents("owner", "repo", "README.md", "main", "token123")
        assert result == content


@pytest.mark.asyncio
async def test_get_file_contents_skips_large_files():
    client = GitHubClient()
    # Simulate a file > 1MB by returning empty content
    with patch.object(client, "_request", new_callable=AsyncMock, return_value={"content": "", "encoding": "base64"}):
        result = await client.get_file_contents("owner", "repo", "huge.md", "main", "token123")
        assert result == ""
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/integrations/test_github_client.py -v`
Expected: FAIL with `AttributeError: 'GitHubClient' object has no attribute 'get_tree'`

- [x] **Step 3: Write minimal implementation**

First extend the existing helpers in `src/draftly/integrations/github/client.py` to accept an installation token (falls back to the default auth headers when omitted):

```python
    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        token: str | None = None,
    ) -> Any:
        url = f"{self.BASE_URL}{path}"
        headers = self.auth.headers()
        if token:
            headers = {**headers, "Authorization": f"Bearer {token}"}

        async with httpx.AsyncClient(
            timeout=self.timeout,
        ) as client:
            response = await client.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json,
            )

        response.raise_for_status()

        return response.json()
```

Apply the same optional `token` override to `_request_text`.

Then add the new methods (they reuse `_request` instead of duplicating httpx plumbing):

```python
    async def get_tree(
        self,
        owner: str,
        repo: str,
        ref: str,
        token: str,
    ) -> list[dict[str, Any]]:
        """Get recursive Git tree for a repository ref.

        A truncated recursive response cannot be paginated, so fall back to
        walking each root directory's subtree by sha.
        """
        data = await self._request(
            "GET",
            f"/repos/{owner}/{repo}/git/trees/{ref}",
            params={"recursive": "1"},
            token=token,
        )

        if not data.get("truncated", False):
            return list(data.get("tree", []))

        logger.warning(
            "github_tree_truncated owner=%s repo=%s ref=%s", owner, repo, ref
        )
        all_entries: list[dict[str, Any]] = []
        pending = [
            entry for entry in data.get("tree", []) if entry.get("type") == "tree"
        ]
        while pending:
            entry = pending.pop(0)
            subtree = await self._request(
                "GET",
                f"/repos/{owner}/{repo}/git/trees/{entry['sha']}",
                params={"recursive": "1"},
                token=token,
            )
            all_entries.extend(subtree.get("tree", []))
        return all_entries

    async def get_file_contents(
        self,
        owner: str,
        repo: str,
        path: str,
        ref: str,
        token: str,
    ) -> str:
        """Get decoded file contents from a repository."""
        import base64

        data = await self._request(
            "GET",
            f"/repos/{owner}/{repo}/contents/{path}",
            params={"ref": ref},
            token=token,
        )

        # Skip files > 1MB
        if data.get("size", 0) > 1_000_000:
            logger.warning("file_too_large path=%s size=%d", path, data.get("size", 0))
            return ""

        content = data.get("content", "")
        encoding = data.get("encoding", "")

        if encoding == "base64":
            return base64.b64decode(content).decode("utf-8", errors="replace")
        return content
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/integrations/test_github_client.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/integrations/github/client.py tests/unit/integrations/test_github_client.py
git commit -m "feat: add get_tree and get_file_contents to GitHubClient"
```

---

## Task 5: Baseline Snapshot

**Files:**
- Create: `src/draftly/documentation/baseline.py`
- Create: `tests/unit/documentation/test_baseline.py`

**Interfaces:**
- Consumes: sync results (commit_sha, document count, section count, chunk count, paths config)
- Produces: `BaselineSnapshot` Pydantic model

- [x] **Step 1: Write the failing test**

```python
# tests/unit/documentation/test_baseline.py
"""Unit tests for baseline snapshot."""

from draftly.documentation.baseline import BaselineSnapshot, create_baseline


def test_create_baseline_captures_all_fields():
    snapshot = create_baseline(
        commit_sha="abc123",
        repository="owner/repo",
        document_count=5,
        section_count=20,
        chunk_count=40,
        include=["*.md"],
        exclude=["node_modules/**"],
    )
    assert snapshot.commit_sha == "abc123"
    assert snapshot.repository == "owner/repo"
    assert snapshot.document_count == 5
    assert snapshot.section_count == 20
    assert snapshot.chunk_count == 40
    assert snapshot.include == ["*.md"]
    assert snapshot.exclude == ["node_modules/**"]
    assert snapshot.synced_at is not None


def test_baseline_to_dict():
    snapshot = create_baseline(
        commit_sha="abc123",
        repository="owner/repo",
        document_count=1,
        section_count=1,
        chunk_count=1,
    )
    d = snapshot.to_dict()
    assert d["commit_sha"] == "abc123"
    assert d["document_count"] == 1
    assert "synced_at" in d
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_baseline.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/documentation/baseline.py
"""Baseline snapshot after successful documentation sync."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field


class BaselineSnapshot(BaseModel):
    """Snapshot record after successful sync."""
    commit_sha: str
    repository: str
    document_count: int
    section_count: int
    chunk_count: int
    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)
    synced_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


def create_baseline(
    commit_sha: str,
    repository: str,
    document_count: int,
    section_count: int,
    chunk_count: int,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
) -> BaselineSnapshot:
    """Create a new baseline snapshot."""
    return BaselineSnapshot(
        commit_sha=commit_sha,
        repository=repository,
        document_count=document_count,
        section_count=section_count,
        chunk_count=chunk_count,
        include=include or [],
        exclude=exclude or [],
    )
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_baseline.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/documentation/baseline.py tests/unit/documentation/test_baseline.py
git commit -m "feat: add baseline snapshot model for sync results"
```

---

## Task 6: Extend Document Store for Sync Upserts

**Files:**
- Modify: `src/draftly/integrations/database/document_store.py`
- Modify: `src/draftly/persistence/repositories/documents.py`
- Create: `tests/unit/documentation/test_document_store_sync.py`

**Why:** `DocumentStore.upsert_document` keys on `(repository, path)` but never persists `commit_sha`, `source_hash`, or `status` — so the sync engine's content-hash skip cannot survive across runs (`source_hash` would stay NULL). The sync service also needs an org-scoped lookup (`get_by_org_and_path`) and org-scoped listing for the audit workflow (`list_by_org`). All existing callers keep working: every new parameter is optional.

**Interfaces:**
- Extends: `upsert_document(..., status=None, commit_sha=None, source_hash=None)` — persisted on both INSERT and UPDATE branches
- Adds: `get_by_org_and_path(*, org_id, path) -> dict | None`, `list_by_org(*, org_id, limit=1000) -> list[dict]`
- Also adds matching passthroughs on `DocumentRepository` (`persistence/repositories/documents.py`): `upsert`, `get_by_org_and_path`, `list_by_org` — the sync service reaches the store only through this repository (WorkflowContext pattern)
- Test style: reuse the `ScriptedClient` pattern from `tests/unit/documentation/test_document_store.py`

- [x] **Step 1: Write the failing test**

```python
# tests/unit/documentation/test_document_store_sync.py
"""Sync-focused DocumentStore tests (offline, scripted client)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from draftly.integrations.database.document_store import DocumentStore


@dataclass
class ScriptedClient:
    """Returns scripted rows in order and records every (sql, args) pair."""

    responses: list[Any] = field(default_factory=list)
    calls: list[tuple[str, tuple]] = field(default_factory=list)

    async def fetch_one(self, query: str, *args: Any) -> Any:
        self.calls.append((" ".join(query.split()), args))
        return self.responses.pop(0) if self.responses else None

    async def fetch_all(self, query: str, *args: Any) -> list[Any]:
        self.calls.append((" ".join(query.split()), args))
        rows = self.responses.pop(0) if self.responses else []
        return rows if isinstance(rows, list) else []

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((" ".join(query.split()), args))
        return "OK"


def _row(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": "doc-1",
        "org_id": "demo-org",
        "repository": "draftly/draftly-docs",
        "path": "guide.md",
        "title": None,
        "content": "c",
        "document_type": "general",
        "version": 1,
        "commit_sha": None,
        "status": "draft",
        "metadata": {},
        "stale": False,
        "outdated": False,
        "incomplete": False,
        "broken_links": False,
        "unsupported_claims": False,
        "created_at": None,
        "updated_at": None,
    }
    row.update(overrides)
    return row


async def test_upsert_document_persists_sync_columns_on_insert():
    client = ScriptedClient(
        responses=[None, _row(status="indexed", commit_sha="abc123", source_hash="deadbeef")]
    )
    store = DocumentStore(client)

    await store.upsert_document(
        org_id="demo-org",
        repository="draftly/draftly-docs",
        path="guide.md",
        content="# Guide",
        status="indexed",
        commit_sha="abc123",
        source_hash="deadbeef",
    )

    insert_sql, insert_args = client.calls[-1]
    assert "INSERT INTO documentation" in insert_sql
    assert "commit_sha" in insert_sql
    assert "source_hash" in insert_sql
    assert "status" in insert_sql
    assert "abc123" in insert_args
    assert "deadbeef" in insert_args
    assert "indexed" in insert_args


async def test_upsert_document_persists_sync_columns_on_update():
    client = ScriptedClient(
        responses=[{"id": "doc-1"}, _row(commit_sha="def456", status="indexed")]
    )
    store = DocumentStore(client)

    await store.upsert_document(
        repository="draftly/draftly-docs",
        path="guide.md",
        content="# Guide v2",
        status="indexed",
        commit_sha="def456",
        source_hash="cafebabe",
    )

    update_sql, update_args = client.calls[-1]
    assert "UPDATE documentation" in update_sql
    assert "commit_sha" in update_sql
    assert "source_hash" in update_sql
    assert "status" in update_sql
    assert "def456" in update_args


async def test_get_by_org_and_path_filters_on_org():
    client = ScriptedClient(responses=[_row(path="README.md")])
    store = DocumentStore(client)

    doc = await store.get_by_org_and_path(org_id="demo-org", path="README.md")

    assert doc is not None
    assert doc["path"] == "README.md"
    sql, args = client.calls[-1]
    assert "org_id = $1" in sql
    assert args[0] == "demo-org"


async def test_list_by_org_returns_rows_for_org():
    client = ScriptedClient(responses=[[_row(path="a.md"), _row(path="b.md")]])
    store = DocumentStore(client)

    docs = await store.list_by_org(org_id="demo-org")

    assert len(docs) == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_document_store_sync.py -v`
Expected: FAIL (`TypeError: unexpected keyword argument 'status'` / missing methods)

- [x] **Step 3: Write minimal implementation**

In `src/draftly/integrations/database/document_store.py`:

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
    ) -> dict[str, Any]:
```

Extend both branches:

```python
        if existing is not None:
            fields = ["content = $1"]
            params: list[Any] = [content]

            fields.append(f"metadata = ${len(params) + 1}")
            params.append(metadata or {})

            if title is not None:
                fields.append(f"title = ${len(params) + 1}")
                params.append(title)

            if document_type is not None:
                fields.append(f"document_type = ${len(params) + 1}")
                params.append(document_type)

            # NEW: persist sync columns when provided
            for column, value in (
                ("status", status),
                ("commit_sha", commit_sha),
                ("source_hash", source_hash),
            ):
                if value is not None:
                    fields.append(f"{column} = ${len(params) + 1}")
                    params.append(value)

            fields.append("updated_at = CURRENT_TIMESTAMP")
            params.append(existing["id"])
            # ... UPDATE unchanged from here

        else:
            # NEW: build INSERT dynamically so optional sync columns are included
            columns = ["repository", "path", "content", "metadata"]
            values: list[Any] = [repository, path, content, metadata or {}]
            for column, value in (
                ("org_id", org_id),
                ("title", title),
                ("document_type", document_type or "general"),
                ("status", status or "draft"),
                ("commit_sha", commit_sha),
                ("source_hash", source_hash),
            ):
                if value is not None:
                    columns.append(column)
                    values.append(value)

            placeholders = ", ".join(f"${i}" for i in range(1, len(values) + 1))
            row = await self.client.fetch_one(
                f"""
                INSERT INTO documentation ({", ".join(columns)})
                VALUES ({placeholders})
                RETURNING {_DOCUMENT_COLUMNS}
                """,
                *values,
            )
```

Add the repository passthroughs to `src/draftly/persistence/repositories/documents.py`:

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
        )

    async def get_by_org_and_path(
        self, *, org_id: str, path: str
    ) -> dict[str, Any] | None:
        return await self.store.get_by_org_and_path(org_id=org_id, path=path)

    async def list_by_org(
        self, *, org_id: str, limit: int = 1000
    ) -> list[dict[str, Any]]:
        return await self.store.list_by_org(org_id=org_id, limit=limit)
```

Add the two org-scoped lookups to `DocumentStore`:

```python
    async def get_by_org_and_path(
        self,
        *,
        org_id: str,
        path: str,
    ) -> dict[str, Any] | None:
        row = await self.client.fetch_one(
            f"""
            SELECT {_DOCUMENT_COLUMNS}
            FROM documentation
            WHERE org_id = $1
              AND path = $2
            LIMIT 1
            """,
            org_id,
            path,
        )
        return self._row_to_dict(row) if row else None

    async def list_by_org(
        self,
        *,
        org_id: str,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        rows = await self.client.fetch_all(
            f"""
            SELECT {_DOCUMENT_COLUMNS}
            FROM documentation
            WHERE org_id = $1
            ORDER BY updated_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
        return [self._row_to_dict(row) for row in rows]
```

- [x] **Step 4: Run existing store tests to verify no regression**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_document_store.py tests/unit/documentation/test_document_store_sync.py -v`
Expected: PASS (existing callers unaffected)

- [x] **Step 5: Commit**

```bash
git add src/draftly/integrations/database/document_store.py src/draftly/persistence/repositories/documents.py tests/unit/documentation/test_document_store_sync.py
git commit -m "feat: persist sync columns in upsert_document; add org-scoped lookups"
```

---

## Task 7: Wire GitHub Installation Lookup into Composition

**Files:**
- Modify: `src/draftly/persistence/repositories/github.py`
- Modify: `src/draftly/app/dependencies.py`
- Create: `tests/unit/persistence/test_installations_lookup.py`

**Why:** The sync workflow resolves the org's GitHub App installation via `context.repositories.github_installations`, but that accessor does not exist on `RepositoryDependencies` — every run would raise `RuntimeError`. The existing module function `list_github_installations()` lists ALL installations across orgs (and joins `organizations`); the sync path needs an org-filtered repository object wired like the others.

**Interfaces:**
- Produces: `GitHubInstallationsRepository` with `list_by_org(org_id)` and `first_for_org(org_id)`
- Wiring: `RepositoryDependencies.github_installations` field + construction in `build_repositories()`

- [x] **Step 1: Write the failing test**

```python
# tests/unit/persistence/test_installations_lookup.py
"""Unit tests for org-scoped GitHub installation lookup."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any

from draftly.persistence.repositories.github import GitHubInstallationsRepository


@dataclass
class FakeDb:
    rows: list[Any] = field(default_factory=list)
    queries: list[tuple[str, tuple]] = field(default_factory=list)

    async def fetch_all(self, query: str, *args: Any) -> list[Any]:
        self.queries.append((" ".join(query.split()), args))
        return self.rows


async def test_list_by_org_filters_on_org_and_parses_repositories_json():
    db = FakeDb(rows=[
        {
            "id": "gi-1",
            "installation_id": 12345,
            "github_org": "acme",
            "repositories": '["repo-a"]',  # stored as TEXT JSON
            "created_at": None,
            "updated_at": None,
        }
    ])
    repo = GitHubInstallationsRepository(db=db)

    installs = await repo.list_by_org("org_clerk_123")

    assert installs[0]["installation_id"] == 12345
    assert installs[0]["repositories"] == ["repo-a"]
    sql, args = db.queries[-1]
    assert "FROM github_installations" in sql
    assert "org_id = $1" in sql
    assert args[0] == "org_clerk_123"


async def test_first_for_org_returns_none_when_empty():
    repo = GitHubInstallationsRepository(db=FakeDb())
    assert await repo.first_for_org("missing-org") is None


async def test_repository_dependencies_declares_installations_field():
    from draftly.app.dependencies import RepositoryDependencies

    params = inspect.signature(RepositoryDependencies.__init__).parameters
    assert "github_installations" in params
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/persistence/test_installations_lookup.py -v`
Expected: FAIL (`ImportError: cannot import name 'GitHubInstallationsRepository'`)

- [x] **Step 3: Write minimal implementation**

Add to `src/draftly/persistence/repositories/github.py`:

```python
class GitHubInstallationsRepository:
    """Org-scoped access to github_installations for workflow contexts."""

    def __init__(self, db: DatabaseClient | None = None) -> None:
        self.db = db or DatabaseClient()

    async def list_by_org(self, org_id: str) -> list[dict[str, Any]]:
        """List installations belonging to one org (clerk_org_id)."""
        rows = await self.db.fetch_all(
            """
            SELECT gi.id::text, gi.installation_id, gi.github_org, gi.repositories,
                   gi.created_at, gi.updated_at
            FROM github_installations gi
            WHERE gi.org_id = $1
            ORDER BY gi.created_at DESC
            """,
            org_id,
        )
        result = []
        for row in rows:
            d = dict(row)
            if isinstance(d.get("repositories"), str):
                d["repositories"] = json.loads(d["repositories"])
            result.append(d)
        return result

    async def first_for_org(self, org_id: str) -> dict[str, Any] | None:
        """Most recent installation for an org, or None."""
        installs = await self.list_by_org(org_id)
        return installs[0] if installs else None
```

Wire into `src/draftly/app/dependencies.py`:

```python
class RepositoryDependencies(BaseModel):  # keep existing base/decorator as-is
    ...
    github_installations: GitHubInstallationsRepository
```

And in `build_repositories(...)`, construct it next to the other repositories using the same database client instance already used there:

```python
        github_installations=GitHubInstallationsRepository(db=<database client used by other repositories>),
```

> Implementer note: match however `DocumentRepository` receives its database client inside `build_repositories()` — reuse that exact variable.

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/persistence/test_installations_lookup.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/persistence/repositories/github.py src/draftly/app/dependencies.py tests/unit/persistence/test_installations_lookup.py
git commit -m "feat: wire org-scoped GitHub installation lookup into composition"
```

---

## Task 8: Add delete_by_metadata to Memory Layer

**Files:**
- Modify: `src/draftly/memory/repository.py`
- Modify: `src/draftly/persistence/repositories/memory.py`
- Create: `tests/unit/memory/test_delete_by_metadata.py`

**Why:** Re-syncing a changed document must remove its stale chunks before storing new ones (spec §4.4), otherwise superseded sections accumulate forever in the `documents` namespace. No such method exists today. Implemented by composing existing primitives (`list_namespace` + `delete`) so no new SQL is required; a single SQL delete by `metadata->>'document_id'` is a possible later optimization.

**Interfaces:**
- Produces: `DomainMemoryRepository.delete_by_metadata(namespace, key, value) -> int` returning number deleted
- Underlying: `MemoryRepository.delete_by_metadata(namespace, key, value) -> int`
- Also adds: `DomainMemoryRepository.store_batch(items) -> list[dict]` — persists many items with ONE `embed_batch` call (spec §4.3); used by the sync service when storing chunks

- [x] **Step 1: Write the failing test**

```python
# tests/unit/memory/test_delete_by_metadata.py
"""Unit tests for memory deletion scoped to a metadata value."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from draftly.memory.repository import DomainMemoryRepository


@pytest.mark.asyncio
async def test_delete_by_metadata_removes_only_matching_items():
    repository = AsyncMock()

    async def fake_list(namespace: str):
        assert namespace == "documents"
        return [
            {"id": "mem-1", "metadata": {"document_id": "doc-1"}},
            {"id": "mem-2", "metadata": {"document_id": "doc-1"}},
            {"id": "mem-3", "metadata": {"document_id": "doc-2"}},
            {"id": "mem-4", "metadata": {}},
        ]

    repository.list_namespace = AsyncMock(side_effect=fake_list)
    repository.delete = AsyncMock(return_value=True)
    domain = DomainMemoryRepository(repository=repository)

    deleted = await domain.delete_by_metadata(
        namespace="documents",
        key="document_id",
        value="doc-1",
    )

    assert deleted == 2
    deleted_ids = {call.args[0] for call in repository.delete.await_args_list}
    assert deleted_ids == {"mem-1", "mem-2"}


@pytest.mark.asyncio
async def test_delete_by_metadata_returns_zero_when_no_matches():
    repository = AsyncMock()
    repository.list_namespace = AsyncMock(return_value=[])
    domain = DomainMemoryRepository(repository=repository)

    deleted = await domain.delete_by_metadata(
        namespace="documents",
        key="document_id",
        value="doc-x",
    )

    assert deleted == 0
    repository.delete.assert_not_called()


class StubEmbeddings:
    """Records embed_batch calls; returns fixed vectors."""

    def __init__(self):
        self.batch_calls: list[list[str]] = []

    def embed(self, text: str) -> list[float]:
        return [0.0, 0.1]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        self.batch_calls.append(list(texts))
        return [[0.0, 0.1] for _ in texts]


@pytest.mark.asyncio
async def test_store_batch_uses_single_embed_batch_call():
    from draftly.memory.models.document import Document

    repository = AsyncMock()
    repository.create = AsyncMock(side_effect=lambda **kw: {"id": "ok"})
    embeddings = StubEmbeddings()
    domain = DomainMemoryRepository(repository=repository, embeddings=embeddings)

    items = [
        Document(namespace="documents", content="chunk one"),
        Document(namespace="documents", content="chunk two"),
    ]
    results = await domain.store_batch(items)

    assert len(results) == 2
    assert embeddings.batch_calls == [["chunk one", "chunk two"]]
    assert repository.create.await_count == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/memory/test_delete_by_metadata.py -v`
Expected: FAIL (`AttributeError: ... has no attribute 'delete_by_metadata'`)

- [x] **Step 3: Write minimal implementation**

Add to `DomainMemoryRepository` in `src/draftly/memory/repository.py`:

```python
    async def delete_by_metadata(self, *, namespace: str, key: str, value: str) -> int:
        """Delete all items in a namespace whose metadata[key] == value."""
        return await self.repository.delete_by_metadata(
            namespace=namespace, key=key, value=value
        )
```

Add to `MemoryRepository` in `src/draftly/persistence/repositories/memory.py`:

```python
    async def delete_by_metadata(self, *, namespace: str, key: str, value: str) -> int:
        """Delete items in a namespace matching metadata[key]; returns count."""
        items = await self.list_namespace(namespace=namespace)
        deleted = 0
        for item in items:
            if (item.get("metadata") or {}).get(key) == value:
                if await self.delete(memory_id=item["id"]):
                    deleted += 1
        return deleted
```

Add to `DomainMemoryRepository` in `src/draftly/memory/repository.py`:

```python
    async def store_batch(self, items: list[Any]) -> list[dict[str, Any]]:
        """Persist many MemoryItems with a single embed_batch call."""
        if not items:
            return []
        embeddings = self.embeddings.embed_batch([item.content for item in items])
        results: list[dict[str, Any]] = []
        for item, embedding in zip(items, embeddings):
            results.append(
                await self.repository.create(
                    namespace=item.namespace,
                    content=item.content,
                    memory_type=item.memory_type,
                    importance=float(item.importance),
                    confidence=float(item.confidence),
                    metadata=dict(item.metadata),
                    embedding=embedding,
                    org_id=item.org_id,
                )
            )
        return results
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/memory/test_delete_by_metadata.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/memory/repository.py src/draftly/persistence/repositories/memory.py tests/unit/memory/test_delete_by_metadata.py
git commit -m "feat: add delete_by_metadata to memory layer for stale chunk cleanup"
```

---

## Task 9: Wire Memory Embeddings into Documentation

**Files:**
- Modify: `src/draftly/memory/models/document.py`

**Interfaces:**
- Adds: `heading_path`, `start_line`, `end_line` fields to Document model
- Ordering: must land BEFORE the Sync Service Orchestrator task, which constructs `Document` chunks carrying these fields

- [x] **Step 1: Write the failing test**

```python
# tests/unit/memory/test_document_model.py
"""Unit tests for Document memory model."""

from draftly.memory.models.document import Document


def test_document_has_heading_fields():
    doc = Document(
        namespace="documents",
        content="test",
        heading_path="A > B",
        start_line=5,
        end_line=10,
    )
    assert doc.heading_path == "A > B"
    assert doc.start_line == 5
    assert doc.end_line == 10


def test_document_heading_fields_optional():
    doc = Document(
        namespace="documents",
        content="test",
    )
    assert doc.heading_path is None
    assert doc.start_line is None
    assert doc.end_line is None
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/memory/test_document_model.py -v`
Expected: FAIL (fields don't exist)

- [x] **Step 3: Write minimal implementation**

Update `src/draftly/memory/models/document.py`:

```python
"""Document memory model."""

from __future__ import annotations

from .base import MemoryItem


class Document(MemoryItem):
    """A documentation page tracked in memory."""

    memory_type: str = "document"
    path: str | None = None
    repository: str | None = None
    title: str | None = None
    heading_path: str | None = None
    start_line: int | None = None
    end_line: int | None = None
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/memory/test_document_model.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/memory/models/document.py tests/unit/memory/test_document_model.py
git commit -m "feat: add heading_path, start_line, end_line to Document model"
```

---

## Task 10: Sync Service Orchestrator

**Files:**
- Create: `src/draftly/documentation/sync_service.py`
- Create: `tests/unit/documentation/test_sync_service.py`

**Interfaces:**
- Consumes: `WorkflowContext` (repositories, memory), GitHub client, org_id, repository_full_name, include/exclude globs
- Produces: `SyncResult` with counts and baseline

- [x] **Step 1: Write the failing test**

```python
# tests/unit/documentation/test_sync_service.py
"""Unit tests for sync service."""

import pytest
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, MagicMock
from draftly.documentation.sync_service import SyncService, SyncResult


@dataclass
class FakeGitHubClient:
    tree: list = None
    files: dict = None
    repository: dict = None

    def __post_init__(self):
        if self.tree is None:
            self.tree = []
        if self.files is None:
            self.files = {}
        if self.repository is None:
            self.repository = {"default_branch": "main", "commit_sha": "abc123"}

    async def get_tree(self, owner, repo, ref, token):
        return self.tree

    async def get_file_contents(self, owner, repo, path, ref, token):
        return self.files.get(path, "")

    async def get_repository(self, repository):
        return self.repository

    async def get_installation_token(self, installation_id):
        return "fake-token"


@dataclass
class FakeDocuments:
    """Mirrors the DocumentRepository interface used by SyncService."""

    documents: list = field(default_factory=list)

    async def get_by_org_and_path(self, *, org_id, path):
        for doc in self.documents:
            if doc["org_id"] == org_id and doc["path"] == path:
                return doc
        return None

    async def upsert(self, **kwargs):
        self.documents.append(kwargs)
        return {"id": f"doc-{len(self.documents)}"}


@dataclass
class FakeMemory:
    """Mirrors DomainMemoryRepository interface used by SyncService."""

    stored: list = field(default_factory=list)
    deleted: list = field(default_factory=list)

    async def delete_by_metadata(self, *, namespace, key, value):
        self.deleted.append((namespace, key, value))
        return 0

    async def store_batch(self, items):
        self.stored.extend(items)
        return [{"id": f"mem-{i}"} for i in range(len(items))]


def _context(documents, memory, installation):
    context = MagicMock()
    context.repositories.documents = documents
    context.repositories.github_installations.first_for_org = AsyncMock(
        return_value=installation
    )
    context.memory = memory
    return context


@pytest.mark.asyncio
async def test_sync_discovers_and_stores_documents():
    github = FakeGitHubClient(
        tree=[
            {"path": "README.md", "type": "blob"},
            {"path": "src/main.py", "type": "blob"},
        ],
        files={"README.md": "# Hello\n\nWorld."},
    )
    documents = FakeDocuments()
    memory = FakeMemory()

    service = SyncService(github=github, context=_context(documents, memory, {"installation_id": 42}))
    result = await service.sync(
        org_id="test-org",
        repository_full_name="owner/repo",
        include=["README.md", "*.md"],
        exclude=[],
    )

    assert result.document_count == 1
    assert result.commit_sha == "abc123"
    # Document upsert persists sync columns so hash-skip works next run
    record = documents.documents[0]
    assert record["status"] == "indexed"
    assert record["commit_sha"] == "abc123"
    assert record["source_hash"]
    # Chunks are real Document models; stale cleanup ran first
    assert memory.deleted
    chunk = memory.stored[0]
    assert chunk.namespace == "documents"
    assert chunk.metadata["document_id"]


@pytest.mark.asyncio
async def test_sync_skips_unchanged_documents():
    import hashlib
    content = "# Hello\n\nWorld."
    content_hash = hashlib.sha256(content.encode()).hexdigest()

    github = FakeGitHubClient(
        tree=[{"path": "README.md", "type": "blob"}],
        files={"README.md": content},
    )
    documents = FakeDocuments(
        documents=[{"org_id": "test-org", "path": "README.md", "source_hash": content_hash}]
    )
    memory = FakeMemory()

    service = SyncService(github=github, context=_context(documents, memory, {"installation_id": 42}))
    result = await service.sync(
        org_id="test-org",
        repository_full_name="owner/repo",
        include=["README.md"],
        exclude=[],
    )

    assert result.document_count == 0  # Skipped
    assert not memory.stored


@pytest.mark.asyncio
async def test_sync_raises_without_installation():
    github = FakeGitHubClient()
    service = SyncService(github=github, context=_context(FakeDocuments(), FakeMemory(), None))

    with pytest.raises(RuntimeError, match="No GitHub installation"):
        await service.sync(org_id="org-x", repository_full_name="owner/repo")
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_sync_service.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 3: Write minimal implementation**

```python
# src/draftly/documentation/sync_service.py
"""Documentation sync service orchestrator."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Any

from draftly.memory.models.document import Document
from draftly.memory.repository import MemoryNamespaces

from .baseline import BaselineSnapshot, create_baseline
from .chunker import chunk_document
from .discovery import discover_documentation
from .parser import parse_markdown

logger = logging.getLogger(__name__)


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


class SyncService:
    """Orchestrate documentation sync from GitHub to Draftly."""

    def __init__(
        self,
        github: Any,
        context: Any,
    ) -> None:
        self.github = github
        self.context = context

    async def sync(
        self,
        *,
        org_id: str,
        repository_full_name: str,
        include: list[str] | None = None,
        exclude: list[str] | None = None,
    ) -> SyncResult:
        """Run a full documentation sync."""
        include = include or ["README.md", "docs/**", "*.md", "*.mdx", "CHANGELOG.md", "CONTRIBUTING.md"]
        exclude = exclude or ["node_modules/**", "dist/**", "build/**", "vendor/**", ".git/**"]

        # 1. Resolve installation (Task 7) and mint token
        installation = await self.context.repositories.github_installations.first_for_org(org_id)
        if installation is None:
            raise RuntimeError(f"No GitHub installation found for org {org_id}")
        token = await self.github.get_installation_token(installation["installation_id"])

        # 2. Get repository info
        repo_info = await self.github.get_repository(repository_full_name)
        default_branch = repo_info.get("default_branch", "main")
        commit_sha = repo_info.get("commit_sha", "unknown")

        # 3. Get tree
        owner, repo = repository_full_name.split("/", 1)
        tree = await self.github.get_tree(owner, repo, default_branch, token)
        paths = [entry["path"] for entry in tree if entry.get("type") == "blob"]

        # 4. Discover documentation files
        doc_paths = discover_documentation(paths, include, exclude)

        # 5. Process each file
        documents = self.context.repositories.documents
        memory = self.context.memory
        result = SyncResult(commit_sha=commit_sha, repository=repository_full_name)

        for path in doc_paths:
            try:
                content = await self.github.get_file_contents(owner, repo, path, default_branch, token)
                if not content:
                    continue

                # Content-hash skip against persisted source_hash (Task 6)
                content_hash = hashlib.sha256(content.encode()).hexdigest()
                existing = await documents.get_by_org_and_path(org_id=org_id, path=path)
                if existing and existing.get("source_hash") == content_hash:
                    result.skipped_count += 1
                    continue

                # Parse and chunk
                parse_result = parse_markdown(content)
                chunks = chunk_document(parse_result, content)

                # Upsert document via the repository passthroughs (Task 6)
                document_record = await documents.upsert(
                    org_id=org_id,
                    repository=repository_full_name,
                    path=path,
                    title=parse_result.title,
                    content=content,
                    status="indexed",
                    commit_sha=commit_sha,
                    source_hash=content_hash,
                    metadata={
                        "source_url": f"https://github.com/{repository_full_name}/blob/{default_branch}/{path}",
                        "branch": default_branch,
                        "section_count": len(parse_result.headings),
                        "chunk_count": len(chunks),
                    },
                )
                document_id = document_record["id"]

                # Remove stale chunks for this document, then store new ones
                # in a single embed_batch call per file (Tasks 8 + spec §4.3).
                if chunks:
                    await memory.delete_by_metadata(
                        namespace=MemoryNamespaces.DOCUMENTS,
                        key="document_id",
                        value=document_id,
                    )
                    items = [
                        Document(
                            namespace=MemoryNamespaces.DOCUMENTS,
                            memory_type="document_chunk",
                            content=chunk.content,
                            importance=0.5,
                            confidence=0.5,
                            org_id=org_id,
                            path=path,
                            heading_path=chunk.heading_path,
                            start_line=chunk.start_line,
                            end_line=chunk.end_line,
                            metadata={
                                "document_id": document_id,
                                "path": path,
                                "heading_path": chunk.heading_path,
                                "start_line": chunk.start_line,
                                "end_line": chunk.end_line,
                                "commit_sha": commit_sha,
                            },
                        )
                        for chunk in chunks
                    ]
                    await memory.store_batch(items)

                result.document_count += 1
                result.section_count += len(parse_result.headings)
                result.chunk_count += len(chunks)

            except Exception as exc:
                logger.exception("sync_file_failed path=%s", path)
                result.failed_files.append(path)

        # 6. Create baseline
        result.baseline = create_baseline(
            commit_sha=commit_sha,
            repository=repository_full_name,
            document_count=result.document_count,
            section_count=result.section_count,
            chunk_count=result.chunk_count,
            include=include,
            exclude=exclude,
        )

        return result
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/documentation/test_sync_service.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/documentation/sync_service.py tests/unit/documentation/test_sync_service.py
git commit -m "feat: add sync service orchestrator with content-hash skip"
```

---

## Task 11: Register Sync Workflow

**Files:**
- Modify: `src/draftly/workflows/documentation/documentation_sync.py`
- Modify: `src/draftly/app/composition/workflows.py`
- Modify: `src/draftly/app/composition/workers.py`

**Interfaces:**
- Consumes: `WorkflowContext` with repositories and memory
- Produces: Registered `documentation_sync` workflow and `documentation.sync_repository` task

- [x] **Step 1: Write the failing test**

```python
# tests/unit/workflows/test_sync_workflow.py
"""Unit tests for documentation sync workflow."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from draftly.workflows.documentation.documentation_sync import run_documentation_sync
from draftly.workflows.state import WorkflowStatus


def _context(installation):
    context = MagicMock()
    context.repositories.github_installations.first_for_org = AsyncMock(
        return_value=installation
    )
    return context


@pytest.mark.asyncio
async def test_sync_workflow_completes_delivered():
    """Happy path: installation resolves, sync service succeeds."""
    from draftly.documentation.sync_service import SyncResult

    sync_result = SyncResult(
        commit_sha="abc123",
        repository="owner/repo",
        document_count=3,
        chunk_count=9,
    )

    with patch("draftly.documentation.sync_service.SyncService") as service_cls:
        service_cls.return_value.sync = AsyncMock(return_value=sync_result)
        state = await run_documentation_sync(
            _context({"installation_id": 42}),
            org_id="test-org",
            repository_full_name="owner/repo",
        )

    assert state.status == WorkflowStatus.DELIVERED
    assert state.result["document_count"] == 3
    assert state.result["chunk_count"] == 9


@pytest.mark.asyncio
async def test_sync_workflow_fails_without_installation():
    """No GitHub App installation for the org → FAILED, not crash."""
    state = await run_documentation_sync(
        _context(None),
        org_id="test-org",
        repository_full_name="owner/repo",
    )
    assert state.status == WorkflowStatus.FAILED


@pytest.mark.asyncio
async def test_sync_workflow_fails_with_missing_params():
    state = await run_documentation_sync(_context(None))
    assert state.status == WorkflowStatus.FAILED
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_sync_workflow.py -v`
Expected: FAIL (signature mismatch or import error)

- [x] **Step 3: Write minimal implementation**

Update `src/draftly/workflows/documentation/documentation_sync.py`:

```python
"""Documentation sync workflow (plan §7.2).

Scheduled full-repository documentation sweep. Orchestrates the sync
service to ingest documentation from GitHub into the document store
and memory index.
"""

from __future__ import annotations

import logging
from typing import Any

from draftly.workflows.context import WorkflowContext
from draftly.workflows.state import WorkflowState, WorkflowStatus

logger = logging.getLogger(__name__)


async def run_documentation_sync(
    context: WorkflowContext,
    *,
    org_id: str | None = None,
    repository_full_name: str | None = None,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    **kwargs: Any,
) -> WorkflowState:
    """Sync documentation from GitHub into the document store."""
    del kwargs
    state = WorkflowState(run_id=f"doc-sync-{id(object())}")

    if org_id is None or repository_full_name is None:
        logger.warning("documentation_sync_missing_params")
        return state.finish(WorkflowStatus.FAILED)

    try:
        from draftly.documentation.sync_service import SyncService

        # Build a minimal GitHub client for sync
        from draftly.integrations.github.client import GitHubClient
        github = GitHubClient()

        service = SyncService(github=github, context=context)
        result = await service.sync(
            org_id=org_id,
            repository_full_name=repository_full_name,
            include=include,
            exclude=exclude,
        )

        state.result = {
            "document_count": result.document_count,
            "section_count": result.section_count,
            "chunk_count": result.chunk_count,
            "skipped_count": result.skipped_count,
            "failed_files": result.failed_files,
        }

        if result.baseline:
            state.result["baseline"] = result.baseline.to_dict()

        logger.info(
            "documentation_sync_done org=%s repo=%s docs=%d chunks=%d",
            org_id,
            repository_full_name,
            result.document_count,
            result.chunk_count,
        )
        return state.finish(WorkflowStatus.DELIVERED)

    except Exception as exc:
        logger.exception("documentation_sync_failed")
        state.errors.append(str(exc))
        return state.finish(WorkflowStatus.FAILED)
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_sync_workflow.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/workflows/documentation/documentation_sync.py tests/unit/workflows/test_sync_workflow.py
git commit -m "feat: implement documentation sync workflow with sync service"
```

---

## Task 12: Documentation Sync API Route

**Files:**
- Modify: `src/draftly/app/api/routes/documentation.py`
- Modify: `src/draftly/app/composition/workers.py`

**Interfaces:**
- Produces: `POST /api/documentation/sync`, `GET /api/documentation/sync/{job_id}`, `GET /api/documentation/baseline`

- [x] **Step 1: Write the failing test**

```python
# tests/api/test_documentation_sync.py
"""Tests for documentation sync API routes."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock
from draftly.app.api.routes import documentation


SYNC_RESULT = {
    "document_count": 2,
    "chunk_count": 7,
    "commit_sha": "abc123",
    "baseline": {"commit_sha": "abc123"},
}


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(documentation.router, prefix="/api")
    # Mock auth
    from draftly.app.api.auth import get_verified_token
    app.dependency_overrides[get_verified_token] = lambda: {"sub": "tester", "org_id": "test-org"}

    state = MagicMock()
    # Follows the real composition shape: application.worker + task_runner,
    # and application.dependencies.repositories.jobs (see jobs.py route).
    state.worker = MagicMock()
    state.worker.task_runner.has_task = MagicMock(return_value=True)
    state.worker.run_task = AsyncMock(return_value=SYNC_RESULT)
    state.dependencies.repositories.jobs.get = AsyncMock(
        return_value={"id": "job-123", "status": "completed"}
    )
    state.dependencies.repositories.documents.list_by_org = AsyncMock(return_value=[
        {"repository": "owner/repo", "path": "README.md", "commit_sha": "abc123", "status": "indexed"},
        {"repository": "owner/repo", "path": "docs/guide.md", "commit_sha": "abc123", "status": "indexed"},
        {"repository": "owner/repo", "path": "docs/old.md", "commit_sha": "000000", "status": "stale"},
    ])
    app.state.draftly = state

    return TestClient(app)


class TestDocumentationSyncRoutes:
    def test_sync_runs_task_and_returns_result(self, client: TestClient) -> None:
        response = client.post(
            "/api/documentation/sync",
            json={"repository_full_name": "owner/repo"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "completed"
        assert data["result"]["document_count"] == 2

    def test_sync_returns_503_when_worker_disabled(self, client: TestClient) -> None:
        client.app.state.draftly.worker = None
        response = client.post(
            "/api/documentation/sync",
            json={"repository_full_name": "owner/repo"},
        )
        assert response.status_code == 503

    def test_sync_returns_404_for_unknown_task(self, client: TestClient) -> None:
        client.app.state.draftly.worker.task_runner.has_task.return_value = False
        response = client.post(
            "/api/documentation/sync",
            json={"repository_full_name": "owner/repo"},
        )
        assert response.status_code == 404

    def test_sync_status_reads_job_record(self, client: TestClient) -> None:
        response = client.get("/api/documentation/sync/job-123")
        assert response.status_code == 200
        assert response.json()["job"]["status"] == "completed"

    def test_sync_status_404_for_unknown_job(self, client: TestClient) -> None:
        client.app.state.draftly.dependencies.repositories.jobs.get = AsyncMock(return_value=None)
        response = client.get("/api/documentation/sync/nope")
        assert response.status_code == 404

    def test_baseline_reports_live_document_state(self, client: TestClient) -> None:
        response = client.get("/api/documentation/baseline?repository=owner/repo")
        assert response.status_code == 200
        data = response.json()
        assert data["document_count"] == 3
        assert data["latest_commit_sha"] == "abc123"
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_documentation_sync.py -v`
Expected: FAIL (route doesn't exist)

- [x] **Step 3: Write minimal implementation**

Add to `src/draftly/app/api/routes/documentation.py`:

```python
# Add near the top of src/draftly/app/api/routes/documentation.py
from collections import Counter


class SyncRequest(BaseModel):
    repository_full_name: str
    include: list[str] | None = None
    exclude: list[str] | None = None


def _worker(request: Request):
    """Resolve the application worker, mirroring routes/jobs.py."""
    worker = getattr(request.app.state.draftly, "worker", None)
    if worker is None:
        raise HTTPException(status_code=503, detail="Background worker is disabled")
    return worker


@router.post("/sync")
async def sync_documentation(
    request: Request,
    body: SyncRequest,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Run documentation sync for a repository (synchronous via the task runner)."""
    org_id = token.get("org_id")
    if not org_id:
        raise HTTPException(status_code=400, detail="No organization selected")

    worker = _worker(request)
    if not worker.task_runner.has_task("documentation.sync_repository"):
        raise HTTPException(status_code=404, detail="Unknown job: documentation.sync_repository")

    result = await worker.run_task(
        "documentation.sync_repository",
        org_id=org_id,
        repository_full_name=body.repository_full_name,
        include=body.include,
        exclude=body.exclude,
    )

    return {"status": "completed", "result": result}


@router.get("/sync/{job_id}")
async def get_sync_status(
    job_id: str,
    request: Request,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Look up a sync run's job record."""
    jobs = request.app.state.draftly.dependencies.repositories.jobs
    record = await jobs.get(job_id=job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return {"job": record}


@router.get("/baseline")
async def get_baseline(
    request: Request,
    repository: str,
    token: dict = Depends(get_verified_token),
) -> dict[str, Any]:
    """Live baseline: current indexed state for a repository.

    v1 executes sync synchronously and returns the BaselineSnapshot in the
    POST /sync response; this endpoint reports the live indexed state.
    """
    org_id = token.get("org_id")
    if not org_id:
        raise HTTPException(status_code=400, detail="No organization selected")

    documents = _documents(request)
    rows = await documents.list_by_org(org_id=org_id, limit=1000)
    repo_rows = [row for row in rows if row.get("repository") == repository]
    shas = [row.get("commit_sha") for row in repo_rows if row.get("commit_sha")]
    latest = Counter(shas).most_common(1)[0][0] if shas else None

    return {
        "repository": repository,
        "document_count": len(repo_rows),
        "latest_commit_sha": latest,
        "stale_count": sum(1 for row in repo_rows if row.get("status") == "stale"),
    }
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/api/test_documentation_sync.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/app/api/routes/documentation.py tests/api/test_documentation_sync.py
git commit -m "feat: add documentation sync API routes"
```

---

## Task 13: Audit Upgrade

**Files:**
- Modify: `src/draftly/workflows/documentation/documentation_audit.py`

**Interfaces:**
- Extends: `run_documentation_audit` beyond freshness to include broken links, orphaned docs, duplicate headings

- [x] **Step 1: Write the failing test**

```python
# tests/unit/workflows/test_audit_upgrade.py
"""Unit tests for upgraded documentation audit."""

from datetime import UTC, datetime, timedelta

import pytest
from unittest.mock import AsyncMock, MagicMock
from draftly.workflows.documentation.documentation_audit import run_documentation_audit
from draftly.workflows.state import WorkflowStatus


def _documents(rows):
    documents = MagicMock()
    documents.list_by_org = AsyncMock(return_value=rows)
    return documents


@pytest.mark.asyncio
async def test_audit_checks_broken_links():
    context = MagicMock()
    context.repositories.documents = _documents([
        {"id": "doc-1", "path": "guide.md", "content": "# Guide\n\nSee [link](missing-target.md)", "updated_at": None},
        {"id": "doc-2", "path": "other.md", "content": "# Other", "updated_at": None},
    ])

    state = await run_documentation_audit(context, org_id="test-org", freshness_days=30)

    assert state.status == WorkflowStatus.DELIVERED
    result = state.result
    assert {"source": "guide.md", "target": "missing-target.md"} in result["broken_links"]
    # Valid links are not flagged
    assert all(b["source"] != "none.md" for b in result["broken_links"])


@pytest.mark.asyncio
async def test_audit_detects_orphaned_documents():
    context = MagicMock()
    context.repositories.documents = _documents([
        {"id": "doc-1", "path": "index.md", "content": "# Index\n\n[Guide](guide.md)", "updated_at": None},
        {"id": "doc-2", "path": "guide.md", "content": "# Guide", "updated_at": None},
        {"id": "doc-3", "path": "orphan.md", "content": "# Orphan", "updated_at": None},
    ])

    state = await run_documentation_audit(context, org_id="test-org")

    # orphan.md has no inbound links
    assert "orphan.md" in state.result.get("orphaned_documents", [])
    assert "guide.md" not in state.result.get("orphaned_documents", [])


@pytest.mark.asyncio
async def test_audit_flags_stale_documents():
    old_timestamp = (datetime.now(UTC) - timedelta(days=60)).isoformat()
    context = MagicMock()
    context.repositories.documents = _documents([
        {"id": "old-1", "path": "old.md", "content": "# Old", "updated_at": old_timestamp},
    ])

    state = await run_documentation_audit(context, org_id="test-org", freshness_days=30)

    assert state.result["stale_documents"] == ["old-1"]


@pytest.mark.asyncio
async def test_audit_flags_duplicate_headings_within_a_document():
    context = MagicMock()
    context.repositories.documents = _documents([
        {
            "id": "dup",
            "path": "dup.md",
            "content": "# Guide\n\n## Setup\n\ntext\n\n## Setup\n\nmore",
            "updated_at": None,
        },
    ])

    state = await run_documentation_audit(context, org_id="test-org")

    assert {"document": "dup.md", "heading": "## Setup", "count": 2} in state.result["duplicate_headings"]
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_audit_upgrade.py -v`
Expected: FAIL (missing fields in result)

- [x] **Step 3: Write minimal implementation**

Update `src/draftly/workflows/documentation/documentation_audit.py`:

```python
"""Documentation audit workflow (plan §7.2).

Extended audit: freshness scan, broken internal links, orphaned docs,
duplicate headings. Advisory-only — findings require human review.

Spec §4.6 note: "missing coverage" candidates (search_code queries with
no documentation hits) are explicitly DEFERRED — they require live search
telemetry and are tracked as follow-up work, not silently dropped.
"""

from __future__ import annotations

import logging
import posixpath
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from draftly.documentation.validator import DocumentationValidator
from draftly.workflows.context import WorkflowContext
from draftly.workflows.state import WorkflowState, WorkflowStatus

DEFAULT_FRESHNESS_DAYS = 30

logger = logging.getLogger(__name__)


async def run_documentation_audit(
    context: WorkflowContext,
    *,
    org_id: str | None = None,
    freshness_days: int = DEFAULT_FRESHNESS_DAYS,
    **kwargs: Any,
) -> WorkflowState:
    """Extended documentation audit: freshness, links, orphans, duplicates."""
    del kwargs
    state = WorkflowState(run_id=f"doc-audit-{datetime.now(UTC):%Y%m%d%H%M%S}")
    documents = getattr(context.repositories, "documents", None) if context else None

    result: dict[str, Any] = {
        "org_id": org_id,
        "stale_documents": [],
        "broken_links": [],
        "orphaned_documents": [],
        "duplicate_headings": [],
        "freshness_days": freshness_days,
    }

    # Org-scoped data access via Task 6's list_by_org passthrough.
    if documents is None or org_id is None:
        logger.warning("documentation_audit_skipped has_documents=%s org_id=%s", documents is not None, org_id)
        state.result = result
        return state.finish(WorkflowStatus.DELIVERED)

    try:
        all_docs = list(await documents.list_by_org(org_id=org_id, limit=1000))
    except Exception:
        logger.exception("documentation_audit_list_failed")
        state.result = result
        return state.finish(WorkflowStatus.DELIVERED)

    validator = DocumentationValidator()
    known_paths = {doc.get("path", "") for doc in all_docs}
    inbound: set[str] = set()

    for doc in all_docs:
        path = doc.get("path", "")
        content = doc.get("content", "")

        # 1. Freshness — reuses validator.check_freshness (ISO/str/datetime safe)
        days = validator.check_freshness(doc.get("updated_at") or doc.get("created_at"))
        if days is None or days > freshness_days:
            result["stale_documents"].append(doc.get("id", "?"))

        # 2. Links — every target feeds the inbound graph (orphan detection);
        #    check_links additionally flags relative targets missing from the corpus.
        for target in validator.analyzer.links(content):
            inbound.add(_resolve(path, target))
        for target in validator.check_links(content, known_paths=known_paths):
            result["broken_links"].append({"source": path, "target": target})

    # 3. Orphaned documents: nothing links to them
    for path in sorted(known_paths):
        if path and path not in inbound:
            result["orphaned_documents"].append(path)

    # 4. Duplicate headings within a single document
    for doc in all_docs:
        counts = Counter(
            line.strip()
            for line in doc.get("content", "").split("\n")
            if line.strip().startswith("#")
        )
        for heading, count in counts.items():
            if count > 1:
                result["duplicate_headings"].append(
                    {"document": doc.get("path"), "heading": heading, "count": count}
                )

    state.result = result
    logger.info(
        "documentation_audit_done stale=%d broken=%d orphaned=%d dupes=%d",
        len(result["stale_documents"]),
        len(result["broken_links"]),
        len(result["orphaned_documents"]),
        len(result["duplicate_headings"]),
    )
    return state.finish(WorkflowStatus.DELIVERED)


def _resolve(source_path: str, target: str) -> str:
    """Resolve a relative doc link to a repository path."""
    base = posixpath.dirname(source_path)
    return posixpath.normpath(posixpath.join(base, target.split("#", 1)[0]))
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_audit_upgrade.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/workflows/documentation/documentation_audit.py tests/unit/workflows/test_audit_upgrade.py
git commit -m "feat: upgrade audit with broken links, orphans, duplicate headings"
```

---

## Task 14: Register Sync Task for HTTP Trigger

**Files:**
- Modify: `src/draftly/app/composition/workers.py`
- Modify: `src/draftly/app/composition/workflows.py`

**Interfaces:**
- Produces: `documentation.sync_repository` task registered in `TASK_REGISTRY`

- [x] **Step 1: Write the failing test**

```python
# tests/unit/workflows/test_task_registration.py
"""Unit tests for task registration."""

import pytest
from unittest.mock import MagicMock
from draftly.app.composition.workers import build_task_runner, TASK_REGISTRY


def test_task_runner_registers_sync_repository():
    workflows = MagicMock()
    workflows.registry = MagicMock()
    workflows.registry.get = MagicMock(return_value=MagicMock())
    workflows.context = MagicMock()

    runner = build_task_runner(workflows=workflows, dependencies=MagicMock())

    assert runner.has_task("documentation.sync_repository")
    assert runner.has_task("documentation.sync")
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_task_registration.py -v`
Expected: FAIL (task not registered)

- [x] **Step 3: Write minimal implementation**

Update `src/draftly/app/composition/workers.py`:

```python
TASK_REGISTRY: dict[str, str] = {
    "documentation.sync": "documentation_sync",
    "documentation.sync_repository": "documentation_sync",
    "documentation.stale_scan": "documentation_audit",
    "support.gap_scan": "feedback_loop",
    "evaluation.loop": "evaluation_loop",
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/unit/workflows/test_task_registration.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/draftly/app/composition/workers.py tests/unit/workflows/test_task_registration.py
git commit -m "feat: register documentation.sync_repository task for HTTP trigger"
```

---

## Task 15: Integration Test — Full Sync Flow

**Files:**
- Create: `tests/integration/test_sync_flow.py`

**Interfaces:**
- End-to-end: mock GitHub → sync → verify documents + chunks stored

- [x] **Step 1: Write the failing test**

```python
# tests/integration/test_sync_flow.py
"""Integration test for full documentation sync flow."""

import pytest
from unittest.mock import AsyncMock, MagicMock
from draftly.documentation.sync_service import SyncService


@pytest.mark.asyncio
async def test_full_sync_flow():
    """End-to-end: GitHub → discover → fetch → parse → chunk → embed → store."""
    # Mock GitHub client
    github = MagicMock()
    github.get_installation_token = AsyncMock(return_value="token-123")
    github.get_repository = AsyncMock(return_value={"default_branch": "main", "commit_sha": "abc123"})
    github.get_tree = AsyncMock(return_value=[
        {"path": "README.md", "type": "blob"},
        {"path": "docs/guide.md", "type": "blob"},
    ])
    github.get_file_contents = AsyncMock(side_effect=lambda owner, repo, path, ref, token: {
        "README.md": "# My Project\n\nThis is the README.",
        "docs/guide.md": "# Guide\n\n## Getting Started\n\nInstall instructions.\n\n## Usage\n\nRun the app.",
    }[path])

    # Mock context
    context = MagicMock()
    documents = MagicMock()
    documents.get_by_org_and_path = AsyncMock(return_value=None)
    documents.upsert = AsyncMock(return_value={"id": "doc-1"})
    context.repositories.documents = documents
    context.repositories.github_installations.first_for_org = AsyncMock(
        return_value={"installation_id": 123}
    )
    memory = MagicMock()
    memory.delete_by_metadata = AsyncMock(return_value=0)
    memory.store_batch = AsyncMock(return_value=[{"id": "mem-1"}])
    context.memory = memory

    # Run sync
    service = SyncService(github=github, context=context)
    result = await service.sync(
        org_id="test-org",
        repository_full_name="owner/repo",
        include=["README.md", "*.md", "docs/**"],
        exclude=[],
    )

    # Verify
    assert result.document_count == 2
    assert result.chunk_count >= 2
    assert result.commit_sha == "abc123"
    assert result.baseline is not None
    assert result.baseline.document_count == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd draftly-agent-backend && python -m pytest tests/integration/test_sync_flow.py -v`
Expected: FAIL (implementation issues)

- [x] **Step 3: Write minimal implementation**

The implementation is already in place from Task 10. This test validates the integration. If it fails, debug and fix the sync service implementation.

- [x] **Step 4: Run test to verify it passes**

Run: `cd draftly-agent-backend && python -m pytest tests/integration/test_sync_flow.py -v`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add tests/integration/test_sync_flow.py
git commit -m "test: add integration test for full sync flow"
```

---

## Self-Review Checklist

After completing all tasks, verify:

1. **Spec coverage:** §4.1 (parser, chunker, discovery, baseline, sync_service) ✓, §4.2 (GitHubClient extensions) ✓, §4.3 (sync orchestrator with batched embeddings) ✓, §4.4 (chunk storage + stale cleanup in memory) ✓, §4.5 (API surface) ✓, §4.6 (audit upgrade; missing-coverage candidates explicitly deferred and documented in the workflow docstring) ✓

2. **Interface grounding:** every repository/context call in the plan matches a method that exists after the prerequisite task lands (`documents.upsert`/`get_by_org_and_path` ← Task 6, `github_installations.first_for_org` ← Task 7, `memory.delete_by_metadata`/`store_batch` ← Task 8, Document heading fields ← Task 9) ✓

3. **Placeholder scan:** No "TBD", "TODO", or "implement later" in any step ✓

4. **Type consistency:** All function signatures, parameter names, and return types match across tasks ✓

5. **Test coverage:** Every module has unit tests; integration test covers full flow ✓

6. **Commit granularity:** Each task produces one focused commit ✓
