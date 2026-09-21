/** 将被 Git 忽略的 lib/ 产物绑定到 R5 使用的源码版本（plan §10.2）。 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export interface BuildIntegrityRecord {
  readonly schemaVersion: 1
  readonly gitCommit: string
  readonly artifactsHash: string
}

/** 对全部生成的运行文件求指纹；排除记录自身以避免递归引用。 */
export function hashBuildArtifacts(directory: string): string {
  const root = resolve(directory)
  if (!existsSync(root)) throw new Error('构建产物目录缺失')
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('构建产物根必须是普通目录，不能是符号链接')
  const paths: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error('构建产物目录不得含符号链接')
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        const rel = relative(root, absolute).replaceAll('\\', '/')
        if (rel !== 'build-manifest.json') paths.push(rel)
      } else throw new Error('构建产物目录含不支持的文件类型')
    }
  }
  walk(root)
  paths.sort()
  if (paths.length === 0) throw new Error('构建产物目录为空')
  const hash = createHash('sha256')
  for (const path of paths) {
    const content = readFileSync(join(root, path))
    hash.update(path).update('\0').update(String(content.byteLength)).update('\0').update(content).update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export function verifyBuildIntegrity(
  directory: string,
  expectedGitCommit: string,
  expectedArtifactsHash: string,
): BuildIntegrityRecord {
  const root = resolve(directory)
  const artifactsHash = hashBuildArtifacts(root)
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(join(root, 'build-manifest.json'), 'utf8')) }
  catch { throw new Error('生成的 build manifest 缺失或无效') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('生成的 build manifest 结构无效')
  }
  const record = parsed as Record<string, unknown>
  if (record['schemaVersion'] !== 1 || typeof record['gitCommit'] !== 'string' ||
      !/^[a-f0-9]{40}$/.test(record['gitCommit']) || typeof record['artifactsHash'] !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(record['artifactsHash'])) {
    throw new Error('生成的 build manifest 字段无效')
  }
  if (record['gitCommit'] !== expectedGitCommit || record['artifactsHash'] !== artifactsHash ||
      expectedArtifactsHash !== artifactsHash) {
    throw new Error('构建产物与冻结的源码/构建身份不匹配')
  }
  return { schemaVersion: 1, gitCommit: record['gitCommit'], artifactsHash }
}
