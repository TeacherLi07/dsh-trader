import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * 通用结构化生成选项。具名工具选择由 provider 映射到其原生 API 字段；
 * 此处不依赖交易模型或交易工具。
 */
export interface StructuredGenerateOptions extends GenerateOptions {
  readonly toolChoice?: { readonly type: 'function'; readonly name: string }
}
