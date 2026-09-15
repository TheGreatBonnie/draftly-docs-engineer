import pytest

from authly import Authly, Token
from authly.errors import ValidationError


def test_oauth_authorization_url_contains_required_parameters():
    client = Authly(project_id="proj_demo", api_key="key")

    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="https://app.example.com/callback",
        state="state123",
    )

    assert "client_id=proj_demo" in url
    assert "provider=github" in url
    assert "state=state123" in url
    assert "response_type=code" in url


def test_oauth_exchange_code_returns_access_token():
    client = Authly(project_id="proj_demo", api_key="key")

    token = client.oauth.exchange_code(
        provider="github",
        code="auth_code_123",
        redirect_uri="https://app.example.com/callback",
    )

    assert isinstance(token, Token)
    assert token.token_type == "access"
    assert token.user_id in client._users


def test_oauth_exchange_code_creates_oauth_identity_user():
    client = Authly(project_id="proj_demo", api_key="key")

    token = client.oauth.exchange_code(
        provider="github",
        code="auth_code_123",
        redirect_uri="https://app.example.com/callback",
    )
    user = client.users.get(token.user_id)

    assert user.email.startswith("github:")
    assert user.email.endswith("@oauth.example.test")
    assert "auth_code_123" not in user.email


def test_oauth_exchange_code_does_not_reuse_code_as_password():
    client = Authly(project_id="proj_demo", api_key="key")

    token = client.oauth.exchange_code(
        provider="github",
        code="auth_code_123",
        redirect_uri="https://app.example.com/callback",
    )
    user = client.users.get(token.user_id)

    assert user.password != "auth_code_123"


def test_oauth_exchange_code_rejects_empty_code():
    client = Authly(project_id="proj_demo", api_key="key")

    with pytest.raises(ValidationError, match="authorization code is required"):
        client.oauth.exchange_code(
            provider="github",
            code="",
            redirect_uri="https://app.example.com/callback",
        )


def test_oauth_exchange_code_rejects_missing_redirect_uri():
    client = Authly(project_id="proj_demo", api_key="key")

    with pytest.raises(ValidationError, match="redirect_uri is required"):
        client.oauth.exchange_code(
            provider="github",
            code="auth_code_123",
            redirect_uri="",
        )


def test_oauth_exchange_code_rejects_missing_provider():
    client = Authly(project_id="proj_demo", api_key="key")

    with pytest.raises(ValidationError, match="provider is required"):
        client.oauth.exchange_code(
            provider="",
            code="auth_code_123",
            redirect_uri="https://app.example.com/callback",
        )
