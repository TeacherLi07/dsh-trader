/** Codex CLI 的公开客户端标识；网关仍负责其上游账号认证。 */
import { randomUUID } from 'node:crypto'
import { arch, release, type } from 'node:os'

// 本机 codex-cli 0.160.0 已核验；版本只在 provider 配置维护，不在请求热路径执行 CLI。
export const DEFAULT_CODEX_VERSION = '0.160.0'
export const CODEX_ORIGINATOR = 'codex_cli_rs'

export function codexClientIdentity(sessionId: string = randomUUID(), version: string = DEFAULT_CODEX_VERSION) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || version.length > 64) {
    throw new Error('Codex client version must be a valid bounded release identifier')
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new Error('Codex session identity must be a bounded header-safe identifier')
  const architecture = arch() === 'x64' ? 'x86_64' : arch() === 'arm64' ? 'aarch64' : arch()
  // UA 首段必须与 originator 配套；Sub2API 的 PairCodexClientIdentity 会检查这组关系。
  const userAgent = `${CODEX_ORIGINATOR}/${version} (${type()} ${release()}; ${architecture})`
  return {
    sessionId,
    headers: {
      'User-Agent': userAgent, originator: CODEX_ORIGINATOR, version,
      'session-id': sessionId, 'thread-id': sessionId, 'x-client-request-id': sessionId,
    },
    body: { prompt_cache_key: sessionId, client_metadata: { session_id: sessionId, thread_id: sessionId } },
  }
}
