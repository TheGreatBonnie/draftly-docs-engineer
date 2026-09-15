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

## Membership is not authorization

In version 0.1, being a member of an organization grants no permissions. Authorization comes only from roles assigned through `authly.roles.assign()`. See [Authorization model](../explanation/authorization-model.md).

## See also

- [Create and assign roles](create-assign-roles.md)
- [Organization data model](../reference/data-models.md#organization)
