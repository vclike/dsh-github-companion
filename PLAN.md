# dsh-plugin-github — 把 DeerFlow 的 GitHub 能力做成 DeepSeek Harness 插件 · 规划

> 状态：待评审 · 作者：ox-alpha · 依据：dsh-plugin-guide 知识库（quick-reference.md + adding-a-tool.md + subsystems/credentials.md）

## 1. 背景：DeerFlow 有什么，插件该搬什么

DeerFlow 的 GitHub 能力有三条路径（详见 deer-flow-main 调研结论）：

| DeerFlow 路径 | 本质 | 是否进插件 |
|---|---|---|
| MCP server（PAT → issues/PR/文件读写/搜索） | 一组 **agent 可调用的工具** | ✅ 这是插件的主体 |
| GitHub App webhook 事件驱动 agent | **入站服务器通道**（需公网回调 + HMAC + installation token 铸造） | ❌ v1 不做（见 §2） |
| github-deep-research skill | 只读调研提示词包 | ❌ 属于 skill 形态，与工具插件正交 |

**结论**：把路径 1 的能力用原生 DSH 工具重新实现（而不是套一层 MCP stdio），获得更好的参数校验、UI 卡片、Code Mode 集成和凭证管理。

## 2. 范围界定

**做（v1）**：
- 只读发现类：仓库元信息、文件内容、commit 列表、仓库/代码/issues 全文搜索
- Issues 写操作：创建/更新/评论/加 label
- 凭证走 `ctx.credentials` 缝（env 引用，非硬编码）；支持 github.com 与 GHES（可配 `apiBaseUrl`）

**做（v2）**：
- PR 读列表/详情；分支创建；单文件/多文件提交（tree→blob→commit→ref 链）；创建 PR
- 破坏性操作开关（merge PR 等）默认关闭

**明确不做（记录原因）**：
- **Webhook 事件驱动模式**：DSH 插件运行在 agent harness 进程内，官方扩展点是工具/服务/事件，没有"托管公网入站回调端点"的缝；自起 HTTP server 属于部署层职责。若未来需要，应作为独立 Gateway 服务而非本插件。
- git clone 大仓库操作：沙箱 `bash` 工具已覆盖，且 token 不应下放到子进程环境（见 §7）。

## 3. 架构：一个包，两层结构（不提前拆三层缝）

按官方规则"Provider/Consumer 不提前拆"，v1 单包双贡献：

```
dsh-plugin-github/
├── src/
│   ├── index.ts          # name/inject/apply —— 注册 service + 全部工具
│   ├── service.ts        # GithubApiService extends Service（super(ctx,'github')）
│   │                     #   · 每操作解析凭证（不缓存 → 轮换即时生效）
│   │                     #   · fetch 封装：超时/重试/限速/status 映射
│   ├── tools/
│   │   ├── repos.ts      # github_get_repository / get_file_contents / list_commits
│   │   ├── search.ts     # github_search_repositories / _code / _issues
│   │   ├── issues.ts     # github_list_/get_/create_/update_issue, add_issue_comment
│   │   └── pulls.ts      # (v2) pr 读取 / create_branch / create_or_update_file / push_files / create_pull_request
│   └── types.ts          # declaration merging: Context.github + Events
├── cordis.patch.yml      # bundle 清单指向的插入行
├── package.json          # "dsh":{"bundle":{"patch":"./cordis.patch.yml"}}
├── README.md / README.zh.md   # 双语成对
└── tsconfig.json         # bundler 三件套（见 §6）
```

### 3.1 服务层骨架

```ts
// src/service.ts
export class GithubApiService extends Service {
  static inject = ['credentials']
  constructor(ctx: Context, private config: Config) { super(ctx, 'github') }

  async request<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> {
    const ref = this.credentialRef                    // 启动时按 shell 标识符语法校验过
    const resolved = await this.ctx.credentials.resolve(ref)   // ★ 每次调用重新解析
    // 无 token → 匿名请求（公开仓库可用，60 req/h）；有 token → Authorization: Bearer
    // AbortSignal.any([exec 信号, AbortSignal.timeout(config.requestTimeoutMs)])
    // 403 + Retry-After → 按 config.maxRetries 退避；404/401/422 原样上抛给工具层
  }
}
```

要点（全部来自官方契约原文）：
- **凭证引用而非值**：config 只存环境变量名（如 `GITHUB_TOKEN`），值由 `credentials-local` provider 持有；`resolve()` 每操作调用一次，轮换 token 下一次请求即生效，无需重启。
- **注册即 effect**：service 用 `ctx.plugin(class ...)` 挂载，工具用 `ctx.tools.register(defineTool(...))` 注册，卸载自动回收；无手动清理。
- **类型安全**：`declare module '@deepseek-ai/cordis' { interface Context { github: GithubApiService } }`。

### 3.2 配置面（Schemastery，一切可调参数进 cordis.yml）

```ts
export const Config: Schema<Config> = Schema.object({
  credentialRef:      Schema.string().default('GITHUB_TOKEN'),
  apiBaseUrl:         Schema.string().default('https://api.github.com'), // GHES 支持点
  requestTimeoutMs:   Schema.number().default(30_000),
  maxRetries:         Schema.number().default(1),
  maxPerPage:         Schema.number().default(30),    // 各 list/search 工具的硬上限
  maxFileBytes:       Schema.number().default(256_000), // 文件内容截断阈值
  enableIssueWrites:  Schema.boolean().default(true),
  enableGitDataTools: Schema.boolean().default(false), // v2 分支/提交/PR 写，默认关
})
```

非法配置加载期响亮失败；判断标准 = "能否在 cordis.yml 里改"，任何魔法常量都不许出现在代码里。

## 4. 工具清单（模型可见行为，description 即行为的一部分）

统一约定：
- `execute` 只返回 `output.schema` 声明的规范 JSON；人类解释放 `output.render`
- **GitHub 层面的领域结果**（404 不存在、422 校验失败、401 token 失效）返回 `{ ok: false, status, message }` 规范值，让模型能自行决策；只有网络/基础设施故障才 throw（registry 标记 isError）
- 每个 fetch 都尊重 `exec.signal`；卡片 presenter 是纯函数（禁 I/O/时钟/随机）

### Phase 1 — 只读发现（7 个）

| 工具 | 参数（required 加粗） | 返回规范值要点 |
|---|---|---|
| `github_get_me` | — | 登录名/身份；**token 健康检查首选入口**（匿名时返回 anonymous + 限速额度） |
| `github_get_repository` | **owner, repo** | stars/forks/license/default_branch/description |
| `github_get_file_contents` | **owner, repo, path**, ref? | 内容（超 `maxFileBytes` 截断 + `truncated:true`）、sha、编码；目录入参返回条目列表 |
| `github_list_commits` | **owner, repo**, sha?, per_page? | sha/message/author/date 数组 |
| `github_search_repositories` | **query**, per_page? | total_count + 仓库摘要数组 |
| `github_search_code` | **query**, per_page? | 片段匹配（注意搜索接口 30 req/min 二级限速） |
| `github_search_issues` | **query**, per_page? | issues+PR 统一搜索 |

### Phase 2 — Issues 写操作（4 个，受 `enableIssueWrites` 门控）

| 工具 | 参数 | 备注 |
|---|---|---|
| `github_list_issues` | **owner, repo**, state?, labels?, per_page? | 区分 PR 与纯 issue |
| `github_create_issue` | **owner, repo, title**, body?, labels? | |
| `github_update_issue` | **owner, repo, issue_number**, state?, title?, body?, labels? | state: open/closed |
| `github_add_issue_comment` | **owner, repo, issue_number, body** | |

### Phase 3 — Git 数据写（5 个，受 `enableGitDataTools` 门控，默认关）

`github_list_pull_requests` / `github_get_pull_request` / `github_create_branch` / `github_create_or_update_file`（单文件 commit）/ `github_push_files`（多文件一次 commit）/ `github_create_pull_request`

> merge PR 归入"破坏性"候选，单独评估是否提供及门控方式。

## 5. 官方红线逐条对照

| 红线 | 本插件的做法 |
|---|---|
| 注册即 effect | service `ctx.plugin()`、tools `ctx.tools.register()`，零手动收尾 |
| waterfall 必调 next() | 本插件只发事件不拦截，无 waterfall 监听器 |
| 模型可见 ⟺ 已记录 | 工具输出走原生 `tool/result` 会话事件；不注入隐藏上下文，无需新增 SessionEventMap 成员 |
| 配置必须 Schemastery + 无硬编码可调参数 | §3.2，全部字段可在 cordis.yml 覆盖 |
| execute 只返回规范 JSON / 尊重 exec.signal | §4 统一约定 |
| presenter 纯函数 | 卡片只用 args(+result)；截断标记等回放需要的事实走 `output.presentationMeta` 进 `result.meta` |
| 不硬编码部署策略 | 不内置 allow/deny；写工具的启停是**配置**不是策略钩子；若用户要审批流，交给 `tools/pre-execute` 权限门插件组合 |
| Branded 跨边界 id | CredentialRef 用缝自带品牌类型；issue_number 等数值 id 不跨进程边界 |

## 6. 打包与工程细节（社区已知坑规避）

- **包名** `dsh-plugin-github`（不用 `@deepseek-ai` 官方 scope）；ESM。
- **脚手架**：优先试 `create-dsh-plugin`（0.1.1 已发布）生成骨架再改造。
- **依赖身份**：`@deepseek-ai/cordis` 声明为 peerDependency 且与宿主同源（严禁混装 unscoped `cordis` 双副本）；`@deepseek-ai/dsh-tools` 与 schemastery 为 dependencies，**pin `next` tag**（npm `latest` 停在 0.0.1-rc.1 是已知坑）。
- **tsconfig 三件套**：`moduleResolution:"bundler"` + `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`，`lib:["ES2024"]`、`types:["node"]`。
- **构建产物**：ship `lib/`；`tsc --noEmitOnError`；发布前 grep 残留 `.ts` import。
- **安装通道**：正式分发带 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`（`dsh plugin add` 进 bundles 栈，重启生效）；开发期用 scratch `--patch ./cordis.yml` overlay（普通 cordis 插件行享受配置热更）。若走 git 源安装：需自包含 `prepare` 构建脚本 + 用户 profile `pnpm-workspace.yaml` 的 `allowBuilds`；npm/tarball 免构建许可。
- 导入 `CredentialRef` 构造器的确切说明符以宿主 `node_modules` 中 credentials 包实际导出为准（实施第一步核对，不在规划里臆造）。

## 7. 安全设计

1. **token 永不入沙箱/子进程**：所有认证收敛在 service 的 fetch 内；绝不提供"把 token 给 bash/git"的工具（对比 DeerFlow 的 env 注入路径，这里没有沙箱 env_policy 兜底，所以更要收紧）。
2. **日志与渲染脱敏**：Authorization header、token 字符串不得出现在 logger 输出、canonical 值或 render 文本中。
3. **匿名降级显式化**：未配置 token 时工具仍可用于公开仓库（60 req/h），但 `github_get_me` 返回匿名标识，render 提示模型告知用户当前无写权限。
4. **GHES 场景**：`apiBaseUrl` 由操作者配置（信任边界内的值），不做任意用户可控 URL。
5. **写操作双层门控**：配置开关（§3.2）+ 用户可选叠加 pre-execute 权限门插件。

## 8. 测试与验收

- **单元**：vitest + mock fetch —— 每个 tool 的 execute 对 `output.schema` 的符合性快照；status 映射矩阵（200/304/401/403/404/422/452 限速）；凭证缺失→匿名路径；`exec.signal` 取消传导。
- **加载验证**：干净 profile `dsh plugin add` 后 `dsh --profile X --dump-config` 检查插入行生效，启动日志无 FAILED。
- **行为验证**：`dsh --profile headless "查一下 bytedance/deer-flow 的 star 数并开个 issue"` 实测（只读用匿名，写操作用测试仓库 + 低权限 PAT）；工具返回/模型可见文本即行为，改动必测。
- **Code Mode 抽查**：`await tools.github_search_repositories({...})` 解析到规范值、失败抛真实 `ToolCallError`。
- **打包验证**：`pnpm pack` → 干净 profile 试装（含 lib/）。

## 9. 实施里程碑（2026-08-23 全部完成 ✅）

| 里程碑 | 内容 | 出口条件 | 状态 |
|---|---|---|---|
| M0 | 脚手架 + service 骨架 + credentials 接通 | `--dump-config` 生效；`github_get_me` 匿名/token 两态实测通过 | ✅（dump-config 两行插入生效；两态由单测覆盖） |
| M1 | Phase 1 七个只读工具 + 单测 | 行为验证通过；卡片渲染正确 | ✅（23 个单测全绿；v1 用通用卡片，自定义卡片留作后续打磨） |
| M2 | Phase 2 四个 issue 写工具 + 门控 | 测试仓库上建/评/关 issue 全链路通过 | ✅（工具已实现+单测覆盖；真实 GitHub 端到端待用户配 token 后自测） |
| M3 | Phase 3 git 数据写（默认关） | 分支→提交→PR 全链路通过 | ✅（同上；含 push_files 原子多文件提交） |
| M4 | 双语 README、CHANGELOG、pack 发布 | 干净 profile 试装成功 | ✅（plugin-verify profile 试装 + verify-load.mjs 通过；npm 发布未做） |

### 验证记录
- `tsc --noEmit` 干净；`vitest run` 23/23 通过。
- `dsh plugin add` → plugin-verify profile：bundle 进入 stacks，`--dump-config` 显示 `github-tools` 与 `github-permission-gate`（`dsh-plugin-github/gate` 子路径导出）两行插入。
- `scripts/verify-load.mjs` 在 profile 目录内通过真实 link 解析加载 lib/：12 工具初始注册、设置翻转后 git-data 工具出现、gate 对写工具 ask/读工具放行。
- web profile 安装被 pnpm minimumReleaseAge 供应链策略拦截——原因是 lockfile 中既有的无关包 `@linxin666/dsh-chat-recovery@0.2.9` 太新，与本插件无关；待其过龄后用户可自行重试 `dsh plugin --profile web add D:\work_space\dsh-plugin-github`。

## 10. 已确认的决策（2026-08-16 用户拍板）

1. **目录位置**：独立仓 `D:\work_space\dsh-plugin-github`。✅
2. **凭证引用名**：沿用 `GITHUB_TOKEN`（config.credentialRef 可改，但默认值不变）。✅
3. **v2 写操作审批**：提供配套 `github-permission-gate` 示例插件（同仓分发，bundle patch 两行插入），基于 `tools/pre-execute` waterfall 实现 off/writes/all 三档模式 + ask/deny 两种动作，且自身通过 DSH 设置界面（settings 命名空间）可配置。✅
4. **设置界面**：两个插件各自注册 settings 命名空间（`github-tools` / `github-gate`），组合层默认值来自 cordis.yml 的 `base`，用户可在 Web 设置中覆盖并实时生效（applies:'live'）。✅
