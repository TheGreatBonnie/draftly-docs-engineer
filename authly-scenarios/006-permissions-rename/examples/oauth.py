from authly import Authly

authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
)

url = authly.oauth.authorization_url(
    provider="github",
    redirect_uri="https://example.com/callback",
    state="demo-state",
)

print("Open this URL:", url)
