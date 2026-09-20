/** 切片大小属于实验配置；与实际值一起进 context hash，不能在提示词里另设一套。 */
export interface DecisionContextConfig {
  readonly version: string
  readonly barsPerTimeframe: number
  readonly statisticsWindow: number
  readonly historyLimit: number
  readonly historyTextChars: number
  readonly maxChars: number
  readonly accountMaxAgeMs: number
  readonly marketGraceMs: number
  readonly derivativesMaxAgeMs: number
  readonly specMaxAgeMs: number
}

export const DEFAULT_DECISION_CONTEXT_CONFIG: DecisionContextConfig = Object.freeze({
  version: 'context-r2-v1', barsPerTimeframe: 64, statisticsWindow: 32,
  historyLimit: 12, historyTextChars: 1600, maxChars: 180_000,
  accountMaxAgeMs: 60_000, marketGraceMs: 120_000,
  derivativesMaxAgeMs: 3_600_000, specMaxAgeMs: 86_400_000,
})

export function decisionContextConfig(input: Partial<DecisionContextConfig> = {}): DecisionContextConfig {
  const config = { ...DEFAULT_DECISION_CONTEXT_CONFIG, ...input }
  if (config.version.trim() === '') throw new Error('context.version 不能为空')
  for (const [key, value] of Object.entries(config)) {
    if (key === 'version') continue
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`context.${key} 必须是正整数`)
  }
  if (config.barsPerTimeframe > 512 || config.statisticsWindow < 3 || config.statisticsWindow >= config.barsPerTimeframe || config.historyLimit > 100) {
    throw new Error('context 切片越界：bars<=512，3<=statisticsWindow<bars，historyLimit<=100')
  }
  return Object.freeze(config)
}
