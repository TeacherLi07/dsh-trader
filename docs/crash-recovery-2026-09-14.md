# P1 ⑤ 崩溃恢复验收（真实 `kill -9`，2026-09-14）

> `node scripts/crash-recovery-check.mjs` 产出；原始 JSON 见 `docs/crash-recovery-2026-09-14.json`。

## 为什么用真的 `SIGKILL`

`SIGKILL` 不可捕获，进程拿不到任何 flush/cleanup 机会 —— 这正是"断电/被 OOM 杀掉"的等价场景。
用 mock 或 `process.exit()` 模拟验证不了"SQLite 里已提交的东西是完整的、没提交的不会半写"。

## 流程

1. 子进程打开临时库，写下崩溃现场（`decisions` + `order_intents(state='created', acked_at IS NULL)`），
   打印 `READY` 后挂住；
2. 父进程读到 `READY` 立刻 `SIGKILL`（实测 `childExit.signal === 'SIGKILL'`）；
3. 父进程重新打开同一个库（resume），跑 `CrashRecovery`；
4. 再跑一遍，验证幂等。

## 判定：10/10 通过（`allPassed: true`）

| 检查 | 结果 |
|---|---|
| 崩溃现场在 SIGKILL 后仍然存在 | ✅ 1 条在途意图 |
| SIGKILL 真的送达 | ✅ `signal === 'SIGKILL'` |
| 恢复后不残留 `created` 无 ack 意图 | ✅ 0 |
| 未知状态**冻结标的**（绝不猜，§4.2） | ✅ 冻结 `BTC/USDT` |
| 无重复决策 / 意图 / `client_order_id` | ✅ 1 / 1 / 0 |
| 恢复幂等（第二遍 id 集合不变） | ✅ |
| 恢复**绝不重新下单**、不产生成交 | ✅ outcomes 0 / fills 0 |
| 告警可操作 | ✅ `orphan_intent_unknown`（含原因与处置说明） |

## 一处诚实说明

本地 paper broker 是**内存**实现，崩溃后无法回答"按 `client_order_id` 查询"，
因此这里收敛为"未知 + 冻结标的" —— 这正是 plan §4.2 规定的行为（"未知持仓告警并冻结自动交易，绝不猜"）。
真交易所接口下的 `client_order_id` 回查与"孤儿订单 = 0（50 次 kill -9）"属 **P2 ①**，
需要测试网凭据（§12 #6），不在这里假装完成。
