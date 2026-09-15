# Configure the client

Use this recipe to initialize an `Authly` client with a project ID and API key so you can call any service method.

## Prerequisites

- The `authly` package installed ([Getting started](../tutorials/getting-started.md))
- A project ID and API key for your environment

## Initialize the client

Both arguments are keyword-only and required:

```python
from authly import Authly

authly = Authly(
    project_id="proj_demo",
    api_key="demo_key",
)
```

## What happens on bad input

Missing or empty values raise `ValueError` before any service is created:

```text
ValueError: project_id is required
ValueError: api_key is required
```

Passing arguments positionally raises `TypeError` because both parameters are keyword-only:

```python
Authly("proj_demo", "demo_key")  # TypeError
```

## Access configuration later

The client stores both values as attributes:

```python
authly.project_id  # "proj_demo"
authly.api_key     # "demo_key"
```

The project ID is also reused as the OAuth `client_id` when constructing authorization URLs.

## See also

- [SDK overview](../reference/sdk.md)
- [Security notes](../explanation/security.md) — treat keys as placeholders in this benchmark
