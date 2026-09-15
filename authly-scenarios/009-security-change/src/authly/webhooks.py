"""Webhook signing helpers (v0.8.0 replay protection).

Signing now includes a Unix timestamp so receivers can refuse payloads
older than a configurable tolerance.  The signature uses the
``v1=<timestamp>.<hex>`` scheme so future signing versions can coexist.
"""

import hashlib
import hmac
import json
import time


class WebhookService:
    def __init__(self, client):
        self.client = client

    @staticmethod
    def sign(
        *,
        payload: dict,
        secret: str,
        timestamp: int | None = None,
    ) -> str:
        """Return a ``v1=<timestamp>.<hex>`` signature for *payload*.

        The HMAC covers ``{timestamp}.{canonical_json}`` so a receiver
        can verify the timestamp was issued by the signer and reject
        replays beyond a tolerance window.
        """
        if timestamp is None:
            timestamp = int(time.time())

        body = json.dumps(
            payload,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()

        signed_payload = f"{timestamp}.{body.decode()}".encode()
        digest = hmac.new(
            secret.encode(),
            signed_payload,
            hashlib.sha256,
        ).hexdigest()
        return f"v1={timestamp}.{digest}"

    @staticmethod
    def verify(
        *,
        payload: dict,
        signature: str,
        secret: str,
        max_age_seconds: int = 300,
    ) -> bool:
        """Verify a ``v1=`` signature and reject replays beyond tolerance.

        Returns ``False`` (never raises) for malformed signatures, wrong
        secrets, or replay attempts outside the age window.
        """
        if not signature.startswith("v1="):
            return False

        _, _, rest = signature.partition("v1=")
        try:
            timestamp_str, _, provided = rest.partition(".")
            timestamp = int(timestamp_str)
        except ValueError:
            return False

        # Recompute the expected digest using the embedded timestamp
        body = json.dumps(
            payload,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        signed_payload = f"{timestamp}.{body.decode()}".encode()
        expected_digest = hmac.new(
            secret.encode(),
            signed_payload,
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected_digest, provided):
            return False

        now = int(time.time())
        if abs(now - timestamp) > max_age_seconds:
            return False

        return True
