# dsh-github-companion

> DeepSeek Harness 插件：AI 操作 GitHub 的完整集成——33 个 REST/GraphQL 工具 + 进程内权限门 + 成本纪律 companion skill，零 gh CLI 依赖。
>
> DeepSeek Harness plugin: complete GitHub integration for AI agents — 33 REST/GraphQL tools + in-process permission gate + cost-discipline companion skill, zero `gh` CLI dependency.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [中文](README.zh.md)

> Verified against DeepSeek Harness `0.1.2-rc.1` (declared in
> `peerDependencies`). Compatibility passes for new host releases
> ship under `## CHANGELOG.md`.

## What's in the box

This package mounts as **three cordis bundles** sharing one install:

| Mount point | Purpose |
|---|---|
| `github-companion` | Registers 33 `github_*` tools on `ctx.tools`. Always-on read/discovery; opt-in writes/clone/repo-creation. |
| `github-companion-gate` | Worked example of the host's `tools/pre-execute` permission seam. Three modes, three actions, fail-open under full-access posture. |
| `github-companion-usage` | Bundles the package-root `SKILL.md` (capability map, result conventions, workflow recipes, failure playbook) as one on-demand agent skill. |

And via the same `~/.dsh/skills/dsh-github-companion/` directory the user
manages separately: the **discipline companion skill** (`SKILL.md` plus
`references/{cost-discipline,release-flows,incident-playbook,repo-hardening}.md`).
It owns what the plugin cannot enforce: push discipline, tag timing, budget
reaction, CI hardening.

## What can it do?

Talk to your agent in plain language — it picks the right tools itself:

| You ask for… | The agent… | Tools fired |
|---|---|---|
| "Summarize this week's changes across my starred projects" | walks your star list, checks each repo's latest release and commits, writes a digest | `list_starred` · `latest_release` · `list_commits` |
| "What's new in owner/repo recently?" | fetches the newest release notes, recent commits and hot issues | `latest_release` · `list_commits` · `list_issues` |
| "Upload this local folder as a new private repo" | creates the repo, then pushes every file in one atomic commit | `create_repository` · `push_files` |
| "Fix the README typo and cut v1.2.1" | edits the file on main and tags a release with notes | `push_files` · `create_release` |
| "Which of my forks are behind upstream?" | compares each fork against its parent, syncs the ones you pick | `list_forks` · `sync_fork` |
| "Open an issue upstream about this bug" | files a well-formed issue after you approve | `create_issue` |
| "Show me how repo X implements Y" | reads and searches any public code without leaving the chat | `get_file_contents` · `search_code` |

### Tool surface (33 total, registered per switches)

**Read / discovery — always on (21 tools):**
`github_get_me`, `github_get_repository`, `github_get_file_contents`,
`github_get_file_tree`, `github_list_commits`, `github_list_contributors`,
`github_list_languages`, `github_list_tags`, `github_search_repositories`,
`github_search_code`, `github_search_issues`, `github_list_issues`,
`github_get_issue`, `github_list_releases`, `github_latest_release`,
`github_list_starred`, `github_list_forks`, `github_list_watched`,
`github_list_notifications`, `github_list_my_repositories`,
`github_get_commit_activity`.

**Issue writes** — switchable (`enableIssueWrites`, default **on**):
`github_create_issue`, `github_update_issue`, `github_add_issue_comment`.

**Git data writes** — switchable (`enableGitDataTools`, default **off**):
`github_list_pull_requests`, `github_get_pull_request`, `github_create_branch`,
`github_create_or_update_file`, `github_push_files`,
`github_create_pull_request`, `github_create_release`, `github_sync_fork`.

**Repo creation** — switchable (`enableRepoCreation`, default **off**):
`github_create_repository` — **always creates a private repository**; there
is no `public` argument exposed. Public repos stay a manual web action.

**Local clone** — switchable (`enableCloneTools`, default **off**):
`github_clone_repository` — clones any repo you can access to a local
directory via the machine's `git`. The PAT bridges to exactly **one** git
subprocess through an environment-injected auth header; it never appears
in argv, the remote URL, `.git/config`, logs, or the conversation.

Canonical results are JSON-safe objects with a top-level `ok` field.
GitHub domain failures (404/401/403/422…) return
`{ ok: false, status, message }` instead of throwing; only network
failures surface as tool errors.

## Why this plugin does not wrap the `gh` CLI

Every tool talks to GitHub REST + GraphQL directly over `fetch`/`undici`.
`github_clone_repository` shells out to `git` (not `gh`) for the one
subprocess it needs. The trade-offs that drove that choice:

| Concern | Direct REST (this plugin) | Wrapping `gh` CLI |
|---|---|---|
| External dependency | Zero — works the same on Windows / Linux / macOS, no PATH requirement, no version skew | Requires `gh` on PATH, version must match what the wrapper expects |
| Atomic multi-file push | blob → tree → commit → ref in one round-trip via git-data API | `gh` has no equivalent — closest is one `git push` per file |
| Actions cost guard | Direct `GET /actions/runs?status=in_progress` pre-flight before every push — first-class | `gh run list` works but adds another shell round-trip per push |
| Rate-limit handling | We own the retry policy + backoff header reading — configurable per composition | Relies on `gh` stderr strings, fragile |
| Sandbox / Windows | Pure JS, deterministic | `gh.exe` may not exist in headless / sandboxed setups |
| Testability | `fetchImpl` mock in unit tests | Subprocess black box, output parsing fragile |
| Debugging | Same code path as `curl -H "Authorization: Bearer …"` | Translates between gh surface and wire format |
| GraphQL support | Native (`github_graphql` for queries the REST surface can't reach) | Has `gh api graphql` but with extra shell escaping |

If a future deployment legitimately needs `gh` (e.g. a GHES instance
behind a firewall that drops REST but lets SSH escape), a `useGhCli`
fallback flag can be added; the default stays REST.

## Credentials

The plugin never holds the token value outside the harness credential
seam. Two resolution paths, both per-operation (a rotated credential
reaches the next request without a restart):

- **`ctx.credentials.resolve(ref)`** — the reference name (default
  `GITHUB_TOKEN`) is configured at composition time; the value lives in
  `$DSH_HOME/.credentials.yaml`
- **Inline PAT via settings UI** — `github-tools.token` declared
  `role('secret')`, written through DSH's settings document; the
  redaction sidecar reports `set: true/false` on every describe read

Without a token, all read tools work anonymously against public repos
(60 req/h core limit); `github_get_me` reports that state.

> **Storage note**: a PAT saved through the settings UI persists
> server-side in `~/.dsh/settings.yaml` as plaintext on disk (like the
> rest of that document). `role('secret')` protects the wire and the UI
> — not the file. If disk-plaintext is a concern, keep the token in an
> environment variable via `credentialRef` and leave the UI field empty.

### Token permissions (fine-grained PAT recommended)

Apply at <https://github.com/settings/personal-access-tokens/new>:

| Permission | Why |
|---|---|
| Metadata **R** | always required by the API |
| Contents **RW** | read files, commits, branches, uploads |
| Issues **RW** | create / update / comment on issues |
| Pull requests **RW** | PR tools |
| Workflows **RW** | push workflow files when uploading projects |
| Administration **RW** | only needed for repo creation (`enableRepoCreation`) |

Recommended baseline: the first five. Add Administration RW only when you
turn on repo creation.

## Safety by design

- **Repo creation is always private.** `github_create_repository` sends
  `private: true` unconditionally; there is no `public` argument to
  choose by accident.
- **Multi-file commit is one atomic round-trip.** `github_push_files`
  uses the git-data API (blob → tree → commit → ref) so a partial push
  is impossible.
- **Multi-file commit cap.** `maxFileBytes` (default 256 KiB) and
  `maxPerPage` (default 30) bound any single tool's blast radius;
  refusal returns canonical `{ ok:false, status, message }`, never an
  exception.
- **Git subprocess token bridge.** `github_clone_repository` is the ONE
  tool that hands the token to a child process. The token rides in an
  environment-injected `http.<host>/.extraheader`, never argv, never the
  remote URL, never `.git/config`, never logs. The subprocess dies with
  the operation.
- **Permission gate (optional).** `github-companion-gate` rejects write
  tool calls that match your `mode` × `action` policy; an exact-name
  exempt list lets read tools and the most-common writes run without
  prompting. **Fail-open posture**: under sandbox
  `danger-full-access` + approval `never`, the gate auto-allows — the
  alternative (ask) would deterministically resolve `'unavailable'` and
  translate the user's explicit "don't bother me" intent into a fake
  "user rejected tool" failure.
- **Actions cost guard** (`actionsGuardEnabled`, default **on**).
  `github_push_files` and `github_create_release` refuse when the
  target repo has `in_progress` Actions runs, and a per-tag cooldown
  (default 30 minutes) stops a debugging loop from repeatedly hitting
  the same tag. Fail-open on pre-flight API errors — a broken guard
  never blocks work. See [Actions cost guard](#actions-cost-guard).

## Settings UI

The plugin contributes one section to the DSH settings page (browser half
= `client.js`, exposed via the `dsh.client` manifest). It talks to the
official `settings.describe` / `settings.mutate` surface — no custom
RPC.

Two namespaces:

- **`github-tools`** (rendered as "GitHub" section): `enableIssueWrites`,
  `enableGitDataTools`, `enableRepoCreation`, `enableCloneTools`,
  `workspaceRoot`, `proxyUrl`, `actionsGuardEnabled`,
  `actionsGuardTagCooldownMinutes`, and the write-only `token` field.
- **`github-gate`** (rendered as "GitHub · Permission gate"): `mode`
  (`off|writes|all`), `action` (`ask|deny`), `excludeTools` (managed as
  removable pills, with common read-only suggestions).

Composition defaults come from the cordis.yml insert rows (`base` layer);
changes apply live.

UI-free equivalent — add user-layer sections to `~/.dsh/settings.yaml`:

```yaml
github-tools:
  enableGitDataTools: true
github-gate:
  mode: all
```

## Install

```bash
# published package (bundle channel — takes effect on restart)
dsh plugin add dsh-github-companion

# from a local checkout
dsh plugin add <your-checkout>/dsh-github-companion

# or pin a commit on a public repo
dsh plugin add github:owner/dsh-github-companion#<sha>
```

Then set your token (Settings → GitHub) and (optionally) remove the
`github-companion-gate` row from your profile's `cordis.patch.yml` if
you don't want the gate loaded.

## Actions cost guard

Private-repo Actions minutes are consumed by push-triggered workflow runs
in the `in_progress` state, billed per job with round-up. The 2026-08-28
incident showed how fast that burns: a misconfigured $0 budget locked
Actions and zombie-queued ~1500 minutes without doing any work. Since
v0.8.1 the plugin hard-guards the only push surface it controls:

- **`github_push_files`**: refuses with `push_guard_in_progress` (HTTP 409)
  and a list of running jobs when the target repository already has
  `in_progress` workflow runs. Stacking a push onto billed jobs wastes
  minutes that are already spent.
- **`github_create_release`**: the same in-progress check, plus a per-tag
  cooldown (`release_tag_cooldown`, HTTP 429, default 30 minutes) that
  stops rapid re-firing of the same tag while debugging a release
  pipeline. The window is consumed only by a successful creation.
- **Fail-open by design**: if the pre-flight API check itself errors
  (403/404/transport), the push proceeds — a broken guard must never
  wedge work. Billing endpoints are deliberately NOT consulted:
  fine-grained PATs get 403 there, so quota-based gating would be fake
  protection. The real circuit breaker is a GitHub-side **stop-usage
  budget** (the author runs a $20/month Actions budget; see the companion
  skill for the reasoning).

Configure via the settings UI (`github-tools` namespace) or
`~/.dsh/settings.yaml`:

```yaml
github-tools:
  actionsGuardEnabled: true            # default true
  actionsGuardTagCooldownMinutes: 30   # default 30, 0 = off
```

`actionsGuardRefuseOnInProgress` (default true) is composition-layer only.
Local `git push` bypasses the plugin process entirely and cannot be
intercepted — for that surface, install the companion skill below.

## Companion discipline skill (user-level, cross-workspace)

`skill/dsh-github-companion/` in this repository is a **user-level skill**
— copy it to `~/.dsh/skills/dsh-github-companion` and every DSH workspace
picks it up (unlike session memory, it survives workspace switches and
plugin upgrades):

```
~/.dsh/skills/dsh-github-companion/
├── SKILL.md                            # router: which file to read per task
└── references/
    ├── cost-discipline.md              # read before ANY push/tag/release
    ├── release-flows.md                # release chains, tag re-firing, drafts
    ├── incident-playbook.md            # CI red / hung runs / budget errors
    └── repo-hardening.md               # CI template for new private repos
```

It complements the plugin-exported `github-companion-usage` skill (tool
map & recipes) with what the plugin cannot enforce: cost discipline
(one push per round, no `push && push --tags`, CI-green-before-tag),
release chains (`publish-self` → `create-tag` → auto-release), an
incident playbook (npm ci infinite peer loop, budget lockouts, hung-run
cancellation), and the CI hardening template.

## Configuration (cordis.yml insert row)

```yaml
- insert:
    - id: github-tools
      name: dsh-github-companion
      config:
        credentialRef: GITHUB_TOKEN
        apiBaseUrl: https://api.github.com
        requestTimeoutMs: 30000
        maxRetries: 1
        maxPerPage: 30
        maxFileBytes: 262144
        enableIssueWrites: true
        enableGitDataTools: false
        enableRepoCreation: false
        actionsGuardEnabled: true
        actionsGuardRefuseOnInProgress: true
        actionsGuardTagCooldownMinutes: 30
        workspaceRoot: ''
        proxyUrl: ''
    - id: github-permission-gate
      name: dsh-github-companion/gate
      config:
        mode: writes                     # off | writes | all
        action: ask                      # ask (approval service) | deny
        excludeTools: [github_search_code, …]  # 11-tool author default
    - id: dsh-github-usage
      name: dsh-github-companion/skill
```

`id:` values are the **bundle identifiers** the loader tracks — they
keep the legacy `github-tools` / `github-permission-gate` / `dsh-github-usage`
naming so an existing `~/.dsh/settings.yaml` keeps working without
migration. Only the `name:` (the module path) follows the new package
name. This split keeps the rename a code change, not a settings
migration.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (83 tests, offline)
npm run test:coverage
npm run build       # emit lib/
node scripts/verify-load.mjs   # run inside a scratch profile dir after `dsh plugin add`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and PR flow;
security disclosure goes through [SECURITY.md](SECURITY.md).

## Boot-safety & recovery (verified by experiment)

What happens when things go wrong, measured on a real harness boot:

| Scenario | Result |
|---|---|
| Healthy insert rows | boots; model called `github_get_repository` live via a headless one-shot task |
| Schema-invalid config (e.g. string where number expected) | **entire profile refuses to boot**, exit 1, error names the exact row id and field — fail-closed by design |
| Valid config but `apply()` throws (e.g. malformed `credentialRef`) | same: boot refuses, stack trace names the plugin |
| Tool `execute()` throwing at runtime | contained by the tool registry as an `isError` result; harness keeps running |

The blast radius of a bad install is "this profile won't start until the
row is fixed or removed" — never a silent half-broken agent. Recovery:

```bash
# option 1: remove cleanly
dsh plugin --profile <name> remove dsh-github-companion

# option 2: hand-edit the profile's cordis.patch.yml (delete/fix the three rows)

# pre-flight before restarting your daily profile:
dsh --profile <name> --dump-config          # composition check
dsh --profile <name> "<one-shot task>"      # real boot check (headless-capable profiles)
```

The two injection overlays used to measure this live in
`scripts/bad-config.patch.yml` and `scripts/apply-throw.patch.yml` —
replay them against any scratch profile with
`dsh --profile <scratch> --patch <overlay> "<task>"`.

## License

MIT
