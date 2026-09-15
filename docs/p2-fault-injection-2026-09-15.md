# P2 ①②④ 故障注入验收（真实 `kill -9`，2026-09-15）

> `pnpm build && node scripts/fault-injection.mjs /tmp/p2-fault.json` 产出；
> 原始 JSON 见 `docs/p2-fault-injection-2026-09-15.json`，汇总见
> `p2-fault-injection-2026-09-15.json` 的 `p2_1/p2_2/p2_4/checks`。

## 为什么需要一个"可跨进程持久"的模拟交易所

`paper` broker 是**内存**实现：进程被 `kill -9` 后它自己也消失，无法回答"这笔
`client_order_id` 到底有没有下出去"，因此测不了"孤儿订单 = 0"。这一轮新增
`src/exec/sim-exchange.ts`：用独立的 SQLite 文件持久化订单/成交/持仓，并**严格**按
`client_order_id` 幂等。它只在验收脚本与单测里使用，**不是生产 venue**；
真 HTX 接口的只读核对仍需 §12.2 A 的凭据。

## 判定：全部通过（`allPassed: true`）

### ① 订单在途时 `kill -9` × 50

| 指标 | 结果 |
|---|---|
| 轮数 | 50 |
| 真正送达 `SIGKILL` 的轮数 | **38**（其余 12 轮按设计跑到完成，用于制造"本地有记录的非孤儿挂单"样本） |
| 崩溃后在途意图 > 0 的轮数（非空跑） | **38** |
| **孤儿挂单**（交易所挂着、journal 无记录） | **0** |
| **重复成交**（同一 `clientOrderId` 成交 > 1） | **0** |
| 恢复幂等（第二遍 id 集合不变） | **50/50** |

非空跑守卫：`in_flight_rounds > 0` **且** `open_order_rounds > 0` —— 后者证明
"孤儿 = 0"不是因为交易所挂单集合本来就是空的。

### ② 同一 `clientOrderId` 提交 10 次 ⇒ 只成交 1 次

| 指标 | 结果 |
|---|---|
| 提交次数 | 10 |
| 交易所成交数 | **1** |
| journal 意图数 | **1** |
| journal 成交数 | **1** |
| 重复成交 | **0** |

### ④ 停掉模型供应商：已挂保护单仍生效

父进程建仓并挂保护单后，**不再有任何模型/主循环参与**，仅用 `SimExchange.onPrice`
把价格打到止损价：

| 指标 | 结果 |
|---|---|
| 停摆后保护单触发次数 | **1** |
| 停摆后持仓 | **0** |
| `protective_survives_without_model` | **true** |

这条判据证明"止损走交易所侧条件单、不依赖 LLM"（plan §1 红线 3）。

## 口径（避免以后各算各的）

- **孤儿挂单**：`exchange.openOrders()` 中 `clientOrderId` 不存在于
  `journal.clientOrderIds()` 的订单数；只统计真孤儿，本地有记录的挂单不算。
- **重复成交**：按 `clientOrderId` 分组，`Σ max(0, 组内成交数 − 1)`；不同
  `clientOrderId` 各一笔不互相算重复。
- **恢复幂等**：第一遍与第二遍 `CrashRecovery.run()` 后的
  decisions/intents/clientOrderIds/fills 四组 id 快照完全相等。

## 仍未覆盖（诚实说明）

真 HTX/OKX 端点上的破坏性测试需要凭据（§12.2 A/B）。本脚本用的是同契约的持久化模拟
venue，验证的是**我方状态机**（幂等键、意图先落库、恢复绝不重下单、保护单交易所侧），
不是交易所自身的幂等行为。两者不可互相替代。
