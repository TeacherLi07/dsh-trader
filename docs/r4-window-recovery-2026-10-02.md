# R4 W1 窗口恢复修复（2026-10-02）

原始输出见 [同名 JSON](r4-window-recovery-2026-10-02.json)。

| 判据 | 实测 |
|---|---|
| 原实现上的非空回归 | 3 失败 / 3 通过 |
| 修复后完整检查 | pnpm verify：71 文件 / 786 用例通过，exit 0 |
| 真 DSH 隔离 paper 启动 | exit 0，2 个命令、halt/resume 成功 |
| 模型 / 交易所调用 | 0 / 0 |

复现：在 dsh-trader 下运行 `pnpm verify`；专项为 `pnpm vitest run tests/supervisor-window-queue.test.ts`；插件加载为 `node scripts/offline-startup-check.mjs`。

回归覆盖：领取退回 pending 后旧 complete 不推进游标；恢复并重新领取后旧 complete 不结束新 attempt；旧 fail 不释放新 attempt 或改写其错误。当前 attempt 仍可完成/重试，重复完成幂等。每个样本都实际入队并领取窗口，不用空队列证明正确。

实现仅给现有状态更新增加 attempts 身份条件，并在同一事务内确认完成命中后推进 cursor；supervisor 为失效完成保留失败审计。未增加新表或额外锁。R5/R6 真实验收仍按 plan.md §12 阻塞。
