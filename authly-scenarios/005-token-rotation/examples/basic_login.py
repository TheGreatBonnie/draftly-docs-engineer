from authly import Authly

authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
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
