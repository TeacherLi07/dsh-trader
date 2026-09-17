# AGENTS.md

面向**编码 agent**（Codex / Claude Code / Cursor / Jules 等）的仓库说明，格式遵循 [agents.md](https://agents.md/)。
标准 Markdown，无必填字段；就近的 `AGENTS.md` 优先，用户当轮的明确指令覆盖本文件。

> **本文件不进入交易模型的上下文。** 交易运行时的配置（标的池 / 时间框 / 限额 / 基准）在
> `dsh-trader/cordis.patch.yml` 的插件 Config 里，因为那些值需要"可审计、可热改、不当代码常量"
> （见 `plan.md` §6.5）。把构建命令喂给交易模型只是噪声。

## 项目概览

7×24 无人值守 crypto 交易 agent，以 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件包形态运行。

| 位置 | 内容 |
|---|---|
| `plan.md` | **可执行计划**（红线、DSL、DDL、验收判据、WBS、决策记录）——改行为前先读对应章节 |
| `docs/decision.md` | 决策与依据：为什么这样做、被否决的选项、历史证据 |
| `docs/*.md` | 各阶段验收的**实测证据**（每份都配同名 `.json` 原始输出） |
| `dsh-trader/` | 全部代码（src / tests / scripts） |
| `dsh-trader/README.md` | 人类向的状态表与快速开始 |

**当前阶段**：P0 ✅（`tag: phase-p0`）、P1 ✅（`tag: phase-p1`）、P1.5 闸门 ✅、P2 ✅ 代码落地与安全收口（T2.1–T2.9；Docker 单进程重启 + 启动恢复为故障模型；旧 watchdog 证据仅保留归档）。
**下一步**：P3 小额实盘前安全收口 —— HTX key/只读预检/最小额独立冒烟均已完成，`live_auto` 也曾获授权但当前已回退 `paper`。进入连续 P3 前仍需用真 HTX 验证“有持仓 + 算法保护单”的 merged 对账，并补齐 §12.1 #25 的结构化 `live_confirm` 逐单确认通道（未接入前 runtime fail-closed 拒绝该模式）。

**七条红线**（完整版见 `plan.md` §1）：默认 `paper`；硬闸不可绕过；密钥绝不进 prompt；
审计优先（被拒也要落库）；预测市场**只读、永不下单**；时钟必须注入；失败状态逐字保留。

## 环境与命令

所有命令都在 `dsh-trader/` 下执行（除 `dsh` 命令）。

```bash
pnpm install --frozen-lockfile   # 装依赖；首次或换 profile 后需要 pnpm link:peers
pnpm verify                      # ★ 提交前必过：typecheck && build && test
pnpm typecheck                   # tsc -p tsconfig.json && tsc -p tsconfig.test.json
pnpm build                       # 产出 lib/ —— scripts/*.mjs 从 lib/ 导入，改完 src 必须先 build
pnpm test                        # vitest run，当前 60 文件 / 647 测试
pnpm vitest run tests/plan-dsl.test.ts          # 跑单个文件
pnpm vitest run -t "UNCOVERED"                  # 按用例名过滤
pnpm link:peers                  # 把 @deepseek-ai/* 运行时 peer 链进来
dsh --profile probe --dump-config               # 合成配置、验证 patch 行（应列出 11 个 trade-*）
```

### 验收脚本（真实行情 / 真实网络，不进 CI）

```bash
pnpm build
node scripts/client-s0-check.mjs                         # UI S0 client bundle/座位注册探针
node scripts/replay-check.mjs htx BTC/USDT 1h 30     # P0 ②③ 回放确定性
node scripts/probe-check.mjs probe /tmp/probe.json   # P0 ⑤ 探针 resume + notice 落盘
node --expose-gc scripts/soak.mjs 24 60              # P0 ⑥ 24h 稳态
node scripts/p1-acceptance.mjs 30                    # P1 ①–④
node scripts/crash-recovery-check.mjs                # P1 ⑤ 真实 SIGKILL
node scripts/pm-pit-check.mjs 30                     # P1 ⑥ 预测市场专项
node scripts/ab-gate.mjs htx BTC/USDT 1h 92          # P1.5 通道有效性闸门
node scripts/fault-injection.mjs /tmp/p2-fault.json  # P2 ①②④ kill -9×50 / 幂等×10 / 保护单停摆仍生效
node scripts/htx-preflight.mjs htx BTC/USDT:USDT      # HTX 只读对账（需 TRADER_API_KEY/SECRET；不下单）
node scripts/htx-live-smoke.mjs --execute ADA/USDT:USDT  # ★ 真实首单全链路冒烟（下单/保护单/撤单/平仓；带强制清理）
node scripts/live-paper-e2e.mjs 30 ADA/USDT:USDT     # paper 全链路：真实 bar→计划卡→下单+保护单+幂等
node scripts/seed-prices.mjs [dbPath]                # 价目表种子（幂等）
```

判据是"命中行数 = 0""CI 下界 > 0"这类**可计算**的东西。新增行为请优先补一个能一条命令复现的判定，
并把输出留成 `docs/*.md` + `.json`，而不是只在对话里说"已验证"。

## 代码约定

- **TypeScript strict** + `noUncheckedIndexedAccess`；ESM；相对导入**必须带 `.js` 后缀**。
- 注释用**中文**，写**为什么**（尤其是被否决的选项与踩过的坑），不要复述代码在做什么。
- **时钟必须注入**：`src/market/`、`src/predictions/`、`src/trigger/`、`src/supervisor/`、
  `src/exec/gate.ts` 里**禁止** `Date.now()` / `new Date()`；由 `tests/clock-discipline.test.ts` 整目录扫描强制。
  需要"现在"就从 `Clock` 参数拿（`ReplayClock` 让回放可确定性复算）。
- **DB 访问**：走 `src/db/statements.ts` 的 `Statements` 缓存；热路径**禁止**直接 `db.prepare()`
  （实测 5 万次调用累积 +139.5MB；由 `tests/db-discipline.test.ts` 守）。
- **幂等一律靠唯一键**：`ON CONFLICT(...) DO NOTHING`，**不要用 `INSERT OR IGNORE`**
  （它会连 CHECK 违规一起吞掉）。
- **失败要 fail-closed**：DSL 里未知路径 / 未注册 alias 必须让求值返回 `ok:false` → 计 UNCOVERED，
  **绝不静默返回 false 或 0**。"没数据"与"值为 0"必须能区分（缺数据返回 `null`）。
- **schema 改动必须两处同步**：`src/db/schema.ts` 与 `plan.md` §4.1 的 DDL，并在
  `tests/db-schema.test.ts` 的表清单里登记。
- 注释里的反引号：`src/db/schema.ts` 的 DDL 在模板字符串里，**注释中不要用反引号**（会截断字符串）。

## 测试纪律

1. 改行为就加测试，哪怕没人要求。
2. **反空跑**（本项目最贵的一条经验）：断言必须有非空样本。已两次因"0 个样本也通过"而误判：
   结算成功率曾在 **0 条到期决策**上显示 100%；预测市场 novelty 检查曾在 **0 行**上"通过"。
   写法：先断言分母 `> 0`，再断言比率。
3. **幂等测试**：同一输入重复调用只应生效一次（重复回放、重复写入、重复恢复）。
4. **非 vacuity 守卫**：端到端脚本要有"前置条件确实成立"的检查（如 `pm_signals_exercised`、
   `sample_has_real_jump`），否则验收会随行情飘。
5. 阈值**从数据推导**，不要写死（写死的 3% 曾让同一脚本几小时内 true→false）。

## 安全纪律

- **密钥只从环境读**：`cordis.patch.yml` 里用 `!!js process.env.TRADER_API_KEY`；插件只输出
  "已注入/未注入"布尔，**永不打印、永不落库、永不进 prompt**。
- HTX API key 权限最小化：只开**交易**，**禁用提现**，绑 IP；`paper` 与 `live` 用不同 profile。
- **预测市场没有任何下单工具**，且不得作为开仓的唯一理由（`isTradeTrigger` 写死 `false`）。
- **硬闸不可绕过**：模型只提议，`gate` 裁决；每个交易工具内部还要**二次校验**。
- **审计优先**：被拒的意图、被限流的触发、失败的恢复都要落库，不能"擦掉失败"。

## 提交与交付

- **trunk-based**：直接提交到 `main`，一次提交 = 一个 WBS 任务。
- 提交信息用 **conventional commits 且带任务 ID**，例如：
  `feat(predictions): T1.10 pm 规则族 + 走同一套触发治理（专项 ④）`。
  正文写"做了什么 / 为什么 / 验证方式"，把发现的真问题写清楚（含实测数字）。
- 提交前 `pnpm verify` 必须绿；**阶段完成打 annotated tag**（`phase-p0`、`phase-p1`）。
- 需要人决定或需要凭据的事，写进 `plan.md` §12 并**显式报告为阻塞项**，不要假装完成。

## 外部数据源的坑（全部为实测结论，别再踩）

| 坑 | 事实 | 处理 |
|---|---|---|
| ccxt 不读代理环境变量 | 有 `HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY=1` 时，ccxt 自带 fetch 仍 `ECONNREFUSED` | 必须 `applyProxyAwareFetch(exchange)`（`createMarketRuntime` 已默认启用） |
| ccxt 私有端点要**实例级凭据**，字段名是 `secret` | 只把 key 传给自己的 broker 类没用；写成 `apiSecret` 也不是 ccxt 的字段。实测 HTX 先后报 `requires "apiKey" credential`、`requires "secret" credential` | `CcxtBroker` 构造时回填 `exchange.apiKey` / `exchange.secret`；哑值真打一次确认拿到 `api-signature-not-valid`（见 `docs/htx-credentials.md`） |
| Gamma 数值字段是**字符串** | `liquidity: "904179.3825"` | 归一化要接受数字字符串，优先 `liquidityNum`/`volumeNum`；不可解析返回 `null` |
| 时间戳单位**因端点而异** | `clob/book` 的 `timestamp` 是**毫秒**；`prices-history` 的 `t`/`timestamp` 是**秒** | 用 `normalizeSourceMillis` / `normalizeSourceSeconds`，两个方向都判错 |
| `prices-history` 的 `market=` | 必须是 **CLOB token id**；传 `conditionId` 返回 **200 + 空序列**（静默骗人） | `assertTokenId()` 直接拒非十进制 token id |
| pm `interval` 白名单 | `1d`/`1w`/`1m`(30 天) 可用；`1h` 空；`max` 行为不一致 | 未验证取值一律拒绝 |
| market 文本不可信 | `question`/`description` 由市场创建者书写 | 按数据注入并标注 `untrustedText`，**不参与工具授权** |
| HTX 无 sandbox | ccxt 里 HTX 没有 sandbox 端点，OKX 有 | P2 破坏性测试走 OKX sandbox 或纯 `paper`（`plan.md` §12.2 B） |
| HTX 现货与 USDT 永续是**两个账户** | `fetchBalance()` 默认读现货；跑 `BTC/USDT:USDT` 时现货通常为 0 ⇒ 系统"以为没钱"，sizing 推出 qty=0 | 显式 `accountType: swap`（`fetchBalance({type})` + exchange `defaultType`）；实测同一 key 现货 0 / swap 24.914 |
| 永续的 `amount`/`contracts` 是**张数** | ccxt 合约的 `createOrder` 与 `fetchPositions` 都用张数；直接传基础币会差一个 `contractSize`（BTC 1000×、ADA 10×） | `CcxtBroker` 按 `contractSize` 换算并用 `amountToPrecision` 对齐；inverse 直接拒绝 |
| cordis 的 `ctx.X` 必须已声明 | 读未注册的 `ctx.tradePorts` 会抛 `cannot get property "tradePorts" without inject`，**整个 plugin tree 加载失败**（单测测不到） | 插件间用模块级注册表（`getExecPorts()`）或 `inject`；改完必须真启动一次 `dsh --profile trade` |
| `everyMs` 窗口的游标语义 | `dueWindows(specs, since, now)` 从 `since` 起算下一发；调用方若每轮把 `since` 跟到 `now`，窗口**永不触发**（实测 W1 11 分钟没动） | 只在**触发后**把游标推进到 `fireTs`（`tests/supervisor-windows.test.ts` 同时钉住错/对两种用法） |
| `ctx.agents.create` 必须给 `meta.cwd` | 缺 cwd 时系统提示的 persona-suffix 段 `{{cwd}}` 无值，回合在模型调用前抛错；错误被 agent-loop 的 `kick()` 吞掉，只表现为"6ms、无 assistant/message" | create 传 `meta: { cwd }`（resume 沿用会话持久化的 cwd）；并显式监听 `agent/error` 落审计 |
| HTX 市价单 `createOrder` **不回填成交** | 响应是 open/new（`state:'acked'`），而 execute-action 只在 `filled` 时记 fill/登记结算/挂保护单 ⇒ 真实成交被当没成交 | 下单后有界轮询 `fetchOrder` 回填（`CcxtBroker.#awaitFill`，默认 6×700ms，可配） |
| HTX 算法保护单（sl/tp）三件套 | ① 必须带 `position_side`（否则 code 1067，保护单永远挂不上）；② 不在普通 `fetchOpenOrders` 里，撤单也要 `stopLossTakeProfit`/`trigger`/`trailing` 标志；③ 实测 `client_order_id` 由交易所生成=订单号，**不采用我们传的 id** | `positionSide`（默认 both）+ `#fetchOpenOrdersMerged()` + `cancelOrder` 逐个标志尝试；恢复对"未 ack 意图"只能判 unknown+冻结（fail-closed） |
| 免费 ccxt 无 WS | `has.watchOHLCV === undefined` | v0/v1 只用 REST 轮询（分钟级足够） |

## 常见改动落点

| 想做的事 | 改哪里 |
|---|---|
| 加 DSL 算子 / 路径 | `src/plan/dsl.ts` + `evaluate.ts`（`V0_ALLOWED_PATHS` / `UNIMPLEMENTED_PATHS`）+ `tests/dsl.test.ts` |
| 加交易工具 | `src/agents/tools.ts`（定义 + `TOOL_DEFINITIONS`）+ `src/agents/roles.ts` 白名单 + `SIDE_EFFECT_TOOLS` |
| 加表 / 列 | `src/db/schema.ts` + `plan.md` §4.1 + `tests/db-schema.test.ts` 表清单 |
| 加触发规则族 | `src/trigger/engine.ts` 的 `RULE_PACKS` + `cordis.patch.yml` 的 `rulePacks` |
| 预测市场（只读） | `src/predictions/{client,store,poller,rules,wiring}.ts` |
| 结算 / 反思 | `src/memory/{settle,recall}.ts` |
| 崩溃恢复 | `src/exec/recovery.ts` + `scripts/crash-recovery-check.mjs` |
| 每轮运营指标 | `src/supervisor/metrics.ts` |
| 加验收脚本 | `scripts/*.mjs`，并留 `docs/*.md` + 同名 `.json` 证据 |

## 诚实清单：已知未实现

写代码时**不要**注册"调用即抛错"的占位工具或空实现来让表格好看；缺口要如实报告。

- **6 个工具未实现**（`missingTools()` 会打印）：`trade_derivatives`、`trade_news`、`trade_onchain`、
  `trade_stress_test`、`trade_review`、`trade_playbook_update`。`trade_workflow_run` 已由 T2.9
  固化接线（子 agent 使用结构化输出与零工具面）。
  （`trade_regime` 已由 T2.5 实现。）
- **0 个指标路径未实现**：`UNIMPLEMENTED_PATHS` 现为空 —— T2.4 已补齐 `adx14`、`oi.changePct`、
  `liq.notional`、`funding.rate`、`basis.bps`，全部移入 `V0_ALLOWED_PATHS`（`plan.md` §12.1 #16）。
- **P3–P4 未做**：周级复盘/playbook/M3 版本化。`live_auto` 已按用户授权 arm，无人值守回路
  **已跑通到决策**（W1→desk 回合→工具调用→`no_trade`/计划卡）；首单取决于模型是否判出机会。
- **P2 的剩余外部依赖**：真 HTX“有持仓 + 算法保护单”的 merged 对账（`CcxtBroker` 代码已就绪、单测覆盖；需用已有 key 做非空实测）；结构化 `live_confirm` 逐单确认通道仍未接入。
  P2 ①②④ 已用持久化模拟 venue 验证（`docs/p2-fault-injection-2026-09-15.md`）；旧 watchdog 结果仅作历史归档，当前不启动外部进程。
- **宏观事件窗口不是硬闸（暂不启用）**：`GatePolicy.tradingWindowOpen` 可选，调用方不传即不拦截；
  宏观风险只写进 `news` 分析师的提示词提醒（软判断，主动权在 agent）。**不要**再塞一个恒真/恒假的开关
  假装有这条风控；接入日历前请先读 `plan.md` §12.1 #22 的推翻条件。
- **待外部输入**（`plan.md` §12.2）：OKX demo key 可选；模型凭据（P1.5 的 LLM 判断臂）；
  A/B 触发密度（92 天仅 16 次触发，需 `--preset high-freq`）。真 HTX merged 对账使用已确认的现有 key，不再是凭据阻塞。

## 文档维护

`plan.md` 是**活文档**：任务完成后在该行标 ✅，决策变化写进 §12（含推翻条件），
新踩的坑写进本文件的坑表。**不要**在代码注释、`README.md`、本文件三处重复同一段解释 ——
选一处（通常是 `plan.md` 或 `docs/decision.md`），其余用链接指过去。
