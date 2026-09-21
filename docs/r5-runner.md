# R5 真实模型静态对照运行器

**当前决策**：负责人已选择 production 默认 `critique`，并取消付费 single/critique 对照实验。此 runner 与 single 实现保留为将来可选的研究工具，但当前不执行；选择 critique 不证明它优于 single。所选策略的真实 forward-paper/经济验收仍是 R5 独立门槛，且需要单独的预算与凭据授权。

`dsh-trader/scripts/r5-acceptance.mjs` 是真实 provider 静态判断对照入口，复用 DSH `ctx.llm` 与项目的结构化 DecisionWorkflow、价目表、预算账本、DecisionRun 和 append-only 审计。它不实现或冒充经济验收：报告固定写明 `executionChainSamples=0`、`economicGate=not_run`、`r5OverallPassed=false`。

## 安全运行方式

先只做 manifest / 预算 / 价目 / 构建与已安装包版本预检；不实例化 provider、不建立模型连接、不发模型请求、不触网络：

```bash
pnpm build && pnpm link:peers
node scripts/r5-acceptance.mjs \
  --manifest /path/to/frozen-r5-manifest.json \
  --preflight \
  --output /tmp/r5-preflight.json
```

真实调用必须再显式传 `--execute`、提供一个新的隔离 state DB，并由负责人在环境层设定正数的
`TRADER_R5_DAILY_BUDGET_USD`、`TRADER_R5_DAILY_TOKEN_CAP`、`TRADER_R5_TOTAL_BUDGET_USD` 与
专用 `TRADER_R5_API_KEY` 和显式 `TRADER_R5_CONFIRM_KEY_ISOLATION=1`。若它与同环境 `DEEPSEEK_API_KEY` 完全相同会拒绝执行；ack 表示负责人确认 key 不与 credentials store / 其他进程共用。脚本只记录 key 存在/隔离 ack 布尔，不打印其值；所有 provider 请求仍经 DSH 的
`ctx.llm.stream()`，不直连 HTTP、不创建 broker、不下单。

`--execute` 也不会在预算授权/共享 reservation 之前实例化 DSH provider：provider 只在第一笔已预留调用进入 `stream` 时延迟创建。CLI 的 `staticEngineeringGate` 仅判 schema、证据与覆盖结构；Critic/outcome 标签准确度和错配会单独报告，计划没有为它们规定硬阈值，因此不能把此门通过解释成模型质量或 R5 全面通过。

在创建 DSH provider 前，runner 会把当前进程的 R5/DeepSeek/HTX key 与 secret 值（仅内存）扫描整个 manifest 的字符串和 object key；发现命中只报所在字段路径，不输出凭据值并 fail-closed。manifest 本身也禁止凭据字段名。

独立 API key 不会隔离 provider 账户余额；如果同一 provider 账户还被其他进程使用，runner 的账本只限制本 control registry 发出的调用。要求 provider 账户/额度专用于该实验，或另有 provider 侧 hard cap；否则不得把本地 `totalBudgetUsd` 宣称为账户级支出上限。

```bash
node scripts/r5-acceptance.mjs \
  --manifest /path/to/frozen-r5-manifest.json \
  --execute \
  --state-db /path/to/isolated/r5-state.sqlite \
  --output docs/r5-acceptance-YYYY-MM-DD.json
```

相同 manifest 和 state DB 可通过 `--resume` 分批继续，并可用 `--sample-start`、`--sample-count`、
`--max-model-calls` 限定一次运行。任何请求先检查每日美元预算、每日 token cap 和实验总预算，再追加
budget reservation audit；调用 outcome 未落审计的 request hash 不会自动重发。state DB 含完整冻结 context
与脱敏后的 request/response 审计，应按敏感实验工件保护，不能放进公共目录。
跨 state DB 的唯一实验注册、request reservation 和全局每日 cap 固定放在当前 OS 账户 home 下的
`~/.dsh/trading/r5-control/registry.sqlite`，使用系统账户目录而非 `DSH_HOME`/`HOME` 环境覆盖；同一 experimentId 不能换 state DB。
validation 去重同时保存逐独立时点的 PIT 指纹；任何 validation 与其他 split 共享一个窗口都会被拒绝，因此改 sample/window ID、标签或 dataset hash 也不能复用/泄漏同一验证窗。数据集 hash 仍单独绑定顺序和标签。SIGKILL 后用 boot id + PID startTicks 验明 owner 已退出时，reservation 按最大 USD/token 上界记为已消耗、cost unknown 且绝不重发；owner 仍活着/无法核验时，全局阻断。每日 caps 在 registry 内冻结，预留超限会全局熔断；未知成本调用按最大 USD/token reservation 继续占额并标 `cost_known=false`，当前批次停止，后续静态批次只能在剩余额度内继续，经济闸仍不通过。不要删除/替换 registry 来恢复预算，`--resume` 缺失 registry 会 fail-closed。
共享 registry 同时禁止复用相同 manifest；不同实验可共用控制账本，但每日 USD/token cap 是该账本的单调冻结策略。
执行目录必须仅当前用户可访问（目录 mode 0700、state DB mode 0600）；runner 会拒绝权限过宽的 state 路径，
防止账户 context 或模型 trace 被同机其他用户读取。

## Manifest 契约

Manifest 必须是预先冻结的 `schemaVersion: 1` JSON，并包含：`experimentId`、`development` 或
`validation` split、数据集 id/hash/source、固定 provider/model/输出上限、时间边界、冻结时刻、block length、
绝对回撤上限、selection rule，以及至少 **200 个独立 windowId**；不同 windowId 必须对应不同 PIT 时点，同一时点的多标的样本归入同一窗口。每个 sample 都要带完整且 hash 可复验的
DecisionContext、唯一 `sampleId`、毫秒 `at` 和非空机器可检查标签（预期 outcome、必需 evidence path、禁止开仓、
critic 必需/禁止引用路径或按 evidence path 预标注 critic accept/reject 至少一项）。Critic 专属预标注只在 critique arm 计分；single arm 对这两类标签显示为“不适用”，不伪造 0/0 分母。重复 context hash 不增加样本量；验证段 protocol 必须早于验证段开始时刻冻结。
`dataset.contentHash` 必须等于 `computeR5DatasetHash(samples)`，该 hash 覆盖 sample 顺序、windowId/时点、contextHash 与全部标签，不能由调用者任意填一个符合格式的值。整个数据集必须在非空独立窗口中分别预标注至少一项 Critic 应采纳的纠错和一项应驳回的误报；缺少任一分母会在任何 provider 调用前拒绝 manifest，避免把 0/0 报成通过。
当前静态 runner 将 route 固定为 `deepseek-official/deepseek-flash`，并由测试保证与生产 supervisor 配置一致。
`versions.gitCommit` 必须与当前 HEAD 一致，`buildArtifactsHash` 必须匹配 `pnpm build` 生成的 `lib/build-manifest.json` 及当前全部 `lib/` 产物，执行时要求 tracked worktree clean；还要冻结 context schema、prompt version、
安装的 DSH LLM/provider-adapter 版本与固定 adapter config hash，防止复用同名实验偷换代码或 provider 配置。
模型调用前还要求 manifest 价目版本与实验 state DB 的 `price_table` 完全一致。
Manifest 含完整账户/行情 DecisionContext，应与 state DB 一样作为敏感实验工件保管。hash 仅证明工件内部一致，不证明 `dataset.source`、PIT 来源或 `frozenAt` 声明来自可信的外部不可变记录；这些 provenance 仍须由实验负责人/数据交付流程提供。本仓库没有可验证签名或可信时间戳，静态校验不能替代它们。

Manifest 的结构示意（不是可运行样本；省略的 199 个以上 PIT 样本与真实预标注不可用 fixture 代替）：

```json
{
  "schemaVersion": 1,
  "experimentId": "r5-validation-2026-10-a",
  "split": "validation",
  "dataset": { "id": "frozen-pit-v1", "contentHash": "sha256:<64 hex>", "source": "..." },
  "versions": {
    "gitCommit": "<40-hex commit>",
    "buildArtifactsHash": "sha256:<64 hex from lib/build-manifest.json>",
    "contextSchemaVersion": 1,
    "decisionPromptVersion": "decision-r3-v1",
    "dshLlmVersion": "<installed version>",
    "providerAdapterVersion": "<installed version>",
    "providerConfigHash": "<hash of the R5 fixed adapter config>",
    "priceTableVersion": "<hash of the frozen price_table rows>"
  },
  "preregistration": {
    "frozenAt": 1790800000000,
    "windowStart": 1790800000001,
    "windowEnd": 1798000000000,
    "blockLength": 6,
    "absoluteMaxDrawdownUsd": 25,
    "selectionRule": "critique-if-supported-otherwise-single"
  },
  "route": { "provider": "deepseek-official", "model": "deepseek-flash", "maxTokens": 1024, "maxChars": 180000 },
  "samples": [
    {
      "sampleId": "window-0001-BTC",
      "windowId": "window-0001",
      "at": 1790800000001,
      "context": "<canonical DecisionContext object>",
      "labels": {
        "expectedOutcome": "no_trade",
        "requiredEvidencePaths": ["/sections/portfolio/value/account/equityQuote"],
        "forbiddenOpen": true
      }
    }
  ]
}
```

此静态 runner 完成后仍需独立执行链样本与 forward-paper 权益曲线；完整经济判据见 [`plan.md` §10.2–10.4](../plan.md#10-实施顺序与验收)。缺少预算、真实调用、≥50 个非空执行样本或独立经济曲线时，不得宣布 R5 通过或进入 R6。
