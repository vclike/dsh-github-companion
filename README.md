# dsh-plugin-github

Give your DeepSeek Harness agent native GitHub abilities: track open-source
projects, upload your own work as private repos, manage issues / releases /
forks — from natural conversation, with every write behind an approval gate.

[![CI](https://github.com/vclike/dsh-plugin-github/actions/workflows/ci.yml/badge.svg)](https://github.com/vclike/dsh-plugin-github/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [中文](README.zh.md)

> Verified against DeepSeek Harness g0.1.0-rc.7` (declared in
> `peerDependencies`). Breaking host releases are announced here after a
> compatibility pass.

## What can it do?

Talk to your agent in plain language — it picks the right tools itself:

| You ask for… | The agent… | Tools fired |
|---|---|---|
| “Summarize this week’s changes across my starred projects” | walks your star list, checks each repo’s latest release and commits, writes a digest | `list_starred` · `latest_release` · `list_commits` |
| “What’s new in owner/repo recently?” | fetches the newest release notes, recent commits and hot issues | `latest_release` · `list_commits` · `list_issues` |
| “Upload this local folder as a new private repo” | creates the repo, then pushes every file in one atomic commit | `create_repository` · `push_files` |
| “Fix the README typo and cut v1.2.1” | edits the file on main and tags a release with notes | `push_files` · `create_release` |
| “Which of my forks are behind upstream?” | compares each fork against its parent, syncs the ones you pick | `list_forks` · `sync_fork` |
| “Open an issue upstream about this bug” | files a well-formed issue after you approve | `create_issue` |
| “Show me how repo X implements Y” | reads and searches any public code without leaving the chat | `get_file_contents` · `search_code` |

**Safety model** — read tools are always on; every write (issues, branches,
files, releases, PRs) goes through a permission gate that pops an approval
prompt first; created repositories are always **private** by design; the token
never reaches subprocesses or logs. Without a token everything still works
read-only against public repos (60 req/h).

## Quick start

```bash
dsh plugin add dsh-plugin-github        # restart DSH afterwards
```

1. Open DSH Settings → **GitHub** section.
2. Paste a token (one-click link in [Credentials](#credentials) below) → save.
3. Ask the agent something like *“what did I star recently?”* — if it answers
   with real data, you are set.

## Under the hood

Two cordis plugins in one package:

| Entry | Plugin name | Purpose |
|---|---|---|
| `dsh-plugin-github` | `github-tools` | Registers GitHub REST tools on `ctx.tools` |
| `dsh-plugin-github/gate` | `github-permission-gate` | Example `tools/pre-execute` permission gate scoped to `github_*` tools |

### Tools (29 total, registered per switches)

**Read / discovery** — always on:
`github_get_me`, `github_get_repository`, `github_get_file_contents`,
`github_list_commits`, `github_search_repositories`, `github_search_code`,
`github_search_issues`, `github_list_issues`, `github_get_issue`,
`github_list_releases`, `github_latest_release`, `github_list_starred`,
`github_list_forks`, `github_list_watched`, `github_list_notifications`,
`github_get_file_tree` (one-call recursive directory tree),
`github_list_my_repositories` (the only list that includes your own private repos)

**Issue writes** — switchable (`enableIssueWrites`, default on):
`github_create_issue`, `github_update_issue`, `github_add_issue_comment`

**Git data writes** — switchable (`enableGitDataTools`, default **off**):
`github_list_pull_requests`, `github_get_pull_request`, `github_create_branch`,
`github_create_or_update_file`, `github_push_files`, `github_create_pull_request`,
`github_create_release`, `github_sync_fork`

**Repo creation** — switchable (`enableRepoCreation`, default **off**):
`github_create_repository` — always creates a **private** repository (no
visibility argument exists); requires Administration (rw) on the token.

**Local clone** — switchable (`enableCloneTools`, default **off**):
`github_clone_repository` — clones any repo you can access (private
included) to a local directory via the machine's git. The PAT is bridged to
exactly ONE git subprocess through an environment-injected auth header
(the actions/checkout mechanism); it never appears in argv, the remote URL,
`.git/config`, logs, or the conversation.

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

The token never reaches subprocesses or logs — with ONE deliberate,
switchable exception: `github_clone_repository` hands it to a single local
git subprocess via an environment-injected header (not argv, not the URL,
not `.git/config`, not logs). The subprocess dies with the operation; the
token never persists outside the harness.

### Step 1 — Apply for a token (pick ONE)

**Option A · one-click classic token (easiest)**

1. Log in to GitHub and open this link — every scope the plugin needs is
   pre-checked:
   **https://github.com/settings/tokens/new?scopes=repo,workflow&description=dsh-plugin-github**
2. Pick an expiration if you like (or keep no-expiration).
3. Scroll down, click **Generate token**.
4. Copy the value (starts with `ghp_`) into the plugin settings card and save.

Tradeoff: the classic `repo` scope is account-wide (all repos, read/write) and
cannot be limited to selected repositories. If that matters, use Option B.

**Option B · fine-grained token (per-repository control)**

Apply at **https://github.com/settings/personal-access-tokens/new**
(GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens):

1. Set a name and expiration.
2. Repository access: **All repositories** — repos you create later are
   covered automatically, no need to touch the token again.
3. Tick the permissions per the table below.
4. Generate and copy (starts with `github_pat_`).

### Step 2 — which permissions to tick (Option B)

| Permission | Why |
|---|---|
| Metadata **R** | always required by the API |
| Contents **RW** | read files, commits, branches, uploads |
| Issues **RW** | create / update / comment on issues |
| Pull requests **RW** | PR tools |
| Workflows **RW** | push workflow files when uploading projects |
| Administration **RW** | only needed for repo creation (`enableRepoCreation`) |

Recommended baseline: the first five. Add Administration RW only when you turn
on repo creation — editing permissions later keeps the same token value.

### Step 3 — give the token to the plugin

- **Settings UI** (preferred): DSH 设置 → GitHub 区块 → 粘贴进 Token 输入框 →
  保存。Takes effect immediately; UI never echoes the value back.
- **Environment variable**: define `GITHUB_TOKEN` (e.g. in `~/.dsh/.env`) and
  leave the settings field empty. Rotation applies on the next request.

Verify by asking the agent anything about your GitHub account —
`github_get_me` should report `authenticated: true` (anonymous mode reports
`false` and only public data works).

> **Storage note**: a PAT saved through the settings UI persists server-side
> in `~/.dsh/settings.yaml` as plaintext on disk (like the rest of that
> document). `role('secret')` protects the wire and the UI — not the file.
> If disk-plaintext is a concern, keep the token in an environment variable
> via `credentialRef` instead and leave the UI field empty.

## Settings UI

Both plugins register settings namespaces rendered by the DSH settings UI:

- `github-tools`: `enableIssueWrites`, `enableGitDataTools`, `enableRepoCreation`,
  `workspaceRoot` (**default clone directory** — clone destination priority:
  the current session's workspace → this directory → ask; created on first
  clone. Surfaced to the agent via `github_get_me`), and
  `proxyUrl` (optional HTTP(S) proxy for api.github.com — Node's fetch ignores
  system proxy settings, so set this explicitly if you need one; applies live)
- `github-gate`: `mode` (`off|writes|all`), `action` (`ask|deny`), `excludeTools`
  (managed as removable pills in the settings card, with common read-only
  suggestions)

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

# from a local checkout of this repository
dsh plugin add <your-checkout>/dsh-plugin-github   # or github:owner/repo#<sha>
```

Then set your token and (optionally) trim the gate row from your profile's
`cordis.patch.yml` if you don't want the permission gate loaded.

### Companion usage skill (recommended)

`dsh-github-guide/` in this repository is a mini bundle that registers an
on-demand agent skill, `dsh-github-usage` — a capability map, result
conventions, token prerequisites, workflow recipes (upload project → private
repo), and a failure playbook. Install it alongside:

```bash
dsh plugin add <your-checkout>/dsh-plugin-github/dsh-github-guide
```

Agents that have it loaded stop guessing about anonymous rate limits, empty
repo pushes, `already_exists` handling, and why public repos are out of scope.

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
        enableRepoCreation: false        # composition default (settings UI can override)
        workspaceRoot: ''                # local root for cloned repos (empty = ask each time)
        proxyUrl: ''                     # optional HTTP(S) proxy for api.github.com
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
npm test            # vitest (43 tests, offline)
npm run test:coverage
npm run build       # emit lib/
node scripts/verify-load.mjs   # run inside a scratch profile dir after `dsh plugin add`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and PR flow; security
disclosure goes through [SECURITY.md](SECURITY.md).

## Testing

Four layers, from quickest to most thorough (no paid services involved —
this only ranks run time and setup effort):

```bash
# L1 — offline: types + 43 unit tests (client/tools/gate, mocked fetch)
npm run typecheck && npm test

# L2 — package loads through a profile's link layout
dsh plugin --profile <scratch> add <your-checkout>/dsh-plugin-github   # once
cd ~/.dsh/profiles/<scratch>
dsh --profile <scratch> --dump-config                                  # insert rows present?
node <your-checkout>/dsh-plugin-github/scripts/verify-load.mjs

# L3 — live GitHub API smoke (READ-ONLY; anonymous works, 60 req/h)
node scripts/smoke-live.mjs                      # from the repo root
# authed path: set GITHUB_TOKEN in the environment first

# L4 — authenticated writes: use a scratch repository.
# Enable enableGitDataTools, then drive create_branch → push_files →
# create_pull_request against it (GUI chat or headless profile).

# L5 — agent-level E2E: after `dsh plugin add` into your daily profile,
# ask the assistant e.g. "how many stars does langchain-ai/langchain have?"
# and watch the tool cards; gate mode=writes should pop an approval for
# write tools.
```

## Boot-safety & recovery (verified by experiment)

What happens when things go wrong, measured on a real harness boot:

| Scenario | Result |
|---|---|
| Healthy insert rows | boots; model called `github_get_repository` live via a headless one-shot task |
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
