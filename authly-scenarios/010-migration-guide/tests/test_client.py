import pytest

from authly import Authly


def test_client_raises_for_empty_project_id():
    with pytest.raises(ValueError, match="project_id is required"):
        Authly(project_id="", token="tok")


def test_client_raises_for_missing_token():
    with pytest.raises(ValueError, match="token is required"):
        Authly(project_id="proj")


def test_client_rejects_positional_arguments():
    with pytest.raises(TypeError):
        Authly("proj", "tok")  # type: ignore[misc]


def test_client_emits_deprecation_warning_for_api_key():
    with pytest.warns(DeprecationWarning, match="api_key is deprecated"):
        client = Authly(project_id="proj", api_key="old_key")
    assert client.api_key == "old_key"
    assert client.token is None


def test_client_accepts_token_without_warning():
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        client = Authly(project_id="proj", token="tok_demo")
    assert client.token == "tok_demo"
    assert client.api_key is None


def test_client_exposes_all_service_namespaces():
    client = Authly(project_id="proj", token="tok")

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
    client = Authly(project_id="proj_demo", token="tok_demo")

    assert client.project_id == "proj_demo"
    assert client.token == "tok_demo"


def test_version_matches_pyproject():
    import tomllib
    from pathlib import Path

    import authly

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))

    assert authly.__version__ == data["project"]["version"]
