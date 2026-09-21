#!/usr/bin/env node
/**
 * R5 真实模型静态对照入口（经济/forward-paper 闸门仍单独判定）。
 *
 * 无副作用预检：
 *   pnpm build && node scripts/r5-acceptance.mjs --manifest <frozen-manifest.json> --preflight --output /tmp/r5-preflight.json
 * 真正调用固定 DSH DeepSeek provider（必须有人工预算授权）：
 *   node scripts/r5-acceptance.mjs --manifest <frozen-manifest.json> --execute \
 *     --state-db /tmp/r5-state.sqlite --output docs/r5-acceptance-YYYY-MM-DD.json
 * 环境：专用 TRADER_R5_API_KEY + TRADER_R5_CONFIRM_KEY_ISOLATION=1、TRADER_R5_DAILY_BUDGET_USD、TRADER_R5_DAILY_TOKEN_CAP、
 * TRADER_R5_TOTAL_BUDGET_USD。这个入口只做静态 single/critique 判断，不下单，
 * 报告会明确把执行链覆盖标为 0、经济闸标为 not_run，不能代替 R5 或启用 live。
 */

import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  BudgetLedger,
  DEEPSEEK_PRICE_SEED,
  PriceTableStore,
  PRICING_SOURCE,
  R5_MIN_WINDOWS,
  R5_DEEPSEEK_PROVIDER_CONFIG,
  R5ControlRegistry,
  assertNoCredentialValues,
  isDedicatedR5ApiKey,
  migrate,
  r5MaximumModelCalls,
  passesR5StaticEngineeringGate,
  runR5StaticExperiment,
  systemClock,
  fingerprint,
  verifyBuildIntegrity,
  validateR5BudgetAuthorization,
  validateR5Manifest,
} from '../lib/internal-api.js'

const USAGE = `用法：
  node scripts/r5-acceptance.mjs --manifest <json> --preflight --output <report.json>
  node scripts/r5-acceptance.mjs --manifest <json> --execute --state-db <isolated.sqlite> --output <report.json> [--resume]

真实调用需要显式配置 TRADER_R5_DAILY_BUDGET_USD、TRADER_R5_DAILY_TOKEN_CAP、
TRADER_R5_TOTAL_BUDGET_USD、专用 TRADER_R5_API_KEY 和 TRADER_R5_CONFIRM_KEY_ISOLATION=1。缺一项会在 provider I/O 前拒绝。`

function parseArgs(argv) {
  const result = { execute: false, preflight: false, resume: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { result.help = true; continue }
    if (arg === '--execute') { result.execute = true; continue }
    if (arg === '--preflight') { result.preflight = true; continue }
    if (arg === '--resume') { result.resume = true; continue }
    if (arg === '--manifest' || arg === '--output' || arg === '--state-db' || arg === '--sample-start' || arg === '--sample-count' || arg === '--max-model-calls') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`)
      result[arg.slice(2).replaceAll('-', '')] = value
      index += 1
      continue
    }
    throw new Error(`未知参数：${String(arg)}`)
  }
  if (result.execute && result.preflight) throw new Error('--execute 与 --preflight 不能同时使用')
  if (!result.execute && !result.preflight) result.preflight = true
  return result
}

function positiveEnv(name, integer = false) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} 必须是${integer ? '正安全整数' : '有限正数'}`)
  }
  return value
}

function inspectSourceRevision() {
  let currentGitCommit = null
  try {
    currentGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* preflight reports unavailable; execute will fail closed */ }
  if (currentGitCommit === null) return { currentGitCommit: null, trackedWorktreeClean: false }
  try {
    execFileSync('git', ['diff', '--quiet'], { stdio: 'ignore' })
    execFileSync('git', ['diff', '--cached', '--quiet'], { stdio: 'ignore' })
    const untrackedRuntimeFiles = execFileSync('git', [
      'ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts', 'package.json', 'pnpm-lock.yaml',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { currentGitCommit, trackedWorktreeClean: untrackedRuntimeFiles === '' }
  } catch {
    return { currentGitCommit, trackedWorktreeClean: false }
  }
}

function readProcessIdentity(pid) {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closingParen = stat.lastIndexOf(')')
    const fieldsAfterCommand = stat.slice(closingParen + 2).trim().split(/\s+/)
    const startTicks = fieldsAfterCommand[19]
    if (bootId === '' || startTicks === undefined || !/^\d+$/.test(startTicks)) return null
    return { pid, bootId, startTicks }
  } catch { return null }
}

function processIdentityAlive(owner) {
  try {
    const currentBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (currentBootId !== owner.bootId) return false
    const stat = readFileSync(`/proc/${owner.pid}/stat`, 'utf8')
    const closingParen = stat.lastIndexOf(')')
    const fieldsAfterCommand = stat.slice(closingParen + 2).trim().split(/\s+/)
    if (fieldsAfterCommand[0] === 'Z' || fieldsAfterCommand[0] === 'X') return false
    return fieldsAfterCommand[19] === owner.startTicks
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false
    return undefined
  }
}

function installedPackageVersion(specifier) {
  const entry = fileURLToPath(import.meta.resolve(specifier))
  const packagePath = resolve(dirname(entry), '../package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`无法读取 ${specifier} 的固定版本`)
  }
  return packageJson.version
}

function readManifest(path) {
  const resolved = resolve(path)
  const size = Buffer.byteLength(readFileSync(resolved))
  if (size > 256 * 1024 * 1024) throw new Error('R5 manifest 超过 256 MiB 上限')
  const raw = JSON.parse(readFileSync(resolved, 'utf8'))
  return { path: resolved, ...validateR5Manifest(raw) }
}

function atomicJson(path, value) {
  const output = resolve(path)
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
  finally { closeSync(fd) }
  renameSync(temporary, output)
  return output
}

function assertPrivateMode(path, kind) {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${kind} 必须禁止 group/other 访问（建议 chmod 700/600）：${path}`)
}

function ensurePrivateDirectory(path, kind) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  }
  assertPrivateMode(path, kind)
}

function markdown(report) {
  const run = report.run
  const byStrategy = run?.staticByStrategy ?? {}
  const ratio = (numerator, denominator) => denominator > 0 ? `${numerator}/${denominator}` : '不适用'
  const strategyRows = ['single', 'critique'].map((strategy) => {
    const aggregate = byStrategy[strategy]
    const outcomeAccuracy = aggregate?.expectedOutcomeAccuracy === null || aggregate === null || aggregate === undefined
      ? '未标注'
      : `${(aggregate.expectedOutcomeAccuracy * 100).toFixed(2)}%`
    return `| ${strategy} | ${aggregate?.samples ?? 0} | ${aggregate?.windows ?? 0} | ${aggregate === null || aggregate === undefined ? '未运行' : `${(aggregate.schemaSuccessRate * 100).toFixed(2)}%`} | ${aggregate === null || aggregate === undefined ? '未运行' : `${(aggregate.firstPassSuccessRate * 100).toFixed(2)}%`} | ${aggregate?.evidenceIssueCount ?? 0} | ${aggregate?.missingRequiredEvidenceCount ?? 0} | ${outcomeAccuracy} | ${ratio(aggregate?.correctlyAddressedCritiqueCorrections ?? 0, aggregate?.expectedCritiqueCorrections ?? 0)} | ${ratio(aggregate?.rejectedFalseAlarms ?? 0, aggregate?.expectedFalseAlarms ?? 0)} | ${aggregate?.critiqueDispositionMismatches ?? 0} | ${aggregate?.forbiddenOpenCount ?? 0} |`
  })
  const lines = [
    '# R5 真实模型静态对照运行报告',
    '',
    `- 实验：${report.experimentId}`,
    `- manifest：${report.manifestHash}`,
    `- split：${report.split}`,
    `- route：${report.route.provider}/${report.route.model}`,
    `- 运行状态：${run?.status ?? 'preflight only'}`,
    `- 模型调用数：${run?.modelCalls ?? 0}`,
    `- 硬预算预留：${run?.reservedUsd ?? 0} USD`,
    `- control registry 回收的未决 reservation：${run?.controlRecoveredAbandonedCalls ?? 0}（全局计数；未必真正发出请求）`,
    `- provider outcome 不确定并按上界计入：${run?.abandonedReservations ?? 0}`,
    `- 成本未知调用（control registry）：${run?.controlCostUnknownCalls ?? 0}`,
    `- control blocker：${run?.controlBlocker ?? 'none'}`,
    `- 执行链非空样本：${run?.executionChainSamples ?? 0}`,
    `- 经济闸：${run?.economicGate ?? 'not_run'}`,
    `- R5 完整通过：${report.r5OverallPassed ? '是' : '否'}`,
    '',
    '## 判断静态指标',
    '',
    '| 策略 | 样本 | 窗口 | schema 成功率 | 首次成功率 | evidence issue | 缺失必需引用 | outcome 标签准确率 | critic 纠错接受/预标注 | false alarm 驳回/预标注 | critic disposition 不匹配 | 禁止开仓违反 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...strategyRows,
    '',
    `已终态 run：${run?.terminalRuns ?? 0}/${run?.expectedRuns ?? 0}。`,
    '',
    '静态工程门不设模型判断质量阈值；outcome/critic 标签命中与不匹配均单独报告，不能把工程门通过解释为模型质量通过。Critic 专属指标在 single arm 不适用。',
    '',
    '此报告只证明本次真实 provider 静态判断运行的工程与标签指标。无论静态指标如何，执行链样本为 0 或 forward-paper 经济闸未运行时，R5/R6 均不得判通过。',
    '',
  ]
  return `${lines.join('\n')}\n`
}

async function createDshDecisionModel(route) {
  if (route.provider !== 'deepseek-official') throw new Error('R5 runner 只允许 manifest 固定到 DSH deepseek-official provider')
  const [{ Context }, LlmModule, DeepSeekModule] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-llm'),
    import('@deepseek-ai/dsh-llm-deepseek'),
  ])
  const context = new Context()
  let llmFiber
  let providerFiber
  try {
    llmFiber = await context.plugin(LlmModule.default ?? LlmModule.LlmRuntime)
    providerFiber = await context.plugin(
      { apply: DeepSeekModule.apply, inject: DeepSeekModule.inject },
      R5_DEEPSEEK_PROVIDER_CONFIG.connection,
    )
    const providers = context.llm.listProviders().map((item) => item.id)
    if (!providers.includes(route.provider)) throw new Error('DSH LLM provider route 未注册')
    return {
      model: { stream: (options) => context.llm.stream(options) },
      async dispose() {
        await providerFiber?.dispose()
        await llmFiber?.dispose()
      },
    }
  } catch (error) {
    await providerFiber?.dispose()
    await llmFiber?.dispose()
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(USAGE); return 0 }
  if (typeof options.manifest !== 'string' || typeof options.output !== 'string') throw new Error('--manifest 和 --output 必填')

  const { path: manifestPath, manifest, summary } = readManifest(options.manifest)
  const outputPath = resolve(options.output)
  const statePath = typeof options.statedb === 'string' ? resolve(options.statedb) : undefined
  if (existsSync(outputPath)) {
    if (!options.resume) throw new Error(`输出已存在：${outputPath}（如同一实验续跑请传 --resume）`)
    const previousReport = JSON.parse(readFileSync(outputPath, 'utf8'))
    const expectedMode = options.execute ? 'real-model-static-judgment' : 'preflight'
    if (previousReport.manifestHash !== summary.manifestHash || previousReport.experimentId !== manifest.experimentId ||
        previousReport.mode !== expectedMode) {
      throw new Error('resume 输出绑定了不同 experiment/manifest/mode；拒绝覆盖')
    }
  }
  const authRaw = {
    dailyBudgetUsd: positiveEnv('TRADER_R5_DAILY_BUDGET_USD'),
    dailyTokenCap: positiveEnv('TRADER_R5_DAILY_TOKEN_CAP', true),
    totalBudgetUsd: positiveEnv('TRADER_R5_TOTAL_BUDGET_USD'),
  }
  let budgets
  let budgetError
  try { budgets = validateR5BudgetAuthorization(authRaw) }
  catch (error) { budgetError = error instanceof Error ? error.message : String(error) }
  const r5ApiKey = process.env['TRADER_R5_API_KEY'] ?? ''
  const productionApiKey = process.env['DEEPSEEK_API_KEY'] ?? ''
  const credentialValues = [
    r5ApiKey, productionApiKey, process.env['TRADER_API_KEY'] ?? '', process.env['TRADER_API_SECRET'] ?? '',
  ].map((value) => value.trim()).filter((value) => value !== '')
  assertNoCredentialValues(manifest, credentialValues)
  const apiKeyPresent = r5ApiKey.trim() !== ''
  const keyIsolationAcknowledged = process.env['TRADER_R5_CONFIRM_KEY_ISOLATION'] === '1'
  const apiKeyDedicated = isDedicatedR5ApiKey(r5ApiKey, productionApiKey, keyIsolationAcknowledged)
  const routeSupported = manifest.route.provider === 'deepseek-official'
  const sourceRevision = inspectSourceRevision()
  const codeCommitMatches = sourceRevision.currentGitCommit === manifest.versions.gitCommit
  let buildArtifactsHash = null
  let buildIntegrityError = null
  try {
    const verified = verifyBuildIntegrity(
      resolve(dirname(fileURLToPath(import.meta.url)), '../lib'),
      sourceRevision.currentGitCommit ?? '',
      manifest.versions.buildArtifactsHash,
    )
    buildArtifactsHash = verified.artifactsHash
  } catch (error) {
    buildIntegrityError = error instanceof Error ? error.message : String(error)
  }
  const processIdentity = readProcessIdentity(process.pid)
  const processIdentityVerified = processIdentity !== null && processIdentityAlive(processIdentity) === true
  let dshProviderPackagesAvailable = false
  let dshProviderPackageError = null
  let installedDshLlmVersion = null
  let installedProviderAdapterVersion = null
  if (routeSupported) {
    try {
      // preflight 只做本地 package resolution；绝不实例化 provider，避免“预检”触发网络副作用。
      installedDshLlmVersion = installedPackageVersion('@deepseek-ai/dsh-llm')
      installedProviderAdapterVersion = installedPackageVersion('@deepseek-ai/dsh-llm-deepseek')
      dshProviderPackagesAvailable = true
    } catch (error) {
      dshProviderPackageError = error instanceof Error ? error.message : String(error)
    }
  }
  const clock = systemClock()
  const preflightDb = new Database(':memory:')
  migrate(preflightDb)
  const preflightPrices = new PriceTableStore(preflightDb)
  preflightPrices.seed(DEEPSEEK_PRICE_SEED)
  const now = clock.now()
  const priceStale = preflightPrices.isStale(now)
  const price = preflightPrices.select(manifest.route.model, now)
  const priceTableVersion = preflightPrices.version()
  const ledger = new BudgetLedger(preflightDb)
  const maximumCall = budgets === undefined ? undefined : ledger.preflight({
    at: now,
    model: manifest.route.model,
    estimatedUsage: { tokensIn: manifest.route.maxChars * 3 + 4_096, tokensOut: manifest.route.maxTokens, tokensCached: 0 },
    dailyBudgetUsd: budgets.dailyBudgetUsd,
    tokenCap: budgets.dailyTokenCap,
    wake: 'W1',
  })
  preflightDb.close()

  const readiness = {
    executeFlag: options.execute,
    routeSupported,
    currentGitCommit: sourceRevision.currentGitCommit,
    manifestGitCommit: manifest.versions.gitCommit,
    codeCommitMatches,
    buildArtifactsHash,
    manifestBuildArtifactsHash: manifest.versions.buildArtifactsHash,
    buildIntegrityMatches: buildArtifactsHash === manifest.versions.buildArtifactsHash,
    buildIntegrityError,
    trackedWorktreeClean: sourceRevision.trackedWorktreeClean,
    processIdentityAvailable: processIdentity !== null,
    processIdentityVerified,
    installedDshLlmVersion,
    manifestDshLlmVersion: manifest.versions.dshLlmVersion,
    installedProviderAdapterVersion,
    manifestProviderAdapterVersion: manifest.versions.providerAdapterVersion,
    providerConfigHashMatches: manifest.versions.providerConfigHash === fingerprint(R5_DEEPSEEK_PROVIDER_CONFIG),
    manifestPriceTableVersion: manifest.versions.priceTableVersion,
    currentPriceTableVersion: priceTableVersion,
    priceTableVersionMatches: manifest.versions.priceTableVersion === priceTableVersion,
    dshProviderPackagesAvailable,
    dshProviderPackageError,
    providerConnectionProbe: 'not_run',
    apiKeyPresent,
    keyIsolationAcknowledged,
    apiKeyDedicated,
    budgetAuthorizationPresent: budgets !== undefined,
    budgetError: budgetError ?? null,
    priceAvailable: price !== undefined,
    priceStale,
    priceTableVersion,
    worstCaseModelCalls: r5MaximumModelCalls(manifest),
    worstCaseSingleCallUsd: maximumCall?.estimateUsd ?? null,
    worstCaseSingleCallFitsDaily: maximumCall?.decision.allow ?? false,
    stateDbProvided: statePath !== undefined,
    readyToExecute: options.execute && routeSupported && dshProviderPackagesAvailable && codeCommitMatches &&
      buildArtifactsHash === manifest.versions.buildArtifactsHash &&
      processIdentity !== null && processIdentityVerified &&
      sourceRevision.trackedWorktreeClean && installedDshLlmVersion === manifest.versions.dshLlmVersion &&
      installedProviderAdapterVersion === manifest.versions.providerAdapterVersion &&
      manifest.versions.providerConfigHash === fingerprint(R5_DEEPSEEK_PROVIDER_CONFIG) &&
      manifest.versions.priceTableVersion === priceTableVersion &&
      apiKeyDedicated && budgets !== undefined &&
      price !== undefined && !priceStale && statePath !== undefined,
  }
  if (!options.execute) {
    const report = {
      artifactVersion: 1,
      mode: 'preflight',
      experimentId: manifest.experimentId,
      manifestHash: summary.manifestHash,
      gitCommit: summary.gitCommit,
      buildArtifactsHash,
      split: manifest.split,
      samples: summary.samples,
      independentWindows: summary.windows,
      pitDataHash: summary.pitDataHash,
      pitWindowHashes: summary.pitWindowHashes,
      preregisteredCritiqueCorrectionWindows: summary.preregisteredCritiqueCorrectionWindows,
      preregisteredFalseAlarmWindows: summary.preregisteredFalseAlarmWindows,
      route: manifest.route,
      readiness,
      externalModelCalls: 0,
      r5OverallPassed: false,
      note: '纯本地预检：只解析安装版本与本地工件，未实例化 provider、未建立模型连接、未调用模型或进入经济闸。',
    }
    atomicJson(outputPath, report)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }

  if (!readiness.readyToExecute || budgets === undefined || statePath === undefined) {
    process.stdout.write(`${JSON.stringify({ ...readiness, experimentId: manifest.experimentId, manifestHash: summary.manifestHash }, null, 2)}\n`)
    throw new Error('R5 execute gate 未满足；provider I/O 未开始')
  }
  // 固定到当前 OS 用户目录，不随 DSH profile 的 DSH_HOME 改变预算/去重 registry。
  const osUserHome = userInfo().homedir
  if (!isAbsolute(osUserHome)) throw new Error('无法解析当前 OS 用户的固定 control registry 目录')
  const controlDirectory = join(osUserHome, '.dsh', 'trading', 'r5-control')
  const controlPath = join(controlDirectory, 'registry.sqlite')
  if (basename(statePath).toLowerCase() === 'desk.db') throw new Error('R5 state DB 不得指向生产 desk.db')
  if (statePath === manifestPath || statePath === outputPath || statePath === controlPath) {
    throw new Error('manifest/output/state DB/control DB 必须使用不同文件')
  }
  ensurePrivateDirectory(dirname(statePath), 'R5 state DB 目录')
  if (options.resume && !existsSync(statePath)) throw new Error('--resume 要求 state DB 已存在')
  if (existsSync(statePath) && !options.resume) throw new Error(`state DB 已存在：${statePath}（如同一实验续跑请传 --resume）`)
  ensurePrivateDirectory(controlDirectory, 'R5 control registry 目录')
  if (options.resume && !existsSync(controlPath)) throw new Error('--resume 要求共享 control registry 存在；缺失时不能重置预算账本')
  if (existsSync(controlPath)) assertPrivateMode(controlPath, 'R5 control registry 文件')
  if (options.resume) {
    assertPrivateMode(statePath, 'R5 state DB 文件')
    const existingDb = new Database(statePath, { readonly: true, fileMustExist: true })
    try {
      const auditTable = existingDb.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='audit_events'").get()
      if (auditTable === undefined) throw new Error('--resume state DB 不是有效的 R5 实验账本')
      const rows = existingDb.prepare("SELECT payload_json FROM audit_events WHERE kind='r5_experiment_started'").all()
      const matches = rows.some((row) => {
        try {
          const payload = JSON.parse(row.payload_json)
          return payload.experimentId === manifest.experimentId && payload.manifestHash === summary.manifestHash
        } catch { return false }
      })
      if (!matches) throw new Error('--resume state DB 中不存在匹配的 experimentId + manifestHash；拒绝写入')
    } finally {
      existingDb.close()
    }
  }

  let db
  let controlDb
  let dshModel
  let originalUmask
  try {
    originalUmask = process.umask(0o077)
    if (!options.resume) {
      const stateFd = openSync(statePath, 'wx', 0o600)
      closeSync(stateFd)
    }
    if (!existsSync(controlPath)) {
      try {
        const controlFd = openSync(controlPath, 'wx', 0o600)
        closeSync(controlFd)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    assertPrivateMode(controlPath, 'R5 control registry 文件')
    controlDb = new Database(controlPath)
    migrate(controlDb)
    db = new Database(statePath)
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const stateDbId = fingerprint(realpathSync(statePath))
    // 在 workflow 完成预算 reservation 之后，首次 stream 才实例化 DSH provider。
    // 即使 provider 初始化会尝试外部 I/O，也不会发生在预算/调用上限检查之前。
    const model = {
      async *stream(modelOptions) {
        dshModel ??= await createDshDecisionModel(manifest.route)
        yield* dshModel.model.stream(modelOptions)
      },
    }
    const run = await runR5StaticExperiment({
      manifest,
      db,
      registry: new R5ControlRegistry(controlDb, clock),
      stateDbId,
      processIdentity,
      isProcessIdentityAlive: processIdentityAlive,
      keyIsolationAcknowledged: apiKeyDedicated,
      requireExistingControlExperiment: options.resume,
      clock,
      model,
      budgets,
      credentialValues,
      ...(options.samplestart === undefined ? {} : { sampleStartIndex: Number(options.samplestart) }),
      ...(options.samplecount === undefined ? {} : { sampleCount: Number(options.samplecount) }),
      ...(options.maxmodelcalls === undefined ? {} : { maxModelCalls: Number(options.maxmodelcalls) }),
    })
    const staticEngineeringGate = passesR5StaticEngineeringGate(run, R5_MIN_WINDOWS)
    const report = {
      artifactVersion: 1,
      mode: 'real-model-static-judgment',
      generatedAt: clock.now(),
      experimentId: run.experimentId,
      manifestHash: run.manifestHash,
      pitDataHash: summary.pitDataHash,
      pitWindowHashes: summary.pitWindowHashes,
      gitCommit: summary.gitCommit,
      buildArtifactsHash,
      split: run.split,
      dataset: manifest.dataset,
      route: manifest.route,
      budgetAuthorization: budgets,
      priceTableVersion: new PriceTableStore(db).version(),
      manifestPriceTableVersion: manifest.versions.priceTableVersion,
      pricingSource: PRICING_SOURCE,
      readiness,
      run,
      controlRegistryId: fingerprint(realpathSync(controlPath)),
      staticEngineeringGate,
      executionChainSamples: 0,
      economicGate: 'not_run',
      r5OverallPassed: false,
      noOrdersSentByThisRunner: true,
      blockers: ['至少 50 个非空样本经过执行链', '独立 forward-paper 经济闸及账户权益时间块 bootstrap'],
    }
    atomicJson(outputPath, report)
    const markdownPath = outputPath.replace(/\.json$/i, '.md')
    writeFileSync(`${markdownPath}.tmp-${process.pid}`, markdown(report), { mode: 0o600 })
    renameSync(`${markdownPath}.tmp-${process.pid}`, markdownPath)
    process.stdout.write(`${JSON.stringify({ ...report, output: outputPath, markdown: markdownPath }, null, 2)}\n`)
    return run.status === 'finished' && staticEngineeringGate ? 0 : 2
  } finally {
    try {
      await dshModel?.dispose()
    } finally {
      try {
        db?.close()
      } finally {
        try {
          controlDb?.close()
        } finally {
          if (originalUmask !== undefined) process.umask(originalUmask)
        }
      }
    }
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`${message}\n${USAGE}`)
  process.exitCode = 2
})
