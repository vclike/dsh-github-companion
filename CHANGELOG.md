# Changelog

## 0.4.5 (2026-08-23)

Fix: picked folder never reached the input.

- Root cause: `host.pickDirectory` rides `callUnary`, which wraps every
  response as `{ result: { ok, value } }` — the path lives at
  `result.value.path`. The previous unwrap stopped one layer short and
  treated the real pick as a cancel. Full unwrap chain implemented
  (envelope → ok check → value → path).

## 0.4.4 (2026-08-23)

Fix: folder picker was a silent no-op.

- Root cause: the browse button probed `api.workspaces.pickDirectory`, a
  namespace that does not exist on the client connection; the real surface
  is `host.pickDirectory` (returns `{ path }`, null = cancelled). Rewired
  to the correct RPC and made failures visible next to the input instead
  of swallowing them.

## 0.4.3 (2026-08-23)

Settings card restyled to the shipped design language.

- Adopted the official settings-row tokens (`--dsw-alias-border-l2`,
  `label-primary/tertiary`, `bg-module-platform`, `interactive-bg-hover`):
  separator rows, pill controls without hard borders, 14px titles / 12px
  tertiary descriptions.
- Token row button states: unset → [保存][提示]; set → [保存][清除]. The
  beginner guidance lives only behind 提示 and disappears once a token is
  saved.
- Exempt-tool pills: fixed cramped spacing, per-tool hover tooltips
  (one-line Chinese descriptions for every tool), and a transient feedback
  line on add/remove ("已免审批/已恢复审批：…").

## 0.4.2 (2026-08-23)

Settings-card UX pass from first real usage.

- Default clone directory: renamed from 本地工作区目录, native folder-picker
  button (host `workspaces.pickDirectory`), and clone-destination priority
  codified in the usage skill: current session workspace → configured
  directory → ask.
- GitHub Token: long inline guidance moved into a ？ help popover; the
  one-click classic-token link now states it covers every plugin feature
  (repo + workflow scopes include repo creation).
- Exempt tools: pill UI — removable chips for current entries plus one-tap
  suggestions for common read-only tools (replaces comma-separated input).
- Usage skill documents the workspace probe (`workspace.exists/projects`).

## 0.4.1 (2026-08-23)

Settings-card polish + workspace probe.

- `github_get_me` now probes the configured `workspaceRoot` on the local
  filesystem and reports `workspace: { exists, projects[] }` (dot-folders
  skipped, capped at 50 entries) — the agent can answer "what's in my
  workspace" without new tools.
- Settings card: workspace-root row shows a 已设置/未设置 badge.
- Fixed: token row layout jumped when the 清除 button appeared after saving
  (space-between redistribution); input+button rows now use a stable
  flex-start layout.

## 0.4.0 (2026-08-23)

Workspace convention + proxy support.

- New settings (user-editable, live-applied): `workspaceRoot` — the local
  root directory for cloned/checked-out repositories, surfaced to the agent
  via `github_get_me.workspace_root` so recipes never have to ask; and
  `proxyUrl` — optional HTTP(S) proxy for api.github.com routed through
  undici's ProxyAgent (Node's fetch ignores system proxy settings). Both
  also settable as composition-layer defaults in cordis.yml.
- Settings card gains two text rows for the new fields.

## 0.3.0 (2026-08-23)

Fork / watch tracking + one-command fork sync.

- New read tools (always on): `github_list_forks` (your forks with upstream
  freshness hint — parent repo, pushed_at comparison, `upstream_newer` flag)
  and `github_list_watched` (notification subscriptions).
- New write tool: `github_sync_fork` — official merge-upstream endpoint;
  fast-forward only, structured `merge_conflict` code on 409, friendly
  already-up-to-date result on 204. Sits under the Git-data switch and the
  permission gate.
- Usage skill: recipe G (fork upstream patrol & sync); digest recipe can now
  draw its watchlist from starred repos.

## 0.2.1 (2026-08-23)

- New read tool: `github_list_starred` — repositories the authenticated user
  has starred; the natural watchlist for tracking digests. Anonymous mode
  cannot call it.
- Usage skill: weekly-digest recipe defaults its watchlist to starred repos
  when the user does not name repositories explicitly.

## 0.2.0 (2026-08-23)

Release tooling + digest/release recipes.

- New read tools (always on): `github_list_releases`, `github_latest_release`.
- New write tool: `github_create_release` — auto-creates the tag from
  `target_commitish` when missing; structured `tag_already_exists` code.
  Sits under the Git-data switch and the permission gate like other writes.
- Duplicate detection hardened: GitHub signals duplicates via
  `errors[].code = 'already_exists'` (underscored) — both release and
  repository creation now honor that shape.
- Usage skill (`dsh-github-usage`): new recipes E (multi-repo weekly digest)
  and F (one-sentence release pipeline).
- CI hardening from first real runs: workflow-level env gate for optional npm
  publish (`secrets` is not usable in step-level `if`), actions v5.

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
