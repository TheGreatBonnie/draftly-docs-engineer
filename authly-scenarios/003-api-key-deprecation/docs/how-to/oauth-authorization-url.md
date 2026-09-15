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
)

print(url)
```

Output (single line):

```text
https://auth.example.test/oauth/authorize?client_id=proj_demo&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&provider=github&state=demo-state&response_type=code
```

## Parameters

| Parameter      | Required | Used as                              |
| -------------- | -------- | ------------------------------------ |
| `provider`     | yes      | `provider` query parameter           |
| `redirect_uri` | yes      | `redirect_uri` query parameter       |
| `state`        | yes      | `state` query parameter              |

The `client_id` query parameter is filled from `authly.project_id`, and `response_type` is always `code`.

## Choose an unpredictable state

The state value is echoed back by the provider after the redirect. Generate it with a random source and verify it on return to protect against CSRF:

```python
from secrets import token_urlsafe

state = token_urlsafe(16)
```

## Exchange the code for an access token

After the provider redirects back with a `code`, exchange it for an access token:

```python
token = authly.oauth.exchange_code(code="authcode123")
```

`exchange_code()` returns an access `Token` (see [Data models](../reference/data-models.md#token)). Call it with the exact code from the redirect; an empty code raises `ValueError`.

## Version boundary

Authorization URL construction and authorization-code exchange are supported as of v2.0.0. PKCE is still on the roadmap — see [Troubleshoot errors](troubleshoot-errors.md) if you were expecting PKCE.

## See also

- [OAuthClient API](../reference/api.md#oauthclient)
- [Security notes](../explanation/security.md)
