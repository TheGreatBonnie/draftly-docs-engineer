from authly import Authly

authly = Authly(
    project_id="proj_demo",
    scoped_token="tok_demo",
)

alice = authly.users.create(
    email="alice@example.com",
    name="Alice",
    password="secret",
)

organization = authly.organizations.create(
    name="Acme",
)

authly.organizations.add_member(
    organization_id=organization.id,
    user_id=alice.id,
)

print("Organization:", organization.name)
print("Members:", organization.member_ids)
