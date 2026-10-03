/** 交易判断只依赖 DSH LLM seam；协议、凭据、重试与传输均由已注册 provider 持有。 */

import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

export interface DecisionProviderRoute {
  readonly provider: string
  readonly model: string
}

export interface DecisionModelProvider {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 配置独立 DSH context 时仍复用官方 provider，避免交易层重新实现协议和凭据读取。
 * 配置只携带环境变量名，实际密钥由 DSH 解析。
 */
export function deepseekResponsesPiAiConfig(input: {
  readonly productionApiKeyEnv: string
  readonly r5ApiKeyEnv: string
}) {
  const profile = (apiKeyEnv: string): PiAiProviderProfile => ({
    apiKeyEnv,
    api: 'openai-responses',
    baseURL: 'https://api.deepseek.com',
    reasoning: 'high',
    compat: { supportsStrictMode: false },
    transport: 'sse',
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    models: [{
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      contextWindow: 1_048_576,
      maxTokens: 393_216,
      reasoningEfforts: { high: 'high', max: 'max' },
    }],
  })

  return {
    providers: {
      'deepseek-responses': profile(input.productionApiKeyEnv),
      'deepseek-r5-responses': profile(input.r5ApiKeyEnv),
    },
  }
}

/**
 * 将 DSH 的 provider-neutral LLM seam 接入交易判断工作流。
 * 该检查防止工作流配置漂移成第二条 provider 路由；实际传输始终由 DSH 适配器负责。
 */
export function createDecisionModelProvider(
  llm: Pick<LlmRuntime, 'stream'>,
  route: DecisionProviderRoute,
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
