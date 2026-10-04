# 真实连接测试进度（2026-10-03）

**最新状态（2026-10-03）**：使用负责人指定的 `ai.teacherli.net` / `SUB2API_KEY` / `gpt-6-luna/max` Responses WS。v5有3条完整判断；稳定会话v6又有2条完整判断，第三条最终阶段被上游1013限流关闭，未知费用保留。v6缓存率1.2594%，未证实缓存或延迟改善。真实DB副本6次终态重放模型/网络均0；完整联网恢复另被HTX业务401 IP白名单拒绝阻断。最新测试、费用、失败与日志索引见 [Luna验收](r5-luna-teacherli-2026-10-03.md) 和 [缓存调查](codex-cache-investigation-2026-10-03.md)。后面的DeepSeek余额失败保留为历史证据。

原始汇总见 [JSON](real-integration-progress-2026-10-03.json)。完整脱敏 HTTP/WS、模型流、冻结上下文、usage 和 SQLite 在当前用户私有目录 ~/.dsh/trading/integration-2026-10-02/ 与 integration-2026-10-03/；文件600、目录700。

| 项目 | 实测 |
|---|---|
| 本地完整检查 | 当前81文件 / 891用例；覆盖率最新计数见独立报告，历史统计保留 |
| 历史DeepSeek最终Responses批量 | 目标52条，完成38条；122次可核验usage调用；4条因402失败并保持未知费用 |
| 同运行时恢复探针 | 另1条完成；进程重新运行 --resume 后同runId、modelInvocations=0、真实provider请求=0 |
| 历史DeepSeek开发调用 | 154次可核验usage，按官方价目估算1.895202540 USD；另0.223983300 USD未决上限预留，非已证实支出 |
| Sub2API WS | Luna/max真实两轮工具与完整strict envelope通过；v5/v6完整判断5条，另2条传输未终态；网关账单未核验 |
| HTX生产runtime | 一张0.1 FIL开仓+止损、非空merged对账、runtime重建、幂等、保留保护撤单、reduce-only平仓与最终清理通过 |
| 预测市场只读 | 23个非空市场，14条概率跳变novelty，12项PIT/治理判定通过 |
| DSH/UI | 完整trade配置合成、隔离paper真启动与client bundle座位/只读请求检查通过 |

## 历史 DeepSeek 余额失败与当前状态

DeepSeek返回HTTP402 Insufficient Balance，四个batch均停止；只读余额端点返回is_available=false。最终同运行时版本共39条完成，未达≥50。原错误、request id和未决reservation保留，没有自动重发或换模型；负责人现已停止 DeepSeek 样本补量，走量切至 ai.teacherli.net 的 Luna/max WS；历史未决额度保持原状。

批量全部为NO_TRADE，保存了真实计划/批评工件，但模型开仓/平仓分母为0。source W1/W2/W3是直接runtime身份，不能冒称真实队列worker已通过。schema/工程调用数不构成独立经济结论。生产funding resolver、完整动作/拒绝/恢复分项、forward-paper经济段和R6十四天安全观察仍未达标，默认保持paper。

## 修复与证据

- [HTX原生规格](r2-htx-specification-2026-10-03.md)：原生整张最小量与来源身份核验。
- [HTX broker](r6-real-broker-2026-10-03.md)及[生产runtime](r6-runtime-connection-2026-10-03.md)：账户类型、symbol、TPSL、止损覆盖、算法查询和主单错误路由。
- [Provider连接](r5-provider-connections-2026-10-03.md)：DeepSeek官方Responses/SSE与独立Sub2API WS，复用官方SDK和pi-ai；断线/取消不重发，保留原始诊断。
- [PM PIT](pm-pit-connection-2026-10-03.md)：本机接收时间与源时间分离，具体prob/estimator比对与非空守卫。
- [覆盖率](local-coverage-2026-10-03.md)：本地百分比与真实网络证据分开。

早期自然语言DSL、seq=0、批评格式/长度、提示误写&&/||、错误provider兼容项与HTX首次失败均保留。现在复用计划校验器在阶段提交前使用唯一repair；prompt为decision-r3-v3，Flash/high/32768由真实wire请求确认。测试runner另修复当日预算绝对上限和触发at的持久化，避免重启改变run identity而重复计费。


## 2026-10-04 补充

[Context前缀与协议](context-prefix-verification-2026-10-04.md)完成固定cohort标识、工具集合和独立消息边界，81文件/891测试通过；3个真实冻结快照完整性与原DB不变，8次loopback不计付费模型样本。真实缓存/延迟改善待验证。[HTX鉴权对照](htx-auth-diagnostics-2026-10-04.md)确认代理、双栈出口、当前key权限及IP绑定；现货成功但V5合约仍业务401，根因未确认，原实盘成功证据保留。


新布局的[真实历史回放](context-prefix-live-2026-10-04.md)已通过3阶段/3次usage：critic/final各48768 cached，合计64.98%；参考上界0.02278372 USD，未知预留0。仅验证全快照前缀复用与协议，未证明TTFT或经济效果；HTX V5当前鉴权仍另列。


## 修订恢复补验

[特征恢复](feature-recovery-2026-10-04.md)补齐只重建特征和显式游标确认：159根真实bar副本、53根受影响、模型/网络/订单回调0，原DB与预算不变；另过SIGKILL与1005根分页重启数值一致性。最新82文件/900测试通过。HTX V5鉴权、资金费来源和模型未决账单核销继续单列。

## 2026-10-04 07:44 UTC：V5只读鉴权恢复

[完整对照](htx-auth-diagnostics-2026-10-04.md)：指定代理下 `.vn`/`.com` V5余额成功，生产HtxBroker权益24.904121200514755 USDT、持仓0、merged挂单0；私有读取全部V5，交易动作0。当前合约鉴权阻塞解除，前后差异根因尚未定位，旧失败证据保留。

## 2026-10-04：模型费用核销工程入口

[核销验收](model-billing-reconciliation-2026-10-04.md)：schema v12 的单次请求账单凭据、完整费用归因、原子核销、真实SIGKILL、CLI幂等与paper真启动通过；pnpm verify 82文件/925测试，全库行87.37%/分支76.97%。本次凭据扫描14264文件/1379744638字节、命中0。实际旧未知账单核销0，fixture没有网络/付费请求/订单，独立经济段与funding/长期观察仍待完成。

## 2026-10-04：实际WS身份与完整生产链

[真实WS证据](responses-ws-identity-2026-10-04.md)：短探针2次、完整生产critique 3次，全部teacherli/Luna/max；后者header-ID与SQLite reservation 3/3匹配，cached97536/149840（65.09%），参考上界0.02026172 USD，repair/未知预留/重放新增调用/订单均0。final错误引用空挂单数组元素，被资格闸降decision_only；draft诊断漏传正在单独修复。pnpm verify 82文件/926测试。V5生产broker重建后仍读取成功；funding样本0和经济/长期验收缺口保留。
