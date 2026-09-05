# Changelog

## 0.9.1 (2026-09-05)

Adapt to DeepSeek Harness `0.1.2-rc.1`. The four breakage points from the host
release — peer-dep string, the removed `settingsNamespace` helper, the
`JsonValue` re-export relocation, and the implicit `any` on the
`tools/pre-execute` waterfall — are each pinpointed below. The new `defineTool`
schema DSL is **backward-compatible** with the existing `parameters` / `output`
shape, so the 33 tool definitions (and their 83 unit tests) needed no
restructuring.

- `package.json`: peer-dep string broadened to `^0.1.0-rc.7 || ^0.1.1-rc.1 || ^0.1.2-rc.1`; `dsh-credentials` / `dsh-settings` / `dsh-tools` dependencies and the four dev peers (`dsh-{llm,scope,session,timeout}`) lifted to `>=0.1.2-rc.1`; added `dsh-util-values` to runtime deps.
- `src/index.ts` and `src/gate.ts`: dropped the now-removed `settingsNamespace` helper import and pass the namespace string directly to `ctx.settings.register(ns, schema, { base, applies })`. `Context.settings` augmentation is preserved via a side-effect `import type { SettingsProvider } from '@deepseek-ai/dsh-settings'`.
- `src/tools.ts`: split `JsonValue` off the `dsh-tools` import — it now lives in `@deepseek-ai/dsh-util-values`. `defineTool` and `ToolDefinition` stay on `dsh-tools`.
- `src/gate.ts`: explicit `(exec, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>` on the `tools/pre-execute` listener so the implicit-`any` lint check passes under the new strict-mode defaults.
- Verification: `pnpm typecheck` clean, `pnpm build` clean, `vitest run` 83/83 green, `node scripts/verify-load.mjs` confirms 24 default tools + 33 after the live settings flip + the `github-tools` settings namespace + the gate's waterfall + the `dsh-github-usage` skill all register.
- Bundle mount unchanged: still three rows (`github-tools`, `github-permission-gate`, `dsh-github-usage`) per the plugin's own `cordis.patch.yml`.

## 0.9.0 (2026-08-28)

One bundle, one install: the standalone `dsh-github-guide` bundle (which did
nothing but register the `dsh-github-usage` skill) is merged into the main
package. Every install now carries tools + settings + permission gate +
usage skill in a single bundle row.

- New entry point `dsh-plugin-github/skill` (`src/skill.ts`) registers the
  `dsh-github-usage` skill from the package-root `SKILL.md` through the
  `skills` service — same mount pattern as the gate row, same SKILL.md
  content as the former guide.
- `cordis.patch.yml` gains a third insert row (`dsh-github-usage` →
  `dsh-plugin-github/skill`). The tools and gate entries are untouched — a
  profile without the `skills` service at worst loses the skill, never the
  tools.
- **Migration (previously installed guide)**: remove the
  `dsh-github-guide` row from your profile's bundle list and its
  `node_modules` link, then restart. Keeping both mounts registers the same
  skill name twice.
- The `dsh-github-guide/` subpackage is removed from the repository; the
  user-level `skill/dsh-github-companion/` is unaffected (it is copied to
  `~/.dsh/skills/`, not bundled).
- Verification: 83 unit tests + extended `verify-load.mjs` now asserting
  the skill entry registers with non-trivial content and a disposer.

## 0.8.1 (2026-08-28)

Actions-cost guard: stop burning private-repo Actions minutes at the only
surface the plugin controls. Motivated by the 2026-08-28 incident where a
$0 stop budget locked Actions and zombie-queued ~1500 minutes of the monthly
quota without doing any work.

- **`github_push_files` pre-flight**: refuses (`push_guard_in_progress`, 409)
  when the target repository already has `in_progress` workflow runs, listing
  them — a push that stacks onto billed jobs wastes already-spent minutes.
- **`github_create_release` pre-flight**: same in-progress check, plus a
  per-tag cooldown (`release_tag_cooldown`, 429; default 30 minutes) against
  rapid re-firing of the same tag while debugging. The cooldown window is
  consumed only by a successful creation.
- **Fail-open by design**: a broken pre-flight (403/404/transport error)
  never blocks work — the guard only refuses when it can *prove* runs are
  active. Billing APIs are intentionally NOT consulted: fine-grained PATs
  get 403 there, so any quota-based gate would be fake protection.
- **Config** (settings UI `github-tools` namespace or `~/.dsh/settings.yaml`
  user layer): `actionsGuardEnabled` (default true),
  `actionsGuardTagCooldownMinutes` (default 30, 0 = off); composition layer
  additionally seeds `actionsGuardRefuseOnInProgress` (default true).
- **Companion skill ships with the repo** (`skill/dsh-github-companion/`):
  copy it to `~/.dsh/skills/dsh-github-companion` for cross-workspace agent
  discipline — cost rules, release flows, incident playbook, CI hardening
  template, organized as a router with per-task reference files.
- 9 new tests (guard refusal, fail-open, user-layer opt-out, cooldown
  windows); 81 total green.

## 0.8.0 (2026-08-28)

Bakes the author's own approval-free posture into the gate defaults, so a
fresh install starts friction-free for the same tool set the author runs.

- `github-gate.excludeTools` schema default (composition layer AND settings-UI
  section) changes `[]` → 11 tools: all read tools (`github_search_code`,
  `github_search_repositories`, `github_latest_release`, `github_list_issues`,
  `github_list_starred`, `github_list_forks`, `github_get_me`,
  `github_get_file_contents`) plus the write trio the author keeps ungated
  (`github_create_repository`, `github_push_files`, `github_create_release`).
- Content mutations (`update_issue`, `create_branch`, `create_pull_request`,
  `sync_fork`, …) and `github_clone_repository` remain gated by default.
- UI "reset to default" on the exempt list now restores the 11-tool posture
  instead of an empty list. Existing user-layer settings are untouched — the
  change only affects fresh installs and resets.
- READMEs document the new default in the cordis.yml example.

## 0.7.0 (2026-08-24)

Internalizes the core of deer-flow's github-deep-research skill (issue-free
dogfooding follow-up to #2).

- Four new always-on read tools close the last research gaps:
  `github_list_languages` (byte shares sorted desc), `github_list_contributors`
  (ranked by contributions, paginated), `github_list_tags`, and
  `github_get_commit_activity` — including correct handling of GitHub's
  lazy stats endpoint (202 cold cache surfaces as `pending: true` with retry
  guidance instead of an empty-looking result).
- Usage skill gains 配方 I: the four-round deep-research methodology mapped
  onto native plugin tools for round one (authenticated, 5000 req/h vs the
  script's anonymous 60 req/h), with web rounds kept in the harness; report
  structure, confidence tiers, and inline-citation rules condensed.
- Tool count 29 → 33; tests 65 → 71.

## 0.6.0 (2026-08-24)

Implements the high-value items of issue #2 (dogfooding retro).

- New `github_get_file_tree`: one recursive Git-Data call lists the whole
  tree under a ref (default branch resolved automatically). Upstream
  truncation maps to `truncated: true` plus next-action guidance; entries
  capped at 1000 locally with an explicit note.
- New `github_list_my_repositories`: `/user/repos` with
  visibility/affiliation/sort — the first discovery surface that includes
  the user's own PRIVATE repositories.
- `github_get_repository` now projects `permissions` ({admin,push,pull};
  null when unknown/anonymous) and `archived`, so write tools can be
  self-checked before hitting a 403.
- Clone tool passes the live proxy through as HTTPS_PROXY/HTTP_PROXY to its
  git subprocess — API proxying never implied git proxying (issue #2 §6).
- Skill triggers now cover clone/checkout/download phrasing (guide source
  and installed copy); READMEs document the empty-path-lists-root behavior
  of get_file_contents and grow to 29 tools.

Deferred by design (recorded on issue #2): inline-PAT migration into the
credential-seam storage layer (needs host provider write capability),
tarball export, and the gh-CLI integration (ruled out in appendix A).

## 0.5.0 (2026-08-24)

Implements issue #1 — `github_clone_repository` (方案 1).

- New switchable clone tool (`enableCloneTools`, default off): clones any
  accessible repo — private included — to a local directory using the
  machine's git, closing the gap that left agents detouring into Git
  Credential Manager queries on sandboxed private-clone attempts.
- Credential bridge by env-injected `http.<host>/.extraheader` basic header
  (the official actions/checkout mechanism): token touches neither argv nor
  the remote URL nor `.git/config` nor stderr/logs; `credential.helper=`
  is force-cleared; the env block lives only for the single subprocess.
- Structured error matrix with next-action messages: `git_not_found`,
  `auth_failed`, `not_found`, `already_exists`, `empty_repo` (with
  half-clone cleanup), `tls_backend_failed`; schannel failures auto-retry
  once over openssl unless a backend is pinned (`gitSslBackend`).
- Landing spot honors the long-promised priority: explicit `targetPath` →
  settings 默认克隆目录/`workspaceRoot` → structured guidance; `ref` and
  opt-in `depth` forwarded; `exec.signal` and `gitTimeoutMs` enforced.
- REST→git host mapping handles both api.github.com and GHES /api/v3 roots.
- L1 suite grows to 58 tests incl. hard no-token-leak assertions over argv,
  env, and canonical results; settings UI gains a 本地克隆工具 toggle;
  bilingual READMEs updated including the revised token-subprocess promise.

## 0.4.10 (2026-08-23)

- Approval prompts are now Chinese-first and self-explanatory: each gated
  ask carries a plain-language action label (e.g. 「一次性提交多个文件到仓库」)
  next to the tool name and gate mode; denials explain where to adjust.
- No behavior change — wording only.

## 0.4.9 (2026-08-23)

The gate now understands the session's trust posture.

- Under the bundled **Full access** preset (sandbox danger-full-access AND
  approval policy never) there is no prompt channel — every gated ask used
  to fail downstream misreported as "the user rejected tool". The gate now
  recognizes that exact two-knob posture and auto-allows its asks: full
  access finally means the plugin writes flow, matching what the preset
  promises.
- Any other knob combination (default ask, explicit deny, or custom pairs
  like read-local-files + no-prompting) keeps the previous behavior — mixed
  postures do not express blanket trust for remote writes.
- Usage skill documents both this and the "auto-rejected without a prompt"
  playbook (exempt the tool; do not detour through bash git).

## 0.4.8 (2026-08-23)

From a full read-path smoke test of every tool against the live API.

- `github_list_issues` now reports `prs_excluded` and adds an explicit note
  when a page contained only pull requests — previously an all-PR page was
  indistinguishable from "no issues exist" (seen live on a repo where 9 of
  10 entries were PRs).
- Smoke-test verdicts for the rest: `get_repository`, `get_file_contents`
  (file / directory / 404), all three searches, `list_issues`, `get_issue`,
  `latest_release`, `list_starred/forks/commits` behave correctly; one
  repo's `/pulls` endpoint 404s upstream (its own setting) and the tool
  passes that through honestly — not a plugin bug.

## 0.4.7 (2026-08-23)

Close out every finding from the live-use audit — one batch, no leftovers.

- **New read tool `github_list_notifications`**: the watch inbox (unread by
  default, `all:true` for everything, `participating` filter, pagination
  fields). Watching now has its missing half.
- **Transient network retries**: one-shot DNS/connection blips (seen live as
  `fetch failed`) now consume the same `maxRetries` budget as rate limits
  instead of failing the call immediately; aborts never retry.
- **Host compatibility declared**: `peerDependencies` pin
  `^0.1.0-rc.7 || ^0.1.1-rc.1`, both READMEs state the verified host
  version — the openpencil-style silent drift cannot happen unnoticed here.
- README tool counts corrected to 26 in English and Chinese.

## 0.4.6 (2026-08-23)

Fixes found by live use (star digest + fork/watch audit), plus pagination
awareness across every list tool.

- `github_list_watched`: hit the correct endpoint `/user/subscriptions`
  (bare `/subscriptions` 404s) and map entries as repository objects — the
  endpoint returns repos directly, not subscription wrappers, so previous
  results were all null.
- `github_list_forks`: list responses omit `parent`, leaving
  `upstream_newer` always false. Fork sets of ≤10 are now enriched via
  single-repo detail fetches; larger sets carry an explicit note instead of
  silent staleness.
- `github_latest_release`: a repo with no releases now resolves
  `{ok:true, has_releases:false}` instead of an error-shaped 404; notes
  body omitted by default (`include_body:true` to opt in) so multi-repo
  scans stop flooding context.
- `github_list_commits`: new `since`/`until` ISO filters for precise
  windows (weekly digests no longer over-fetch).
- All list tools (`starred/forks/watched/releases/issues/commits`) now
  report `has_more`/`next_page` parsed from the Link header and accept a
  `page` parameter — silent truncation is gone.

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
