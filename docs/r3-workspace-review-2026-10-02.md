# R3 工作区审查（2026-10-02）

本次是本地代码与恢复边界审查。原始输出见 [同名 JSON](r3-workspace-review-2026-10-02.json)。

| 判据 | 实测 |
|---|---|
| 修改前基线 | pnpm verify：71 文件 / 770 用例通过 |
| 新增回归在原实现上确实失败 | 10 失败 / 5 通过，非空样本 |
| 修改后完整检查 | pnpm verify：71 文件 / 782 用例通过，exit 0 |
| 真实模型 / 交易所调用 | 0 / 0 |

复现：在 dsh-trader 下运行 `pnpm verify`；专项为 `pnpm vitest run tests/decision-workflow.test.ts tests/decision-runtime.test.ts`。

已修复：repair 额度随阶段持久化、拒绝审计补足恢复计数、重启不重发已计费且输出已拒绝的原请求、恢复 final 必须逐项回应 Critic、Critic 字段/长度校验，以及无效缓存/输入/输出 token 计数返回未知成本。引用校验删除临时 envelope，直接复用事实路径函数。

测试包含真正关闭再打开 SQLite 的恢复场景，以及 repaired draft 保存后中断再恢复的非空调用轨迹；并检查再次请求计数为 0 或受限为 1。R5/R6 仍阻塞，详见 plan.md §12。
