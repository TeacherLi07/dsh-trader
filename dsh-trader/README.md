# dsh-trader

7×24 无人值守 crypto 交易 agent，以 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件包形态运行。

- **可执行计划** → [`../plan.md`](../plan.md)
- **决策与依据（为什么这样做、证据、被否决的选项）** → [`../docs/decision.md`](../docs/decision.md)

> 本项目按 `non-human in the loop`（无人确认）+ `audit-first`（全量可审计）设计。**默认模式是 `paper`**；
> 切到实盘前请先读完 plan.md §6（权限与安全）与 §10（验收）。

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P-1 | 仓库 / 依赖 / profile / 项目根标记 | ✅ 已完成（pnpm 12.4.1；`trade` profile 已创建并挂载） |
| T0.1 | 仓库骨架 + exports + `cordis.patch.yml` + 插件入口 | ✅ 已完成（9 行合成进 `trade`，`--dump-config` exit 0） |
| T0.2 | SQLite schema + 迁移 + `db` 插件 | ✅ 已完成（14 张表；唯一索引/CHECK/append-only 有单测） |
| T0.3 | `clock.ts` + Config + 启动参数校验 | ✅ 已完成（含"禁止直接读墙钟"的 grep 测试） |
| T0.4 | 行情：`market/{normalize,ratelimit,archive,backfill,feed,ccxt-source,runtime}` + 插件接线 | ✅ 已完成（101 单测；HTX 实测 30 天 1h 回补 **719 根全部为已收盘 bar**；代理感知 fetch 见 `applyProxyAwareFetch`） |
| T0.6 | 计划卡 schema + `when` DSL + 求值器 | 🟡 v0 已实现并有单测；`match/store` 待接 |
| §4.4 | 预测市场事件源（Polymarket，**只读**） | 🟡 DDL（4 张表）+ PIT 三道闸门已落地并有单测；client/store/poller/watch/tools 属 T1.8–T1.11 |
| T0.5/T0.7/T0.8/T0.9 | 特征 / 触发 / 执行 / 回放 | ⬜ 未开始 |
| P1（含 T1.8–T1.11）/ P1.5–P4 | 判断、通道闸门、测试网、实盘、离线整合 | ⬜ 未开始 |

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

1. 判断用 LLM，执行用代码；盘中不唤醒 LLM（只有 W1/W2/W3）。
2. 判断只发生在窗口内、敞口打开之前 → 产出计划卡。
3. 止损/止盈走交易所侧条件单或插件硬闸，不依赖 LLM。
4. 权威状态在交易所 + SQLite；context 是可丢弃的视图。
5. 模型输出不得成为决策的唯一真相来源。
6. 硬性风控在代码里，模型没有豁免通道。
7. 新增任何 LLM 调用点，先回答"为什么不能是条件与逻辑"。
