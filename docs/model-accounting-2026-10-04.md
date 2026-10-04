# 模型请求身份与原子记账（2026-10-04）

[判定输出](model-accounting-2026-10-04.json)。复现：`cd dsh-trader && pnpm verify`，82 个文件 / 910 个测试通过。

修复两个真实代码缺口：完整结构化输出缺 usage 时，原先会记为 accounted 并保存 stage；现在记为 unresolved，保留输出、计入保守预留并停止后续阶段/修复请求，跨 SQLite 重启仍阻断。费用聚合、run 计数和模型调用审计原先分别提交；现在在同一 immediate 事务提交，任一步失败全部回滚，已提交的 reservation 留在原处。

每次传输的 `x-client-request-id` 使用持久 callAttemptId；稳定 session/thread/cache cohort 继续共享。随机请求 ID 不进入语义 requestHash。Luna 子代理的通用 provider 修改已整合；已收到的上游 response ID 在断线时通过标准 failure.requestId 保留，审计另存来源/模型、记账日及精确 scopes/账本条目，便于未来凭据核销。

新增 root 5 个回归用例，分别覆盖同 cohort 两次非空请求、完整输出缺 usage 的重启、run 更新失败、审计插入失败及上游 response ID；provider 另增 5 个用例，含真实 DSH stream 的 loopback。没有发送新的付费模型请求，没有核销旧未知账单；外部 usage/billing 核销入口仍待完成。
