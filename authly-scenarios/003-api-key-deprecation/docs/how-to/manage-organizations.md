# Manage organizations and members

Use this recipe to create an organization, add users to it, and read it back.

## Prerequisites

- An initialized client ([Configure the client](configure-client.md))
- User IDs for the members you want to add

## Create an organization

```python
organization = authly.organizations.create(name="Acme")

print(organization.id)          # org_2b9d41c7ae
print(organization.member_ids)  # set()
```

## Add a member

```python
organization = authly.organizations.add_member(
    organization_id=organization.id,
    user_id="usr_4f8a2c1b9d",
)

print(sorted(organization.member_ids))  # ['usr_4f8a2c1b9d']
```

`add_member()` returns the updated organization. Membership is stored as a set, so adding the same user twice has no additional effect.

Note that `add_member()` does not verify that the user exists — it records whatever user ID you pass.

## Look up an organization

```python
organization = authly.organizations.get("org_2b9d41c7ae")
```

An unknown organization ID raises `NotFoundError`.

## Membership and organization-scoped authorization

Roles can be scoped to an organization so that permission checks reflect it:

```python
role = authly.roles.create(
    name="acme-editor",
    permissions={"documents:write"},
    organization_id=organization.id,
)
```

A check restricted to an organization only considers roles scoped to that organization plus unscoped roles:

```python
authly.permissions.check(
    user_id=user.id,
    permission="documents:write",
    organization_id=organization.id,
)
```

Membership alone still grants nothing — a user gains permissions only through assigned roles. See [Authorization model](../explanation/authorization-model.md).

## See also

- [Create and assign roles](create-assign-roles.md)
- [Organization data model](../reference/data-models.md#organization)
