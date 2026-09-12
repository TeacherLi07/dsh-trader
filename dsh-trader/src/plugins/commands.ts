/**
 * `trade-commands` —— 人工介入面：`/halt`、`/resume`、`/mode`、`/limits`。
 *
 * 要求（plan §9.1）：介入是**异步且随时可用**的 —— 任何时刻都能执行、立即生效
 * （不等当前回合结束），并作为审计事件留痕。`/halt` 后**恢复必须人工**。
 *
 * 状态：骨架（T0.1）。实现属 P2。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'trade-commands'

export function apply(ctx: Context): void {
  // TODO(P2): ctx.commands 注册 /halt /resume /mode /limits；/halt 置 halted + cancelAll（经外部 watchdog 兜底）。
  ctx.effect(
    () => () => {
      /* P2: 注销命令 */
    },
    'trade.commands.close',
  )
}
