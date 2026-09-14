# P1 阶段验收（①–④，2026-09-14）

> `node scripts/p1-acceptance.mjs 30` 产出；原始 JSON 见 `docs/p1-acceptance-2026-09-14.json`。
> **真实行情**（HTX 30 天 1h，719 根已收盘 bar）→ 真实回放 → 真实结算。

## 判定：全部通过（`allPassed: true`）

| 判据 | 落点 | 结果 |
|---|---|---|
| ① 计划卡 schema 通过率 100% | `validatePlanCard` | ✅ |
| ① `when` 编译成功率 100% | `checkExpressions` | ✅ |
| ② 每次命中都可归因 | 回放日志（matched/UNCOVERED/rule/denied/judgment） | ✅ |
| ② 求值错误全部计 UNCOVERED（不静默） | `uncovered` 计数 == `UNCOVERED:` 行数 | ✅ 14 |
| ③ 计划覆盖率（绑定时点） | `MetricsStore.coverage` | ✅ 1/1 = 1 |
| ③ W2/W3 频次 | `triggers` 按 purpose/disposition | ✅ novelty 6 / rate_limited 2 |
| ③ 每窗口成本 | `budget_ledger` 自洽（机械回放不调模型 ⇒ 0 行） | ✅ |
| ④ 结算成功率 ≥ 99%（含重试） | 真实回放产出 104 条到期决策 | ✅ **104/104 = 100%** |
| ④ 每条决策至多一条 outcome / lesson | SQL `HAVING COUNT(*) > 1` | ✅ 0 / 0 |
| ④ `client_order_id` 重复数 = 0 | SQL 分组计数 | ✅ 0 |

## ★ 这一轮抓到的最重要的问题：结算闭环在回放/机械执行里**根本没接上**

第一版 `p1-acceptance.mjs` 报告 `dueTotal = 0`、`rate = 1` ——
**"成功率 100%"是在 0 个样本上通过的**。根因不是脚本：

`reflection_due_at` 只有 `trade_execute_order`（模型调用路径）会登记，
而 `src/exec/replay.ts` 的机械执行路径**从来不登记**。也就是说：
- 回测/机械执行产生的成交**永远不会进结算队列** ⇒ 反思闭环在回测里根本不跑；
- P1 ④ 的"结算成功率"会长期以"没有样本"的方式显示为通过。

修法：`replay.ts` 在 `ack.state === 'filled'` 且动作属于 `{open, reduce, close}` 时
调用 `markDecisionExecuted` + `markDecisionReflectionDue`（视界可配，默认 4h）。
修完后真实的数字是 **104 条到期、104 条结算、0 条 pending**，
两轮跑完（`attempt 2: scanned 0`）—— 重试路径也据此可观测。

## 顺带修掉的第二个问题：缺数据时"编造结算"

`SettlementScheduler` 原先在"没有成交也没有行情"时会写一条 `entry_price = 0` 的 outcome
（`computeSettlement` 对 `entryPrice = 0` 返回 0% 收益）。那不是"结算成功"，
而是**把数据缺口伪装成一次零收益交易**，会污染 alpha 与 lessons。

现在显式区分：数据不足 ⇒ **推迟**（保持 pending，下一轮重试），
`SettlementRunResult` 增加 `deferred` 与 `deferredIds`（缺的是哪个标的的行情一眼可见）。
有测试证明"数据补齐后重试成功"以及"有成交但无 bar 同样推迟"。

## 仍未覆盖

⑤（`kill -9` 后 resume）：**不在这个脚本里**，由 `scripts/crash-recovery-check.mjs` 单独验证。
P1.5 通道有效性闸门：`scripts/ab-gate.mjs`（见 `docs/p1.5-gate-run-2026-09-14.md`）。
