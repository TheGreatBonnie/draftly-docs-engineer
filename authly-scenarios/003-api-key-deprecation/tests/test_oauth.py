import pytest

from authly import Authly


def test_oauth_authorization_url_contains_required_parameters():
    client = Authly(project_id="proj_demo", scoped_token="tok")

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
    client = Authly(project_id="proj_demo", scoped_token="tok")

    token = client.oauth.exchange_code(code="authcode123")

    assert token.token_type == "access"
    assert token.value
    assert token.id in client._tokens


def test_oauth_exchange_code_rejects_empty_code():
    client = Authly(project_id="proj_demo", scoped_token="tok")

    with pytest.raises(ValueError, match="code is required"):
        client.oauth.exchange_code(code="")