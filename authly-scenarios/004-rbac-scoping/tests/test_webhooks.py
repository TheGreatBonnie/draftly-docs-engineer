from authly import Authly


def test_webhook_signature_round_trip():
    client = Authly(project_id="proj", api_key="key")
    payload = {"event": "user.created", "user_id": "usr_123"}
    secret = "webhook_secret"

    signature = client.webhooks.sign(
        payload=payload,
        secret=secret,
    )

    assert client.webhooks.verify(
        payload=payload,
        signature=signature,
        secret=secret,
    )


def test_tampered_payload_fails_verification():
    client = Authly(project_id="proj", api_key="key")
    payload = {"event": "user.created"}
    signature = client.webhooks.sign(
        payload=payload,
        secret="secret",
    )

    assert not client.webhooks.verify(
        payload={"event": "user.deleted"},
        signature=signature,
        secret="secret",
    )
