# 模型费用核销验收（2026-10-04）

[完整判定输出](model-billing-reconciliation-2026-10-04.json)。`pnpm verify`：82 文件 / 925 测试通过；全库行覆盖 87.37%、分支 76.97%，核销模块行 96.62%、函数 100%、分支 89.78%。

## 修复内容

原子记账版本的 reservation 可通过单次 clientRequestId、上游 response ID（若已观察到）、run/requestHash/provider/model 与外部账单关联。schema v12 保存不可修改的核销凭据，单次调用及同一 provider 的单条账单均只能核销一次；凭据、费用聚合与审计同事务提交。

核销前核验完整审计哈希链和该日两个 scopes 的完整费用归因。无归因费用、历史非原子记账、身份/模型/response ID 不匹配、非法 usage/金额/时间或过期预览均拒绝。仍有另一条未知调用时 cost_known 不归真。只有外部明确未受理且没有本地生成证据，才允许零 usage/零费用；已观察到输出、response ID 或正 usage 时，矛盾的未受理账单拒绝。

原 reservation、失败、终态 run 与模型输出不回写；原请求禁止重新发送，核销不能恢复交易授权。准入查询只投影身份/状态，避免反复载入历史完整 prompt/response。通用 Sub2API provider 另补实际 key 与其 URL 编码回显为 response ID 时的丢弃保护，四种 loopback 用例覆盖。

## 复现与证据

```bash
cd dsh-trader
pnpm verify
node scripts/model-billing-reconciliation-check.mjs /tmp/new-billing-check-directory
```

命令验收是明确标注的模型/账单 fixture：查看不写原 DB、两条 scopes、1 条核销凭据/审计、重复 apply 不增加记录；原 REVIEW/失败逐字保留，网络/付费请求/订单均 0。真实 SIGKILL 在插入凭据但事务未提交时发生，重启后费用、凭据、审计全部回滚；完整 apply 与再次重启确认唯一落盘。另验跨午夜日归属、另一条未知费用、账单唯一约束、聚合不一致、审计损坏、无配对审计与运行中请求拒绝。

Cordis 隔离 profile 真启动通过，broker=paper，halt/resume 与 Sub2API model 注册非空，networkAttempts/modelCalls 均 0。当前四项凭据的精确/URL 编码扫描覆盖 14264 文件、1379744638 字节，命中 0；扫描排除了凭据文件与编辑器 swap、依赖、git/worktree、coverage。

## 实际操作

先停止交易 profile，备份 DB，以当前代码完成 v12 迁移后准备一个人工核对过的最终 provider USD 账单/usage 证据文件，以及符合 ModelBillingReceipt 合同的 receipt.json。receipt.evidence.sha256 是证据文件原始字节的 SHA-256；来源 URL 不能含认证或查询参数。文件摘要只能证明内容未变，来源真实性由操作者审阅。

```bash
node scripts/model-billing-reconciliation.mjs db.sqlite receipt.json provider-bill.json
node scripts/model-billing-reconciliation.mjs db.sqlite receipt.json provider-bill.json apply sha256:INSPECT_PLAN_HASH '核对记录与原因'
```

首条默认只读 inspect。第二条需要首条的完整 planHash；期间任何审计变化都要求重新查看。该入口仅调整模型费用与未决状态，没有模型或交易所 I/O。

旧真实未知账单本轮核销 **0**：它们缺少新版本的单次传输身份/原子记账凭据及已核验外部账单，继续保留。fixture 结果不作为真实账单、模型判断质量或经济验收证据。生产 funding resolver、独立经济段与 R6 长期观察仍未完成。
