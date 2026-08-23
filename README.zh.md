# dsh-plugin-github

DeepSeek Harness 插件：为 agent 提供原生 GitHub REST 工具，附一个配套的
permission-gate 示例插件。

[English](README.md) | 中文

## 你会得到

一个包里的两个 cordis 插件：

| 入口 | 插件名 | 用途 |
|---|---|---|
| `dsh-plugin-github` | `github-tools` | 向 `ctx.tools` 注册 GitHub REST 工具 |
| `dsh-plugin-github/gate` | `github-permission-gate` | 针对 `github_*` 工具的 `tools/pre-execute` 权限门示例 |

### 工具清单（共 22 个，按开关注册）

**只读/发现** — 恒开：
`github_get_me`、`github_get_repository`、`github_get_file_contents`、
`github_list_commits`、`github_search_repositories`、`github_search_code`、
`github_search_issues`、`github_list_issues`、`github_get_issue`、
`github_list_releases`、`github_latest_release`、`github_list_starred`

**Issue 写操作** — 可开关（`enableIssueWrites`，默认开）：
`github_create_issue`、`github_update_issue`、`github_add_issue_comment`

**Git 数据写操作** — 可开关（`enableGitDataTools`，默认**关**）：
`github_list_pull_requests`、`github_get_pull_request`、`github_create_branch`、
`github_create_or_update_file`、`github_push_files`、`github_create_pull_request`、
`github_create_release`

**仓库自动创建** — 可开关（`enableRepoCreation`，默认**关**）：
`github_create_repository` —— 一律创建**私有**仓库（工具不提供公开选项，公开
请到网页手动操作）；需令牌带 Administration (rw) 权限。

规范返回值为 JSON 安全对象，带顶层 `ok` 字段。GitHub 领域错误
（404/401/403/422…）以 `{ ok: false, status, message }` 返回而非抛出，模型可以
编程化处理；只有网络故障才表现为工具错误。

## 凭证

配置只保存环境变量**名**（`credentialRef`，默认 `GITHUB_TOKEN`）。实际值通过
harness 凭证缝（`ctx.credentials`）每次请求前解析——在任意 provider 层设置该
变量（本地 provider 读取 `~/.dsh/.env` 等 env 层，或在 shell 中 export），
随时轮换，下一次请求即生效，无需重启。未配置 token 时工具以匿名模式访问公开
仓库（核心限速 60 次/小时）；`github_get_me` 会如实报告该状态。

token 永不进入子进程环境或日志。

### 第一步 · 申请令牌（二选一）

**方式 A · 一键经典令牌（新手推荐）**

1. 登录 GitHub 后打开这个链接，插件所需的全部权限已自动预选：
   **https://github.com/settings/tokens/new?scopes=repo,workflow&description=dsh-plugin-github**
2. 按需选择有效期（不选也行）。
3. 拉到页面底部，点 **Generate token**。
4. 复制生成的值（`ghp_` 开头），粘贴进插件设置卡片并保存。

权衡：经典 `repo` 权限是账户级（全部仓库可读写），不能限定个别仓库；在意这点
就用方式 B。

**方式 B · 细粒度令牌（可按仓库控制）**

申请入口：**https://github.com/settings/personal-access-tokens/new**
（GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens）：

1. 填名称、选有效期。
2. Repository access 选 **All repositories**——以后新建的仓库自动纳入覆盖，
   无需回来改令牌。
3. 按下表勾选权限。
4. 生成并复制（`github_pat_` 开头）。

### 第二步 · 权限勾选对照（方式 B）

| 权限 | 用途 |
|---|---|
| Metadata **R** | API 必需 |
| Contents **RW** | 读文件、提交、分支、上传项目 |
| Issues **RW** | Issue 的创建 / 更新 / 评论 |
| Pull requests **RW** | PR 相关工具 |
| Workflows **RW** | 上传含工作流文件的项目时需要 |
| Administration **RW** | 仅"自动新建仓库"开关需要 |

推荐基线：前五项。只有打开建仓开关才追加 Administration RW；之后修改权限
不会改变令牌值。

### 第三步 · 把令牌交给插件

- **设置界面**（推荐）：DSH 设置 → GitHub 区块 → 粘贴进 Token 输入框 → 保存。
  立即生效；界面永不回显已保存的值。
- **环境变量**：定义 `GITHUB_TOKEN`（如写在 `~/.dsh/.env`），设置界面留空。
  轮换后下一次请求即生效。

验证：问 agent 任意关于你 GitHub 账号的问题——`github_get_me` 应返回
`authenticated: true`（匿名模式返回 `false` 且只能读公开数据）。

> **存储说明**：经设置界面保存的 PAT 会以**明文**落在本机
> `~/.dsh/settings.yaml`（与该文档其余部分一致）。`role('secret')` 保护的是
> 网络传输与界面回显，不是磁盘文件。若在意明文落盘，请改用环境变量方式
> （`credentialRef`），设置界面留空即可。

## 设置界面

两个插件各自注册了设置命名空间，会渲染在 DSH 设置界面中：

- `github-tools`：`enableIssueWrites`、`enableGitDataTools`、`enableRepoCreation`
- `github-gate`：`mode`（`off|writes|all`）、`action`（`ask|deny`）、`excludeTools`

组合层默认值来自 cordis.yml 插入行（`base` 层）；修改实时生效。

设置页的「GitHub」区块由本包自带的浏览器半（`client.js`，经 `dsh.client`
manifest 暴露为 `/plugins/dsh-plugin-github/client.js`）贡献，读写走官方
`settings.describe/mutate` 接口。注意：后端 `settings.register` 本身不产生
UI——每个设置区块都是客户端插件通过 `settings.section` 座位贡献的。

不经过 UI 的等效做法：在 `~/.dsh/settings.yaml` 直接加用户层分节：

```yaml
github-tools:
  enableGitDataTools: true
github-gate:
  mode: all
```

## 安装

```bash
# 已发布包（bundle 通道 — 重启后生效）
dsh plugin add dsh-plugin-github

# 从本仓库的本地检出安装
dsh plugin add <你的检出目录>/dsh-plugin-github   # 或 github:owner/repo#<sha>
```

然后设置 token；不需要权限门时，可从 profile 的 `cordis.patch.yml` 删掉
gate 那一行。

### 配套使用技能（推荐）

仓库内的 `dsh-github-guide/` 是一个迷你 bundle，注册按需加载的 agent 技能
`dsh-github-usage`——能力开关地图、结果约定、令牌权限速查、工作流配方
（上传项目→私仓）与故障手册。建议一并安装：

```bash
dsh plugin add <你的检出目录>/dsh-plugin-github/dsh-github-guide
```

装了它的 agent 不会再对匿名限速、空仓推送、重名处理、公开仓边界反复试错。

## 配置（cordis.yml 插入行）

```yaml
- insert:
    - id: github-tools
      name: dsh-plugin-github
      config:
        credentialRef: GITHUB_TOKEN      # 存放 PAT 的环境变量名
        apiBaseUrl: https://api.github.com   # GHES: https://host/api/v3
        requestTimeoutMs: 30000
        maxRetries: 1                    # 限速响应的重试次数
        maxPerPage: 30                   # list/search 工具的硬上限
        maxFileBytes: 262144             # 文件内容截断阈值
        enableIssueWrites: true          # 组合层默认（设置界面可覆盖）
        enableGitDataTools: false        # 组合层默认（设置界面可覆盖）
        enableRepoCreation: false        # 组合层默认（设置界面可覆盖）
    - id: github-permission-gate
      name: dsh-plugin-github/gate
      config:
        mode: writes                     # off | writes | all
        action: ask                      # ask（走审批服务）| deny
        excludeTools: []                 # 免除门控的精确工具名
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（27 个测试，离线）
npm run test:coverage
npm run build       # 产出 lib/
node scripts/verify-load.mjs   # 在 `dsh plugin add` 后于临时 profile 目录内运行
```

贡献约定与 PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全披露走
[SECURITY.md](SECURITY.md)。

## 测试

四层，由快到全（不涉及任何付费服务——这里排的只是耗时和搭建成本）：

```bash
# L1 — 离线：类型 + 27 个单测（client/tools/gate，mock fetch）
npm run typecheck && npm test

# L2 — 包能被 profile 的 link 布局加载
dsh plugin --profile <scratch> add <你的检出目录>/dsh-plugin-github   # 一次即可
cd ~/.dsh/profiles/<scratch>
dsh --profile <scratch> --dump-config                                 # 插入行存在？
node <你的检出目录>/dsh-plugin-github/scripts/verify-load.mjs

# L3 — 真连 GitHub API 冒烟（只读；匿名即可，60 次/小时）
node scripts/smoke-live.mjs                      # 仓库根目录运行
# 认证路径：先在环境里设置 GITHUB_TOKEN

# L4 — 认证+写操作：用一个一次性仓库。
# 打开 enableGitDataTools 后按 create_branch → push_files →
# create_pull_request 顺序驱动（GUI 对话或 headless profile）。

# L5 — agent 级端到端：`dsh plugin add` 进日常 profile 后，直接问
# "langchain-ai/langchain 有多少 star" 并观察工具卡片；
# gate mode=writes 时写工具应弹出审批。
```

## 启动安全与恢复（实测结论）

插件出问题时会发生什么，全部在真实 harness 启动上验证过：

| 场景 | 结果 |
|---|---|
| 配置行健康 | 正常启动；headless 一次性任务里模型真实调用了 `github_get_repository` |
| schema 非法配置（如数字字段给字符串） | **整个 profile 拒绝启动**，exit 1，错误精确指到行 id 和字段——官方 fail-closed 设计 |
| 配置合法但 `apply()` 抛错（如 `credentialRef` 格式错） | 同样拒绝启动，堆栈点名插件 |
| 工具 `execute()` 运行时抛错 | 被工具注册表包含为 `isError` 结果，harness 继续运行 |

所以坏安装的爆炸半径是"这个 profile 在修好/删掉该行之前起不来"——绝不会静默
变成半坏的 agent。恢复手段：

```bash
# 方式 1：干净移除
dsh plugin --profile <name> remove dsh-plugin-github

# 方式 2：手改 profile 的 cordis.patch.yml（删掉或修正那两行）

# 重启日常 profile 前的预检：
dsh --profile <name> --dump-config          # 组合检查
dsh --profile <name> "<一次性任务>"          # 真实启动检查（支持 headless 的 profile）
```

测量用的两个故障注入 overlay 在 `scripts/bad-config.patch.yml` 与
`scripts/apply-throw.patch.yml`，可对任意 scratch profile 重放：
`dsh --profile <scratch> --patch <overlay> "<任务>"`。

## 许可

MIT
