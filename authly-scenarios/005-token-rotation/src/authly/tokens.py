"""Simple token primitives for the benchmark."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from uuid import uuid4

from .errors import ValidationError


@dataclass(slots=True)
class Token:
    id: str
    user_id: str
    value: str
    expires_at: datetime
    token_type: str = "access"
    rotated_from: str | None = None
    revoked: bool = False


class TokenService:
    def __init__(self, client):
        self.client = client

    def create(
        self,
        *,
        user_id: str,
        expires_in_seconds: int = 3600,
    ) -> Token:
        token = Token(
            id=f"tok_{uuid4().hex[:10]}",
            user_id=user_id,
            value=token_urlsafe(24),
            expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=expires_in_seconds),
        )
        self.client._tokens[token.id] = token
        return token

    def create_refresh(
        self,
        *,
        user_id: str,
        expires_in_seconds: int = 3600,
    ) -> Token:
        """Create a refresh token: a rotating credential."""
        token = Token(
            id=f"tok_{uuid4().hex[:10]}",
            user_id=user_id,
            value=token_urlsafe(24),
            expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=expires_in_seconds),
            token_type="refresh",
        )
        self.client._tokens[token.id] = token
        return token

    def refresh(
        self,
        *,
        token: Token,
        expires_in_seconds: int = 3600,
    ) -> Token:
        """Rotate a refresh token: issue a successor and revoke the predecessor.

        Refresh tokens are rotating credentials — every refresh issues a new
        refresh token and invalidates the previous one.
        """
        if token.token_type != "refresh":
            raise ValidationError("only refresh tokens can be rotated")
        if token.revoked:
            raise ValidationError("refresh token has already been rotated")
        if self.is_expired(token):
            raise ValidationError("refresh token is expired")

        successor = Token(
            id=f"tok_{uuid4().hex[:10]}",
            user_id=token.user_id,
            value=token_urlsafe(24),
            expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=expires_in_seconds),
            token_type="refresh",
            rotated_from=token.id,
        )
        token.revoked = True
        self.client._tokens[successor.id] = successor
        return successor

    def is_expired(self, token: Token) -> bool:
        return token.expires_at <= datetime.now(timezone.utc)
