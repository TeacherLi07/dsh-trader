# R1 schema / DecisionContext 验收

命令：

```bash
cd dsh-trader
pnpm build
node scripts/r1-acceptance.mjs
```

结果：schema/user_version 均为 `5`；`decision_contexts` 能完整 canonical round-trip，重复写入不新增行；`decision_runs` 保存 draft、critique、final、eligibility 及成本未知状态；不存在旧 `context_snapshots` / `workflow_contexts` 表；不存在的 run 外键写入被拒绝。

原始输出见同名 `.json` 文件。
