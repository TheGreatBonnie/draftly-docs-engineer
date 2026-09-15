import base64
import hashlib
import secrets

from authly import Authly

authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
)

# Generate PKCE code verifier and challenge
code_verifier = base64.urlsafe_b64encode(
    secrets.token_bytes(32)
).rstrip(b"=").decode("ascii")

code_challenge = base64.urlsafe_b64encode(
    hashlib.sha256(code_verifier.encode()).digest()
).rstrip(b"=").decode("ascii")

url = authly.oauth.authorization_url(
    provider="github",
    redirect_uri="https://example.com/callback",
    state="demo-state",
    code_challenge=code_challenge,
)

print("Open this URL:", url)
print("Store this code_verifier for token exchange:", code_verifier)
