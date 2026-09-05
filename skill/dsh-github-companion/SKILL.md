---
name: dsh-github-companion
description: dsh-plugin-github 的配套实践技能（成本防护 + 发版流程 + 故障处置）。凡是计划 git push / 打 tag / 发版 / 创建 Release / 建 workflow / 触发 GitHub Actions，或会话中出现 github_push_files、github_create_release 等写工具，或用户提到"额度 / 分钟 / 扣费 / Actions 浪费 / CI 挂了 / run 卡住"，先读本技能再动手——按需只读对应分册，防止把私有仓月度免费分钟烧穿（2026-08-28 事故：$0 预算锁死 + 僵尸排队烧掉 1500 分钟）。
---

# dsh-github-companion — dsh-plugin-github 配套实践

**分工（不重复）**：工具能力地图、结果约定、凭证前置、权限开关 → 读插件自带技能 `dsh-github-usage`。本技能管插件不管的另外三件事：**成本纪律**（怎么不把免费额度烧穿）、**发版流程**（两条链路怎么选）、**故障处置**（出事先做什么）。

## 三条铁律（任何 GitHub 写操作前默查，无需读分册）

1. **一轮任务 = 一次 push**：所有修改本地聚合、本地验证（typecheck/test/build）通过后再推。
2. **永远禁止组合命令** `git push && git push --tags`：代码与 tag 必须是两个独立步骤。
3. **禁用 macOS runner**（倍率 ×10）；CI 一律 ubuntu-latest。

## 按需分册（完成什么任务读什么，不要一次全读）

| 你正要做的任务 | 读这份 |
|---|---|
| push / 打 tag / 创建 Release 之前（成本核对） | `references/cost-discipline.md` |
| 发版、发 Release、调试发版流水线 | `references/release-flows.md` |
| CI 红了 / run 卡死 / 报额度类错误 / Actions 停摆 | `references/incident-playbook.md` |
| 给新仓库配 CI / 修改 workflow yaml | `references/repo-hardening.md` |

## 插件侧硬防护（v0.8.1 起，自动生效，无需你记得）

- `github_push_files`：推前自动查目标仓 `in_progress` 的 Actions run，有 → 拒绝（`push_guard_in_progress`），列出运行中的 run。防"叠推烧已计费分钟"。
- `github_create_release`：同样的 in-progress 检查 + 同名 tag 冷却（默认 30 分钟，`release_tag_cooldown`）。防"调试狂打 tag"。
- **fail-open 设计**：预检 API 出错（404/403/网络）时放行——防护自身故障绝不阻塞工作。
- 关闭/调整：设置 UI `github-tools` 区 `actionsGuardEnabled` / `actionsGuardTagCooldownMinutes`，或 `~/.dsh/settings.yaml` 用户层同名键。

注意：**本地 `git push` 不经过插件**，防护只覆盖 API 推送面；本地推送纪律靠本技能约束 agent 行为。

## 权限门完全权限姿势（v0.9.2 起，自动生效）

`github-permission-gate` 在以下任一情况会**自动放行**（不弹窗、不问、不返回 ask）：

- `ctx.approval` 服务未挂载（旧 host / 极简 headless）
- `ctx.approval.config.policy === 'never'`（完全权限运行）

底层原理：policy=never 的字面语义是"永远别问我"——任何 `kind: 'ask'` 都会被确定性拒绝为 `'unavailable'`，旧版 gate 误把这条翻译成"用户拒绝工具"。v0.9.2 改判 fail-open，避免在完全权限场景下产生假拒绝。

**对 agent 的实际含义**：当用户用 `sandboxMode: danger-full-access + approval policy: never`（或在 CI/headless 无 approval 服务）跑 dsh 时，**所有 33 个 github_* 工具（含 push_files、create_release、create_repository、clone）都直接可用**，没有任何弹窗。

**完全权限下的真正安全层**（gate 在该姿势下失效，这些是兜底）：
1. **token scope**：用 fine-grained PAT 限定仓库与权限（不要用 classic `repo` 全权）
2. **`actionsGuardEnabled`**（已默认开）：防 push/release 叠触发 Actions 分钟
3. **`actionsGuardTagCooldownMinutes`**（已默认 30 分钟）：防 agent 循环反复打 tag
4. **dsh host audit log**：所有工具调用参数与返回值有据可查
5. **dsh file sandbox**：非 danger-full-access 时 `workspace-write` 把 agent 文件操作限制在工作区

如果用户用 `mode: writes` 配了 `excludeTools`，那些工具在该姿势下直接走 exclude 分支（更早的 pass-through），不经过 fail-open 判断。
