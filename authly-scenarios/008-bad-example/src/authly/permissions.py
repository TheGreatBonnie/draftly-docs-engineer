"""Permission checks."""

from .errors import AuthorizationError


class PermissionService:
    def __init__(self, client):
        self.client = client

    def check(self, *, user_id: str, permission: str) -> bool:
        roles = [
            role
            for role in self.client._roles.values()
            if user_id in role.assignments
        ]

        if any(permission in role.permissions for role in roles):
            return True

        raise AuthorizationError(
            f"user {user_id!r} lacks permission {permission!r}"
        )

    def list_for_user(self, *, user_id: str) -> set[str]:
        permissions: set[str] = set()
        for role in self.client._roles.values():
            if user_id in role.assignments:
                permissions.update(role.permissions)
        return permissions
