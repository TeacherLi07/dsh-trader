# R4 执行账户来源与资金费范围（2026-10-04）

## 实现

HTX live 启动通过同一 exchange 实例的已注入凭据，只读获取 UID，计算固定 `swap/multi_asset/cross/USDT` 范围指纹。UID 和密钥不落库、不进模型上下文；凭据在请求前后变化会拒绝旧账户响应。余额显式使用 multiAssetMode，主单与保护单显式 cross，读取持仓与挂单保留全部返回行并验证原生 margin_mode，不筛掉其他模式。

schema v13 在 `order_intents` 增加 nullable `account_scope_hash`，用单行不可变 `execution_scope_binding` 固定数据库账户。paper 首次生成独立 namespace，重启沿用；不同数据库/账户/模式隔离。agent、机械执行、保护与恢复共用 journal 写入入口，新意图继承范围。成交暴露 decision ownership 与账户指纹；幂等 ID 碰撞、历史 NULL、不同账户来源均拒绝混合。

根 agent 补齐子代理未覆盖的本地持仓镜像与风险统计检查，防止历史不同账户成交净额抵消或旧收益归入当前风险。非终态累计成交也检查来源。旧行迁移保持 NULL，**不会根据当前凭据回填历史账户**；旧库无法证明来源时冻结，后续运行应使用独立数据库并保留旧证据。

## 验证

- `pnpm verify`：84 文件 / 984 测试通过。账户原语 statement/function/branch 均 100%；全库行 87.77%、分支 77.37%、函数 91.18%、statement 83.70%。
- 非空夹具验证 scope 迁移、paper 重启/独立 DB、不同 UID、凭据在途变更、ID 碰撞、旧 NULL 成交、镜像部分成交与实际亏损风险来源；旧恢复意图不向当前账户查询。
- `node scripts/offline-startup-check.mjs`：真实隔离 DSH paper 启动、halt/resume 和 Sub2API 非空模型目录通过；模型调用与网络尝试均 0。
- 指定 `host.docker.internal:7890` 代理下，最新生产 runtime 两次启动/重启一致：UID 读取 2 次，68 次 GET，权益均 24.904121200514755 USDT，挂单/冻结/本地订单/交易尝试均 0。私有合约读取全部 V5，身份使用只读 spot V2，行情 metadata 保留 CCXT 公共端点。
- 更新后的资金费读取器得到相同账户范围；真实支付 0 行，`knownDecisionFundingCost=false`。这仍不证明已知零资金费。
- `/workspace/dsh-trader/.env` 与 `~/.dsh/.env` 四项凭据均存在且相等，检查只输出布尔。

原始输出、hash、私有目录与可计算判定见 [JSON](execution-account-scope-2026-10-04.json)。只读复现命令（需事先注入凭据与启动时代理环境）：

```bash
node scripts/execution-account-scope-check.mjs /path/to/new-private-directory
```

## 留存的失败与范围

Luna 独立 worktree 工作因 teacherli 503 中断，request id 保留；根 agent 接手完成，没有重启同轮付费工作。未完成夹具有两处类型错误、9 个 targeted 失败，以及一次算法订单夹具缺 margin_mode，均留存。首次只读命令在 Node 启动后才设置代理，UID 查询失败；改为启动时注入指定代理后成功，不把首次结果归因为 HTX 白名单错误。

一次将 build 与 coverage 并发导致缺 `lib/cost.js`、两个 SIGKILL 夹具超时；完整失败输出保留，串行 coverage 984 测试通过。本任务新增付费模型请求 0，交易请求 0。

本次完成账户来源基础。生产 `FundingCostResolver` 仍未接通，真实 funding 收支、assessment/发布时间、留存覆盖和决策数量归因仍需验证；经济验收与 R6 长期观察未完成，默认 paper。
