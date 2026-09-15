import pytest
from datetime import datetime, timedelta, timezone

from authly import Authly, Token
from authly.errors import ValidationError


def _client() -> Authly:
    return Authly(project_id="proj", api_key="key")


def test_create_returns_token_with_defaults():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")
    before = datetime.now(timezone.utc)

    token = client.tokens.create(user_id=user.id)

    assert isinstance(token, Token)
    assert token.id.startswith("tok_")
    assert len(token.id) == 14
    assert token.user_id == user.id
    assert token.value
    assert token.token_type == "access"
    delta = token.expires_at - before
    assert timedelta(seconds=3595) < delta <= timedelta(seconds=3601)


def test_create_respects_custom_expiry():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")
    before = datetime.now(timezone.utc)

    token = client.tokens.create(user_id=user.id, expires_in_seconds=60)

    delta = token.expires_at - before
    assert timedelta(seconds=55) < delta <= timedelta(seconds=65)


def test_is_expired_false_for_fresh_token():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")

    token = client.tokens.create(user_id=user.id)

    assert client.tokens.is_expired(token) is False


def test_is_expired_true_for_past_expiry():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")

    token = client.tokens.create(user_id=user.id, expires_in_seconds=-10)

    assert client.tokens.is_expired(token) is True


def test_expiry_boundary_counts_current_time_as_expired():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")

    token = client.tokens.create(user_id=user.id)
    token.expires_at = datetime.now(timezone.utc) - timedelta(microseconds=1)

    assert client.tokens.is_expired(token) is True


def test_create_refresh_returns_rotating_credential():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")

    token = client.tokens.create_refresh(user_id=user.id)

    assert token.token_type == "refresh"
    assert token.rotated_from is None
    assert token.revoked is False


def test_refresh_issues_successor_and_revokes_predecessor():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")
    original = client.tokens.create_refresh(user_id=user.id)

    successor = client.tokens.refresh(token=original)

    assert successor.token_type == "refresh"
    assert successor.rotated_from == original.id
    assert successor.value != original.value
    assert original.revoked is True


def test_refresh_of_rotated_token_is_rejected():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")
    original = client.tokens.create_refresh(user_id=user.id)
    client.tokens.refresh(token=original)

    with pytest.raises(ValidationError, match="already been rotated"):
        client.tokens.refresh(token=original)


def test_refresh_rejects_access_tokens():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")
    access = client.tokens.create(user_id=user.id)

    with pytest.raises(ValidationError, match="only refresh tokens"):
        client.tokens.refresh(token=access)


def test_refresh_rejects_expired_refresh_token():
    client = _client()
    user = client.users.create(email="a@b.co", name="A", password="secret")
    token = client.tokens.create_refresh(user_id=user.id, expires_in_seconds=-10)

    with pytest.raises(ValidationError, match="expired"):
        client.tokens.refresh(token=token)
