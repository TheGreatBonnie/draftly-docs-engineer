# Create and assign roles

Use this recipe to define a role with a set of permissions and assign it to a user so that permission checks pass.

## Prerequisites

- An initialized client ([Configure the client](configure-client.md))
- A user ID to assign the role to

## Create a role

Permissions are free-form strings. The convention used across Authly docs is `resource:action`:

```python
role = authly.roles.create(
    name="editor",
    permissions={"documents:read", "documents:write"},
)

print(role.id)  # role_5c8f0a3d71
```

The `permissions` argument is optional; omit it to create an empty role:

```python
role = authly.roles.create(name="viewer")
```

## Assign the role to a user

```python
role = authly.roles.assign(
    user_id="usr_4f8a2c1b9d",
    role_id=role.id,
)

print(role.assignments)  # {'usr_4f8a2c1b9d'}
```

Assignments are stored as a set of user IDs on the role, so assigning twice has no additional effect. One role can be assigned to many users.

## Look up a role

```python
role = authly.roles.get("role_5c8f0a3d71")
```

An unknown role ID raises `NotFoundError`. There is no lookup by role name.

## Verify the assignment worked

Check a permission the role contains:

```python
authly.permissions.check(
    user_id="usr_4f8a2c1b9d",
    permission="documents:read",  # True
)
```

See [Check user permissions](check-permissions.md).

## See also

- [Role data model](../reference/data-models.md#role)
- [Authorization model](../explanation/authorization-model.md)
