"""Simple token primitives for the benchmark."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from uuid import uuid4


@dataclass(slots=True)
class Token:
    id: str
    user_id: str
    value: str
    expires_at: datetime
    token_type: str = "access"


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

    def is_expired(self, token: Token) -> bool:
        return token.expires_at <= datetime.now(timezone.utc)
