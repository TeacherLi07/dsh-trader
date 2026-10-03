# 真实连接测试进度（2026-10-03）

**最新来源变更**：使用负责人指定的 `ai.teacherli.net` / `SUB2API_KEY` / `gpt-6-luna/max`。两组真实 WS 工具往返通过；复杂schema已修复：全量行情W1/W2/W3各一条合法完成；第四条传输未终结后安全停止。最新缓存率1.339%，稳定会话的后续验证继续中。12次已知用量调用标准官方参考0.0535792 USD，账本保守参考上界0.1201505 USD；另0.063202 USD未决预留。最新测试、失败与日志索引见 [Luna验收](r5-luna-teacherli-2026-10-03.md)。后面的 DeepSeek 余额失败是保留的历史证据。

原始汇总见 [JSON](real-integration-progress-2026-10-03.json)。完整脱敏 HTTP/WS、模型流、冻结上下文、usage 和 SQLite 在当前用户私有目录 ~/.dsh/trading/integration-2026-10-02/ 与 integration-2026-10-03/；文件600、目录700。

| 项目 | 实测 |
|---|---|
| 本地完整检查 | 当前76文件 / 855用例；行87.09%，函数90.73%，分支76.68%；原74/832结果留在历史JSON |
| 最终 Responses 批量 | 目标52条，完成38条；122次可核验usage调用；4条因402失败并保持未知费用 |
| 同运行时恢复探针 | 另1条完成；进程重新运行 --resume 后同runId、modelInvocations=0、真实provider请求=0 |
| 全部开发调用 | 154次可核验usage，按官方价目估算1.895202540 USD；另0.223983300 USD未决上限预留，非已证实支出 |
| Sub2API WS | 真实gpt-5.6-sol工具调用通过，172 tokens；价格/账单未知，交易成本闸保持关闭 |
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
