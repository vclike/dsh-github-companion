/**
 * dsh-plugin-github — browser half (settings card).
 *
 * Contributes one "GitHub" section to the DSH settings page, rendering the
 * backend-registered `github-tools` and `github-gate` namespaces through the
 * official settings surface (describe + mutate over the client connection).
 *
 * Hand-written against the shared client externals (`react` via the module
 * loader's require) — same shape as dsh-status-rotator's browser half, so no
 * bundler step is needed. Everything degrades silently on hosts that lack the
 * seats this card rides on.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-github',
	factory: (require) => {
		var module = { exports: {} }
		const react = require('react')

		const NS_TOOLS = 'github-tools'
		const NS_GATE = 'github-gate'

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
		async function setField(api, ns, descriptor, field, value) {
			const res = await api.settings.mutate({
				ns,
				ops: [{ op: 'set', path: [field], value }],
				expectedRevision: descriptor.revision,
			})
			const inner = res && res.result ? res.result : null
			if (!inner || !inner.ok)
				throw new Error(inner && inner.message ? inner.message : 'settings write failed')
		}

		function makePanel(getConnection) {
			const h = react.createElement
			const { useState, useEffect } = react

			const rowStyle = {
				display: 'flex', alignItems: 'center', justifyContent: 'space-between',
				gap: 12, padding: '6px 0',
			}
			const groupStyle = {
				display: 'flex', flexDirection: 'column', gap: 2, width: '100%',
				maxWidth: 560, padding: '10px 12px', marginBottom: 12,
				border: '1px solid var(--dsw-alias-label-primary-dimmed, rgba(127,127,127,.35))',
				borderRadius: 10,
			}
			const titleStyle = { margin: '0 0 4px', fontSize: 14, fontWeight: 600 }
			const mutedStyle = {
				fontSize: 12, opacity: 0.65, margin: '2px 0 8px',
			}
			const selectStyle = {
				font: 'inherit', padding: '4px 8px', borderRadius: 8,
				border: '1px solid var(--dsw-alias-label-primary-dimmed, rgba(127,127,127,.45))',
				background: 'transparent', color: 'inherit',
			}
			const inputStyle = {
				...selectStyle, flex: 1, minWidth: 0,
			}
			const saveStyle = {
				cursor: 'pointer', font: 'inherit', borderRadius: 999, padding: '3px 12px',
				border: '1px solid var(--dsw-alias-label-primary-dimmed, rgba(127,127,127,.45))',
				background: 'var(--dsw-alias-label-primary,#111)',
				color: 'var(--dsw-alias-label-primary-foreground,#fff)',
			}

			function ToggleRow({ label, hint, checked, disabled, onChange }) {
				return h('label', { style: rowStyle },
					h('span', { style: { display: 'flex', flexDirection: 'column' } },
						h('span', null, label),
						hint ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, hint) : null),
					h('input', {
						type: 'checkbox', checked: !!checked, disabled: !!disabled,
						onChange: e => onChange(e.target.checked),
						style: { width: 18, height: 18, cursor: 'pointer' },
					}))
			}

			function SelectRow({ label, value, options, disabled, onChange }) {
				return h('label', { style: rowStyle },
					h('span', null, label),
					h('select', {
						value, disabled: !!disabled, onChange: e => onChange(e.target.value),
						style: selectStyle,
					}, options.map(o => h('option', { key: o.value, value: o.value }, o.label))))
			}

			function ExcludeToolsRow({ gate, onSave, busy }) {
				const [draft, setDraft] = useState(null)
				const current = Array.isArray(gate.value && gate.value.excludeTools)
					? gate.value.excludeTools.join(', ') : ''
				const text = draft === null ? current : draft
				return h('div', { style: { ...rowStyle, alignItems: 'flex-end' } },
					h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } },
						h('span', null, '豁免工具（逗号分隔，精确名）'),
						h('input', {
							value: text, spellCheck: false, disabled: busy,
							placeholder: '例如：github_search_issues',
							onChange: e => setDraft(e.target.value),
							style: inputStyle,
						})),
					h('button', {
						style: saveStyle, disabled: busy || draft === null,
						onClick: () => {
							const list = text.split(',').map(s => s.trim()).filter(Boolean)
							onSave(list, () => setDraft(null))
						},
					}, '保存'))
			}

			function Group({ title, children }) {
				return h('div', { style: groupStyle }, h('h3', { style: titleStyle }, title), children)
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

				const write = async (ns, descriptor, field, value, after) => {
					if (!descriptor) return
					setBusy(true)
					setWriteError('')
					try {
						const conn = getConnection()
						await setField(conn.api, ns, descriptor, field, value)
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
					return h('div', { style: mutedStyle }, '正在读取 GitHub 设置…')
				if (state.error)
					return h('div', { style: { ...mutedStyle, color: '#c0392b' } },
						'无法读取设置界面数据：' + state.error)

				const t = state.tools
				const g = state.gate
				const anyPresent = !!(t || g)

				return h('div', { style: { width: '100%' } },
					!anyPresent ? h('div', { style: mutedStyle },
						'未发现 github-tools / github-gate 命名空间——插件可能未启用。') : null,

					t ? h(Group, { title: 'GitHub 工具' },
						h(ToggleRow, {
							label: 'Issue 写操作', hint: 'create/update/comment 三类写工具的注册开关',
							checked: !!(t.value && t.value.enableIssueWrites),
							onChange: v => write(NS_TOOLS, t, 'enableIssueWrites', v),
						}),
						h(ToggleRow, {
							label: 'Git 数据写操作', hint: '分支/提交文件/PR 等六个工具（含两个只读 PR 工具）',
							checked: !!(t.value && t.value.enableGitDataTools),
							onChange: v => write(NS_TOOLS, t, 'enableGitDataTools', v),
						}),
						h('div', { style: mutedStyle }, '改动实时生效。'),
					) : null,

					g ? h(Group, { title: 'GitHub 权限门' },
						h(SelectRow, {
							label: '门控范围',
							value: (g.value && g.value.mode) || 'writes',
							options: [
								{ value: 'off', label: 'off — 不拦截' },
								{ value: 'writes', label: 'writes — 拦截写工具' },
								{ value: 'all', label: 'all — 拦截所有 github_* 工具' },
							],
							onChange: v => write(NS_GATE, g, 'mode', v),
						}),
						h(SelectRow, {
							label: '拦截动作',
							value: (g.value && g.value.action) || 'ask',
							options: [
								{ value: 'ask', label: 'ask — 弹出审批' },
								{ value: 'deny', label: 'deny — 直接拒绝' },
							],
							onChange: v => write(NS_GATE, g, 'action', v),
						}),
						h(ExcludeToolsRow, {
							gate: g, busy,
							onSave: (list, after) => write(NS_GATE, g, 'excludeTools', list, after),
						}),
						writeError ? h('div', { style: { ...mutedStyle, color: '#c0392b' } }, '写入失败：' + writeError) : null,
					) : null,
				)
			}

			return GithubSettingsPanel
		}

		function apply(ctx) {
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
