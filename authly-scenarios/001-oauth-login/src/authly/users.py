"""User management service."""

from dataclasses import dataclass
from uuid import uuid4

from .errors import NotFoundError, ValidationError


@dataclass(slots=True)
class User:
    id: str
    email: str
    name: str
    password: str


class UserService:
    def __init__(self, client):
        self.client = client

    def create(self, *, email: str, name: str, password: str) -> User:
        if not email or "@" not in email:
            raise ValidationError("a valid email is required")
        if not password:
            raise ValidationError("password is required")

        user = User(
            id=f"usr_{uuid4().hex[:10]}",
            email=email,
            name=name,
            password=password,
        )
        self.client._users[user.id] = user
        return user

    def get(self, user_id: str) -> User:
        try:
            return self.client._users[user_id]
        except KeyError as exc:
            raise NotFoundError(f"user {user_id!r} was not found") from exc

    def list(self) -> list[User]:
        return list(self.client._users.values())
