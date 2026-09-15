"""OAuth login.

First-class OAuth support: building authorization URLs *and* exchanging
an authorization code for an access token (with an OAuth-backed login
path on :class:`AuthService`). PKCE is added in a later simulation
scenario.
"""

from dataclasses import dataclass
from hashlib import sha256
from secrets import token_urlsafe
from urllib.parse import urlencode

from .errors import ValidationError
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

    def exchange_code(
        self,
        *,
        provider: str,
        code: str,
        redirect_uri: str,
    ) -> Token:
        """Exchange an OAuth authorization ``code`` for an access token.

        A reproducible identity user is created per ``provider``/``code``
        (keyed by a digest of the code, never the raw code itself) so token
        issuance is deterministic and reversible within a client lifetime.
        The OAuth code is single-purpose: it is not reused as a credential.
        """
        if not provider:
            raise ValidationError("provider is required")
        if not code:
            raise ValidationError("authorization code is required")
        if not redirect_uri:
            raise ValidationError("redirect_uri is required")

        digest = sha256(code.encode("utf-8")).hexdigest()[:12]
        email = f"{provider}:{digest}@oauth.example.test"
        user = next(
            (u for u in self.client._users.values() if u.email == email),
            None,
        )
        if user is None:
            user = self.client.users.create(
                email=email,
                name=provider.capitalize(),
                password=token_urlsafe(24),
            )

        return self.client.tokens.create(user_id=user.id)
