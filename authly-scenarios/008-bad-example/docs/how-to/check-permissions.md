# Permissions

Evaluate whether a user has a permission:

```python
authly.permissions.evaluate(
    user_id=user.id,
    permission="documents:write",
)
```

The implementation returns `True` when one of the user's assigned roles contains the requested permission.

Otherwise it raises `AuthorizationError`.
