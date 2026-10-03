# 预测市场只读连接与 PIT（2026-10-03）

首次验收失败：旧脚本没有给 quote 传 required availableAt，并把网络回补的获知时间写成启动时点。
脚本现分别保存 metadata/series/book 的本机接收时间，quote 仍保留源 observedAt；判定 cutoff 在接收后推进。估计量检查改为与具体 snapshot 的 prob/estimator 逐项比对，并先断言概率跳变分母非空。
不通过修改生产 PIT 门控兼容旧脚本。

真实复验命令：PM_SCAN=20 NODE_USE_ENV_PROXY=1 node scripts/pm-pit-check.mjs 7 <private-report.json>。
[摘要 JSON](pm-pit-connection-2026-10-03.json) 记录 23 个非空市场、14 个信号、14 条非空概率跳变 novelty；HTTP 请求数见 JSON。
真实序列约 29.98 天、95 点；所有 12 项判定通过，存在/结算提前引用、薄流动性 novelty、估计量错配均为 0。
未知 alias 返回 UNCOVERED，热路径 as_of 调用为 0。HTTP 原文与初次失败保留在私有日志目录。

这些数据仅验证读取、PIT、规则和治理；预测市场没有下单工具，不能作为独立开仓理由。
