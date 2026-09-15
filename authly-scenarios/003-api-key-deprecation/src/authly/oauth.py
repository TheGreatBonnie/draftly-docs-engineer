"""OAuth authorization code flow.

Authorization URL construction and authorization-code exchange are
supported as of v2.0.0. PKCE is reserved for later simulation scenarios.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from urllib.parse import urlencode
from uuid import uuid4

from .tokens import Token


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

    def exchange_code(self, *, code: str, user_id: str = "") -> Token:
        """Exchange an OAuth authorization code for a scoped access token.

        The token is stored in the client's token store and expired like any
        other ``Token``. The optional ``user_id`` binds it to a user; omit it
        for an application-level token.
        """
        if not code:
            raise ValueError("code is required")

        token = Token(
            id=f"tok_{uuid4().hex[:10]}",
            user_id=user_id,
            value=token_urlsafe(24),
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=3600),
            token_type="access",
        )
        self.client._tokens[token.id] = token
        return token