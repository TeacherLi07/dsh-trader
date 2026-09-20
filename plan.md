# dsh-trader 实施计划

> 本文件只保留当前目标、边界、目标架构、重构范围和验收门槛。历史依据见
> `docs/decision.md` 与 `research/`；已经解决的事故与阶段流水账不再复制到本文件。

## 0. 目标与当前状态

目标：构建一个固定、可审计、7×24 运行的 crypto 交易框架。LLM 负责市场判断、情景推演、
即时动作与未来承诺；代码负责事实校验、风险包络、仓位计算、执行、恢复和对账。LLM 的价值是
待验证假设；没有合格的判断通道时，继续执行有效承诺与机械保护，不生成新的 LLM 开仓计划。
纯规则候选也必须经过独立验收，不能把“关闭 LLM”当作未经验证规则的自动上线许可。

本阶段不做自进化、自动改 prompt、自动改策略代码、通用多 venue 平台或高度可配置的 agent
编排。框架固定为 HTX USDT 永续、少量高流动性标的、`15m/1h/4h` 三时间框；具体标的、限额和
模型通过审计配置提供，不写成代码常量。

当前已完成行情、DSL、paper/HTX broker、订单状态机、保护单、恢复、对账与审计基础，以及 R1–R4
的 DecisionContext、DecisionEnvelope、统一执行路径、成本闸与持久 W2/W3 worker。R3/R4 工程验收使用
stub，不是模型质量或经济效果证据；生产 `dailyBudgetUsd` 仍未配置，因此生产 W1/W2/W3 不发模型请求。
旧 JudgmentPack、多分析师与第二套模型下单工具链已删除。2026-09-20 的 SR1 安全审查修复已合并；
结算 scheduler 已启动，reflector 尚未接入。下一步 R5 才进行真实模型回放与 forward-paper 验收。

本计划评估的是价格、衍生品、组合状态支持的交易判断，不宣称覆盖 LLM 的全部交易能力。当前
模式保持 `paper`；R2–R5 完成后再评估 R6。此次收敛依据见 [决策记录 §17](docs/decision.md#architecture-review-2026-09-19)。

## 1. 设计原则

### 1.1 永久硬边界

以下约束不随模型能力提升而取消：

1. 密钥不进 prompt、日志和数据库；实盘 key 禁止提现并绑定 IP。
2. 交易所 + SQLite 是权威状态；模型上下文只是可重建投影。
3. 每次增加敞口前在同 runtime 的账户锁内重取账户、持仓、挂单及其未成交名义金额、价格与市场规格；agent 工具、机械执行、撤单和迟到保护共用锁；无法估值的在途单阻止新增敞口。
4. 最大单笔名义、总敞口、杠杆、日亏、回撤、连续亏损、点差和挂单数由代码强制。
5. 数量、精度、最小额和保护价由代码计算；模型不得直接给最终 `qty`。
6. 幂等、订单状态机、启动恢复、周期对账、冻结与 kill switch 不可绕过。
7. 有持仓无交易所侧保护单、未知在途订单或对账不一致时，只许减险，不许增加敞口。
8. 审计只追加；拒绝、失败、未知状态和副作用都必须逐字保留。
9. Polymarket 只读，永不下单，也不得成为开仓的唯一证据。
10. 时钟必须注入；历史判断只使用 point-in-time 可见数据。

### 1.2 模型权限

模型可以探索交易假设，执行权限由代码限定：

- 模型可以决定 `NO_TRADE/REVIEW`、方向、入场方式、止损方法、目标、减仓、退出、未来承诺和
  失效条件。
- 模型可以提交即时动作；框架验证后自动执行，不再要求必须等下一根 bar 才能入场。
- 模型可以用 `riskFraction ∈ (0,1]` 下调本次风险，但不能超过配置的 `riskPct`。
- 模型不能调用 broker、扩大限额、解除冻结、修改配置或改变本工作流。
- 风险批评是独立挑战，不是授权来源；最终授权只来自确定性资格检查与硬闸。
- `evidencePaths` 只证明模型引用了当时可见的事实，不证明其推论或方向正确。
- 可以使用一般领域知识形成明确标注的假设，不能把训练记忆中的事件或价格当作本轮事实。
- `confidence` 是未经校准的主观强度，不能直接当胜率、Kelly 输入或放宽限额的依据。

### 1.3 简化原则

- 只保留能改善信息质量、执行安全或可测结果的层；角色数量和调用次数本身不算能力。
- 工程正确性、判断可靠性和交易效果分别验收，不能互相替代。
- 同一 PIT 样本比较纯规则、单次判断和三步判断，最终只保留通过验收的最简单方案。
- 调用次数、审议频率、序列长度和 lesson 数量是版本化实验参数；当前默认值不等于已证明最优。
- 先修补模型实际缺少的信息；额外角色、检索或记忆机制必须由具体失败样本和消融结果支持。

## 2. 运行循环

```text
W1 时间窗 / W2 未覆盖 / W3 新颖性
                    ↓
          组装并冻结 DecisionContext
                    ↓
      单次 Strategist 或 Strategist → RiskCritic → Strategist
                    ↓
      证据校验 + eligibility + 持久化 DecisionEnvelope
                    ↓
       即时动作过硬闸执行；未来承诺交给 DSL 引擎
                    ↓
       成交/拒绝/对账 → 结算 outcome → 可选 lesson
```

已收盘行情持续驱动特征与 DSL；没有 W1/W2/W3 事件时不逐 bar 调用 LLM。起始触发配置：

- **W1**：每 4 小时一次，共 6 次/UTC 日；删除 `pre_session/midday/post_session` 的重叠配置。
- **W2**：规则或行情状态不在 active plan 覆盖范围内；默认上限 3/时、8/日。
- **W3**：代码识别的异常波动、衍生品异常、交易所异常或合格预测市场事件；默认 2/时、6/日。
- P0 风险事件不等待 LLM：立即执行预定义减险或冻结。
- agent 忙时进入持久队列；成功落下最终裁决后才推进游标。

W2/W3 的去重、冷却和预算必须实际接线；重复缺口不能无限唤醒。事件入队时刻、等待时间、判断
完成时刻和动作执行时刻均可审计。事件已过期时记录原因，不能执行旧快照的动作。频率变化要
单独对照，不能与工作流变化混为一个实验；未接入的事件源不宣称能被 W3 识别。

R3 先实现单次 Strategist，再用同一调用适配器组合三步 draft→critique→final，供 R5 对照。
默认每轮为 1 或 3 次调用；每轮最多增加 1 次结构修复，失败原文与修复成本均保留，仍失败则
`REVIEW`。不为两个候选建立两套执行、存储或生产配置系统。删除四分析师、多空辩论和通用编排。

## 3. 决策工件与计划卡

### 3.1 `DecisionEnvelope`

每轮最终只允许一个类型化工件：

```ts
interface DecisionEnvelope {
  runId: string
  contextHash: string
  symbol: string
  primaryTimeframe: '1h'
  outcome: 'act' | 'no_trade' | 'review'
  thesis: string
  rejectedAlternatives: string[]
  claims: {
    kind: 'observation' | 'inference' | 'assumption'
    statement: string
    evidencePaths: string[]
  }[]
  uncertainties: string[]
  confidence: number                  // [0,1] 主观强度；不等于校准胜率
  riskFraction: number                // (0,1]；只能缩小配置 riskPct
  immediateAction?: PlanAction
  plan?: PlanCardDraft
  critiqueResponses?: {               // 单次候选省略；三步候选逐项回应
    critiqueId: string
    disposition: 'accept' | 'reject'
    reason: string
  }[]
}
```

事实引用由代码从冻结 context 展开原值、单位和时点，不要求模型逐角色抄写 `keyNumbers`。
`observation` 必须有有效引用；推论区分事实依据和假设，假设可以没有直接事实引用，但不能冒充
观测或替代动作的必要数据。自然语言与引用之间的逻辑支持程度属于判断质量验收。

代码检查 context hash、引用是否存在且可用、数据新鲜度、输出形状、动作一致性、资格与 DSL
可执行性；不把推论标成“已验证”。`no_trade/review` 不得夹带增加敞口动作，即时动作和未来承诺
不能造成同一意图重复开仓。不合格工件落 `REVIEW`；任何允许的减险动作也必须通过自身校验。

### 3.2 计划卡

保留当前四条性质：可判定、有期限、幂等、不可事后改写。同一标的最多一张 active 卡；新卡只会
supersede 旧卡。卡片保存完整 thesis、反例、失效条件、承诺、禁则和来源 `runId`。

DSL 继续作为未来承诺的可靠执行后端，支持当前数值路径、布尔/算术运算、`crossAbove`、
`crossBelow`、`between`、`pct` 等。未知路径、缺前值、缺数据或未注册 alias 一律 `UNCOVERED`，
不得静默当成 `false` 或 `0`。

即时 `open/reduce/close/set_stop/set_target/set_trailing/cancel_all/halt` 不需要伪造恒真 DSL；它们
直接来自本轮 `immediateAction`，仍走同一 `execute-action`、硬闸和审计链。

### 3.3 仓位与保护

```text
effectiveRiskPct = configuredRiskPct × riskFraction
riskQuote        = equityQuote × effectiveRiskPct
stopDistance     = |entry - derivedStop|
qty              = floorToStep(riskQuote / stopDistance)
```

初始止损必须存在。`atr` 与 `structure` 由模型选择，具体价格由代码结合实时价格/ATR/结构位校验；
止盈可用 R multiple、结构位或省略。任何动作最终仍受单笔名义与组合风险上限约束。

## 4. 数据与持久化

### 4.1 DDL 合同

可执行 DDL 的唯一实现是 `dsh-trader/src/db/schema.ts`；本节记录必须同步的逻辑合同，
`tests/db-schema.test.ts` 负责表与约束验收。R1 已升为 v5；后续有表/列变更时继续同步 schema、
迁移和测试，不保留旧判断链的兼容 shim。开发库在导出审计记录后允许重建。

| 表组 | 表 | 不变量 |
|---|---|---|
| 行情 | `bars`, `features`, `bar_processing`, `market_observations` | 只处理已收盘 bar；PIT 观测按 event/available 双时间只追加；同一 bar 成功后才推进游标 |
| 判断 | `decision_contexts`, `decision_runs`, `decisions`, `plan_cards` | context 全文可复现；终态 run 由 SQLite trigger 禁止改写；一轮一个最终裁决；每标的一张 active 卡 |
| 执行 | `order_intents`, `orders`, `fills` | client id 唯一；状态单向迁移；重复回报不重复成交 |
| 学习 | `outcomes`, `lessons` | 一条决策至多一个结算和一个有证据 lesson |
| 触发 | `triggers`, `supervisor_window_cursors`, `supervisor_windows` | 去重、限流、带退避的有界重试、事件过期、重启恢复 |
| 运营 | `audit_events`, `config_versions`, `heartbeat`, `price_table`, `budget_ledger` | 审计 append-only；限额与成本版本化 |
| 预测市场 | `pm_markets`, `pm_series`, `pm_quotes`, `pm_watches` | PIT、只读、别名有期限且有上限 |

当前 schema 为 v7。v5 用 `decision_contexts` 取代只存 part hash 的 `context_snapshots`，保存 canonical context 或可核验的
内容指针；用 `decision_runs` 取代一次性 `workflow_contexts` token，把 draft、critique、final、
eligibility、模型版本、token、成本和耗时放在同一 run 根下。`decisions.run_id` 与 `plan_cards.run_id`
必须回指该 run。v6 增加 `market_observations`，按 `event_time` 与 `available_at` 记录不可变行情修订，
禁止回写和删除；历史回补只能从真实抓取时刻起可见。v7 为 `triggers` 增加 `attempts`、
`next_attempt_at`、`claimed_at`、`last_error`，并将 `failed` 纳入终态：worker 重启可恢复 claimed，
瞬时失败按退避重试且有上限，陈旧事件过期后不得再调用模型或执行动作。

R3 补足运行语义：run 必须绑定候选/提示词/模型版本与触发身份，不能只凭 context hash 合并不同
实验；终结工件不可重写，重试按已持久化阶段恢复。状态为 running/failed 或 eligibility 未计算的
run 不能授权开仓。同一 context 可用于多个对照 run，实验账户及其订单幂等域彼此隔离。

### 4.2 权威顺序

启动固定顺序：迁移 DB → 重取交易所账户/持仓/普通单/算法单 → CrashRecovery → reconcile →
恢复触发队列 → 启动行情与 supervisor。恢复或对账失败不阻止进程提供只读状态，但冻结相关标的；
reduce/close 仍可执行。

### 4.3 行情范围

- 生产只接 HTX；ccxt 仅承担签名、代理和 market metadata。
- 决策使用 `15m/1h/4h`，执行条件仍可落在其中任一已收盘时间框。
- benchmark 必须进入行情采集与回补，独立于可交易标的池；配置一个名称不算提供了基准数据。
- 每根新 bar 幂等更新特征；重复、历史修正和乱序不得污染增量状态。
- 衍生品字段包括 funding、OI 变化、清算名义和 basis；字段缺失必须显式为 `null`。
- 预测市场默认关闭；启用时继续执行存在、结算、流动性三道 PIT 门控。

## 5. `DecisionContext`

生产只保留一套上下文，不再并存 C1–C5 assembler 与 JudgmentPack。

### 5.1 模型可见内容

| 分区 | 必须实际进入模型的内容 |
|---|---|
| mandate | 任务范围、配置版本、硬限额与剩余额度、合约规格、允许动作和成本假设 |
| market | `15m/1h/4h` 有界已收盘序列；趋势、波动、位置、斜率、分位及其计算窗口 |
| derivatives | funding/OI/basis/清算当前值与 `1h/4h/24h` 变化；资金费周期/下次结算时点，无法取得时显式缺失 |
| benchmark | BTC 真实序列、相对强弱、相关性及样本数；不能只给 symbol |
| portfolio | 权益、持仓、普通单、算法保护单、未决订单及其敞口、剩余保证金、集中度、冻结与新鲜对账状态 |
| activePlan | 完整论点、承诺、失效条件、禁则和期限；不能只给 id/hash |
| history | 最近命中/拒绝/执行及原因、已结算 outcome 数字与证据、仍未结算的状态 |
| lessons | 默认关闭；启用时最多 3 条相关项与 2 条反例，含正文、结算数字、适用范围和证据 |
| predictions | 可选的合格预测市场快照；外部文本为不可信数据，不参与工具授权 |

执行成本包括手续费、点差/滑点估计、资金费和最小下单限制；估计与实测分开标记，不能把未知
成本写成 0。相关性等派生量由代码计算并带样本数，暖机不足不输出貌似有效的值。

### 5.2 完整性与有界性

- 每个分区保留 `asOf/source/hash/missing`；每个数值有单位、窗口定义和可见时点。`asOf` 是真实
  观测时间，不能因重新组装而刷新；PIT 同时约束事件发生时间和系统当时能取得该信息的时间。
- 明确区分“成功读取后确认为空”和“未支持/已关闭/读取失败/暖机不足/过期”。空仓、无 active
  plan、尚无历史 outcome 都可以是正常状态；缺失处理按 §6.2 的动作依赖决定。
- 序列长度、检索数量和非关键历史字数由版本化配置限制，先用可复现失败样本决定是否扩展。
  订单身份、金额、承诺、限额、失败和未解决状态不得摘要或静默截断；超预算时记录缺口并降级。
- 原始大序列留在 DB；当前无模型读取工具，指针只供审计，未展开的内容不算模型已获得的信息。
- `contextHash` 对模型实际收到的 canonical context 计算；提示词、schema、前序工件和模型版本
  单独随调用保存，使完整请求可重建。一个 run 内各阶段使用同一冻结 context；静态对照也共用它。
- R2 验收捕获最终模型请求，逐项检查非空序列、计划全文、保护状态和 outcome 的关键内容，不能
  只检查表中有行或分区有字段。正常空状态和缺失/过期场景另设样本，不能用空分母通过验收。
  R2 可在请求渲染边界使用捕获器，不依赖真实模型；R3 必须复用该渲染器并验证生产调用接线。

## 6. 判断工作流

### 6.1 两个受控候选

- **single / 单次**：Strategist 直接输出唯一 `DecisionEnvelope`。
- **critique / 三步**：Strategist draft → RiskCritic 反例 → Strategist final；final 必须逐项回应 critique。

RiskCritic 只寻找数据缺口、反事实、组合风险、执行风险和失效条件，不定仓位、不下单。两个候选都
看完整冻结 context，不通过中间角色转述关键数字；所有工件完整落 `decision_runs`。Critic 的问题
使用稳定 id，final 必须逐项接受或驳回并说明理由；回应完整不等于回应正确。模型版本、推理/
输出预算和提示词固定并记录，运行时不自选模型、角色、脚本或工具。

两个候选只在实验入口组合阶段；生产一次部署只启用一个冻结方案，R5 选定后移除落选的生产
分支，保留实验脚本与历史工件供复核。共用 schema 不要求单次候选伪造 draft/critique 内容。

### 6.2 `eligibility`

代码在 final 后计算：

- eligibility 只判断客观可执行条件，不评价 thesis 是否正确。
- 增加敞口必须满足代码维护的最小依赖：账户、持仓/挂单、价格、市场规格、保护/冻结状态和
  剩余风险额度。另检查本次动作、止损方法、DSL 以及论点实际依赖的事实；模型不能通过省略
  evidencePaths 绕开最小依赖。必要数据缺失/过期、引用伪造或 DSL 无法求值 → `decision_only`。
- `decision_only` 只允许 `NO_TRADE/REVIEW` 或经过单独校验的减险动作。减险仍需可靠确认目标
  持仓/订单及 reduce-only 语义；`set_stop/set_target/cancel_all` 不能仅凭动作名称认定安全，必须
  验证不会扩大风险或移除必要保护。P0 机械保护独立运行。
- 当前可执行的 `decision_only` 即时动作限制为 `reduce/close`、无订单动作，以及有新鲜价格且当前无远端止损时添加有效初始 `set_stop`；已有远端止损的原子替换尚未实现。`set_target/set_trailing/cancel_all` 在 `decision_only` 明确返回 REVIEW，直到各自的保护状态校验通过测试。
- 可选预测市场、lesson 或未被动作依赖的指标缺失，不单独阻止开仓；缺口仍进入 uncertainties。
- PM W3 事件虽然可映射到 active plan 并进入只读 context，但目前代码无法从 claim 的文本/路径证明方向性独立；R5 验收独立场内 entry gate 前，PM-triggered run 固定为 `decision_only`，只能复核/减险，不能新增敞口。
- 数据与工件有效 → `risk_gate_required`；即时动作和以后每次承诺命中都必须再过实时硬闸。
- RiskCritic 的主观意见必须被 final 回应，但不能自行增加或取消执行权限。

### 6.3 有界补数的后续实验

本轮先补齐 R2，不增加模型工具循环。若请求追踪证明固定切片遗漏了决策所需信息，才安排独立
实验：仅对白名单历史数据/计划/结算开放只读查询，限制次数、时间和 token，全部结果满足 PIT。
补数必须生成新的 context 版本并重新完成审阅，不能在旧 hash 下混用新事实，也不能接触 broker、
任意脚本或配置。该实验需重新比较全成本和判断质量，不是 R2–R6 的完成前置。

## 7. 结算与记忆

结算视界按计划主时间框推导，区分真实已实现盈亏、尚未平仓的视界估值和独立模拟账户结果。
部分成交/多次减仓按实际数量归因；用真实成交价计盈亏时不再重复扣除已体现在成交价中的滑点，
模拟滑点仅由撮合模型施加。手续费、资金费和相应行情/基准必须有来源；缺成交/行情则推迟，
缺成本或基准则相应净额/超额结果标记未知，不能用 0 或未经校准的 alpha 替代。

outcome 是由权威成交/费用/行情计算的可复核记录；lesson 是可选派生意见。lesson 只在外部结果可核验后生成，必须有 evidence
refs、regime、TTL 和适用范围，且不能修改 prompt、配置、DSL、限额或代码。没有接线 reflector 时
必须明确记录“仅完成结算”，不得宣称学习闭环已完成。lesson 默认不进入生产判断，直到 R5 的
有/无 lesson 对照证明它改善预先定义的指标。检索只使用本次决策时已结算且已生成的记录，按
标的/regime/TTL 限量；单笔获利不构成因果证据，lesson 可以被反例推翻。默认关闭时不必为阶段
验收新增 reflector；若选择启用，必须验证常驻生成、重复调用幂等、正文进入请求与独立消融。
本阶段不做策略自进化。

## 8. 模式、成本与运行

### 8.1 模式

- `paper`：实时行情，本地撮合；默认模式。
- `live_auto`：小额实盘，无逐单人工确认；启动时必须显式 arm，且全部限额非空。

删除未实现的 `live_confirm`，也删除 live 下的 `waiver`。需要人工介入时使用 `/halt`、只读控制台和
重新 arm，而不是保留一个名义存在、实际未接线的模式。

### 8.2 成本

每次模型调用（含失败、结构修复和可选反思）必须写入所属 `runId`/阶段、模型版本、输入/输出/
cache token、耗时和成本；反思成本回指来源决策。调用前按剩余额度与有界输出预算准入，完成后
按真实 usage 结算，不能只在超支后记账。缺价目或 usage 时 `cost_known=false`，不能按 0 计，
停止新增敞口判断并记录原因。日预算超限也停止 W1/W2/W3 的新增敞口判断；已有持仓的 P0
减险与机械保护不受影响。报价、判断等待、推理和下单延迟分别记录，用于回放执行时点。

生产为 Docker 单进程；容器负责 restart，进程内不启动第二个 watchdog。UI 只读。

## 9. 重构范围

项目没有历史兼容负担；允许删测试、删接口、删表、改 schema、改工具名，不保留双实现或 deprecated shim。

| 处理 | 模块 | 目标 |
|---|---|---|
| **保留** | `market/{archive,backfill,feed,features,indicators,derivatives}` | 扩展多 tf 与 context 聚合，不重写已验证数值内核 |
| **保留** | `exec/{broker,ccxt-broker,order-state,paper,gate,recovery,reconcile}` | 保持状态机与硬闸，补 DecisionEnvelope 即时动作入口 |
| **保留** | `plan/{dsl,evaluate,match,store}` | DSL 继续执行未来承诺 |
| **重构** | `plan/schema.ts`, `exec/execute-action.ts`, `exec/live-engine.ts` | 引入 `DecisionEnvelope`、`riskFraction≤1`、即时动作与 run 归因 |
| **重构** | `memory/{settle,recall}`, `cost-ledger.ts` | outcome 为事实根；lesson 可选；模型调用按 run 记账 |
| **重构** | `trigger/*`, `plugins/rules.ts` | 真正接通 W2/W3 claim、预算和 supervisor |
| **重写/删除** | `agents/{types,pack,prompts,workflow}.ts` | 旧 JudgmentPack 与多分析师代码删除；single/critique 只用 DecisionContext/DecisionEnvelope |
| **重写/删除** | `plugins/{workflow-runner,supervisor}.ts` | 旧 workflow-runner 删除；supervisor 直接驱动 W1 与持久 W2/W3，不唤醒通用 desk agent |
| **收敛/删除** | `agents/context.ts`, `agents/decision-{context,context-store,run-store}.ts` | 旧 C1–C5 assembler 删除；保留 R1 canonical context/run 存储根 |
| **重构** | `supervisor/ab.ts`, `scripts/ab-gate.mjs` 与 R5 验收脚本 | 真实 LLM 对照、按时间对齐账户净值、分开工程与经济结论 |
| **删除** | `agents/roles.ts`, `agents/tool-roster.ts`, 固定四分析师提示词 | 删除未生效模型分层、目标工具箱与名义角色 |
| **删除/收窄** | `plugins/tools-{desk,research,risk}.ts`, 未实现工具声明 | 只保留控制台/诊断真正使用的工具，不让模型靠工具编排主循环 |
| **更新** | `cordis.patch.yml`, `README.md`, UI cycle 投影、验收脚本 | 配置与新 run/context 根一致 |

执行与判断之间不得出现第二条订单路径；即时动作和 DSL 命中最终都调用同一 `execute-action`。

## 10. 实施顺序与验收

### 10.1 WBS

| 阶段 | 工作 | 完成判据 |
|---|---|---|
| R1 | schema v5 + DecisionContext 类型与 store | ✅ `decision_contexts` 保存 canonical 全文或不可变 content ref；`decision_runs` 保存 draft/critique/final/eligibility 与模型成本；终态 run 由 store 与 SQLite trigger 双重禁止改写；旧 context/token 表已从生产 schema/引用移除；验收：`dsh-trader/scripts/r1-acceptance.mjs` |
| R2 | 完整而有界的 DecisionContext | ✅ 双时间 observation 覆盖 bar/feature/derivatives/spec；按 PIT 组装 9 分区 context 与最终请求；非空样本：192 根资产 bar、64 根 benchmark bar、32 对 benchmark returns、4 条衍生品观测、1 个结算 outcome、1 个持仓/挂单/计划承诺；正常空、读取失败脱敏、过期（含对账）、暖机、晚到数据、未来计划/对账/订单排除、未决意图溢出显式降级及配置化 maxChars 强制均有测试；验收：`scripts/r2-acceptance.mjs`，历史证据见 `docs/r2-decision-context-2026-09-20.md` |
| SR1 | 2026-09-20 安全审查闭环 | ✅ 撤单默认保留保护单且逐张复核；本地 stop 不作为远端保护证据；未知/孤儿订单冻结；并发执行在账户锁内重读和串行化；市价余量未知估值进入硬闸；部分/延迟成交按真实量入账并续接保护/降级，位置快照滞后时按成交量保护或 reduce-only 降级，订单终态前不安排结算；缺成交量、均价或手续费不伪造为 0，缺手续费周期回查同单成交明细；启动对账失败时保留降险入口；W1 固定 UTC 6 窗；run 终态不可重写；验收：新增执行/上下文回归测试 + `pnpm verify` |
| R3 | 单次/三步 workflow + evidence/eligibility | ✅ 共用 renderer/schema；single/critique、最多一次 repair、run 阶段恢复、证据引用/资格检查与预算/usage 入账；旧 JudgmentPack/多分析师/副作用工具链删除。工程 stub 验收：`scripts/r3-acceptance.mjs`，证据 `docs/r3-decision-envelope-2026-09-20.md`；没有真实模型调用 |
| R4 | 即时动作、W2/W3、结算与成本 | ✅ 即时与 DSL 共用 execute-action；W2/W3 claim、预算、频率、P0 freeze、退避/attempt ceiling、重启恢复、TTL 过期和 PM active-plan/PIT 映射已接线。PM-triggered opening 在 R5 独立场内 gate 验收前保持 `decision_only`。工程 stub 验收：`scripts/r4-acceptance.mjs`，证据 `docs/r4-trigger-worker-2026-09-20.md`；没有真实模型调用 |
| R5 | 真实 LLM 回放 + forward paper | 分别完成 §10.3 工程与 §10.4 经济验收；交付完整样本、实验清单、对照结果和方案选择，不用替身或成交子集宣称增益 |
| R6 | P3 小额 `live_auto` | R5 两道验收均通过且完成 §12；先通过真实 HTX 非空持仓+算法保护单对账；连续 14 天重复成交=0、无保护暴露=0、对账未决=0 |

R2–R5 每阶段交付一条待实现的验收入口 `scripts/r2-acceptance.mjs` 至 `scripts/r5-acceptance.mjs`，
以 `pnpm build && node scripts/rN-acceptance.mjs` 运行（N 替换为阶段号），输出同名日期化
`docs/*.md + .json`。需要网络/真实模型的入口不进 CI；预录工件可复核，但不能冒充新模型调用。
阶段代码完成必须 `pnpm verify` 通过。R1 的完成标记仅覆盖现有验收，不提前勾选 R2–R6。

### 10.2 实验协议与可复现性

- 开始前保存实验清单：数据范围与可见时点、标的、模型/提示词/代码/配置版本、推理预算、
  成本口径、触发频率、评估时段/结束条件、最低有效时间块数、区间估计方法、选择规则和绝对
  回撤上限。开发段用于修改方案，
  独立验证段用于判定；看到验证结果后改规则必须启动新实验，不能重用原验证段宣称通过。
- **静态判断对照**：single/critique 使用完全相同的 context、账户和计划快照，比较引用错误、
  推理缺陷、批评纠错/引入错误、拒绝理由和延迟。相同快照的重复采样不算独立市场样本。
- **交易效果对照**：冻结现有 DSL 规则基线 `rules`，与 single/critique 共用外部 PIT 数据、
  初始权益、风险上限、执行内核、成本模型和评估时间网格。各路独立维护账户、持仓、计划和
  由自身计划产生的 W2；不能为了相同 context 强制覆盖策略已经分叉的账户状态。
- 所有运行包含失败、修复、`NO_TRADE/REVIEW`、拒绝和未成交。回放必须把推理/排队延迟计入
  可执行时点；信号形成前或模型尚未完成时的价格不能用作成交价。经济比较以共同时间网格的
  完整账户净值为准，不按“第 n 笔成交”或两路成交列表共同前缀配对。
- 回放复现分两层：固定模型工件后的执行应确定性一致；重新调用模型是新采样，保存原始请求/
  响应与成本，不能要求模型输出逐字相同。PIT 输入不能消除模型训练记忆泄漏，历史结果必须经
  冻结配置的前向 paper 验证，不能单凭历史回放进入 R6。

### 10.3 工程与判断可靠性

- 共同评估窗口至少 200 个；每个 LLM 候选均有真实调用。至少 50 个非空样本实际经过执行链，
  且动作、拒绝、恢复等已声明覆盖项分别有分母；不得要求模型为凑数量强行开仓。合成安全用例
  与真实 LLM/行情样本分开统计，不能合并为交易有效性的样本量。
- 最终 schema 成功率 ≥99%，首次成功率与修复率单列；失败后的安全 `REVIEW` 不算 schema
  成功。错误引用进入可执行工件=0、硬闸绕过=0、重复成交=0；缺失/过期测试必须确实触发拒绝。
- 依据预先标注的事实/动作要求，检查模型是否使用了计划失效、保护缺失、相关敞口、成本升高等
  关键信息；不能只按文字是否变化或模型自评分判定。Critic 纠错和引入新错误分别报告，证据引用
  有效、逐项回应完整与预测正确分别统计。
- 上述数量是工程验收下限，不能当经济显著性的保证。达到调用数但没有足够交易/独立时间块时，
  相应经济结论仍为“未证实”。旧 P1.5 的确定性替身、1 笔配对样本仅为历史记录。

### 10.4 经济效果与方案选择

- 主要指标为完整账户的成本后净收益差：包含未平仓估值、手续费、资金费、实际撮合滑点，以及
  全部模型调用成本。另列交易净收益、绝对回撤、换手、持仓时间、拒绝/不交易率、延迟和成本。
  缺价目、资金费或估值行情时不能产出“通过”；资金费/基准缺失也不能填 0。
- 用共同时间块的账户收益差估计 95% 置信区间；按时间块重采样并保持同段标的的相关关系，
  块长度根据开发段的持有期/依赖性确定后冻结，不把每笔交易当独立同分布样本。必须报告有效
  时间块数；数量不足或区间不稳定时结论无效，增加 bootstrap 次数不能补足市场样本。
- 开发段选方案时，critique 只有相对 single 的全成本净收益增量得到支持且不突破绝对回撤上限
  才保留；少交易、少拒绝或更高共识本身不构成选择理由。收益差 95% CI 下界不大于 0 时优先
  single，但仍需独立验证，不能把“未证明差异”解释为两个方案等效。
- 选定的 LLM 方案在独立前向 paper 段相对 rules 的全成本收益差 95% CI 下界必须 >0，自身
  全成本净收益为正，且绝对回撤不超过实验前冻结的上限，才通过经济闸门。rules 无交易或回撤
  为 0 时仍使用绝对上限，不用失效的回撤比。未证实则继续 paper，不进入 R6。
- lesson 默认关闭。有/无 lesson 对照在基础方案固定后单独进行，检索只读各路当时已知历史，
  包含生成成本并验证反例检索；没有足够 lesson 或没有全成本增益，保持关闭，不阻塞基础方案。
  W2/W3 频率和 §6.3 补数同样逐项对照，不能同时改多项后把收益归因于其中一项。

R6 的 14 天零事故验证必须有非空成交、持仓、算法保护单和对账样本，不能在空账户上通过。
它验证上线运行纪律，不替代 R5，也不证明未来收益或长期 alpha。

## 11. 明确非目标

- 自进化、自动改 prompt/策略/限额、M3 playbook。
- 新闻、社媒、链上供应商与对应专职 agent。
- 多交易所、跨所套利、高频、做市和亚秒执行。
- 任意 workflow、动态角色市场、模型自选工具集。
- 在缺少失败样本与对照收益时引入通用检索、记忆平台或追加专职 agent。
- 把 evidence 引用正确、critic 共识或工程成功率当作交易有效性的证明。
- 让预测市场直接交易或单独触发开仓。
- 保留旧判断链的兼容层。

## 12. 外部前置

以下是 R6 的外部前置，均未因修改计划而完成；R2–R5 的仓库改造不等待它们：

1. 用真实 HTX key 验证“非空持仓 + 已挂算法保护单”的 merged 读取与 reconcile。失败时保持冻结，
   补齐读取或本地保护意图线索后重验；本地记录不能替代交易所侧已生效保护的证据。
2. 确认固定模型路由可用并完成价目表种子；模型版本或行为显著变化必须重新跑 R5。

其中真实模型调用也是 R5 的必要输入；路由、额度或价目不可用时，允许先完成离线检查，但必须
报告 R5 对应部分阻塞，不能用假模型替代。进入 live 前 arm、交易标的与风险限额仍需显式配置。
其余改造均为仓库内工作，不应再以“等待外部输入”为由保留空实现。
