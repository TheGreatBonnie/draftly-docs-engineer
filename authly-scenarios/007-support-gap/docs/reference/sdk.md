# SDK overview

Authly ships as a single Python package, `authly`, requiring Python 3.11 or newer. It is an in-memory SDK: all state lives on the client instance and disappears when the process exits.

## Installation

```bash
pip install -e .
```

or, from the repository root:

```bash
uv sync
```

The installed version is available as `authly.__version__` (`0.1.0`).

## Client constructor

```python
from authly import Authly

authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
)
```

| Parameter    | Type | Required | Notes                                        |
| ------------ | ---- | -------- | -------------------------------------------- |
| `project_id` | str  | yes      | Empty value raises `ValueError`.             |
| `api_key`    | str  | yes      | Empty value raises `ValueError`.             |

Both parameters are keyword-only.

## Service namespaces

Every service is instantiated by the client and reachable as an attribute:

| Attribute            | Service              | Purpose                                  |
| -------------------- | -------------------- | ---------------------------------------- |
| `authly.users`       | `UserService`        | Create and look up users                 |
| `authly.auth`        | `AuthService`        | Password login                           |
| `authly.sessions`    | `SessionService`     | Create, get, revoke sessions             |
| `authly.organizations` | `OrganizationService` | Organizations and membership          |
| `authly.roles`       | `RoleService`        | Roles, permissions, assignments          |
| `authly.permissions` | `PermissionService`  | Permission checks                        |
| `authly.oauth`       | `OAuthClient`        | Authorization URL construction           |
| `authly.tokens`      | `TokenService`       | Token primitives                         |
| `authly.webhooks`    | `WebhookService`     | HMAC signing and verification            |

Method-level detail: [API reference](api.md). Returned object shapes: [Data models](data-models.md).

## Top-level exports

```python
from authly import (
    Authly,
    AuthlyError,
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    ValidationError,
    OAuthClient,
    Token,
)
```

## Design notes

- The client is deliberately not an HTTP client; there is no network I/O.
- The in-memory store keeps the benchmark deterministic and easy to test.
- The CLI entry point `authly` is registered on install — see [CLI](cli.md).
