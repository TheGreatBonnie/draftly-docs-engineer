# Migrate from API-key to token authentication

Authly v0.4.0 deprecates the `api_key` constructor argument in favor of a scoped
`token`. This guide walks through migrating your application.

## Who is affected

Applications that initialize the SDK with `api_key=`:

```python
# OLD — deprecated
authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
)
```

After upgrading you will see a `DeprecationWarning`:

```text
DeprecationWarning: api_key is deprecated and will be removed in v1.0.
Authenticate with token instead. See docs/how-to/migrate-to-token-auth.md
```

## What changed

| Aspect              | v0.1–v0.3                    | v0.4.0+                    |
|---------------------|------------------------------|----------------------------|
| Auth method         | `api_key=str`                | `token=str`                |
| Error on missing    | `ValueError("api_key is required")` | `ValueError("token is required")` |
| Deprecation signal  | None                         | `DeprecationWarning`       |
| Removal target      | —                            | v1.0 (hard error)          |

## Migration steps

### 1. Obtain a scoped token

Generate a scoped token in the Authly dashboard:

1. Go to **Project → API tokens**.
2. Click **Create token**.
3. Scope the token to the minimum permissions your integration needs.
4. Copy the token value (it is shown only once).

### 2. Update initialization

Replace `api_key=` with `token=`:

```python
# NEW — token authentication
authly = Authly(
    project_id="proj_demo",
    token="tok_demo",
)
```

### 3. Update tests

If your tests assert `ValueError("api_key is required")`, update them:

```python
# OLD
with pytest.raises(ValueError, match="api_key is required"):
    Authly(project_id="proj", api_key="")

# NEW
with pytest.raises(ValueError, match="token is required"):
    Authly(project_id="proj")
```

## Rollback

If you must roll back before completing the migration:

1. Pin your Authly version to `<0.4.0` in `pyproject.toml`.
2. Keep using `api_key=` — the deprecated path still works (with a warning)
   through v0.9.

## Validation steps

After migrating, verify:

- No `DeprecationWarning` is emitted at startup.
- All integration tests pass with the new token.
- The `api_key` attribute is no longer referenced in your codebase
  (`grep -r "api_key" .`).

## See also

- [Configure the client](configure-client.md)
- [Errors reference](../reference/errors.md)