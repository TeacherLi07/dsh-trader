import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashBuildArtifacts, verifyBuildIntegrity } from '../src/util/build-integrity.js'

describe('build artifact integrity', () => {
  it('binds generated files to a git revision and detects stale or modified lib output', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-trader-build-integrity-'))
    try {
      mkdirSync(join(root, 'nested'))
      writeFileSync(join(root, 'nested', 'runtime.js'), 'export const generation = 1\n')
      const artifactsHash = hashBuildArtifacts(root)
      const gitCommit = 'a'.repeat(40)
      writeFileSync(join(root, 'build-manifest.json'), JSON.stringify({ schemaVersion: 1, gitCommit, artifactsHash }))

      expect(verifyBuildIntegrity(root, gitCommit, artifactsHash)).toEqual({ schemaVersion: 1, gitCommit, artifactsHash })
      expect(hashBuildArtifacts(root)).toBe(artifactsHash)
      writeFileSync(join(root, 'nested', 'runtime.js'), 'export const generation = 2\n')
      expect(() => verifyBuildIntegrity(root, gitCommit, artifactsHash)).toThrow(/构建产物.*不匹配/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlink used as the build artifact root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-trader-build-integrity-link-'))
    const target = join(root, 'target')
    const link = join(root, 'lib')
    try {
      mkdirSync(target)
      writeFileSync(join(target, 'runtime.js'), 'export const safe = true\n')
      symlinkSync(target, link, 'dir')
      expect(() => hashBuildArtifacts(link)).toThrow(/构建产物根.*符号链接/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
