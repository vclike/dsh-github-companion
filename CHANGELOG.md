# Changelog

## 0.1.0 (2026-08-23)

Initial release.

- `github-tools` plugin: 19 GitHub REST tools in three tiers —
  read/discovery (9), issue writes (3, default on), git-data writes (6,
  default off). Credential via `ctx.credentials` env-reference
  (`credentialRef`, default `GITHUB_TOKEN`) resolved per request; settings
  namespace `github-tools` with live re-sync of the registered tool set.
- `github-permission-gate` example plugin: `tools/pre-execute` waterfall gate
  for `github_*` tools (`mode: off|writes|all`, `action: ask|deny`,
  `excludeTools`), settings namespace `github-gate`.
- Domain failures returned as `{ ok:false, status, message }` canonical
  values; network failures throw. Rate-limit retry with Retry-After support;
  GHES supported via `apiBaseUrl`.
- Bundle packaging (`dsh.bundle.patch`), bilingual README, vitest suite
  (23 tests) and a profile-level load verification script.
