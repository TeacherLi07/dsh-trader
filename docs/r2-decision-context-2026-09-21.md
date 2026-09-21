# R2 DecisionContext / 请求预算复验（2026-09-21）

命令：

```bash
cd dsh-trader
pnpm build
node scripts/r2-acceptance.mjs ../docs/r2-decision-context-2026-09-21.json
```

判定：脚本断言全部通过。当前 schema v8；固定 PIT fixture 捕获的 context 为 107,128 字符，请求为 119,243 / 180,000 字符；UTF-8 保守输入预算上界为 123,751 tokens（不是 provider 实际 usage）。非空样本包括 192 根资产 bar、64 根 benchmark bar、32 对 benchmark return、4 条衍生品观测、1 个已结算 outcome、1 个持仓、1 个挂单和 1 条 active-plan commitment。

正常空状态、未来 reconciliation/intent/plan 排除、过期/暖机/晚到行情区分、失败读取脱敏和超长请求拒发均通过。捕获器只用固定合成数据，不连接或调用真实模型，也不代表生产模型质量。完整请求及逐项检查见同名 JSON。
