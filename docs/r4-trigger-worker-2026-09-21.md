# R4 持久触发 worker 工程验收（stub，2026-09-21）

命令：

```bash
cd dsh-trader
pnpm build
node scripts/r4-acceptance.mjs ../docs/r4-trigger-worker-2026-09-21.json
```

判定：脚本断言全部通过。schema v8；3 条触发分别落入 `done=1`、`failed=1`、`expired=1`，无残留 `queued/claimed`；瞬时失败按退避重试同一触发，重启恢复保留 attempt，缺预算在调用决策回调前拒绝，过期事件不再运行；审计事件 5 条。

安全检查：外部模型调用 0，决策回调为本地 stub。此结果只证明持久队列、预算拒绝、重试/恢复与 TTL 工程接线，不证明真实模型质量或经济效果。原始输出见同名 JSON。
