# R3 DecisionEnvelope 工程验收（stub，2026-09-21）

命令：

```bash
cd dsh-trader
pnpm build
node scripts/r3-acceptance.mjs ../docs/r3-decision-envelope-2026-09-21.json
```

判定：脚本断言全部通过。schema v8；single workflow 产出 `completed/no_trade`；同一触发重放返回幂等结果，stub provider 只调用 1 次；实际 usage 为输入 256、输出 48 tokens，成本记为 0.0000672 USD。

安全检查：外部模型调用 0、订单意图 0；冻结 context 未包含 fixture secret。此结果只证明本地 DecisionRuntime、持久化、usage/cost 和幂等接线，不证明真实模型质量或经济效果。原始输出见同名 JSON。
