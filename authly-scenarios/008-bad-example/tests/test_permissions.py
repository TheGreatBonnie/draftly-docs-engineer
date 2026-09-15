import pytest

from authly import Authly
from authly.errors import AuthorizationError


def _client_with_user() -> tuple[Authly, object]:
    client = Authly(project_id="proj", api_key="key")
    user = client.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )
    return client, user


def test_check_returns_true_when_role_grants_permission():
    client, user = _client_with_user()
    role = client.roles.create(
        name="editor",
        permissions={"documents:read", "documents:write"},
    )
    client.roles.assign(user_id=user.id, role_id=role.id)

    assert client.permissions.check(user_id=user.id, permission="documents:read") is True
    assert client.permissions.check(user_id=user.id, permission="documents:write") is True


def test_check_raises_when_permission_missing():
    client, user = _client_with_user()
    role = client.roles.create(name="viewer", permissions={"documents:read"})
    client.roles.assign(user_id=user.id, role_id=role.id)

    with pytest.raises(AuthorizationError) as excinfo:
        client.permissions.check(user_id=user.id, permission="documents:delete")

    assert user.id in str(excinfo.value)
    assert "documents:delete" in str(excinfo.value)


def test_check_raises_for_unknown_user():
    client = Authly(project_id="proj", api_key="key")

    with pytest.raises(AuthorizationError):
        client.permissions.check(user_id="usr_unknown", permission="documents:read")


def test_check_is_case_sensitive():
    client, user = _client_with_user()
    role = client.roles.create(name="editor", permissions={"documents:write"})
    client.roles.assign(user_id=user.id, role_id=role.id)

    with pytest.raises(AuthorizationError):
        client.permissions.check(user_id=user.id, permission="documents:Write")


def test_list_for_user_unions_multiple_roles():
    client, user = _client_with_user()
    editor = client.roles.create(name="editor", permissions={"documents:write"})
    auditor = client.roles.create(
        name="auditor",
        permissions={"documents:read", "audit:view"},
    )
    client.roles.assign(user_id=user.id, role_id=editor.id)
    client.roles.assign(user_id=user.id, role_id=auditor.id)

    held = client.permissions.list_for_user(user_id=user.id)

    assert held == {"documents:write", "documents:read", "audit:view"}


def test_list_for_user_returns_empty_set_for_unknown_user():
    client = Authly(project_id="proj", api_key="key")

    assert client.permissions.list_for_user(user_id="usr_unknown") == set()


def test_list_for_user_ignores_unassigned_roles():
    client, user = _client_with_user()
    client.roles.create(name="admin", permissions={"admin:all"})
    client.roles.create(name="none", permissions=set())

    assert client.permissions.list_for_user(user_id=user.id) == set()
