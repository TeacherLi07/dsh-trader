# R4 持久 W2/W3 worker 工程验收（2026-09-20）

复现命令：`pnpm build && node scripts/r4-acceptance.mjs docs/r4-trigger-worker-2026-09-20.json`

使用内存 SQLite、ReplayClock 与 stub 决策回调；没有外部模型调用，也不代表交易收益。

- W2 transient failure 持久退避后重试同一触发，最终只完成一次。
- 重启恢复检查最大尝试次数；queued/claimed 过期有持久终态，P0 invalidation 只冻结、不回退到模型。
- 未配置正数日预算时，回调调用数为 0，触发进入可审计的 `failed`。
- claimed 触发重启恢复后保留 attempt 计数；超过 TTL 后进入 `expired`。
- `decision_only` 中，`set_stop` 只可添加安全初始保护；已有远端 stop 不走非原子替换；`set_target` 需远端 stop 仍有效且处于盈利方向；`set_trailing` 需保留有效远端 stop；`cancel_all` 限于当前标的并保留保护，全局撤单 fail-closed。
- 本次样本共 3 条触发，终态分布为 done=1、failed=1、expired=1；队列与审计均非空。

PM W3 另有显式 active-plan 映射及当前 PIT 概率/流动性验收；未映射事件 fail-closed。由于 claim/path 无法证明方向性语义，PM-triggered run 在 R5 验收独立场内 entry gate 前固定为 `decision_only`，不能新增敞口。完整原始输出见 [JSON](./r4-trigger-worker-2026-09-20.json)。
