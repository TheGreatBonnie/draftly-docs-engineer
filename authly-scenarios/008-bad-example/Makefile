.PHONY: install test lint docs-check run-example clean

install:
	uv sync --extra dev

test:
	uv run pytest

lint:
	uv run ruff check .
	uv run python -m compileall src tests examples scripts

docs-check:
	uv run python scripts/check_docs.py

run-example:
	uv run python examples/basic_login.py

clean:
	rm -rf .pytest_cache .ruff_cache .venv dist build src/*.egg-info
