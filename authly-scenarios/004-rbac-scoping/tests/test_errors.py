from authly import (
    AuthenticationError,
    AuthlyError,
    AuthorizationError,
    NotFoundError,
    ValidationError,
)


def test_all_errors_subclass_authly_error():
    for exc_type in (AuthenticationError, AuthorizationError, NotFoundError, ValidationError):
        assert issubclass(exc_type, AuthlyError)


def test_authly_error_subclasses_exception():
    assert issubclass(AuthlyError, Exception)


def test_subclass_is_catchable_as_authly_error():
    try:
        raise NotFoundError("resource missing")
    except AuthlyError as exc:
        assert str(exc) == "resource missing"


def test_authentication_error_message_is_generic():
    try:
        raise AuthenticationError("invalid email or password")
    except AuthlyError as exc:
        assert str(exc) == "invalid email or password"
