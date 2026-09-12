/**
 * `trade-tools-research` —— 分析师/辩论角色工具面（**全部只读**）。
 *
 * `trade_market` / `trade_derivatives` / `trade_news` / `trade_onchain`：
 * 返回结构化摘要 + 数据指纹，绝不返回未收盘 K 线。
 *
 * 状态：骨架（T0.1）。实现属 T1.2/T1.3。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'trade-tools-research'

export const Config = z.object({
  maxBars: z.number().default(500),
})

export interface ResearchToolsConfig {
  maxBars: number
}

export function apply(ctx: Context, config: ResearchToolsConfig): void {
  // TODO(T1.2): 注册只读工具；这些工具只允许注册给分析师/辩论子 agent 的作用域。
  ctx.effect(
    () => () => {
      /* T1.2: 注销工具 */
    },
    'trade.tools-research.close',
  )
  void config
}
