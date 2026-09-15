# Troubleshoot errors

Work through the symptom you are seeing to find the cause and fix.

## Symptom: login fails with `AuthenticationError`

**Cause:** no registered user matches the email, or the password is wrong. The message is always `invalid email or password` and never says which part failed.

**Fix:** confirm the email exists via `authly.users.list()` and retry with that user's password. Remember that only the *first* user created with a given email can match a login.

```python
from authly import AuthenticationError

try:
    authly.auth.login(email="alice@example.com", password="secret")
except AuthenticationError:
    ...
```

## Symptom: permission check raises `AuthorizationError`

**Cause:** none of the roles assigned to the user contains the requested permission string. Permission names must match exactly (`documents:write` ≠ `documents:Write`).

**Fix:** inspect what the user actually holds, then assign a missing role or extend an existing one:

```python
held = authly.permissions.list_for_user(user_id=user.id)
print(sorted(held))
```

Note: this error also appears for unknown user IDs, because an unknown user has no assigned roles.

## Symptom: lookup raises `NotFoundError`

**Cause:** the ID passed to `users.get()`, `sessions.get()`, `sessions.revoke()`, `organizations.get()`, or `roles.get()` does not exist. IDs are generated per client instance and prefixed by type (`usr_`, `sess_`, `org_`, `role_`, `tok_`).

**Fix:** use the object returned when it was created, or check your prefix matches the resource type. All state is in-memory — objects created in another process (or before a restart) are gone.

## Symptom: creating a user raises `ValidationError`

**Cause:** the email is empty or contains no `@`, or the password is empty.

**Fix:** pass a syntactically valid email and a non-empty password.

```text
ValidationError: a valid email is required
ValidationError: password is required
```

## Symptom: initializing the client raises `ValueError`

**Cause:** `project_id` or `api_key` was omitted or empty.

**Fix:** see [Configure the client](configure-client.md).

## Symptom: OAuth flow stops after the redirect

**Cause:** version 0.1 has no callback handling, authorization-code exchange, or PKCE support. `authorization_url()` is the entire OAuth surface.

**Fix:** nothing to fix — the capability is not implemented yet. Track the roadmap in `simulation/roadmap.md`.

## Still stuck?

Check the full [Errors reference](../reference/errors.md), or ask on the benchmark's issue tracker.
