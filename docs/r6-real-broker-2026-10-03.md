# R6 真实 broker 修复（2026-10-03）

证据见 [同名 JSON](r6-real-broker-2026-10-03.json)，脱敏 HTTP 原始 trace 留在当前用户私有目录。

真实连接修复：ccxt.options.defaultType、提交/成交查找的 symbol、原生 SL/TP close-only 回报、足量且方向正确的远端 stop、普通触发开仓单的在途敞口，以及区分 exchange id 与 client id 的算法查询。改前回归在非空样本上复现失败；错误和失败探针未覆盖或删除。

一张 FIL=0.1 基础币、约 0.105 USD，全部本金损失和成本预留低于 2%权益包络。真实 open/fill/own-client lookup、SL、TP、全账户 merged、保留保护 cancelAll、reduce-only close 和最终清理均有非空记录。10月3日再次只读确认账户空仓、零挂单。

已有 SL 的历史 exchange-id 查询成功找到记录，venue 返回 failed，adapter 保留 unknown，未伪造 canceled/filled 或执行数量。该未知状态和完整生产 journal/长期安全验收继续单独核验，不把端点冒烟当成 R6 全面通过。

复现入口：`pnpm verify`；真实命令与原始私有报告路径见 JSON。真实复跑需要空账户、显式 --execute、损失包络与新的报告路径；脚本的 finally 先确认平仓再撤保护。
