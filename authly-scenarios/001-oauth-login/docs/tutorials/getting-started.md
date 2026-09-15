# Getting started

This tutorial walks through a complete Authly workflow: installing the SDK, creating a user, authenticating them, organizing them into an organization, granting a role, and checking a permission. It takes about ten minutes.

By the end you will have verified that a user can perform an action guarded by a permission.

## Prerequisites

- Python 3.11 or newer
- The Authly repository checked out locally

## 1. Install the SDK

From the repository root:

```bash
uv sync
```

Or install in editable mode:

```bash
pip install -e .
```

Verify the installation:

```bash
python -c "import authly; print(authly.__version__)"
```

You should see:

```text
0.1.0
```

## 2. Initialize the client

Every call goes through an `Authly` client. Both arguments are required:

```python
from authly import Authly

authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
)
```

## 3. Create a user

```python
user = authly.users.create(
    email="alice@example.com",
    name="Alice",
    password="secret",
)

print(user.id)
```

The ID is prefixed with `usr_`, for example `usr_4f8a2c1b9d`. The client keeps all state in memory, so nothing persists after the process exits.

## 4. Authenticate

Log in with the email and password you just registered:

```python
session = authly.auth.login(
    email=user.email,
    password="secret",
)

print(session.id)
print(session.active)
```

Expected output:

```text
sess_7d21e5a09c
True
```

A wrong email or password raises `AuthenticationError`.

## 5. Create an organization

Organizations group users:

```python
organization = authly.organizations.create(name="Acme")

authly.organizations.add_member(
    organization_id=organization.id,
    user_id=user.id,
)

print(sorted(organization.member_ids))
```

The member list now contains Alice's user ID.

## 6. Grant a role

Roles bundle permissions. Create one and assign it to Alice:

```python
role = authly.roles.create(
    name="editor",
    permissions={"documents:read", "documents:write"},
)

authly.roles.assign(
    user_id=user.id,
    role_id=role.id,
)
```

## 7. Check a permission

Now verify that Alice holds a permission from her role:

```python
result = authly.permissions.check(
    user_id=user.id,
    permission="documents:write",
)

print(result)
```

Expected output:

```text
True
```

Checking a permission that none of Alice's roles contain raises `AuthorizationError`.

## Next steps

- Configure the client in your own project: [Configure the client](../how-to/configure-client.md)
- Handle login failures deliberately: [Authenticate a user](../how-to/authenticate-user.md)
- Browse every available method: [API reference](../reference/api.md)
