#!/usr/bin/env node
/** pnpm build 末尾调用：为被 Git 忽略的 lib/ 产物写入可复核的源码 revision 与 artifact hash。 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashBuildArtifacts } from '../lib/util/build-integrity.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libRoot = resolve(packageRoot, 'lib')
const manifestPath = resolve(libRoot, 'build-manifest.json')
if (existsSync(manifestPath) && lstatSync(manifestPath).isSymbolicLink()) {
  throw new Error('build-manifest.json 不得为符号链接，拒绝覆盖目录外文件')
}
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: packageRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim()
if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('无法为 build artifact 绑定 Git commit')

const record = {
  schemaVersion: 1,
  gitCommit,
  artifactsHash: hashBuildArtifacts(libRoot),
}
writeFileSync(manifestPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
