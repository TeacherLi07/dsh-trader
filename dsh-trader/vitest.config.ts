import { defineConfig } from 'vitest/config'

/**
 * `@deepseek-ai/*` 是 peerDependencies，由 DSH 运行时提供。
 * 这里把裸标识符指向本机 profile 的 node_modules，使将来引用插件的单测也能直接跑，
 * 而不需要把 DSH 的包安装进本仓库（那样会因 chmod 失败，见 scripts/link-peers.mjs）。
 */
const dshScope =
  process.env.DSH_PROFILE_SCOPE ?? '/home/ubuntu/.dsh/profiles/node_modules/@deepseek-ai'

export default defineConfig({
  resolve: {
    alias: [{ find: /^@deepseek-ai\/(.*)$/, replacement: `${dshScope}/$1` }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
})
