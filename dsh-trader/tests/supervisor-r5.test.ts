import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReplayClock } from '../src/clock.js'
import { DEEPSEEK_PRICE_SEED } from '../src/cost.js'
import { migrate } from '../src/db/schema.js'
import { PriceTableStore } from '../src/cost-ledger.js'
import { fingerprint } from '../src/util/canonical.js'
import { DECISION_CONTEXT_SECTIONS, DECISION_CONTEXT_VERSION, freezeDecisionContext } from '../src/agents/decision-context.js'
import { DECISION_WORKFLOW_PROMPT_VERSION } from '../src/agents/decision-workflow.js'
import type { DecisionEnvelopeCandidate } from '../src/agents/decision-envelope.js'
import type { DecisionModel, DecisionWorkflowStages } from '../src/agents/decision-workflow.js'
import {
  R5_MIN_WINDOWS,
  R5_DEEPSEEK_PROVIDER_CONFIG,
  assertNoCredentialValues,
  aggregateR5StaticResults,
  computeR5DatasetHash,
  computeR5PITDataHash,
  computeR5PITWindowHashes,
  isDedicatedR5ApiKey,
  passesR5StaticEngineeringGate,
  r5MaximumModelCalls,
  scoreR5StaticSample,
  r5SeedPriceTableVersion,
  validateR5Manifest,
  validateR5BudgetAuthorization,
  type R5ExperimentManifest,
} from '../src/supervisor/r5.js'
import { runR5StaticExperiment } from '../src/supervisor/r5-runner.js'
import { R5ControlRegistry } from '../src/supervisor/r5-registry.js'

const START = Date.UTC(2026, 0, 1)
const EVIDENCE_PATH = '/sections/market/value/labelledFact'

function sample(index: number) {
  const at = START + index * 4 * 3_600_000
  const context = freezeDecisionContext({
    symbol: 'BTC/USDT:USDT',
    primaryTimeframe: '1h',
    asOf: at,
    sections: Object.fromEntries(DECISION_CONTEXT_SECTIONS.map((section) => [section, {
      asOf: at,
      source: 'r5-fixture',
      missing: [],
      value: section === 'market' ? { labelledFact: `fact-${index}`, counterFact: `counter-${index}` } : {},
    }])) as never,
  })
  return {
    sampleId: `sample-${index}`,
    windowId: `window-${index}`,
    at,
    context,
    labels: {
      expectedOutcome: 'no_trade' as const,
      requiredEvidencePaths: [EVIDENCE_PATH],
      forbiddenOpen: true,
      expectedCritiqueDispositions: [{
        evidencePath: EVIDENCE_PATH,
        disposition: index % 2 === 0 ? 'accept' as const : 'reject' as const,
      }],
    },
  }
}

function manifest(count = R5_MIN_WINDOWS): R5ExperimentManifest {
  const samples = Array.from({ length: count }, (_, index) => sample(index))
  return {
    schemaVersion: 1,
    experimentId: 'r5-validation-2026-01',
    split: 'validation',
    dataset: {
      id: 'historical-pit-v1',
      contentHash: computeR5DatasetHash(samples),
      source: 'pre-frozen fixture window export',
    },
    versions: {
      gitCommit: 'a'.repeat(40),
      buildArtifactsHash: `sha256:${'6'.repeat(64)}`,
      contextSchemaVersion: DECISION_CONTEXT_VERSION,
      decisionPromptVersion: DECISION_WORKFLOW_PROMPT_VERSION,
      dshLlmVersion: 'fixture-dsh-llm-version',
      providerAdapterVersion: 'fixture-provider-version',
      providerConfigHash: fingerprint(R5_DEEPSEEK_PROVIDER_CONFIG),
      priceTableVersion: r5SeedPriceTableVersion(),
    },
    preregistration: {
      frozenAt: START - 1,
      windowStart: START,
      windowEnd: START + (count + 1) * 4 * 3_600_000,
      blockLength: 6,
      absoluteMaxDrawdownUsd: 100,
      selectionRule: 'critique-if-supported-otherwise-single',
    },
    route: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 512, maxChars: 180_000 },
    samples,
  }
}

const noTrade: DecisionEnvelopeCandidate = {
  outcome: 'no_trade',
  thesis: 'fixture label check',
  rejectedAlternatives: [],
  claims: [{ kind: 'observation', statement: 'the prelabelled fact', evidencePaths: [EVIDENCE_PATH] }],
  uncertainties: [],
  confidence: 0.5,
  riskFraction: 1,
}

class FakeR5Model implements DecisionModel {
  calls = 0

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const name = options.tools?.[0]?.name
    const output = name === 'submit_risk_critique'
      ? { issues: [], uncertainties: ['fixture-only'] }
      : noTrade
    yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } } as StreamChunk
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: `r5-fake-${this.calls}`, name, arguments: JSON.stringify(output) },
    } as unknown as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk
  }
}

describe('R5 pre-registered manifest and static scoring', () => {
  it('requires 200 non-empty independent windows and rejects repeated contexts', () => {
    expect(() => validateR5Manifest(manifest(R5_MIN_WINDOWS - 1))).toThrow(/独立评估窗口 199 < 200/)
    const oversized = manifest()
    expect(() => validateR5Manifest({ ...oversized, samples: Array.from({ length: 10_001 }, () => oversized.samples[0]) }))
      .toThrow(/资源保护上限/)

    const repeated = manifest()
    const samples = [...repeated.samples]
    samples[1] = { ...samples[1]!, windowId: samples[0]!.windowId, at: samples[0]!.at, context: samples[0]!.context }
    expect(() => validateR5Manifest({ ...repeated, samples })).toThrow(/重复快照不能增加样本量/)

    const sameTimeDifferentWindow = manifest()
    const aliased = [...sameTimeDifferentWindow.samples]
    aliased[1] = { ...aliased[1]!, windowId: 'forged-independent-window', at: aliased[0]!.at }
    const aliasedManifest = {
      ...sameTimeDifferentWindow,
      samples: aliased,
      dataset: { ...sameTimeDifferentWindow.dataset, contentHash: computeR5DatasetHash(aliased) },
    }
    expect(() => validateR5Manifest(aliasedManifest)).toThrow(/同一时点.*多个 windowId/)

    const relabelled = repeated.samples.map((item, index) => ({
      ...item,
      sampleId: `renamed-${index}`,
      windowId: `renamed-window-${index}`,
      labels: { ...item.labels, forbiddenOpen: false },
    }))
    expect(computeR5PITDataHash(relabelled)).toBe(computeR5PITDataHash(repeated.samples))
    expect(computeR5PITWindowHashes(relabelled)).toEqual(computeR5PITWindowHashes(repeated.samples))
    expect(computeR5PITWindowHashes(repeated.samples.slice(0, 199))).toHaveLength(199)
  })

  it('validates preregistered evidence labels against each frozen context', () => {
    const valid = validateR5Manifest(manifest())
    expect(valid.summary).toMatchObject({
      samples: 200, windows: 200, split: 'validation',
      preregisteredCritiqueCorrectionWindows: 100, preregisteredFalseAlarmWindows: 100,
      pitWindowHashes: expect.arrayContaining([expect.stringMatching(/^sha256:/)]),
    })
    expect(valid.summary.manifestHash).toMatch(/^sha256:/)
    expect(r5MaximumModelCalls(manifest())).toBe(1_600)

    const bad = manifest()
    const samples = [...bad.samples]
    samples[0] = { ...samples[0]!, labels: { requiredEvidencePaths: ['/sections/market/value/missing'] } }
    expect(() => validateR5Manifest({ ...bad, samples })).toThrow(/requiredEvidencePaths/)
    expect(() => validateR5Manifest({ ...manifest(), route: { ...manifest().route, model: 'self-selected-model' } }))
      .toThrow(/冻结生产路由/)
    expect(() => validateR5Manifest({ ...manifest(), dataset: { ...manifest().dataset, contentHash: `sha256:${'b'.repeat(64)}` } }))
      .toThrow(/contentHash/)
    expect(() => validateR5Manifest({ ...manifest(), apiSecret: 'NEVER-PERSIST-THIS' })).toThrow(/敏感字段/)
  })

  it('拒绝 Critic 纠错或误报预标注分母为空的实验清单', () => {
    const base = manifest()
    const onlyCorrections = base.samples.map((item) => ({
      ...item,
      labels: { ...item.labels, expectedCritiqueDispositions: [{ evidencePath: EVIDENCE_PATH, disposition: 'accept' as const }] },
    }))
    const correctionsOnlyManifest = {
      ...base,
      samples: onlyCorrections,
      dataset: { ...base.dataset, contentHash: computeR5DatasetHash(onlyCorrections) },
    }
    expect(() => validateR5Manifest(correctionsOnlyManifest)).toThrow(/应驳回的误报/)

    const duplicate = base.samples.map((item, index) => index === 0 ? {
      ...item,
      labels: {
        ...item.labels,
        expectedCritiqueDispositions: [
          ...item.labels.expectedCritiqueDispositions!,
          { evidencePath: EVIDENCE_PATH, disposition: 'reject' as const },
        ],
      },
    } : item)
    const duplicateManifest = { ...base, samples: duplicate, dataset: { ...base.dataset, contentHash: computeR5DatasetHash(duplicate) } }
    expect(() => validateR5Manifest(duplicateManifest)).toThrow(/不得重复/)
  })

  it('检测藏在普通 context 文本里的实际凭据且错误不泄漏凭据值', () => {
    const secret = 'r5-provider-secret-never-print'
    let thrown: unknown
    try { assertNoCredentialValues({ market: { description: `external text: ${secret}` } }, [secret]) }
    catch (error) { thrown = error }
    expect(String(thrown)).toMatch(/运行时凭据值.*market\/description/)
    expect(String(thrown)).not.toContain(secret)
    let keyThrown: unknown
    try { assertNoCredentialValues({ market: { [secret]: 'field name is not a safe place for a token' } }, [secret]) }
    catch (error) { keyThrown = error }
    expect(String(keyThrown)).toMatch(/object-key/)
    expect(String(keyThrown)).not.toContain(secret)
  })

  it('拒绝分区摘要时间正常但嵌套 observation availableAt 超前的 PIT 清单', () => {
    const base = manifest()
    const first = base.samples[0]!
    const futureContext = freezeDecisionContext({
      symbol: first.context.symbol,
      primaryTimeframe: first.context.primaryTimeframe,
      asOf: first.at,
      sections: {
        ...first.context.sections,
        market: {
          ...first.context.sections.market,
          hash: undefined,
          value: {
            ...first.context.sections.market.value as Record<string, unknown>,
            nestedObservation: { availableAt: first.at + 1 },
          },
        },
      },
    })
    const samples = base.samples.map((item, index) => index === 0 ? { ...item, context: futureContext } : item)
    const futureManifest = { ...base, samples, dataset: { ...base.dataset, contentHash: computeR5DatasetHash(samples) } }
    expect(() => validateR5Manifest(futureManifest)).toThrow(/availableAt.*超前于 PIT/)
  })

  it('requires explicit positive daily, token, and total experiment caps', () => {
    expect(() => validateR5BudgetAuthorization({})).toThrow(/dailyBudgetUsd/)
    expect(() => validateR5BudgetAuthorization({
      dailyBudgetUsd: 1, dailyTokenCap: 1000, totalBudgetUsd: 0,
    })).toThrow(/totalBudgetUsd/)
    expect(validateR5BudgetAuthorization({
      dailyBudgetUsd: 2, dailyTokenCap: 50_000, totalBudgetUsd: 100,
    })).toEqual({ dailyBudgetUsd: 2, dailyTokenCap: 50_000, totalBudgetUsd: 100 })
  })

  it('recognizes only a non-empty R5 key distinct from the production key after normalization', () => {
    expect(isDedicatedR5ApiKey('', 'prod', true)).toBe(false)
    expect(isDedicatedR5ApiKey('  ', '', true)).toBe(false)
    expect(isDedicatedR5ApiKey('r5-key', '', false)).toBe(false)
    expect(isDedicatedR5ApiKey('r5-key', '', true)).toBe(true)
    expect(isDedicatedR5ApiKey('prod-key ', 'prod-key', true)).toBe(false)
    expect(isDedicatedR5ApiKey('r5-key', 'prod-key', true)).toBe(true)
  })

  it('scores labels and refuses zero-row static aggregation', () => {
    expect(() => aggregateR5StaticResults([])).toThrow(/non-empty results/)
    const item = sample(0)
    const stages: DecisionWorkflowStages = {
      strategy: 'single', final: noTrade, evidenceIssues: [], calls: [], repairCalls: 0,
    }
    const scored = scoreR5StaticSample(item, 'single', stages)
    expect(scored).toMatchObject({
      schemaSuccess: true,
      firstPassSuccess: true,
      missingRequiredEvidencePaths: [],
      forbiddenOpen: false,
      expectedOutcomeMatch: true,
    })
    expect(aggregateR5StaticResults([scored])).toMatchObject({
      samples: 1, windows: 1, schemaSuccessRate: 1, executionChainSamples: 0, economicGate: 'not_run',
    })

    const opens: DecisionEnvelopeCandidate = {
      ...noTrade,
      outcome: 'act',
      immediateAction: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 99 } },
    }
    expect(scoreR5StaticSample(item, 'single', { ...stages, final: opens })).toMatchObject({
      forbiddenOpen: true, expectedOutcomeMatch: false,
    })
  })

  it('静态工程闸要求两策略齐全、样本达标且纠错/误报分母非空', () => {
    const aggregate: ReturnType<typeof aggregateR5StaticResults> = {
      samples: 200, windows: 200, schemaSuccessRate: 1, firstPassSuccessRate: 1, repairedSamples: 0,
      evidenceIssueCount: 0, missingRequiredEvidenceCount: 0, missingCritiqueEvidenceCount: 0,
      forbiddenCritiqueCount: 0, expectedCritiqueCorrections: 1, correctlyAddressedCritiqueCorrections: 1,
      expectedFalseAlarms: 1, rejectedFalseAlarms: 1, critiqueDispositionMismatches: 0,
      forbiddenOpenCount: 0, expectedOutcomeAccuracy: 1, executionChainSamples: 0, economicGate: 'not_run',
    }
    const run = { status: 'finished', terminalRuns: 400, expectedRuns: 400, staticByStrategy: { single: aggregate, critique: aggregate } }
    expect(passesR5StaticEngineeringGate(run)).toBe(true)
    expect(passesR5StaticEngineeringGate({
      ...run,
      staticByStrategy: { ...run.staticByStrategy, critique: { ...aggregate, expectedFalseAlarms: 0 } },
    })).toBe(false)
    expect(passesR5StaticEngineeringGate({ ...run, terminalRuns: 399 })).toBe(false)
  })

  it('Critic 预标注只计入 critique arm，single arm 仍可通过结构工程闸', () => {
    const item = {
      ...sample(0),
      labels: {
        ...sample(0).labels,
        expectedCritiqueDispositions: [
          { evidencePath: EVIDENCE_PATH, disposition: 'accept' as const },
          { evidencePath: '/sections/market/value/counterFact', disposition: 'reject' as const },
        ],
      },
    }
    const single = scoreR5StaticSample(item, 'single', {
      strategy: 'single', final: noTrade, evidenceIssues: [], calls: [], repairCalls: 0,
    })
    expect(single).toMatchObject({
      expectedCritiqueCorrections: 0,
      expectedFalseAlarms: 0,
      missingCritiquePaths: [],
    })

    const critiqueStages: DecisionWorkflowStages = {
      strategy: 'critique',
      critique: {
        issues: [{
          critiqueId: 'required-correction', severity: 'P1', statement: 'supported correction',
          evidencePaths: [EVIDENCE_PATH],
        }],
        uncertainties: [],
        evidenceIssues: [],
      },
      final: {
        ...noTrade,
        critiqueResponses: [{ critiqueId: 'required-correction', disposition: 'accept', reason: 'supported' }],
      },
      evidenceIssues: [], calls: [], repairCalls: 0,
    }
    const critique = scoreR5StaticSample(item, 'critique', critiqueStages)
    expect(critique).toMatchObject({
      expectedCritiqueCorrections: 1,
      correctlyAddressedCritiqueCorrections: 1,
      expectedFalseAlarms: 1,
      rejectedFalseAlarms: 1,
      missingCritiquePaths: [],
    })
    const run = {
      status: 'finished', terminalRuns: 2, expectedRuns: 2,
      staticByStrategy: {
        single: aggregateR5StaticResults([single]) as ReturnType<typeof aggregateR5StaticResults>,
        critique: aggregateR5StaticResults([critique]) as ReturnType<typeof aggregateR5StaticResults>,
      },
    }
    expect(passesR5StaticEngineeringGate(run, 1)).toBe(true)
  })

  it('separately scores supported critique corrections and rejected false alarms', () => {
    const item = sample(0)
    const labelled = {
      ...item,
      labels: {
        ...item.labels,
        expectedCritiqueDispositions: [
          { evidencePath: EVIDENCE_PATH, disposition: 'accept' as const },
          { evidencePath: '/sections/market/value/counterFact', disposition: 'reject' as const },
        ],
      },
    }
    const candidate: DecisionEnvelopeCandidate = {
      ...noTrade,
      critiqueResponses: [
        { critiqueId: 'required-correction', disposition: 'accept', reason: 'confirmed' },
        { critiqueId: 'false-alarm', disposition: 'reject', reason: 'not supported' },
      ],
    }
    const scored = scoreR5StaticSample(labelled, 'critique', {
      strategy: 'critique', final: candidate, evidenceIssues: [], repairCalls: 0,
      critique: { issues: [
        { critiqueId: 'required-correction', severity: 'P1', statement: 'required', evidencePaths: [EVIDENCE_PATH] },
        { critiqueId: 'false-alarm', severity: 'P1', statement: 'false alarm', evidencePaths: ['/sections/market/value/counterFact'] },
      ], uncertainties: [], evidenceIssues: [] },
      calls: [],
    })
    expect(scored).toMatchObject({
      expectedCritiqueCorrections: 1,
      correctlyAddressedCritiqueCorrections: 1,
      expectedFalseAlarms: 1,
      rejectedFalseAlarms: 1,
      critiqueDispositionMismatches: 0,
    })
  })

  it('persists real-run structure, enforces call budgets, and resumes without duplicate calls', async () => {
    const db = new Database(':memory:')
    const controlDb = new Database(':memory:')
    migrate(db)
    migrate(controlDb)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const clock = new ReplayClock(Date.UTC(2026, 8, 20, 12))
    const model = new FakeR5Model()
    const registry = new R5ControlRegistry(controlDb, clock)
    const args = {
      manifest: manifest(),
      db,
      registry,
      stateDbId: `sha256:${'c'.repeat(64)}`,
      processIdentity: { pid: 1234, bootId: 'test-boot', startTicks: '100' },
      isProcessIdentityAlive: () => true,
      keyIsolationAcknowledged: true,
      credentialValues: [],
      clock,
      model,
      budgets: { dailyBudgetUsd: 10, dailyTokenCap: 10_000_000, totalBudgetUsd: 100 },
      sampleStartIndex: 0,
      sampleCount: 1,
    } as const
    try {
      const secret = 'r5-provider-secret-never-prompt'
      const firstSample = args.manifest.samples[0]!
      const contextWithCredential = freezeDecisionContext({
        symbol: firstSample.context.symbol,
        primaryTimeframe: firstSample.context.primaryTimeframe,
        asOf: firstSample.at,
        sections: {
          ...firstSample.context.sections,
          market: {
            ...firstSample.context.sections.market,
            hash: undefined,
            value: {
              ...firstSample.context.sections.market.value as Record<string, unknown>,
              textNote: `PIT note ${secret}`,
            },
          },
        },
      })
      const contaminatedSamples = args.manifest.samples.map((item, index) =>
        index === 0 ? { ...item, context: contextWithCredential } : item)
      const contaminatedManifest = {
        ...args.manifest,
        samples: contaminatedSamples,
        dataset: { ...args.manifest.dataset, contentHash: computeR5DatasetHash(contaminatedSamples) },
      }
      await expect(runR5StaticExperiment({ ...args, manifest: contaminatedManifest, credentialValues: [secret] }))
        .rejects.toThrow(/运行时凭据值/)
      expect(model.calls).toBe(0)

      const first = await runR5StaticExperiment({ ...args, maxModelCalls: 1 })
      expect(first).toMatchObject({ status: 'budget-stopped', terminalRuns: 1, modelCalls: 1 })
      expect(model.calls).toBe(1)

      const second = await runR5StaticExperiment({ ...args, maxModelCalls: 1 })
      expect(second).toMatchObject({ status: 'budget-stopped', terminalRuns: 1, modelCalls: 2 })
      expect(model.calls).toBe(2)

      const third = await runR5StaticExperiment({ ...args, maxModelCalls: 10 })
      expect(third).toMatchObject({ status: 'incomplete', terminalRuns: 2, modelCalls: 4 })
      expect(third.staticAggregate).toMatchObject({
        samples: 2, windows: 1, executionChainSamples: 0, economicGate: 'not_run',
      })
      expect(model.calls).toBe(4)

      await runR5StaticExperiment({ ...args, maxModelCalls: 10 })
      expect(model.calls).toBe(4)
      await expect(runR5StaticExperiment({
        ...args,
        budgets: { ...args.budgets, totalBudgetUsd: 101 },
        maxModelCalls: 10,
      })).rejects.toThrow(/预算上限或价目表版本已冻结/)
      expect(model.calls).toBe(4)
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'r5_model_call_reserved'").get()).toMatchObject({ n: 4 })
      expect(db.prepare("SELECT COUNT(*) AS n FROM decision_runs WHERE status = 'completed'").get()).toMatchObject({ n: 2 })
    } finally {
      db.close()
      controlDb.close()
    }
  })

  it('rejects daily or total budget overruns before the model stream starts', async () => {
    const runDenied = async (budgets: { dailyBudgetUsd: number; dailyTokenCap: number; totalBudgetUsd: number }) => {
      const db = new Database(':memory:')
      const controlDb = new Database(':memory:')
      migrate(db)
      migrate(controlDb)
      new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
      const model = new FakeR5Model()
      const clock = new ReplayClock(Date.UTC(2026, 8, 20, 12))
      try {
        const result = await runR5StaticExperiment({
          manifest: manifest(), db, clock, model, registry: new R5ControlRegistry(controlDb, clock),
          stateDbId: fingerprint({ testState: budgets.totalBudgetUsd }),
          processIdentity: { pid: 1234, bootId: 'test-boot', startTicks: '100' },
          isProcessIdentityAlive: () => true,
          keyIsolationAcknowledged: true,
          credentialValues: [],
          budgets, sampleStartIndex: 0, sampleCount: 1,
        })
        expect(result.status).toBe('budget-stopped')
        expect(result.modelCalls).toBe(0)
        expect(model.calls).toBe(0)
        expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'r5_model_call_reserved'").get()).toMatchObject({ n: 0 })
      } finally {
        db.close()
        controlDb.close()
      }
    }
    await runDenied({ dailyBudgetUsd: 1e-12, dailyTokenCap: 10_000_000, totalBudgetUsd: 100 })
    await runDenied({ dailyBudgetUsd: 100, dailyTokenCap: 10_000_000, totalBudgetUsd: 1e-12 })
  })
})
