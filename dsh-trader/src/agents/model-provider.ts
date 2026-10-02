/** 交易判断只依赖 DSH LLM seam；协议、凭据、重试与传输均由已注册 provider 持有。 */

import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'

export interface DecisionModelRoute {
  readonly provider: string
  readonly model: string
}

export interface DecisionModelProvider {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 将 DSH 的 provider-neutral LLM seam 接入交易判断工作流。
 * 该检查防止工作流配置漂移成第二条 provider 路由；实际传输始终由 DSH 适配器负责。
 */
export function createDecisionModelProvider(
  llm: Pick<LlmRuntime, 'stream'>,
  route: DecisionModelRoute,
): DecisionModelProvider {
  const provider = route.provider.trim()
  const model = route.model.trim()
  if (provider === '' || model === '') throw new Error('模型 provider/model 路由不能为空')

  return {
    stream(options) {
      if (options.provider !== provider || options.model !== model) {
        throw new Error('模型请求路由与 trade-supervisor 的冻结 provider/model 不一致')
      }
      return llm.stream(options)
    },
  }
}
