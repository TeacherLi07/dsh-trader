# T3.4 平台/运营安全收口

日期：2026-09-18

本次完成：

- SQLite schema v4：历史 v3 fixture 可升级，补齐 `triggers.disposition`、`price_table.tier`/复合主键、`budget_ledger.cost_known` 默认值，并保留旧行；新增 `bar_processing`、W1 pending/cursor、workflow context token 表。
- W1 改为持久 pending queue：只在窗口回合成功后推进 cursor；busy、attach/followup 失败和进程重启均可重试。
- workflow 成功后生成随机明文 token，数据库只存 token hash，并保存 pack/context/result 指纹；失败路径不签发 token。
- `settleMs` 从插件配置接线到 runtime；`riskPct` 收紧到 `(0, 0.05]`。
- `p1-acceptance` 拒绝零 due/零 executed 空跑；`live-paper-e2e` 要求每个 executed open 有 ack/filled 保护意图或已确认 flat。

验证：

```text
pnpm verify
typecheck: pass
build: pass
tests: 65 files / 662 tests pass
```

独立覆盖：历史 schema fixture、W1 锚点/失败重试/恢复、workflow token 绑定、fake HTX 启动恢复顺序。

剩余外部项：真 HTX “有持仓 + 算法保护单”的 merged 对账、结构化 `live_confirm` 逐单确认通道。
