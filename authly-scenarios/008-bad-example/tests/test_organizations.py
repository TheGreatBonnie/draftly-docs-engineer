from authly import Authly
from authly.errors import NotFoundError


def _client_with_user():
    client = Authly(project_id="proj", api_key="key")
    user = client.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )
    return client, user


def test_create_returns_organization_with_empty_membership():
    client = Authly(project_id="proj", api_key="key")

    org = client.organizations.create(name="Acme")

    assert org.id.startswith("org_")
    assert len(org.id) == 14
    assert org.name == "Acme"
    assert org.member_ids == set()


def test_get_returns_created_organization():
    client = Authly(project_id="proj", api_key="key")
    created = client.organizations.create(name="Acme")

    fetched = client.organizations.get(created.id)

    assert fetched is created


def test_get_unknown_organization_raises_not_found():
    client = Authly(project_id="proj", api_key="key")

    try:
        client.organizations.get("org_missing")
        raise AssertionError("expected NotFoundError")
    except NotFoundError as exc:
        assert "org_missing" in str(exc)


def test_add_member_adds_user_and_returns_same_organization():
    client, user = _client_with_user()
    org = client.organizations.create(name="Acme")

    updated = client.organizations.add_member(
        organization_id=org.id,
        user_id=user.id,
    )

    assert updated is org
    assert org.member_ids == {user.id}


def test_add_member_is_idempotent():
    client, user = _client_with_user()
    org = client.organizations.create(name="Acme")

    client.organizations.add_member(organization_id=org.id, user_id=user.id)
    client.organizations.add_member(organization_id=org.id, user_id=user.id)

    assert len(org.member_ids) == 1


def test_add_member_does_not_validate_user_existence():
    client = Authly(project_id="proj", api_key="key")
    org = client.organizations.create(name="Acme")

    updated = client.organizations.add_member(
        organization_id=org.id,
        user_id="usr_ghost",
    )

    assert updated.member_ids == {"usr_ghost"}


def test_add_member_unknown_organization_raises_not_found():
    client = Authly(project_id="proj", api_key="key")

    try:
        client.organizations.add_member(organization_id="org_missing", user_id="usr_1")
        raise AssertionError("expected NotFoundError")
    except NotFoundError as exc:
        assert "org_missing" in str(exc)
