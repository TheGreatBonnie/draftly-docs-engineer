# CLI

Installing the package registers an `authly` console script (see `[project.scripts]` in `pyproject.toml`). The CLI is intentionally minimal in version 0.1 and performs no network or state operations.

## Commands

### `authly login`

Authenticate a local project session:

```bash
authly login --project proj_demo
```

Output:

```text
Authenticated local CLI session for proj_demo
```

`--project` is required; omitting it prints an argparse error and exits with status 2.

### `authly user list`

```bash
authly user list
```

Output:

```text
The benchmark CLI does not connect to a remote API yet.
```

The command always prints this placeholder regardless of arguments.

### No command

Running `authly` with no subcommand prints the help text:

```text
usage: authly [-h] {login,user} ...
```

## Exit codes

The CLI uses argparse defaults: `0` on success, `2` on usage errors. It never reads or mutates SDK state.
