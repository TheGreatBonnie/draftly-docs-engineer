"""OAuth URL construction.

This version implements authorization URL construction with PKCE
(code_challenge / code_challenge_method) support. Token exchange remains
reserved for later simulation scenarios.
"""

from dataclasses import dataclass
from urllib.parse import urlencode


@dataclass(slots=True)
class OAuthClient:
    client: object

    def authorization_url(
        self,
        *,
        provider: str,
        redirect_uri: str,
        state: str,
        code_challenge: str | None = None,
        code_challenge_method: str = "S256",
    ) -> str:
        params: dict[str, str] = {
            "client_id": self.client.project_id,
            "redirect_uri": redirect_uri,
            "provider": provider,
            "state": state,
            "response_type": "code",
        }
        if code_challenge:
            params["code_challenge"] = code_challenge
            params["code_challenge_method"] = code_challenge_method
        return f"https://auth.example.test/oauth/authorize?{urlencode(params)}"
