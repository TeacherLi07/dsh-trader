/**
 * 计划卡求值的对外门面（plan.md §3.5）。
 * 纯函数、无副作用：回测/回放/实盘走同一份逻辑。
 */

import {
  compileExpression,
  defaultFunctions,
  evaluateExpression,
  parseExpression,
  referencedPaths,
  type DslContext,
  type EvalResult,
  type Expr,
  type Primitive,
} from './dsl.js'

/** `when` 表达式求值 —— 失败即 UNCOVERED，调用方必须落库并告警。 */
export const evaluateWhen = evaluateExpression

export { compileExpression, parseExpression, referencedPaths }
export type { DslContext, EvalResult, Expr, Primitive }

/** 由扁平取值表构造上下文；`functions` 默认只含纯数学函数。 */
export function createDslContext(
  values: Readonly<Record<string, Primitive>>,
  functions: (name: string, args: readonly Primitive[]) => Primitive | undefined = defaultFunctions,
): DslContext {
  return {
    get: (path) => values[path],
    call: (name, args) => functions(name, args),
  }
}

export interface ExpressionCheck {
  readonly expression: string
  readonly reason: string
}

/**
 * 编译率检查（P0 验收：表达式编译成功率 100%）。
 * 合法但引用未知字段的表达式在这里**不算**语法失败 —— 它属于运行期 UNCOVERED。
 */
export function checkExpressions(expressions: readonly string[]): {
  readonly ok: boolean
  readonly errors: readonly ExpressionCheck[]
} {
  const errors: ExpressionCheck[] = []
  for (const expression of expressions) {
    try {
      parseExpression(expression)
    } catch (error) {
      errors.push({ expression, reason: (error as Error).message })
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 准入校验：表达式只允许引用词汇表内的字段（plan §3.2）。
 * 返回未在 `allowed` 中出现的路径 —— 非空即应拒绝该计划卡。
 */
export function unknownPaths(
  expressions: readonly string[],
  allowed: readonly string[],
): readonly string[] {
  const allow = new Set(allowed)
  const unknown = new Set<string>()
  for (const expression of expressions) {
    for (const path of referencedPaths(expression)) {
      if (!allow.has(path)) unknown.add(path)
    }
  }
  return [...unknown].sort()
}

/** v0 词汇表：与 plan §3.2 的值列表逐项对应。未实现的路径不在表内 ⇒ 求值即 UNCOVERED。 */
export const V0_ALLOWED_PATHS: readonly string[] = [
  'position.qty',
  'position.avgPrice',
  'position.unrealizedPnl',
  'equity.quote',
  'price.last',
  'bar.open',
  'bar.high',
  'bar.low',
  'bar.close',
  'bar.volume',
  'ema20',
  'ema50',
  'rsi14',
  'atr14',
  'adx14',
  'vwap20',
  'zscore20',
  'volRealized20',
  'funding.rate',
  'oi.changePct',
  'liq.notional',
  'basis.bps',
  'plan.ageMs',
  'window.sinceMs',
]

/** 保留清单以便验收时显式证明当前没有已知缺口。 */
export const UNIMPLEMENTED_PATHS: readonly string[] = []
