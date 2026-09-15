# FAQ

## Is Authly production-ready?

No. Authly is a fictional benchmark application for testing Draftly. Do not use it for production identity or security workloads.

## Does Authly support OAuth?

Yes. As of v2.0.0 Authly supports the authorization-code flow: construct an authorization URL with `oauth.authorization_url()`, then exchange the redirect's code for an access token with `oauth.exchange_code()`. PKCE is still on the roadmap. See [Construct an OAuth authorization URL](../how-to/oauth-authorization-url.md).

## Does Authly support roles and permissions?

Yes. Roles bundle permission strings and can be assigned to users; checks succeed when any assigned role contains the requested permission. See [Authorization model](authorization-model.md).

## Do organizations grant permissions?

Yes. Roles can be scoped to an organization (`roles.create(..., organization_id=...)`), and permission checks can be restricted to an organization — when `organization_id` is given, only that organization's roles and unscoped roles are considered. Membership alone still grants nothing. See [Authorization model](authorization-model.md).

## Does Authly have persistent storage?

No. Everything lives in memory on the client instance and is lost when the process exits.

## How do I authenticate the client itself?

Initialize `Authly` with `project_id` and `scoped_token`. Both are required. Note that this is client configuration, separate from user login via `authly.auth.login()`. See [Configure the client](../how-to/configure-client.md).

**Migration note:** The `api_key` parameter was removed in v2.0.0. Construct the client with `scoped_token` instead.

## Why is my password stored in plain text?

Benchmark simplification, by design. Real password hashing would add complexity without teaching anything new about documentation drift. See [Security notes](security.md).

## Where do I report issues?

Authly exists to exercise documentation workflows; its issue tracker lives at `simulation/github/issues/` within this repository.
