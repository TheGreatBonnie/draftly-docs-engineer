"""OAuth URL construction (v0.8.0 security hardening).

Redirect URIs are validated at URL-construction time: production
URIs must use ``https`` (localhost loopback may use ``http``).

Webhook payload signing now includes a timestamp and a ``v1=``
scheme prefix to prevent replay attacks — see ``webhooks.py``.
"""

from dataclasses import dataclass
from urllib.parse import urlencode
from urllib.parse import urlsplit

from .errors import ValidationError


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
        self._validate_redirect_uri(redirect_uri)

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

    @staticmethod
    def _validate_redirect_uri(redirect_uri: str) -> None:
        """Reject insecure or malformed redirect URIs.

        Production redirect URIs must use ``https``.  Loopback addresses
        (``localhost`` / ``127.0.0.1``) may use ``http`` for local
        development.
        """
        parsed = urlsplit(redirect_uri)

        if parsed.scheme not in ("http", "https"):
            raise ValidationError(
                f"redirect_uri must use http or https, got {parsed.scheme!r}"
            )

        host = parsed.hostname or ""
        if not host:
            raise ValidationError("redirect_uri must contain a host")

        if parsed.scheme == "https":
            return

        # scheme is "http" — only allow loopback
        if host not in ("localhost", "127.0.0.1"):
            raise ValidationError(
                "non-loopback redirect_uri must use https, "
                f"got http://{host}"
            )
