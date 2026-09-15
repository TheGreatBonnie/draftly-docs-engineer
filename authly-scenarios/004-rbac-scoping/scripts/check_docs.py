#!/usr/bin/env python3
"""Verify Authly documentation integrity.

Checks that every Python fence in docs/ compiles, every internal link resolves
(including heading anchors), and the documented tutorial flow actually runs
against the installed SDK. Exits non-zero on any failure.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
sys.path.insert(0, str(ROOT / "src"))

PYTHON_FENCE = re.compile(r"```python\n(.*?)```", re.DOTALL)
LINK = re.compile(r"\[[^\]]+\]\(([^)#]+)(#[^)]*)?\)")
EXPLICIT_ANCHOR = re.compile(r"\{\s*#([\w-]+)\s*\}")


def _markdown_files() -> list[Path]:
    return sorted(DOCS_DIR.rglob("*.md"))


def check_fences() -> list[str]:
    failures: list[str] = []
    count = 0
    for md_path in _markdown_files():
        rel = md_path.relative_to(ROOT)
        for match in PYTHON_FENCE.finditer(md_path.read_text(encoding="utf-8")):
            count += 1
            try:
                compile(match.group(1), str(rel), "exec")
            except SyntaxError as exc:
                failures.append(f"syntax error in {rel}: {exc}")
    print(f"[fences] compiled {count} python fences")
    return failures


def _heading_slugs(text: str) -> set[str]:
    slugs: set[str] = set()
    for line in text.splitlines():
        if not line.startswith("#"):
            continue
        heading = line.lstrip("#").strip()
        heading = EXPLICIT_ANCHOR.sub("", heading).strip()
        slug = re.sub(r"[^\w\- ]", "", heading).lower().replace(" ", "-")
        slug = re.sub(r"-+", "-", slug).strip("-")
        if slug:
            slugs.add(slug)
    slugs.update(EXPLICIT_ANCHOR.findall(text))
    return slugs


def check_links() -> list[str]:
    failures: list[str] = []
    count = 0
    for md_path in _markdown_files():
        rel = md_path.relative_to(DOCS_DIR)
        text = md_path.read_text(encoding="utf-8")
        for match in LINK.finditer(text):
            target, anchor = match.group(1).strip(), match.group(2)
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            count += 1
            resolved = (md_path.parent / target).resolve()
            if not resolved.exists():
                failures.append(f"{rel}: broken link '{target}'")
                continue
            if anchor:
                anchor_name = anchor.lstrip("#")
                if anchor_name not in _heading_slugs(resolved.read_text(encoding="utf-8")):
                    failures.append(f"{rel}: missing anchor '{anchor}' in {target}")
    print(f"[links] checked {count} internal links")
    return failures


def run_tutorial_flow() -> list[str]:
    """Execute the getting-started tutorial end to end against the SDK."""
    failures: list[str] = []
    try:
        from authly import AuthenticationError, Authly

        authly = Authly(project_id="proj_demo", api_key="demo_key")

        user = authly.users.create(
            email="alice@example.com",
            name="Alice",
            password="secret",
        )
        assert user.id.startswith("usr_"), "user id prefix"

        session = authly.auth.login(email=user.email, password="secret")
        assert session.active is True, "fresh session must be active"

        try:
            authly.auth.login(email=user.email, password="wrong")
            failures.append("tutorial: wrong password did not raise")
        except AuthenticationError:
            pass

        organization = authly.organizations.create(name="Acme")
        authly.organizations.add_member(
            organization_id=organization.id,
            user_id=user.id,
        )
        assert user.id in organization.member_ids, "membership"

        role = authly.roles.create(
            name="editor",
            permissions={"documents:read", "documents:write"},
        )
        authly.roles.assign(user_id=user.id, role_id=role.id)
        result = authly.permissions.check(
            user_id=user.id,
            permission="documents:write",
        )
        assert result is True, "permission check"
    except Exception as exc:
        failures.append(f"tutorial: {type(exc).__name__}: {exc}")
    else:
        print("[tutorial] full getting-started flow executed")
    return failures


def main() -> int:
    if not DOCS_DIR.is_dir():
        print(f"ERROR: docs directory not found: {DOCS_DIR}")
        return 1

    failures = check_fences()
    failures += check_links()
    failures += run_tutorial_flow()

    if failures:
        print()
        print("FAILURES:")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print()
    print("ALL DOC CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
