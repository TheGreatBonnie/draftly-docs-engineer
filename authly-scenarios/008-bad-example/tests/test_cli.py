import pytest

from authly.cli import build_parser, main


def _run_main(monkeypatch, argv):
    monkeypatch.setattr("sys.argv", argv)
    main()


def test_parser_parses_login_command():
    args = build_parser().parse_args(["login", "--project", "proj_demo"])

    assert args.command == "login"
    assert args.project == "proj_demo"


def test_parser_requires_project_flag(capsys):
    with pytest.raises(SystemExit) as excinfo:
        build_parser().parse_args(["login"])

    assert excinfo.value.code == 2
    assert "--project" in capsys.readouterr().err


def test_parser_parses_user_list_command():
    args = build_parser().parse_args(["user", "list"])

    assert args.command == "user"
    assert args.action == "list"


def test_parser_rejects_unknown_user_action():
    with pytest.raises(SystemExit) as excinfo:
        build_parser().parse_args(["user", "delete"])

    assert excinfo.value.code == 2


def test_main_login_prints_confirmation(monkeypatch, capsys):
    _run_main(monkeypatch, ["authly", "login", "--project", "proj_demo"])

    assert capsys.readouterr().out == (
        "Authenticated local CLI session for proj_demo\n"
    )


def test_main_user_list_prints_placeholder(monkeypatch, capsys):
    _run_main(monkeypatch, ["authly", "user", "list"])

    assert capsys.readouterr().out == (
        "The benchmark CLI does not connect to a remote API yet.\n"
    )


def test_main_without_command_prints_help(monkeypatch, capsys):
    _run_main(monkeypatch, ["authly"])

    out = capsys.readouterr().out
    assert out.startswith("usage: authly")
    assert "{login,user}" in out
