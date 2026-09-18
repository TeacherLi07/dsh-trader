# T3.5 HTX 单 venue 集成验收（2026-09-18）

## 范围

- 合并 T3.2 HTX 订单状态机、T3.3 行情/策略 fail-closed、T3.4 平台迁移与持久调度。
- 生产配置只允许 HTX；ccxt 仅承担签名、代理与 market metadata。
- workflow 成功签发的一次性 context token 成为 `trade_plan_card` / `trade_record_decision` 的代码级前置条件。

## 可计算结果

```text
pnpm verify
Test Files  65 passed (65)
Tests       678 passed (678)

dsh --profile trade --dump-config
trade entries = 13
trade-market venue = htx
trade-exec venue = htx
crossCheckVenue 命中 = 0
settleMs = 60000
```

## 边界

本轮没有调用真实私有下单端点。连续 P3 前仍需真实 HTX 的“非空持仓 + 算法保护单”只读 merged 对账；`live_confirm` 在结构化逐单确认 token 接入前继续 fail-closed。
