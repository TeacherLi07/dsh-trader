import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const helperUrl = new URL('../scripts/model-connection-config.mjs', import.meta.url).href
function readFixture(baseURL = 'https://ai.teacherli.net', wire = 'responses', websocket = true): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'luna-config-'))
  directories.push(directory)
  const path = join(directory, 'config.toml')
  writeFileSync(path, `model_provider = "gateway"\nmodel = "irrelevant-default"\nmodel_reasoning_effort = "high"\n[model_providers.gateway]\nbase_url = "${baseURL}"\nwire_api = "${wire}"\nsupports_websockets = ${websocket}\napi_key = "FAKE_SECRET_SHOULD_NOT_LEAVE_CONFIG"\n`)
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {readLunaGatewayConfig,lunaProviderConfig} from ${JSON.stringify(helperUrl)};
    const config=readLunaGatewayConfig(process.argv[1]);
    console.log(JSON.stringify({config,provider:lunaProviderConfig(config,32768)}));`, path],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, unknown>
}

describe('真实连接配置按本轮授权固定来源', () => {
  it('读取所选 provider，但显式模型、max 和环境引用优先于 Codex 默认模型', () => {
    const result = readFixture()
    expect(result).toMatchObject({ config: { baseURL: 'https://ai.teacherli.net/', apiKeyEnv: 'SUB2API_KEY',
      model: 'sub2api:gpt-6-luna', wireModelId: 'gpt-6-luna', reasoningEffort: 'max' },
      provider: { strictTools: true, models: [{ defaultReasoningEffort: 'max', contextWindow: 1_050_000, maxTokens: 32768 }] } })
    expect(JSON.stringify(result)).not.toContain('FAKE_SECRET')
    expect(JSON.stringify(result)).not.toContain('irrelevant-default')
  })
  it('兼容已有 /v1 base URL', () => {
    expect(readFixture('https://ai.teacherli.net/v1')).toMatchObject({ config: { baseURL: 'https://ai.teacherli.net/v1' } })
  })
  it.each(['http://ai.teacherli.net', 'https://other.invalid', 'https://fake:fake@ai.teacherli.net',
    'https://ai.teacherli.net?key=fake', 'https://ai.teacherli.net/responses'])('拒绝未授权或含认证信息端点 %s', (url) => {
    expect(() => readFixture(url)).toThrow()
  })
  it('拒绝没有明确 WS 能力或错误协议的配置', () => {
    expect(() => readFixture(undefined, 'chat', true)).toThrow()
    expect(() => readFixture(undefined, 'responses', false)).toThrow()
  })
})


describe('真实连接脚本的整轮时间上限', () => {
  it.each(['0', '-1', 'NaN', '1800001'])('拒绝越界上限 %s，且在凭据/网络前拒绝', (timeout) => {
    let stderr = ''
    try {
      execFileSync(process.execPath, [new URL('../scripts/real-connection-check.mjs', import.meta.url).pathname,
        '--decision-timeout-ms', timeout], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr)
    }
    expect(stderr).toContain('decision timeout must be 1..1800000 ms')
    expect(stderr).not.toContain('HTX credentials missing')
  })
})
