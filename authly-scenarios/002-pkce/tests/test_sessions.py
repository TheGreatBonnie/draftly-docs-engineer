from authly import Authly


def test_session_can_be_revoked():
    client = Authly(project_id="proj", api_key="key")
    user = client.users.create(
        email="alice@example.com",
        name="Alice",
        password="secret",
    )

    session = client.sessions.create(user_id=user.id)
    assert session.active is True

    client.sessions.revoke(session.id)

    assert client.sessions.get(session.id).active is False
