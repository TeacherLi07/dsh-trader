#!/usr/bin/env node
/** 隔离 DSH 真启动：不继承凭据，禁止网络，仅核验 paper 组合根与人工命令。 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-offline-startup-'))
const profile = join(temporary, 'profiles/trade')
const reportPath = join(temporary, 'report.json')
const moduleUrl = (path) => JSON.stringify(pathToFileURL(join(root, path)).href)

try {
  mkdirSync(profile, { recursive: true })
  symlinkSync(join(root, 'node_modules'), join(temporary, 'profiles/node_modules'), 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-offline-startup', private: true,
    dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }))
  const preload = join(temporary, 'no-network.mjs')
  writeFileSync(preload, `
import { Socket } from 'node:net'
globalThis.offlineNetworkAttempts = 0
function blocked() {
  globalThis.offlineNetworkAttempts += 1
  throw new Error('offline startup check forbids network I/O')
}
Socket.prototype.connect = blocked
globalThis.fetch = async () => blocked()
`)
  const checker = join(temporary, 'check.mjs')
  writeFileSync(checker, `
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { getExecPorts } from ${moduleUrl('lib/plugins/exec.js')}
import { getDatabase } from ${moduleUrl('lib/db/runtime.js')}
import { HeartbeatStore } from ${moduleUrl('lib/supervisor/heartbeat.js')}
export const inject = ['commands', 'appExit']
export function apply(ctx) {
  ctx.effect(() => {
    let attempts = 0
    let checking = false
    const timer = setInterval(async () => {
      if (checking) return
      const ports = getExecPorts()
      if (ports === undefined && ++attempts < 100) return
      checking = true
      clearInterval(timer)
      try {
        assert.equal(ports?.broker.venue, 'paper')
        const commands = ctx.commands.list(undefined).map((item) => item.name)
        assert.deepEqual(commands, ['halt', 'resume'])
        const heartbeat = new HeartbeatStore(getDatabase())
        const halt = await ctx.commands.find(undefined, 'halt').handler({})
        assert.equal(halt.kind, 'success')
        assert.equal(heartbeat.isHalted(), true)
        const resume = await ctx.commands.find(undefined, 'resume').handler({})
        assert.equal(resume.kind, 'success')
        assert.equal(heartbeat.isHalted(), false)
        const account = await ports.broker.getAccount()
        assert.ok(account.equityQuote > 0)
        const calls = getDatabase().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind IN ('model_call_reserved', 'model_call_accounted', 'model_call_unresolved')").get().n
        assert.equal(calls, 0)
        assert.equal(globalThis.offlineNetworkAttempts, 0)
        writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
          status: 'passed', broker: ports.broker.venue, commands, halt, resume,
          equityQuote: account.equityQuote, modelCalls: calls, networkAttempts: globalThis.offlineNetworkAttempts,
        }))
        ctx.appExit(0)
      } catch (error) {
        writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ status: 'failed', reason: String(error) }))
        ctx.appExit(1)
      }
    }, 50)
    return () => clearInterval(timer)
  }, 'offline.startup.check')
}
`)
  // 最小树仅挂载本次改变的生产插件及所需服务，避开任何行情/模型 provider adapter。
  writeFileSync(join(profile, 'cordis.patch.yml'), `
- insert:
    - { id: commands, name: '@deepseek-ai/dsh-commands' }
    - { id: llm, name: '@deepseek-ai/dsh-llm' }
    - id: trade-db
      name: ${JSON.stringify(join(root, 'lib/plugins/db.js'))}
      config: { path: ${JSON.stringify(join(temporary, 'desk.db'))} }
    - id: trade-exec
      name: ${JSON.stringify(join(root, 'lib/plugins/exec.js'))}
      config:
        mode: paper
        reconcileEnabled: true
        liveArmed: false
        riskPct: 0.002
        perOrderCapUsd: 12
        maxExposureUsd: 24
        maxLeverage: 1
        dailyLossLimitUsd: 1.25
        maxDrawdownUsd: 2.5
        maxConsecutiveLosses: 3
        maxSpreadBps: 10
        maxOpenOrders: 2
        paperInitialEquityQuote: 24.914
        symbols: ['ADA/USDT:USDT']
        timeframes: [15m, 1h, 4h]
        benchmark: 'BTC/USDT:USDT'
    - { id: trade-commands, name: ${JSON.stringify(join(root, 'lib/plugins/commands.js'))} }
    - id: trade-supervisor
      name: ${JSON.stringify(join(root, 'lib/plugins/supervisor.js'))}
      config: { l3: { provider: offline, model: offline }, windows: [] }
    - { id: offline-check, name: ${JSON.stringify(checker)} }
`)
  const output = execFileSync('dsh', ['--profile', 'trade'], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DSH_HOME: temporary, DSH_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.status, 'passed')
  console.log(JSON.stringify({ ...report, command: 'dsh --profile trade', isolatedProfile: true, output }, null, 2))
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
