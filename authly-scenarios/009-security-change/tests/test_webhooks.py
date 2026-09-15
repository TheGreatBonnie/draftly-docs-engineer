"""Tests for webhook signing (v0.8.0 timestamp + v1= replay protection)."""

import time

from authly import Authly
from authly.webhooks import WebhookService

SECRET = "webhook_secret"


def _client() -> Authly:
    return Authly(project_id="proj_demo", api_key="key")


def test_webhook_signature_round_trip():
    client = _client()
    payload = {"event": "user.created", "user_id": "usr_123"}
    signature = client.webhooks.sign(payload=payload, secret=SECRET)
    assert client.webhooks.verify(
        payload=payload, signature=signature, secret=SECRET
    ) is True


def test_sign_returns_v1_scheme():
    client = _client()
    sig = client.webhooks.sign(payload={"event": "test"}, secret=SECRET)
    assert sig.startswith("v1="), f"expected v1= prefix, got {sig!r}"
    # v1=<timestamp>.<hex>
    body = sig[len("v1="):]
    ts_str, _, digest = body.partition(".")
    assert ts_str.isdigit()
    assert len(digest) == 64  # SHA-256 hex


def test_verify_accepts_valid_signature():
    payload = {"event": "user.created", "user_id": "usr_42"}
    now = int(time.time())
    sig = WebhookService.sign(payload=payload, secret=SECRET, timestamp=now)
    assert WebhookService.verify(
        payload=payload, signature=sig, secret=SECRET
    ) is True


def test_verify_rejects_old_hex_signature():
    payload = {"event": "test"}
    # Old-style signature (plain hex, no v1= prefix) — must be rejected
    old_sig = "a" * 64
    assert WebhookService.verify(
        payload=payload, signature=old_sig, secret=SECRET
    ) is False


def test_tampered_payload_fails_verification():
    client = _client()
    payload = {"event": "user.created"}
    signature = client.webhooks.sign(payload=payload, secret=SECRET)
    assert client.webhooks.verify(
        payload={"event": "user.deleted"},
        signature=signature,
        secret=SECRET,
    ) is False


def test_verify_rejects_wrong_secret():
    payload = {"event": "test"}
    now = int(time.time())
    sig = WebhookService.sign(payload=payload, secret=SECRET, timestamp=now)
    assert WebhookService.verify(
        payload=payload, signature=sig, secret="wrong_secret"
    ) is False


def test_verify_rejects_replay_beyond_tolerance():
    old_ts = int(time.time()) - 3600  # one hour ago
    sig = WebhookService.sign(
        payload={"event": "test"}, secret=SECRET, timestamp=old_ts
    )
    assert WebhookService.verify(
        payload={"event": "test"},
        signature=sig,
        secret=SECRET,
        max_age_seconds=300,
    ) is False


def test_verify_accepts_recent_timestamp():
    recent_ts = int(time.time())
    sig = WebhookService.sign(
        payload={"event": "test"}, secret=SECRET, timestamp=recent_ts
    )
    assert WebhookService.verify(
        payload={"event": "test"},
        signature=sig,
        secret=SECRET,
        max_age_seconds=300,
    ) is True


def test_sign_is_reproducible_with_explicit_timestamp():
    payload = {"b": 1, "a": 2}
    sig_a = WebhookService.sign(payload=payload, secret=SECRET, timestamp=1000)
    sig_b = WebhookService.sign(payload=payload, secret=SECRET, timestamp=1000)
    assert sig_a == sig_b


def test_sign_differs_with_different_timestamps():
    payload = {"event": "test"}
    sig_a = WebhookService.sign(payload=payload, secret=SECRET, timestamp=1000)
    sig_b = WebhookService.sign(payload=payload, secret=SECRET, timestamp=2000)
    assert sig_a != sig_b
