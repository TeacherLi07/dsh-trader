# R2 DecisionContext / 请求渲染验收

命令：

```bash
cd dsh-trader
pnpm verify
node scripts/r2-acceptance.mjs ../docs/r2-decision-context-2026-09-20.json
```

结果：schema v6；R2 固定样本在渲染边界捕获了完整请求，context 为 107,044 字符，请求为
119,015 / 180,000 字符。非空分母包括 192 根资产 bar、64 根 benchmark bar、32 对 benchmark
收益、4 条衍生品观测、1 个 settled outcome、1 个持仓、1 个挂单和 1 条计划承诺。

正常空状态、未来配置/计划/对账/订单排除、晚到行情、过期、暖机、账户读取错误脱敏、完整计划不截断、
超预算拒发及 lessons/predictions 默认关闭均通过。原始渲染请求与逐项结果见同名 `.json`。

捕获器使用固定合成数据，没有调用真实模型，也不证明当前生产 workflow 已使用该渲染器；R3 负责生产
调用接线与 single/critique / eligibility 验收。当前上下文会明确标记模型预算缺少 intraday PIT 账本、
paper margin 未建模或滑点未知等缺口，不把它们写成零。
