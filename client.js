/**
 * dsh-github-companion — browser half (settings card).
 *
 * Contributes one "GitHub" section to the DSH settings page, rendering the
 * backend-registered `github-tools` and `github-gate` namespaces through the
 * official settings surface (describe + mutate over `ctx.settingsScope`).
 *
 * Hand-written against the shared client externals (`react` via the module
 * loader's require) — same shape as dsh-status-rotator's browser half, so no
 * bundler step is needed. Everything degrades audibly (console.warn) but
 * never breaks the host.
 *
 * Settings UI invariants:
 * - "默认克隆目录" 浏览按钮: `ctx.uiWorkspace.pickDirectory()` (the v0.4.x
 *   `connection.rpc.call('/host', 'pickDirectory', {})` path was retired in
 *   0.1.5-rc.1; the rpc endpoint is gone but the connection.rpc surface itself
 *   is still mounted, so calls fail silently).
 * - "豁免工具" panel: 33 chips, one per GitHub tool. On hover the chip text
 *   swaps from the english tool name to a concise Chinese description (no
 *   tooltip; the chip stays the same size and the description is centered).
 *   A small colored dot marks risk: green = read-only, yellow = reversible
 *   write, red = creates a resource / burns Actions minutes / pulls code
 *   onto this machine. Untoggled chips render at lower opacity so the
 *   currently-exempt set is visually obvious.
 * - "快速预设" row above the chips: tapping one of three buttons applies
 *   the matching `excludeTools` set in one shot:
 *     off   = all 33 (gate never prompts),
 *     writes = all 23 read-only (gate only prompts on writes),
 *     all   = empty (gate prompts on every github_* call).
 *   Manual chip toggles after a preset application DO NOT mutate the
 *   `mode` field — the two are independent (`mode` stays for back-compat).
 */

window.__ModuleLoader__.load({
	id: 'dsh-github-companion',
	factory: (require) => {
		var module = { exports: {} }
		const react = require('react')

		const NS_TOOLS = 'github-tools'
		const NS_GATE = 'github-gate'

		// ------------------------------------------------------------------------
		// 33 tools: risk classification + concise Chinese description
		// ------------------------------------------------------------------------
		// Risk semantics (color dot):
		//   green  — read-only, no side effects on remote or local state
		//   yellow — reversible write: issue / PR / branch / fork sync
		//   red    — creates a resource (new repo, new release), directly
		//            mutates a branch tip without a PR review surface
	 //            (push_files / create_or_update_file), or pulls code onto
		//            this machine (clone). Red tools are the only ones the
		//            actions cost guard refuses against.
		const TOOL_LIST = [
			// ── green: read-only ────────────────────────────────────────
			{ name: 'github_get_me', risk: 'green', desc: '查询登录身份' },
			{ name: 'github_get_repository', risk: 'green', desc: '查看仓库信息' },
			{ name: 'github_get_file_contents', risk: 'green', desc: '读取仓库文件' },
			{ name: 'github_get_file_tree', risk: 'green', desc: '列出目录树' },
			{ name: 'github_list_commits', risk: 'green', desc: '列出提交历史' },
			{ name: 'github_list_contributors', risk: 'green', desc: '列出贡献者' },
			{ name: 'github_list_languages', risk: 'green', desc: '语言占比' },
			{ name: 'github_list_tags', risk: 'green', desc: '列出 tag' },
			{ name: 'github_list_releases', risk: 'green', desc: '列出发布版本' },
			{ name: 'github_latest_release', risk: 'green', desc: '查最新发布' },
			{ name: 'github_list_starred', risk: 'green', desc: '读取 star 列表' },
			{ name: 'github_list_forks', risk: 'green', desc: '读取我的 fork' },
			{ name: 'github_list_watched', risk: 'green', desc: '读取 watch 列表' },
			{ name: 'github_list_notifications', risk: 'green', desc: '读取通知收件箱' },
			{ name: 'github_list_my_repositories', risk: 'green', desc: '读取我的所有仓库' },
			{ name: 'github_get_commit_activity', risk: 'green', desc: '查询提交活跃度' },
			{ name: 'github_search_repositories', risk: 'green', desc: '搜索仓库' },
			{ name: 'github_search_code', risk: 'green', desc: '搜索代码' },
			{ name: 'github_search_issues', risk: 'green', desc: '搜索议题与 PR' },
			{ name: 'github_list_issues', risk: 'green', desc: '列出开放议题' },
			{ name: 'github_get_issue', risk: 'green', desc: '查看单个议题' },
			{ name: 'github_list_pull_requests', risk: 'green', desc: '列出 PR' },
			{ name: 'github_get_pull_request', risk: 'green', desc: '查看单个 PR' },
			// ── yellow: reversible writes ────────────────────────────────
			{ name: 'github_create_issue', risk: 'yellow', desc: '创建新议题' },
			{ name: 'github_update_issue', risk: 'yellow', desc: '修改或关闭议题' },
			{ name: 'github_add_issue_comment', risk: 'yellow', desc: '给议题写评论' },
			{ name: 'github_create_pull_request', risk: 'yellow', desc: '发起 PR' },
			{ name: 'github_create_branch', risk: 'yellow', desc: '创建分支' },
			{ name: 'github_sync_fork', risk: 'yellow', desc: '同步 fork 到上游' },
			// ── red: irreversible / Actions / clone ──────────────────────
			{ name: 'github_create_or_update_file', risk: 'red', desc: '直接改 main 文件' },
			{ name: 'github_push_files', risk: 'red', desc: '多文件提交' },
			{ name: 'github_create_release', risk: 'red', desc: '打 tag 并发版' },
			{ name: 'github_create_repository', risk: 'red', desc: '新建私有仓库' },
			{ name: 'github_clone_repository', risk: 'red', desc: '克隆仓库到本机' },
		]
		const TOOL_NAMES = TOOL_LIST.map(t => t.name)
		const TOOL_BY_NAME = Object.fromEntries(TOOL_LIST.map(t => [t.name, t]))
		const GREEN_NAMES = TOOL_LIST.filter(t => t.risk === 'green').map(t => t.name)
		const RISK_ORDER = ['green', 'yellow', 'red']
		const RISK_LABEL = { green: '只读（无副作用）', yellow: '可逆的写', red: '不可逆 / 触发 Actions' }
		const RISK_DOT_CLASS = { green: 'dsh-gh-risk-green', yellow: 'dsh-gh-risk-yellow', red: 'dsh-gh-risk-red' }

		// What `excludeTools` becomes when a "快速预设" button is clicked.
		//   off    → all 33 (gate never prompts)
		//   writes → the 23 read-only tools (gate prompts on writes only)
		//   all    → empty    (gate prompts on every github_* call)
		function defaultListForMode(mode) {
			if (mode === 'off') return TOOL_NAMES.slice()
			if (mode === 'writes') return GREEN_NAMES.slice()
			if (mode === 'all') return []
			return null
		}
		const MODE_PRESET_LABEL = {
			off: '全部免审批',
			writes: '仅读工具免审批，写工具全部拦截',
			all: '全部拦截审批',
		}
		const MODE_PRESET_BUTTON = { off: '全免审批', writes: '默认 writes', all: '全拦截' }

		/** Inject the card stylesheet exactly once. */
		function ensureStyles() {
			if (document.getElementById('dsh-gh-settings-style')) return
			const style = document.createElement('style')
			style.id = 'dsh-gh-settings-style'
			style.textContent = [
				'.dsh-gh{display:flex;flex-direction:column;gap:20px;width:100%;max-width:680px;',
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
				// --- 33-tool chip + risk dot (v1.0.4) ---
				'.dsh-gh-modebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
				'.dsh-gh-modebar-label{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
				'.dsh-gh-modebar-btn{font-size:12px;line-height:18px;height:24px;padding:0 10px;',
				'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:999px;',
				'background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}',
				'.dsh-gh-modebar-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}',
				'.dsh-gh-tools-by-risk{display:flex;flex-direction:column;gap:12px}',
				'.dsh-gh-toolgroup{display:flex;flex-direction:column;gap:6px}',
				'.dsh-gh-toolgroup-label{font-size:11px;line-height:16px;',
				'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));',
				'display:flex;align-items:center;gap:6px;letter-spacing:.02em}',
				'.dsh-gh-risk{width:8px;height:8px;border-radius:50%;flex:0 0 auto;',
				'box-shadow:0 0 0 1px rgba(0,0,0,.06) inset}',
				'.dsh-gh-risk-red{background:#e5534b}',
				'.dsh-gh-risk-yellow{background:#d4a017}',
				'.dsh-gh-risk-green{background:#2ea44f}',
				// Fixed min-width prevents the chip from shrinking when its label
				// swaps between the long english name and the shorter chinese
				// description — without this, flex-wrap reflows the row and the
				// mouse hovers into the next chip, recursively. 7.5rem holds the
				// longest description ("读取我的所有仓库") comfortably; longer
				// english names overflow visually but the row never reflows.
				'.dsh-gh-toolchip{display:inline-flex;align-items:center;gap:6px;height:26px;',
				'padding:0 12px;border-radius:999px;font-size:12px;line-height:18px;',
				'white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
				'background:var(--dsw-alias-bg-module-platform,transparent);',
				'color:var(--dsw-alias-label-primary);font-family:inherit;cursor:pointer;font:inherit;',
				'transition:opacity .12s ease, background .12s ease;',
				'min-width:7.5rem;justify-content:center;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
				'.dsh-gh-toolchip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}',
				'.dsh-gh-toolchip:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));outline-offset:1px}',
				'.dsh-gh-toolchip.off{opacity:.42}',
				'.dsh-gh-toolchip.off:hover:not(:disabled){opacity:.7}',
				'.dsh-gh-toolchip.on .dsh-gh-toolname{font-weight:500}',
				'.dsh-gh-toolname{display:inline-block;text-align:center}',
			].join('')
			document.head.appendChild(style)
		}

		/** Fetch the describe mirror and pick out our two namespaces. */
		async function describeOurs(ctx) {
			const binder = ctx.settingsScope
			if (!binder || typeof binder.describe !== 'function')
				throw new Error('settingsScope service unavailable')
			const face = binder.describe()
			await face.ensure()
			const snap = face.getSnapshot()
			if (snap.status === 'unavailable')
				throw new Error(snap.error || 'settings mirror unavailable')
			const list = (snap.view && snap.view.namespaces) || []
			const byNs = new Map(list.map(d => [d.ns, d]))
			return { tools: byNs.get(NS_TOOLS) || null, gate: byNs.get(NS_GATE) || null }
		}

		/** One path-op write against a namespace's user layer. */
		async function writeOp(ctx, ns, descriptor, op) {
			const binder = ctx.settingsScope
			if (!binder || typeof binder.bind !== 'function')
				throw new Error('settingsScope service unavailable')
			const scope = binder.bind({ namespace: ns })
			await scope.mutate([op], descriptor && typeof descriptor.revision === 'number' ? descriptor.revision : undefined)
		}

		/** True when the redaction sidecar reports a value at `field`. */
		function secretSet(descriptor, field) {
			const secrets = (descriptor && descriptor.secrets) || []
			return secrets.some(s => Array.isArray(s.path) && s.path.join('.') === field && s.set === true)
		}

		/**
		 * Native OS folder chooser via the `uiWorkspace` service. The pre-0.9.3
		 * code path (`connection.rpc.call('/host', 'pickDirectory', {})`) was
		 * retired in DSH 0.1.5-rc.1 — the rpc channel is still mounted but the
		 * `/host/pickDirectory` endpoint is not, so the older call would
		 * silently no-op (zero console error, zero UI feedback). Returns the
		 * picked absolute path, throws a readable error otherwise.
		 *
		 * v1.0.4: defensive logging — every failure path emits a console line
		 * tagged `[dsh-gh]`, so an end-user who reports "浏览按钮没反应" can
		 * paste the console output and we can pinpoint the missing service vs.
		 * the host rejection vs. the picker UI itself.
		 */
		async function pickDirectory(ctx) {
			console.log('[dsh-gh] pickDirectory invoked; uiWorkspace typeof =', typeof (ctx && ctx.uiWorkspace))
			const ws = ctx && ctx.uiWorkspace
			if (!ws || typeof ws.pickDirectory !== 'function') {
				const msg = '此宿主未提供目录选择器（uiWorkspace.pickDirectory 不可用）'
				console.warn('[dsh-gh] pickDirectory: ' + msg + ' — available ctx keys =',
					ctx ? Object.keys(ctx).filter(k => /workspace|fs|connection|host/i.test(k)) : '<no ctx>')
				throw new Error(msg + '，请手动输入路径')
			}
			try {
				const picked = await ws.pickDirectory()
				console.log('[dsh-gh] pickDirectory resolved:', picked)
				return picked
			} catch (error) {
				console.error('[dsh-gh] pickDirectory threw:', error)
				throw error
			}
		}

		function makePanel(ctx) {
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

			// ------------------------------------------------------------------------
			// One tool chip: a colored risk dot + a label that swaps english ↔
			// Chinese on hover. The chip stays the same physical size — only the
			// inner `<span>` text changes (so layout never shifts). Tapping the
			// chip toggles its presence in `excludeTools`; opacity 0.42 marks
			// untoggled (intercepted) state so the currently-exempt set is
			// obvious at a glance.
			// ------------------------------------------------------------------------
			function ToolChip({ tool, checked, busy, onToggle }) {
				const [hovered, setHovered] = useState(false)
				const cls = 'dsh-gh-toolchip ' + (checked ? 'on' : 'off')
				return h('button', {
					className: cls,
					type: 'button',
					disabled: busy,
					onMouseEnter: () => setHovered(true),
					onMouseLeave: () => setHovered(false),
					onFocus: () => setHovered(true),
					onBlur: () => setHovered(false),
					onClick: () => onToggle(tool.name),
					'aria-label': tool.desc + '（' + (checked ? '已豁免' : '已拦截') + '）',
					'aria-pressed': !!checked,
					title: tool.desc,
				},
					h('span', { className: 'dsh-gh-risk ' + RISK_DOT_CLASS[tool.risk] }),
					h('span', { className: 'dsh-gh-toolname' }, hovered ? tool.desc : tool.name),
				)
			}

			// ------------------------------------------------------------------------
			// Exempt-tools panel: 33 chips grouped by risk color, with three
			// "快速预设" buttons above the list. Toggling a chip writes
			// `excludeTools` directly (the `mode` field is left alone for
			// back-compat with users who have it set in their settings.yaml).
			// Tapping a preset button overwrites `excludeTools` with the
			// matching default set in one shot.
			// ------------------------------------------------------------------------
			function ExcludeToolsRow({ gate, busy, writeError, onWrite }) {
				const current = Array.isArray(gate.value && gate.value.excludeTools)
					? gate.value.excludeTools : []
				const [flash, setFlash] = useState('')
				useEffect(() => {
					if (!flash) return
					const t = setTimeout(() => setFlash(''), 2500)
					return () => clearTimeout(t)
				}, [flash])

				const writeList = (nextList, label) => onWrite(
					{ op: 'set', path: ['excludeTools'], value: nextList },
					() => setFlash(label),
				)

				const toggle = name => {
					const wasOn = current.includes(name)
					console.log('[dsh-gh] toggle:', name, 'was:', wasOn ? 'on' : 'off', 'current.length =', current.length)
					const t = TOOL_BY_NAME[name]
					const flashText = wasOn
						? '已恢复审批：' + t.desc
						: '已免审批：' + t.desc
					const next = wasOn
						? current.filter(n => n !== name)
						: current.concat([name])
					writeList(next, flashText)
				}

				const applyPreset = mode => {
					const next = defaultListForMode(mode)
					if (next === null) return
					writeList(next, '已应用预设「' + MODE_PRESET_LABEL[mode] + '」')
				}

				const groups = RISK_ORDER.map(risk => ({
					risk,
					label: RISK_LABEL[risk],
					tools: TOOL_LIST.filter(t => t.risk === risk),
				}))

				return h('div', { className: 'dsh-gh-row stack' },
					writeError ? h('div', { className: 'dsh-gh-error', style: { marginTop: 0 } }, '写入失败：' + writeError) : null,
					h('div', { className: 'dsh-gh-labels' },
						h('span', null, '豁免工具（免审批）',
							h('span', { className: 'dsh-gh-badge' }, String(current.length) + ' / ' + TOOL_NAMES.length)),
						h('span', { className: 'dsh-gh-hint' },
							'悬停胶囊直接显示中文描述，按风险标红黄绿；点预设一键覆盖，手点胶囊走自定义。'),
					),
					h('div', { className: 'dsh-gh-modebar' },
						h('span', { className: 'dsh-gh-modebar-label' }, '快速预设：'),
						RISK_ORDER.length === 0 ? null : h('button', {
							key: 'off', className: 'dsh-gh-modebar-btn', disabled: busy,
							onClick: () => applyPreset('off'),
							title: MODE_PRESET_LABEL.off,
						}, MODE_PRESET_BUTTON.off),
						h('button', {
							key: 'writes', className: 'dsh-gh-modebar-btn', disabled: busy,
							onClick: () => applyPreset('writes'),
							title: MODE_PRESET_LABEL.writes,
						}, MODE_PRESET_BUTTON.writes),
						h('button', {
							key: 'all', className: 'dsh-gh-modebar-btn', disabled: busy,
							onClick: () => applyPreset('all'),
							title: MODE_PRESET_LABEL.all,
						}, MODE_PRESET_BUTTON.all),
					),
					h('div', { className: 'dsh-gh-tools-by-risk' },
						groups.map(g => h('div', { key: g.risk, className: 'dsh-gh-toolgroup' },
							h('div', { className: 'dsh-gh-toolgroup-label' },
								h('span', { className: 'dsh-gh-risk ' + RISK_DOT_CLASS[g.risk] }),
								g.label + '（' + g.tools.length + '）',
							),
							h('div', { className: 'dsh-gh-chips' },
								g.tools.map(t => h(ToolChip, {
									key: t.name,
									tool: t,
									checked: current.includes(t.name),
									busy,
									onToggle: toggle,
								})),
							),
						)),
					),
					flash ? h('div', { className: 'dsh-gh-flash' }, flash) : null,
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
						const ours = await describeOurs(ctx)
						setState({ loading: false, error: '', tools: ours.tools, gate: ours.gate })
					} catch (error) {
						setState({ loading: false, error: String((error && error.message) || error), tools: null, gate: null })
					}
				}

				useEffect(() => { void reload() }, [])

				const write = async (ns, descriptor, op, after) => {
					if (!descriptor) {
						console.warn('[dsh-gh] write: descriptor missing for', ns, op.path)
						return
					}
					console.log('[dsh-gh] write:', ns, op.path, '=', Array.isArray(op.value) ? op.value.length + ' items' : 'scalar')
					setBusy(true)
					setWriteError('')
					try {
						await writeOp(ctx, ns, descriptor, op)
						if (after) after()
						await reload()
						console.log('[dsh-gh] write OK:', ns, op.path)
					} catch (error) {
						console.error('[dsh-gh] write failed:', ns, op.path, error)
						setWriteError(String((error && error.message) || error) + '（写入路径：' + ns + ' / ' + op.path.join('.') + '）')
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
						h(ToggleRow, {
							label: '本地克隆工具', hint: '允许 agent 把仓库（含私有仓）克隆到本机目录；令牌只经环境变量注入单个 git 子进程，不进命令行、URL、.git/config 和日志',
							checked: !!(t.value && t.value.enableCloneTools),
							onChange: v => write(NS_TOOLS, t, { op: 'set', path: ['enableCloneTools'], value: v }),
						}),
						h(TextRow, {
							label: '默认克隆目录', field: 'workspaceRoot',
							badge: t.value && typeof t.value.workspaceRoot === 'string' && t.value.workspaceRoot.trim()
								? '已设置' : '未设置',
							hint: '克隆落点优先级：当前会话的工作区 → 此目录 → 询问你。适合存放临时参考的克隆；目录不存在时自动创建。',
							placeholder: '例如 D:\\work_space\\github',
							value: t.value && t.value.workspaceRoot, busy,
							onWrite: (op, after) => write(NS_TOOLS, t, op, after),
							onBrowse: () => pickDirectory(ctx),
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
							writeError: writeError,
							onWrite: (op, after) => write(NS_GATE, g, op, after),
						}),
						writeError ? h('div', { className: 'dsh-gh-error' }, '写入失败：' + writeError) : null,
					) : null,
				)
			}

			return GithubSettingsPanel
		}

		function apply(ctx) {
			console.log('[dsh-gh] apply: ctx.settingsScope =', typeof (ctx && ctx.settingsScope),
				'ctx.slots =', typeof (ctx && ctx.slots),
				'ctx.uiWorkspace =', typeof (ctx && ctx.uiWorkspace))
			ensureStyles()
			try {
				if (!ctx.slots) throw new Error('slots service not injected — is "slots" in this module\'s inject list?')
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'dsh-github-companion',
					order: 60,
					label: () => 'GitHub',
				}, makePanel(ctx)))
				console.log('[dsh-gh] settings card registered (id=dsh-github-companion)')
			} catch (error) {
				// Older hosts without the settings.section seat: degrade audibly
				// in the browser console but never break the host.
				console.warn('[dsh-plugin-github] settings card not registered:', String((error && error.message) || error))
			}
		}

		module.exports.inject = ['settingsScope', 'slots', 'uiWorkspace']
		module.exports.apply = apply
		return module.exports
	},
})
