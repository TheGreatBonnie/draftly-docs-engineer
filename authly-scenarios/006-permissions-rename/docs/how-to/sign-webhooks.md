# Sign and verify webhook payloads

Use this recipe to produce an HMAC signature for a webhook payload and to verify payloads you receive.

## Prerequisites

- An initialized client ([Configure the client](configure-client.md))
- A shared webhook secret agreed with the receiver

## Sign a payload

```python
payload = {
    "event": "user.created",
    "user_id": "usr_123",
}

signature = authly.webhooks.sign(
    payload=payload,
    secret="webhook_secret",
)

print(signature)  # 64-character hex string
```

## Verify a received payload

```python
valid = authly.webhooks.verify(
    payload=payload,
    signature=signature,
    secret="webhook_secret",
)

print(valid)  # True
```

`verify()` recomputes the expected signature and compares it in constant time. A modified payload, wrong secret, or truncated signature returns `False`; it never raises on mismatch.

## Signature reproducibility

The signature is HMAC-SHA256 over a canonical JSON encoding of the payload: keys sorted alphabetically, `,`/`:` separators without extra spaces. Two semantically equal dictionaries therefore produce identical signatures regardless of insertion order:

```python
a = authly.webhooks.sign(payload={"b": 1, "a": 2}, secret="s")
b = authly.webhooks.sign(payload={"a": 2, "b": 1}, secret="s")
assert a == b
```

A receiver that re-canonicalizes the raw JSON body this way can reproduce the signature without the SDK.

## Keep secrets out of source control

Store webhook secrets in environment variables or a secrets manager. See [Security notes](../explanation/security.md).

## See also

- [WebhookService API](../reference/api.md#webhookservice)
