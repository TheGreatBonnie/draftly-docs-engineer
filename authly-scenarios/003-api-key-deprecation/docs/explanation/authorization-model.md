# Authorization model

This page explains how Authly decides whether a user may do something. For the step-by-step recipes, see [Create and assign roles](../how-to/create-assign-roles.md) and [Check user permissions](../how-to/check-permissions.md).

## The three building blocks

Authorization in Authly has exactly three concepts:

1. **Permissions** — free-form strings, conventionally `resource:action` (for example `documents:write`). They exist only inside roles; there is no global permission registry.
2. **Roles** — named bundles of permissions. A role owns two sets: `permissions` and `assignments`.
3. **Assignment** — a user ID placed in a role's `assignments` set by `roles.assign()`.

```text
User ──(assigned to)──▶ Role ──(contains)──▶ Permission strings
```

## How a check resolves

`permissions.check(user_id, permission)` answers one question: *does any role that lists this user among its assignments contain this exact permission string?*

The algorithm is:

1. Collect every role whose `assignments` contains the user ID.
2. If any of those roles' `permissions` contains the exact string, return `True`.
3. Otherwise raise `AuthorizationError`.

When `organization_id` is supplied to the check, step 1 only collects roles scoped to that organization (through `role.organization_id`) plus unscoped roles. Roles scoped to a different organization are skipped even when the user holds them.

Consequences worth internalizing:

- **Checks never return `False`.** Absence of permission is always an exception.
- **Unknown users fail checks.** A user ID with no role assignments — including one that was never created — raises `AuthorizationError`, not `NotFoundError`.
- **Matching is exact.** Permission strings are case-sensitive and compared literally; `documents:Write` does not satisfy `documents:write`.
- **Roles don't inherit.** There is no role hierarchy and no wildcard matching.

## What organizations do

Organizations group users into `member_ids` and participate in authorization through **organization-scoped roles**. A role created with an `organization_id` is scoped to that organization; a role created without one is unscoped and, as before, applies in every context.

A permission check restricted to an organization only considers:

1. roles scoped to that organization (`role.organization_id == organization_id`), and
2. unscoped roles (`role.organization_id is None`).

Roles scoped to any other organization are ignored for that scope. Checks without `organization_id` continue to consider every role the user holds, so existing code keeps working.

Membership alone still grants nothing — a user gains permissions only through assigned roles — but roles can now be scoped per organization instead of relying on manual naming conventions.

## Why so simple?

Authly's purpose is to exercise documentation workflows against a realistic-but-small API. The flat role model covers the common RBAC vocabulary — grant, assign, check, list — without hiding the mechanics behind policy engines. Every question about *why* a check passed can be answered by inspecting two sets on a `Role`.

## See also

- [PermissionService API](../reference/api.md#permissionservice)
- [Role data model](../reference/data-models.md#role)
