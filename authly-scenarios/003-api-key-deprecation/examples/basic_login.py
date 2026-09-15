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

session = authly.auth.login(
    email=user.email,
    password="secret",
)

print("User:", user.id)
print("Session:", session.id)
