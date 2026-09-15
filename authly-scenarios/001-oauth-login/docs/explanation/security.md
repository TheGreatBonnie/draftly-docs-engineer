# Security notes

This page explains Authly's security posture: what the benchmark guarantees, what it deliberately does not, and how to work on it safely.

## What Authly is not

Authly is a fictional benchmark application. Its authentication primitives are intentionally simplified and must never guard real systems or real user data. Concrete simplifications include:

- Passwords are stored as provided, unhashed.
- API keys are accepted without validation beyond non-emptiness.
- Tokens are random strings with expiry metadata only; no signing, revocation lists, or rotation.
- OAuth supports building authorization URLs and exchanging codes for tokens; PKCE is not implemented.

## Working on the benchmark safely

Even fictional credentials should stay fictional:

- Do not commit real credentials anywhere in the repository.
- Use placeholder values (`proj_demo`, `demo_key`) in examples and tests.
- Treat webhook secrets as sensitive — examples use `webhook_secret`, nothing more.
- Never place real passwords in source control, including in test fixtures.

## Authentication changes are documentation events

In this repository, product changes to authentication are treated as high-impact documentation changes. When a release touches login, tokens, keys, or redirect validation, the affected guides and reference pages need review in the same change. The roadmap stages these deliberately — for example the v0.4.0 API-key deprecation introduces token-based client authentication and requires a migration guide.

If you are evolving Authly, read `simulation/roadmap.md` first and update the docs listed under each release's *Documentation risk* section alongside the code.

## See also

- [FAQ](faq.md)
- [Troubleshoot errors](../how-to/troubleshoot-errors.md)
