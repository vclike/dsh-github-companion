# 发版流程（三条链路怎么选）

## 模式速查

| 模式 | 做法 | 消耗 |
|---|---|---|
| 🔵 日常调试 | 本地改 + 本地验；**不 push 不打 tag**；要试 workflow 用 `workflow_dispatch` 手动触发 | 0 |
| 🟢 正常交付 | 单次 push（不打 tag）；版本号/CHANGELOG 本地就位 | CI 一次（~3-4 分钟） |
| 🔴 正式发版 | CI 绿 → **独立**推 tag → release workflow 自动建 Release | CI + Release 两次（~7 分钟） |
| 草稿/预览 | API 建 draft Release（无 tag、零消耗），正式时再补 tag | 0 |

非正式交付**禁止推 tag**——每次 tag 触发 release workflow（~4 分钟）且污染 Release 页面。

## dsh-plugin-github 本仓的两条发版链路

**链路 A（日常，推荐）**：本地 commit → `node scripts/publish-self.mjs`（快照推送全部 tracked 文件为单 commit 到远端 main）→ `node scripts/create-tag.mjs vX.Y.Z`（给远端 main 打 tag → release.yml 自动 typecheck/test/build + 建 GitHub Release）。

**链路 B（断路兜底）**：release workflow 不可用时，`github_create_release` 工具直连 API 一步建 tag+Release。注意 v0.8.1 起该工具有同名 tag 冷却（默认 30 分钟）——重发同版本要么等冷却，要么走链路 A 换 tag。

**重触发某 tag 的 Release workflow**（tag 已存在、workflow 曾失败时）：

```
DELETE /repos/{owner}/{repo}/git/refs/tags/vX.Y.Z   # 先删远端 tag
node scripts/create-tag.mjs vX.Y.Z                  # 再重建（指向当前 main）
```

重触发会重跑 softprops 并用自动生成 notes **覆盖**既有 Release 正文——发布前先把正文存档（GET /releases/tags/vX.Y.Z），跑完 PATCH 还原。

## 版本号纪律

- `package.json` bump 与 `CHANGELOG.md` 手写条目进同一个发版 commit。
- tag 命名 `v*`（release.yml 只监听 `v*`）。
- 破坏性变更（工具参数/结果契约变化）→ 主/次版本号 + CHANGELOG 顶部标注。
