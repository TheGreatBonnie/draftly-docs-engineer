# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- OAuth authorization-code exchange (`OAuthClient.exchange_code`) with a
  deterministic, per-provider/code identity user.
- Input validation for `provider`, `code`, and `redirect_uri` in the OAuth
  exchange.
