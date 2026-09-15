# Configure the client

Use this recipe to initialize an `Authly` client with a project ID and scoped token so you can call any service method.

## Prerequisites

- The `authly` package installed ([Getting started](../tutorials/getting-started.md))
- A project ID and scoped token for your environment

## Initialize the client

Both arguments are keyword-only and required:

```python
from authly import Authly

authly = Authly(
    project_id="proj_demo",
    scoped_token="tok_demo",
)
```

## What happens on bad input

Missing or empty values raise `ValueError` before any service is created:

```text
ValueError: project_id is required
ValueError: scoped_token is required
```

Passing arguments positionally raises `TypeError` because both parameters are keyword-only:

```python
Authly("proj_demo", "tok_demo")  # TypeError
```

Passing the removed `api_key` argument also raises `TypeError`.

## Access configuration later

The client stores both values as attributes:

```python
authly.project_id    # "proj_demo"
authly.scoped_token  # "tok_demo"
```

The project ID is also reused as the OAuth `client_id` when constructing authorization URLs.

## Breaking change in v2.0.0: legacy key authentication removed

Legacy API-key authentication was removed in v2.0.0. Passing `api_key` now raises `TypeError`. Migrate to `scoped_token`:

```python
authly = Authly(project_id="proj_demo", scoped_token="tok_demo")
```

## See also

- [SDK overview](../reference/sdk.md)
- [Security notes](../explanation/security.md) — treat keys as placeholders in this benchmark
