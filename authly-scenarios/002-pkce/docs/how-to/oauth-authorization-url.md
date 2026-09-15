# Construct an OAuth authorization URL

Use this recipe to build the URL that sends a user to Authly's OAuth authorization endpoint.

## Prerequisites

- An initialized client ([Configure the client](configure-client.md))

## Build the URL

```python
url = authly.oauth.authorization_url(
    provider="github",
    redirect_uri="https://example.com/callback",
    state="demo-state",
    code_challenge="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
)

print(url)
```

Output (single line):

```text
https://auth.example.test/oauth/authorize?client_id=proj_demo&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&provider=github&state=demo-state&response_type=code&code_challenge=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk&code_challenge_method=S256
```

## Parameters

| Parameter               | Required | Default | Used as                              |
| ----------------------- | -------- | ------- | ------------------------------------ |
| `provider`              | yes      | —       | `provider` query parameter           |
| `redirect_uri`          | yes      | —       | `redirect_uri` query parameter       |
| `state`                 | yes      | —       | `state` query parameter              |
| `code_challenge`        | no       | `None`  | `code_challenge` query parameter     |
| `code_challenge_method` | no       | `S256`  | `code_challenge_method` query param  |

The `client_id` query parameter is filled from `authly.project_id`, and `response_type` is always `code`. When `code_challenge` is provided, PKCE parameters are included in the URL.

## Choose an unpredictable state

The state value is echoed back by the provider after the redirect. Generate it with a random source and verify it on return to protect against CSRF:

```python
from secrets import token_urlsafe

state = token_urlsafe(16)
```

## Generate a code challenge

Create a code verifier and derive the code challenge for PKCE:

```python
import base64
import hashlib
import secrets

# Generate a code verifier (random 32 bytes, base64url encoded)
code_verifier = base64.urlsafe_b64encode(
    secrets.token_bytes(32)
).rstrip(b"=").decode("ascii")

# Derive the code challenge (SHA256 hash, base64url encoded)
code_challenge = base64.urlsafe_b64encode(
    hashlib.sha256(code_verifier.encode()).digest()
).rstrip(b"=").decode("ascii")
```

Store `code_verifier` securely; you will need it to exchange the authorization code for a token.

## Version boundary

Version 0.1 only constructs the URL. There is no callback handling or authorization-code exchange — see [Troubleshoot errors](troubleshoot-errors.md) if you were expecting a token.

## See also

- [OAuthClient API](../reference/api.md#oauthclient)
- [Security notes](../explanation/security.md)
