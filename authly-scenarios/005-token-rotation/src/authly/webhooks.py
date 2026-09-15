"""Webhook signing helpers."""

import hashlib
import hmac
import json


class WebhookService:
    def __init__(self, client):
        self.client = client

    @staticmethod
    def sign(*, payload: dict, secret: str) -> str:
        body = json.dumps(
            payload,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()

        return hmac.new(
            secret.encode(),
            body,
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def verify(
        *,
        payload: dict,
        signature: str,
        secret: str,
    ) -> bool:
        expected = WebhookService.sign(
            payload=payload,
            secret=secret,
        )
        return hmac.compare_digest(expected, signature)
