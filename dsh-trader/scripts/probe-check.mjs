#!/usr/bin/env node
/**
 * T0.9 闭环探针验收（plan §4.6 R1/R2 / §10 P0 验收 ⑤）。
 *
 * 跑两遍 headless probe profile，并做**两层**核验：
 *   1. 进程内观测（插件写出的 result JSON）：resume/create、notice 来源、assistant 回复；
 *   2. **落盘核验**：解压 session 日志，确认那条注入消息真的以 `form: 'notice'` 持久化成了
 *      `user/message` 记录（而不是被当成用户说的话）—— 这是 R2 的实质。
 *
 * ⚠️ session 日志是**多帧拼接**的 zstd（append-only 写入），`zstdDecompressSync` 只解第一帧，
 * 必须按帧魔数切分后逐帧解压。
 *
 * 用法：pnpm build && node scripts/probe-check.mjs [profile] [resultPath]
 * 前置：profile 由 headless 模板创建、已装 dsh-trader、并在其 cordis.patch.yml 里启用 trade-probe。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const PROFILE = process.argv[2] ?? 'probe'
const RESULT = process.argv[3] ?? '/tmp/trade-probe-result.json'
const MARKER = 'TRADE-PROBE-NOTICE'
const PROBE_SESSION_ID = 'trade-probe-session'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(DSH_HOME, 'sessions')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function runProfile() {
  rmSync(RESULT, { force: true })
  execFileSync('dsh', ['--profile', PROFILE, 'say ok'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  })
  return JSON.parse(readFileSync(RESULT, 'utf8'))
}

function sessionDir(sessionId) {
  for (const slug of readdirSync(SESSIONS)) {
    const candidate = join(SESSIONS, slug, sessionId)
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 该 slug 下没有这个会话
    }
  }
  return undefined
}

/** 多帧 zstd：按帧魔数切分，逐帧解压后拼接。 */
function decodeSessionLog(path) {
  const buffer = readFileSync(path)
  const starts = []
  let cursor = 0
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    starts.push(cursor)
    cursor += ZSTD_MAGIC.length
  }
  if (starts.length === 0) throw new Error(`${path} 不是 zstd 文件`)
  let text = ''
  for (let frame = 0; frame < starts.length; frame += 1) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(starts[frame], end)).toString('utf8')
    } catch {
      // 坏帧跳过即可，日志是 append-only 的
    }
  }
  return text
}

function parseRecords(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter((record) => record !== undefined)
}

// 清场：删掉上一轮探针会话，才能验证"第一次是 create、第二次是 resume"
rmSync(sessionDir(PROBE_SESSION_ID) ?? join(SESSIONS, '_missing', PROBE_SESSION_ID), {
  recursive: true,
  force: true,
})

const first = runProfile()
const second = runProfile()

const injectedSessionId = first.injectedSessionId ?? second.injectedSessionId
const dir = injectedSessionId === null ? undefined : sessionDir(injectedSessionId)
const logPath = dir === undefined ? undefined : join(dir, 'session.v3.jsonl.zstd')

let persisted = {
  logFound: false,
  injectedRecordFound: false,
  persistedSource: null,
  assistantAfterInjection: false,
  userMessageCount: 0,
  assistantMessageCount: 0,
}

if (logPath !== undefined) {
  const records = parseRecords(decodeSessionLog(logPath))
  const injectedIndex = records.findIndex(
    (record) =>
      record.type === 'user/message' && JSON.stringify(record.data?.content ?? '').includes(MARKER),
  )
  persisted = {
    logFound: true,
    injectedRecordFound: injectedIndex >= 0,
    persistedSource: injectedIndex < 0 ? null : (records[injectedIndex].data?.source ?? null),
    assistantAfterInjection:
      injectedIndex >= 0 &&
      records.slice(injectedIndex).some((record) => record.type === 'assistant/message'),
    userMessageCount: records.filter((record) => record.type === 'user/message').length,
    assistantMessageCount: records.filter((record) => record.type === 'assistant/message').length,
  }
}

const checks = {
  first_run_created_session: first.created === true && first.resumed === false,
  second_run_resumed_session: second.resumed === true && second.created === false,
  followup_produced_assistant_message: first.checks.followup_produced_assistant_message === true,
  injected_message_carries_notice_form: first.checks.injected_message_carries_notice_form === true,
  injected_message_is_not_user_source: first.checks.injected_message_is_not_user_source === true,
  persisted_user_message_has_notice_form: persisted.persistedSource?.form === 'notice',
  persisted_source_is_plugin_kind: persisted.persistedSource?.kind === 'plugin',
  persisted_log_has_assistant_after_injection: persisted.assistantAfterInjection,
}

console.log(
  JSON.stringify(
    {
      profile: PROFILE,
      marker: MARKER,
      first: { resumed: first.resumed, created: first.created, injectedSource: first.injectedSource },
      second: { resumed: second.resumed, created: second.created },
      persisted: { ...persisted, logPath: logPath ?? null },
      checks,
      allPassed: Object.values(checks).every(Boolean),
    },
    null,
    2,
  ),
)

process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
