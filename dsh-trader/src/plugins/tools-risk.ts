/**
 * `trade-tools-risk` —— 风控角色工具面：`trade_risk_check` / `trade_stress_test` / `trade_limits`。
 *
 * **纯计算 + 读限额，不能下单。** 风控角色永不被要求"为提案辩护"（decision §3.1 的反面教材）。
 *
 * 状态：骨架（T0.1）。实现属 T1.3。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'trade-tools-risk'

export function apply(ctx: Context): void {
  // TODO(T1.3): 注册纯计算工具；结果必须带数据指纹与 asOf。
  ctx.effect(
    () => () => {
      /* T1.3: 注销工具 */
    },
    'trade.tools-risk.close',
  )
}
