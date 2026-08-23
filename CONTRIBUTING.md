# Contributing to dsh-plugin-github

Thanks for your interest! This plugin follows the DeepSeek Harness (DSH)
plugin contract — if you are new to it, the `dsh-plugin-guide` skill / knowledge
base documents the plugin lifecycle, cordis.yml layers, and the tool DSL.

## Development setup

```bash
git clone <this repo>
cd dsh-plugin-github
npm install

npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest, offline (mocked fetch)
npm run build       # emit lib/
```

Optional live checks (need a GitHub token in `~/.dsh/settings.yaml` under
`github-tools.token`, or a `GITHUB_TOKEN` env var):

```bash
node scripts/smoke-live.mjs     # read-only real-API smoke
node scripts/publish-self.mjs   # pushes this repo's tracked files to GitHub
```

## Ground rules

- **No hardcoded tunables.** Anything changeable must be reachable from the
  cordis.yml insert row (`Config` schema) or the settings namespace.
- **Canonical results**: tool `execute()` returns JSON-safe values with a
  top-level `ok`. GitHub domain failures (404/422…) are returned as
  `{ ok: false, status, message }`, never thrown; only infrastructure
  failures throw.
- **Registration-is-effect**: everything applied through `ctx.effect` /
  `ctx.on` / register-return disposers so unloading cleans up completely.
- Waterfall listeners (`tools/pre-execute`) MUST call `next()` on the allow path.

## Testing expectations

- New tools ship with unit tests (route-based fake fetch — see
  `tests/tools.test.ts` for the pattern).
- Behavior changes update the affected tests; bug fixes add a regression test.
- `scripts/verify-load.mjs` must stay green (run it from any directory that
  resolves the package).

## Submitting changes

1. Fork / branch from `main`.
2. Keep commits focused; the PR description should state user-visible impact.
3. CI must pass (typecheck + tests + build on Node 20/22/24).
4. Bump `CHANGELOG.md` under an *Unreleased* heading when behavior changes.

## Reporting bugs

Open a GitHub issue with: what you asked the agent, which tools ran (names are
enough), expected vs actual result, and host version (`dsh --version`).
Never paste tokens — see [SECURITY.md](SECURITY.md).
