import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Entry {
  readonly id: string
  readonly name: string
  readonly config?: Record<string, unknown>
}

describe('部署 profile 的实际 bundle 组合', () => {
  it('官方 base/web 与包 patch 合成后，每个 id 唯一且原有 Responses 路由完整', async () => {
    // 精简插件 fixture 没有官方 base 的同名条目；这里直接复用启动时的解析器和合成器。
    const scope = process.env.DSH_PROFILE_SCOPE ?? '/home/ubuntu/.dsh/profiles/node_modules/@deepseek-ai'
    const require = createRequire(join(scope, 'dsh-app-boot/package.json'))
    const moduleUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href
    const boot = await import(/* @vite-ignore */ moduleUrl) as {
      loadOverlayPatches: (name: string, path: string) => unknown[]
      composeEntries: (layers: unknown[][], warn: (message: string) => void) => Entry[]
    }
    const layers = [
      join(scope, 'dsh-base/cordis.patch.yml'),
      join(scope, 'dsh-web-app/cordis.patch.yml'),
      fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)),
    ].map(path => boot.loadOverlayPatches('dsh', path))
    const warnings: string[] = []
    const entries = boot.composeEntries(layers, message => warnings.push(message))
    expect(warnings).toEqual([])
    expect(entries.length).toBeGreaterThan(0)
    const ids = entries.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(id => id === 'llm-pi-ai')).toHaveLength(1)
    expect(ids.filter(id => id === 'webserver')).toHaveLength(1)
    const adapter = entries.find(entry => entry.id === 'llm-pi-ai')!
    expect(adapter.name).toBe('@deepseek-ai/dsh-llm-pi-ai')
    const providers = adapter.config?.['providers'] as Record<string, unknown>
    expect(Object.keys(providers).sort()).toEqual(['deepseek-r5-responses', 'deepseek-responses'])
    for (const provider of Object.values(providers)) {
      expect(provider).toMatchObject({ api: 'openai-responses', transport: 'sse', reasoning: 'high',
        retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'deepseek-flash' }] })
    }
    expect(entries.find(entry => entry.id === 'trade-ui')?.name).toBe('dsh-trader/plugins/ui')
    expect(entries.find(entry => entry.id === 'trade-ui-client')?.name).toBe('dsh-trader')
  })
})
