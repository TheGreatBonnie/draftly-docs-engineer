from authly import Authly


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


def test_oauth_authorization_url_without_pkce_omits_challenge_parameters():
    client = Authly(project_id="proj_demo", api_key="key")

    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="https://app.example.com/callback",
        state="state123",
    )

    assert "code_challenge" not in url
    assert "code_challenge_method" not in url


def test_oauth_authorization_url_includes_pkce_parameters():
    client = Authly(project_id="proj_demo", api_key="key")

    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="https://app.example.com/callback",
        state="state123",
        code_challenge="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    )

    assert "code_challenge=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" in url
    assert "code_challenge_method=S256" in url


def test_oauth_authorization_url_supports_plain_pkce_method():
    client = Authly(project_id="proj_demo", api_key="key")

    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="https://app.example.com/callback",
        state="state123",
        code_challenge="dBjftJeZ4CVP",
        code_challenge_method="plain",
    )

    assert "code_challenge=dBjftJeZ4CVP" in url
    assert "code_challenge_method=plain" in url
