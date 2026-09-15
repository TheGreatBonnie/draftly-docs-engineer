#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../authly-scenarios/001-oauth-login"

git push -u origin feat/001-oauth-login

gh pr create --repo TheGreatBonnie/authly \
  --base master --head feat/001-oauth-login \
  --title "feat: add OAuth login with authorization-code exchange" \
  --body "Adds OAuth authorization-code exchange (OAuthClient.exchange_code) with a \
deterministic per-provider identity user, plus an OAuth-backed login path \
(AuthService.login_with_oauth)."