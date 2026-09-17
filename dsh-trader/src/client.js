/*
 * dsh-trader 的浏览器半只做 S0 挂载探针。
 *
 * 这里故意不读取交易状态、不调用 connection、不提供写操作：S0 先证明
 * trade profile 能把自有 main/sidebar 座位装进原生外壳，读模型与服务端边界
 * 留到后续阶段。这个文件保持为 DSH client-loader 的无依赖 bundle 源文本，
 * 由 build-client.mjs 原样复制到 lib/client.js。
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

		function TradeConsolePanel() {
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
						React.createElement('div', { style: { ...caption, letterSpacing: '0.08em', textTransform: 'uppercase' } }, 'S0 · Read-only mount probe'),
						React.createElement('h1', { style: { fontSize: 24, margin: 0 } }, 'Trade Console'),
						React.createElement('p', { style: { ...muted, margin: 0 } }, '原生 DSH 外壳中的交易操作台座位已挂载。'),
					),
					React.createElement('section', { style: card },
						React.createElement('strong', null, 'S0 边界'),
						React.createElement('p', { style: { ...muted, margin: '8px 0 0' } }, '本面板只验证 client seat；不读取账户、持仓、订单、行情或密钥。交易读模型仍在服务端边界。'),
					),
					React.createElement('section', { style: card },
						React.createElement('dl', { style: { display: 'grid', gap: 10, margin: 0 } },
							React.createElement('div', { style: { display: 'flex', gap: 12, justifyContent: 'space-between' } },
								React.createElement('dt', { style: muted }, 'Client seats'),
								React.createElement('dd', { style: { margin: 0 } }, 'main + sidebar.panellist'),
							),
							React.createElement('div', { style: { display: 'flex', gap: 12, justifyContent: 'space-between' } },
								React.createElement('dt', { style: muted }, 'Data mode'),
								React.createElement('dd', { style: { margin: 0 } }, 'read-only probe'),
							),
							React.createElement('div', { style: { display: 'flex', gap: 12, justifyContent: 'space-between' } },
								React.createElement('dt', { style: muted }, 'Write path'),
								React.createElement('dd', { style: { margin: 0 } }, 'none'),
							),
						),
					),
					React.createElement('p', { style: { ...caption, margin: 0 } }, 'S0 intentionally adds no LLM call, no trade tool, no control action, and no server endpoint.'),
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
