/*
 * dsh-trader 的浏览器半：S0 挂载探针 + S2 只读状态面。
 *
 * 只用同源 GET 读取 `/api/trade/state`；浏览器沿用 DSH connection 的认证 cookie。
 * 不提供 POST、撤单、模式切换或其它控制路径。这个文件保持为 DSH client-loader
 * 的无依赖 bundle 源文本，由 build-client.mjs 原样复制到 lib/client.js。
 */
window.__ModuleLoader__.load({
	 id: 'dsh-trader',
	 factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		var React = require('react')

		const PANEL_ID = 'trade-console'
		const muted = { color: 'var(--dsw-alias-label-secondary)' }
		const caption = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }
		const card = {
			background: 'var(--dsw-alias-bg-layer-1)',
			border: '0.5px solid var(--dsw-alias-border-l1)',
			borderRadius: 12,
			padding: 16,
		}
		const row = { display: 'flex', gap: 12, justifyContent: 'space-between' }

		function useTradeState() {
			const [snapshot, setSnapshot] = React.useState({ status: 'loading', body: null, error: null })
			React.useEffect(() => {
				let stopped = false
				const refresh = async () => {
					try {
						const response = await fetch('/api/trade/state', {
							cache: 'no-store',
							credentials: 'same-origin',
						})
						const body = await response.json()
						if (stopped) return
						if (!response.ok || body?.ok !== true) {
							setSnapshot({ status: 'rebuilding', body, error: String(body?.error ?? `HTTP ${response.status}`) })
							return
						}
						setSnapshot({ status: 'ready', body, error: null })
					} catch (error) {
						if (!stopped) setSnapshot({ status: 'rebuilding', body: null, error: String(error) })
					}
				}
				void refresh()
				const timer = setInterval(() => void refresh(), 5_000)
				return () => {
					stopped = true
					clearInterval(timer)
				}
			}, [])
			return snapshot
		}

		function display(value) {
			return value === null || value === undefined || value === '' ? '—' : String(value)
		}

		function TradeConsolePanel() {
			const snapshot = useTradeState()
			const state = snapshot.body?.ok === true ? snapshot.body.state : null
			const account = state?.account?.value
			const positions = state?.positions?.value
			const openOrders = state?.openOrders?.value
			return React.createElement(
				'main',
				{
					'aria-label': 'Trade Console S0',
					style: {
						boxSizing: 'border-box',
						maxWidth: 860,
						margin: '0 auto',
						padding: 24,
						width: '100%',
					},
				},
				React.createElement('div', { style: { display: 'grid', gap: 16 } },
					React.createElement('header', { style: { display: 'grid', gap: 6 } },
						React.createElement('div', { style: { ...caption, letterSpacing: '0.08em', textTransform: 'uppercase' } }, 'S2 · Read-only state'),
						React.createElement('h1', { style: { fontSize: 24, margin: 0 } }, 'Trade Console'),
						React.createElement('p', { style: { ...muted, margin: 0 } }, '只读状态面；交易所是当前真相，重建中不显示旧值。'),
					),
					React.createElement('section', { style: card },
						React.createElement('strong', null, snapshot.status === 'ready' ? '状态已读取' : '正在重建'),
						React.createElement('p', { style: { ...muted, margin: '8px 0 0' } }, snapshot.error ?? '仅允许 GET /api/trade/state；没有交易控制入口。'),
					),
					React.createElement('section', { style: card },
						React.createElement('dl', { style: { display: 'grid', gap: 10, margin: 0 } },
							React.createElement('div', { style: row },
								React.createElement('dt', { style: muted }, 'Client seats'),
								React.createElement('dd', { style: { margin: 0 } }, 'main + sidebar.panellist'),
							),
							React.createElement('div', { style: row },
								React.createElement('dt', { style: muted }, 'Mode / venue'),
								React.createElement('dd', { style: { margin: 0 } }, `${display(state?.mode)} / ${display(state?.venue)}`),
							),
							React.createElement('div', { style: row },
								React.createElement('dt', { style: muted }, 'Halt'),
								React.createElement('dd', { style: { margin: 0 } }, state === null ? '—' : state.halted ? 'HALTED' : 'not halted'),
							),
							React.createElement('div', { style: row },
								React.createElement('dt', { style: muted }, 'Equity'),
								React.createElement('dd', { style: { margin: 0 } }, `${display(account?.equityQuote)} · ${display(state?.account?.credibility)}`),
							),
							React.createElement('div', { style: row },
								React.createElement('dt', { style: muted }, 'Positions / orders'),
								React.createElement('dd', { style: { margin: 0 } }, `${positions === null || positions === undefined ? '—' : positions.length} / ${openOrders === null || openOrders === undefined ? '—' : openOrders.length}`),
							),
						),
					),
					React.createElement('p', { style: { ...caption, margin: 0 } }, 'S2 intentionally adds no LLM call, no trade tool, no control action.'),
				),
			)
		}

		function TradeConsoleIcon({ size }) {
			return React.createElement('span', {
				'aria-hidden': true,
				style: {
					alignItems: 'center',
					border: '1px solid currentColor',
					borderRadius: 5,
					display: 'inline-flex',
					fontSize: Math.max(10, Math.round(size * 0.42)),
					fontWeight: 700,
					height: size,
					justifyContent: 'center',
					width: size,
				},
			}, 'T')
		}

		const inject = ['slots']
		function apply(ctx) {
			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: PANEL_ID,
			}, TradeConsolePanel))
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 10,
				label: 'Trade Console',
			}, TradeConsoleIcon))
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
