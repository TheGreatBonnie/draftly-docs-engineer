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

## Version boundary

Version 0.1 only constructs the URL. There is no callback handling, authorization-code exchange, or PKCE support yet — see [Troubleshoot errors](troubleshoot-errors.md) if you were expecting a token.

## See also

- [OAuthClient API](../reference/api.md#oauthclient)
- [Security notes](../explanation/security.md)
