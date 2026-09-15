"""Permission checks."""

from .errors import AuthorizationError


class PermissionService:
    def __init__(self, client):
        self.client = client

    def _assigned_roles(
        self,
        *,
        user_id: str,
        organization_id: str | None = None,
    ):
        for role in self.client._roles.values():
            if user_id not in role.assignments:
                continue
            if (
                organization_id is not None
                and role.organization_id not in (None, organization_id)
            ):
                continue
            yield role

    def check(
        self,
        *,
        user_id: str,
        permission: str,
        organization_id: str | None = None,
    ) -> bool:
        roles = self._assigned_roles(
            user_id=user_id,
            organization_id=organization_id,
        )

        if any(permission in role.permissions for role in roles):
            return True

        raise AuthorizationError(
            f"user {user_id!r} lacks permission {permission!r}"
            + (
                f" in organization {organization_id!r}"
                if organization_id is not None
                else ""
            )
        )

    def list_for_user(
        self,
        *,
        user_id: str,
        organization_id: str | None = None,
    ) -> set[str]:
        permissions: set[str] = set()
        for role in self._assigned_roles(
            user_id=user_id,
            organization_id=organization_id,
        ):
            permissions.update(role.permissions)
        return permissions