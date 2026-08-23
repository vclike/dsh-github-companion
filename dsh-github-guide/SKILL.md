---
name: dsh-github-usage
description: 如何正确驱动已安装的 dsh-plugin-github 工具集完成 GitHub 任务。只要会话中可用工具包含 github_get_me / github_search_repositories / github_push_files / github_create_repository 等任何 github_* 工具，或用户提出"上传项目到 GitHub / 建新仓库 / 管理 issue / 研究某个开源项目 / 看某仓库最近更新"类需求，先读本技能再动手——它包含能力开关地图、结果约定、权限前置、标准配方和故障速查，能避免反复试错（匿名限速、空仓推失败、重名 422、误建公开仓等）。
---

# 使用 dsh-plugin-github（agent 操作手册）

## 0. 动手前先探测一次

任何 GitHub 任务开始时先调 `github_get_me`：

- `authenticated: true` → 凭证可用，放开手脚（5000 req/h）。
- `authenticated: false` → 匿名模式：只能读公开数据且限速 60 req/h。继续做只读任务，
  同时提醒用户在设置界面保存 PAT 以解锁全部能力。

**克隆落点优先级**（涉及把仓库下载到本地时）：① 当前会话已打开的工作区目录 →
② 设置里的"默认克隆目录"（`workspace.workspace_root`，配合 `workspace.exists` /
`workspace.projects` 判断）→ ③ 都没有才询问用户。临时参考性质的克隆优先落在当前
工作区，不要污染用户的默认目录。

## 1. 能力与开关地图

| 层 | 工具 | 注册条件 | 备注 |
|---|---|---|---|
| 只读（常驻） | get_me / get_repository / get_file_contents / list_commits / search_repositories / search_code / search_issues / list_issues / get_issue / **list_releases** / **latest_release** / **list_starred** / **list_forks** / **list_watched** | 总是 | 匿名不可用：star/fork/watch 三张个人表 |
| Issue 写 | create_issue / update_issue / add_issue_comment | 开关默认开 | 每次弹审批 |
| Git 数据写 | list/get_pull_requests, create_branch, create_or_update_file, push_files, create_pull_request, **create_release**, **sync_fork** | 开关默认关 | 每次弹审批；sync_fork 仅快进合并，冲突报 merge_conflict |
| 建仓 | create_repository | 开关默认关 | 强制私有 |

工具没出现在会话里 = 对应开关没开。引导用户到 设置 → GitHub 区块打开，而不是硬猜。

## 2. 结果约定（所有工具一致）

- 成功：顶层 `ok: true` + 领域字段。
- 失败：`{ ok: false, status, message }`，**不会抛错**——按 status/message 分支处理，
  不要 try/catch 思维。
- 特判 `code: 'already_exists'`（建仓重名）：改用现有仓库或换名字重试即可，不算事故。
- `github_push_files` 成功返回 `commit_url`，向用户汇报时直接引用。

## 3. 权限前置速查（告诉用户配令牌时用）

| 操作 | Fine-grained PAT 需要 |
|---|---|
| 只读公开数据 | 无（匿名也行） |
| 读自己的私有仓 | Metadata R + Contents R |
| Issue 写 | Issues RW |
| 分支/提交文件/PR | Contents RW + Pull requests RW |
| **新建仓库** | **Administration RW** |

推荐配置：All repositories + 五权限全开（Metadata R / Contents RW / Issues RW /
Pull requests RW / Workflows RW）。Repository access 选 All repositories 时新建的仓
自动被覆盖，无需回来改令牌。

## 4. 标准配方

### A. 把本地项目传上新建私仓（最高频）

1. `github_create_repository { name, description }`——auto_init 默认 true 会带 README，
   保证后续推送有基线提交。返回 `{full_name, html_url, private:true}`。
2. 收集要上传的文件：排除 node_modules / 构建产物 / .git；单文件超过 ~250KB 先告知
   用户（工具默认上限 256KB）。
3. `github_push_files` 一次性原子提交所有文件到 `main`（branch 可省略，默认 main）。
   返回的 commit_url 汇报给用户。
4. 重名时收到 `already_exists`：问用户是"复用现仓追加"还是"换名重建"，别自作主张。

### B. 向已有仓库追加/更新文件

直接 `github_push_files`（多文件一次原子提交优于逐个 create_or_update_file）。
分支不存在会得到含指引的错误（空仓提示）——按提示先建初始提交。

### C. Issue 整理

批量前先 `github_list_issues` / `github_search_issues` 摸清现状，再逐条
create/update/comment。写操作每条都会弹审批，量大时先跟用户确认数量。

### D. 开源调研（无审批路径）

search_repositories / search_code / get_file_contents 组合即可读完一个公开项目的
README、目录与关键源码。匿名可做但限速紧；有令牌体验好得多。

### E. 开源追踪周报（多仓库情报汇总）

watchlist 来源（按优先级）：用户点名的 `owner/repo` 列表；用户说"用我 star 的
项目"时调 `github_list_starred` 获取；两者都没有时先问一句。

对确定下来的每个 `owner/repo`：

1. `github_latest_release` —— 返回 `{ok:true, has_releases:false}` 即"尚无发布"（正常
   状态，不是错误）；默认不带正文，需要读完整说明才传 `include_body:true`
2. `github_list_issues`（默认 open）—— 挑出互动多（评论多）或标题与用户兴趣相关的
3. 可选：`github_list_commits {since:'一周前 ISO 时间'}` 精确圈定一周活跃度
4. 按"每仓库一小节：最新版本 / 值得关注的 issue / 活跃度"输出汇总，最后给一句
   总体建议

分页约定：所有列表类结果都带 `has_more`/`next_page`——为 true 时数据未取全，按需
带 `page` 参数续拉，不要把单页结果当成完整列表。

注意：仓库多且未配置令牌时会撞 60 次/小时匿名限速——先探测凭证，超量时主动分批。

### F. 一句话发版（本地项目 → GitHub Release）

1. 和用户确认版本号（如 v1.3.0）；若项目有 package.json/版本文件，先用本地编辑把
   版本号改好
2. `github_push_files` 把全部改动（含版本文件）作为单个提交推到 main
3. `github_create_release { tag_name: 'v1.3.0', name, body: <变更说明> }` —— tag 不
   存在时会自动创建，一步完成打标+发版；返回的 html_url 汇报给用户
4. 收到 `tag_already_exists` 时**不要覆盖**：问用户是换下一个版本号还是基于已有
   tag 补说明

### G. Fork 上游巡检与同步

1. `github_list_forks` —— 返回你的全部 fork，`upstream_newer: true` 的即"上游有更新"
2. 向用户汇报陈旧清单（含上游仓库名），问哪些要同步
3. 对确认的每个：`github_sync_fork { owner: <你>, repo, branch: 'main' }` —— 仅快进
   合并；`merge_conflict` 时如实告知需手动处理，不要尝试强行覆盖
4. 同步属于写操作，每个都会弹审批

## 5. 硬边界（不要尝试）

- **建不了公开仓库**：工具强制 `private:true` 且没有可见性参数——这是设计而非缺陷。
  用户要公开时，指引其到网页 仓库 Settings → Danger Zone 手动切换。
- 没有"删除仓库/删除文件"工具；破坏性操作天然不在能力内。
- `push_files` 只快进（fast-forward），远端有新提交时会失败——重新拉取基线再推。

## 6. 故障速查

| 症状 | 含义 | 处置 |
|---|---|---|
| 401 | 令牌失效/被撤销 | 让用户重新生成并在设置里更新 |
| 403 + rate limit | 匿名限额或次级限制 | 等 Retry-After；建议配令牌 |
| 404 | 私有仓未授权或不存在 | 核对仓库名；检查令牌 Repository access 范围 |
| 422 already_exists | 重名 | 复用或改名（见配方 A.4） |
| 推送报"分支不存在" | 空仓库 | 建仓用 auto_init，或先造初始提交 |
| 工具根本不存在 | 开关未开 | 引导设置界面开启对应层 |

## 7. 审批预期

写操作（Issue/Git 数据/建仓）每次弹出审批确认是权限门的正常行为，如实向用户说明
"这一步需要你点允许"；用户拒绝就停，不要换工具绕过。
