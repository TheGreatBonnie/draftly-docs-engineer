# FAQ

## Is Authly production-ready?

No. Authly is a fictional benchmark application for testing Draftly. Do not use it for production identity or security workloads.

## Does Authly support OAuth?

Version 0.1 constructs OAuth authorization URLs and exchanges an authorization code for an access token. PKCE support arrives in a later simulated release (v0.3.0 in `simulation/roadmap.md`). See [Construct an OAuth authorization URL](../how-to/oauth-authorization-url.md).

## Does Authly support roles and permissions?

Yes. Roles bundle permission strings and can be assigned to users; checks succeed when any assigned role contains the requested permission. See [Authorization model](authorization-model.md).

## Do organizations grant permissions?

No. Organizations group users but play no part in authorization in version 0.1.

## Does Authly have persistent storage?

No. Everything lives in memory on the client instance and is lost when the process exits.

## How do I authenticate the client itself?

Initialize `Authly` with `project_id` and `api_key`. Both are required. Note that this is client configuration, separate from user login via `authly.auth.login()`. See [Configure the client](../how-to/configure-client.md).

## Why is my password stored in plain text?

Benchmark simplification, by design. Real password hashing would add complexity without teaching anything new about documentation drift. See [Security notes](security.md).

## Where do I report issues?

Authly exists to exercise documentation workflows; its issue tracker lives at `simulation/github/issues/` within this repository.
