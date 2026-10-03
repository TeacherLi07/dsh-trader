import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAiProvider from '@deepseek-ai/dsh-llm-pi-ai'
import type { GenerateOptions, LlmRuntime as DshLlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createDecisionModelProvider, deepseekResponsesPiAiConfig } from '../src/agents/model-provider.js'

const route = { provider: 'deepseek-responses', model: 'deepseek-flash' } as const

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: route.provider,
    model: route.model,
    messages: [],
    maxTokens: 32_768,
    ...overrides,
  }
}

describe('createDecisionModelProvider', () => {
  it('forwards the exact request once to DSH without rewriting or retrying it', () => {
    const stream = (async function* (): AsyncGenerator<StreamChunk> {})()
    const llm = { stream: vi.fn(() => stream) } as unknown as Pick<DshLlmRuntime, 'stream'>
    const model = createDecisionModelProvider(llm, route)
    const request = options()

    expect(model.stream(request)).toBe(stream)
    expect(llm.stream).toHaveBeenCalledTimes(1)
    expect(llm.stream).toHaveBeenCalledWith(request)
  })

  it('refuses a request whose provider or model differs from the frozen route', () => {
    const llm = { stream: vi.fn() } as unknown as Pick<DshLlmRuntime, 'stream'>
    const model = createDecisionModelProvider(llm, route)

    expect(() => model.stream(options({ provider: 'sub2api-openai' }))).toThrow(/冻结 provider\/model/)
    expect(() => model.stream(options({ model: 'other-model' }))).toThrow(/冻结 provider\/model/)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('preserves provider failures unchanged for the run-level unresolved-cost handling', () => {
    const failure = new Error('provider stream failed')
    const llm = { stream: vi.fn(() => { throw failure }) } as unknown as Pick<DshLlmRuntime, 'stream'>
    const model = createDecisionModelProvider(llm, route)

    expect(() => model.stream(options())).toThrow(failure)
  })

  it('requires a non-empty provider and model route', () => {
    const llm = { stream: vi.fn() } as unknown as Pick<DshLlmRuntime, 'stream'>
    expect(() => createDecisionModelProvider(llm, { provider: '  ', model: 'x' })).toThrow(/不能为空/)
    expect(() => createDecisionModelProvider(llm, { provider: 'x', model: '  ' })).toThrow(/不能为空/)
  })
})

describe('deepseekResponsesPiAiConfig', () => {
  it('builds DSH pi-ai route profiles with Responses SSE, high reasoning, and retries disabled', () => {
    const config = deepseekResponsesPiAiConfig({
      productionApiKeyEnv: 'DEEPSEEK_API_KEY',
      r5ApiKeyEnv: 'TRADER_R5_API_KEY',
    })

    expect(Object.keys(config.providers)).toEqual(['deepseek-responses', 'deepseek-r5-responses'])
    for (const profile of Object.values(config.providers)) {
      expect(profile).toMatchObject({
        api: 'openai-responses',
        baseURL: 'https://api.deepseek.com',
        reasoning: 'high',
        compat: { supportsStrictMode: false },
        transport: 'sse',
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        models: [{
          id: 'deepseek-flash', contextWindow: 1_048_576, maxTokens: 393_216,
          reasoningEfforts: { high: 'high', max: 'max' },
        }],
      })
    }
    expect(config.providers['deepseek-responses'].apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(config.providers['deepseek-r5-responses'].apiKeyEnv).toBe('TRADER_R5_API_KEY')
  })

  it('is accepted by the installed DSH pi-ai adapter and resolves both exact model routes offline', async () => {
    const context = new Context()
    const llmFiber = await context.plugin(LlmRuntime)
    const providerFiber = await context.plugin(
      { apply: PiAiProvider.apply, inject: PiAiProvider.inject },
      deepseekResponsesPiAiConfig({
        productionApiKeyEnv: 'DEEPSEEK_API_KEY',
        r5ApiKeyEnv: 'TRADER_R5_API_KEY',
      }),
    )
    try {
      expect(context.llm.listProviders().map((provider) => provider.id)).toEqual([
        'deepseek-responses', 'deepseek-r5-responses',
      ])
      const listed = await context.llm.listModels('deepseek-responses')
      expect(listed).toEqual([{ provider: 'deepseek-responses', id: 'deepseek-flash', name: 'DeepSeek Flash', inputModalities: ['text'] }])
      const resolved = await context.llm.resolveModelInfo('deepseek-responses', 'deepseek-flash')
      expect(resolved).toMatchObject({
        provider: 'deepseek-responses',
        id: 'deepseek-flash',
        context: { contextWindow: 1_048_576 },
        reasoning: { defaultEffort: 'high' },
      })
      expect(context.llm.providerRetryPolicy('deepseek-responses')).toMatchObject({ mode: 'normal', maxRetries: 0 })
    } finally {
      await providerFiber.dispose()
      await llmFiber.dispose()
    }
  })
})
