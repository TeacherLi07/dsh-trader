# R6 生产执行 runtime 真实连接（2026-10-03）

原始摘要见 [JSON](r6-runtime-connection-2026-10-03.json)，完整脱敏 HTTP/SQLite 在私有 integration-2026-10-03/htx-runtime-v3/ 及同名 HTTP 文件。

首次真实主单失败，HTTP 显示发到 /v5/algo/order：ccxt 把主单风险字段 stopLossPrice 解释成独立算法单，并非附带保护。
HtxBroker 主单现仅传普通订单参数；成交后仍由现有生产执行链挂保护并核验，不另建执行实现。
市价/限价的非空回归保证主单不含标量 stop/tp/trailing 参数。失败和空仓清理证据完整保留。

受控一张 FIL = 0.1 FIL，整张本金加 2% 成本预留约 0.1076 USD，低于账户权益 2% 包络约 0.4981 USD。
同一个 createExecRuntime / executeAction / journal 通过：

- 真实开仓成交、独立止损和非空 merged 保护核验；对账 consistent=true、freezeTrading=false。
- 重复开仓幂等，订单意图数量不增加。
- 销毁并重建 runtime 后，持久 journal 与非空远端仓位/保护对账一致。这是 runtime 重建，不冒称真实 SIGKILL。
- symbol 撤普通单保留保护；reduce-only 平仓后才撤保护；最终空仓、零挂单、对账一致，finally 再次清理通过。
- 非空落库：4 决策、3 意图、3 订单、2 成交、36 审计。

本地 pnpm verify 通过 74 文件 / 831 测试。可复现命令：先 build，再用私有输出目录运行
node --env-file=.env scripts/htx-runtime-check.mjs --execute <private-directory>；默认不带 --execute 只读规格/余额，不下单。
R6 14 天非空安全观察尚未完成，此工程连接探针不替代经济或长期验收。
