import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createDecisionModelProvider } from '../src/agents/model-provider.js'

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
    const llm = { stream: vi.fn(() => stream) } as unknown as Pick<LlmRuntime, 'stream'>
    const model = createDecisionModelProvider(llm, route)
    const request = options()

    expect(model.stream(request)).toBe(stream)
    expect(llm.stream).toHaveBeenCalledTimes(1)
    expect(llm.stream).toHaveBeenCalledWith(request)
  })

  it('refuses a request whose provider or model differs from the frozen route', () => {
    const llm = { stream: vi.fn() } as unknown as Pick<LlmRuntime, 'stream'>
    const model = createDecisionModelProvider(llm, route)

    expect(() => model.stream(options({ provider: 'sub2api-openai' }))).toThrow(/冻结 provider\/model/)
    expect(() => model.stream(options({ model: 'other-model' }))).toThrow(/冻结 provider\/model/)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('preserves provider failures unchanged for the run-level unresolved-cost handling', () => {
    const failure = new Error('provider stream failed')
    const llm = { stream: vi.fn(() => { throw failure }) } as unknown as Pick<LlmRuntime, 'stream'>
    const model = createDecisionModelProvider(llm, route)

    expect(() => model.stream(options())).toThrow(failure)
  })

  it('requires a non-empty provider and model route', () => {
    const llm = { stream: vi.fn() } as unknown as Pick<LlmRuntime, 'stream'>
    expect(() => createDecisionModelProvider(llm, { provider: '  ', model: 'x' })).toThrow(/不能为空/)
    expect(() => createDecisionModelProvider(llm, { provider: 'x', model: '  ' })).toThrow(/不能为空/)
  })
})
