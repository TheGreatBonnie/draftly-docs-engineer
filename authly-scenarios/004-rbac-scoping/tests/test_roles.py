import pytest

from authly import Authly
from authly.errors import AuthorizationError


def test_role_grants_permission():
    client = Authly(project_id="proj", api_key="key")
    user = client.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )

    role = client.roles.create(
        name="editor",
        permissions={"documents:read", "documents:write"},
    )
    client.roles.assign(user_id=user.id, role_id=role.id)

    assert client.permissions.check(
        user_id=user.id,
        permission="documents:write",
    )


def test_missing_permission_is_rejected():
    client = Authly(project_id="proj", api_key="key")
    user = client.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )

    with pytest.raises(AuthorizationError):
        client.permissions.check(
            user_id=user.id,
            permission="documents:write",
        )


def test_create_role_can_be_organization_scoped():
    client = Authly(project_id="proj", api_key="key")
    role = client.roles.create(
        name="editor",
        permissions={"documents:write"},
        organization_id="org_1",
    )
    assert role.organization_id == "org_1"
