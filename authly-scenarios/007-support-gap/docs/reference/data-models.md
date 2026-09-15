# Data models

Services return dataclass instances. All use `slots=True`, expose plain attributes, and carry generated IDs with type-specific prefixes.

## ID prefixes

| Prefix  | Resource      | Format                |
| ------- | ------------- | --------------------- |
| `usr_`  | User          | prefix + 10 hex chars |
| `sess_` | Session       | prefix + 10 hex chars |
| `org_`  | Organization  | prefix + 10 hex chars |
| `role_` | Role          | prefix + 10 hex chars |
| `tok_`  | Token         | prefix + 10 hex chars |

## User

Returned by `users.create()`, `users.get()`, `users.list()`.

| Field       | Type | Notes                                    |
| ----------- | ---- | ---------------------------------------- |
| `id`        | str  | `usr_...`                                |
| `email`     | str  | Validated at creation; may be duplicated across users |
| `name`      | str  | Display name                             |
| `password`  | str  | Stored as provided — benchmark simplification, see [Security notes](../explanation/security.md) |

## Session { #session }

Returned by `auth.login()`, `sessions.create()`, `sessions.get()`, `sessions.revoke()`.

| Field        | Type       | Notes                          |
| ------------ | ---------- | ------------------------------ |
| `id`         | str        | `sess_...`                     |
| `user_id`    | str        | Owning user                    |
| `created_at` | datetime   | UTC timestamp                  |
| `active`     | bool       | Defaults to `True`; `revoke()` sets it to `False` |

## Organization { #organization }

Returned by `organizations.create()`, `organizations.add_member()`, `organizations.get()`.

| Field         | Type      | Notes                                     |
| ------------- | --------- | ----------------------------------------- |
| `id`          | str       | `org_...`                                 |
| `name`        | str       | Organization name                         |
| `member_ids`  | set[str]  | User IDs; mutated in place by `add_member()` |

## Role { #role }

Returned by `roles.create()`, `roles.assign()`, `roles.get()`.

| Field          | Type      | Notes                                        |
| -------------- | --------- | -------------------------------------------- |
| `id`           | str       | `role_...`                                   |
| `name`         | str       | Role name; not used for lookups              |
| `permissions`  | set[str]  | Permission strings such as `documents:write` |
| `assignments`  | set[str]  | User IDs the role is assigned to             |

Because `permissions` and `assignments` are sets, duplicate inserts are no-ops and membership tests are O(1).

## Token

Returned by `tokens.create()`; accepted by `tokens.is_expired()`.

| Field         | Type       | Notes                                  |
| ------------- | ---------- | -------------------------------------- |
| `id`          | str        | `tok_...`                              |
| `user_id`     | str        | Owning user                            |
| `value`       | str        | URL-safe random token string           |
| `expires_at`  | datetime   | UTC; creation time plus `expires_in_seconds` |
| `token_type`  | str        | Always `"access"`                      |

Note that `Token` is exported at the package root (`from authly import Token`); the other models are not.
