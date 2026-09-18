import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const clientPath = resolve(root, packageJson.exports['./client'])
const source = await readFile(clientPath, 'utf8')

if (packageJson.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be web')
if (!Array.isArray(packageJson.dsh?.client?.inject) || !packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer')) {
	throw new Error('dsh.client must declare the renderer dependency')
}
if (!source.includes('window.__ModuleLoader__.load')) throw new Error('client bundle is not a DSH ModuleLoader registration')
if (!source.includes('/api/trade/state')) throw new Error('client does not consume the read-only trade state route')
if (!source.includes('/api/trade/cycles?limit=8')) throw new Error('client does not consume the read-only cycle ledger route')
if (!source.includes('restartCount1h') || !source.includes('currentStep')) throw new Error('client does not consume startup recovery projection')
if (source.includes("'POST'") || source.includes('trade_execute_order')) throw new Error('client contains a write trade path')

let registration
const fetchRequests = []
const context = vm.createContext({
  window: {
		__ModuleLoader__: {
			load(value) {
				registration = value
      },
    },
  },
  fetch: async (input, init) => {
    fetchRequests.push({ input: String(input), init: init ?? {} })
    return { ok: true, status: 200, json: async () => ({ ok: true, state: {} }) }
  },
  setInterval: () => 1,
  clearInterval: () => {},
})
vm.runInContext(source, context, { filename: clientPath })
if (registration?.id !== 'dsh-trader' || typeof registration.factory !== 'function') throw new Error('invalid dsh-trader client registration')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useEffect(effect) {
    effect()
  },
}
const registrations = []
const mounted = []
const slots = {
	inject(name, callback) {
		registrations.push({ name, dispose: callback() })
	},
	register(options, component) {
		mounted.push({ options, component })
		return () => {}
	},
}
const plugin = registration.factory((specifier) => {
	if (specifier === 'react') return React
	throw new Error(`unexpected client external: ${specifier}`)
})
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots') || typeof plugin.apply !== 'function') throw new Error('invalid client plugin face')

plugin.apply({ slots })
const names = registrations.map(({ name }) => name)
if (names.length !== 2 || !names.includes('main') || !names.includes('sidebar.panellist')) throw new Error(`unexpected slots: ${names.join(', ')}`)
const main = mounted.find(({ options }) => options.name === 'main')
const panelIcon = mounted.find(({ options }) => options.name === 'sidebar.panellist')
if (main?.options.key !== 'trade-console' || panelIcon?.options.id !== 'trade-console') throw new Error('main/sidebar entries are not paired by the owned key')
if (typeof main.component !== 'function' || typeof panelIcon.component !== 'function') throw new Error('slot components are missing')
main.component({})
panelIcon.component({ size: 20, active: false })
const stateRequest = fetchRequests.find((request) => request.input === '/api/trade/state')
const cyclesRequest = fetchRequests.find((request) => request.input === '/api/trade/cycles?limit=8')
if (fetchRequests.length !== 2 || stateRequest === undefined || cyclesRequest === undefined) throw new Error('state/cycle routes were not fetched')
if (stateRequest.init.credentials !== 'same-origin' || stateRequest.init.cache !== 'no-store') throw new Error('state fetch is not same-origin no-store')
if (cyclesRequest.init.credentials !== 'same-origin' || cyclesRequest.init.cache !== 'no-store') throw new Error('cycle fetch is not same-origin no-store')

console.log(JSON.stringify({
	client_bundle: clientPath,
	registration_id: registration.id,
	plugin_inject: plugin.inject,
  slots: names,
  read_only: source.toLowerCase().includes('read-only state') && source.includes('/api/trade/state'),
  state_route: '/api/trade/state',
  state_fetch: stateRequest,
  cycles_fetch: cyclesRequest,
  status: 'ok',
}, null, 2))
