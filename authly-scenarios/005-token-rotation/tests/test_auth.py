import pytest

from authly import AuthenticationError, Authly


def client():
    return Authly(project_id="proj_test", api_key="key_test")


def test_login_creates_session():
    authly = client()
    user = authly.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )

    session = authly.auth.login(
        email=user.email,
        password="secret",
    )

    assert session.user_id == user.id
    assert session.active is True


def test_invalid_password_fails():
    authly = client()
    authly.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )

    with pytest.raises(AuthenticationError):
        authly.auth.login(
            email="alice@example.com",
            password="wrong",
        )
