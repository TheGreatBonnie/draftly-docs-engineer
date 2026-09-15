"""Authly fictional developer authentication platform."""

from .client import Authly
from .errors import (
    AuthenticationError,
    AuthlyError,
    AuthorizationError,
    NotFoundError,
    ValidationError,
)
from .oauth import OAuthClient
from .tokens import Token

__all__ = [
    "Authly",
    "AuthlyError",
    "AuthenticationError",
    "AuthorizationError",
    "NotFoundError",
    "ValidationError",
    "OAuthClient",
    "Token",
]

__version__ = "0.1.0"
