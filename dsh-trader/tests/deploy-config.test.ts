import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { R5_FIXED_MODEL, R5_FIXED_PROVIDER } from '../src/supervisor/r5.js'

/**
 * plan §12.2 E：运行模式必须由**启动参数**决定，不在仓库里写死。
 *
 * 这是结构性测试（读 patch 文本）：`!!js` 表达式不会被单测求值，但只要有这条断言，
 * 谁把 mode 改回字面量 `paper` / `live_auto` 都会立刻变红。
 */
describe('部署配置：运行模式来自启动参数', () => {
  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

  it('trade-exec.mode 引用 TRADER_MODE，而不是字面量', () => {
    expect(patch).toMatch(/mode:\s*!!js\s+process\.env\.TRADER_MODE/)
    expect(patch).not.toMatch(/^\s*mode:\s*(paper|live_auto)\s*$/m)
    expect(patch).toMatch(/liveArmed:\s*!!js\s+process\.env\.TRADER_LIVE_ARMED\s*===\s*'1'/)
    expect(patch).toMatch(/waiver:\s*false/)
  })

  it('R5 静态实验冻结的模型路由与生产 supervisor 路由一致', () => {
    expect(patch).toContain(`l3: { provider: ${R5_FIXED_PROVIDER}, model: ${R5_FIXED_MODEL} }`)
  })
})
