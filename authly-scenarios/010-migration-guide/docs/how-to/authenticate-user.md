# Authenticate a user

Use this recipe to log a user in with email and password and obtain a session.

## Prerequisites

- An initialized client ([Configure the client](configure-client.md))
- A user created with `authly.users.create()`

## Log in

```python
session = authly.auth.login(
    email="alice@example.com",
    password="secret",
)

print(session.id)      # sess_7d21e5a09c
print(session.user_id) # usr_4f8a2c1b9d
print(session.active)  # True
```

A successful login creates a new session owned by the matching user.

## Handle failed logins

An unknown email or a wrong password raises `AuthenticationError` with the message `invalid email or password`. The error does not reveal which of the two was wrong:

```python
from authly import AuthenticationError

try:
    authly.auth.login(email="alice@example.com", password="oops")
except AuthenticationError as exc:
    print(f"login failed: {exc}")
```

## Email lookup behavior

`login()` matches against the first user registered with that email address. Creating two users with the same email is allowed, but only the first one can ever match a login. Avoid duplicate emails.

## Revoke the session later

Revoking sets `active` to `False`; see [Create and revoke sessions](manage-sessions.md).

## See also

- [Sessions data model](../reference/data-models.md)
- [Troubleshoot errors](troubleshoot-errors.md)
