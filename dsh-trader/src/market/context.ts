/**
 * 特征快照 → DSL 上下文（plan §3.2 的词汇表落点）。
 *
 * 只有 `V0_ALLOWED_PATHS` 里的键会被暴露；缺失的键**不填 null**，而是让 `get` 返回
 * `undefined` ⇒ 求值失败 ⇒ UNCOVERED（fail-closed）。这一点很关键：暖机期的指标是 `null`，
 * 若把 `null` 当成 0 参与比较，"rsi14 < 30" 会在暖机期误命中。
 */

import type { DslContext, Primitive } from '../plan/dsl.js'
import { defaultFunctions } from '../plan/dsl.js'
import type { FeatureSnapshot, FeatureValues } from './features.js'

function put(target: Record<string, Primitive>, key: string, value: number | null | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value
}

/** 把一份快照摊平成 DSL 取值表；`extra` 用于合并仓位/权益等非行情状态。 */
export function featureValues(
  values: FeatureValues,
  extra: Readonly<Record<string, Primitive>> = {},
): Record<string, Primitive> {
  const out: Record<string, Primitive> = { ...extra }
  put(out, 'bar.open', values.open)
  put(out, 'bar.high', values.high)
  put(out, 'bar.low', values.low)
  put(out, 'bar.close', values.close)
  put(out, 'bar.volume', values.volume)
  put(out, 'ema20', values.ema20)
  put(out, 'ema50', values.ema50)
  put(out, 'rsi14', values.rsi14)
  put(out, 'atr14', values.atr14)
  put(out, 'adx14', values.adx14)
  put(out, 'vwap20', values.vwap20)
  put(out, 'zscore20', values.zscore20)
  put(out, 'volRealized20', values.volRealized20)
  put(out, 'funding.rate', values.fundingRate)
  put(out, 'oi.changePct', values.oiChangePct)
  put(out, 'liq.notional', values.liqNotional)
  put(out, 'basis.bps', values.basisBps)
  return out
}

export interface FeatureContextOptions {
  readonly extra?: Readonly<Record<string, Primitive>>
  /** `tf` 相关的取值（如窗口计时）在求值前已经是具体数字，由调用方补齐。 */
  readonly functions?: (name: string, args: readonly Primitive[]) => Primitive | undefined
  /**
   * **前一根已收盘 bar** 的快照；只有 `crossAbove`/`crossBelow` 需要。
   * 缺省（第一根 bar、前一根未归档）⇒ cross 求值失败 ⇒ UNCOVERED（fail-closed）。
   * 注意：`extra`（仓位/权益）没有历史，前值沿用当前值 —— 所以 cross 只应比较行情/指标路径。
   */
  readonly previous?: FeatureSnapshot
}

export function createFeatureContext(
  snapshot: FeatureSnapshot,
  options: FeatureContextOptions = {},
): DslContext {
  const table = featureValues(snapshot.values, options.extra)
  const functions = options.functions ?? defaultFunctions
  const previousTable =
    options.previous === undefined ? undefined : featureValues(options.previous.values, options.extra)
  return {
    get: (path) => table[path],
    call: (name, args) => functions(name, args),
    ...(previousTable === undefined ? {} : { previous: (path: string) => previousTable[path] }),
  }
}
