# Permissions

Check whether a user has a permission:

```python
authly.permissions.check(
    user_id=user.id,
    permission="documents:write",
)
```

The initial implementation returns `True` when one of the user's assigned roles contains the requested permission.

Otherwise it raises `AuthorizationError`.

## Scoping a check to an organization

Pass `organization_id` to restrict the check to roles scoped to that organization plus unscoped roles. Roles scoped to a different organization are ignored for that scope:

```python
authly.permissions.check(
    user_id=user.id,
    permission="documents:write",
    organization_id="org_2b9d41c7ae",
)
```
