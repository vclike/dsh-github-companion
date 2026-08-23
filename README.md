# dsh-plugin-github

DeepSeek Harness plugin: native GitHub REST tools for agents, plus a companion
permission-gate example plugin.

[![CI](https://github.com/vclike/dsh-plugin-github/actions/workflows/ci.yml/badge.svg)](https://github.com/vclike/dsh-plugin-github/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [中文](README.zh.md)

## What you get

Two cordis plugins in one package:

| Entry | Plugin name | Purpose |
|---|---|---|
| `dsh-plugin-github` | `github-tools` | Registers GitHub REST tools on `ctx.tools` |
| `dsh-plugin-github/gate` | `github-permission-gate` | Example `tools/pre-execute` permission gate scoped to `github_*` tools |

### Tools (18 total, registered per switches)

**Read / discovery** — always on:
`github_get_me`, `github_get_repository`, `github_get_file_contents`,
`github_list_commits`, `github_search_repositories`, `github_search_code`,
`github_search_issues`, `github_list_issues`, `github_get_issue`

**Issue writes** — switchable (`enableIssueWrites`, default on):
`github_create_issue`, `github_update_issue`, `github_add_issue_comment`

**Git data writes** — switchable (`enableGitDataTools`, default **off**):
`github_list_pull_requests`, `github_get_pull_request`, `github_create_branch`,
`github_create_or_update_file`, `github_push_files`, `github_create_pull_request`

**Repo creation** — switchable (`enableRepoCreation`, default **off**):
`github_create_repository` — always creates a **private** repository (no
visibility argument exists); requires Administration (rw) on the token.

Canonical results are JSON-safe objects with a top-level `ok` field. GitHub
domain failures (404/401/403/422…) return `{ ok: false, status, message }`
instead of throwing, so the model can react programmatically; only network
failures surface as tool errors.

## Credentials

Config carries only the env-var **name** (`credentialRef`, default
`GITHUB_TOKEN`). The value is resolved through the harness credential seam
(`ctx.credentials`) once per request — set the variable in any provider layer
(`~/.dsh/.env` is read by the local provider's env layers, or export it in the
shell), rotate it any time, and the next request picks it up without a
restart. Without a token the tools work anonymously against public repos
(60 req/h core limit); `github_get_me` reports that state.

The token never reaches subprocesses or logs.

> **Storage note**: a PAT saved through the settings UI persists server-side
> in `~/.dsh/settings.yaml` as plaintext on disk (like the rest of that
> document). `role('secret')` protects the wire and the UI — not the file.
> If disk-plaintext is a concern, keep the token in an environment variable
> via `credentialRef` instead and leave the UI field empty.

## Settings UI

Both plugins register settings namespaces rendered by the DSH settings UI:

- `github-tools`: `enableIssueWrites`, `enableGitDataTools`
- `github-gate`: `mode` (`off|writes|all`), `action` (`ask|deny`), `excludeTools`

Composition defaults come from the cordis.yml insert rows (`base` layer);
changes apply live.

The "GitHub" section on the settings page is contributed by this package's
browser half (`client.js`, exposed as
`/plugins/dsh-plugin-github/client.js` via the `dsh.client` manifest) and
talks to the official `settings.describe/mutate` surface. Note that a backend
`settings.register` alone produces no UI — every settings section is a client
plugin contributing through the `settings.section` seat.

UI-free equivalent: add user-layer sections to `~/.dsh/settings.yaml`:

```yaml
github-tools:
  enableGitDataTools: true
github-gate:
  mode: all
```

## Install

```bash
# published package (bundle channel — takes effect on restart)
dsh plugin add dsh-plugin-github

# local checkout
dsh plugin add D:/path/to/dsh-plugin-github   # or github:owner/repo#<sha>
```

Then set your token and (optionally) trim the gate row from your profile's
`cordis.patch.yml` if you don't want the permission gate loaded.

## Configuration (cordis.yml insert row)

```yaml
- insert:
    - id: github-tools
      name: dsh-plugin-github
      config:
        credentialRef: GITHUB_TOKEN      # env-var NAME holding the PAT
        apiBaseUrl: https://api.github.com   # GHES: https://host/api/v3
        requestTimeoutMs: 30000
        maxRetries: 1                    # retries for rate-limited responses
        maxPerPage: 30                   # hard cap for list/search tools
        maxFileBytes: 262144             # file-content truncation threshold
        enableIssueWrites: true          # composition default (settings UI can override)
        enableGitDataTools: false        # composition default (settings UI can override)
    - id: github-permission-gate
      name: dsh-plugin-github/gate
      config:
        mode: writes                     # off | writes | all
        action: ask                      # ask (approval service) | deny
        excludeTools: []                 # exact tool names exempt from gating
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (27 tests, offline)
npm run test:coverage
npm run build       # emit lib/
node scripts/verify-load.mjs   # run inside a profile dir after `dsh plugin add`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and PR flow; security
disclosure goes through [SECURITY.md](SECURITY.md).

## Testing

Four layers, cheapest first:

```bash
# L1 — offline: types + 24 unit tests (client/tools/gate, mocked fetch)
npm run typecheck && npm test

# L2 — package loads through a profile's link layout
dsh plugin --profile plugin-verify add <repo>   # once
cd ~/.dsh/profiles/plugin-verify
dsh --profile plugin-verify --dump-config        # insert rows present?
node D:/path/to/dsh-plugin-github/scripts/verify-load.mjs

# L3 — live GitHub API smoke (READ-ONLY; anonymous works, 60 req/h)
node scripts/smoke-live.mjs                      # from the repo root
# authed path: set GITHUB_TOKEN in the environment first

# L4 — authenticated writes: use a scratch repository.
# Enable enableGitDataTools, then drive create_branch → push_files →
# create_pull_request against it (GUI chat or headless profile).

# L5 — agent-level E2E: after `dsh plugin add` into your daily profile,
# ask the assistant e.g. "查一下 bytedance/deer-flow 的 star 数" and watch
# the tool cards; gate mode=writes should pop an approval for write tools.
```

## Boot-safety & recovery (verified by experiment)

What happens when things go wrong, measured on a real harness boot:

| Scenario | Result |
|---|---|
| Healthy rows (`scripts/` none) | boots; model called `github_get_repository` live via a headless one-shot task |
| Schema-invalid config (e.g. string where number expected) | **entire profile refuses to boot**, exit 1, error names the exact row id and field — fail-closed by design |
| Valid config but `apply()` throws (e.g. malformed `credentialRef`) | same: boot refuses, stack trace names the plugin |
| Tool `execute()` throwing at runtime | contained by the tool registry as an `isError` result; harness keeps running |

So the blast radius of a bad install is "this profile won't start until the row
is fixed or removed" — never a silent half-broken agent. Recovery:

```bash
# option 1: remove cleanly
dsh plugin --profile <name> remove dsh-plugin-github

# option 2: hand-edit the profile's cordis.patch.yml (delete/fix the two rows)

# pre-flight before restarting your daily profile:
dsh --profile <name> --dump-config          # composition check
dsh --profile <name> "<one-shot task>"      # real boot check (headless-capable profiles)
```

The two injection overlays used to measure this live in
`scripts/bad-config.patch.yml` and `scripts/apply-throw.patch.yml` — replay
them against any scratch profile with
`dsh --profile <scratch> --patch <overlay> "<task>"`.

## License

MIT
