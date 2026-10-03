import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as packageRoot from '../src/index.js'

describe('交易包 public API', () => {
  it('独立 WS provider 在 patch 中的包子路径可被 Node 正常解析', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> }
    expect(manifest.exports['./plugins/sub2api-responses-ws']).toBe('./lib/plugins/sub2api-responses-ws.js')
    expect(import.meta.resolve('dsh-trader/plugins/sub2api-responses-ws')).toBe(new URL('../lib/plugins/sub2api-responses-ws.js', import.meta.url).href)
  })

  it('包根不暴露可直接持有实盘 broker 或跳过组合根的执行器', () => {
    const internalExecutionExports = [
      'HtxBroker', 'CcxtBroker', 'executeAction', 'executePlanAction',
      'createExecRuntime', 'runDecisionRuntime', 'createLiveEngine', 'ReplayRunner', 'CrashRecovery',
    ]
    for (const name of internalExecutionExports) expect(name in packageRoot).toBe(false)
    expect(packageRoot.name).toBe('dsh-trader')
    expect(typeof packageRoot.apply).toBe('function')
  })

  it('package exports 不开放内核子路径或仅供仓库脚本使用的 internal-api', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> }
    const paths = Object.keys(manifest.exports)
    expect(paths.some((path) => path.startsWith('./exec/'))).toBe(false)
    expect(paths).not.toContain('./plugins/*')
    expect(paths).not.toContain('./internal-api')
    expect(paths).not.toContain('./internal-api.js')
  })

  it('发布产物与源码均不携带已删除的外部撤单进程', () => {
    const removedFiles = [
      '../src/supervisor/watchdog.ts', '../lib/supervisor/watchdog.js',
      '../scripts/watchdog-daemon.mjs', '../scripts/watchdog-check.mjs',
    ]
    expect(removedFiles.length).toBeGreaterThan(0)
    for (const path of removedFiles) expect(existsSync(new URL(path, import.meta.url))).toBe(false)
  })
})
