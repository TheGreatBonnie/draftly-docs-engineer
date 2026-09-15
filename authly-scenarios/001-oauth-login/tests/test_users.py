import pytest

from authly import Authly
from authly.errors import NotFoundError, ValidationError


def test_create_and_get_user():
    client = Authly(project_id="proj", api_key="key")
    user = client.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )

    assert client.users.get(user.id).email == "alice@example.com"


def test_invalid_email_is_rejected():
    client = Authly(project_id="proj", api_key="key")

    with pytest.raises(ValidationError):
        client.users.create(
            email="invalid",
            name="Alice",
            password="secret",
        )


def test_missing_user_raises():
    client = Authly(project_id="proj", api_key="key")

    with pytest.raises(NotFoundError):
        client.users.get("usr_missing")
