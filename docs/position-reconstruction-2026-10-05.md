# R4 持仓重建与 paper 价差一致性（2026-10-05）

## 修复

paper 撮合与历史重建曾分别实现均价规则：反向成交超过旧仓位后，两者都会留下旧均价；历史重建还会把未知方向当买入、把负数量取绝对值。新增共同的 `applyPositionFill`，在入场、加仓、减仓、平仓和翻仓中统一数量、均价与已实现价差。翻仓剩余部分以本次实际成交价作为新均价。

缺方向、非正/非有限数量或价格、矛盾旧仓位和计算溢出均拒绝。本地实际成交及非终态累计成交不再用 SQL 默认 buy；paper 在修改订单/现金前校验方向和数量。原有 reduce-only 封顶与唯一 client id 幂等保持生效。

## 验证

- 最初 16 个非空回归全部失败，复现旧行为；原始输出留存。一次中间检查因夹具精确比较 `-0` 与 `0` 失败，改为数值接近后通过。
- 2026-10-05 `pnpm verify`：85 文件 / **1017 测试通过**。串行 coverage 同样通过；全库行 87.78%、分支 77.47%、函数 91.18%、statement 83.72%。新持仓原语 statement/function/branch 均 100%。
- buy 2@100 → sell 3@90 → buy 1@80，paper 与历史重建每步一致；无费用时实际价差为 -10，有费用时再扣每笔实际撮合费用，最终现金权益与 realized PnL 一致。重复 client id 不再记现金或费用。
- 对原 HTX 实盘冒烟库只读复算：2 笔真实 FIL 成交，最终空仓，gross=0.000030000000000018903 USDT，与平仓现金流在按数据规模推导的浮点容差内一致；原 SQLite/WAL/SHM 指纹不变。
- DSH 隔离 paper 真启动、halt/resume、非空 Sub2API 模型目录通过，模型与网络调用 0。

所有判定、输出路径与 hash 见 [JSON](position-reconstruction-2026-10-05.json)。一条命令复现离线行为：

```bash
pnpm vitest run tests/position-reconstruction.test.ts tests/exec-preflight.test.ts
```

真实历史只读复算（要求同一标的、非空且已闭合的 HTX 成交簿）：

```bash
node scripts/position-reconstruction-check.mjs SOURCE.sqlite NEW_PRIVATE_DIRECTORY
```

本次修复没有网络、付费模型或交易动作。历史成交只验证计算，未证明当前 UID 归属、资金费已知或经济效果；生产 funding resolver 与长期验收仍未完成。
