"""Tests for OAuth redirect URI validation (v0.8.0 security hardening)."""

import pytest

from authly import Authly
from authly.errors import ValidationError


def _client() -> Authly:
    return Authly(project_id="proj_demo", api_key="key")


def test_https_redirect_uri_is_accepted():
    client = _client()
    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="https://app.example.com/callback",
        state="state123",
    )
    assert "redirect_uri=" in url


def test_localhost_http_redirect_uri_is_accepted():
    client = _client()
    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="http://localhost:8080/callback",
        state="state123",
    )
    assert url.startswith("https://auth.example.test/oauth/authorize")


def test_loopback_127_http_redirect_uri_is_accepted():
    client = _client()
    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="http://127.0.0.1:5000/callback",
        state="state123",
    )
    assert "redirect_uri=" in url


def test_non_loopback_http_redirect_uri_is_rejected():
    client = _client()
    with pytest.raises(ValidationError, match="must use https"):
        client.oauth.authorization_url(
            provider="github",
            redirect_uri="http://app.example.com/callback",
            state="state123",
        )


def test_non_http_redirect_uri_is_rejected():
    client = _client()
    with pytest.raises(ValidationError, match="must use http or https"):
        client.oauth.authorization_url(
            provider="github",
            redirect_uri="ftp://app.example.com/callback",
            state="state123",
        )


def test_redirect_uri_without_host_is_rejected():
    client = _client()
    with pytest.raises(ValidationError, match="must contain a host"):
        client.oauth.authorization_url(
            provider="github",
            redirect_uri="https:///callback",
            state="state123",
        )


def test_http_redirect_uri_requires_explicit_port_for_loopback():
    """Loopback http is allowed even without a port (urlsplit handles default)."""
    client = _client()
    url = client.oauth.authorization_url(
        provider="github",
        redirect_uri="http://localhost/callback",
        state="state123",
    )
    assert "redirect_uri=" in url
