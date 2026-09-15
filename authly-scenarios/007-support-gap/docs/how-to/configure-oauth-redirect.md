# Configure OAuth redirect URIs

Your OAuth redirect URI must exactly match a URI registered in the Authly dashboard. If the redirect sent in the authorization request does not match a registered URI (including scheme, host, port, and path), Authly rejects the exchange.

## Prerequisites

- An Authly project with OAuth enabled
- An Authly dashboard user account with the **Project Settings** role

## Register a redirect URI

1. Open the Authly dashboard and go to your project.
2. Navigate to **Project → OAuth → Redirect URLs**.
3. Click **Add redirect URI**.
4. Enter the full URI you will use in `authorization_url()`, including the https scheme and exact path:

   ```
   https://app.example.com/oauth/callback
   ```

5. Click **Save**.

## Local development

For local development you may use `http://localhost:<port>` / `http://127.0.0.1:<port>`. Production redirect URIs must use `https` and are validated strictly (see [Troubleshoot errors](../how-to/troubleshoot-errors.md)).

## Multiple environments

Register one URI per environment. Do not reuse a production URI for staging. Each redirect URI is bound to the project where it was created.

## See also

- [Build an OAuth authorization URL](oauth-authorization-url.md)
- [Troubleshoot errors](troubleshoot-errors.md)