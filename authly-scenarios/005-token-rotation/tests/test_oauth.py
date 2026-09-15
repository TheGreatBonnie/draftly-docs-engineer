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
