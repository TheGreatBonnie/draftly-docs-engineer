# API reference

Complete method inventory for every service exposed by the `Authly` client. All keyword-only arguments are marked with `*`. Object shapes are documented in [Data models](data-models.md); exceptions in [Errors](errors.md).

## Authly

```text
Authly(*, project_id: str, api_key: str)
```

Creates the client and all service namespaces. Raises `ValueError` if either argument is empty.

## UserService

`authly.users`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `create` | `(*, email: str, name: str, password: str)` | `User` | `ValidationError` if email is empty or lacks `@`, or password is empty |
| `get` | `(user_id: str)` | `User` | `NotFoundError` for unknown ID |
| `list` | `()` | `list[User]` | — |

Duplicate emails are permitted; only the first matching user is found at login.

## AuthService

`authly.auth`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `login` | `(*, email: str, password: str)` | `Session` | `AuthenticationError` when email/password do not match |

A successful login also stores a new session via `SessionService`.

## SessionService

`authly.sessions`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `create` | `(*, user_id: str)` | `Session` | — |
| `get` | `(session_id: str)` | `Session` | `NotFoundError` for unknown ID |
| `revoke` | `(session_id: str)` | `Session` | `NotFoundError` for unknown ID |

`revoke()` sets `active = False`.

## OrganizationService

`authly.organizations`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `create` | `(*, name: str)` | `Organization` | — |
| `add_member` | `(*, organization_id: str, user_id: str)` | `Organization` | `NotFoundError` for unknown organization ID |
| `get` | `(organization_id: str)` | `Organization` | `NotFoundError` for unknown ID |

`add_member()` does not verify that the user exists.

## RoleService

`authly.roles`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `create` | `(*, name: str, permissions: set[str] \| None = None)` | `Role` | — |
| `assign` | `(*, user_id: str, role_id: str)` | `Role` | `NotFoundError` for unknown role ID |
| `get` | `(role_id: str)` | `Role` | `NotFoundError` for unknown ID |

`assign()` adds the user ID to the role's `assignments` set.

## PermissionService

`authly.permissions`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `check` | `(*, user_id: str, permission: str)` | `bool` | `AuthorizationError` when no assigned role contains the permission |
| `list_for_user` | `(*, user_id: str)` | `set[str]` | — |

`check()` returns `True` or raises; it never returns `False`. Unknown users raise because they hold no roles. `list_for_user()` never raises and returns an empty set for unknown users.

## OAuthClient { #oauthclient }

`authly.oauth`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `authorization_url` | `(*, provider: str, redirect_uri: str, state: str)` | `str` | — |

Builds `https://auth.example.test/oauth/authorize?...` with `client_id` set to `project_id` and `response_type=code`. No token exchange or PKCE in 0.1.

## TokenService

`authly.tokens`

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `create` | `(*, user_id: str, expires_in_seconds: int = 3600)` | `Token` | — |
| `is_expired` | `(token: Token)` | `bool` | — |

Expiry compares `expires_at` against the current UTC time.

## WebhookService { #webhookservice }

`authly.webhooks` — both methods are static and callable on the class.

| Method | Signature | Returns | Raises |
| ------ | --------- | ------- | ------ |
| `sign` | `(*, payload: dict, secret: str)` | `str` | — |
| `verify` | `(*, payload: dict, signature: str, secret: str)` | `bool` | — |

HMAC-SHA256 over canonical JSON (sorted keys, compact separators). `verify()` uses a constant-time comparison.
