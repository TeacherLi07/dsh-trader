# dsh-trader

7×24 无人值守 crypto 交易 agent，以 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件包形态运行。

- **可执行计划** → [`../plan.md`](../plan.md)
- **决策与依据（为什么这样做、证据、被否决的选项）** → [`../docs/decision.md`](../docs/decision.md)

> 本项目按 `non-human in the loop`（无人确认）+ `audit-first`（全量可审计）设计。**默认模式是 `paper`**；
> 切到实盘前请先读完 plan.md §1（硬边界）、§6（判断资格）、§8（模式）与 §10（验收）。

## 状态

历史阶段的完成记录不代表新判断链已完成；当前实现缺口与目标以 [plan.md §0](../plan.md#0-目标与当前状态) 为准。

| 阶段 | 内容 | 状态 |
|---|---|---|
| P-1 | 仓库 / 依赖 / profile / 项目根标记 | ✅ 已完成（pnpm 12.4.1；`trade` profile 已创建并挂载） |
| T0.1 | 仓库骨架 + exports + `cordis.patch.yml` + 插件入口 | ✅ 已完成（9 行合成进 `trade`，`--dump-config` exit 0） |
| T0.2 | SQLite schema + 迁移 + `db` 插件 | ✅ 已完成（14 张表；唯一索引/CHECK/append-only 有单测） |
| T0.3 | `clock.ts` + Config + 启动参数校验 | ✅ 已完成（含"禁止直接读墙钟"的 grep 测试） |
| T0.4 | 行情：`market/{normalize,ratelimit,archive,backfill,feed,ccxt-source,runtime}` + 插件接线 | ✅ 已完成（101 单测；HTX 实测 30 天 1h 回补 **719 根全部为已收盘 bar**；代理感知 fetch 见 `applyProxyAwareFetch`） |
| T0.5 | 特征层：`market/{indicators,features,feature-archive}` + 重启回灌 | ✅ 已完成（增量实现与全量重算**逐点严格相等**；130 单测；HTX 实测 719 根真实 bar 跑出完整快照） |
| T0.6 | 计划卡 schema + `when` DSL + 求值器 + `match` + `store` | ✅ 已完成（DSL 每算子/每错误分支有单测；计划卡不可事后改写、每标的一张 active、UNCOVERED 可达） |
| §4.4 | 预测市场事件源（Polymarket，**只读**） | ✅ 已完成（client/store/poller/watch/rules；W3 只接受 active-plan 映射与当前 PIT 快照；PM-triggered run 在 R5 独立场内 entry gate 验收前不新增敞口；无模型下单工具；专项 ①–⑧ 见 `../docs/pm-pit-acceptance-2026-09-14.md`） |
| T0.7 | 规则引擎 + 触发治理（去重/冷却/限流/分级 + `TriggerQueue`） | ✅ 已完成（同一 bar 回放两遍**零重复触发**由 `dedup_key` 唯一键保证；内置 2 个只使用已实现指标的规则包） |
| T0.8a | 纸面撮合 `exec/paper` + 对账 `exec/reconcile` | ✅ 已完成（滑点/手续费、`clientOrderId` 幂等、保护单为挂单；对账纯函数覆盖孤儿单/未知持仓/无保护单） |
| T0.8b | 确定性回放 `exec/replay` + `sizing` + `journal` | ✅ 已完成（P0 验收 ②③ 通过：真实 HTX 30 天 719 根回放两遍 id 集合完全相等、`client_order_id` 重复数 = 0、命中全部可归因） |
| T0.9 | 闭环探针 + R5 压测 | ✅ 已完成（`scripts/probe-check.mjs`：第一遍 create、第二遍 **resume**，且注入消息在 session 日志里落盘为 `form: 'notice'`；`scripts/soak.mjs`：24h 稳态 +2.73%、fd 波动 0、WAL 有界）|
| — | **P0 验收**：plan §10 六条全部通过 | ✅ `tag: phase-p0` |
| T1.1 | 判断流程：冻结 pack + workflow 脚本 + 角色提示词 | ✅ 历史验收完成；旧 JudgmentPack/多分析师链已在 R3 删除 |
| T1.2 | 角色工具箱与模型路由 `agents/roles.ts` | ✅ 历史验收完成；固定角色与工具 roster 已在 R3 删除 |
| T1.3 | 交易工具 `agents/tools.ts`（14 个，含 propose/execute） | ✅ 历史验收完成；旧模型副作用工具链已在 R3 删除，执行只保留 `execute-action` |
| T1.4–T1.11 | 结算/反思、context 组装、预算账本、P1.5 闸门、预测市场（§4.4） | ✅ 已完成（`tag: phase-p1`；证据见 `../docs/p1-acceptance-2026-09-14.md`、`../docs/pm-pit-acceptance-2026-09-14.md`、`../docs/p1.5-gate-run-2026-09-14.md`） |
| — | **P1 验收 + P1.5 通道闸门**（§10 P1 ①–⑥；当时判定关闭 W2/W3） | ✅ `tag: phase-p1`；R4 后 W2/W3 已接线，但预算未配置时仍 fail-closed |
| T2.1 | `CcxtBroker`（HTX 优先、venue-agnostic、OKX sandbox）+ 真实 `getOpenOrders`/`findOrderByClientOrderId` | ✅ 真 HTX 只读预检与最小额独立冒烟已通过；普通/算法单合并计数与撤单已补测；进 P3 前仍需真 HTX “有持仓 + 保护单”对账验证 |
| T2.2 | 对账 runner + Docker 重启后的启动恢复 + `/halt` `/resume` | ✅ 单进程模型：dsh 退出由 Docker 重启；启动先跑 CrashRecovery 再做对账；持久化 `halted` 已接入新增敞口硬闸，`/resume` 不清对账冻结；旧 watchdog 验收仅归档 |
| T2.3 | 故障注入：`kill -9`×50 / 幂等提交×10 / 保护单停摆仍生效 | ✅ P2 ①②④ 全通过：`../docs/p2-fault-injection-2026-09-15.md` |
| T2.4 | 内核指标补全：`adx14` + `funding.rate`/`oi.changePct`/`liq.notional`/`basis.bps` | ✅ 增量=全量（ADX 对拍 92 样本）；单位口径有测试；`UNIMPLEMENTED_PATHS` 清空 |
| T2.5 | `regime` 分桶（§12 #2）+ `trade_regime` 工具 | ✅ 分位定义可复现；样本 < 30 一律 `ok:false` |
| T2.6 | §12 已决小项：#5 提示词版本并入 C1、#12 negRisk 只校验、#17 启动自洽、#18 视界按 tf、#19 价目表年龄 | ✅ 每项一个单测 |
| T2.7 | 结构化证据账本 + 有限 Bull/Bear + 单一 `RiskCritic` | ✅ 数字/路径/contextHash 由代码校验；无效工件不进下一阶段；三风险人格已移除 |
| T2.8 | 真实 agent 运行时权限收窄 | ✅ create/resume 共用 scoped restrict；judge 无 `trade_execute_order`，只读角色无副作用工具 |
| T2.9 | 固化判断 workflow `trade_workflow_run` | ✅ 已接线（代码组装 pack、固定脚本；spawn child 只允许 `structured_output`，结果/失败均落审计） |
| R1 | schema v5 + `DecisionContext` / decision run 存储根 | ✅ canonical context 与 draft/critique/final/eligibility 已落库；旧 snapshot/token 表已移除；验收见 `scripts/r1-acceptance.mjs` |
| R2 | 有界 `DecisionContext` 与请求渲染 | ✅ schema v6 双时间归档（当前 schema v8）；固定 PIT fixture 的 context/request 为 107,128 / 119,243 字符，request 上限 180,000，UTF-8 输入预算保守上界 123,751 tokens；非空样本含行情、benchmark、衍生品、组合/保护、计划与 outcome；缺失/过期/暖机、PIT、脱敏和超长拒发均通过；复验见 `../docs/r2-decision-context-2026-09-21.md`。只捕获请求，未调用模型 |
| R3 | DecisionEnvelope 判断链 | ✅ single/critique、evidence/eligibility、成本入账和单一执行入口；`trade-supervisor.decisionStrategy` 默认 `critique`，可切回 `single`；付费对照未执行，不代表效果差异；stub 工程证据见 `../docs/r3-decision-envelope-2026-09-21.md`（外部模型调用 0） |
| R4 | 即时动作与 W2/W3 持久 worker | ✅ 去重、限频、预算、退避重试、重启恢复、TTL 与 PM 只读映射；结算对未知成本 fail-closed，但生产 funding resolver 尚未接入，经济验收仍受阻；PM-triggered 开仓仍 fail-closed，待 R5 独立场内 gate；stub 工程证据见 `../docs/r4-trigger-worker-2026-09-21.md`（外部模型调用 0） |
| R5 | 真实 critique 与 forward-paper 效果验收 | ⬜ 负责人选择 critique，付费 single/critique 对照取消；静态 runner 与离线护栏保留但未执行。仍缺预算授权后的 critique 真实运行、≥50 个非空执行链样本、独立 forward-paper 经济证据和 funding resolver；选择不代表相对 single 的效果结论。说明见 [`docs/r5-runner.md`](../docs/r5-runner.md)，lesson 默认关闭 |
| R6 / P3 | 小额实盘 | ⬜ 当前为 `paper`；R5 两道验收通过且完成真 HTX “有持仓 + 保护单”对账后，需同时设置 `TRADER_MODE=live_auto`、独立 `TRADER_LIVE_ARMED=1`、两项凭据及全部非空限额；缺凭据不降级；逐单 `live_confirm` 与自进化不在当前架构 |

## 开发

前置：`pnpm` 在 PATH 上（`dsh plugin` 只是 pnpm 转发器）：`corepack enable pnpm`。

```bash
pnpm install          # 依赖；better-sqlite3 是原生模块，构建许可见 pnpm-workspace.yaml
pnpm link:peers       # 可选：把 DSH 的 @deepseek-ai/* 软链进 node_modules（编辑器/单测用）
pnpm typecheck        # src + tests 全量类型检查
pnpm test             # vitest
pnpm build            # tsc → lib/
```

### `@deepseek-ai/*` 的处理方式（不要改）

这些包是本包的 **peerDependencies**，由 DSH 运行时提供。本地开发期需要它们做类型检查，但
**不能**用 pnpm 安装：

- 公共 registry 上的同名包是**无关的旧版本**（如 `@deepseek-ai/dsh-tools@0.0.1-rc.1`，而本机是 `0.1.5-rc.2`）；
- 用 `link:` 指向 `$DSH_HOME/profiles/node_modules` 会因 pnpm 创建 bin shim 时 chmod DSH 自己的文件而失败
  （`ERR_PNPM_CMD_SHIM_CHMOD`）。

因此采用**解析器级**方案：`tsconfig.json` 的 `paths`（类型检查/构建）+ `vitest.config.ts` 的 alias
（单测）+ 可选的 `pnpm link:peers` 软链（编辑器跳转）。位置可用 `DSH_PROFILE_SCOPE` 覆盖。

## 挂载到 DSH

```bash
# 1) 创建 trade profile（本机没有 `dsh profile` 子命令，用 --from-default-profile）
dsh --profile trade --from-default-profile web --dump-config

# 2) 装包即挂载：package.json 里的 dsh.bundle.patch 会自动进入 profile 的 bundles 层栈
dsh plugin --profile trade add /workspace/dsh-trader

# 3) 离线校验插件树（不启动）
dsh --profile trade --dump-config
```

## 目录

```
src/
├── index.ts          插件包元信息
├── config.ts         运行模式、风控限额、启动参数校验（缺省即拒绝启动）
├── clock.ts          Clock 接口 + SystemClock / ReplayClock（回放确定性的前提）
├── cost.ts           自建价目表与预算（DeepSeek 无价格表）
├── db/schema.ts      §4.1 的 DDL（权威状态）
├── plan/             计划卡：schema / when DSL / 求值 / 匹配 / 存储
├── exec/             broker 接口、硬闸 gate、paper/ccxt/reconcile
├── market/           行情、归档、特征、规则（纯函数）
├── trigger/          去重 / 冷却 / 限流 / 分级 + 持久队列
├── memory/           情节记忆、journal、检索、结算
├── agents/           角色提示词与工具白名单
├── supervisor/       desk 会话调度 + 心跳
└── plugins/          cordis 插件入口（被 cordis.patch.yml 逐行挂载）
```

## 红线（摘自 plan.md §1）

1. 判断用 LLM，执行用代码；LLM 由 W1/W2/W3 驱动，不逐 bar 调用。
2. 判断可提议即时动作或未来计划；执行均需通过资格检查与实时硬闸。
3. 止损/止盈走交易所侧条件单或插件硬闸，不依赖 LLM。
4. 权威状态在交易所 + SQLite；context 是可丢弃的视图。
5. 模型输出不得成为决策的唯一真相来源。
6. 硬性风控在代码里，模型没有豁免通道。
7. 新增任何 LLM 调用点，先回答"为什么不能是条件与逻辑"。
