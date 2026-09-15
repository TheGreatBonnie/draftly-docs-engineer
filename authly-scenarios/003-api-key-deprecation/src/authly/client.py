"""Top-level Authly client."""

from .auth import AuthService
from .oauth import OAuthClient
from .organizations import OrganizationService
from .permissions import PermissionService
from .roles import RoleService
from .sessions import SessionService
from .tokens import TokenService
from .users import UserService
from .webhooks import WebhookService


class Authly:
    """In-memory Authly SDK client.

    The in-memory store makes the benchmark deterministic and easy to test.
    It is deliberately not a production HTTP client.

    Clients authenticate with ``project_id`` plus a ``scoped_token``. Legacy
    project-level keys were removed in v2.0.0; only scoped tokens are
    accepted.
    """

    def __init__(
        self,
        *,
        project_id: str,
        scoped_token: str | None = None,
    ):
        if not project_id:
            raise ValueError("project_id is required")
        if not scoped_token:
            raise ValueError("scoped_token is required")

        self.project_id = project_id
        self.scoped_token = scoped_token

        self._users: dict[str, object] = {}
        self._sessions: dict[str, object] = {}
        self._organizations: dict[str, object] = {}
        self._roles: dict[str, object] = {}
        self._tokens: dict[str, object] = {}
        self._webhook_events: list[dict] = []

        self.users = UserService(self)
        self.auth = AuthService(self)
        self.sessions = SessionService(self)
        self.organizations = OrganizationService(self)
        self.roles = RoleService(self)
        self.permissions = PermissionService(self)
        self.oauth = OAuthClient(self)
        self.tokens = TokenService(self)
        self.webhooks = WebhookService(self)
