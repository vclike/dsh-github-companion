# Security Policy

## Reporting a vulnerability

Please do NOT open a public issue for security problems.

Contact the maintainer privately via GitHub (**@vclike** — use "Report a
vulnerability" on the Security tab of this repository, or a direct message).
You will get an acknowledgment within 72 hours and a fix timeline within 7
days for confirmed issues.

## Scope notes for this plugin

- **Token handling**: the PAT is resolved through the host credential seam per
  request and never written to logs or subprocess environments. A token saved
  through the settings UI persists server-side in the host's settings document
  (plaintext on disk — documented in README; prefer `credentialRef` env
  resolution if that is a concern).
- **Network surface**: the plugin talks only to the configured REST root
  (default `https://api.github.com`). It runs no servers.
- **The permission gate is an example**, not a hardened boundary: it gates
  tool calls by name in-process. Do not treat it as a sandbox against a
  hostile model.

## Supported versions

Only the latest tagged release receives security fixes.
