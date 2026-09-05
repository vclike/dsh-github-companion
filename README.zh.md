# dsh-github-companion

DeepSeek Harness 上**完整**的 GitHub 集成包：**33 个原生 agent 工具** + **进程内权限门** + **按需加载的用法技能** + **独立安装的成本纪律 companion skill**——一次装齐。**完全不依赖 `gh` CLI**。

[English](README.md) | 中文

> 已在 DeepSeek Harness `0.1.2-rc.1` 上验证（见 `peerDependencies` 声明）；
> 宿主破坏性版本发布后会在此更新兼容结论。

## 包内三个挂载点

| 挂载点 | 作用 |
|---|---|
| `github-companion` | 在 `ctx.tools` 上注册 33 个 `github_*` 工具。读/发现恒开；写/克隆/建仓按开关启用。 |
| `github-companion-gate` | 宿主 `tools/pre-execute` 权限缝的工作示例。三种模式、三种动作、完全权限下 fail-open。 |
| `github-companion-usage` | 把仓库根的 `SKILL.md`（能力地图、结果约定、工作流配方、故障速查）作为一个按需 agent skill 加载。 |

加上用户手动安装到 `~/.dsh/skills/dsh-github-companion/` 的 **discipline companion skill**（含 `references/{cost-discipline,release-flows,incident-playbook,repo-hardening}.md`），负责插件强制不了的事：推送纪律、tag 时机、预算反应、CI 模板。

## 它能做什么？

用大白话跟 agent 说需求就行，工具由它自己挑：

| 你说… | agent 会… | 背后调用的工具 |
|---|---|---|
| "总结一下我 star 的项目这周有什么更新" | 遍历 star 列表，逐仓查最新版本和提交，汇总成周报 | `list_starred` · `latest_release` · `list_commits` |
| "某某仓库最近有什么新东西？" | 拉最新 release 说明、近期提交、热门 issue | `latest_release` · `list_commits` · `list_issues` |
| "把这个本地文件夹上传成一个私有仓库" | 建仓，然后一次性原子提交全部文件 | `create_repository` · `push_files` |
| "改掉 README 里的错别字，发个 v1.2.1" | 在 main 上改文件并打 tag 发版 | `push_files` · `create_release` |
| "我的 fork 哪些落后上游了？" | 逐个对比上游并报告，你点头后才同步 | `list_forks` · `sync_fork` |
| "给上游提个 issue 反馈这个 bug" | 写好标题正文，经你确认后提交 | `create_issue` |
| "看看某仓库的某个源码文件怎么实现的" | 直接读公开代码、搜代码，不用离开对话 | `get_file_contents` · `search_code` |

**安全模型** —— 读工具恒开；一切写操作（issue/分支/文件/发版/建仓）都经过权限门，先弹审批再执行；新建仓库**强制私有**；令牌不会进入子进程或日志（本地克隆工具开启时除外）。
没有令牌也能匿名只读公开数据（60 次/小时）。

## 为什么不包装 `gh` CLI

所有工具都直连 GitHub REST + GraphQL（fetch / undici）。`github_clone_repository` 唯一开 subprocess 调的是 `git`，不是 `gh`。选择直连的具体权衡：

| 维度 | 直连 REST（这个插件） | 包装 `gh` CLI |
|---|---|---|
| 外部依赖 | 零，跨平台一致 | 必须 PATH 有 `gh`，版本要对齐 |
| 多文件原子提交 | blob → tree → commit → ref 一次完成 | `gh` 无等价物——最接近是一次 `git push` 推一个文件 |
| Actions 成本防护 | 推送前 `GET /actions/runs?status=in_progress` 主动拦截 | `gh run list` 能做但多一次 shell round-trip |
| 限流处理 | 自家重试策略 + 读 backoff 头，可配置 | 依赖 `gh` 的 stderr 文本，脆弱 |
| 沙箱/Windows | 纯 JS，确定性强 | `gh.exe` 不一定在 headless / 沙箱里 |
| 可测性 | `fetchImpl` mock | subprocess 黑盒 |
| 排错 | 与 `curl -H "Authorization: Bearer …"` 同代码路径 | 要翻译 gh 输出格式 |
| GraphQL | 原生（`github_graphql` 走 REST 不到的字段） | `gh api graphql` 能做但要 shell 转义 |

如果未来真有部署需要 `gh`（例如 GHES 防火墙只放 SSH 不放 REST），加一个 `useGhCli` 兜底开关即可，默认仍然走 REST。

## 快速上手

```bash
dsh plugin add dsh-github-companion        # 装完重启 DSH
```

1. 打开 DSH 设置 → **GitHub** 区块
2. 粘贴令牌（[凭证](#凭证)一节有一键申请链接）→ 保存
3. 随口问一句 *"我最近 star 了什么？"* ——答得上来就配置完成

## 包内三个 cordis 挂载点

| 入口 | 插件 name | 用途 |
|---|---|---|
| `dsh-github-companion` | `github-companion` | 向 `ctx.tools` 注册 GitHub REST 工具 |
| `dsh-github-companion/gate` | `github-companion-gate` | 针对 `github_*` 工具的 `tools/pre-execute` 权限门示例 |
| `dsh-github-companion/skill` | `github-companion-usage` | 注册 `dsh-github-companion` 按需技能 |

### 工具清单（共 33 个，按开关注册）

**只读/发现** — 恒开：`github_get_me`、`github_get_repository`、`github_get_file_contents`、`github_list_commits`、`github_search_repositories`、`github_search_code`、`github_search_issues`、`github_list_issues`、`github_get_issue`、`github_list_releases`、`github_latest_release`、`github_list_starred`、`github_list_forks`、`github_list_watched`、`github_list_notifications`、`github_get_file_tree`（一次调用递归列出整棵目录树）、`github_list_my_repositories`（唯一包含你自己私有仓的清单工具）、`github_list_languages`、`github_list_contributors`、`github_list_tags`、`github_get_commit_activity`（近一年周度活跃度，含统计冷缓存处理）

**Issue 写操作** — 可开关（`enableIssueWrites`，默认开）：`github_create_issue`、`github_update_issue`、`github_add_issue_comment`

**Git 数据写操作** — 可开关（`enableGitDataTools`，默认**关**）：`github_list_pull_requests`、`github_get_pull_request`、`github_create_branch`、`github_create_or_update_file`、`github_push_files`、`github_create_pull_request`、`github_create_release`、`github_sync_fork`

**仓库自动创建** — 可开关（`enableRepoCreation`，默认**关**）：`github_create_repository` —— 一律创建**私有**仓库（工具不提供公开选项，公开请到网页手动操作）；需令牌的 Administration (rw) 权限。

规范返回值为 JSON 安全对象，带顶层 `ok` 字段。GitHub 领域错误（404/401/403/422…）以 `{ ok: false, status, message }` 返回而非抛出，模型可以编程化处理；只有网络故障才表现为工具错误。

## 凭证

配置只保存环境变量**名**（`credentialRef`，默认 `GITHUB_TOKEN`）。实际值通过 harness 凭证缝（`ctx.credentials`）每次请求前解析——在任意 provider 层设置该变量（本地 provider 读取 `~/.dsh/.env` 的 env 层，或在 shell 里 export），随时轮换，下一次请求即生效，无需重启。未配置 token 时工具以匿名模式访问公开仓库（核心限速 60 次/小时）；`github_get_me` 会如实报告该状态。

token 永不进入子进程环境或日志——唯一的、可开关的例外：`github_clone_repository` 会把 token 经环境变量注入的认证头交给单个本地 git 子进程（不进命令行参数、URL、`.git/config` 或日志），子进程随操作结束消亡，token 在 harness 之外零残留。

### 第一步 · 申请令牌（二选一）

**方式 A · 一键经典令牌（新手推荐）**

1. 登录 GitHub 后打开这个链接，插件所需的全部权限已自动预选：
   **https://github.com/settings/tokens/new?scopes=repo,workflow&description=dsh-github-companion**
2. 按需选择有效期（不选也行）
3. 拉到页面底部，点 **Generate token**
4. 复制生成的值（`ghp_` 开头），粘贴进插件设置卡片并保存

权衡：经典 `repo` 权限是账户级（全部仓库可读写），不能限定个别仓库；在意这点就用方式 B。

**方式 B · 细粒度令牌（可按仓库控制）**

申请入口：**https://github.com/settings/personal-access-tokens/new**（GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens）：

1. 填名称、选有效期
2. Repository access：**All repositories**——以后新建的仓库自动纳入覆盖，无需回来改令牌
3. 按下表勾选权限
4. 生成并复制（`github_pat_` 开头）

### 第二步 · 权限勾选对照（方式 B）

| 权限 | 用途 |
|---|---|
| Metadata **R** | API 必需 |
| Contents **RW** | 读文件、提交、分支、上传项目 |
| Issues **RW** | Issue 的创建/更新/评论 |
| Pull requests **RW** | PR 相关工具 |
| Workflows **RW** | 上传含工作流文件的项目时需要 |
| Administration **RW** | 自动新建仓库开关需要 |

推荐基线：前五项。只有打开建仓开关才追加 Administration RW；之后修改权限不会改变令牌值。

### 第三步 · 把令牌交给插件

- **设置界面**（推荐）：DSH 设置 → GitHub 区块 → 粘贴到 Token 输入框 → 保存。立即生效；界面永不回显已保存的值
- **环境变量**：定义 `GITHUB_TOKEN`（如写在 `~/.dsh/.env`），设置界面留空。轮换后下一次请求即生效

验证：问 agent 任意关于你 GitHub 账号的问题——`github_get_me` 应返回 `authenticated: true`（匿名模式返回 `false` 且只能读公开数据）。

> **存储说明**：经设置界面保存的 PAT 会以**明文**落在本机的 `~/.dsh/settings.yaml`（与该文档其余部分一致）。`role('secret')` 保护的是网络传输与界面回显，不是磁盘文件。若在意明文落盘，请改用环境变量方式（`credentialRef`），设置界面留空即可。

## 设置界面

三个挂载点各自注册设置命名空间，会渲染在 DSH 设置界面中：

- `github-tools`：`enableIssueWrites`、`enableGitDataTools`、`enableRepoCreation`、`enableCloneTools`、`workspaceRoot`（**默认克隆目录**——克隆落点优先级：当前会话的工作区 → 此目录 → 询问；目录不存在时自动创建。agent 通过 `github_get_me` 读取该路径与状态）、`proxyUrl`（访问 api.github.com 的可选 HTTP(S) 代理 ——Node 的 fetch 不读系统代理，需要时在此显式填写；改动实时生效）、**Actions 成本防护**开关 `actionsGuardEnabled` + `actionsGuardTagCooldownMinutes` （见下文 [Actions 成本防护](#actions-成本防护)）
- `github-gate`：`mode`（`off|writes|all`）、`action`（`ask|deny`）、`excludeTools`（设置卡片以胶囊形式增删，附常用只读工具建议）

组合层默认值来自 cordis.yml 插入行（`base` 层）；修改实时生效。

设置页的「GitHub」区块由本包自带的浏览器半（`client.js`，经 `dsh.client` manifest 暴露为 `/plugins/dsh-github-companion/client.js`）贡献，读写走官方 `settings.describe/mutate` 接口。注意：后端 `settings.register` 本身不产生 UI——每个设置区块都是客户端插件通过 `settings.section` 座位贡献的。

不经设置 UI 的等效做法：往 `~/.dsh/settings.yaml` 直接加用户层分节：

```yaml
github-tools:
  enableGitDataTools: true
  actionsGuardEnabled: true            # 默认 true
  actionsGuardTagCooldownMinutes: 30   # 默认 30；0 = 关闭
github-gate:
  mode: all
```

## 安装

```bash
# 已发布包（bundle 通道，重启后生效）
dsh plugin add dsh-github-companion

# 从本仓库的本地检出安装
dsh plugin add <你的检出目录>/dsh-github-companion   # 或 github:owner/repo#<sha>
```

然后设置 token；不需要权限门时，可从 profile 的 `cordis.patch.yml` 删掉 gate 那一行。

一个 bundle 一步装——v0.9.0 起包内自带按需加载的 agent 技能 `github-companion-usage`（能力开关地图、结果约定、令牌权限速查、工作流配方与故障手册），取代原先独立的 `dsh-github-guide` bundle。从旧版迁移：删掉 profile bundle 清单里的 `dsh-github-guide` 行及其 `node_modules` 链接（技能现在由主包以 `dsh-github-companion/skill` 入口提供）——两个挂载并存会把同名技能注册两次。

### Actions 成本防护

私有仓的 Actions 分钟由 push 触发的 workflow run 在 `in_progress` 状态消耗，**按 job 计费且向上取整**。2026-08-28 的事故展示了烧穿速度：一条配置错误的 $0 预算把 Actions 锁死，僵尸排队烧掉约 1500 分钟而没干任何活。v0.8.1 起插件在其能控制的唯一推送面上加了硬防护：

- **`github_push_files`**：目标仓已有 `in_progress` 的 workflow run 时拒绝，返回 `push_guard_in_progress`（HTTP 409）并列出运行中的 run——往已计费的 job 上叠推送，只会浪费已经花掉的分钟数
- **`github_create_release`**：同样的 in-progress 预检，外加同名 tag 冷却（`release_tag_cooldown`，HTTP 429，默认 30 分钟），防止调试发版流水线时疯狂重打同一个 tag。冷却窗口只在创建成功后计时
- **fail-open 设计**：预检 API 自身报错（403/404/网络断）时放行——防护自身的故障绝不能阻塞工作。Billing 接口有意不查：细粒度 PAT 在那里是 403，任何基于额度查询的熔断都是假防护。真正的断路器是 GitHub 侧的 **停用预算**（作者自跑 $20/月 Actions 预算；推理过程见配套技能）

配置方式（设置界面 `github-tools` 命名空间，或 `~/.dsh/settings.yaml` 用户层）：

```yaml
github-tools:
  actionsGuardEnabled: true            # 默认 true
  actionsGuardTagCooldownMinutes: 30   # 默认 30；0 = 关闭
```

`actionsGuardRefuseOnInProgress`（默认 true）仅组合层可调。**本地 `git push` 完全不经过插件进程**，无法被拦截——这层防护请安装下面的配套技能补齐。

### 配套实践技能（用户级，跨工作区）

仓库里 `skill/dsh-github-companion/` 是一个**用户级技能**——复制到 `~/.dsh/skills/dsh-github-companion` 后所有 DSH 工作区自动加载（不像会话记忆，它不随工作区切换丢失，也不随插件升级被覆盖）：

```
~/.dsh/skills/dsh-github-companion/
├── SKILL.md                        # 路由器：按任务告诉你读哪个分册
└── references/
    ├── cost-discipline.md          # 任何 push/tag/Release 之前必读
    ├── release-flows.md            # 发版链路、tag 重点火、草稿
    ├── incident-playbook.md        # CI 红 / run 卡死 / 预算报错
    └── repo-hardening.md           # 新私有仓 CI 加固模板
```

它补充插件导出的 `github-companion-usage` 技能（工具地图与配方）管不到的部分：**成本纪律**（一轮一推、禁 `push && push --tags`、先绿后 tag）、**发版链路**（`publish-self` → `create-tag` → 自动 Release）、**故障手册**（npm ci 无限 peer 循环、预算锁死、卡死 run 取消）与 **CI 加固模板**。SKILL.md 只是路由器——agent 按任务只读需要的分册，上下文最小化。

## 配置（cordis.yml 插入行）

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
        enableCloneTools: false
        actionsGuardEnabled: true
        actionsGuardRefuseOnInProgress: true
        actionsGuardTagCooldownMinutes: 30
        workspaceRoot: ''
        proxyUrl: ''
    - id: github-permission-gate
      name: dsh-github-companion/gate
      config:
        mode: writes
        action: ask
        excludeTools: [github_search_code, …]  # 11 项作者默认
    - id: dsh-github-usage
      name: dsh-github-companion/skill
```

`id:` 是 loader 跟踪的 **bundle 标识**，沿用历史命名（`github-tools` / `github-permission-gate` / `dsh-github-usage`），保证现有 `~/.dsh/settings.yaml` 无需迁移。只有 `name:`（模块路径）跟随新包名走。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run test:coverage
npm run build
node scripts/verify-load.mjs
```

贡献约定与 PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全披露走 [SECURITY.md](SECURITY.md)。

## 测试

四层，由快到全（不涉及任何付费服务——这里排的只是耗时和搭建成本）：

```bash
# L1 — 离线：类型 + 83 个单测（client/tools/gate，mock fetch）
npm run typecheck && npm test

# L2 — 包能被 profile 的 link 布局加载
dsh plugin --profile <scratch> add <你的检出目录>/dsh-github-companion
cd ~/.dsh/profiles/<scratch>
dsh --profile <scratch> --dump-config
node <你的检出目录>/dsh-github-companion/scripts/verify-load.mjs

# L3 — 真连 GitHub API 冒烟（只读；匿名即可）
node scripts/smoke-live.mjs

# L4 — 认证+写操作：用一个一次性仓库

# L5 — agent 级端到端：装进日常 profile 后直接问
```

## 启动安全与恢复（实测结论）

插件出问题时会发生什么，全部在真实 harness 启动上验证过：

| 场景 | 结果 |
|---|---|
| 配置行健康 | 正常启动 |
| schema 非法配置 | 整个 profile 拒绝启动，错误精确指到行 id 和字段 |
| 配置合法但 `apply()` 抛错 | 同样拒绝启动，堆栈点名插件 |
| 工具 `execute()` 运行时抛错 | 被工具注册表包含为 `isError` 结果，harness 继续运行 |

坏安装的爆炸半径是"这个 profile 在修好/删掉该行之前起不来"——绝不会静默变成半坏 agent。恢复手段：

```bash
dsh plugin --profile <name> remove dsh-github-companion
```

测量用的两个故障注入 overlay 在 `scripts/bad-config.patch.yml` 和 `scripts/apply-throw.patch.yml`，可对任何 scratch profile 重放。

## 许可

MIT
