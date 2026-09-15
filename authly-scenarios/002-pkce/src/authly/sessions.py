"""Session management."""

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4

from .errors import NotFoundError


@dataclass(slots=True)
class Session:
    id: str
    user_id: str
    created_at: datetime
    active: bool = True


class SessionService:
    def __init__(self, client):
        self.client = client

    def create(self, *, user_id: str) -> Session:
        session = Session(
            id=f"sess_{uuid4().hex[:10]}",
            user_id=user_id,
            created_at=datetime.now(timezone.utc),
        )
        self.client._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> Session:
        try:
            return self.client._sessions[session_id]
        except KeyError as exc:
            raise NotFoundError(
                f"session {session_id!r} was not found"
            ) from exc

    def revoke(self, session_id: str) -> Session:
        session = self.get(session_id)
        session.active = False
        return session
