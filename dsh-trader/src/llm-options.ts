import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * 通用结构化生成选项。具名工具选择由 provider 映射到其原生 API 字段；
 * 此处不依赖交易模型或交易工具。
 */
export interface StructuredGenerateOptions extends GenerateOptions {
  readonly toolChoice?: { readonly type: 'function'; readonly name: string }
  /** 单次模型尝试 ID；provider 将其用于请求关联 header，而不改变 cohort/cache 身份。 */
  readonly clientRequestId?: string
}
