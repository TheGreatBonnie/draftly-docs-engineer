"""Authly exception types."""


class AuthlyError(Exception):
    """Base exception for Authly."""


class AuthenticationError(AuthlyError):
    """Raised when authentication fails."""


class AuthorizationError(AuthlyError):
    """Raised when a principal lacks a required permission."""


class NotFoundError(AuthlyError):
    """Raised when a requested resource does not exist."""


class ValidationError(AuthlyError):
    """Raised when input is invalid."""
