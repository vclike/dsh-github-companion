/**
 * dsh-plugin-github — browser half (settings card).
 *
 * Contributes one "GitHub" section to the DSH settings page, rendering the
 * backend-registered `github-tools` and `github-gate` namespaces through the
 * official settings surface (describe + mutate over the client connection).
 *
 * Hand-written against the shared client externals (`react` via the module
 * loader's require) — same shape as dsh-status-rotator's browser half, so no
 * bundler step is needed. Everything degrades audibly (console.warn) but
 * never breaks the host.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-github',
	factory: (require) => {
		var module = { exports: {} }
		const react = require('react')

		const NS_TOOLS = 'github-tools'
		const NS_GATE = 'github-gate'

		/** Inject the card stylesheet exactly once. */
		function ensureStyles() {
			if (document.getElementById('dsh-gh-settings-style')) return
			const style = document.createElement('style')
			style.id = 'dsh-gh-settings-style'
			style.textContent = [
			'.dsh-gh{display:flex;flex-direction:column;gap:20px;width:100%;max-width:640px;',
			'color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
			'.dsh-gh-title{margin:0 0 4px;font-size:14px;font-weight:600;line-height:22px}',
			'.dsh-gh-group{display:flex;flex-direction:column}',
			'.dsh-gh-row{display:flex;align-items:center;justify-content:space-between;gap:8px;',
			'padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
			'.dsh-gh-row.stack{flex-direction:column;align-items:stretch;gap:8px}',
			'.dsh-gh-labels{display:flex;flex-direction:column;gap:4px;min-width:0;padding-right:24px}',
			'.dsh-gh-row.stack .dsh-gh-labels{padding-right:0}',
			'.dsh-gh-hint{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary-dimmed,rgba(127,127,127,.7)))}',
			'.dsh-gh-hint a,.dsh-gh-help a{color:#4c8dff;text-decoration:none}',
			'.dsh-gh-hint a:hover,.dsh-gh-help a:hover{text-decoration:underline}',
			'.dsh-gh-inputrow{display:flex;align-items:center;gap:8px}',
			'.dsh-gh-inputrow .dsh-gh-input{flex:1 1 auto;height:36px}',
			'.dsh-gh-inputrow .dsh-gh-btn{flex:0 0 auto;height:32px}',
			'.dsh-gh-select,.dsh-gh-input{font:inherit;font-size:14px;color:var(--dsw-alias-label-primary);',
			'background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2,transparent));',
			'border:none;border-radius:18px;padding:0 14px;min-width:0}',
			'.dsh-gh-select{cursor:pointer}',
			'.dsh-gh-select option{color:#1f2328;background:#ffffff}',
			'.dsh-gh-input:focus,.dsh-gh-select:focus{outline:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
			'.dsh-gh-btn{cursor:pointer;font:inherit;font-size:13px;line-height:22px;padding:0 14px;',
			'border:none;border-radius:999px;white-space:nowrap;flex:0 0 auto;',
			'background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2,transparent));',
			'color:var(--dsw-alias-label-primary)}',
			'.dsh-gh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,transparent))}',
			'.dsh-gh-btn.primary{background:var(--dsw-alias-label-primary,#111);',
			'color:var(--dsw-alias-label-primary-foreground,#fff)}',
			'.dsh-gh-btn.primary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-label-primary,#111)}',
			'.dsh-gh-btn:disabled{opacity:.5;cursor:default}',
			'.dsh-gh-btn.small{height:28px;padding:0 10px;font-size:12px}',
			'.dsh-gh-badge{display:inline-block;font-size:11px;line-height:16px;border-radius:999px;',
			'padding:0 8px;margin-left:8px;vertical-align:middle;',
			'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
			'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary-dimmed,rgba(127,127,127,.7)))}',
			'.dsh-gh-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
			'.dsh-gh-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px;',
			'border-radius:999px;font-size:12px;line-height:18px;white-space:nowrap;',
			'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
			'background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2,transparent));',
			'color:var(--dsw-alias-label-primary);font-family:inherit}',
			'.dsh-gh-chip.suggest{border-style:dashed;cursor:pointer;',
			'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary-dimmed,rgba(127,127,127,.7)))}',
			'.dsh-gh-chip.suggest:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent);',
			'color:var(--dsw-alias-label-primary)}',
			'.dsh-gh-chip-x{cursor:pointer;border:none;background:none;color:inherit;font:inherit;',
			'font-size:13px;padding:0 0 0 2px;line-height:1}',
			'.dsh-gh-help{font-size:12px;line-height:18px;padding:12px 14px;',
			'border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:10px;',
			'background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,transparent));',
			'color:var(--dsw-alias-label-primary)}',
			'.dsh-gh-flash{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary-dimmed,rgba(127,127,127,.7)))}',
			'.dsh-gh-muted{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary-dimmed,rgba(127,127,127,.7)))}',
			'.dsh-gh-error{font-size:12px;line-height:1.5;color:#e5534b}',
			'.dsh-gh-check{width:17px;height:17px;cursor:pointer;accent-color:var(--dsw-alias-label-primary,#111)}',
		].join('')
			document.head.appendChild(style)
		}

		/** Fetch the describe mirror and pick out our two namespaces. */
		async function describeOurs(api) {
			const res = await api.settings.describe({})
			const inner = res && res.result ? res.result : null
			if (!inner || !inner.ok)
				throw new Error(inner && inner.message ? inner.message : 'settings.describe failed')
			const list = (inner.value && inner.value.namespaces) || []
			const byNs = new Map(list.map(d => [d.ns, d]))
			return { tools: byNs.get(NS_TOOLS) || null, gate: byNs.get(NS_GATE) || null }
		}

		/** One path-op write against a namespace's user layer. */
		async function writeOp(api, ns, descriptor, op) {
			const res = await api.settings.mutate({
				ns,
				ops: [op],
				expectedRevision: descriptor.revision,
			})
			const inner = res && res.result ? res.result : null
			if (!inner || !inner.ok)
				throw new Error(inner && inner.message ? inner.message : 'settings write failed')
		}

		/** True when the redaction sidecar reports a value at `field`. */
		function secretSet(descriptor, field) {
			const secrets = (descriptor && descriptor.secrets) || []
			return secrets.some(s => Array.isArray(s.path) && s.path.join('.') === field && s.set === true)
		}

		/**
		 * Native OS folder chooser via the connection's `host.pickDirectory`
		 * RPC (the same surface the shipped directory pickers ride on).
		 * Resolves an absolute path; resolves null when the user cancelled;
		 * THROWS with a readable message when the surface is missing — TextRow
		 * shows that instead of failing silently.
		 */
		async function pickDirectory(conn) {
			const api = conn && conn.api
			const host = api && api.host
			if (!host || typeof host.pickDirectory !== 'function') {
				throw new Error('此宿主未提供目录选择器（host.pickDirectory 不可用），请手动输入路径')
			}
			let res = await host.pickDirectory({})
			if (res && typeof res === 'object' && 'result' in res) res = res.result
			if (res && typeof res.path === 'string') return res.path
			return null
		}

		function makePanel(getConnection) {
			const h = react.createElement
			const { useState, useEffect } = react

			function ToggleRow({ label, hint, checked, disabled, onChange }) {
				return h('div', { className: 'dsh-gh-row' },
					h('div', { className: 'dsh-gh-labels' },
						h('span', null, label),
						hint ? h('span', { className: 'dsh-gh-hint' }, hint) : null),
					h('input', {
						type: 'checkbox', className: 'dsh-gh-check', checked: !!checked,
						disabled: !!disabled, onChange: e => onChange(e.target.checked),
					}))
			}

			function SelectRow({ label, value, options, disabled, onChange }) {
				return h('div', { className: 'dsh-gh-row' },
					h('div', { className: 'dsh-gh-labels' },
						h('span', null, label)),
					h('select', {
						className: 'dsh-gh-select', value, disabled: !!disabled,
						onChange: e => onChange(e.target.value),
					}, options.map(o => h('option', { key: o.value, value: o.value }, o.label))))
			}

			function TokenRow({ tools, busy, onWrite }) {
				const [draft, setDraft] = useState('')
				const [helpOpen, setHelpOpen] = useState(false)
				const configured = secretSet(tools, 'token')
				return h('div', { className: 'dsh-gh-row stack' },
					h('div', { className: 'dsh-gh-labels' },
						h('span', null, 'GitHub Token（PAT）',
							h('span', { className: 'dsh-gh-badge' }, configured ? '已设置' : '未设置')),
							!configured ? h('span', { className: 'dsh-gh-hint' },
								'还没有令牌？点「提示」有新手指引，一键创建、权限自动勾好。') : null,
						),
					h('div', { className: 'dsh-gh-inputrow' },
						h('input', {
							className: 'dsh-gh-input', type: 'password', spellCheck: false,
							placeholder: configured ? '••••••••（输入新值可覆盖）' : '粘贴 PAT',
							value: draft, disabled: busy,
							onChange: e => setDraft(e.target.value),
						}),
						h('button', {
							className: 'dsh-gh-btn primary', disabled: busy || !draft.trim(),
							onClick: () => onWrite({ op: 'set', path: ['token'], value: draft.trim() }, () => setDraft('')),
						}, '保存'),
						configured
							? h('button', {
								className: 'dsh-gh-btn', disabled: busy,
								onClick: () => onWrite({ op: 'unset', path: ['token'] }),
							}, '清除')
							: h('button', {
								className: 'dsh-gh-btn', onClick: () => setHelpOpen(v => !v),
							}, helpOpen ? '收起提示' : '提示'),
					),
					helpOpen && !configured ? h('div', { className: 'dsh-gh-help' },
						h('div', null,
							'新手一键创建（推荐，权限已预选，覆盖插件全部功能，含自动建仓）：',
							h('a', { href: 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=dsh-plugin-github', target: '_blank', rel: 'noreferrer' }, '点此生成经典令牌'),
							' —— 打开即勾好 repo + workflow，拉到底点 Generate token，复制结果粘贴到上面即可。'),
						h('div', { style: { marginTop: 6 } },
							'需逐仓精细控制时用 ',
							h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noreferrer' }, '细粒度令牌'),
							'，手动勾选：Metadata R、Contents RW、Issues RW、Pull requests RW、Workflows RW；要自动建仓再加 Administration RW。'),
						h('div', { style: { marginTop: 6 } },
							'令牌只写入本机服务端配置文件，界面永不回显。'),
					) : null,
				)
			}


			/** One-line Chinese description per tool — hover tooltip + click feedback. */
			const TOOL_DESC = {
				github_get_me: '查询登录身份与凭证状态',
				github_get_repository: '查看仓库信息',
				github_get_file_contents: '读取仓库文件',
				github_list_commits: '列出提交历史',
				github_search_repositories: '搜索仓库',
				github_search_code: '搜索代码',
				github_search_issues: '搜索议题和 PR',
				github_list_issues: '列出开放议题',
				github_get_issue: '查看单个议题',
				github_list_releases: '列出发布版本',
				github_latest_release: '查最新发布版本',
				github_list_starred: '读取 star 列表',
				github_list_forks: '读取我的 fork 及上游动态',
				github_list_watched: '读取 watch 订阅列表',
				github_create_issue: '创建新议题',
				github_update_issue: '修改或关闭议题',
				github_add_issue_comment: '给议题写评论',
				github_create_branch: '创建分支',
				github_create_or_update_file: '提交单个文件改动',
				github_push_files: '多文件一次提交',
				github_create_pull_request: '发起 PR',
				github_create_release: '打 tag 并发版',
				github_sync_fork: '把 fork 同步到上游最新',
				github_create_repository: '自动新建私有仓库',
			}
			const toolDesc = name => TOOL_DESC[name] || ('调用工具 ' + name)

			/** Read-only tools commonly worth exempting when the gate is set to "all". */
			const SUGGESTED_EXEMPT = [
				'github_get_me', 'github_get_file_contents', 'github_search_repositories',
				'github_search_code', 'github_list_issues', 'github_latest_release',
				'github_list_starred', 'github_list_forks',
			]

			function ExcludeToolsRow({ gate, busy, onWrite }) {
				const current = Array.isArray(gate.value && gate.value.excludeTools)
					? gate.value.excludeTools : []
				const [draft, setDraft] = useState('')
				const [flash, setFlash] = useState('')
				useEffect(() => {
					if (!flash) return
					const timer = setTimeout(() => setFlash(''), 3500)
					return () => clearTimeout(timer)
				}, [flash])
				const removeOne = name => {
					onWrite({ op: 'set', path: ['excludeTools'], value: current.filter(n => n !== name) }, () => {})
					setFlash('已恢复审批：' + toolDesc(name))
				}
				const addOne = raw => {
					const v = String(raw || '').trim()
					if (!v || current.includes(v)) return
					onWrite({ op: 'set', path: ['excludeTools'], value: [...current, v] }, () => setDraft(''))
					setFlash('已免审批：' + toolDesc(v))
				}
				const suggestions = SUGGESTED_EXEMPT.filter(n => !current.includes(n))
				return h('div', { className: 'dsh-gh-row stack' },
					h('div', { className: 'dsh-gh-labels' },
						h('span', null, '豁免工具（免审批）',
							h('span', { className: 'dsh-gh-badge' }, String(current.length))),
						h('span', { className: 'dsh-gh-hint' }, '悬停可看用途；点 × 移除，点虚线胶囊加入。只建议豁免只读工具。'),
					),
					current.length
						? h('div', { className: 'dsh-gh-chips' },
							current.map(name => h('span', {
								key: name, className: 'dsh-gh-chip', title: toolDesc(name),
							},
								name,
								h('button', {
									className: 'dsh-gh-chip-x', title: '移除（恢复审批）', disabled: busy,
									onClick: () => removeOne(name),
								}, '×'))))
						: h('div', { className: 'dsh-gh-muted' }, '当前没有豁免——门控范围内的每次调用都会弹审批。'),
					flash ? h('div', { className: 'dsh-gh-flash' }, flash) : null,
					suggestions.length
						? h('div', { className: 'dsh-gh-chips' },
							h('span', { className: 'dsh-gh-hint' }, '常用只读：'),
							suggestions.map(name => h('button', {
								key: name, className: 'dsh-gh-chip suggest', disabled: busy,
								title: toolDesc(name),
								onClick: () => addOne(name),
							}, '+ ' + name)))
						: null,
					h('div', { className: 'dsh-gh-inputrow' },
						h('input', {
							className: 'dsh-gh-input', spellCheck: false, value: draft, disabled: busy,
							placeholder: '自定义工具名，如 github_get_pull_request',
							onChange: e => setDraft(e.target.value),
						}),
						h('button', {
							className: 'dsh-gh-btn primary', disabled: busy || !draft.trim(),
							onClick: () => addOne(draft),
						}, '添加'))
				)
			}

			/** Single-line text setting; saves on button press (draft === null = clean). */
			function TextRow({ label, hint, placeholder, field, value, badge, busy, onWrite, onBrowse }) {
				const current = typeof value === 'string' ? value : ''
				const [draft, setDraft] = useState(null)
				const [browsing, setBrowsing] = useState(false)
				const [browseMsg, setBrowseMsg] = useState('')
				const text = draft === null ? current : draft
				const dirty = draft !== null && draft.trim() !== current
				const browse = async () => {
					if (typeof onBrowse !== 'function') return
					setBrowsing(true)
					setBrowseMsg('')
					try {
						const picked = await onBrowse()
						if (typeof picked === 'string' && picked.trim()) {
							setDraft(picked.trim())
							onWrite({ op: 'set', path: [field], value: picked.trim() }, () => setDraft(null))
						}
					} catch (error) {
						setBrowseMsg(String((error && error.message) || error))
					} finally {
						setBrowsing(false)
					}
				}
				return h('div', { className: 'dsh-gh-row stack' },
					h('div', { className: 'dsh-gh-labels' },
						h('span', null, label,
							badge ? h('span', { className: 'dsh-gh-badge' }, badge) : null),
						hint ? h('span', { className: 'dsh-gh-hint' }, hint) : null),
					h('div', { className: 'dsh-gh-inputrow' },
						h('input', {
							className: 'dsh-gh-input', spellCheck: false, value: text,
							placeholder: placeholder || '', disabled: busy || browsing,
							onChange: e => setDraft(e.target.value),
						}),
						onBrowse ? h('button', {
							className: 'dsh-gh-btn small', disabled: busy || browsing,
							onClick: () => void browse(),
						}, browsing ? '…' : '浏览…') : null,
						dirty ? h('button', {
							className: 'dsh-gh-btn primary', disabled: busy,
							onClick: () => onWrite({ op: 'set', path: [field], value: draft.trim() }, () => setDraft(null)),
						}, '保存') : null,
					),
					browseMsg ? h('div', { className: 'dsh-gh-flash' }, browseMsg) : null,
				)
			}

			function Group({ title, children }) {
				return h('div', { className: 'dsh-gh-group' },
					h('h3', { className: 'dsh-gh-title' }, title), children)
			}

			function GithubSettingsPanel() {
				const [state, setState] = useState({ loading: true, error: '', tools: null, gate: null })
				const [busy, setBusy] = useState(false)
				const [writeError, setWriteError] = useState('')

				const reload = async () => {
					try {
						const conn = getConnection()
						if (!conn || !conn.api || !conn.api.settings) throw new Error('settings surface unavailable')
						const ours = await describeOurs(conn.api)
						setState({ loading: false, error: '', tools: ours.tools, gate: ours.gate })
					} catch (error) {
						setState({ loading: false, error: String((error && error.message) || error), tools: null, gate: null })
					}
				}

				useEffect(() => { void reload() }, [])

				const write = async (ns, descriptor, op, after) => {
					if (!descriptor) return
					setBusy(true)
					setWriteError('')
					try {
						const conn = getConnection()
						await writeOp(conn.api, ns, descriptor, op)
						if (after) after()
						await reload()
					} catch (error) {
						setWriteError(String((error && error.message) || error))
						await reload()
					} finally {
						setBusy(false)
					}
				}

				if (state.loading)
					return h('div', { className: 'dsh-gh-muted' }, '正在读取 GitHub 设置…')
				if (state.error)
					return h('div', { className: 'dsh-gh-error' }, '无法读取设置数据：' + state.error)

				const t = state.tools
				const g = state.gate
				const anyPresent = !!(t || g)
				if (!anyPresent)
					return h('div', { className: 'dsh-gh-muted' },
						'未发现 github-tools / github-gate 命名空间——插件可能未启用。')

				const tokenSource = t && secretSet(t, 'token')
					? '设置中保存的 PAT'
					: '环境变量 GITHUB_TOKEN'
				return h('div', { className: 'dsh-gh' },

					t ? h(Group, { title: 'GitHub 工具' },
						h(TokenRow, {
							tools: t, busy,
							onWrite: (op, after) => write(NS_TOOLS, t, op, after),
						}),
						h(ToggleRow, {
							label: 'Issue 写操作', hint: 'create / update / comment 三类写工具的注册开关',
							checked: !!(t.value && t.value.enableIssueWrites),
							onChange: v => write(NS_TOOLS, t, { op: 'set', path: ['enableIssueWrites'], value: v }),
						}),
						h(ToggleRow, {
							label: 'Git 数据写操作', hint: '分支 / 提交文件 / PR 等（含两个 PR 只读工具）',
							checked: !!(t.value && t.value.enableGitDataTools),
							onChange: v => write(NS_TOOLS, t, { op: 'set', path: ['enableGitDataTools'], value: v }),
						}),
						h(ToggleRow, {
							label: '自动新建仓库', hint: '允许 agent 创建新的私有仓库（强制 private，无法创建公开仓库；需令牌含 Administration 权限）',
							checked: !!(t.value && t.value.enableRepoCreation),
							onChange: v => write(NS_TOOLS, t, { op: 'set', path: ['enableRepoCreation'], value: v }),
						}),
						h(TextRow, {
							label: '默认克隆目录', field: 'workspaceRoot',
							badge: t.value && typeof t.value.workspaceRoot === 'string' && t.value.workspaceRoot.trim()
								? '已设置' : '未设置',
							hint: '克隆落点优先级：当前会话的工作区 → 此目录 → 询问你。适合存放临时参考的克隆；目录不存在时自动创建。',
							placeholder: '例如 D:\\work_space\\github',
							value: t.value && t.value.workspaceRoot, busy,
							onWrite: (op, after) => write(NS_TOOLS, t, op, after),
							onBrowse: () => pickDirectory(getConnection()),
						}),
						h(TextRow, {
							label: 'API 代理', field: 'proxyUrl',
							hint: '访问 api.github.com 走的 HTTP(S) 代理。Node 不读系统代理，直连超时才需要填；改动实时生效。',
							placeholder: '例如 http://127.0.0.1:7890',
							value: t.value && t.value.proxyUrl, busy,
							onWrite: (op, after) => write(NS_TOOLS, t, op, after),
						}),
						h('div', { className: 'dsh-gh-muted' },
							'当前凭证来源：' + tokenSource + '。改动实时生效。'),
					) : null,

					g ? h(Group, { title: 'GitHub 权限门' },
						h(SelectRow, {
							label: '门控范围', value: (g.value && g.value.mode) || 'writes',
							options: [
								{ value: 'off', label: 'off — 不拦截' },
								{ value: 'writes', label: 'writes — 拦截写工具' },
								{ value: 'all', label: 'all — 拦截所有 github_* 工具' },
							],
							onChange: v => write(NS_GATE, g, { op: 'set', path: ['mode'], value: v }),
						}),
						h(SelectRow, {
							label: '拦截动作', value: (g.value && g.value.action) || 'ask',
							options: [
								{ value: 'ask', label: 'ask — 弹出审批' },
								{ value: 'deny', label: 'deny — 直接拒绝' },
							],
							onChange: v => write(NS_GATE, g, { op: 'set', path: ['action'], value: v }),
						}),
						h(ExcludeToolsRow, {
							gate: g, busy,
							onWrite: (op, after) => write(NS_GATE, g, op, after),
						}),
						writeError ? h('div', { className: 'dsh-gh-error' }, '写入失败：' + writeError) : null,
					) : null,
				)
			}

			return GithubSettingsPanel
		}

		function apply(ctx) {
			ensureStyles()
			let connection = undefined
			try {
				connection = ctx.get('connection')
			} catch {
				connection = undefined
			}
			try {
				if (!ctx.slots) throw new Error('slots service not injected — is "slots" in this module\'s inject list?')
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'dsh-plugin-github',
					order: 60,
					label: () => 'GitHub',
				}, makePanel(() => connection)))
			} catch (error) {
				// Older hosts without the settings.section seat: degrade audibly
				// in the browser console but never break the host.
				console.warn('[dsh-plugin-github] settings card not registered:', String((error && error.message) || error))
			}
		}

		module.exports.inject = ['connection', 'slots']
		module.exports.apply = apply
		return module.exports
	},
})
