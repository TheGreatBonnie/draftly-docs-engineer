# Create and revoke sessions

Use this recipe to manage sessions directly: create one for an existing user, look it up, and revoke it.

## Prerequisites

- An initialized client ([Configure the client](configure-client.md))
- A user ID (sessions belong to a user)

## Create a session

`auth.login()` creates sessions as a side effect of a password login. You can also create one directly for a user who already exists:

```python
session = authly.sessions.create(user_id="usr_4f8a2c1b9d")

print(session.id)        # sess_7d21e5a09c
print(session.active)    # True
print(session.created_at)  # e.g. 2026-08-22 10:15:00+00:00
```

## Look up a session

```python
session = authly.sessions.get("sess_7d21e5a09c")
```

An unknown session ID raises `NotFoundError`.

## Revoke a session

Revoking sets `active` to `False` and returns the updated session:

```python
session = authly.sessions.revoke("sess_7d21e5a09c")

print(session.active)  # False
```

Revoking is idempotent in effect but raises `NotFoundError` if the session does not exist, because `revoke()` performs a `get()` first.

## List nothing, safely

There is no `list()` on the session service. Track session IDs yourself if you need to enumerate them; every returned `Session` object carries its `id`.

## See also

- [Authenticate a user](authenticate-user.md)
- [Session data model](../reference/data-models.md#session)
- [Errors reference](../reference/errors.md)
