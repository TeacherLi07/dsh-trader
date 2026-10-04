# Context 前缀与协议补验（2026-10-04）

原始计数、来源哈希和私有完整 WS 请求见 [JSON](context-prefix-verification-2026-10-04.json)。

## 实现

- profile 的 DB namespace、provider/model 与 prompt/schema 共同决定稳定会话标识；跨 run/重启保持一致，runId 与每次完整事实仍独立。
- 只读 Envelope/Critic 工具列表、顺序和公共系统指令固定；具名 tool_choice 选择本阶段函数，返回其它工具仍被本地拒绝。
- 完整冻结事实独立放在 user 消息；阶段指令/材料放随后 developer 消息。后续 system 的指令身份由 adapter 保留，tool-result 和同文 user 不被升级。
- prompt 排列先放配置，动态额度/费用/时点/身份保留在后续位置；canonical context/hash 和 JSON Pointer 合同不变。完整工具集合与 selector 进入预算和 requestHash。

该布局依据 [GPT-6 实践指南](https://openai.com/index/practical-guide-building-gpt-6/) 的稳定资料前置原则及 [缓存指南](https://developers.openai.com/api/docs/guides/prompt-caching) 的消息边界要求。目标网关的 explicit cache 参数兼容性未核验，本轮实现使用已有请求字段。

## 非空判定

| 检查 | 结果 |
|---|---|
| 完整本地验证 | 81文件 / 891测试通过 |
| 真实DSH服务与SDK的WS loopback | 8次请求，2个快照，各draft/repair/critic/final；完整user后接developer，工具/政策固定 |
| 当前事实更新 | 两个不同asOf/hash/价格均完整发出；没有引用前次response |
| 真实v6冻结context的排列比较 | 3个非空快照，旧共同前缀15/14字符，新前缀1252/1249字符 |
| 完整性 | 新文本解码后canonical JSON与原事实相同，原DB哈希不变 |
| 恢复隔离 | 旧prompt/schema证据必须用匹配实现；新CLI在开始模型流程前拒绝版本混用 |

字符前缀增长不是缓存token命中或延迟改善证明。8次loopback没有执行付费模型，也不计入R5真实行情样本。真实回放后两阶段已返回48768 cached tokens；见 [真实缓存补验](context-prefix-live-2026-10-04.md)。字节排列检查本身仍不代表服务端命中。

复现本地协议捕获（输出父目录应为700，文件必须不存在）：

```bash
TRADER_CONTEXT_PREFIX_EVIDENCE=/private/new-ws-frames.json pnpm vitest run tests/sub2api-responses-ws.test.ts tests/decision-context-serialization.test.ts tests/decision-workflow.test.ts tests/decision-runtime.test.ts tests/terminal-replay-version.test.ts
```

短provider探针同时补修：usage先记账再校验输出；有终态但schema失败仍保留参考费用；无终态保留上界。每次最多2请求、max8192、max effort、官方参考上界总额0.05 USD；原ws/report存在则拒绝重发，未宣称网关实付已核验。


历史provider回放入口：`node scripts/context-prefix-model-check.mjs <已完成真实运行的DB> <新私有目录>`。只选费用已知、无workflow failure的原始快照；原asOf/hash保留，不启动交易服务，不算前向paper样本。三阶段加至多一次repair，上界最多4请求、32768输出tokens、max effort、官方参考总额0.30 USD；真实命中/延迟另写实测结果。


短provider补验2请求/2次usage通过：具名双strict工具和后续developer消息均被真实服务接受，原Envelope校验通过；参考上界0.0008535 USD，未知预留0。该工具→工具结果→文本探针不作缓存率比较。
