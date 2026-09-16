import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
    expect(patch).not.toMatch(/^\s*mode:\s*(paper|live_confirm|live_auto)\s*$/m)
  })
})
