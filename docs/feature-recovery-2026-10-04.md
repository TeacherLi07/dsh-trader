# 历史bar修订的特征恢复（2026-10-04）

配对[JSON](feature-recovery-2026-10-04.json)保存非空计数、来源哈希、CLI结果与测试范围。

## 操作

先停止对应profile；CLI默认inspect为只读。查看计划后，使用同一个recoveryId重建，再单独确认游标；最后重启profile以加载新的完整增量状态。重建不会自动解除游标隔离。

```bash
node scripts/feature-recovery.mjs <db> <symbol> <timeframe> inspect
node scripts/feature-recovery.mjs <db> <symbol> <timeframe> rebuild <recoveryId> '恢复原因'
node scripts/feature-recovery.mjs <db> <symbol> <timeframe> confirm <recoveryId> '确认跳过历史回调的原因'
```

若历史超过默认20万根，明确设置 `--max-bars=<上限>`；超限、缺口、无效/未来OHLCV或不足暖机窗口均拒绝，不能截断后继续。原始衍生品输入从隔离前的不可变feature观测读取；无法取得则字段仍未知，不伪造零。

输入或结果在重建后变化会拒绝旧确认。只确认隔离边界内的历史待处理bar，新到达bar继续走正常feed。隔离观测不会删除；schema v11的唯一恢复凭据不能删除或改写，只能确认一次。重复操作返回原凭据，CLI同时报告当前isolationActive，新修订不会被旧确认抹去。

## 验证

- 完整 `pnpm verify`：82文件/900测试通过。
- 从真实159根ADA/15m归档复制故障fixture，53根受影响；两阶段审计非空，重复执行不新增，原DB哈希不变。处理游标与修订为标注的工程注入，不冒称真实生产修订。
- 模型/网络/执行回调/新订单意图均0，预算不变；159根成功恢复至重启状态。
- 真子进程完成重建后SIGKILL，重启保留隔离和未确认凭据，重复重建不写入，只有人工确认推进历史游标。
- 1005根跨SQL分页重启，下一根完整特征与不中断计算一致；只回灌50根的EMA50确实不同，因此生产启动改为分页恢复完整已处理前缀。
- 缺口、投影篡改、新修订、空原因、未重建确认及NULL确认原因均拒绝；v10→v11迁移保留原数据，失败操作留下审计。
- 禁网的隔离DSH真启动通过，paper、halt/resume与非空provider注册表通过。

副本验收复现：

```bash
node scripts/feature-recovery-check.mjs <真实来源DB> <新私有输出目录>
```

本轮未对生产DB执行恢复。该入口不处理模型账单未决reservation、不补资金费来源；它们仍在plan §12。
