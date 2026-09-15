"""Role management."""

from dataclasses import dataclass, field
from uuid import uuid4

from .errors import NotFoundError


@dataclass(slots=True)
class Role:
    id: str
    name: str
    permissions: set[str] = field(default_factory=set)
    assignments: set[str] = field(default_factory=set)


class RoleService:
    def __init__(self, client):
        self.client = client

    def create(
        self,
        *,
        name: str,
        permissions: set[str] | None = None,
    ) -> Role:
        role = Role(
            id=f"role_{uuid4().hex[:10]}",
            name=name,
            permissions=set(permissions or set()),
        )
        self.client._roles[role.id] = role
        return role

    def assign(self, *, user_id: str, role_id: str) -> Role:
        role = self.get(role_id)
        role.assignments.add(user_id)
        return role

    def get(self, role_id: str) -> Role:
        try:
            return self.client._roles[role_id]
        except KeyError as exc:
            raise NotFoundError(f"role {role_id!r} was not found") from exc
