"""Organization management."""

from dataclasses import dataclass, field
from uuid import uuid4

from .errors import NotFoundError


@dataclass(slots=True)
class Organization:
    id: str
    name: str
    member_ids: set[str] = field(default_factory=set)


class OrganizationService:
    def __init__(self, client):
        self.client = client

    def create(self, *, name: str) -> Organization:
        organization = Organization(
            id=f"org_{uuid4().hex[:10]}",
            name=name,
        )
        self.client._organizations[organization.id] = organization
        return organization

    def add_member(self, *, organization_id: str, user_id: str) -> Organization:
        organization = self.get(organization_id)
        organization.member_ids.add(user_id)
        return organization

    def get(self, organization_id: str) -> Organization:
        try:
            return self.client._organizations[organization_id]
        except KeyError as exc:
            raise NotFoundError(
                f"organization {organization_id!r} was not found"
            ) from exc
