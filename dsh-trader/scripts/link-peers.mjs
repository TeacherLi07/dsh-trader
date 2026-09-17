#!/usr/bin/env node
/**
 * 把 DSH 自带的 `@deepseek-ai/*` 包软链到本仓库的 node_modules，供编辑器与类型检查使用。
 *
 * 为什么不用 pnpm 的 `link:` 依赖：pnpm 会为带 `bin` 字段的包创建命令 shim，
 * 并对**目标目录里的源文件**执行 chmod，而 `$DSH_HOME/profiles/node_modules` 不允许这样改 ——
 * 会以 ERR_PNPM_CMD_SHIM_CHMOD 失败。这些包本来就是 **peerDependencies**（由 DSH 运行时提供），
 * 不该被本包安装，因此这里只做"开发期解析"用的软链。
 *
 * 用法：pnpm link:peers
 * 可用 DSH_PROFILE_SCOPE 覆盖默认位置。
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scope =
  process.env.DSH_PROFILE_SCOPE ?? '/home/ubuntu/.dsh/profiles/node_modules/@deepseek-ai'
const target = join(repoRoot, 'node_modules', '@deepseek-ai')

const PACKAGES = [
  'cordis',
  'dsh-agent',
  'dsh-client-connection',
  'dsh-tools',
  'dsh-system-prompt',
  'dsh-session',
  'dsh-subagent',
  'dsh-llm',
  'schemastery',
]

if (!existsSync(scope)) {
  console.error(`[link-peers] 找不到 DSH 包目录：${scope}`)
  console.error('[link-peers] 用 DSH_PROFILE_SCOPE=<DSH_HOME>/profiles/node_modules/@deepseek-ai 覆盖')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

let linked = 0
for (const pkg of PACKAGES) {
  const from = join(scope, pkg)
  if (!existsSync(from)) {
    console.warn(`[link-peers] 缺少 ${pkg}，已跳过`)
    continue
  }
  symlinkSync(from, join(target, pkg), 'dir')
  linked += 1
}
console.log(`[link-peers] 已链接 ${linked}/${PACKAGES.length} 个 peer 包 → ${scope}`)
