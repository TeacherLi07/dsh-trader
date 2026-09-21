/** R5 真实模型静态对照的冻结清单校验与非空指标；不含 provider 调用。 */

import { fingerprint } from '../util/canonical.js'
import { DEEPSEEK_PRICE_SEED } from '../cost.js'
import { assertDecisionContext, DECISION_CONTEXT_VERSION, type DecisionContext } from '../agents/decision-context.js'
import { parseDecisionEnvelopeCandidate, type DecisionEnvelopeCandidate } from '../agents/decision-envelope.js'
import { DECISION_WORKFLOW_PROMPT_VERSION, type DecisionModelRoute, type DecisionWorkflowStages } from '../agents/decision-workflow.js'

export const R5_MIN_WINDOWS = 200
export const R5_MAX_SAMPLES = 10_000
export const R5_MODEL_CONTEXT_WINDOW = 1_000_000
export const R5_MAX_REQUEST_CHARS = 300_000
export const R5_FIXED_PROVIDER = 'deepseek-official'
export const R5_FIXED_MODEL = 'deepseek-flash'
export const R5_DEEPSEEK_PROVIDER_CONFIG = Object.freeze({
  provider: R5_FIXED_PROVIDER,
  adapter: '@deepseek-ai/dsh-llm-deepseek',
  connection: Object.freeze({
    apiKeyEnv: 'TRADER_R5_API_KEY',
    baseURL: 'https://api.deepseek.com',
    thinking: 'enabled',
    reasoningEffort: 'high',
  }),
})
export const R5_STRATEGIES = ['single', 'critique'] as const
export type R5Strategy = (typeof R5_STRATEGIES)[number]

/** 与 PriceTableStore.all() 同顺序/字段口径，供 manifest 冻结成本假设。 */
export function r5SeedPriceTableVersion(): string {
  const rows = DEEPSEEK_PRICE_SEED.map((price) => ({
    model: price.model,
    effectiveFrom: price.effectiveFrom,
    tier: price.tier ?? 'any',
    inPerMtok: price.inPerMtok,
    outPerMtok: price.outPerMtok,
    ...(price.cachedInPerMtok === undefined ? {} : { cachedInPerMtok: price.cachedInPerMtok }),
    ...(price.source === undefined ? {} : { source: price.source }),
  })).sort((left, right) => left.model.localeCompare(right.model) ||
    left.effectiveFrom - right.effectiveFrom || left.tier.localeCompare(right.tier))
  return fingerprint(rows)
}

/** 只返回布尔；比较 trim 后的值以匹配 provider 的凭据规范化语义。 */
export function isDedicatedR5ApiKey(r5Value: unknown, productionValue: unknown, isolationAcknowledged: unknown): boolean {
  if (typeof r5Value !== 'string' || r5Value.trim() === '') return false
  const productionKey = typeof productionValue === 'string' ? productionValue.trim() : ''
  return isolationAcknowledged === true && (productionKey === '' || r5Value.trim() !== productionKey)
}

export interface R5SampleLabels {
  /** 每个样本至少要预先标注一项可机器检查的事实或动作要求。 */
  readonly requiredEvidencePaths: readonly string[]
  readonly forbiddenOpen?: boolean
  readonly expectedOutcome?: DecisionEnvelopeCandidate['outcome']
  readonly requiredCritiqueEvidencePaths?: readonly string[]
  readonly forbiddenCritiqueEvidencePaths?: readonly string[]
  /** Critic 应当提出/驳回的带依据意见；用于分开统计纠错与引入错误。 */
  readonly expectedCritiqueDispositions?: readonly {
    readonly evidencePath: string
    readonly disposition: 'accept' | 'reject'
  }[]
}

export interface R5ManifestSample {
  readonly sampleId: string
  /** 同一 W1/评估时点的样本可含多个 symbol，但独立窗口只计一次。 */
  readonly windowId: string
  readonly at: number
  readonly context: DecisionContext
  readonly labels: R5SampleLabels
}

export interface R5ExperimentManifest {
  readonly schemaVersion: 1
  readonly experimentId: string
  readonly split: 'development' | 'validation'
  readonly dataset: {
    readonly id: string
    readonly contentHash: string
    readonly source: string
  }
  readonly versions: {
    readonly gitCommit: string
    readonly buildArtifactsHash: string
    readonly contextSchemaVersion: number
    readonly decisionPromptVersion: string
    readonly dshLlmVersion: string
    readonly providerAdapterVersion: string
    readonly providerConfigHash: string
    readonly priceTableVersion: string
  }
  readonly preregistration: {
    readonly frozenAt: number
    readonly windowStart: number
    readonly windowEnd: number
    readonly blockLength: number
    readonly absoluteMaxDrawdownUsd: number
    readonly selectionRule: 'critique-if-supported-otherwise-single'
  }
  readonly route: DecisionModelRoute
  readonly samples: readonly R5ManifestSample[]
}

export interface R5ManifestSummary {
  readonly experimentId: string
  readonly split: R5ExperimentManifest['split']
  readonly manifestHash: string
  /** 只覆盖 PIT context 与时点，不含可被事后改写的 sampleId/windowId/labels。 */
  readonly pitDataHash: string
  /** 每个独立时点一枚稳定指纹，供 control registry 拒绝 validation 与其他 split 的部分重叠。 */
  readonly pitWindowHashes: readonly string[]
  readonly gitCommit: string
  readonly samples: number
  readonly windows: number
  readonly preregisteredCritiqueCorrectionWindows: number
  readonly preregisteredFalseAlarmWindows: number
  readonly symbols: readonly string[]
  readonly route: DecisionModelRoute
  readonly range: { readonly start: number; readonly end: number }
  readonly blockLength: number
  readonly absoluteMaxDrawdownUsd: number
}

/** 数据集 hash 覆盖样本顺序、PIT context hash、窗口身份与预注册标签。 */
export function computeR5DatasetHash(samples: readonly R5ManifestSample[]): string {
  return fingerprint(samples.map((sample) => ({
    sampleId: sample.sampleId,
    windowId: sample.windowId,
    at: sample.at,
    contextHash: sample.context.contextHash,
    labels: sample.labels,
  })))
}

/** 验证集去重指纹：重命名窗口或改预标注不能把同一组 context 伪装成新市场数据。 */
export function computeR5PITDataHash(samples: readonly R5ManifestSample[]): string {
  const snapshots = samples.map((sample) => ({ at: sample.at, contextHash: sample.context.contextHash }))
    .sort((left, right) => left.at - right.at || left.contextHash.localeCompare(right.contextHash))
  return fingerprint(snapshots)
}

/** 每个独立 PIT 时点单独指纹化；多标的样本同窗合并，改 ID/标签仍无法绕开窗口重用闸。 */
export function computeR5PITWindowHashes(samples: readonly R5ManifestSample[]): readonly string[] {
  const snapshots = new Map<number, string[]>()
  for (const sample of samples) {
    const hashes = snapshots.get(sample.at) ?? []
    hashes.push(sample.context.contextHash)
    snapshots.set(sample.at, hashes)
  }
  return [...snapshots.entries()]
    .sort(([left], [right]) => left - right)
    .map(([at, contextHashes]) => fingerprint({ at, contextHashes: contextHashes.sort() }))
}

export interface R5BudgetAuthorization {
  readonly dailyBudgetUsd: number
  readonly dailyTokenCap: number
  readonly totalBudgetUsd: number
}

export function validateR5BudgetAuthorization(raw: unknown): R5BudgetAuthorization {
  if (!isRecord(raw)) fail('必须显式提供 dailyBudgetUsd、dailyTokenCap、totalBudgetUsd')
  if (typeof raw['dailyBudgetUsd'] !== 'number' || !Number.isFinite(raw['dailyBudgetUsd']) || raw['dailyBudgetUsd'] <= 0) {
    fail('dailyBudgetUsd 必须是有限正数')
  }
  if (typeof raw['dailyTokenCap'] !== 'number' || !Number.isSafeInteger(raw['dailyTokenCap']) || raw['dailyTokenCap'] <= 0) {
    fail('dailyTokenCap 必须是正安全整数')
  }
  if (typeof raw['totalBudgetUsd'] !== 'number' || !Number.isFinite(raw['totalBudgetUsd']) || raw['totalBudgetUsd'] <= 0) {
    fail('totalBudgetUsd 必须是有限正数')
  }
  return {
    dailyBudgetUsd: raw['dailyBudgetUsd'],
    dailyTokenCap: raw['dailyTokenCap'],
    totalBudgetUsd: raw['totalBudgetUsd'],
  }
}

/** single 每窗口最多 2 次调用，critique 的三阶段各最多 repair 一次。 */
export function r5MaximumModelCalls(manifest: R5ExperimentManifest): number {
  return manifest.samples.length * (2 + 6)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new Error(`R5 manifest invalid: ${message}`)
}

function assertNoCredentialFields(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${path}/${index}`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
    if (['apikey', 'apisecret', 'secret', 'secretkey', 'authorization', 'accesstoken', 'refreshtoken', 'privatekey'].includes(normalized)) {
      fail(`manifest 含敏感字段 ${path}/${key}；不得把密钥放入实验工件`)
    }
    assertNoCredentialFields(item, `${path}/${key}`)
  }
}

/** 运行时的实际凭据值不能藏在普通文本字段里被完整 context 带进 prompt。 */
export function assertNoCredentialValues(value: unknown, secretValues: readonly string[], path = ''): void {
  const secrets = [...new Set(secretValues.map((secret) => secret.trim()).filter((secret) => secret !== ''))]
  const scan = (item: unknown, itemPath: string): void => {
    if (typeof item === 'string') {
      if (secrets.some((secret) => item.includes(secret))) fail(`运行时凭据值出现在实验材料 ${itemPath}；拒绝送入 prompt`)
      return
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => scan(child, `${itemPath}/${index}`))
      return
    }
    if (!isRecord(item)) return
    for (const [key, child] of Object.entries(item)) {
      if (secrets.some((secret) => key.includes(secret))) {
        fail(`运行时凭据值出现在实验材料 ${itemPath}/[object-key]；拒绝送入 prompt`)
      }
      scan(child, `${itemPath}/${key}`)
    }
  }
  scan(value, path)
}

const PIT_OBSERVATION_TIME_KEYS = new Set([
  'asof', 'availableat', 'observedat', 'quoteobservedat', 'eventat', 'eventtime',
  'opentime', 'closetime', 'createdat', 'settledat', 'decidedat', 'effectivefrom', 'fetchedat',
])

/** PIT manifest 不能只信分区摘要时间；嵌套原始样本也不得含未来可见/发生时点。 */
function assertNoFutureObservationTimes(value: unknown, sampleAt: number, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFutureObservationTimes(item, sampleAt, `${path}/${index}`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
    const itemPath = `${path}/${key}`
    if (PIT_OBSERVATION_TIME_KEYS.has(normalized) && item !== null) {
      if (!Number.isSafeInteger(item) || Number(item) < 0) fail(`${itemPath} 不是有效的 PIT 毫秒时间戳`)
      if (Number(item) > sampleAt) fail(`${itemPath} 超前于 PIT 样本时点`)
    }
    assertNoFutureObservationTimes(item, sampleAt, itemPath)
  }
}

function validateEvidencePaths(
  sampleId: string,
  context: DecisionContext,
  paths: readonly string[],
  label: string,
): void {
  if (paths.length === 0) fail(`${sampleId}.${label} 不能为空（防止零标签空跑）`)
  const parsed = parseDecisionEnvelopeCandidate({
    outcome: 'no_trade',
    thesis: 'R5 preregistered evidence-path check',
    rejectedAlternatives: [],
    claims: paths.map((evidencePath) => ({
      kind: 'observation', statement: 'preregistered label', evidencePaths: [evidencePath],
    })),
    uncertainties: [],
    confidence: 0.5,
    riskFraction: 1,
  }, context)
  if (!parsed.ok) fail(`${sampleId}.${label}: ${parsed.errors.join('; ')}`)
  if (parsed.evidenceIssues.length > 0) fail(`${sampleId}.${label}: ${parsed.evidenceIssues.join('; ')}`)
}

/** 检查 frozen sample、标签与预注册边界；真实运行前必须先过该检查。 */
export function validateR5Manifest(
  raw: unknown,
  options: { readonly minWindows?: number } = {},
): { readonly manifest: R5ExperimentManifest; readonly summary: R5ManifestSummary } {
  if (!isRecord(raw)) fail('root 必须是 object')
  assertNoCredentialFields(raw)
  const manifest = raw as unknown as R5ExperimentManifest
  if (manifest.schemaVersion !== 1) fail('schemaVersion 必须为 1')
  if (typeof manifest.experimentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/.test(manifest.experimentId)) {
    fail('experimentId 必须是 3–96 字符的稳定 ID')
  }
  if (manifest.split !== 'development' && manifest.split !== 'validation') fail('split 必须是 development 或 validation')
  if (!isRecord(manifest.dataset) || typeof manifest.dataset.id !== 'string' || manifest.dataset.id.trim() === '' ||
      typeof manifest.dataset.contentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifest.dataset.contentHash) ||
      typeof manifest.dataset.source !== 'string' || manifest.dataset.source.trim() === '') {
    fail('dataset 必须有 id、sha256 contentHash 和 source')
  }
  if (!isRecord(manifest.versions) || typeof manifest.versions.gitCommit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(manifest.versions.gitCommit) ||
      typeof manifest.versions.buildArtifactsHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifest.versions.buildArtifactsHash) ||
      manifest.versions.contextSchemaVersion !== DECISION_CONTEXT_VERSION ||
      manifest.versions.decisionPromptVersion !== DECISION_WORKFLOW_PROMPT_VERSION ||
      typeof manifest.versions.dshLlmVersion !== 'string' || manifest.versions.dshLlmVersion.trim() === '' ||
      typeof manifest.versions.providerAdapterVersion !== 'string' || manifest.versions.providerAdapterVersion.trim() === '' ||
      manifest.versions.providerConfigHash !== fingerprint(R5_DEEPSEEK_PROVIDER_CONFIG) ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.versions.priceTableVersion)) {
    fail('versions 必须绑定 Git commit、context/prompt schema、DSH adapter config 与价目版本')
  }
  if (!isRecord(manifest.preregistration)) fail('缺少 preregistration')
  const protocol = manifest.preregistration
  for (const [name, value] of [
    ['frozenAt', protocol.frozenAt], ['windowStart', protocol.windowStart], ['windowEnd', protocol.windowEnd],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`preregistration.${name} 必须是非负毫秒整数`)
  }
  if (protocol.windowStart >= protocol.windowEnd) fail('windowStart 必须早于 windowEnd')
  if (manifest.split === 'validation' && protocol.frozenAt >= protocol.windowStart) {
    fail('validation protocol 必须在验证段开始前冻结')
  }
  if (!Number.isSafeInteger(protocol.blockLength) || protocol.blockLength < 1) fail('blockLength 必须是正整数')
  if (!Number.isFinite(protocol.absoluteMaxDrawdownUsd) || protocol.absoluteMaxDrawdownUsd <= 0) {
    fail('absoluteMaxDrawdownUsd 必须是有限正数')
  }
  if (protocol.selectionRule !== 'critique-if-supported-otherwise-single') fail('selectionRule 未冻结或不支持')
  if (!isRecord(manifest.route) || typeof manifest.route.provider !== 'string' || manifest.route.provider.trim() === '' ||
      typeof manifest.route.model !== 'string' || manifest.route.model.trim() === '' ||
      !Number.isSafeInteger(manifest.route.maxTokens) || manifest.route.maxTokens <= 0 ||
      !Number.isSafeInteger(manifest.route.maxChars) || manifest.route.maxChars <= 0 || manifest.route.maxChars > R5_MAX_REQUEST_CHARS ||
      manifest.route.maxChars * 3 + 4_096 + manifest.route.maxTokens > R5_MODEL_CONTEXT_WINDOW) {
    fail(`route 必须固定 provider/model/maxTokens/maxChars，且 UTF-8 保守输入上界 + 输出预算不超过 ${R5_MODEL_CONTEXT_WINDOW} tokens`)
  }
  if (manifest.route.provider !== R5_FIXED_PROVIDER || manifest.route.model !== R5_FIXED_MODEL) {
    fail(`route 必须使用冻结生产路由 ${R5_FIXED_PROVIDER}/${R5_FIXED_MODEL}`)
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) fail('samples 不能为空')
  if (manifest.samples.length > R5_MAX_SAMPLES) fail(`samples 超过资源保护上限 ${R5_MAX_SAMPLES}`)

  const sampleIds = new Set<string>()
  const contextHashes = new Set<string>()
  const windowTimes = new Map<string, number>()
  const timestampWindows = new Map<number, string>()
  const symbols = new Set<string>()
  const critiqueCorrectionWindows = new Set<string>()
  const falseAlarmWindows = new Set<string>()
  for (const rawSample of manifest.samples as readonly unknown[]) {
    if (!isRecord(rawSample) || typeof rawSample['sampleId'] !== 'string' || rawSample['sampleId'].trim() === '' ||
        typeof rawSample['windowId'] !== 'string' || rawSample['windowId'].trim() === '' ||
        !Number.isSafeInteger(rawSample['at']) || Number(rawSample['at']) < protocol.windowStart || Number(rawSample['at']) >= protocol.windowEnd) {
      fail('每个 sample 必须有 sampleId/windowId 和位于冻结窗口内的 at')
    }
    const sample = rawSample as unknown as R5ManifestSample
    if (sampleIds.has(sample.sampleId)) fail(`sampleId 重复：${sample.sampleId}`)
    sampleIds.add(sample.sampleId)
    const priorWindowAt = windowTimes.get(sample.windowId)
    if (priorWindowAt !== undefined && priorWindowAt !== sample.at) fail(`windowId ${sample.windowId} 绑定多个时点`)
    const priorWindowId = timestampWindows.get(sample.at)
    if (priorWindowId !== undefined && priorWindowId !== sample.windowId) {
      fail(`同一时点 ${sample.at} 不得通过多个 windowId 重复计为独立窗口`)
    }
    windowTimes.set(sample.windowId, sample.at)
    timestampWindows.set(sample.at, sample.windowId)
    if (!isRecord(sample.context)) fail(`${sample.sampleId}.context 缺失`)
    try { assertDecisionContext(sample.context as unknown as DecisionContext) }
    catch (error) { fail(`${sample.sampleId}.context: ${error instanceof Error ? error.message : String(error)}`) }
    if (sample.context.asOf !== sample.at) fail(`${sample.sampleId}.context.asOf 与 sample.at 不一致`)
    assertNoFutureObservationTimes(sample.context, sample.at, `${sample.sampleId}.context`)
    for (const [section, value] of Object.entries(sample.context.sections)) {
      if (value.asOf !== null && value.asOf > sample.at) fail(`${sample.sampleId}.context.sections.${section}.asOf 超前于 PIT 时点`)
    }
    if (contextHashes.has(sample.context.contextHash)) fail(`contextHash 重复，重复快照不能增加样本量：${sample.context.contextHash}`)
    contextHashes.add(sample.context.contextHash)
    symbols.add(sample.context.symbol)
    if (!isRecord(sample.labels)) fail(`${sample.sampleId}.labels 缺失`)
    const labels = sample.labels
    const hasExpectedOutcome = labels.expectedOutcome === 'act' || labels.expectedOutcome === 'no_trade' || labels.expectedOutcome === 'review'
    const hasForbiddenOpen = labels.forbiddenOpen === true
    const requiredPaths = Array.isArray(labels.requiredEvidencePaths) ? labels.requiredEvidencePaths : []
    const requiredCritiquePaths = Array.isArray(labels.requiredCritiqueEvidencePaths) ? labels.requiredCritiqueEvidencePaths : []
    const forbiddenCritiquePaths = Array.isArray(labels.forbiddenCritiqueEvidencePaths) ? labels.forbiddenCritiqueEvidencePaths : []
    const expectedCritiqueDispositions = Array.isArray(labels.expectedCritiqueDispositions) ? labels.expectedCritiqueDispositions : []
    if (!hasExpectedOutcome && !hasForbiddenOpen && requiredPaths.length === 0 &&
        requiredCritiquePaths.length === 0 && forbiddenCritiquePaths.length === 0 && expectedCritiqueDispositions.length === 0) {
      fail(`${sample.sampleId}.labels 没有有效标注（防止标签空跑）`)
    }
    if (requiredPaths.some((path) => typeof path !== 'string') ||
        requiredCritiquePaths.some((path) => typeof path !== 'string') ||
        forbiddenCritiquePaths.some((path) => typeof path !== 'string')) {
      fail(`${sample.sampleId}.labels evidence paths 必须是字符串`)
    }
    if (expectedCritiqueDispositions.some((item) => !isRecord(item) || typeof item['evidencePath'] !== 'string' ||
        item['evidencePath'].trim() === '' || (item['disposition'] !== 'accept' && item['disposition'] !== 'reject'))) {
      fail(`${sample.sampleId}.labels.expectedCritiqueDispositions shape 无效`)
    }
    const dispositionPaths = new Set<string>()
    for (const item of expectedCritiqueDispositions) {
      const evidencePath = item['evidencePath'] as string
      if (dispositionPaths.has(evidencePath)) {
        fail(`${sample.sampleId}.labels.expectedCritiqueDispositions 同一 evidencePath 不得重复`)
      }
      dispositionPaths.add(evidencePath)
      if (item['disposition'] === 'accept') critiqueCorrectionWindows.add(sample.windowId)
      else falseAlarmWindows.add(sample.windowId)
    }
    if (requiredPaths.length > 0) validateEvidencePaths(sample.sampleId, sample.context as unknown as DecisionContext, requiredPaths, 'requiredEvidencePaths')
    if (requiredCritiquePaths.length > 0) validateEvidencePaths(sample.sampleId, sample.context as unknown as DecisionContext, requiredCritiquePaths, 'requiredCritiqueEvidencePaths')
    if (forbiddenCritiquePaths.length > 0) validateEvidencePaths(sample.sampleId, sample.context as unknown as DecisionContext, forbiddenCritiquePaths, 'forbiddenCritiqueEvidencePaths')
    if (expectedCritiqueDispositions.length > 0) {
      validateEvidencePaths(sample.sampleId, sample.context as unknown as DecisionContext,
        expectedCritiqueDispositions.map((item) => item.evidencePath), 'expectedCritiqueDispositions')
    }
  }
  if (critiqueCorrectionWindows.size === 0 || falseAlarmWindows.size === 0) {
    fail('数据集必须在非空独立窗口中分别预标注 Critic 应采纳的纠错与应驳回的误报')
  }
  const windows = windowTimes.size
  const minWindows = options.minWindows ?? R5_MIN_WINDOWS
  if (!Number.isSafeInteger(minWindows) || minWindows < 1) fail('minWindows 参数非法')
  if (windows < minWindows) fail(`独立评估窗口 ${windows} < ${minWindows}`)
  if (computeR5DatasetHash(manifest.samples) !== manifest.dataset.contentHash) {
    fail('dataset.contentHash 与 sample/window/context/label 内容不匹配')
  }
  const pitDataHash = computeR5PITDataHash(manifest.samples)
  const pitWindowHashes = computeR5PITWindowHashes(manifest.samples)

  return {
    manifest,
    summary: {
      experimentId: manifest.experimentId,
      split: manifest.split,
      manifestHash: fingerprint(manifest),
      pitDataHash,
      pitWindowHashes,
      gitCommit: manifest.versions.gitCommit,
      samples: manifest.samples.length,
      windows,
      preregisteredCritiqueCorrectionWindows: critiqueCorrectionWindows.size,
      preregisteredFalseAlarmWindows: falseAlarmWindows.size,
      symbols: [...symbols].sort(),
      route: manifest.route,
      range: { start: protocol.windowStart, end: protocol.windowEnd },
      blockLength: protocol.blockLength,
      absoluteMaxDrawdownUsd: protocol.absoluteMaxDrawdownUsd,
    },
  }
}

function candidateOpens(candidate: DecisionEnvelopeCandidate | undefined): boolean {
  return candidate?.immediateAction?.action === 'open' ||
    candidate?.plan?.commitments.some((item) => item.then.action === 'open') === true ||
    candidate?.plan?.invalidation.some((item) => item.then.action === 'open') === true
}

/** 仅做预注册 label 可机判的静态计分；不把它冒充经济效果或 forward-paper 通过。 */
export function scoreR5StaticSample(
  sample: R5ManifestSample,
  strategy: R5Strategy,
  stages: DecisionWorkflowStages,
): Readonly<Record<string, unknown>> {
  const candidate = stages.final
  const claimPaths = new Set(candidate?.claims.flatMap((claim) => claim.evidencePaths) ?? [])
  const requiredEvidencePaths = sample.labels.requiredEvidencePaths ?? []
  const missingRequiredEvidencePaths = requiredEvidencePaths.filter((path) => !claimPaths.has(path))
  const critiquePaths = new Set(stages.critique?.issues.flatMap((issue) => issue.evidencePaths) ?? [])
  const critiqueApplicable = strategy === 'critique'
  const missingCritiquePaths = critiqueApplicable
    ? (sample.labels.requiredCritiqueEvidencePaths ?? []).filter((path) => !critiquePaths.has(path))
    : []
  const forbiddenCritiquePresent = critiqueApplicable
    ? (sample.labels.forbiddenCritiqueEvidencePaths ?? []).filter((path) => critiquePaths.has(path))
    : []
  let expectedCritiqueCorrections = 0
  let correctlyAddressedCritiqueCorrections = 0
  let expectedFalseAlarms = 0
  let rejectedFalseAlarms = 0
  let critiqueDispositionMismatches = 0
  const responses = candidate?.critiqueResponses ?? []
  for (const expected of critiqueApplicable ? sample.labels.expectedCritiqueDispositions ?? [] : []) {
    const matchingIssues = (stages.critique?.issues ?? []).filter((issue) => issue.evidencePaths.includes(expected.evidencePath))
    if (expected.disposition === 'accept') {
      expectedCritiqueCorrections += 1
      if (matchingIssues.length === 0) {
        missingCritiquePaths.push(expected.evidencePath)
        continue
      }
      const allAccepted = matchingIssues.every((issue) =>
        responses.find((response) => response.critiqueId === issue.critiqueId)?.disposition === 'accept')
      if (allAccepted) correctlyAddressedCritiqueCorrections += 1
      else critiqueDispositionMismatches += 1
    } else {
      expectedFalseAlarms += 1
      if (matchingIssues.length === 0) {
        rejectedFalseAlarms += 1
        continue
      }
      const allRejected = matchingIssues.every((issue) =>
        responses.find((response) => response.critiqueId === issue.critiqueId)?.disposition === 'reject')
      if (allRejected) rejectedFalseAlarms += 1
      else critiqueDispositionMismatches += 1
    }
  }
  const forbiddenOpen = sample.labels.forbiddenOpen === true && candidateOpens(candidate)
  const outcomeLabelPresent = sample.labels.expectedOutcome !== undefined
  const expectedOutcomeMatch = sample.labels.expectedOutcome === undefined || candidate?.outcome === sample.labels.expectedOutcome
  return {
    sampleId: sample.sampleId,
    windowId: sample.windowId,
    at: sample.at,
    symbol: sample.context.symbol,
    contextHash: sample.context.contextHash,
    strategy,
    labels: sample.labels,
    status: stages.failure === undefined ? 'completed' : 'review',
    schemaSuccess: candidate !== undefined && stages.failure === undefined,
    firstPassSuccess: candidate !== undefined && stages.failure === undefined && stages.repairCalls === 0,
    repairCalls: stages.repairCalls,
    evidenceIssues: stages.evidenceIssues,
    missingRequiredEvidencePaths,
    missingCritiquePaths,
    forbiddenCritiquePresent,
    expectedCritiqueCorrections,
    correctlyAddressedCritiqueCorrections,
    expectedFalseAlarms,
    rejectedFalseAlarms,
    critiqueDispositionMismatches,
    forbiddenOpen,
    outcomeLabelPresent,
    expectedOutcomeMatch,
    critiqueIssueCount: stages.critique?.issues.length ?? 0,
    failure: stages.failure ?? null,
    calls: stages.calls.map((call) => ({
      stage: call.stage,
      requestHash: call.requestHash,
      requestChars: call.requestChars,
      usage: call.usage,
      failure: call.failure ?? null,
    })),
    candidate: candidate ?? null,
    critique: stages.critique ?? null,
  }
}

export interface R5StaticAggregate {
  readonly samples: number
  readonly windows: number
  readonly schemaSuccessRate: number
  readonly firstPassSuccessRate: number
  readonly repairedSamples: number
  readonly evidenceIssueCount: number
  readonly missingRequiredEvidenceCount: number
  readonly missingCritiqueEvidenceCount: number
  readonly forbiddenCritiqueCount: number
  readonly expectedCritiqueCorrections: number
  readonly correctlyAddressedCritiqueCorrections: number
  readonly expectedFalseAlarms: number
  readonly rejectedFalseAlarms: number
  readonly critiqueDispositionMismatches: number
  readonly forbiddenOpenCount: number
  readonly expectedOutcomeAccuracy: number | null
  readonly executionChainSamples: 0
  readonly economicGate: 'not_run'
}

export function aggregateR5StaticResults(
  results: readonly Readonly<Record<string, unknown>>[],
): R5StaticAggregate {
  if (results.length === 0) throw new Error('R5 static aggregation requires non-empty results')
  const windows = new Set(results.map((result) => String(result['windowId']))).size
  const outcomeLabeled = results.filter((result) => result['outcomeLabelPresent'] === true)
  const count = (key: string): number => results.filter((result) => result[key] === true).length
  const listCount = (key: string): number => results.reduce((sum, result) => {
    const value = result[key]
    return sum + (Array.isArray(value) ? value.length : 0)
  }, 0)
  return {
    samples: results.length,
    windows,
    schemaSuccessRate: count('schemaSuccess') / results.length,
    firstPassSuccessRate: count('firstPassSuccess') / results.length,
    repairedSamples: results.filter((result) => Number(result['repairCalls'] ?? 0) > 0).length,
    evidenceIssueCount: listCount('evidenceIssues'),
    missingRequiredEvidenceCount: listCount('missingRequiredEvidencePaths'),
    missingCritiqueEvidenceCount: listCount('missingCritiquePaths'),
    forbiddenCritiqueCount: listCount('forbiddenCritiquePresent'),
    expectedCritiqueCorrections: results.reduce((sum, result) => sum + Number(result['expectedCritiqueCorrections'] ?? 0), 0),
    correctlyAddressedCritiqueCorrections: results.reduce((sum, result) => sum + Number(result['correctlyAddressedCritiqueCorrections'] ?? 0), 0),
    expectedFalseAlarms: results.reduce((sum, result) => sum + Number(result['expectedFalseAlarms'] ?? 0), 0),
    rejectedFalseAlarms: results.reduce((sum, result) => sum + Number(result['rejectedFalseAlarms'] ?? 0), 0),
    critiqueDispositionMismatches: results.reduce((sum, result) => sum + Number(result['critiqueDispositionMismatches'] ?? 0), 0),
    forbiddenOpenCount: count('forbiddenOpen'),
    expectedOutcomeAccuracy: outcomeLabeled.length === 0 ? null :
      outcomeLabeled.filter((result) => result['expectedOutcomeMatch'] === true).length / outcomeLabeled.length,
    executionChainSamples: 0,
    economicGate: 'not_run',
  }
}

/** 工程门只判结构/证据安全；Critic 标签命中率单独报告，计划尚未规定质量通过阈值。 */
export function passesR5StaticEngineeringGate(
  run: {
    readonly status: string
    readonly terminalRuns: number
    readonly expectedRuns: number
    readonly staticByStrategy: Readonly<Record<R5Strategy, R5StaticAggregate | null>>
  },
  expectedWindows = R5_MIN_WINDOWS,
): boolean {
  const single = run.staticByStrategy.single
  const critique = run.staticByStrategy.critique
  const commonGate = (value: R5StaticAggregate | null): value is R5StaticAggregate =>
    value !== null && value.windows >= expectedWindows && value.schemaSuccessRate >= 0.99 &&
    value.evidenceIssueCount === 0 && value.missingRequiredEvidenceCount === 0 &&
    value.missingCritiqueEvidenceCount === 0 && value.forbiddenCritiqueCount === 0 && value.forbiddenOpenCount === 0
  return run.status === 'finished' && run.terminalRuns === run.expectedRuns &&
    commonGate(single) && commonGate(critique) &&
    critique.expectedCritiqueCorrections > 0 && critique.expectedFalseAlarms > 0
}
