# 基于 DSH 构建全自动 Crypto 交易 Agent —— 决策与依据记录

> **本文是 rationale / 证据 / 被否决选项的记录，不是施工图。可执行计划见 [`plan.md`](../plan.md)。**
> 原文件名 `docs/dsh-crypto-trading-agent-plan.md`；§0–§16 保留历史依据，不代表当前实现或授权边界。
> 实现时包名与目录定为 **`dsh-trader`**（见 `/workspace/dsh-trader/`）；本文中出现的 `dsh-trading-agents` 为历史名称。
> 架构审议见 [§17（2026-09-19）](#architecture-review-2026-09-19)；当前运行模式与 arm 边界以 [§21（2026-09-20）](#21-2026-09-20-删除-live_confirm-并强制-live_auto-arm) 和 `plan.md` 为准。旧文中的固定多角色、持久 desk、
> waiver 和“反思让模型越做越准”等表述，按当前 `plan.md` 的范围与验收解释。

> 参考项目：[TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)（LangGraph 多智能体交易框架）
> 目标平台：DeepSeek Harness（本文所有 DSH 结论均来自本机安装包 `@deepseek-ai/dsh@0.1.5-rc.x` 的源码与 README 实测，非推测）

---

## 0. 结论先行（TL;DR）

1. **判断与执行必须分离（最重要的一条）**：真实交易员**绝大多数时间不在盯盘**。盘中"盯"是**条件与逻辑**，不是智能；智能只出现在**三个边界时刻**——审议窗前的判断、计划外的重大新信息、收盘后的复盘。因此 **LLM 调用次数由"审议窗频率"决定（每天几次），不由"市场波动"决定（每天上万次）**。见 §4.3 / §4.5 / §6.2。
2. **把判断前置成「计划卡」**：每次审议窗必须产出**可被代码逐条执行**的计划卡——论点 + **代码可判定的失效条件** + **数值化的 if-then 承诺**（仓位用公式、止损用表达式）。盘中规则命中时，代码先在计划卡里找承诺并**直接执行（零 token）**；**只有计划未覆盖时才唤醒 LLM**。见 §4.4。
3. **Context 完全自管：Context 是视图，不是仓库**。交易的权威状态在 DB 与交易所；上下文是临时组装的视图。**能否安全丢弃，取决于能否从权威源无损重建**——能重建的随便丢，不能重建的一个字都不丢。**模型的输出（摘要/反思/笔记）绝不允许成为决策的唯一真相来源**。见 §7.1–§7.4。
4. **插件形态**：做成**一个** npm 包 `dsh-trading-agents`，在 `package.json` 声明 `dsh.bundle.patch`，用一份 `cordis.patch.yml` 一次性挂载全部行。`dsh plugin --profile trade add <包>` 会自动把它并入 profile 的 bundles 层栈（注意本机**尚未安装 pnpm**）。见 §2.1 / §11。
5. **循环的导线是 `agent.followup()`**：DSH 里每次判断是一个持久化 agent session，循环由**插件常驻服务**驱动；**盯盘不能用 `dsh-schedule`/`dsh-jobs-local`**（会话内/进程内，前者要活着的 root agent、后者随进程死亡），必须是插件自己的常驻服务 + 自己的 SQLite。见 §5.2 / §6.1。
6. **多智能体只用于"只回答"，不用于"会行动"**：并行分析师必须共用**同一份冻结的 context pack**（否则互相冲突的隐含假设）；辩论角色只产出论证、**没有任何副作用工具**；**最终下单必须由唯一裁决者看到全部材料后串行执行**。见 §5.3。
7. **目标形态是 `non-human in the loop`（无人确认）+ 全量可审计**：不硬性要求人在特定时间审核，**确认换审计** —— 因此历史必须完整到"任意时点可重建当时可见的信息"。风控参数**在启动时由用户提供**（可明确放弃，风险自负），**不是代码常量**。见 §9.1 / §14.3。
8. **交易层走 CCXT，先接 HTX**：止损/止盈/追踪止损**直接下成交易所侧条件单**（进程崩溃也生效），幂等靠 `clientOrderId`。**启动时按 `has`/`features` 做能力自检**，不假设"统一符号=统一能力"。见 §8.1 / §8.2。
9. **Agent 的代码执行能力 = 无限可扩展的指标层**：预置指标保证速度与可回测性，**现场写代码**保证开放性（交易所不会默认提供决策真正依赖的所有指标）。跨语言可行（CCXT 支持 7 种语言），但**不要用跨语言链路做高频路径**。见 §8.5。
10. **最大风险不在 AI，在交易工程**：幂等下单、启动对账、心跳熔断、密钥隔离、模拟盘先行。这些必须在 P0/P1 就写好，而不是"以后加"。

---

## 1. 先说清楚：这个系统的真实约束

| 约束 | 含义 | 对设计的强制要求 |
|---|---|---|
| 市场 7×24 无收盘 | 没有"收盘后跑一次"的天然节拍 | 循环节拍必须自己造：bar close + 事件触发 |
| LLM 慢且贵 | 一次完整辩论图 = 数十次模型调用、分钟级延迟、可观测成本 | **判断与执行分离**：盘中纯代码，LLM 只在审议窗口与逃逸通道出现（§4.5、§6.2） |
| 行情数据量极大 | 1s K 线一天 86400 根 × N 标的 | 数据落库/环形缓冲，**绝不进 prompt** |
| 钱是真的 | 幻觉/重复下单/超时都会造成真实损失 | 执行层与 LLM 层之间必须有确定性硬闸 |
| 进程会崩 | 长跑进程必然重启 | 所有状态可重建；下单幂等；启动即对账 |
| 结论会被自己强化 | 记忆注入有确认偏误风险 | 记忆写入需要"结果结算"才生效（见 §7.3） |

---

## 2. DSH 能力盘点（已在本机验证，附证据位置）

以下全部来自 `/usr/local/lib/node_modules/@deepseek-ai/dsh/`（下称 `$DSH`）与 `$DSH_HOME=/home/ubuntu/.dsh`。

### 2.1 Profile / Bundle / Patch —— 插件分发机制

- Profile 目录（如 `$DSH_HOME/profiles/web/`）含 `package.json` 与 `cordis.patch.yml`，其 `package.json` 的 `dsh.profile.bundles` 是**有序的插件包层栈**，`patchReload: live` 支持热加载补丁。
- 组合顺序：各 bundle 的 patch → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`。
- Patch 是 YAML 数组，支持 `insert:`（按 id 插入行）、按 id 覆盖 config、`disabled: true`；`config` 是**整行替换而非深合并**（`dsh-base/cordis.patch.yml` 顶部注释明确说明）。
- **关键机制**：`$DSH/lib/plugin-Ddi42qoW.js` 的 `reconcilePlugins()` —— `dsh plugin --profile <p> add <pkg>` 本质是**pnpm 转发器 + 协调器**：在 `$DSH_HOME/profiles/<p>/` 下执行 pnpm 安装，成功后扫描已安装依赖，**凡是 package.json 声明了 `dsh.bundle.patch` 的包自动加入 `dsh.profile.bundles`**；未声明的只告警。所以"装包即挂载"。它**从不修改** `cordis.patch.yml`，只改 profile `package.json` 的 bundles 数组。
- 校验手段：`dsh --profile <p> --dump-config` 可在**不启动**的情况下打印合成后的完整插件树（本机实测通过）。
- **本项目只适配 DeepSeek**：缓存默认开启、自动命中，**无价格表、无显式 TTL**。因此**不要**在计划里做缓存成本优化，也**不要**照搬其他供应商的 TTL / 写溢价 / 最小可缓存长度那类调优 —— 那是无用的复杂度（详见 §7.8）。
- patch 行里的 `config` 支持 `!!js` 表达式（读 `process.env`、`dshHomePath('...')`），可用于注入密钥与数据目录路径。
- **⚠️ 两个必须记住的 patch 语义**（`cordis-plugin-include` 实现细节）：
  1. **`name` 在 patch 行里是"校验卫兵"，不是"挂载"** —— 新增插件必须写成 `- insert: [...]`；只写 `- id: x` + `name: y` 只在 id 已存在时按 id 覆盖（名字不符会告警跳过）。
  2. 命不中任何行的 patch **只告警不报错**；空的/comments-only 的 `cordis.patch.yml` 会**导致启动失败**，禁用该层要写 `[]`；重复 entry id 是致命错误。
- **⚠️ 本机未安装 pnpm**（实测 `dsh plugin ... --help` 返回 exit 127 并提示 `pnpm not found on PATH`）。走"装包即挂载"路线前必须先装 pnpm；否则退化为手工安装 + 手工把包名加进 `dsh.profile.bundles`。
- **插件侧只有两个 `dsh` 字段被运行时真正识别**：`dsh.bundle.patch`（自挂载成 profile 层）与 `dsh.client`（Web 客户端模块）。`dsh.profile` 只在 **profile 目录**的 manifest 里生效；`dsh.configTrees` 在本安装中**没有运行时读取方**（不需要依赖它）。

### 2.2 Agent 循环与可挂钩点（这是"造循环"的全部材料）

来自 `$DSH/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` 与 `dsh-agent-loop` README：

| 事件 / 瀑布 | 模式 | 能做什么 |
|---|---|---|
| `agent/created` | emit | 新 agent 发布：安装 per-agent 工具、启动 per-agent 运行时 |
| `agent/pre-step` | **waterfall（可拒绝/可替换消息）** | 在每步前注入最新状态、拒绝某些步、改写进入本步的消息 |
| `agent/request` | **waterfall（可替换调用配置）** | 按场景切模型/路由（轻量 vs 深度） |
| `agent/request-error` | waterfall | 自行接管重试策略 |
| `agent/status` | emit | `idle ⇄ running`：调度时机 |
| `agent/session-start` | emit | `source: startup｜resume｜clear｜compact` —— 知道本次是冷启动还是恢复 |
| `agent/turn-stopping` | serial | 回合收尾落库；若要"数据决定继续"，在此调 `agent.steer(...)` |
| `agent/inbox/inserted` / `claimed` / `discarded` | emit | 观测输入生命周期 |
| `session/event` | emit（提交后） | **唯一能在插件侧观测 turn/step/request/tool 等持久事件的地方** |
| `tools/pre-execute` | waterfall | **统一风控闸口**（allow / deny / ask；不允许改写入参） |
| `tools/execute` | waterfall | 超时、重试、指标（**只允许替换 `exec.signal`**） |
| `tools/post-execute` | waterfall | 结果改写 / 附加 context / block，附审计 |
| `tools/result` | emit | 全量审计日志（冻结快照） |

> **⚠️ 易踩的坑**：`turn/*`、`step/*`、`request/*`、`tool/call`、`tool/result` **不是 Cordis 事件名**，它们是**持久 session log 的事件类型**；插件要观测它们必须订阅 `session/event`。
>
> Cordis 侧真正的可挂载面总共只有这些：`agent/*`（10 个）、`tools/*`（6 个）、`session/*`（4 个：`created`/`disposed`/`event`/`flush`）、`system-prompt/*`（`assemble` 瀑布 + `change`）、`llm/stream`（瀑布，可包装流式输出）、`subagent/start|end`、`goal/*`。此外 `dispatch mode` 有 `emit / parallel / serial / bail / waterfall` 五种，`ctx.on(..., { prepend: true })` 让自己在默认实现**之前**运行（`agent/pre-step` 的注入就靠它）。

Agent 对象（runtime）关键 API：
- `agent.followup(msg)` —— 排队一个**独立的普通回合**并唤醒驱动（★ 循环的发动机）
- `agent.steer(msg)` / `agent.send(msg, target, wakeup)` / `agent.inject(msg)` —— 中途纠偏 / 精确投递 / 注入
- `agent.whenIdle()`、`agent.runMaintenance(task)` —— 等待静默 / 在真空闲期跑非回合任务
- `agent.inbox`、`agent.status`、`agent.session`、`agent.options`、`agent.cancel(cause, {keepInbox})`

Agent 生命周期管理（`dsh-agent` 的 `AgentRegistry`）：
- `ctx.agents.create({ sessionId, agentOptions:{provider,model}, meta:{cwd,...}, setup(agentCtx, agent) })` → `AgentHandle{agent, dispose()}`
- `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` —— 从**持久化会话**恢复（崩溃恢复的关键；需要 `ctx.sessionPersistence` 已挂载）
- `ctx.agents.roots()`、`ctx.agents.get(id)`
- `setup(agentCtx, agent)` 只做**组合**、不做驱动：它登记的一切都发生在 `session/created` → `agent/created` → `agent/session-start` → 首次 prompt 组装**之前**；setup 抛错会整体回滚。

工具注册（`dsh-tools`）：
- `ctx.tools.register(defineTool({ name, description, parameters, output:{schema, render}, timeoutMs?, isConcurrencySafe?, execute }))`
- `parameters` 是**隐式开放对象根**的 schema DSL（每属性 `required?: true`）；嵌套 object 必须显式写 `additionalProperties`；支持 `oneOf`
- `execute` 只返回 `output.schema` 声明的**规范 JSON 值**，模型看到的内容由 `render` 产出；**抛异常就是标准错误约定**
- **工具可见性两手抓**：
  - 注册作用域 —— 通过 `agent.ctx.tools.register(...)` 注册即只对该 agent 可见；
  - **`agentCtx.tools.restrict({ allow: [...], deny: [...] })`**（★ 只允许在 scoped ctx 上调用，全局调用会抛错）用于做**白名单**；多个 restrict 取交集。**这是"分析师只能读、交易员才能下单"的正解。**
- `tools/pre-execute` 返回值：`{kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`
- `ToolRunContext` 额外提供 `deferContext(msg)`（在本工具结果之后追加到历史）与 `concludeTurn()`（本次成功后结束回合）
- `timeoutMs` 是**协作式**的：声明它等于承诺你的工具会尊重 `exec.signal`

### 2.3 消息来源的语义标签：可借鉴，但**不必照搬**

DSH 有一个**语义化的上下文形态分类** `ContextForm`（`dsh-llm/lib/types/message.d.ts`）：它不是外观约定，而是**声明"这段内容是什么性质"**，由消费者决定怎么渲染。原文说明：

> `MessageSource.kind` 回答*谁产生的*；`form` 回答*这是什么东西*，两个轴**刻意独立**。
> 词汇表是**语义的，绝不是视觉的**……未知/缺省值即文档默认：按不透明内容呈现。

| `form` | 官方语义（逐字要点） |
|---|---|
| `instructions` | 从工作区文件读出的、期望模型遵循的指令 |
| `catalog` | 本会话可用项目的目录，随变化重新发布 |
| **`snapshot`** | **当前状态；同一生产者后来的快照会取代先前的** |
| **`notice`** | **刚发生某事的一次性说明；它不取代任何东西** |
| `relay` | 另一个 agent 发给本 agent 的消息 |
| **`recall`** | **从另一个会话日志中取出的材料，可能已在途中被缩减** |

> **⚠️ 态度：这是"可用的词汇 + 值得遵守的纪律"，不是必须匹配的契约。**
>
> DSH 官方定位是**单流、单次 agent**（一个主 agent 顺序推进一个会话）。我们是**循环式自主 agent**：一个长生命周期 desk session + 多个按需产生的审议回合 + 并行的只读子 agent + 离线整合回合。**两者的生命周期模型不同**，所以：
>
> - **可以照抄的**：用 `snapshot` 表达"当前状态、后者取代前者"、用 `notice` 表达"一次性事件"、用 `recall` 表达"从别处取来、可能被缩减的材料"。这三条语义在我们的循环里同样成立，而且能**避免自己发明约定**。
> - **不必照抄的**：为"单流会话"设计的其余分类（`catalog`/`relay` 的具体用法、以及"一个会话一个主 agent"的隐含前提）。我们的子 agent 报告、离线整合产物、跨窗口的计划卡，都**不完全对应**这些形态 —— 强行套用反而会扭曲设计。
> - **我们应当自己定义的部分**：来源标签里要能区分**"这是权威状态"还是"这是模型生成的推断"**（§7.4 铁律的落地）。这一点 DSH 的 `ContextForm` **没有覆盖**，必须由我们补充（例如在自有的来源字段上增加 `authority: 'store' | 'model' | 'external'`），并据此决定渲染与可信度标注。
>
> **另外一条重要提醒**：如果向 agent 提交的 prompt 里**引用了 DSH 自身的框架文字**（例如工具说明、系统提示词片段中"你是一个单流 agent"之类的表述），**必须改写成适合本项目的说明**。我们的 agent 是**循环自主、非人在环、长周期**的，任何"等待用户输入/一次完成任务"的暗示都会误导它。这是一项**实现时的检查项**：逐条审阅注入的框架级文本，替换为符合本项目的语义。

**三个可借鉴的具体收益**：
1. **C3 不用自己发明"覆盖"机制**：`snapshot` 的语义就是"后者取代前者"，与 §7.8 要求的"每步重算覆盖、不留历史"一致。
2. **`recall` 说出了"子 agent 报告会被缩减"这件事是预期行为**，所以 §5.3 的"结构化字段 + 工件指针"是与既有语义一致的正解：**缩减被声明过，因此可审计**。
3. **`notice` 的 `summary` 有硬上限 `CONTEXT_SUMMARY_MAX_CHARS = 120`**（`boundContextSummary` 自动省略）——唤醒消息的**一句话摘要必须压进 120 字符**。这是个有用的强制约束，避免"摘要越写越长"。

> **实践要求**：注册 `notice` 时必须提供 `summary`（类型上是 discriminated union，缺字段编译不过）；缺 `form` 合法但会被当作**不透明内容**——等于放弃了这套语义，建议显式声明。

### 2.4 上下文与成本控制（现成可复用，不要自研）

| 能力 | 包 | 关键配置 |
|---|---|---|
| 自动压缩 | `dsh-compaction-basic` | `thresholdRatio: 0.8`、`retainRatio: 0.16`（或 `retainTokens`）、`modelPolicies[]` 按模型覆盖、`auto` |
| 工具结果裁剪 | `dsh-compaction-tool-result-pruner` | base 默认 `thresholdChars: 8192 / head 4096 / tail 1024` |
| 大结果转存 | `dsh-spill-local` + `dsh-spill-policy` | `maxInlineBytes: 50000`，超限内容落文件、上下文只留指针 |
| Token 计量 | `dsh-token-meter` | `ctx.tokenMeter` 提供每次请求的度量 |
| 技能按需加载 | `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill` | 根目录：`<projectRoot>/.dsh/skills`、`$DSH_HOME/skills`；`SKILL.md` 前置元数据 `name`/`description`/`whenToUse` |
| 工作区指令（持久基线消息） | `dsh-agent-instructions` | 加载 `$DSH_HOME/AGENTS.md` + 项目链路 `AGENTS.md`/`CLAUDE.md`，`maxBytes: 65536` |
| 外部记忆/工具服务 | `dsh-mcp-client` | 一行挂一个 MCP server，工具名 `mcp__<server>__<tool>`；支持 stdio / streamable-http、重连退避 |
| 系统提示词分区 | `dsh-system-prompt` | 贡献项**按 agent 作用域**注册，同名覆盖全局；`personaPrefix/Suffix`、`toolOrder` |

### 2.5 多智能体编排（三个层级，各有用途）

| 机制 | 包 | 语义 | 在本项目中的用途 |
|---|---|---|---|
| `subagent`（spawn，continuable） | `dsh-tool-subagent` + `dsh-subagent-spawn-in-process` | 独立子会话、可多轮、可中断、结果回父 | 单角色分析/辩论的多次发言 |
| `subagent_fork`（fork，one-shot） | `dsh-tool-subagent`（provider=fork） | 继承父历史、one-shot、省 KV cache | 需要父上下文的一次性判断 |
| `workflow` | `dsh-tool-workflow` + `dsh-workflow-worker-thread` | 脚本编排 N 个子 agent，`pipeline`/`parallel`/`phase`，只回最终 JSON | **TradingAgents 图的最佳落点**：四分析师并行 → 多空辩论 → 风险辩论 → 裁决 |

### 2.6 定时 / 长任务 / 目标（**边界必须认清**）

| 能力 | 包 | 边界（重要） |
|---|---|---|
| 会话内定时提醒 | `dsh-schedule` | 持久化在 session log，`schedule_create/list/delete`；**只投递给活着的 root agent**，冷会话只积压不推送；最小重复间隔 5 分钟；**不适合做盯盘** |
| 后台作业 | `dsh-jobs-local` + `dsh-tool-jobs` | 归属 agent 会话，`job_output/job_list/job_kill`，完成有会话内通知；**进程内注册表，随 harness 进程死亡** |
| 目标自动续跑 | `dsh-goal` + `dsh-goal-round-driver` + `dsh-tool-goal` | agent 空闲且目标激活时自动续轮，有轮次上限；**会话 resume/fork 后必须人类显式 resume 才重新武装** —— 不能无人值守自愈 |
| 工具超时 | `dsh-tool-call-timeout-policy` | 协作式超时：只有工具自己配置了 `timeoutMs` 才生效，且工具必须尊重 `exec.signal` |

> **结论**：DSH 现成的定时/目标/作业三者**都不是** 7×24 盯盘的合适载体。盯盘必须由我们自己的插件服务承担（§6）。

---

## 3. TradingAgents 现状与"实盘化"缺口

### 3.1 它的真实结构（读源码所得，commit `be952b8` / v0.4.x）

> **⚠️ 先纠正常见误解**：网上流传的 TradingAgents 介绍（含部分 README 与论文）大量引用 **ChromaDB `FinancialSituationMemory`** 与 **`reflect_and_remember()`** —— 这两者在 v0.4 中**已被删除**（`tests/test_memory_log.py` 显式断言 `not hasattr(TradingAgentsGraph, "reflect_and_remember")`，`main.py` 里的调用已注释）。现在的记忆是 **markdown 决策日志 + 结算反思**。引用旧资料会设计出错误的架构。

图拓扑（`tradingagents/graph/setup.py:113-154`，条件路由见 `conditional_logic.py:14-73`）：

```
START
  └─→ Market Analyst ⇄ tools_market → Msg Clear Market
      → Sentiment Analyst ⇄ tools_social → Msg Clear Sentiment
      → News Analyst ⇄ tools_news → Msg Clear News
      → Fundamentals Analyst ⇄ tools_fundamentals → Msg Clear Fundamentals
      → Bull Researcher ⇄(count<2N，last=="Bull") Bear Researcher
      → Research Manager                     [count >= 2N]
      → Trader
      → Aggressive ──latest=="Aggressive"──▶ Conservative
        ──latest=="Conservative"──▶ Neutral
        ──else（含 last=="Neutral"）──▶ 回到 Aggressive
      → Portfolio Manager                    [count >= 3M]
      → END
   ⇄ = agent/tool 内循环，被随后的 Msg Clear 节点整个抹掉
```

关键事实（**其中多条与直觉相反**）：

- **已有 3 种循环**：分析师 ReAct 工具循环、多空辩论、风险三方辩论。终止**纯靠算术**（`count >= 2*max_debate_rounds` / `>= 3*max_risk_discuss_rounds`）——**没有收敛判据、没有提前退出、没有置信度**。且因为路由在节点**之后**运行，旋钮设为 0 时首位发言者仍会讲一次（"零辩论"不可配置）。辩论上限是偶数，所以**多空辩论永远以 Bear 发言收尾**。
- **图路由与内容耦合**：轮转靠对**发言文本前缀**做字符串匹配（`f"Bull Analyst: {content}"`）判断谁刚说完，而不是靠轮次计数器。这是脆弱设计，我们不要照抄。
- **状态**（`agents/utils/agent_states.py`）：`AgentState(MessagesState)` + 四份 `*_report` + `investment_debate_state` + `investment_plan` + `trader_investment_plan` + `risk_debate_state` + `final_trade_decision` + `past_context`。
  - **只有 `messages` 有 reducer**（`add_messages`）；**其余全部是"后写覆盖"**，包括两个辩论子字典 —— 所以每个辩论节点必须**整份重发**子字典，漏一个键就被丢弃。这就是那些冗长重复 dict 字面量的成因。
- **上下文管理是"粗粒度重置 + 无上限增长"两面**：每位分析师结束后 `Msg Clear <X>` 用 `RemoveMessage` **删光全部消息**再插一条占位 HumanMessage（`agent_utils.py:204-228`）。辩论阶段**完全不追加 messages**，只往辩论子字典里堆 —— 而 `history + "\n" + argument` **无上限增长**，并被完整重新注入每个后续辩手与两位裁决者。**没有摘要、没有滑动窗口、没有 token 预算**。
- **记忆与反思**：决策写入 `~/.tradingagents/memory/trading_memory.md`（追加式 markdown，`<!-- ENTRY_END -->` 分隔）；结算后由 quick 模型生成 2–4 句反思写回；`past_context` 注入"同标的最近 5 条全文 + 跨标的最近 3 条仅反思"。
- **模型分层**：`deep_think_llm`（Research Manager / Portfolio Manager）与 `quick_think_llm`（其余）。这个分层必须保留。
- **检查点**：`checkpoint_enabled` **默认关闭**；开启后是 LangGraph AgentState 级 SQLite（按标的），`thread_id = sha256(ticker:date:图形态签名)`，成功即清除。

**★ 但有两个致命事实必须知道**：

1. **发布的 CLI 根本不跑记忆/反思子系统**。`cli/main.py:1144` 直接 `graph.graph.stream(...)`，**从不调用 `propagate()`**。因此 CLI 路径**不产生**记忆日志条目、不做结算、不做反思、不算 `past_context`、不写 state JSON。所有记忆功能**只对程序化调用 `propagate()` 的调用者存在**。换句话说：它的"卖点功能"在默认入口里是死的。
2. **完全没有执行层**。broker / 下单 / 订单 ID / 成交 / 滑点 / 手续费 / 持仓账本 / 回测器**一概不存在**；`backtrader`、`redis`、`langchain-experimental`、`parsel` 是声明了却**从未 import** 的依赖。`TraderProposal` 里的 `entry_price` / `stop_loss` / `position_sizing` 只是**被渲染成 markdown 然后丢弃**——没有任何代码读回它们。

**★ 结构性问题（我们要主动避开，不要继承）**：

| 问题 | 证据 | 我们的对策 |
|---|---|---|
| **风险辩论结构性地为提案辩护** | Aggressive 被明确要求"create a compelling case for the trader's decision"（`aggressive_debator.py:33`），且入场无条件 | 风控必须是**独立角色 + 确定性硬闸**；辩论只作评述，**绝不作为授权** |
| 评级回退静默变 Hold | `SignalProcessor` 无法解析时返回 `REVIEW`，但记忆日志用 `parse_rating` 把无法解析的决策**静默记为 Hold** —— 一个"拒绝表态"的决策被记成"中性持有"进入学习历史 | 决策必须**类型化**，`REVIEW`/`NO_TRADE` 是一等公民，并在所有消费者（信号、日志、记忆）间一致传播 |
| 结构化输出是"尽力而为" | `bind_structured` 静默降级，`invoke_structured_or_freetext` 捕获**任何**异常后重试为纯文本，随后用**正则**从散文里抠评级 | 决策对象必须 schema 校验 + 校验失败即**拒绝执行**（绝不从散文回退解析） |
| 记忆日志并发不安全 | 读全文 → 改 → `tmp.replace()`，**读改写窗口无锁**；两个进程同时结算会静默丢失一方的反思 | 落到 SQLite/事务，多写者安全 |
| 反思与"重跑同一标的"强耦合 | `_resolve_pending_entries` 只处理**当前正在分析的标的**；一次性标的的 pending 条目**永远悬空** | 结算由**独立定时任务**扫描全部 pending（§7.3） |
| 反思指标是弱代理 | 5 根 bar 的收盘到收盘、`iloc[0]→iloc[holding_days]`（crypto 是自然日、股票是交易日，**跨资产不可比**）、naive `raw - bench`、**不含手续费/滑点/资金费** | 结算按**交易级**（含成本、按仓位）而非"决策级"；crypto 用自然日 + BTC/ETH 基准，不用 SPY |
| 无成本计量 | 只有 token 计数，**没有价格表、没有货币、没有成本数字**，且只在 CLI 显示、不持久化 | 成本是一等指标（§10.3） |
| 全局可变 config | `dataflows/config.py` 的模块级 `_config` 被 `__init__` 覆写；同进程跑"便宜扫描模型 + 强决策模型"会互相污染 | 配置按 agent/作用域显式传递（DSH 的 `agentOptions` + scoped config 天然支持） |
| 无日志配置 | 全仓无 `logging.basicConfig`/`addHandler`；`logger.info` 全部静默 | 结构化日志 + run id（§10.3） |

### 3.2 用于 Live Crypto 的硬缺口

| 缺口 | 具体表现 | 本方案的解法 |
|---|---|---|
| **一次性调用语义** | `propagate(ticker, date)` 是"某标的某日跑一次"，无事件驱动、无持仓概念、无循环 | 插件守护服务 + `followup` 回路（§5） |
| **无持仓/账户状态** | `AgentState` 里根本没有 cash/position/quantity/PnL 键；全仓无权益曲线 | desk state + `trade_portfolio` 工具，每步注入 |
| **执行层完全缺失** | 无 broker、无订单 ID、无成交、无滑点手续费；`position_sizing`/`stop_loss` 是**被丢弃的字符串** | 独立 broker 适配层 + 订单状态机 + **数值化**的仓位/止损推导（§8.2、§8.3） |
| **无幂等/无 run 身份** | `_log_state` 用 `open(...,"w")` 覆盖；`store_decision` 的守卫只在 pending 期间生效（结算后重跑会**追加第二条**） | 每次决策有 `decision_id` + 内容哈希 + "是否已执行"标记（§8.2） |
| **无熔断/杀开关** | 全仓 grep 不到 kill/halt/daily_loss/max_position，只有提示词里的散文 | 硬闸 + 心跳失效即撤单（§9） |
| **数据前视** | PIT 纪律很强，但仍有 5 处漏点：Polymarket 与内部人交易**只有实时没有 as-of**、财报按**财季结束日**而非**申报日**过滤、报表工具默认 `curr_date=None` 直接关闭过滤、`resolve_instrument_identity` 把**缓存的实时** `Ticker.info` 注入每个 prompt 且无日期守卫 | 数据层强制 `closed_at <= now` + **申报时间**而非财季 + 所有外部文本带 `fetched_at`（§8.1） |
| **成本不可控** | 一次完整图 = 低几十次模型调用（仅市场分析师就被要求 8 个指标 + 快照）；且 `_resolve_pending_entries` **每个 pending 条目再烧一次调用、无上限** | 唤醒理由三选一（§6.2）+ 每窗口/每日预算硬顶 |
| **延迟** | 分钟级，不适合止盈止损 | **止损/止盈必须放交易所侧或插件硬闸**，绝不依赖 LLM |
| **反思依赖未来数据** | 需要 `holding_days+7` 个自然日之后的 bar 且拒绝部分窗口 | `reflection_due_at` 结算队列（§7.3） |
| **crypto 支持是"标签级"的** | 只硬编码 11 个币种（BTC/ETH/SOL/XRP/ADA/DOGE/LTC/BCH/DOT/AVAX/LINK），只认 `-USD` 对，**无 funding/OI/盘口/链上**；唯一行为变化是**去掉基本面分析师**；基准默认仍是 **SPY**（拿 7×24 资产对美股指数算 alpha） | 换成 funding、基差、OI、清算、链上、稳定币流；基准用 BTC/ETH（§8.1） |
| **无调度器** | 全仓无 daemon/cron/scheduler，CLI 是"交互一次然后退出" | Docker 单进程常驻 + restart policy（§10.1） |

**值得直接复用（它是这个项目真正的资产）**：
1. **时点（PIT）纪律**：单一共享的 UTC 半开窗口 `in_window` + `withhold_live_profile` + FRED realtime vintage 钉定 + 财报按日期过滤 + 记忆按 `resolved <= as_of` 门控。有测试支撑，成体系。
2. **供应商路由契约**：显式链式（"yfinance,alpha_vantage"）、**行为化**错误分类（NoMarketData / RateLimit / NotConfigured）、`NO_DATA_AVAILABLE` 哨兵明确告诉模型"不要编数字"、core 与 optional 分类区别对待（optional 降级、core 抛错）。
3. **`schemas.py` + `structured.py` 的类型化输出**：三个决策 agent 用 Pydantic，渲染回 markdown 让存储/展示/解析共享一种形状；`_coerce_optional_float` 能处理 `"N/A"`、`"$1,234.50"`、`"15%"` 这类脏输入。
4. **5 档评级词汇 + `REVIEW` 哨兵**：拒绝伪造 Hold 是对的（问题在于没传到记忆层）。
5. **`normalize_symbol`**：纯语法、无网络、别名表即数据。
6. **`safe_ticker_component`** 及"先校验 LLM 影响的值再拼路径"的直觉。
7. **图形态本身作为参考设计**，以及 **`Msg Clear <X>` 的思路**（每个分析师用完即清，避免工具噪声污染下一位）——我们在子 agent 隔离下天然获得同样效果。
8. **检查点设计**：`thread_id = hash(ticker, date, 图形态签名)` —— "图变了就不能静默续跑"这个签名思路是对的。
9. **模型/供应商层**：懒加载、声明式 per-model 能力表、单一 provider→env 映射表。
10. **`write_report_tree`**：确定性分节的 markdown 审计产物。

**必须重写（不要在原实现上扩展）**：执行与持仓账本、风控与杀开关、入口本身（CLI 与 `propagate()` 是两套不同系统）、运行编排与持久化、并发与配置隔离、记忆/反思循环（结算解耦 + 交易级收益 + 有界保留）、信号→动作的类型化翻译、成本与可观测性、确定性与可审计性、供应商冗余、以及**按成本裁剪的辩论循环**（定长、永远以 Bear 收尾、无收敛判据、全量 transcript 反复注入）。

---

## 4. 总体架构

### 4.1 五层结构

```
┌──────────────────────────────────────────────────────────────────────┐
│ L5 元循环（周级）  desk review：结算账本 → 策略有效性 → 更新 playbook   │
│                    ★ 离线（sleep-time），可用更强模型，产出需人审       │
├──────────────────────────────────────────────────────────────────────┤
│ L4 结算闭环（小时~天）  decisions → 结算 → 反思 → 记忆写入（离线）      │
├──────────────────────────────────────────────────────────────────────┤
│ L3 判断（审议窗口：开盘前 / 每 4h / 收盘后）                            │
│      desk session ── followup ──→ agent turn                            │
│      └─ 产出「计划」：论点 + 失效条件 + if-then 承诺（含数值）          │
├──────────────────────────────────────────────────────────────────────┤
│ L2 执行（秒~分钟，纯代码）  ★ 不唤醒 LLM                                │
│      条件评估 → 命中的承诺动作 / 报警；无承诺则入"待判断"队列          │
├──────────────────────────────────────────────────────────────────────┤
│ L1 数据（常驻）  WS 行情 → bar 归档 → 指标增量 → 账户同步 → 对账        │
└──────────────────────────────────────────────────────────────────────┘
       ↑ L1/L2 由「插件常驻服务」驱动，与浏览器/会话存活无关；
         L3/L4/L5 才需要 LLM，且只在少数时刻被唤醒
```

### 4.2 时间尺度与"谁来做"（本方案的核心分工）

| 尺度 | 在做什么 | 执行者 | LLM 参与？ |
|---|---|---|---|
| 毫秒–秒 | 止损/止盈触发、超时撤单、心跳熔断 | 交易所条件单 / 本地硬闸 | **绝不** |
| 秒–分钟 | 逐 bar 算指标、评估条件、执行**已承诺**的 if-then | 规则引擎（纯函数） | **绝不** |
| 分钟–十分钟 | **不开 LLM 回合**；无承诺的异常只入队 | 队列 | **绝不**（见 §6.2） |
| 小时（审议窗） | 读状态 → 形成/复核论点 → 写下失效条件与承诺 | desk agent turn | **是**（核心） |
| 小时–天 | 结算、反思、记忆写入 | 离线任务 + 轻量模型 | 是（离线，不占关键路径） |
| 周 | 策略与参数复审 | 离线 + 人审 | 是（离线） |

> **设计红线一**：**把 LLM 放在"判断"上，把代码放在"执行"上**。一分钟级的价格变化**不需要智能**——它需要的是一份**已经想好的计划**和一台忠实的执行机。
>
> **设计红线二**：**判断必须发生在窗口内、风险敞口打开之前**。盘中不做"要不要开仓"这种没想过的决定（见 §4.4）。

### 4.3 交易员的真实一天（我们要复刻的工作流）

参考真实裁量交易员/小型基金交易台的工作节奏（**关键点：绝大多数时间不在盯盘**）：

| 时段 | 交易员实际在做什么 | 我们的对应机制 | 智能？ |
|---|---|---|---|
| 盘前/窗口前的**准备** | 看隔夜与宏观、扫新闻、标关键位、核对持仓与风险、写当日计划 | 审议窗 turn：注入 desk state + 市场特征 + 记忆 → 产出**计划卡** | ✅ 需要 |
| 盘中**监控** | 大部分时间**不盯盘**：设好警报、按计划执行、处理例外 | 规则引擎 + 条件单 + 告警；**agent 保持 idle** | ❌ 条件与逻辑 |
| 盘中**例外处理** | 出现计划外的重大新信息时才介入重新判断 | 新颖性逃逸通道 → 唤醒（严格限流，§6.2） | ✅ 需要 |
| 盘后**复盘** | 记录决策与情绪、结算当日、对照计划检查执行偏差 | 结算队列 + 反思任务（离线） | ✅ 需要（离线） |
| 周期**复审** | 看盈亏归因、评估策略是否仍有效、调整参数与标的池 | 元循环（周级，离线，人审） | ✅ 需要（离线） |

**这张表的三个结论**：
1. **"盯盘"不是智能活动**，而是"条件评估 + 忠实执行"。把它交给 LLM 是既贵又不可靠的错配。
2. **智能集中在三个边界时刻**：**窗口前的判断**、**计划外的新信息**、**收盘后的复盘**。这三处才是 LLM 该出现的地方。
3. **"设好警报然后去干别的"是专业做法**，不是偷懒。系统架构应当**默认 idle**，唤醒是例外而非常态。

#### ★ 一手依据：盯屏不是"没用"，而是**主动有害**

上表第 2、3 行的判断不是我推的，交易心理学里有一条很直接的证据。Brett Steenbarger（*The Psychology of Trading* 作者，全球宏观对冲基金绩效教练）在 [Market Myopia](http://traderfeed.blogspot.com/2007/12/market-myopia.html) 里逐字写道：

> "**Does watching the market tick-by-tick improve your trading returns?** Clearly, if you're scalping… you have to be glued to the screen. If, however, you're trading over time frames lasting an hour or more, does it add value to be glued to the screen? Does watching each tick lead to better trading decisions or returns, or **does it lead to a kind of myopia in which we become reactive and no longer follow our original trading ideas?**"

他的三条论断，每一条都直接映射到我们的架构决策：

| Steenbarger 的论断（逐字要点） | 对我们的直接含义 |
|---|---|
| "watching markets tick-by-tick often stems from an **illusion of control**: that, by monitoring events tightly, we can somehow better control them" | **"有持仓时每分钟调用 LLM"就是这个错觉的工程版本** —— 用算力换取"我在掌控"的感觉，而不是换取更好的决策 |
| "getting more feedback about investments leads to **risk aversion and reduced returns**"（引 1997 QJE 研究） | 高频反馈**降低收益**。这与"LLM 参与越多越好"的直觉相反 |
| "we begin to see patterns that we believe are indicative of shifting supply and demand. This perception leads us to **exit positions before they've reached their target or delay entering positions** that otherwise offer favorable reward:risk" | 盯盘会让系统**提前平仓、推迟入场** —— 正是把 R:R 做坏的两个方向 |
| "some traders **equate working hard with being glued to screens**. In reality, **the hard work of trading lies in what comes prior to putting the trade on**: the research and analysis" | **把"算力投入"从盘中挪到窗口前** —— 这就是 §4.4 计划卡的全部理由 |
| "to the extent that tracking markets tick-by-tick is an expression of **anxiety over one's position**, it is not only not productive… but is **actively destructive**" | 盯盘是**焦虑的表达**，不只是浪费 |

**他还给出了检验这套设计的方法**（这一条我要写进验收标准）：

> "A very useful exercise is to **define your trading rules so that you can clearly identify a stop and a target for each of your trades. Then you can see how your discretionary management of the position adds value to simply following those rules.** By cutting winners short and delaying entries into good ideas, the trader glued to the screen reduces the risk:reward potential of each trade."

也就是说：**先把止损与目标写成规则，再让"自主管理"去证明它比机械执行规则更好。** 在我们的语境里，这直接成为一条可执行的验收标准：

> **任何盘中 LLM 介入（W2/W3）都必须在回放中证明它相对"纯机械执行计划卡"有正贡献。证明不了，就关掉这条通道。**
> —— 这比"我觉得需要 LLM 看着"要可证伪得多。

### 4.4 先决策、后执行的机制：计划卡（Plan Card）

这是把"判断"与"执行"解耦的**核心概念**。审议窗内，agent 必须产出一份**可被代码逐条执行**的产物，而不是一段散文。

> **本节的粒度说明**：这里只给**概念与约束**，不锁定字段。
> 具体 schema（字段名、类型、枚举、表达式语言）**依赖工程实现**（谁能求值、在哪求值、如何回测），过早定字段会把设计钉死在还没验证的假设上。落地时应当"先能跑通一条最小承诺，再逐步加字段"。

**计划卡必须回答的四件事（概念层，不可省）**：

| # | 要回答的问题 | 硬约束 |
|---|---|---|
| ① | **论点**：现在怎么看、多确定、关键位在哪 | 要能被后续复盘引用；但**不参与执行判定** |
| ② | **失效条件**：什么会证伪这个论点 | ★ **必须能被代码判定**。逼不出可判定形式，说明还没想清楚 —— 这正是审议窗该解决的问题 |
| ③ | **承诺**：条件 → 动作的 if-then 预案 | ★ **动作必须落在有限的"确定性动作词汇表"内**；**仓位由公式算，不由模型给数字** |
| ④ | **不做什么**：本窗口明确禁止的行为 | 防止"盘中即兴发挥"（Steenbarger 说的第三条失败原因） |

**四条不可协商的性质**：

1. **可判定性**：②③ 的条件必须是**代码能求值**的形式（而非自然语言）。无法判定的条件等于没有条件。
2. **有期限**：计划卡必须在**窗口结束即失效**，不能用三小时前的判断处理三小时后的市场。过期后的规则命中一律走"未覆盖"路径。
3. **幂等根**：计划卡与由其产生的每个动作意向都要有**内容哈希 + 唯一标识**，作为去重与审计的根（这是 TradingAgents 缺的那一环）。
4. **不可事后改写**：计划卡一旦生效即**冻结**；修正只能产出**新版本**（新 `planId`），旧版本保留在审计链里。这条是"事后合理化"的防线。

**为什么这套机制成立**（对应 §4.5 的分工表）：

- **仓位是公式，不是判断**：模型只表达"愿意承担多少风险 / 止损放哪"，**数量由代码按账户风险与止损距离算出**（固定分数法）。模型不给"买 N 个"这种数字，也就**不可能给出危险的数字** —— 这是把最危险的一类输出从模型手里拿走。
- **执行不需要推理**：承诺已经做过判断，盘中只剩"条件成立 → 执行动作"。
- **"不做"是合法输出**：计划卡允许只产出失效条件与禁则、不产出任何入场承诺（`NO_TRADE`）。

**要注意的问题点（留给实现阶段）**：

| 问题 | 为什么棘手 | 倾向 |
|---|---|---|
| **条件表达式的表达力 vs 安全性** | 太弱则表达不了真实策略；太强（能执行任意代码）则回测与审计都失控 | 用一个**受限 DSL**，只暴露指标、价格、时间、持仓、资金费率等有限词汇 |
| **谁来求值、在哪求值** | 在插件内核求值最快最可控，但每加一个指标就要改内核；交给代码执行层最灵活但更慢且更难审计 | **混合**：常用条件走内核 DSL，罕见指标走代码执行层（见 §8.5） |
| **过期与重叠** | 窗口切换时旧承诺可能正好命中；多个计划卡并存会互相矛盾 | 明确"同一时刻只有一个活跃计划卡"，旧卡进入只读归档 |
| **多标的下的承诺量** | 标的池开放（决策点 1）意味着承诺数量随标的增长，规则引擎负担上升 | 按"持仓优先 + 观察名单限流"分层求值，而非全量全频 |
| **仓位公式的参数从哪来** | 单笔风险 % 是用户启动时提供的参数（决策点 3） | 参数化注入，不写死在代码里 |
| **滑点/深度假设** | 承诺是否可执行依赖流动性，而流动性在条件命中时才可知 | 执行前必须**重取实时盘口**再判定（§8.6） |

> 这套机制在交易实践里就是**交易计划 + 条件单 + 预案**；在 agent 工程里它有一个更通用的名字：**把决策前置，让执行无需推理**。两者是同一件事。
>
> **注**：条件单本身就是"承诺"的一种交易所侧实现 —— CCXT 已把服务端触发单/止损/止盈/追踪止损统一（§8.2）。因此"止损类承诺"应当**直接下成交易所侧条件单**，而不是靠本地循环监控。

### 4.5 什么需要智能，什么只需要条件与逻辑

这是整个设计里最重要的一张表。**每一行都要问：这里真的需要 LLM 吗？**

| # | 活动 | 需要智能？ | 实现 | 理由 |
|---|---|---|---|---|
| 1 | 接收行情、维护 bar 与指标 | ❌ | 代码 | 确定性计算 |
| 2 | 判断条件是否命中（价格穿越、指标交叉、波动扩张…） | ❌ | 代码（纯函数） | 布尔逻辑，且必须可回测 |
| 3 | 执行已承诺的 if-then（开/加/减/移止损/平） | ❌ | 代码 + 交易所条件单 | 承诺已做过判断，这里只是执行 |
| 4 | 止损/止盈/移动止损触发 | ❌ | 交易所侧条件单 / 本地硬闸 | **毫秒级，LLM 不可能承担** |
| 5 | 仓位大小 | ❌ | 公式（账户风险% ÷ 止损距离） | 行业标准就是公式 |
| 6 | 交易前风控校验（敞口/杠杆/日亏/滑点/幂等） | ❌ | 代码硬闸 | 必须确定性、可审计 |
| 7 | 对账、订单状态机、重连、心跳熔断 | ❌ | 代码 | 工程问题 |
| 8 | 数据质量校验（缺口、离群、时间戳漂移） | ❌ | 代码 | 规则明确 |
| 9 | 告警去重、冷却、限流、分级 | ❌ | 代码 | 计数与时间窗 |
| 10 | **形成/修正论点**（当前 regime、多空逻辑、关键位） | ✅ | **审议窗 LLM** | 需要综合判断 |
| 11 | **声明失效条件**（"什么会证伪我"） | ✅ | **审议窗 LLM** | 需要自我反驳能力 |
| 12 | **写出 if-then 预案**（把判断落成可执行承诺） | ✅ | **审议窗 LLM** | 从判断到执行的翻译 |
| 13 | **识别 regime 变化**（是噪音还是换挡） | ✅ | **窗口 + 新颖性逃逸** | 最难系统化的部分，也是人真正的价值 |
| 14 | **处理计划外的新信息**（协议失败、监管、黑天鹅） | ✅ | **新颖性逃逸通道** | 无法预先穷举 |
| 15 | 组合层判断（相关性聚集、总敞口、是否整体降险） | ✅ | 审议窗（组合视角） | 横截面判断 |
| 16 | 结算后的归因与反思 | ✅ | **离线**轻量模型 | 不占关键路径 |
| 17 | 策略是否仍有效、参数与标的池调整 | ✅ | **离线 + 人审** | 低频高影响，必须人在环 |
| 18 | "看不懂，选择不做" | ✅ | LLM 输出的合法结果（`NO_TRADE`） | 不做也是一种判断 |

**结论**：**18 项里有 9 项（1–9）完全不需要 LLM**，占运行时长的 99% 以上；**需要智能的只有 10–18**，而它们全部可以安排在**离线的窗口或低频的逃逸通道**里。

> 一句话：**LLM 的价值在"想清楚"，不在"盯着看"。** 把"盯"交给代码，把"想"交给模型，并用**计划卡**把两者接起来。

> **设计红线**：**把 LLM 放在它擅长的尺度上**（分钟级以上、需要综合判断的），把确定性任务全部下沉到代码。

### 4.6 五项运行时假设：已核对 API，按"成立"处理

> 这五项原本是"必须先验证才能往下写"的前置条件。现已逐条对照本机源码核对**API 确实存在且签名匹配**，并按"成立"推进设计与实现。每条仍标注**运行期风险**与**若为假的退路**——核对 API 存在 ≠ 语义行为已验证，落地时仍需观测。

| # | 假设 | 核对结论（源码依据） | 若为假的退路 |
|---|---|---|---|
| **R1** | 插件进程内 `ctx.agents.resume()` 能拉起**非用户创建**的持久会话，`followup` 能驱动回合 | ✅ `AgentRegistry.resume({ resumeSessionId, agentOptions, setup })` 存在（`dsh-agent/lib/types/index.d.ts`）；`resume` 要求 `ctx.sessionPersistence`——base bundle 默认挂载 `dsh-session-persistence-jsonl`；`Agent.followup(msg)` 存在且语义为"排队独立回合并唤醒"（`runtime-types.d.ts`） | 生产由 Docker restart + dsh 启动恢复承接；不退化为外部 cron/第二个交易进程 |
| **R2** | 投递消息的 `source` 标签确实区分"非用户输入" | ✅ 存在完整的 `ContextForm` 语义联合（见 §2.3）；`createUserMessage` 要求 `source` | 若渲染不如预期，把状态改走 `systemPrompt.context`（不占消息槽位） |
| **R3** | `tools/pre-execute` 的 `deny` 对**子 agent 内部**调用生效 | ✅ 文档明示该瀑布"Scope-filtered dispatch：agent-scoped listeners receive only that agent's calls"——即全局监听者收到**每一个** agent 的调用 | 退化为在**每个交易工具内部**做二次硬闸（本来就要做，作为双保险） |
| **R4** | `agent/pre-step` 返回 `{kind:'reject'}` 不会造成空转 | ✅ 类型为 `{kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}`，是明确的二选一（`runtime-types.d.ts:92`） | 不使用 reject；改为在组装阶段就把不该有的输入**不投递** |
| **R5** | 长跑无资源泄漏 | ⚠️ **无法靠读源码断言**——只能实测（WS 重连、SQLite 句柄、`ctx.effect` 卸载顺序） | 仍列为 P0 的**实测项**：灌 24h 合成行情，观察 RSS 与句柄数 |

**因此 P0 的形态变了**：不再需要"先写探针证明假设"，而是**在实现 P0 的同时把 R5 做成可重复的压测脚本**，并用 R1/R2 的语义行为做一次最小闭环验证（resume → followup → assistant/message → 落库）。

> **仍建议保留的两个"最小闭环"验证**（成本极低、收益确定）：
> 1. **R1/R2 合体**：启动时 `resume` + `followup` 一条带 `source` 标签的消息，确认产生 `assistant/message`，并 `export` 会话肉眼确认渲染形态。
> 2. **R5 压测**：24h 合成行情下观察 RSS/句柄曲线是否平稳。
> 这两项**不阻塞**后续开发，作为 P0 的验收项并行推进。

---

## 5. 核心命题：把单向流程图变成可循环结构

### 5.1 三层循环的对应关系

| TradingAgents | DSH 对应物 | 循环由谁驱动 |
|---|---|---|
| 分析师 ReAct 工具循环 | DSH 每个 step 的 tool pipeline（内建） | agent loop |
| 多空辩论 / 风险辩论（计数器终止） | `workflow` 脚本里的 `for`/`while`，或 continuable subagent 多轮 | 脚本 / 父 agent |
| `propagate()` 单次运行 | 一次 **desk agent turn** | 插件守护服务 `agent.followup()` |
| —（缺失） | **触发循环**：行情事件 → 决策 → 执行 | 插件守护服务（market watcher） |
| —（缺失） | **反思循环**：结算 → 反思 → 记忆 | 插件定时任务 |
| 决策日志 memory.md | `journal` 存储（SQLite + JSONL） | 工具 + 钩子 |

### 5.2 回路导线：`followup` + 持久会话

```
[行情 WS] ──bar close──▶ [规则引擎] ──trigger──▶ ┌─────────────────────┐
                                                  │ TriggerQueue (SQLite)│
                                                  └──────────┬──────────┘
                                                             │ claim (去重键)
                                                             ▼
                                        ┌────────────────────────────────────┐
                                        │ DeskSupervisor（插件常驻服务）        │
                                        │  · 若无 agent：ctx.agents.resume(id) │
                                        │  · 若 idle：agent.followup(pack)     │
                                        │  · 若 running：入队，等 whenIdle      │
                                        └──────────────┬─────────────────────┘
                                                       ▼
                          ┌──────────────────────────────────────────────────┐
                          │ desk session（长生命周期、持久化 session log）      │
                          │  turn N: [context pack] → 判断 → 工具             │
                          │     ├─ trade_workflow_run  → workflow 子 agent 群 │
                          │     ├─ trade_propose_order → 风控硬闸 → broker    │
                          │     └─ trade_record_decision（写 journal）        │
                          └──────────────┬───────────────────────────────────┘
                                         │ 决策落地
                                         ▼
                          [SettlementScheduler] ── T+N 结算 ──▶ [Reflector]
                                         │                        │
                                         └────── memory 写入 ◀────┘
```

**为什么必须是"插件服务 + followup"，而不是"agent 自己循环"？**

- Agent 的 turn 由 inbox 驱动；没有输入它就 idle。靠 prompt 写"继续盯盘"会退化成**昂贵的忙轮询**（每次都烧 token 却没有新信息）。
- `dsh-goal-round-driver` 确实能自动续轮，但它 (a) 有轮次上限，(b) **会话恢复后必须人类显式 resume 才重新武装**，(c) 语义是"朝一个目标推进"而非"事件驱动"。用它做 7×24 既贵又不可靠。
- 只有插件能在**没有新 turn 的情况下**一直活着、监听市场、并在真正需要时唤醒 agent。这就是本方案的技术核心。

### 5.3 单次判断的内部结构（把图搬进来）—— 但必须遵守两条铁律

**先说一个对多智能体架构的重要警告。** Cognition 在 [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) 里给出了两条我认为**必须遵守**的原则：

> **原则 1：共享上下文** —— 不要只传单条消息，要传完整的相关轨迹。
> **原则 2：动作携带隐含决策，而冲突的隐含决策导致坏结果** —— 并行子 agent 各自基于**未被统一规定的假设**行动，结果会互相不一致。

它举的例子很贴切：把"做个 Flappy Bird 克隆"拆给两个并行子 agent，一个做了马里奥风格的背景，一个做了不像游戏素材的鸟 —— 最后合并者拿到的是两份互相冲突的误解产物。

**这对我们的交易图意味着什么？**

| 我们的设计 | 是否违反原则？ | 处理 |
|---|---|---|
| 4 个**并行只读**分析师 | ⚠️ **有风险**：若各自拿到不同的数据快照，会产出互相冲突的事实（一个说趋势向上，一个说区间震荡——因为看的时间窗不同） | **强制**：所有并行分析师拿到**同一份** context pack 与其哈希；工具只读；**不允许**任何子 agent 有副作用 |
| 多空辩论 / 风险辩论 | ❌ 表面上违反（子 agent 互相看不到） | **但实际不违反**：这些子 agent **只回答一个定义明确的问题**（"为这一侧给出最强论证"），**不采取任何行动**；而且它们**看到完整的分析师报告与完整的前序发言**（见下方代码）。这正是 Cognition 自己也认可的安全形态：*"子 agent 通常只被交办回答一个问题，而不是动手做事"* |
| **最终裁决 + 下单** | — | **必须由单一 agent 看到全部材料后做出**，绝不并行、绝不外包 |

**结论：辩论可以是并行的/多角色的，决策不能。** 关键区别是**"只回答" vs "会行动"**。任何**有副作用**的动作（下单、撤单、改止损）都必须回到**唯一**的那个裁决者，由它看到全部论点后串行执行。

**因此 `workflow` 脚本必须这样写**（注意每处的上下文传递）：

```js
// desk agent 调用 workflow —— 脚本模板由插件以 skill 形式固化，降低模型编排负担
// ★ 铁律 A：先冻结一份 context pack，所有并行分析师共用同一个哈希
const pack = args.pack                 // { packId, contextHash, features, deskState, activePlan, lessons }
if (args.contextHash !== pack.contextHash) throw new Error('context pack mismatch')

phase('analysts')
const reports = await parallel([
  () => agent(marketPrompt(pack),  { label:'market',  schema: ReportSchema }),  // 只读工具
  () => agent(flowPrompt(pack),    { label:'flow',    schema: ReportSchema }),  // 资金/清算
  () => agent(newsPrompt(pack),    { label:'news',    schema: ReportSchema }),
  () => agent(onchainPrompt(pack), { label:'onchain', schema: ReportSchema }),
])
// ★ 铁律 B：合并前先检查事实冲突，而不是把冲突悄悄平均掉
const conflicts = detectFactConflicts(reports)     // 同一事实的两个不同数值/结论
if (conflicts.length) {
  reports.push(await agent(reconcilePrompt(pack, reports, conflicts),
                           { label:'reconcile', schema: ReportSchema }))  // 专职消解冲突
}

phase('debate')
// ★ 每个辩手都拿到：完整报告 + 完整前序发言。不是摘要，也不是"只看对手"
const dossier = { pack, reports, conflicts }
let bull = null, bear = null, rounds = 0
while (rounds < maxRounds) {                       // ← 计数器终止，等价 should_continue_debate
  bull = await agent(bullPrompt(dossier, bear), { label:'bull', schema: ArgSchema })
  bear = await agent(bearPrompt(dossier, bull), { label:'bear', schema: ArgSchema })
  if (bull.concede || bear.concede) break          // ★ 新增：论据收敛即停
  rounds++
}

phase('risk')
// ★ 风控三方同样看到完整材料；且没有任何一方被要求"为提案辩护"（不同于 TradingAgents）
let agg = null, cons = null, neu = null, r = 0
while (r < maxRiskRounds) {
  agg  = await agent(aggPrompt(dossier, bull, bear, cons, neu),  { label:'aggressive',   schema: RiskSchema })
  cons = await agent(consPrompt(dossier, bull, bear, agg, neu),  { label:'conservative', schema: RiskSchema })
  neu  = await agent(neuPrompt(dossier, bull, bear, agg, cons),  { label:'neutral',      schema: RiskSchema })
  r++
}

// ★ 只回「结构化字段 + 工件指针」，不回散文摘要
//   Anthropic 在多智能体研究系统里的原话是最好的解法：
//   "Subagent output to a filesystem to minimize the 'game of telephone'" ——
//   让子 agent 把成果落到外部存储，只把轻量引用回传给协调者。
return { packId: pack.packId, contextHash: pack.contextHash,
         reports: reports.map(r => ({ agent: r.agent, verdict: r.verdict,
                                      keyNumbers: r.keyNumbers,       // ★ 结构化字段，精确
                                      artifactRef: persist(r) })),    // ★ 全文落 DB，只回引用
         debate:{ bull, bear, rounds },
         risk:{ agg, cons, neu, r }, openDisagreements: collectOpenDisagreements(...) }
```

> **为什么"工件指针"比"摘要"好**（这是 §7.2 遮蔽思想在多智能体上的同构应用）：
> 摘要会**不可逆地丢失**信息（"你无法可靠预测哪条观测在十步之后会变得关键" —— [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）；而**引用 + 结构化字段**既保持了上下文的轻量，又让裁决者能在需要时**把原文取回来**。这与我们处理 C6 的方式完全一致：**能重取的，就只留指针。**

**三处相对 TradingAgents / 初稿的关键修正**：

1. **并行分析师共用同一份冻结的 context pack**（否则冲突的前提假设，正是 Cognition 原则 2 的失败模式）。
2. **新增 `detectFactConflicts` + `reconcile` 角色**：把"两个分析师对同一事实给了不同数字"从**隐式矛盾**变成**显式修复步骤**。这一步在交易里价值极高 —— 它拦住的正是"模型拿两个不一致的数据做决策"。
3. **返回 `openDisagreements` 而不只是结论**：让裁决者知道**哪些分歧没有被解决**，从而可以选择 `NO_TRADE` 而不是被迫拍板。这是把"我不确定"变成合法输出的机制。

**为什么仍然用子 agent 群而不是全塞进 desk session？** 子 agent 的中间过程不进入父会话（workflow 只回最终 JSON），desk session 的上下文**只增长一条结论** —— 这是上下文可控的根本原因（§7.1）。同时每个角色可指定自己的 provider/model（轻量模型跑分析师，深度模型跑裁决），并通过 `agentCtx.tools.restrict({allow})` 把工具**白名单化**：分析师**只能读**。

> **实现约束（对应 §7.4 铁律）**：子 agent 一律通过 `agentCtx.tools.restrict({ deny: ['trade_execute_order','trade_cancel', ...] })` 剥夺副作用能力。**能下单的工具只注册给 desk session 的裁决者。**

### 5.4 执行前的"状态重取"（极重要）

LLM 的上下文天然**陈旧**：它看到的是触发时刻的快照，等它决定下单时可能过了 40 秒。因此：

> **所有交易类工具在 execute 里必须先向交易所重新拉取账户/持仓/最新价，用实时状态重算，再决定执行或拒绝。** 上下文里的持仓数字只用于"理解"，不能用于"计算"。

---

## 6. 盯盘（Market Watching）设计

### 6.1 为什么不用现成件（重申）

| 候选 | 否决理由 |
|---|---|
| `dsh-schedule` | 只在会话内投递；冷会话只积压；最小间隔 5 分钟；语义是"提醒我"而非"持续监控" |
| `dsh-jobs-local` | 进程内注册表，随 harness 死亡；无法跨重启 |
| `dsh-goal-round-driver` | 人类显式 resume 才重新武装；有轮次上限 |
| OS cron 拉起 `dsh --profile headless` | **不采用**；Docker restart policy 已负责主进程存活，启动恢复负责状态收敛 |
| Node 进程内 `setInterval` | 进程死即停 —— 由 Docker restart + 启动状态重建承接，不启动第二个交易进程 |

**结论**：盯盘 = 插件内的 `MarketWatcher` 常驻服务（用 `ctx.effect` 管理生命周期），数据源断线自动重连，状态写自己的 SQLite，重启后从 DB 恢复。

### 6.2 ★ 盘中是否需要 LLM？—— 不需要，只有三种情况才唤醒

这是本设计最关键的判断。**分钟~十分钟级的盯盘不需要 LLM 参与**，只用条件化脚本即可。理由有三条，且每条都是硬约束：

1. **成本与延迟**：1 分钟级触发 × N 标的 × 每天 1440 根 bar ⇒ 任何"每根 bar 过一遍模型"的方案都会破产，且分钟级延迟对止损毫无意义。
2. **判断无法连贯**：盘中随机时刻被唤醒的模型**不知道审议窗内形成的计划**。它看到的是一根 bar 和一个持仓数字，却要在信息最少、上下文最碎、时间压力最大的时刻做最贵的决定 —— 这正是散户亏钱的方式。**"有持仓时每一分钟都用 LLM"正是这个错误**。
3. **执行不需要智能**：如果判断已在 §4.4 的计划卡里做完，盘中就只剩"条件成立→执行动作"，这是布尔逻辑。

**因此：L1 → L2 → L3 的分层被替换为"唤醒理由三选一"。**

盘中每一次真正唤醒 LLM，必须能归入以下三类之一（否则**不唤醒**，只落库 + 可选告警）：

| # | 唤醒理由 | 条件 | 频率 | 举例 |
|---|---|---|---|---|
| **W1** | **审议窗口到期** | 时间驱动（盘前、每 4h、收盘后） | 每天几次 | 固定的"该想一想了" |
| **W2** | **计划内承诺需要** | 规则条件命中，且计划卡里**没有**对应承诺可执行 | 罕见 | 计划说"跌破 61200 减半仓"，但实际是跳空到 60800 —— 承诺不适用 |
| **W3** | **新颖性逃逸** | 出现了**与所有已知模式都不匹配**的重大新信息 | 极少（强限流） | 交易所被盗、稳定币脱锚、监管突袭、协议被利用 |

**W2 的精髓**：它是一次**"承诺覆盖率"检查**，而不是"信号触发"。代码问的不是"价格动了吗"，而是：

```
if (conditionHit) {
  const c = activePlan.commitments.find(c => matches(c.when, conditionHit))
  if (c) { executeDeterministically(c.then); return }     // ★ 不唤醒 LLM
  else   { enqueueForJudgment(conditionHit, activePlan) }  // W2：计划没覆盖到
}
```

- 绝大多数 bar 走的是**第 2 行**：执行一个早先想好的动作，**零 token、零延迟**。
- 只有第 3 行才唤醒。而且这次唤醒是**有的放矢**的：它能带着"我的计划覆盖不了这个情况"这个明确问题去见模型。
- 这同时是一个**计划质量的度量**：W2 频繁 ⇒ 审议窗的计划写得太粗，应该改进的是计划，而不是加钱买更多 LLM 调用。

**W3 的边界必须严格**，否则它会退化成"什么都能唤醒"：
- 只有**结构化**的新颖性信号才允许触发：预言机/交易所状态异常、清算量突破历史分位、单根 bar 波动 > k·ATR、资金费率越过极端阈值、稳定币脱锚、已列入白名单的新闻源出现高危关键词。
- **必须强限流**：每小时 ≤ N 次、每日 ≤ M 次，超限只落库告警。
- **不允许"模型自己觉得有意思"**：W3 由代码判定，不由模型判定。
- W3 唤醒时，注入的 Event Pack 必须明确写出**"这是计划外情况，请判断是否需要制定新计划，可以选择不做（NO_TRADE）"**。

> **一句话**：**盘中"盯"由代码做，"想"按窗口做；规则命中只是执行，规则未覆盖才唤醒。** LLM 的调用次数应当由**审议窗的频率**决定（每天几次），而不是由**市场波动**决定（每天上万次）。

### 6.3 规则族（全部纯代码）

1. **价格**：穿越关键位（前高/前低/VWAP/整数关口）、区间突破、跳空
2. **趋势/动量**：EMA 交叉、MACD 柱状翻转、ADX 阈值突破
3. **均值回归**：RSI/布林带极值、z-score 偏离
4. **波动**：ATR 扩张、已实现波动率分位突破、单 bar 异常幅度
5. **量能/流动性**：成交量 z-score、盘口深度骤降、点差扩大
6. **衍生品**：资金费率极值、基差异常、持仓量骤变、**清算潮**（强平数据）
7. **组合**：浮亏阈值、单标的敞口阈值、相关性聚集、回撤阈值
8. **事件**：宏观日历（CPI/FOMC）、上线/分叉/解锁、链上大额流入交易所
9. **时间**：审议窗口到点

**每条规则必须声明自己的用途**，这是设计纪律：

```ts
type RuleSpec = {
  id: string
  purpose: 'invalidation' | 'commitment' | 'novelty' | 'info'
  //   invalidation → 论点被证伪，直接执行降险/平仓（不唤醒）
  //   commitment   → 匹配计划卡里的承诺，执行之（不唤醒）
  //   novelty      → 走 W3 逃逸通道（唤醒，强限流）
  //   info         → 只落库/告警，永远不唤醒
  expr: string          // 可被求值器执行的表达式
  cooldownMs: number
}
```

`purpose` 字段是防止规则集无边界膨胀的闸门：**任何新增规则都必须先回答"命中之后做什么"**。答不上来的规则就是噪音。

### 6.4 推送给 LLM 的内容：Event Pack（注入抵抗）

只在 W1/W2/W3 唤醒时才构造。每条唤醒消息都要满足：
- **标注为数据，不是指令**（内容含未受信外部文本时尤其重要：新闻标题、社媒内容可能含 prompt injection）
- **说清唤醒理由**：`{wake: 'W2', uncovered_condition: ..., active_plan_id: ..., why_not_covered: ...}`
- 只给**最小充分证据**：`{event_id, trigger, symbol, ts, 关键指标快照, 当前持仓, 计划卡摘要, 最近规则命中历史, 冷却状态}`
- 带 **dedup key** 与 **expires_at**（过期即作废，避免处理陈旧信号）
- 明确写"若不需要动作，回复 `NO_TRADE`，不要下单"
- **绝不复述历史行情**：需要更多数据就自己去调工具（just-in-time 检索，§7）

### 6.5 触发治理（防抖动、防风暴）

```
规则命中
  → 查 activePlan.commitments：命中一条 ⇒ 执行它（不唤醒）★ 最常见路径
  → 否则按 purpose 分流：
       invalidation ⇒ 执行降险动作（不唤醒）
       novelty      ⇒ W3 通道（需通过限流）
       其他         ⇒ 落库；仅当 W2 条件成立才入"待判断"队列
  → 去重：dedup key = hash(rule_id, symbol, bar_ts, 阈值桶)
  → 冷却：每规则/每标的独立窗口
  → 限流：W2 每小时 ≤ N，W3 每小时 ≤ M、每日 ≤ K
  → 分级：P0(持仓风险) / P1(机会) / P2(信息)
```

- **P0 抢占**：持仓风险可抢占排队中的 P1/P2。
- **无新信息不唤醒**：队列为空时 agent 保持 idle，**不烧 token**。
- **Agent 忙时不打断**：只入队；turn 结束（`agent/status → idle`）后再投递；只有 P0 允许 `steer()`。

### 6.6 盯盘脚本的治理形态

把"盯盘脚本"做成**声明式规则 + 可测试的纯函数**，而不是散落在 prompt 里的自然语言：

```yaml
# profile patch 里的一行配置（插件 Config）
- id: trading-rules
  name: 'dsh-trading-agents/rules'
  config:
    rulePacks: [mean_reversion_v1, breakout_v1, funding_extreme_v1]
    cooldownMs: 900000
    windows:                          # ★ W1：审议窗口（LLM 只在这里出现）
      - { id: pre_session, at: '00:30Z' }
      - { id: midday,      everyMs: 14400000 }
      - { id: post_session, at: '23:30Z' }
    escape:                           # ★ W3：新颖性逃逸（强限流）
      maxPerHour: 2
      maxPerDay: 6
      dailyBudgetUsd: 3.0
    judgment:                         # ★ W2：计划未覆盖时
      maxPerHour: 3
      maxPerDay: 8
      provider: deepseek-official
      model: deepseek-reasoner
```

规则实现为**纯函数** `(features, plan, position, config) => Hit[]`，因此可用历史数据**离线回放 + 单元测试** —— 这是"脚本式盯盘"能被信任的前提。**注意它是纯函数**：同样的输入永远给同样的输出，不调用模型、不读时钟、不写状态。

---

## 7. Context 与记忆管理

### 7.1 第一原则：Context 是视图，不是仓库

**核心判断：不要依赖框架的自动 compaction 来管理交易上下文。** 原因不是"框架做得不好"，而是**自动压缩无法知道哪些细节在交易里是致命的**。Anthropic 自己的经验也承认这一点：

> "压缩的艺术在于选择保留什么与丢弃什么，**过度压缩会丢失那些重要性日后才显现的微妙但关键的上下文**。" —— [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

所以本方案采取**完全自管**的路线：

> **交易的权威状态存在数据库与交易所里；LLM 的 context 是一份"为本次判断临时组装的视图"，用完即弃。**
> 上下文里**不允许存在任何"只能从上下文里得到"的信息**——凡是重要的，都必须能从权威源重新取回。

这条原则直接推出三个结论：
1. **能否被安全压缩，取决于"能否从别处无损重建"**，而不是取决于"内容重不重要"。能重建的可以随便丢；不能重建的一个字都不能丢。
2. **不确定的信息，从权威源重取，而不是从上下文里回忆。** 模型永远不需要"记得"持仓 —— 它在需要时读一次。
3. **`context_hash` 是必需品**：每次组装求出哈希并连同决策落库，才能事后证明"模型当时看到的是这个"，否则整个决策链不可审计。

**支撑这套做法的两条外部证据**：
- **上下文退化是普遍的**：token 越多，模型准确召回能力越低（[Context Rot, Chroma](https://research.trychroma.com/context-rot)），因此"塞满"永远不是安全选项，**保持工作集小是性能手段而非省钱手段**。
- **更关键的是：检索放在模型外面做，是正确性收益而不只是成本收益。** Chroma 在 LongMemEval 上的对照很说明问题：同一批问题，**约 300 token 的聚焦提示词打败了约 113k token 的全量提示词**。原因不是模型不够强，而是**给了全量输入后，模型必须在一次调用里同时完成"检索"和"推理"两件事**——这两件事互相干扰。所以 §3.2 里 TradingAgents 那种"把四份全文报告 + 全部辩论转录塞进裁决 prompt"的做法，不只是贵，而是**会让推理质量变差**。
- **按需检索优于全量预注入**：维护轻量标识符（路径、查询、句柄），在运行时用工具把数据拉进上下文（"just in time"）。[Anthropic 特别指出](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)金融这类**内容动态性较低**的场景适合**混合策略**：一部分状态前置注入换速度，其余交给自主检索 —— 这正是 §7.3 的分工依据。

### 7.2 六类上下文：机制与生命周期（**"哪些能丢、哪些不能丢"的表**）

每一类都映射到 DSH 原生的 `ContextForm` 语义（§2.3）——**不要自己发明"覆盖/追加"的约定，用官方的**：

| # | 类别 | 内容 | 机制 | `ContextForm` | 生命周期 | 能否压缩？ |
|---|---|---|---|---|---|---|
| **C1** | **宪法级** | 风控纪律、硬性禁令、输出契约、动作词汇表 | `systemPrompt.section`，**逐字固定** | （系统提示词槽位，非消息） | 永久 | **不压缩**（几乎不变 → KV 缓存命中） |
| **C2** | **配置级** | 标的池、时间框架、限额、基准 | `AGENTS.md`（持久基线消息）+ 插件 Config | **`instructions`** | 天~周 | 不压缩（人写，非模型产物） |
| **C3** | **状态级** | 持仓、权益、敞口、挂单、活跃计划卡 id | **每步从交易所+DB 重取** | ★ **`snapshot`**（官方语义：后来的快照**取代**先前的） | 单步 | **不适用**——本就不该被"记住"，每次重新读 |
| **C4** | **承诺级** | 活跃计划卡的 `when`/`then`/失效条件 | **逐字**、结构化、在 DB；注入时**规范化序列化** | **`snapshot`**（同上，随 C3 一起刷新） | 窗口期 | **❌ 绝对不可丢**（见 §7.3） |
| **C5** | **情节级** | 已结算决策与反思、journal、**子 agent 报告** | **检索注入**（工具 + 固定 token 预算），非全量 | ★ **`recall`**（官方语义：取自另一会话日志，**可能已在途中被缩减**） | 单轮 | 可摘要，但**结算数值必须精确** |
| **C6** | **原始级** | K 线、tick、盘口、新闻全文、大报告 | **永不入 context**；落库 + `trade_market` 等工具按需取 | （不进入） | — | 不适用（从不进入） |

**唤醒消息（Event Pack）用 `notice`**：官方语义是"刚发生某事的一次性说明，**不取代任何东西**"——正好区别于 C3 的"取代"。注意 `notice` 的 `summary` 有 **120 字符硬上限**（`CONTEXT_SUMMARY_MAX_CHARS`），所以一句话摘要要极简，细节放正文。

**三类特殊判定**：
- **C3 是"每轮重建"的最大受益者**：它占了旧式 agent 上下文的大头（持仓明细、订单列表），但它**天生可以重建**，所以每步重算一次、不留历史，上下文立即瘦身。**用 `snapshot` 就自动获得这一语义**，无需自己写"替换而非追加"的逻辑。
- **C4 是"绝不进压缩器"的**：它的每一条都可能被代码执行，压缩一个数字就是执行错误。
- **C5 的 `recall` 语义解释了一件重要的事**：子 agent 报告**在途中被缩减是官方预期行为**，而不是缺陷。因此 §5.3 的"结构化字段 + 工件指针"不是权宜之计，而是**与框架语义一致的正解**——缩减被**声明**了，所以可被审计。

**★ 对工具返回体（C6 进入上下文的那一瞬间）要用"遮蔽"而不是"总结"。**

JetBrains Research 的 *The Complexity Trap*（[arXiv 2508.21433](https://arxiv.org/abs/2508.21433)，NeurIPS DL4C 2025）给出了这个领域**最强的实证结果**：把**旧的工具观测**替换为占位符、**完整保留推理与动作链**（observation masking），在 SWE-bench Verified × 5 种模型配置下：

| 对比 | 结果 |
|---|---|
| 遮蔽 vs 不处理 | **成本减半**，解决率持平或略高（Qwen3-Coder 480B：便宜 52% 且 +2.6%） |
| 遮蔽 vs LLM 总结 | **遮蔽不劣于总结** |
| 遮蔽 + 总结的混合 | 再省 7–11% |

原因是**观测 token 占平均回合的约 84%** —— 也就是说，上下文膨胀的主因不是"想得太多"，而是"看了太多"。

对我们的映射：
- **可遮蔽**（因为可重新取回）：盘口快照、K 线序列、新闻正文、API 返回体 —— 正是我们上下文的大头。
- **不可遮蔽**（因为事后不可重建）：**决策记录与成交记录**。遮蔽它们等于篡改审计链。
- 占位符必须**说明省略了什么、在哪里**（如"已省略 15m K 线 200 根，可用 `trade_market` 重取"），而不只是"已省略" —— 这样模型知道自己缺了什么、并且知道怎么补回来。

> 这修正了初稿的说法：**"裁剪/转存"是减小体积，"遮蔽"是用可重取的指针替换**。前者让模型丢了信息却不自知，后者让模型**知道这里被省略了、需要时自己去取**。DSH 的 `tool-result-pruner`/`spill` 负责前者，**遮蔽逻辑要我们自己实现**（在工具的 `finalizeContent` 或 `tools/post-execute` 里）。

### 7.3 ★ 不可损失细节的清单（非协商）

这份清单是**硬约束**：以下内容**禁止**经过任何摘要/压缩环节，必须以**逐字或结构化精确值**存在，且必须能从权威源**无损重建**。

| 必须逐字/精确的内容 | 为什么压缩会致命 | 存放位置 |
|---|---|---|
| **订单标识与幂等键**（`clientOrderId`、`decisionId`、`contentHash`、交易所 `orderId`） | 压缩=丢字=幂等失效=重复下单 | `orders`/`order_intents` 表，唯一键约束 |
| **金额、数量、价格、止损/止盈位** | 近似值直接变成错误执行 | 数值型字段（**不是字符串**），schema 校验 |
| **活跃承诺的 `when` 表达式与其过期时间** | 条件被"概括"后无法求值 | `plan_cards.commitments`，JSON 精确存储 |
| **已声明的失效条件** | 失效条件丢了 ⇒ 论点永远不会被证伪 | 同上 |
| **未平仓头寸与未成交订单** | 忘记持仓是最危险的失忆方式 | 每步从交易所重取（C3），DB 只作镜像 |
| **未解决的线程**（挂起的结算、待对账项、异常状态） | 静默积压成事故 | `pending` 表 + 启动时扫描 |
| **风控限额与当前已用额度** | 限额记错 ⇒ 超限 | 配置 + DB 计数，**不进 prompt 做算术** |
| **数据指纹与 `context_hash`** | 无法证明"当时看到什么" | 决策记录字段 |
| **已执行的副作用**（已下单、已撤单、已改止损） | 重复执行 | append-only 事件表 + 唯一键 |

**反向清单：可以每轮丢弃的**（丢了就重建或干脆不需要）：

| 可丢弃内容 | 为什么可以丢 |
|---|---|
| 逐根 bar 的行情与指标明细 | 需要时用工具重新查（C6） |
| 上一窗口的完整分析原文（四份报告全文） | 结论已进计划卡；原文可按需回查 |
| 辩论过程的逐轮发言 | 只保留结论与"未解决分歧"（§5.3 已要求逐轮摘要） |
| 已结算的历史叙述性描述 | 可检索；且旧叙述对当前判断价值低 |
| 工具调用的原始返回体 | 大结果本就该 spill 到文件（C6） |
| 任何"模型自己写给自己"的中间推理 | **尤其危险**，见 §7.4 |

### 7.4 ★ 铁律：模型的输出不得作为决策输入回流

这是**最重要的一条**，也是最容易被违反的：**LLM 生成的摘要、反思、笔记，绝不能成为未来决策所依赖的唯一真相来源。**

理由：一旦模型的自述成为权威，**一次幻觉会被固化、放大、并无限期地影响后续所有决策**——错误不再需要重新发生就能持续生效。这在交易里等于"用自己编的记忆做真金白银的决定"。

**因此**（对应 Letta 在实践中总结的 "silent drift" 与 "poisoned consolidation" 两个失败模式，见 §7.7）：

| 做法 | 规则 |
|---|---|
| 注入模型自己过去的反思 | **允许**，但必须**同时注入其依据的结构化事实**（决策数值、结算数值、订单结果），让模型能自己发现矛盾 |
| 模型生成的摘要进入 prompt | 必须**标注为"模型生成、未经核实"**，与权威字段在格式上可区分 |
| 反思写入记忆 | **只有结算完成后**才允许（§7.5），且写入时**冻结不可改**（append-only，改则新增版本） |
| 关键块（宪法、限额、playbook） | **代码写入 + 人审**；模型**没有**写入权限（见 §7.6） |
| 任何"模型改写了状态" | 必须**版本化并可 diff**，改动要在会话轨迹里显式可见 |

> 一句话：**模型可以读自己的过去，但不能成为自己过去的作者。**

**这条铁律有直接的实证支撑，而且比我预想的更严厉。** Reflexion（[arXiv 2303.11366](https://arxiv.org/abs/2303.11366)）是"自我反思"的经典机制，它的**架构本身就是带闸门的**：Actor（行动）/ Evaluator（外部评估）/**Self-Reflection（只在评估之后才写教训）** 是三个独立模型，且反思条数**有上限**（Ω 通常 1–3）。

但它的**消融实验才是我要引用的重点**：

| 配置 | 结果 |
|---|---|
| 基线（无反思） | 0.60 |
| **去掉自反思** | 0.60 → **与基线持平**（说明反思不是白送的） |
| **保留自反思但去掉测试生成（即失去外部验证信号）** | 0.60 → **0.52，反而变差** |

也就是说：**没有外部验证锚定的自我反思会主动损害性能** —— 模型会"对实现做出有害的修改"。它报告在 MBPP-Python 上的假阳性率高达 **16.3%**（HumanEval 仅 1.4%），因为错误的测试通过被当成了成功信号，于是学到了错的东西。

**对我们的直接后果**——反思的写入闸门必须是**机械的、外部的**：

1. 反思**只在外部机械评估之后**才写：成交回报、对账结果、结算数值、规则违背记录。**绝不**因为"模型觉得自己这次做得不好"就写。
2. 反思**携带证据指针**（结算用的那些事件 ID / 订单 ID / 行情指纹），因此**可以被推翻**。
3. 反思**有 TTL 与条数上限**（学 Reflexion 的 Ω=1–3 思路），并按**当前 regime 相似度**检索，而不是全量注入。
4. **模型过去的总结绝不能作为新反思的"观测"输入** —— 否则就是自己给自己打分，正是 0.52 那条路径。

> 交易里的"外部验证者"就是**市场本身**：已实现盈亏、相对到达价的滑点、成交率、约束是否被守住。**一条没有锚定到已实现结果的"教训"，是一段不可证伪的文本，它只会漂移。**

### 7.5 记忆的四个层级（借鉴 Letta/MemGPT 的分层，落到交易语义）

MemGPT/Letta 把记忆分成 **core（常驻提示）/ recall（会话历史）/ archival（外部存储）** 三层，并进一步把 core 做成**有字符上限、可被摘要、可版本化的"记忆块"**（[Letta memory blocks](https://www.letta.com/blog/memory-blocks)、[MemGPT arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）。我们采用这个分层，但按交易语义重新命名：

| 层 | 对应 Letta | 载体 | 写入者 | 生命周期 | 读取者 |
|---|---|---|---|---|---|
| **M0 工作记忆** | core（部分） | 本次 turn 的 context（C1–C5 组装而成） | 上下文组装器 | **单步/单轮** | agent |
| **M1 会话记忆** | recall | DSH session log（JSONL 持久化） | DSH 内建 | 天~周 | 人工回看、崩溃恢复 |
| **M2 情节记忆** | archival | `decisions`/`outcomes`/`orders`/`fills`/`plan_cards`（SQLite + 事务） | 交易工具 + 结算器 | 永久 | 检索注入、复盘、报表 |
| **M3 语义记忆** | core blocks | `playbook.md`、`lessons`、skills；**带版本与上限** | 元循环（**人审**） | 永久 | prompt 前缀 / skills / 检索 |

**M2 的主键约定**（让所有表可 join、可重放）：

```
decision_id, content_hash, trigger_id, symbol, timeframe, decided_at,
context_hash, data_fingerprint, model_route, action, size_quote,
stop_loss, take_profit, confidence, executed_at, order_ids[],
rationale(短), risk_notes, reflection_due_at, outcome_id
```

其中 `content_hash`（决策内容的哈希）与 `executed_at` 是**幂等与去重的根**：TradingAgents 的 `_log_state` 用 `open(...,"w")` 直接覆盖，`store_decision` 的守卫只在 pending 期间有效，结算后重跑会**追加第二条同标的同日期的条目**，之后两条都被当成独立的"教训"参与检索 —— 这个坑必须从表结构上堵死（唯一键 + `INSERT OR IGNORE`）。

**M3 采用"记忆块"形态**（这是 Letta 那套里最值得抄的部分）：
- 每个块有 `id` / `label` / `value` / **`limit`（字符上限）** / `description`（告诉模型何时该读它）。
- 块内容**接近上限时必须先摘要再写**，防止无限 append 撑爆（Letta 称之为 block bloat）。
- **每次写入记录旧值与 diff**，并提供 `block_history(label)`，以便回答"这个策略为什么被改掉了"（Letta 称之为 silent drift）。
- **宪法块与限额块只有代码/human 可写**（对应 Letta 的 "treat sleep-time agents as untrusted writers"：涉及 safety/persona 块的写入需要第二方复核）。

**★ 一个必须照抄的权限设计**：Letta 的生产架构把在线与离线 agent 的**工具权限分开**：

| 角色 | 能做什么 | 不能做什么 |
|---|---|---|
| **在线主 agent**（我们的 L3 审议窗） | 对话、调用业务工具、**检索**记忆（recall + archival） | **没有编辑 core memory 的工具** |
| **离线 agent**（我们的 L4/L5） | 拥有**全部记忆编辑工具**，管理自己的与主 agent 的 core memory | 不直接对外行动 |

它给出的理由正好是我们的痛点：**把记忆操作从关键路径上拿掉，既降延迟、又降不可靠性**（"agent 可能在对话中变慢"、"同时调用记忆管理工具和普通工具时可靠性更低"）。而且离线 agent **可以用更强的模型**：*"让 sleep-time agent 用更强的模型，因为它们不受延迟约束 —— 比如对话主 agent 用 gpt-4o-mini，sleep-time agent 用更大更慢的模型。"*

**量化收益**（[Sleep-time Compute, arXiv 2504.13171](https://arxiv.org/abs/2504.13171)，Letta + Berkeley）：
- 达到同等准确率，**测试时算力降低约 5×**；
- 增加 sleep-time 算力可**提升准确率最多 13%（GSM-Symbolic）/ 18%（AIME）**；
- 跨相关查询摊销后，**每查询平均成本降 2.5×**。

**但有一个边界条件必须注意**：收益取决于*"用户查询的可预测性"*。映射到我们这里：**审议窗的查询是高度可预测的**（"现在该不该动、动多少、什么会让我错"），所以离线整合的收益应当显著 —— 但**黑天鹅（W3）天然不可预测**，因此不能指望离线把逃逸通道的思考预先做完。这也是为什么 **W3 必须保留在线判断**。

### 7.6 离线整合（sleep-time compute）：把"复盘"移出关键路径

Letta 的另一个值得直接借鉴的设计是 **sleep-time compute**：让一个**独立的后台 agent** 在主线空闲时处理转录、写入 `learned_context`、合并/失效过时记忆。它的三个性质正好对上交易需求（[Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute)）：

| 性质 | 对交易的意义 |
|---|---|
| **不占关键路径** | 复盘再慢也不影响盘中执行 |
| **可以用更强的模型** | 复盘值得用深度模型（它不受延迟约束） |
| **天然的整合窗口** | 去重、摘要、**作废被证伪的论点**，都在"没人等着"的时候做 |

**★ Anthropic 已经在产品里实现了同一套架构**，可以作为我们设计的独立验证（[compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)、[context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)、[managed memory](https://platform.claude.com/docs/en/managed-agents/memory)、[dreams](https://platform.claude.com/docs/en/managed-agents/dreams)）：

| Anthropic 的能力 | 我们的对应物 |
|---|---|
| 服务端 compaction / `clear_tool_uses` 上下文编辑 | §7.2 的遮蔽 + C5 压缩 |
| 记忆库挂载为**文件系统目录**，每次变更生成**不可变版本** | M3 记忆块 + 版本化 diff（§7.5） |
| **dreams**：离线重综合记忆库（去重/合并/作废），**且绝不修改输入库** | L5 元循环；**产出提案而非就地改写** |

它文档里的一句话正是本方案 §7.1 的第一原则，被产品化了：

> *"Context editing is applied server-side before the prompt reaches Claude. **Your client application maintains the full, unmodified conversation history.**"*

—— **提示词是一份视图，完整历史是真相。** 这与我们"Context 是视图，不是仓库"完全同构，值得作为实现时的对齐标准。

**dreams 的"绝不修改输入库"尤其值得抄**：离线整合**只能产出新版本**，不能就地改写历史。这样任何一次错误的整合都可以被回滚，而审计链保持完整。

我们的 L4/L5 就是这个角色：
- **L4（结算后）**：结算 → 反思 → 写 `lessons` → 作废过期承诺。
- **L5（周级）**：跨窗口归因 → 评估策略有效性 → **提案**修改 playbook（**必须人审**）。
- **空闲期还可做**：把 M1 的冗长历史整合进 M2（而不是留在会话里发霉）。

> **关键区别**：离线 agent 是**不可信写入者**。它可以写 `lessons`，但**不能**直接改宪法/限额/playbook —— 后者只能"提案"。

### 7.7 反模式黑名单（明确不做什么）

| 反模式 | 后果 | 我们的约束 |
|---|---|---|
| 把行情/盘口塞进 prompt | 上下文退化、成本爆炸 | C6：永不入 context |
| **工具数量失控** | ≥30 个工具就开始显著降低工具选择准确率，≥100 近乎必然失败（RAG 选取 <30 个可带来最高 3× 准确率提升） | **desk agent 的工具白名单必须精简**（目标 ≤ 20）；按角色 `restrict({allow})` 收窄，而不是给所有人全部工具 |
| **在一次迭代中途增删工具** | **整个 prompt 缓存失效**（不是部分），并可能让模型引用已不存在的工具 | 「**Mask, don't remove**」：要收窄就用约束手段，等窗口结束再真正改动工具集 |
| 依赖自动 compaction 处理交易状态 | 关键数值被"概括" | C3/C4 不进压缩器；压缩只作用于 C5 的叙述，且只在单次审议内部兜底 |
| 让模型自己写状态摘要再喂给自己 | 幻觉固化、静默漂移 | §7.4 铁律 |
| **让摘要承载审批状态** | 摘要可能**把模型自己的话归因为"用户的批准/确认"** —— 这是有记录的失效模式 | **审批状态永不经过摘要传递**：授权只来自结构化的硬闸判定，不来自任何文本 |
| 无上限累积转录 | TradingAgents 的实际形态（`history + "\n" + argument`） | 逐轮摘要，只传"结论 + 未解决分歧" |
| 每步重新注入完整持仓明细并保留历史 | 上下文膨胀 | C3 每步**重算覆盖**，不留历史（`snapshot` 语义） |
| 记忆块无限 append | 撑爆上限、检索退化 | 带上限 + 超限先摘要 + 版本化 |
| 让上一窗口的长篇报告留在会话里 | 陈旧信息污染当前判断 | 只留计划卡；报告按需回查 |
| **子 agent 用散文摘要回传** | "传话游戏"：信息不可逆丢失，且丢失不可见 | 回传**结构化字段 + 工件引用**（§5.3） |
| **把观测"删掉"而不是"遮蔽"** | 模型不知道自己缺了什么，无法补取 | 占位符必须说明**省略了什么、在哪、怎么重取**（§7.2） |
| **把失败从转录里清理掉** | "擦掉失败就是抹掉证据" —— 没有证据模型无法适应 | **失败与错误状态逐字保留**（见 §7.3 不可损失清单） |
| **无外部验证就写反思** | 实测**主动损害性能**（0.60 → 0.52） | 反思闸门必须是机械的外部信号（§7.4） |
| **把硬性风控写成提示词** | 提示词里的限额只是**建议**，不是限额 | 硬闸在**校验器**里，模型无权绕过（§9.2） |
| **跨轮次切分信息** | 实测把提示词打散到多轮会显著降低表现（且模型"走错一步后不会恢复"） | 一次判断所需的事实**一次给全**，不要"分几步告诉它" |

### 7.8 组装算法与审计

每次组装（每个 step 或每个 turn）执行：

```
assembleContext(agent, step):
  C1 ← staticSections(agent)                       # 逐字，稳定前缀 → KV cache 命中
  C2 ← readAgentsMd()                              # 天级变化        form: 'instructions'
  C3+C4 ← liveState() + activePlanCard(now)        # ★ 每步重取      form: 'snapshot'（取代语义）
  C5 ← recall(regime, symbol, tokenBudget=800)     # 检索，固定预算  form: 'recall'
  C6 ← (不注入；只注册工具句柄)
  ctx  = [C1, C2, {C3,C4}, C5]
  ctxHash = sha256(canonical(ctx))
  logContextAssembly(step, ctxHash, changedParts)  # 记录哪些部分变了、为什么
  return ctx
```
- **C3/C4 合并为一条 `snapshot`**（它们同属"当前状态"，一起刷新最自然），避免两条快照互相错位。
- **C5 用 `recall`**：语义上明确"这是从别处取来、可能被缩减的材料"，与"当前状态"区分开。
- **唤醒消息另走 `notice`**（不参与 `ctxHash`，因为它是回合的输入而非组装的状态）。

- `changedParts`（本步相比上一步哪些部分变化）是**排查"模型为什么突然改变主意"的第一手证据**。
- `ctxHash` 随决策落库 ⇒ 任意历史决策都能重建"当时可见的信息"。
- **C3 的"覆盖不追加"很重要**：如果用注入历史的方式更新状态，会话会被几十份状态快照撑爆；正确做法是**替换**（DSH 的 `systemPrompt.context` 每次组装重新求值，适合承载此类状态）。

**★ 前缀纪律（与供应商计费无关，本身就是好设计）**

> **本项目只适配 DeepSeek，其缓存默认开启、按 token 单元自动命中，没有价格表也没有需要显式选择的 TTL** —— 因此**不需要**在计划层面做缓存成本优化，也**不要**照搬其他供应商的 TTL / 写溢价 / 最小可缓存长度那类调优。（这也是为什么本节删掉了初稿里基于另一家供应商价格结构的"成本悬崖"分析：**该分析对本项目不适用，属于无用的复杂度**。）

但下面三条**与计费无关**，纯粹是"让前缀稳定"的工程纪律，仍然保留：

| 规则 | 理由 |
|---|---|
| **prompt 前缀稳定**：C1/C2 在前且逐字不变，C3/C4/C5 在后 | 前缀稳定对所有供应商都有利，也让 diff 可读 |
| **只追加、不改写历史**；状态用 C3 **替换**而非追加新快照 | 避免会话被几十份状态快照撑爆（这才是真正的膨胀来源） |
| **确定性序列化**（键排序、数字格式固定） | 主要目的**不是省缓存，而是让 `ctxHash` 可复现** —— §7.8 的审计基础 |
| **一次审议内不改工具定义** | 工具集在窗口内冻结，避免同一轮内前后不一致；同时省掉"中途换工具"带来的行为抖动 |

> **⚠️ 消息来源标签必须写对**：插件投递的消息要用 `createUserMessage({ content, source: { kind:'plugin', plugin:name, form:'notice', summary } })`。**缺了 `source` 标签，注入内容会在派生历史里被渲染成"用户说的话"** —— 在交易场景里这会被模型误认为人类指令，是必须避免的。

**仍然要保留的两道"兜底"**（自管不等于不用框架能力）：
- `compaction-basic` 仍然挂载，但它只应作用于**会话叙述**；对深度模型设更激进的 `thresholdRatio`（`modelPolicies`）。
- `tool-result-pruner` 必须打开（`thresholdChars` 收敛到 4–8KB）：一次大行情快照就能塞满窗口，而这类结果本就该走 C6 的按需查询。

**★ 一个重要结论：本架构"按构造"基本不需要 compaction。** 因为工作上下文是**每个窗口从存储重新组装**的，会话里**不存在不断累积的转录** —— 这正是各家来源反复推荐的形态，而我们是靠架构自然得到的，不是靠压缩补丁。
但**例外必须防**：**单次审议内部**（多轮辩论的子 agent 群）确实可能耗尽窗口，而那正是"丢一个决策 ID 或一条失效条件就会造成伤害"的地方。所以：
- compaction **只作为"单次审议内部"的兜底**，不作为主循环机制；
- 一旦触发，必须使用**字段清单式**摘要（见下），而不是自由散文。

**★ 摘要提示词必须用"字段清单"而非自由发挥**。多家收敛到同一模式：**先枚举你不能丢的字段，再要求摘要器逐项填写**（缺项要显式写 "None"）。可采用的分节：

```
## 本次审议的意图与 regime 判断
## 已承诺的动作（逐字：when 表达式、数值、order/client id）   ← 禁止改写
## 失效条件（逐字）                                          ← 禁止改写
## 被否决的选项与原因                                        ← 重要：防止重复提议
## 未解决的分歧与未解决的线程
## 下一步
```

最后一条 `被否决的选项与原因` 是我从多个来源里挑出来的、初稿漏掉的一项：**没有它，模型会反复提议同一个被否决的方案**。

### 7.9 反思闭环（把 TradingAgents 的 memory 做扎实）

> **⚠️ 先定一个方向性问题：学习循环该瞄准什么？**
>
> 交易研究的结论很清醒：**交易"结果"是低效度环境**（Kahneman 的比喻是"更像掷骰子而不是打扑克"——单笔结果的噪音远大于信号）；而**交易"执行"是高效度环境**（快、无歧义、自生成的反馈：我有没有按自己的规则做）。
>
> 因此：**复盘应当瞄准"执行与流程"，而不是"预测"。** 一个可信的复盘流程能建立**执行技能**（纪律、一致性、偏离检测），**不能建立预测技能**。任何承诺后者的说法都是过度延伸。
>
> 对我们的直接后果 —— **学习循环要拆成两条，且权重不同**：

| 循环 | 瞄准 | 可测量性 | 权重 |
|---|---|---|---|
| **执行复盘（主）** | 计划 vs 实际是否一致：承诺有没有被忠实执行？W2（计划未覆盖）频率多少？有没有在窗口外即兴行动？止损有没有守住？ | **高**：二值、可自动判定、样本充足（每次执行都是一个样本） | **主** |
| **预测复盘（次）** | 论点方向对不对？regime 判断准不准？ | **低**：单笔结果被噪音主导，需要**大样本**才能与运气区分 | 次，且**必须攒够样本再下结论** |

**这也修正了 §4.4 计划卡的一个用途**：计划卡不只是"给代码执行的指令"，它同时是**执行复盘的基准** —— 有了它，"偏离"才成为一个可判定的事实而不是印象。这正是"预决策 → 执行 → 复盘"闭环能成立的原因。

**★ 一条必须接受的限制**：复盘流程的价值**未被实证证明能提升交易绩效**（研究里找不到这样的研究；而"刻意练习"在职业领域只能解释**不到 1%** 的绩效方差）。所以：
- 不要把复盘当作"提升胜率的手段"来期待，它是**偏离检测与纪律工具**；
- **决策日志的价值主要在过程审计（可追溯、可问责、可回归测试），而不是在"让模型变聪明"。**
- 与之对应的纪律：复盘产出**不得自动改变策略参数**，只能**提案**（§7.6 的人审闸门）。

TradingAgents 用 markdown 文件 + "下次跑同一标的时补齐收益"；我们改成**显式结算队列**，并修掉它五个已知缺陷：

1. 决策落地时写 `decisions` 行，`reflection_due_at = now + horizon`（如 4h/24h，按策略设定），记录**基准**（crypto 用 BTC/ETH，**不是 SPY**）。
2. `SettlementScheduler` 作为**独立定时任务**扫描**全部** pending —— 而不是"只结算当前正在分析的标的"（TradingAgents 的 `_resolve_pending_entries` 只处理同标的，导致一次性标的的条目**永远悬空**）。
3. 结算算**交易级**而非决策级：按**实际仓位**、**扣除手续费/滑点/资金费**，给出净收益、alpha、MFE/MAE（最大有利/不利偏移）、是否触发止损。TradingAgents 用的是 5 根 bar 的收盘到收盘、忽略成本、且 `iloc` 偏移在 crypto（自然日）与股票（交易日）间**不可比**。
4. 轻量 LLM 生成 2–4 句反思（复用其 prompt 结构：方向对不对 / 哪部分论点成立 / 一条具体教训），写入 `lessons` 并追加到 `journal/YYYY-MM.md`。
5. 反思文本**只有经结算后才允许进入未来 prompt**（避免"未验证的自我叙事"污染决策）。

**反思写入的四条闸门**（依据 §7.4 的 Reflexion 消融结果，**这是硬性规则**）：

| 闸门 | 规则 |
|---|---|
| **外部验证** | 只在**机械的外部评估**之后写（成交回报 / 对账 / 结算数值 / 规则违背记录）。**绝不**因为"模型觉得自己做得不好"就写。 |
| **证据指针** | 每条反思必须携带**证据指针**（结算所用到的事件 ID、订单 ID、行情指纹），因此**可以被推翻**。 |
| **TTL 与上限** | 反思有**过期时间与条数上限**（仿 Reflexion 的 Ω=1–3），并按**当前 regime 相似度**检索，而不是全量注入。 |
| **不可自证** | 模型过去的总结**绝不作为新反思的"观测"输入** —— 否则就是自己给自己打分，正是"0.60 → 0.52"那条路径。 |

**必须一并修掉的四个实现级缺陷**：

| 缺陷（TradingAgents 实测） | 后果 | 我们的做法 |
|---|---|---|
| **评级回退静默变成 Hold** | `SignalProcessor` 解析失败返回 `REVIEW`，但记忆日志用 `parse_rating` 把解析失败的决策**静默记成 Hold** —— "拒绝表态"被当成"中性持有"写进学习历史 | 决策是**类型化对象**；`REVIEW`/`NO_TRADE` 是一等公民，信号、日志、记忆三处**必须一致**；schema 校验失败 → **拒绝执行**，绝不从散文回退解析 |
| **结算与"重跑同一标的"耦合** | 一次性标的永不结算；反思滞后 ≥1 周且依赖调度器恰好重温该标的 | 独立结算任务 + 全量扫描（上文第 2 点） |
| **记忆日志并发不安全** | 读全文 → 改 → `tmp.replace()`，读改写窗口**无锁**；两个进程同时结算会静默丢失一方的反思（长跑多标的场景下这是**必然的数据丢失**） | 落 **SQLite + 事务**，多写者安全；markdown 只作**只读审计产物** |
| **无幂等/无 run 身份** | `_log_state` 用 `open(...,"w")` 覆盖；`store_decision` 的守卫只在 pending 期间生效，结算后重跑会**追加第二条**同标的同日期条目，之后被当成两条不同的教训 | 每条决策有 `decision_id` + **内容哈希** + "是否已执行"标记；写入用 `INSERT OR IGNORE` / 唯一键 |

**记忆检索（何时注入什么）**：
- 默认：同标的最近 3 条**已结算**决策 + 最近 5 条跨标的教训（对应 `past_context`）
- **注入面要更宽**：TradingAgents 的 `past_context` **只到达 Portfolio Manager**（尽管状态文档声称"run 开始时注入"，且反思提示词自称"会被未来的分析师重读"——实际上分析师根本看不到）。我们要在**分析师与辩论阶段也注入相关切片**，否则"复盘教训"影响不到产生论点的地方。
- 进阶：按**市场状态相似度**检索（波动率分位、趋势强度、资金费率状态分桶后做 key 匹配），而非纯时间近邻
- 反确认偏误：同时注入**反方教训**（同类形态下的失败案例），并要求裁决者显式回应

### 7.10 记忆检索实现路径（P1/P2 分步）

- **P1（简单可靠）**：自建 `trade_recall(query|symbol|regime, k)` 工具，SQLite + FTS5，模型按需调用；再用上下文组装器按固定 token 预算（如 800）注入（§7.8 的 C5）。
- **P2（增强）**：既可以把记忆服务做成 **MCP server**（`dsh-mcp-client` 一行挂载，工具自动变成 `mcp__memory__*`），也可以在插件内做向量索引。MCP 路线的好处是记忆服务可独立升级/复用，且不污染插件包体积。

> 注意：DSH 的 `dsh-spill-*` 负责"大结果转存"，session 查询负责"会话全文检索"，但**都不是交易记忆** —— 交易记忆必须自建，因为它需要结构化字段（决策、结果、形态、regime）而非文本相似度。

---

## 8. Crypto 交易层（执行与数据）

### 8.1 数据层：以 CCXT 为基础

**接入统一走 [CCXT](https://docs.ccxt.com/)**（首选 HTX，见 §8.2）。用 CCXT 而不是裸 WS 的三个理由：

1. **统一 API**：行情/盘口/成交/订单/持仓/余额在 100+ 交易所是同一套方法与返回结构，换所成本极低（这直接服务于"标的由 agent 自主选择"，因为试点交易所可以随时增加）。
2. **`has` 与 `features` 能力声明**：**这是最关键的一点** —— 各家对止损/追踪止损/触发单的支持不一致，CCXT 提供**粗粒度 `has` 标志**（如 `has['createTrailingPercentOrder']`）与**细粒度 `features` 块**（按市场类型声明 `createOrder` 是否支持 `triggerPrice`/`stopLossPrice`/`trailingPercent`）。
   > **工程要求**：**在运行时按能力开关（feature gate）决定策略路径，而不是假设统一符号就等于统一能力。** 发现能力缺口的时机应当是**启动自检**，而不是生产环境里的下单被拒。
3. **CCXT Pro 提供 WebSocket 流式**（`watchOHLCV` / `watchOrders` / `watchTicker` 等），并支持多语言（JS/TS、Python、PHP、C#、Go、Java、Rust）—— 这与 §8.5 的跨语言方案天然契合。

**数据来源（按优先级）**：
1. **行情**：CCXT Pro WS（kline/trade/orderbook）。主用一家，**另接一家做交叉校验**（价差异常往往先于事故出现）。
2. **衍生品**：资金费率、基差、持仓量 OI、**强平流**（crypto 特有、信息量极高）。
3. **链上/宏观**：稳定币净流入、交易所净流入、宏观日历（CPI/FOMC）。
4. **情绪**：恐慌贪婪指数、社媒（注意注入风险，只作特征，不作指令）。

**硬性规则**：
- **只用已收盘 bar**：`bar_close_time <= now`，禁止使用未收盘 K 线的 OHLCV（这是加密货币最常见的隐性前视）。
- **CCXT 的 `fetchOHLCV` 返回的最后一根通常是"进行中"的 bar** —— 必须显式丢弃或标记，这是接入时最容易踩的坑之一。
- **时间戳统一**：CCXT 普遍使用**毫秒**时间戳，且部分字段可能是 `undefined`（各所填充程度不同）。落库前要归一化并显式处理缺失，**不要假设字段一定存在**。
- **交易所差异必须显式建模**：符号表示（`BTC/USDT` vs `BTC/USDT:USDT` 永续）、精度与最小下单量（`market.precision` / `market.limits`）、合约乘数、限频（`rateLimit` / `enableRateLimit`）。这些**不能靠默认值**，要在启动时读取并校验。
- 所有数据落**带时间戳的库**，记录 `fetched_at` 与 `source`；`(symbol, timeframe, open_time)` 唯一键，**upsert 而非 append**（交易所会回补/修正）。
- 时间同步：签名私有接口对时间漂移敏感（HTX 尤其），启动时校准服务器时间并持续监控偏移。
- 指标增量计算（EMA/ATR/RSI）由代码维护状态，**不重算全历史**；每根 bar 收盘统一刷新一次特征快照。
- **交易所未默认提供的指标，由 agent 自己算**（见 §8.5）—— 这正是代码执行能力的用途。

### 8.2 执行层：CCXT 的 `createOrder` + `params`（最危险的地方）

好消息是：**CCXT 已经把"服务端止损/止盈/追踪止损/触发单"统一到同一个 `createOrder` 的 `params` 里**。CCXT 自己的说法很直接：

> "Most bots use exactly two order types — `market` and `limit` — and re-implement everything else in application code: watching prices in a loop, firing a market order when a level breaks. **That works until your process crashes, your connection drops, or you're asleep while it happens. Exchanges already run these order types natively, server-side, for free.**"（[order types guide](https://docs.ccxt.com/blog/order-types-guide)）

这条直接决定我们的架构选择 —— 统一参数：

| 参数 | 用途 |
|---|---|
| `triggerPrice` | 通用触发单（睡觉在交易所，触价后激活为市价/限价） |
| `stopLossPrice` / `takeProfitPrice` | 保护性止损 / 止盈（**衍生品必须配 `reduceOnly: true`**，防止误单**反手开仓**） |
| `trailingPercent` / `trailingAmount` | 追踪止损（HTX 额外要求 `trailingTriggerPrice`） |
| `postOnly` | 只做 maker |
| `timeInForce: 'IOC' / 'FOK'` | 立即成交否则取消 / 全成或全取消 |
| **`clientOrderId`** | ★ **我们自己的幂等键** —— CCXT 明确称其为"the fix for the retry-after-timeout trap" |

**HTX 的能力已从 CCXT 源码核实**（`ts/src/htx.ts`）：`createTriggerOrder` / `createStopOrder` / `createStopMarketOrder` / `createTakeProfitOrder` / `createTrailingPercentOrder` **均为 `true`**，`clientOrderId` 亦受支持；**但 `createOrderWithTakeProfitAndStopLoss`（原子括号单）不支持** —— 即"入场+止损"需要**分两步**下单，这带来一个必须处理的窗口：**入场成交了但止损还没挂上**。见下方"两个必须处理的风险"。

**Broker 适配器接口**（同一份代码跑纸面/测试网/实盘，避免"回测能跑、实盘不能跑"）：

```
interface Broker:
  getAccount() / getPositions() / getOpenOrders()
  placeOrder(intent with clientOrderId) → ack
  placeProtective(symbol, stopLossPrice?, takeProfitPrice?, trailingPercent?, reduceOnly=true)
  cancelOrder(id) / cancelAll(symbol?)
  subscribeUserData(cb)          // 成交/持仓推送：CCXT Pro watchOrders / watchMyTrades
实现：PaperBroker（本地撮合 + 真实盘口 + 滑点模型）／ CcxtBroker(htx) ／ 未来其他所
```

**下单必须满足的五条**：
1. **幂等**：`clientOrderId = hash(planId, intentSeq)`，重复提交同一 ID 不会重复成交。
2. **意图先落库**：先写 `order_intents`（`created`），再发请求，收到 ack 置 `acked`。崩溃时用 `created` 但无 ack 的记录按 `clientOrderId` 去交易所查询。
3. **启动即对账**：启动后立即比对"本地订单/持仓"与"交易所真实"；孤儿订单 → 撤销；未知持仓 → **告警并冻结自动交易**（绝不"猜"）。
4. **滑点/深度校验**：下单前读盘口估算滑点；超阈值或深度不足则拒绝或降级为限价单。
5. **降级路径**：私有接口连续失败 N 次 → 停止开新仓（可平不可开）并告警。**"不能开仓"永远比"乱开仓"安全。**

**★ 两个必须处理的风险**（出自 CCXT 自己的警告）：

| 风险 | 说明 | 对策 |
|---|---|---|
| **止损不是保证价** | "a server-side stop-loss is a **risk tool, not a guaranteed price**. In a gap or a flash crash, a stop-market fills wherever liquidity is, and a stop-limit may not fill at all." | **止损限制的是常规亏损；限制灾难性亏损的是仓位。** 二者必须同时存在 —— 这也再次说明为什么仓位必须由公式计算而非模型给数 |
| **保护单的挂单窗口** | HTX 不支持原子括号单，入场与止损分两步 ⇒ 存在"已成交但未受保护"的时间窗 | ① 入场后**立即**挂保护单，并把该窗口视为**已知暴露**；② 保护单挂失败要触发**降级**（立即平仓或冻结）；③ 对账时把"有持仓但无保护单"列为**高优先级不一致** |

### 8.3 关键：止损绝不依赖 LLM


- 开仓成交后**立即**在交易所侧挂条件单（止损/止盈），或由插件硬闸毫秒级触发。
- LLM 的职责是"是否开仓、多大仓位、是否调整逻辑"，**不是**"价格跌到 X 时记得卖出"。
- 若交易所不支持所需条件单类型，插件侧必须有独立的 `StopGuard` 循环（与 agent 完全解耦，即使 LLM 宕机也执行）。
- **止损/止盈必须由代码数值化推导**（ATR 倍数、结构位、资金费率成本），而不是让 LLM 写一段 `position_sizing: "5% of portfolio"` 的自由文本——TradingAgents 正是这么做的，然后把它丢弃。

### 8.4 直接借鉴 TradingAgents 的两个数据层设计（它的真正资产）

**① 时点（PIT）纪律** —— 这套是成体系的，值得照搬思路：
- 所有时间窗用**同一个** UTC 半开区间辅助函数（`in_window`），而不是每个数据源各写一遍；
- **无日期的时间戳条目**在回看历史时**保守丢弃**（"在回测里我们无法证明它不是未来的"）；
- **供应商的"当前快照"类接口在历史运行中必须整个撤下**（TradingAgents 的 `withhold_live_profile`：概览类接口没有历史版本，连名称/板块都不该给）；
- 宏观数据按 **vintage（发布时点）** 钉定，而不是按观测期；
- 财报按**申报日**过滤，而不是按**财季结束日**（TradingAgents 这里**做错了**，留下 3–6 周的隐性前视——我们要修）；
- 记忆检索按 `resolved <= as_of` 门控，避免用未来才知道的结果解释过去的决策。

> 对我们的 crypto 版本：`bar_close_time <= now`、`funding_settle_time <= now`、`liq_event_time <= now`、新闻按 `published_at`（不是抓取时间），并给**每个**数据点存 `observed_at` 与 `source`。每次决策把用到的数据指纹（`context_hash`）落库，以便事后证明"当时能看到什么"。

**② 供应商路由契约** —— 显式链式 + 行为化错误分类：
- 配置形如 `"primary,fallback"` 的**有序链**，且**配置的列表就是链**（没有隐式兜底）；
- 错误按**行为**分类（无数据 / 限流 / 未配置），而不是按供应商：无数据→**记住并继续**、限流→跳过、未配置→跳过并备忘、其他异常→告警并跳过；
- 终结时返回**明确哨兵**让模型知道"不要编数字"：`NO_DATA_AVAILABLE: … Do not estimate or fabricate values`；
- **core 类数据**（行情）全链失败 → 抛错终止本轮；**optional 类数据**（宏观/预测市场）→ 降级为 `DATA_UNAVAILABLE` 继续。

**③ 数据源不可用时的正确语义**：**"跳过这一轮"而不是"崩溃"**，但也**绝不"用旧数据假装新数据"**。TradingAgents 的 core 类别会直接抛错中断整个图——在 7×24 场景下，正确做法是跳过本轮并告警（§10.3）。

### 8.5 ★ Agent 的代码执行能力 = 无限可扩展的指标层

这是本项目一个**被低估的关键设计点**：**不要把"agent 能算的指标"限制在我们预置的工具集里。**

真实交易员本来就会用脚本做分析；agent 更应当如此。交易所与 CCXT 默认提供的是**原始数据**（OHLCV、盘口、成交、资金费率、持仓量），而**决策真正依赖的指标往往是派生出来的**：

- 标准 TA：EMA/RSI/ATR/布林带/ADX/MACD —— 这些我们可以预置（高频、稳定）。
- **非标准/组合指标**：跨周期结构、量价背离、跨标的价差与相关性、基差与资金费率的联合状态、清算簇分布、波动率分位、订单流/成交流不平衡、自定义的 regime 分类器 —— **这些没法穷举，也不该穷举。**

**因此架构上要分两层**：

| 层 | 内容 | 谁来算 | 理由 |
|---|---|---|---|
| **内核指标层** | 高频、稳定、被规则引擎在**每根 bar** 求值的指标 | **代码预置**（增量维护） | 必须在毫秒级、可回测、可审计；不能每次起一个进程 |
| **代码执行层** | 罕见、临时、探索性的派生指标 | **agent 现场写代码算** | 无法穷举；这正是 agent 的价值所在 |

**工程要点（思路与坑，不锁具体实现）**：

1. **必须返回"值 + 数据指纹 + `as_of`"**，而不只是数值。否则一次现场计算会污染 PIT 纪律（§8.4 ①）—— 事后无法证明"当时用的是什么数据算出来的"。
2. **计算必须只读且可复现**：同样的输入 + 同样的代码 → 同样的输出。禁止在计算脚本里访问网络或下单（沙箱 + 只读数据句柄）。
3. **产出要能"转正"**：某个临时指标如果被反复使用，应当**提升为内核指标**（有测试、有回测支持）。否则会积累一堆只有 agent 自己看得懂的临时脚本。
4. **成本与延迟**：现场计算有启动开销，**不适合放进每根 bar 的规则求值路径**（§4.4 的"谁来求值"问题点）。
5. **缓存**：同 (代码哈希, 数据指纹) 的结果应可缓存复用。

**关于跨语言**（决策点 5：可以跨语言，只要依赖存在、调用与传输不受限）：

- **CCXT 本身就支持 7 种语言**（含 JS/TS 与 Python）—— 这意味着**两侧都能用同一个库读同一批数据**，不必为跨语言重写数据接入。
- **推荐分工**：**核心循环与执行用 TS**（与 DSH 同栈、进程内、低延迟），**重度数值分析用 Python**（生态成熟）。两侧通过**共享市场数据存储**交换数据，而不是互相 RPC 传大数据。
- **要注意的问题点**：
  - **依赖可重现**：跨语言意味着两套依赖树，必须都能被锁定与重建（容器化正好解决，见决策点 6）。
  - **时间与精度**：浮点、时区、毫秒/微秒时间戳在跨语言边界上极易出错 —— 定义**统一的时间与数值规范**（如统一毫秒整数时间戳、金额用字符串或定点数传递）。
  - **不要用跨语言链路做高频路径**：进程间通信用于"研究与探索"，不用于"每根 bar 的求值"。
  - **能力探测**：启动时自检各语言的运行时与关键依赖是否可用，缺失要**明确报错**而不是静默降级。

> **一句话**：预置指标保证**速度与可回测性**，代码执行保证**开放性**；两者不可互相替代。而"agent 能自己写代码算指标"这件事，恰恰是它与固定规则系统相比唯一真正的能力优势。

---

## 9. 权限分级与安全护栏

### 9.1 三档运行模式

| 档位 | 数据 | 下单 | 人工确认 | 用途 |
|---|---|---|---|---|
| `paper` | 实时公开行情 | 本地模拟撮合 | 无 | 开发、回放、策略打磨 |
| `live_confirm` | 实时 | 测试网/小额实盘 | **每单确认**（`tools/pre-execute` 返回 `ask`） | 可选：上线首周；非默认 |
| `live_auto` | 实时 | 实盘 | **无人工确认** | ★ **本项目的目标档位** |

**★ 本项目的目标形态是 `live_auto`：`non-human in the loop`。**

这是决策点 2 明确的：**不硬性要求有人在特定时间审核**。这与多数 agent 系统的隐含假设（"高风险动作等人确认"）不同，因此有三条设计后果必须写清：

| 后果 | 说明 |
|---|---|
| **`ask` 不能成为常规路径** | 如果系统依赖"等人点确认"，那它在无人时就是**停摆**的。`ask` 只能作为**可选的过渡档**（`live_confirm`），不能是主流程。**默认路径必须能在无人值守下走完。** |
| **审计取代确认** | 因为没有人当场把关，**"事后可审计"就成了唯一的质量保证**。这不是附加功能，而是**替代人工审核的核心机制** —— 见下方"审计优先"要求。 |
| **风控必须在事前是确定性的** | 没有人在环 ⇒ 唯一的保护是**代码硬闸 + 交易所侧保护单 + 心跳熔断**。任何"以后人工处理"的兜底都等于没有兜底。 |

**★ 审计优先（`audit-first`）：因为没有人在场，历史必须能回答一切**

决策点 2 的后半句是关键：**保存大部分工作的历史，以便人在任意时间审计和介入**。落到设计要求上：

1. **全量落库，而非只落结果**：审议过程（读了什么、算了什么、辩论了什么、否决了什么）、规则命中、意图、订单、成交、对账结果、参数变更 —— **都要可回放**。
2. **任意时点可重建"当时可见的信息"**：这就是 §7.8 的 `ctxHash` 与 §8.4 的 `data_fingerprint` 存在的理由 —— **没有它们，事后审计只能看结论，无法判断结论是否合理**。
3. **区分"记录"与"推断"**：日志里必须能分清哪些是**权威事实**（订单、成交、余额）、哪些是**模型生成的推断**（论点、反思）。这是 §7.4 铁律在审计面的要求 —— 否则事后无法判断错误出在哪一层。
4. **介入是异步且随时可用的**：`/halt`、改限额、切档位等命令**任何时刻都能执行**，且**立即生效**（不等当前回合结束），并作为审计事件留痕。
5. **不可否认性**：任何"谁在什么时候改了什么"都要留痕；模型的行为与人的干预在日志里**可区分**。

> **一句话**：`non-human in the loop` 不是"去掉监督"，而是**把监督从事前移到事后，把确认换成审计**。所以**审计能力必须比常规系统更完整**，而不是更少。

**同意的边界**：本项目**不提供**"无需审计、不可介入"的形态。全自动指的是**执行不需要等人**，不是**行为不需要留痕**。

### 9.2 硬闸（代码里，不是 prompt 里）

> **一句话原则**：**"提示词里的限额是提示，校验器里的限额才是限额。"**
>
> 与之配套的形态是：**模型提议，确定性系统裁决**（agent proposes, deterministic system disposes）。模型产出的是**意图**；意图**必须先通过一个独立校验器**才能写入事件日志并触达交易所。校验器只读结构化参数，**永不读模型的理由文本**。

```ts
// 伪代码：tools/pre-execute 全局监听 + 交易工具内部二次校验（双保险）
// 更准确的说法：这不是"工具里的一个检查"，而是"意图进入日志前的唯一闸门"
validateIntent(order, portfolio, config):   // 提议 → 裁决 → 才允许落库/下单
  if mode == 'paper' && order.venue != 'paper'        -> deny
  if not withinTradingWindow()                        -> deny   // 如重大宏观事件前后 N 分钟
  if |newNotional| > perOrderCapUsd                   -> deny
  if |totalExposure| > maxExposureUsd                 -> deny
  if leverage > maxLeverage                           -> deny
  if dailyLoss > dailyLossLimit || drawdown > ddLimit -> deny
  if consecutiveLosses >= n || spreadBps > maxSpread  -> deny
  if duplicateDecision(order.decisionId)              -> deny   // 幂等
  if openOrders >= maxOpenOrders                      -> deny
  return allow
```

**这道闸门的三个设计要点**：
1. **它在模型的"外部"**：模型没有绕过它的工具，也没有"申请豁免"的通道。**闸门读的所有阈值都来自启动时写入的参数集**（§14 决策点 3/7），运行时只能由人通过命令修改，且改配置本身是一条审计事件。
2. **它读结构化字段，不读散文**：数量/价格/止损/杠杆是数值；理由文本**永不参与判定**。这样"模型说服自己"不构成风险。
3. **它同时是写入门禁**：通过校验的意图**才**被写入 `order_intents`，因此"日志里的每一条意图都是已通过校验的"是一条可断言的不变量。

另需：
- **心跳与启动恢复**：主进程每 N 秒更新心跳用于 liveness/审计；dsh 退出由 Docker 重启，启动时先跑 `CrashRecovery` 再跑 `reconcile`，未知状态 fail-closed 冻结，不启动外部 watchdog。
- **紧急停止**：Web GUI 一个红色按钮（插件注册 command），触发后置 `halted` 并撤单；**恢复必须人工**。
- **密钥隔离**：API key 走 DSH 凭据机制（`$DSH_HOME/.credentials.yaml` + `dsh-credentials-local`，profile 里用 `!!js process.env.X` 引用），**绝不写进仓库/配置/prompt**；实盘 key 只开交易权限、**禁用提现**；`paper` 与 `live` 用不同 profile。
- **HTX 保护单窗口**：入场成交后**立即**挂 `stopLossPrice`/`takeProfitPrice`（`reduceOnly: true`）；挂失败即降级（平仓或冻结），并把"有持仓无保护单"列为对账高优先级不一致（§8.2）。

### 9.3 提示注入防护

外部文本（新闻标题、社媒、链上标签）是不可信输入：
- 统一包裹为显式数据块并标注来源与不可信标记；
- 记忆写入前做模式检查（拒绝"忽略以上指令"类文本进入 `playbook.md`）；
- 交易工具的最终授权**永远不读取**模型提供的理由文本，只看结构化参数 + 硬闸。

---

## 10. 部署、持久化与可观测性

### 10.1 进程模型

```
Docker restart policy
   └─ dsh --profile trade            # 唯一主进程；插件在 profile 内，随进程启动即开始盯盘
        ├─ MarketWatcher（WS + 规则引擎）
        ├─ DeskSupervisor（会话恢复 + followup 投递）
        ├─ SettlementScheduler（结算 + 反思）
        └─ HeartbeatGuard（熔断）
```

- 主进程存活时不依赖浏览器；Web GUI 只作观测与人工干预。
- **崩溃恢复路径**：`MarketWatcher` 重启 → 从 SQLite 恢复最后处理的 bar；`DeskSupervisor` 用固定 `sessionId` 调 `ctx.agents.resume()` 继续同一会话（历史完整保留）；未 ack 订单走对账。

### 10.2 定时与长任务的正确定位

| 需求 | 用什么 | 备注 |
|---|---|---|
| 秒级盯盘 | 插件常驻服务 | 唯一可行 |
| 分钟/小时级审议窗口 | 插件 `setInterval` + TriggerQueue | 比 `dsh-schedule` 可控 |
| "提醒我 30 分钟后看结果" | `dsh-schedule`（Web 会话内） | 人机交互场景 |
| 长跑分析（如下载历史数据） | `dsh-jobs-local` + `dsh-tool-jobs` | 只作前台可见作业，**不作唯一真源** |
| 无人值守推进一个明确目标 | `dsh-goal` + `dsh-goal-round-driver` | 适合"完成一次迁移"，不适合交易循环 |

### 10.3 可观测性（必须从 P0 就有）

- **每次决策一条结构化记录**（context_hash、model_route、token 用量、耗时、触发来源）→ SQLite。
- **每笔订单/成交事件流** → `orders`/`fills` 表 + 日志。
- **成本看板**：按日/按标的聚合 token 与费用（`dsh-token-meter` + 自记）。
- **告警**：数据断流、对账不一致、连续拒绝、日亏损阈值、心跳异常 → 至少一条外部通知通道。
- **回放能力**：任意 `decision_id` 能还原当时看到的 Event Pack 与上下文摘要（Event Pack 必须落库，而不是只喂给模型）。

---

## 11. 插件包工程结构

### 11.1 目录

```
/workspace/                          # ★ 项目根 = DSH 会话工作目录
├── docs/dsh-crypto-trading-agent-plan.md      # 本计划
├── research/TradingAgents/                    # 参考实现（commit be952b8 / v0.4.x）
├── research/TradingAgents-architecture-analysis.md
├── .dsh/skills/                     # ★ 项目级 skill 根（dsh-skill-filesystem 自动扫描）
│   ├── trading-playbook/SKILL.md    #   交易手册：按需加载，常驻 prompt 前缀
│   ├── funding-basis/SKILL.md       #   如何读资金费率/基差
│   └── liq-cascade/SKILL.md         #   如何处理清算潮
├── AGENTS.md                        # ★ 半固定上下文：标的池、时间框架、输出契约
└── dsh-trading-agents/              # ★ 插件包本体（独立 npm 包）
    ├── package.json                 #   声明 dsh.bundle.patch → 装包即挂载
    ├── cordis.patch.yml             #   一份补丁挂载全部行
    ├── README.md
    └── src/
        ├── index.ts                     # 插件入口：name / inject / Config / apply
        ├── config.ts                    # schemastery Config（阈值、模式、限额）
        ├── market/
        │   ├── feed.ts                  # WS 行情接入 + 重连 + 心跳
        │   ├── archive.ts               # bar upsert 到 SQLite
        │   ├── features.ts              # 增量指标（纯函数，可单测）
        │   └── rules.ts                 # 规则引擎（纯函数，不调模型）
        ├── trigger/
        │   ├── engine.ts                # 去重、冷却、限流、分级
        │   └── queue.ts                 # TriggerQueue（SQLite 持久队列）
        ├── memory/
        │   ├── schema.ts                # decisions / outcomes / orders / fills / lessons
        │   ├── journal.ts               # journal/*.md 追加与轮转
        │   └── recall.ts                # FTS 检索 + regime 分桶
        ├── exec/
        │   ├── broker.ts                # Broker 接口
        │   ├── paper.ts / ccxt.ts       # 实现
        │   ├── gate.ts                  # 硬闸（纯函数）+ 单测
    │   └── reconcile.ts             # 启动/周期对账
        ├── agents/
        │   ├── prompts/                 # 各角色提示词（TS 模板，可版本化）
        │   ├── tools/                   # defineTool 定义（按角色分组）
        │   └── roles.ts                 # 角色 → 工具白名单 + 模型路由
        ├── supervisor/
        │   ├── desk.ts                  # 会话恢复、followup 投递、优先级抢占
        │   ├── settle.ts                # 结算 + 反思调度
        │   └── heartbeat.ts             # 熔断
        └── plugins/                      # 各 cordis 插件 entry（被 patch 逐行挂载）
            ├── market.ts  rules.ts  memory.ts  exec.ts
            ├── tools-desk.ts  tools-research.ts  tools-risk.ts
            ├── supervisor.ts  commands.ts
```

**为什么把仓库放在 `/workspace` 根**（而不是随便一个目录）：
- `dsh-skill-filesystem` 按 **project root = 最近的含 `.git` 的祖先目录** 扫描 `<projectRoot>/.dsh/skills`，所以在 `/workspace` 下建 `.dsh/skills/` 才会被自动发现（§2.4）。
- `dsh-agent-instructions` 加载"从项目根到会话工作目录"的 `AGENTS.md` 链，`/workspace/AGENTS.md` 正好是那把"半固定上下文"的落点（§7.1）。
- 会话工作目录是 `/workspace`，插件的数据目录仍走 `dshHomePath('trading/...')` 落在 `$DSH_HOME`（与代码分离，便于备份与`.gitignore`）。

### 11.2 包清单要点

```jsonc
{
  "name": "dsh-trading-agents",
  "type": "module",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },   // ★ 自动进入 profile bundles
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-system-prompt": "*",
    "@deepseek-ai/dsh-session": "*"
  },
  "dependencies": { "better-sqlite3": "...", "ws": "...", "ccxt": "..." }
}
```

### 11.3 补丁骨架（`cordis.patch.yml`，示意）

```yaml
- insert:
    - id: trade-db
      name: 'dsh-trading-agents/db'
      config: { path: !!js dshHomePath('trading/desk.db') }

    - id: trade-market
      name: 'dsh-trading-agents/market'
      config:
        venue: binance
        symbols: [BTC/USDT, ETH/USDT]
        timeframes: [1m, 15m, 1h]
        crossCheckVenue: okx

    - id: trade-rules
      name: 'dsh-trading-agents/rules'
      config: { rulePacks: [mean_reversion_v1, funding_extreme_v1], cooldownMs: 900000 }

    - id: trade-exec
      name: 'dsh-trading-agents/exec'
      config:
        mode: paper                     # paper | live_confirm | live_auto
        perOrderCapUsd: 200
        maxExposureUsd: 2000
        maxLeverage: 2
        dailyLossLimitUsd: 100
        apiKey: !!js process.env.TRADE_API_KEY
        apiSecret: !!js process.env.TRADE_API_SECRET

    - id: trade-supervisor
      name: 'dsh-trading-agents/supervisor'
      config:
        deskSessionId: 'trade-desk-btc'
        l2: { provider: deepseek-official, model: deepseek-flash }
        l3: { provider: deepseek-official, model: deepseek-reasoner }
        l3MinIntervalMs: 14400000
        dailyBudgetUsd: 5

    - id: trade-tools-desk
      name: 'dsh-trading-agents/tools-desk'      # 交易员：propose/execute/portfolio/journal
    - id: trade-tools-research
      name: 'dsh-trading-agents/tools-research'  # 分析师：只读行情/衍生品/新闻
    - id: trade-tools-risk
      name: 'dsh-trading-agents/tools-risk'      # 风控：限额/相关性/压力测试

    - id: trade-command-halt
      name: 'dsh-trading-agents/commands'       # /halt /resume /mode /limits
```

### 11.4 工具清单（按角色白名单）

| 角色 | 工具 | 关键点 |
|---|---|---|
| 分析师（只读） | `trade_market`、`trade_derivatives`、`trade_news`、`trade_onchain` | 全部只读；返回结构化摘要 + 数据指纹 |
| 研究/辩论 | `trade_recall`、`trade_regime` | 只读记忆与市场状态 |
| 交易员 | `trade_portfolio`、`trade_propose_order`、`trade_order_status` | `propose` 只产出**意图**（不触达交易所） |
| 风控 | `trade_risk_check`、`trade_stress_test`、`trade_limits` | 纯计算 + 读限额；**不能**下单 |
| 裁决/执行 | `trade_execute_order`、`trade_cancel`、`trade_record_decision`、`trade_workflow_run` | 执行工具内部**强制**再验一遍硬闸 |
| 元循环 | `trade_review`、`trade_playbook_update` | 人审后才写入 playbook |

**设计原则**：`propose` 与 `execute` **必须分离** —— 让"想"和"做"之间存在一个可审计、可拒绝、可人工插入的缝隙。TradingAgents 的 `entry_price`/`stop_loss`/`position_sizing` 就是"有意图、无执行"的**反面教材**：它们被渲染成 markdown 后**没有任何代码读回**，风控形同虚设。

**决策对象必须是类型化且被强制的**（TradingAgents 的结构化输出是"尽力而为"：`bind_structured` 静默降级、异常后重试为纯文本，最后用**正则**从散文里抠评级）。

> **同样的粒度说明**：这里**不锁定字段**（理由同 §4.4）。只规定**必须成立的约束**：

| 约束 | 理由 |
|---|---|
| **动作是一个封闭枚举**，且包含"不动"与"拿不准" | 没有"自由发挥"这个选项；`NO_TRADE` 表示"看过，不动"，`REVIEW` 表示"拿不准，升级给人"——两者都是**合法且应当常见**的输出 |
| **数量/价格/止损必须是数值**，不是 `"5% of portfolio"` 这类字符串 | TradingAgents 正是把它渲染成 markdown 后丢弃；字符串无法被风控校验，也无法被代码执行 |
| **止损/止盈由代码数值化推导**（ATR、结构位等），模型只指定"用哪个方法、什么参数" | 避免模型给出危险的具体数字 |
| **每个意向带幂等键 + 内容哈希** | 重复提交、崩溃恢复、审计都要靠它 |
| **理由文本与判定字段分离**，且**风控永不读理由文本** | 这样"模型说服自己"不构成风险（§9.2 第 2 点） |
| **schema 校验失败一律拒绝执行** | 不允许"回退成纯文本再正则解析"——这是 TradingAgents 的 `REVIEW`→静默 `Hold` 缺陷的根因 |

### 11.5 插件入口最小骨架（已核对真实 API）

```ts
// src/plugins/tools-research.ts —— 函数式插件：导出 name / inject / Config / apply
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'trade-tools-research'
export const inject = ['tools', 'systemPrompt']      // 缺任一服务时 apply 不运行，服务替换后重跑
export const Config = z.object({ maxBars: z.number().default(500) })

export function apply(ctx: Context, config: { maxBars: number }) {
  // 只对「分析师」这一作用域可见的只读工具；用 ctx.effect 托管生命周期
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trade_market',
    description: '只读：取已收盘 bar 与指标快照。绝不返回未收盘 K 线。',
    parameters: {
      symbol:    { type: 'string', required: true },
      timeframe: { type: 'string', required: true, enum: ['1m','15m','1h','4h','1d'] },
      bars:      { type: 'number', description: `1..${config.maxBars}` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },   // 嵌套 object 必须显式声明
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('aborted')
      return market.queryClosedBars(args.symbol, args.timeframe, Math.min(args.bars ?? 200, config.maxBars))
    },
    presentCall: (a) => ({ card: 'generic', title: `读行情 ${a.symbol} ${a.timeframe}`, kind: 'read' }),
  })), 'trade.tools-research')
}
```

**给 desk / 子角色装配工具白名单与提示词**（在 `setup(agentCtx, agent)` 里做，组合完成前就位）：

```ts
const handle = await ctx.agents.resume({
  resumeSessionId: deskSessionId,
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
  setup(agentCtx, agent) {
    agentCtx.systemPrompt.section({
      name: 'trade:constitution', order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: TRADING_CONSTITUTION,           // 风控宪法：硬性纪律，非建议
    })
    agentCtx.systemPrompt.context({
      name: 'trade:desk-state', order: 200,
      text: () => renderDeskState(livePortfolio()),   // 每步求值 → 新鲜持仓/限额
    })
    agentCtx.tools.restrict({ allow: DESK_TOOL_ALLOWLIST, deny: ['trade_execute_order'] }) // 例：只读模式
  },
})
// 触发到达时（无新信息则完全不唤醒，零 token）：
// ★ notice.summary 有 120 字符硬上限（CONTEXT_SUMMARY_MAX_CHARS），一句话摘要要极简
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: renderEventPack(trigger) }],
  source: { kind: 'plugin', plugin: name, form: 'notice',
            summary: `W2 ${trigger.symbol} 计划未覆盖: ${trigger.ruleId}` },   // ≤120 字符
}))
```

---

## 12. TradingAgents → DSH 映射总表

| TradingAgents 组件 | DSH 落点 | 循环化改造 |
|---|---|---|
| `TradingAgentsGraph`（LangGraph 图） | `workflow` 工具脚本 + continuable subagent | 外层由 TriggerQueue 反复调用；内层辩论用 `while` 计数器 |
| 4 个 Analyst 节点 | 4 个 spawn 子 agent（`parallel`），轻量模型 | 输入改为 crypto 数据包；输出**结构化**报告 |
| `Msg Clear X` 节点 | 无需（子 agent 上下文天然隔离） | — |
| Bull/Bear Researcher | 2 个 spawn 子 agent，`while(rounds<max)` | 保留计数器终止 + 新增"论据收敛即停" |
| Research Manager | 深度模型子 agent，结构化输出 | 记忆注入**同时给分析师与辩论方**（它只注入了 PM） |
| Trader | desk session 内的主 agent（或子 agent） | 输出 `OrderIntent` 结构化对象，**数值化**的 size/stop，非自由文本 |
| Risk Debators ×3 | 3 个 spawn 子 agent + 确定性风控工具 | 风控**同时**由代码硬闸强制；**不让任何角色"为提案辩护"** |
| Portfolio Manager | desk session 内的裁决步（深度模型） | 输出经 `trade_execute_order` 才生效；`NO_TRADE`/`REVIEW` 是合法输出 |
| `TradingMemoryLog`（memory.md） | `decisions`/`lessons` 表（SQLite + 事务）+ 只读 `journal/*.md` + `trade_recall` | 独立结算任务扫描**全部** pending；`decision_id`+`content_hash` 保证幂等 |
| `Reflector` | 轻量模型 + 结算调度器 | 异步、幂等、可追溯；收益按**交易级净额**（含费/滑点/资金费） |
| `conditional_logic.py` | workflow 脚本里的循环条件 | 参数来自 profile config，可热改；终止用**计数器 + 收敛判据**，不靠文本前缀匹配 |
| `default_config.py`（模块级全局 config） | 每插件的 schemastery `Config` + profile patch | 配置**按作用域**传递，天然避免它那种"同进程多模型互相污染" |
| CLI 交互（交互一次即退出，无调度器） | DSH Web GUI + 自定义 command（`/halt`、`/mode`）+ 常驻插件服务 | 人工介入面 + 7×24 循环 |
| yfinance/StockTwits/Reddit | 交易所 WS/ccxt + 资金费率/OI/清算 + 链上 | 全部带 `observed_at` 与源标识；显式供应商链 + 行为化错误分类 |
| LangGraph checkpointer（默认关闭） | DSH session 持久化（JSONL）+ 自己的 SQLite | `ctx.agents.resume()` 恢复；签名校验防止"图变了还静默续跑" |
| Token 计数（仅 CLI 显示、不持久化、无价格） | `dsh-token-meter` + 自建成本表 | 成本是一等指标：每轮/每日预算硬顶 + 看板 |

---

## 13. 分阶段路线图

| 阶段 | 目标 | 交付物 | 验收标准（必须可自动验证） |
|---|---|---|---|
| **P0 骨架**（1–2 周） | 打通"数据 → 规则 → **plan 匹配** → 纸面执行 → 落库"，同时完成 §4.6 的两个最小闭环验证 | `market`/`rules`/`planstore`/`exec`(PaperBroker)/`db`；**最小探针**（resume+followup+`snapshot`/`notice` 语义确认）；**R5 压测脚本** | `--dump-config` 显示全部行；离线回放 30 天，**同一 bar 重复回放零重复下单**；规则命中时打印"匹配到哪条承诺 / 未覆盖"；探针确认产生 `assistant/message` 且渲染形态正确；24h 压测 RSS/句柄曲线平稳 |
| **P1 判断与计划卡**（2–3 周） | 审议窗产出可执行计划卡 + 记忆闭环 | `workflow` 脚本（含冲突消解）+ 角色提示词 + 全部工具 + 结算/反思 | 计划卡通过 schema 校验且**每条 `when` 都能被求值器执行**；24h 后自动生成反思；重启后 `resume()` 恢复且不重复决策；**W2 命中率可统计**（计划覆盖率是可观测指标） |
| **P1.5 通道有效性验证** | 用回放判定"盘中 LLM 介入"是否值得保留（§4.3 的验收标准） | 回放对比：A = 纯机械执行计划卡；B = 允许 W2/W3 唤醒 | **B 必须显著优于 A** 才保留该通道；否则关闭 W2/W3，退化为"纯窗口 + 机械执行"（这仍是一个完整可用的系统）。**这是防止"用算力买焦虑安慰"的量化闸门** |
| **P2 测试网实盘**（2–3 周） | 真实接口、幂等、对账、硬闸 | `CcxtBroker`、`gate`、`reconcile`、`heartbeat`、`/halt` | 断网/杀进程后对账**零孤儿订单**；重复 `clientOrderId` 只成交一次；心跳超时能撤单；**LLM 宕机时已挂条件单仍在工作** |
| **P3 小额实盘**（持续） | 受控自动化 | `live_confirm` → `live_auto`、限额、告警、成本看板 | 连续 N 天无对账错误/无风控绕过；**每窗口成本在预算内**；W2/W3 频率在阈值内 |
| **P4 离线整合**（长期） | 策略自适应（sleep-time） | 周级复盘、`playbook` 提案、regime 检索、M3 记忆块版本化 | 每周产出可读复盘；`playbook` 变更**必须人工批准**才生效；记忆块有版本与 diff，可回答"这个策略为什么被改掉了" |

**贯穿全程的四条纪律**：
1. 任何策略改动先过**离线回放**，再进 `paper`，再进测试网，最后实盘。
2. 每次事故都写进 `lessons` 并加一条**回归测试**。
3. 回测/模拟/实盘共用**同一份** `gate.ts` 与 `broker` 接口。
4. **新增任何 LLM 调用点，必须先回答"这为什么不能是条件与逻辑"** —— 答不上来就不加。（§4.5 的判据）

---

## 14. 决策点：已确定项与启动时参数

### 14.1 已确定（不再是待定项）

| # | 决策 | 结论 | 对设计的含义 |
|---|---|---|---|
| **1** | **标的范围** | ★ **由 agent 自主选择**，且**不限制同时持仓/观察的数量**，目标是广泛捕捉市场机会 | 见下方"开放标的的含义与代价" |
| **2** | **人在环程度** | ★ **`non-human in the loop`**：不硬性要求人在特定时间审核；但必须**保存大部分工作的历史**，支持**任意时间审计与介入** | §9.1 的 `audit-first` 要求；`ask` 不能是常规路径 |
| **3** | **风控参数** | ★ **不在设计阶段确定**。启动交易时由用户提供并写入；用户**明确知悉后可选择不提供**，风险自负 | 参数化注入，不写死；见 §14.3 |
| **4** | **交易所** | ★ **现阶段先接入 HTX** | §8.1/§8.2 已按 CCXT + HTX 能力核实 |
| **5** | **跨语言** | ★ **可以跨语言**，只要依赖存在、调用与数据传输不受限。理由：人类交易员也用脚本分析；agent 本应具备代码执行能力，可计算交易所未默认提供、但决策依赖的指标 | §8.5 |
| **6** | **部署形态** | 设想以 **DSH docker 容器**为本体运行；**暂不过多考虑**，首要目标是**与 DSH 集成良好** | 容器化正好解决跨语言依赖锁定（§8.5） |
| **7** | **风险偏好 / 1R** | 同 #3：**启动时参数** | 进仓位公式 |

**★ 开放标的（#1）的含义与代价 —— 这一条需要在实现时认真对待**

"agent 自主选标的、不限持仓数量"是本项目最有野心的部分，也是**成本与工程复杂度的主要来源**。它带来的不是"自由"，而是四类必须正面处理的问题：

| 问题 | 说明 | 应对思路 |
|---|---|---|
| **扫描成本** | 候选池越大，规则引擎求值量与数据订阅量越大 | **分层**：全市场只做**轻量筛**（价格/成交额/波动分位等廉价特征）→ 入围的才进入**完整指标与规则求值** → 极少数才进入**审议窗** |
| **数据订阅量** | WS 订阅无限增长会打爆内存与限频 | 按**流动性/成交额**动态挑订阅集，而不是"订阅一切"；观察名单**有上限且会轮换** |
| **承诺爆炸** | 每个标的都可能产出承诺 ⇒ 规则求值负担 | 只在**有持仓或已入围观察名单**的标的上求值完整承诺（§4.4 问题点） |
| **注意力稀释** | 模型面对过多标的同时判断，质量会下降（§7.1 上下文退化） | 审议窗**分主题/分批**处理，而不是一次喂进几十个标的 |
| **相关性风险** | 无限持仓会导致隐性同向暴露（例如全是 meme 币多头） | 组合层的**相关性/敞口聚合**必须在硬闸里做（§9.2），不能只靠模型自觉 |

> **建议的落地顺序**：先把"自主选标的"跑在**受限候选池**（如成交额 Top N 的永续合约）上，验证选标的与分层机制有效后再逐步放开。**"形式上不限"不等于"工程上不设界"** —— 界应当由流动性与成本决定，而不是由硬编码的白名单决定。

### 14.2 不再是"待你拍板"的项

上一版列出的 7 个决策点已全部有结论（见 §14.1）。其中 #3/#7 的性质变了：**它们不该在设计与实现阶段被定死**，而应当在**用户启动交易时**作为参数提供。

### 14.3 启动时参数（Trade Session Init）

**设计含义**：风控参数是**运行时输入**，不是代码常量，也不是配置默认值。因此：

| 要求 | 说明 |
|---|---|
| **启动时必须显式提供** | 参数集（单笔风险%、最大敞口、最大杠杆、日亏上限、标的范围、交易所、档位等）在**启动交易时写入**，落库并版本化 |
| **缺省即拒绝启动** | **没有参数的默认值**。系统不替用户"猜一个安全的数" —— 那会制造虚假的安全感 |
| **可显式放弃（风险自负）** | 用户**在明确知悉后果后**可以选择不提供风控参数。这是一条**一等公民路径**，不是隐藏后门 |
| **放弃必须留痕** | 放弃风控是一次**显式的、被记录的、可审计的决定**：写入会话日志、在启动摘要里明确回显、并允许随时补上参数（补上即刻生效） |
| **参数变更即时生效且留痕** | 运行中修改参数立即作用于硬闸，并作为审计事件记录（§9.1 第 4 点） |
| **参数进 prompt，但只作"提示"** | 参数要注入上下文（让模型知道边界），但**真正的强制在硬闸里**（§9.2 第一原则）。二者都要，且不能只做前者 |

> **⚠️ 这里有一个诚实的取舍**：允许"放弃风控"会让系统**在某些配置下没有任何硬性约束**。这是用户明确选择的结果（决策点 3），工程上应当：
> 1. **默认提供一套建议参数**（引导用户采纳），但**不把它当默认值静默套用**；
> 2. 在放弃时**降低而非取消**兜底：心跳熔断、幂等、对账等**安全机制不随风控参数一起放弃**（它们保护的是"不出事故"，不是"赔多少"）；
> 3. 在 UI 与日志里让"当前无风控"**持续可见**，避免用户忘记自己关掉了它。

---

## 15. 关键依据（可复核）

**Context / 记忆 / 多智能体（外部权威来源）**
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：上下文是有限资源、**context rot**、just-in-time 检索优于全量预注入、compaction 可能丢失"重要性日后才显现"的细节、结构化笔记、子 agent 上下文隔离；并明确指出**金融这类低动态场景适合混合策略**（部分前置 + 部分检索）
- [Chroma — Context Rot](https://research.trychroma.com/context-rot)：18 个模型，控制任务难度只变输入长度 ⇒ 全部退化；**约 300 token 聚焦提示词在 LongMemEval 上打败约 113k token 全量提示词**（检索应在模型外完成）
- [JetBrains Research — The Complexity Trap (arXiv 2508.21433)](https://arxiv.org/abs/2508.21433)（NeurIPS DL4C 2025）：**观测遮蔽**成本减半且不劣于 LLM 总结；观测 token 占回合约 84%（§7.2 的核心依据）
- [Manus — Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)：前缀稳定性与"只追加"纪律、"无法可靠预测哪条观测十步后变关键"（§7.7、§7.8）
- [CCXT 文档](https://docs.ccxt.com/)：统一 API 与多语言支持（§8.1、§8.5）；[CCXT order types guide](https://docs.ccxt.com/blog/order-types-guide)：触发单/止损/止盈/追踪止损/`reduceOnly`/`clientOrderId` 的统一参数、**能力自检（`has`/`features`）**、以及"**止损是风险工具不是保证价**"与"别用应用层循环重建交易所原生能力"两条警告（§8.2）
- CCXT HTX 源码 `ts/src/htx.ts`（本机拉取核实）：`createTriggerOrder`/`createStopOrder`/`createStopMarketOrder`/`createTakeProfitOrder`/`createTrailingPercentOrder` 均为 `true`，`clientOrderId` 受支持；**不支持原子括号单** `createOrderWithTakeProfitAndStopLoss`（§8.2 的保护单窗口问题）
- [Cognition — Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)：**原则 1 共享上下文**、**原则 2 动作携带隐含决策**；子 agent 安全的用法是"只回答问题、不动手"（直接决定 §5.3 的三条铁律）
- [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)：多智能体消耗约 15× token；**"子 agent 把成果写到文件系统以最小化传话游戏"**（§5.3 的工件引用模式）
- [Letta — Memory Blocks](https://www.letta.com/blog/memory-blocks)：带 `limit` 的类型化记忆块、超限先摘要、版本化与 diff（支撑 §7.5 的 M3）
- [Letta — Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute) 与 [论文 arXiv 2504.13171](https://arxiv.org/abs/2504.13171)：离线整合；测试时算力降约 5×、准确率最多 +13%/+18%、摊销后每查询成本降 2.5×；**在线 agent 没有编辑 core memory 的工具**、离线 agent 拥有它且可用更强模型（§7.5、§7.6）
- [Anthropic — Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) / [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) / [Memory](https://platform.claude.com/docs/en/managed-agents/memory) / [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)：**"客户端保留完整未修改的对话历史，上下文编辑在服务端于提示词到达前生效"**（本方案第一原则的产品化验证）；记忆库不可变版本；**dreams 绝不修改输入库**（§7.6）
- [Reflexion (arXiv 2303.11366)](https://arxiv.org/abs/2303.11366)：Actor/Evaluator/Self-Reflection 三分与反思条数上限；**消融显示无外部验证锚定的自反思反而变差（0.60 → 0.52）**（§7.4 反思闸门的依据）
- [CoALA (arXiv 2309.02427)](https://arxiv.org/abs/2309.02427)：working / episodic / semantic / procedural 四类记忆的标准词汇（§7.5 命名对齐）
- [MemGPT (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560)：core / recall / archival 三层记忆分层（支撑 §7.5 的层级命名）
- 工程实践综述（块膨胀 block bloat、静默漂移 silent drift、被污染的整合 poisoned consolidation、把离线 agent 当**不可信写入者**）：[Memory Blocks and Sleep-Time Compute](https://raw.githubusercontent.com/rohitg00/ai-engineering-from-scratch/be7e637b7ce54c47ea080cc163c28ac2614fd457/phases/14-agent-engineering/08-memory-blocks-sleep-time-compute/docs/en.md)（支撑 §7.4 / §7.6）
- 完整调研报告（含决策框架表）：`research/context-engineering-taxonomy.md`

**交易流程与"什么需要智能"（外部来源）**
**交易流程 / "什么需要智能"（外部来源）**
- 完整调研报告：`research/trading-desk-workflow-research.md`（含 `[PRIMARY]`/`[SECONDARY]`/`[FOLKLORE]` 三级证据标注与"找不到证据"的显式记录）
- **预定义亏损**：Mark Douglas《The Disciplined Trader》(1990) 的 Trading Rule 1 —— *"Predefine what a loss is in every potential trade"*（[全文 PDF](https://ia802903.us.archive.org/21/items/thedisciplinedtraderdevelopingwinningattitudes/The%20Disciplined%20Trader-Developing%20Winning%20Attitudes_text.pdf)）
- **if-then 预案的心理学基础**：Gollwitzer & Sheeran 的 implementation-intentions 元分析（94 项研究，d = .65，含"shield ongoing goal pursuit from unwanted influences"）——**注意：该机制从未在交易场景中被检验过**
- **计划为什么会失败**（三条，第一条最刺）：Brett Steenbarger, TraderFeed —— *"The plans are not worth acting upon"*、*"intellectually prepared… but not emotionally prepared"*、*"staring at screens… acting on a very short-term market movement that had nothing whatsoever to do with one's original plan"*（[原文](http://traderfeed.blogspot.com/2014/09/three-top-reasons-why-traders-fail-to.html)）——**第三条正是"LLM 盯盘"的反面教材**
- ★ **盯盘主动有害的一手论证**：Brett Steenbarger, [Market Myopia](http://traderfeed.blogspot.com/2007/12/market-myopia.html)（2007）——"illusion of control"、"more feedback leads to risk aversion and reduced returns"（引 1997 QJE）、盯盘导致"提前平仓/推迟入场"、以及"**先定义止损与目标，再让自主管理证明它比机械执行规则更好**"这条检验方法（§4.3 已据此写成验收标准）
- **复盘瞄准执行而非预测**（效度划分）：交易结果是低效度环境、交易执行是高效度环境；刻意练习在职业领域只解释不到 1% 的绩效方差；**未找到任何证明"记日志能提升交易绩效"的实证研究**（§7.9 据此把学习循环拆成主/次两条）
- **前决策强制机制**：SMB Capital 的 OGT 计划模板（要求"涨了怎么办 / 跌了怎么办"两个预案）、SEC 申报文件中的投委会前置审批、VC 基金的一致同意要求
- **提交披露**：`research/briefs/` 下有 5 份支撑简报（压缩、成本延迟、状态外化、记忆反模式、记忆框架定义）

**⚠️ 证据覆盖的诚实说明**（避免把推测当结论用）：
- 交易台调研的 `research/trading-desk-workflow-research.md` **只覆盖了预决策与复盘两个问题**（Q3 / Q9）；任务清单里的其余问题（真实时间分配、**退出与仓位管理规则**、风险限额实践、监控与告警、时间尺度分解）**未被调研**。
- 因此本计划中"**退出规则化 / 仓位公式化 / 风险限额机械化**"这几项，来自**行业通行做法与领域常识，而非文献检索结果**。它们是标准实践（固定分数法、ATR 止损、移动止损、分批止盈、单笔风险 0.5–2%），但**我没有为它们逐条附上来源**。
- **盯盘有害**这一条是例外：它有上面 Steenbarger 的一手论证，因此是本节里证据最硬的一项。
- 若要补齐，`research/` 下应新增一份针对"退出/仓位/限额/监控"的调研——**这是当前计划里最大的证据缺口**。

**DSH 侧（本机源码）**
- `$DSH/lib/plugin-Ddi42qoW.js` → `reconcilePlugins()`：`dsh.bundle.patch` 与 profile bundles 的自动同步
- `$DSH/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` → patch 层语义、行 id、`config` 整行替换、`!!js` 表达式
- `$DSH/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` → `agent.followup/steer/send/runMaintenance/whenIdle`、`agent/pre-step`、`agent/status`、`agent/turn-stopping`
- `$DSH/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts` → `ctx.agents.create/resume/roots`、`AgentHandle`、`setup(agentCtx, agent)`
- `$DSH/node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts` → `defineTool` 完整契约（`output.schema/render`、`timeoutMs`、`isConcurrencySafe`、`presentCall/presentResult`）
- `$DSH/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts` → `tools/pre-execute|execute|post-execute|result` 瀑布与作用域过滤、`ToolRuntime.register/restrict/guard`、`ToolRunContext.deferContext/concludeTurn`
- `$DSH/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js` → patch 应用算法（`name` 是卫兵、非 insert 行整行替换 config、命不中只告警）
- `$DSH/node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts` → `systemPrompt.section/context/variable` 与 `SECTION_ORDERS`/`CONTEXT_ORDERS`
- `$DSH/node_modules/@deepseek-ai/dsh-schedule/README.md` → "reminders need a live root agent"（盯盘不可用）
- `$DSH/node_modules/@deepseek-ai/dsh-jobs/README.md` → "jobs die with the harness process"（不可作真源）
- `$DSH/node_modules/@deepseek-ai/dsh-goal-round-driver/README.md` → 会话恢复后需人工重新武装
- `$DSH/node_modules/@deepseek-ai/dsh-compaction-basic/README.md` → `thresholdRatio`/`retainRatio`/`modelPolicies`
- `$DSH/node_modules/@deepseek-ai/dsh-skill-filesystem/README.md` → skill 根目录与 `SKILL.md` 格式
- `$DSH/node_modules/@deepseek-ai/dsh-mcp-client/README.md` → MCP 挂载与 `mcp__<server>__<tool>` 命名
- `$DSH/node_modules/@deepseek-ai/dsh-home-paths/README.md` → `dshHomePath()` 在 patch 的 `!!js` 表达式里可用（本机实测确认该模块存在）
- 本机实测：`dsh --profile web --dump-config` 可离线校验插件树合成结果（exit 0）

**TradingAgents 侧（本地 clone `research/TradingAgents`，commit `be952b8` / v0.4.x）**
- 完整架构分析报告：`research/TradingAgents-architecture-analysis.md`（1093 行 / 9 节，带 file:line 引用与逐条证据）
- `tradingagents/graph/setup.py:113-154` → 节点与边；`:32-42` → 完整路由路径表（防 fall-through 崩溃）
- `tradingagents/graph/conditional_logic.py:55-68` → 辩论终止的**算术**条件（无收敛判据）
- `tradingagents/agents/utils/agent_states.py:8-76` → 三个 state 定义；**只有 `messages` 有 reducer**，其余后写覆盖
- `tradingagents/agents/utils/agent_utils.py:204-228` → `create_msg_delete()`（`RemoveMessage` 清空 + 占位消息）
- `tradingagents/agents/utils/memory.py:30-49 / 177-229` → `store_decision` 幂等守卫、`update_with_outcome` 的**无锁读改写**
- `tradingagents/graph/reflection.py:14-29` → 反思提示词（2–4 句、方向/论点/教训）
- `tradingagents/graph/trading_graph.py:290-318` → 收益/alpha 计算（5 根 bar、naive `raw - bench`、直连 yfinance 绕过路由）
- `tradingagents/agents/managers/portfolio_manager.py:36-41` → `past_context` 的**唯一**注入点
- `tradingagents/agents/risk_mgmt/aggressive_debator.py:33` → 风控角色被要求"为交易员的决定辩护"
- `tradingagents/agents/utils/rating.py:69-78` + `signal_processing.py:29-38` → `REVIEW` 与静默 `Hold` 的**不一致**
- `cli/main.py:1144` → CLI 直接 `graph.graph.stream(...)`，**从不调用 `propagate()`**（记忆/反思在默认入口中是死代码）
- `tradingagents/dataflows/date_window.py` + `interface.py:153-260` → PIT 纪律与供应商路由契约（**最值得复用的两块**）
- `pyproject.toml:13,25` → `backtrader` / `redis` 声明却从未 import（无执行层、无回测器的旁证）
- [TradingAgents README](https://github.com/TauricResearch/TradingAgents) → 角色分工、决策日志与检查点语义
- [论文 arXiv:2412.20138](https://arxiv.org/abs/2412.20138) → 原始设计（**注意**：其中的 ChromaDB 记忆与 `reflect_and_remember` 在 v0.4 已删除，勿据此设计）

---

## 16. 一句话总结

> 用 DSH 的 **插件 + 事件瀑布 + 持久会话** 承担"永远在线"，用 **workflow 子 agent 群** 承担"一次深度判断"，用 **SQLite 记忆 + 结算反思** 承担"越做越准"，用 **代码硬闸** 承担"绝不失控"。
>
> TradingAgents 给的是**角色与流程**（以及一套优秀的 PIT 纪律与供应商路由契约），DSH 给的是**循环与记忆的骨架**；而它的执行层、风控层、循环层**完全不存在**——那正是这个项目真正的工作量所在，也是唯一决定生死的地方。

---

<a id="architecture-review-2026-09-19"></a>

## 17. 2026-09-19：收敛判断编排，先验证信息供给与交易增益

本节是架构评审后的决策记录；实施合同与 R1–R6 状态以 [plan.md](../plan.md) 为准。本次修改文档，
不表示新工作流已实现或任何经济验收已经通过。

### 17.1 证据支持到哪里

| 依据 | 可以支持的结论 | 不能据此推出的结论 |
|---|---|---|
| 本项目的重复订单、成交回填、保护单、恢复/对账等实测 | 执行状态机、幂等、审计和独立硬闸必须保留 | 工程安全就意味着策略赚钱 |
| [日常节奏研究](../research/01_daily_rhythm.md) §2.4 | 避免没有新信息的模型轮询，按任务时效设计触发 | 人类盯盘时间证明 LLM 每四小时判断一次最优；报告未找到直接时间测量 |
| [预承诺与复盘研究](../research/trading-desk-workflow-research.md) 的证据缺口 | 日志、计划与复盘可用于追责和过程改进 | 检查表、预承诺或 lesson 已证明提高交易预测能力；报告未找到对应直接实证 |
| [上下文研究](../research/context-engineering-taxonomy.md) §11.7 | 权威状态外置、关键字段可恢复、限制无关上下文 | 必须按记忆分类实现相同数量的层或角色；交易场景映射在原报告中即标为推演 |
| [多智能体辩论研究](https://arxiv.org/abs/2505.22960) | 辩论收益需要与强单模型基线比较，效果取决于任务条件 | 非交易推理实验已证明某套多角色交易工作流有超额收益 |

人类预承诺机制可能也能抑制模型反复改写叙事，这是设计推断，不能替代本项目的效果验证。
固定触发频率、调用数和 lesson 数量保留为起始实验参数；没有证据把这些数值设为永久架构边界。

### 17.2 2026-09-19 工作区中的具体缺口

- [旧 workflow](../dsh-trader/src/agents/workflow.ts) 固定启动四分析师、最多两轮多空和一次 RiskCritic，
  即最多 9 次子模型调用，另有外层 desk。新闻/链上角色没有相应数据；更多角色未增加独立事实。
- [workflow-runner](../dsh-trader/src/plugins/workflow-runner.ts) 的分析师 pack 主要使用单时点特征，
  active plan 只带 id/hash，lesson 只带 id；新 benchmark 分区仅有标的名。子角色没有读取工具。
  外层 desk 可通过 recall 取正文，但这不构成所有判断阶段共用完整材料。
- R1 已统一 context/run 存储；它证明存储可往返与归因可落库，不证明 §5 的内容已进入模型请求。
- [生产 runtime](../dsh-trader/src/exec/runtime.ts) 创建结算 scheduler 时未传 reflector；已有结算不等于
  lesson 生成、检索、判断使用已经闭环。[结算实现](../dsh-trader/src/memory/settle.ts) 还需区分真实成交
  与视界估值、资金费、滑点口径及缺失基准，之后才能把反馈用于可靠的效果评估。
- [P1.5 实测](p1.5-gate-run-2026-09-14.md) 明确是确定性替身，只有 1 笔配对成交，报告自己也标记
  样本不足。它不构成真实 LLM 有效或无效的证据。

以上是本次静态检查的时点记录，后续实现改变后由新的阶段验收记录状态，不重写历史事实。

### 17.3 已采用的边界与取舍

1. **保留执行复杂度，减少判断编排。** 沿用 HTX/DSL/状态机/保护/恢复/对账；删除四分析师、
   多空辩论、持久 desk 和重复上下文机制。单次 Strategist 先形成可用基线，再通过同一调用适配器
   组合三步候选。生产只运行一个选定版本，实验可复用同一内核，不建设通用编排平台。
2. **结构化约束用于接口与授权。** 事实引用由代码展开，模型区分观察、推论和假设；不再要求
   每个角色复写所有数字。程序能验证引用是否存在、事实是否可见，不能证明自然语言推论成立。
   Critic 提供反例，final 逐项回应；两者均不能改变执行权限。主观 confidence 不视为校准胜率。
3. **先交付真实材料。** R2 检查模型实际收到的请求，包含多周期序列、benchmark、组合/保护、
   active plan 全文、执行历史与 outcome。正常空状态区别于读取失败，真实观测时间不随组装刷新。
   必要数据缺失阻止增加敞口；可选材料缺失不一刀切拒绝。
4. **按需读取暂作后续实验。** 当前使用完整而有界的冻结输入，审计指针不冒充已读内容。如果
   失败样本证明切片不足，再测试有预算的只读补数，并对新增 context 重新审阅。这与
   [Anthropic 的按需上下文方法](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
   一致，但本文没有证据证明该方法必然改善本项目交易结果，因此不列为当前必做平台能力。
5. **outcome 与 lesson 分开。** 成交、费用和行情支撑可复算 outcome；lesson 是可推翻的派生
   意见。先修结算口径，默认关闭 lesson 注入。只有真实生成/检索接线且独立消融含成本后有增益，
   才启用；无需为了声称有“学习闭环”补一个没有效果证据的 reflector。

新闻、社媒和链上供应商仍为非目标。这是在限定当前实验的问题范围，并非认为这些数据没有
价值，也不宣称已经发挥了 LLM 的全部能力。

### 17.4 为什么改验收方法

采用两层对照：固定 context 的静态判断实验可隔离工作流差异；端到端 paper 实验允许各路账户、
持仓和计划自然分叉，保持共同外部数据、初始资金、硬闸和成本口径。这样既能检查 critic 改了
什么，也能观察它对真实策略路径的影响。

旧 [ab.ts](../dsh-trader/src/supervisor/ab.ts) 按两路成交数组的共同前缀做配对。只要两路不交易的
时点不同，“第 n 笔”就不再是同一市场机会，必须改为共同时间网格上的完整账户净值差。拒绝、
不交易、失败调用和未成交均保留；所有调用成本与推理延迟也计入，不能让少交易或提前成交制造
表面优势。使用时间块估计区间，数量不足如实报告；重采样次数不能制造独立市场信息。

工作流比较、lesson 消融和触发频率试验分别开展。先固定协议与开发/验证划分，再比较全成本
收益，选择支持充分的简单方案。方案上线资格还要求独立前向 paper 对纯规则的增益、正的自身
净收益和预先冻结的绝对回撤上限；99% schema 成功率、200 轮决策或 14 天零事故均不能替代它。
这些是本项目选定的验收政策，不是文献证明的普适阈值，也不保证未来收益。

前向验证还用于约束模型训练记忆带来的历史信息偏差：PIT 只能控制显式输入。金融 LLM 研究已
专门区分训练/回测重叠产生的前视风险与模型先验造成的干扰，但相关实验基于新闻情绪策略，
本文只据此要求验证偏差，不外推具体收益幅度。[Glasserman 与 Lin，2023](https://arxiv.org/abs/2309.17322)

被否决的替代方案：把三步永远固定为最佳、用一致意见作为授权、让可选缺失一律禁止动作、
按成交子集评价策略、只因拒绝率下降就保留 critic、以及在效果未知时同时增加检索/多角色/记忆。

## 18. 2026-09-20：R2 上下文与请求边界

R2 增加 schema v6 `market_observations`，以 `event_time` 表示事实发生时刻，以 `available_at` 表示
系统首次可见时刻；同一事实的晚到修订只对其可见时刻之后的 context 生效。bar、feature、衍生品与
合约规格统一由该归档供给，benchmark 进入行情采集配置而不混入可交易标的池。

Context 从固定快照组装，九个分区各自保存 `asOf/source/hash/missing`。空仓、无计划和无历史是已确认
的正常空状态；缺读取、缺观测时刻、过期、暖机、未来可见数据分别显式表达。历史计划按创建时刻与期限
重建，未来的 supersede 状态、对账、意图和配置不会倒灌进 PIT context。自由文本计划论点与历史 rationale
标成不可信数据。

请求渲染把完整 canonical context 放入固定消息；`contextHash` 因而对应真实渲染内容。超过版本化字符上限
直接拒发，不静默截断计划、订单、限额或失败。当前 `budget_ledger` 只按 UTC 日聚合，没有足够时间粒度恢复
日内 PIT 预算，故 R2 显式报告预算未知；R4 需要可回放的逐调用成本/预算记录后才能把它当作模型可用额度。

R2 验收使用固定合成数据并在最终渲染边界捕获请求；没有真实模型调用，也没有改变生产判断路由。证据见
[R2 验收](r2-decision-context-2026-09-20.md)。生产旧多分析师 workflow 的迁移归 R3。

## 19. 2026-09-20：SR1 安全审查闭环

代码审查发现的共同根因是“本地意图/订单数量”曾被误当成交易所当前事实：本地 stop 记录能压住无保护告警，
未决订单只有数量上限而未预留名义，部分成交的 `acked` 状态既不完整入账也不续接保护。修复后，对账的保护结论
只来自远端 merged 订单；未匹配订单、缺失订单和读状态不确定均冻结新增敞口。默认 cancel-all 仅撤普通单，保护单
只有在交易所确认目标范围空仓后才可撤，且逐张撤前复核普通挂单和持仓。

成交量按交易所累计回报换算为基础币；部分回报持续更新本地订单镜像，终态才写一条累计成交，终态前不安排结算。
缺成交量、均价或手续费时不以请求 qty、信号价或 0 代填：意图转 unknown，费用未知则结算保持 pending，并周期回查
同一订单的成交明细；仅精确匹配且计价币一致才回填费用。HTX 市价单在有限轮询后撤未完成余量，并按当时远端仓位挂
reduce-only 保护；周期轮询会补处理晚到回报。启动对账读失败则保留 runtime，但
全标的临时冻结新增敞口，reduce/close 仍可走实时状态与同一硬闸。

agent 工具、机械执行、撤单与迟到成交保护共享按 `DecisionJournal` 实例键控的同进程账户锁；开仓必须在锁内
重新读取账户/持仓和冻结状态后过闸，避免并发请求同时依据同一旧快照放行。成交 ack 累计量高于/不符持仓快照时
优先保护成交量推导的全量暴露并冻结；交易所仍无法挂足保护时发 reduce-only 降级，不把偏小快照当作成交全量。市价单
剩余量没有可靠价格上界时按 unknown 处理，不能用部分成交均价或 `cost` 推算。

审计与模型输入边界也已收紧：completed/review/failed run 由 store 与 SQLite trigger 禁止改写；相同已完成 workflow
重试返回已存工件，不重复调用子模型。R2 renderer 采用冻结 context 中的 maxChars（调用方只可收紧），旧对账报告
标 stale，未决意图超过展示上限会携带总数与截断缺口。W1 改为六个固定 UTC 窗，旧配置遗留队列不再被领取。

验证只覆盖本地确定性与合成 HTX adapter，不等于真实 HTX 账户验收；系统仍为 `paper`。进入 R6 前仍必须完成真实
“非空持仓 + 算法保护单” merged 对账和 R5 真实模型经济验收。

## 20. 2026-09-20：R3/R4 收敛与二次安全审查

旧 JudgmentPack、多分析师、desk session 和工具编排链已从运行包删除。生产判断只从冻结的 R2
DecisionContext 进入 single/critique DecisionEnvelope；身份、context hash、runId、计划身份和风险比例由代码绑定。
开仓只使用 `configuredRiskPct × riskFraction`，`riskPct` 不再是模型可写字段。运行时在模型调用前作预算准入，记录阶段 usage/成本；
每次成功/失败调用把渲染请求、可见输出片段、usage、成本与时长写入只追加审计链；序列化前敏感键和值脱敏。
stub 验收只证明接口、记账和幂等，不证明真实模型质量。

R4 将规则/DSL uncovered 与 PM novelty 接入同一持久队列。触发尝试数、退避时间、租用时刻、错误、TTL 均落库；
进程恢复时重新排队但不会超过最大尝试次数。队列处理再次检查 W2/W3 额度与日预算，事件过期会在模型调用、计划保存和
即时动作边界阻止旧触发执行。无法求值的 plan invalidation 先冻结标的；旧 invalidation queue 行也只走 P0 freeze，不退回模型。

Luna Max 复核指出，“存在一条 market 路径”不足以证明 PM 信号不是开仓唯一理由：路径只能证明事实被引用，不能证明语义支持。
因此目前所有 PM-triggered run 均被资格闸降为 `decision_only`，允许复核/减险但不允许新增敞口；R5 如要放开，必须先定义并实测
可复算的独立场内 entry gate，而不是以 claim 数量或自由文本说明替代。

另一个执行边界是保护编辑的可证明性：`set_stop` 只可在实时价格有效且当前无远端 stop 时添加初始保护，不能走非原子路径替换已有算法单；
`set_target` 只可在远端 stop 仍有效且目标位于盈利方向时执行；`set_trailing` 只可在当前远端 stop 仍有效时增加 reduce-only 追踪保护；
`cancel_all` 在 `decision_only` 只允许当前标的并保持持仓保护，全局撤单保持 fail-closed。对账/持仓状态未知时不因动作名推断“减险”。

生产 `dailyBudgetUsd` 仍有意未配置，所以 W1/W2/W3 不发真实模型请求。R3/R4 工程 stub 输出于 2026-09-21
重跑并留档：[R3](r3-decision-envelope-2026-09-21.md) 与 [R4](r4-trigger-worker-2026-09-21.md)。
它们不替代 R5 真实模型回放、forward-paper 和经济验收。

R5 的统计实现不得继续使用旧 P1.5 的逐笔共同前缀配对。已在 `supervisor/ab.ts` 增加严格共同时间网格的
完整账户权益对齐、权益回撤与时间块配对 bootstrap；缺失时间点、空曲线或少于两个独立时间块均拒绝产出有效 CI。
旧 `scripts/ab-gate.mjs` 与逐笔 bootstrap 只留作历史 P1.5 替身诊断，不能作为 R5 结论。真实 LLM/forward-paper
执行仍等待 §12 的显式预算/额度决定，因此 R5 未完成。

## 21. 2026-09-20：删除 live_confirm 并强制 live_auto arm

`live_confirm` 没有真实逐单确认协议，保留它会让配置界面声称有一条实际不存在的安全模式，因此从 RunMode、插件 schema、
启动解析和运行时路由删除。旧值即使以 untyped 配置或与 paper waiver 组合出现，也会在解析时拒绝。

### 21.1 2026-09-21：封闭公开交易 API 并统一 arm/waiver

真实执行现在要求 `TRADER_MODE=live_auto`、独立 `TRADER_LIVE_ARMED=1`、两项非空 HTX 凭据及完整限额同时存在；
插件入口先同步检查，组合根再校验，缺凭据时拒绝启动而不是降级 PaperBroker，避免 mode/route 错配。
paper 下可显式 waiver，live_auto 不可 waiver。
没有 arm 时 `resolveExecBroker` 只能返回 paper，不能仅凭环境里的 key 自动进入 live。
`createExecRuntime` 再独立校验 arm 和非空限额，并把生效配置版本化到 `config_versions`；只记录 key/secret 注入布尔，
不落实际值。paper waiver 的 `config_versions.waiver` 与参数正文一致；部分限额不能伪装成 waiver。
相同配置重启复用最新版本，限额、waiver、arm、mode 或 credential presence 改变才新增版本。

包根仅保留 DSH carrier metadata，不再重导出 `HtxBroker`、`executeAction`、`createExecRuntime` 等交易内核 API；
验收脚本走未映射到 package exports 的 `internal-api`，从 Node 包 API 不能直接取得真实 broker 或执行路径。
硬闸本身也二次检查 live arm 与限额，防止内部调用绕过启动 Config。

## 22. 2026-09-21：选择 critique 默认，不做付费 single/critique 对照

负责人决定直接采用三步 `critique` workflow，不为 single 与 critique 的相对效果支付实验成本。
生产 `trade-supervisor.decisionStrategy` 默认设为 `critique`，显式改成 `single` 可回退；两条代码路径都保留。
切换需在部署边界进行，并先排空/核对 running decision run 与 claimed trigger，避免策略参与 run identity 后
重试同一 trigger 产生另一 run。

该决定是成本/产品选择，不是 `critique` 优于 `single` 的证据；不宣称两种策略等效，也不将保留的 R5 两路
静态 runner 当成已执行。默认 `dailyBudgetUsd` 仍未配置，因此仅将默认策略改为 critique 不会启动模型调用。
这项决定不豁免所选 critique 的 R5 真实 forward-paper、成本后经济门槛或 R6 HTX 非空保护对账。
