import pytest

from authly import Authly


def test_client_raises_for_empty_project_id():
    with pytest.raises(ValueError, match="project_id is required"):
        Authly(project_id="", api_key="key")


def test_client_raises_for_missing_api_key():
    with pytest.raises(ValueError, match="api_key is required"):
        Authly(project_id="proj", api_key="")


def test_client_rejects_positional_arguments():
    with pytest.raises(TypeError):
        Authly("proj", "key")  # type: ignore[misc]


def test_client_exposes_all_service_namespaces():
    client = Authly(project_id="proj", api_key="key")

    assert client.users is not None
    assert client.auth is not None
    assert client.sessions is not None
    assert client.organizations is not None
    assert client.roles is not None
    assert client.permissions is not None
    assert client.oauth is not None
    assert client.tokens is not None
    assert client.webhooks is not None


def test_client_stores_configuration():
    client = Authly(project_id="proj_demo", api_key="demo_key")

    assert client.project_id == "proj_demo"
    assert client.api_key == "demo_key"


def test_version_matches_pyproject():
    import tomllib
    from pathlib import Path

    import authly

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))

    assert authly.__version__ == data["project"]["version"]
