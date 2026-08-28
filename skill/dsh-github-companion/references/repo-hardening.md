# 仓库侧兜底（给私有仓配 CI 时的模板）

dsh-plugin-github 的 `.github/workflows/` 已按此加固（2026-08-28），**改它之前先读这条**。给新私有仓配 CI 时照抄模式。

## CI 模板（ci.yml）

```yaml
name: CI
on:
  push:
    branches: [main]
    paths-ignore: ['**.md', 'docs/**', '_dev/**']   # 文档推送不触发 CI
  pull_request:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true          # 连续 push 自动取消旧 job，不堆积
jobs:
  verify:
    runs-on: ubuntu-latest          # 严禁 macos（倍率 x10）
    timeout-minutes: 10             # job 硬上限：挂死最多烧 10 分钟
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22, 24]          # matrix 注意：每个 job 独立计费+取整
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '${{ matrix.node }}', cache: npm }
      - name: Install dependencies
        timeout-minutes: 5          # 步骤级上限：挂死转失败
        run: npm ci
      - name: Retry install
        if: failure()               # 新进程重试，清间歇性挂起
        timeout-minutes: 5
        run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

## Release 模板（release.yml）要点

- 只监听 `push: tags: ['v*']` + `workflow_dispatch`（调试用，不烧 tag）；普通 CI **不要**监听 tag 事件。
- `concurrency: group: release-${{ github.ref }}` + `cancel-in-progress: true`。
- `timeout-minutes: 15`。
- 不配 `NPM_TOKEN` 就不发 npm（workflow 用 job 级 env 判断 secret 存在性）。

## 其他

- **npm 私有图死循环**：`@deepseek-ai/*` 系依赖的仓库，`.npmrc` 里 `legacy-peer-deps=true`（原因见 incident-playbook.md），勿删。
- **artifact**：不传则不用管；要传必须带 `retention-days: 7`（默认 90 天，500MB 存储池易爆）。
- **yaml 一律半角符号**；改完 workflow 后首次 push 观察一次完整 run 再离开。
