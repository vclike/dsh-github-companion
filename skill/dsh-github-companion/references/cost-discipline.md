# 成本纪律（push / tag / Release 之前必读）

## 计费真相

| 动作 | 消耗 |
|---|---|
| `git push` / `git push --tags` 触发 workflow → run 进入 in_progress | ✅ 烧分钟（**按 job 计，向上取整**；3-Node 矩阵一次 push ≈ 3 分钟起步） |
| run 处于 queued 排队 | ❌ 不计费（但会堆积，启动后开始计费） |
| 本地 commit / 本地构建 / 本地测试 | ❌ 免费 |
| GitHub API 读写（含 push_files 之外的读工具）、删 tag、API 重跑 | ❌ 免费 |
| Artifact 上传/存储 | 独立 500MB 存储池，另算 |

私有 Free 版：2000 Linux 等价分钟/月。macOS runner 倍率 ×10，Windows ×2，Linux ×1 —— **只用 ubuntu-latest**。

## 推送纪律

1. **一轮任务 = 一次 push**。所有修改本地聚合、本地验证通过后再推。dsh-plugin-github 本仓用 `node scripts/publish-self.mjs` 快照推送（天然单 commit）。
2. **禁组合命令** `git push && git push --tags`——两个独立步骤，tag 只在 CI 绿后推。
3. **只推 main**；功能分支不推远程。
4. **文档/注释/纯 md 改动**：能不推就不推（CI 已配 paths-ignore 不触发，但仍产生 commit 噪音）。
5. **push 前看在跑的 run**：插件 v0.8.1 起对 `github_push_files` / `github_create_release` 自动预检（有 in_progress → 拒绝，`push_guard_in_progress`）。走本地 git 推送时没有这层防护——自己先查：`GET /repos/{owner}/{repo}/actions/runs?status=in_progress`。
6. **先绿后 tag**：代码 push 后轮询 CI（常规 3-4 分钟，带重试的流水线最长 10 分钟），绿了才打 tag。红了打 tag = 双倍消耗 + 坏版本 Release。
7. **CI 失败禁止无脑重推**：先诊断（见 `incident-playbook.md`），修好再推。重推 N 次烧 N×分钟，根因不动永远红。

## 插件防护的语义（v0.8.1）

- 预检 **fail-open**：预检 API 自身出错（404/403/网络断）→ 放行。防护故障绝不阻塞工作。
- 拒绝结果携带 `code`：`push_guard_in_progress`（409）含运行中 run 清单；`release_tag_cooldown`（429）含剩余等待时间。
- 关闭方式（二选一）：设置 UI `github-tools.actionsGuardEnabled=false`；或 `~/.dsh/settings.yaml` 用户层同名键。tag 冷却时长：`actionsGuardTagCooldownMinutes`（默认 30，0=关）。
- **边界**：本地 `git push` 不经过插件进程，插件拦不住——这是本分册存在的原因。
