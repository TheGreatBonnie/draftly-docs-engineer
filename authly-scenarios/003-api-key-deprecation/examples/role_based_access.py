from authly import Authly

authly = Authly(
    project_id="proj_demo",
    scoped_token="tok_demo",
)

user = authly.users.create(
    email="alice@example.com",
    name="Alice",
    password="secret",
)

editor = authly.roles.create(
    name="editor",
    permissions={"documents:read", "documents:write"},
)

authly.roles.assign(
    user_id=user.id,
    role_id=editor.id,
)

allowed = authly.permissions.check(
    user_id=user.id,
    permission="documents:write",
)

print("Can write documents:", allowed)
