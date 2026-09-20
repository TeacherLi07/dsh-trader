# R3 DecisionEnvelope 工程验收（2026-09-20）

复现命令：`pnpm build && node scripts/r3-acceptance.mjs docs/r3-decision-envelope-2026-09-20.json`

使用内存 SQLite、固定时钟与 stub provider；没有外部模型调用，也不评价交易判断质量。

- schema v7 下 single workflow 调用 1 次，最终 outcome 为 `no_trade`。
- usage 记入 decision run 与预算账本：256 input / 48 output，成本已知，估算 `$0.0000672`。
- 同一触发重放命中同一 run，不产生第二次 provider 调用。
- 决策无订单意图；冻结 context 未包含配置中的哨兵密钥。

完整原始输出见 [JSON](./r3-decision-envelope-2026-09-20.json)。真实模型/经济验收留待 R5。
