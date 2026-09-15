"""OAuth URL construction.

This initial version intentionally implements only authorization URL
construction. Token exchange and PKCE are reserved for later simulation
scenarios.
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
    ) -> str:
        params = urlencode(
            {
                "client_id": self.client.project_id,
                "redirect_uri": redirect_uri,
                "provider": provider,
                "state": state,
                "response_type": "code",
            }
        )
        return f"https://auth.example.test/oauth/authorize?{params}"
