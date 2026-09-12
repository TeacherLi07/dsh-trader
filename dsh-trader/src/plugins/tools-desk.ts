/**
 * `trade-tools-desk` —— 交易员/裁决者的工具面（plan §11.4）。
 *
 * 目标：`trade_portfolio`、`trade_propose_order`、`trade_execute_order`、`trade_cancel`、
 * `trade_order_status`、`trade_record_decision`、`trade_workflow_run`、`trade_recall`。
 *
 * 纪律：
 *   · `propose` 与 `execute` **必须分离**；
 *   · 能下单的工具**只注册给 desk session 的裁决者**，子 agent 一律 `restrict({deny})`；
 *   · 每个 execute 内部**强制**再验一遍硬闸（双保险）；
 *   · desk agent 的工具白名单目标 ≤ 20（工具过多会显著降低选择准确率）。
 *
 * 状态：骨架（T0.1）。实现属 T1.3。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'trade-tools-desk'

export function apply(ctx: Context): void {
  // TODO(T1.3): defineTool 注册；每个执行类工具先重取交易所状态，再过 validateIntent。
  ctx.effect(
    () => () => {
      /* T1.3: 注销工具 */
    },
    'trade.tools-desk.close',
  )
}
