"""Small Authly CLI."""

import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="authly",
        description="Authly fictional developer authentication CLI",
    )
    subparsers = parser.add_subparsers(dest="command")

    login = subparsers.add_parser("login")
    login.add_argument("--project", required=True)

    user = subparsers.add_parser("user")
    user.add_argument("action", choices=["list"])

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "login":
        print(f"Authenticated local CLI session for {args.project}")
    elif args.command == "user" and args.action == "list":
        print("The benchmark CLI does not connect to a remote API yet.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
