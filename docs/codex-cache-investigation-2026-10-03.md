# Codex / Sub2API 缓存调查（2026-10-03）

Luna 子代理只读调查，root复算原始事件。计数与逐请求时间见 [JSON](codex-cache-investigation-2026-10-03.json)。没有额外模型请求或本地KV缓存平台。

| 分项 | 实测 |
|---|---|
| 有终态请求 | 10/11；第11条无终态，费用保持未知 |
| 实际输入 / cache read | 496944 / 6656 tokens，1.3394%；4次各1664，均Envelope工具 |
| cache write | 10条API计数均显式0；第三方账单未核验 |
| 会话 / cache key | 11个请求11个不同key；工作流原先没有传sessionId |
| 首response / 首reasoning item中位 | 1.426s / 2.272s |
| 首可见tool token / 终态中位 | 43.464s / 57.326s；无reasoning文本delta，不能据此精确拆分prefill |
| reasoning token | 24583 / output31822，约77.2% |

注意：费用账本680742 input包含183798未决预留，不能用作实际缓存率分母。只出现1664的命中，符合静态工具前缀复用的模式；不是整个约50k动态context的命中证明。

## 计费与自动管理

OpenAI官方说明 Codex credits没有单独cache-write费用；API-key则按API价目。不能将OAuth/订阅口径直接套为第三方网关账单。[Codex计费](https://learn.chatgpt.com/docs/pricing)

GPT5.6及以后由OpenAI自动做cache routing；prompt_cache_key可用于独立accounting分组，不是命中保证。模型的默认implicit断点/TTL由服务端管理。Sub2API另用session/header/body身份作账号sticky，因此逐请求随机会话仍影响整条网关链。[官方Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Sub2API调度](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/openai_gateway_scheduling.go)

## 最小调整与验证

一次真实decision run的draft/critic/final/repair现在传同一opaque sessionId；provider保持原Codex会话图。每次仍发送完整当次冻结context，没有previous_response_id或本地答案缓存。77文件/867测试通过，新增非空四调用回归；新的有界真实验证已结束，结果见下表；稳定键未显示缓存或延迟收益。

后续可用已有请求的cache diagnostics检查重用边界，先核实目标网关支持。跨run独立缓存namespace、改变静态prefix/材料消息位置或WS复用需要分别验证；动态asOf/contextHash和实时事实始终保留。max effort保持原值，首可见长尾不会由小比例cache hit自动消失。服务端WS retry配置独立于本地maxRetries=0，部署侧尚未核验。


## 稳定会话的真实结果与下一候选

v6 共发出9次 WS 请求，8次有终态；第9次被1013“upstream rate limit exceeded”关闭，没有 usage，原 reservation 保留。前两条完整 critique 判断合法完成；第三条最终阶段失败后停止。相同 run 的三个阶段已实测使用同一键，共3个键。

| 分项 | v6 实测 |
|---|---|
| 实际 input / cached | 396369 / 4992，1.2594% |
| 首 response / 首可见工具 token 中位 | 1.528s / 59.3725s（各8次） |
| 终态中位 | 69.914s（8次） |
| reasoning / output | 25047 / 31104，约80.5% |
| 命中归因 | 3次各1664，均在 tools；instructions 与动态 items 未见缓存归因 |

usage.attribution.request_fields 是此端点返回的观测扩展，未作为公开 API 合同依赖。Envelope tools 为1739 tokens，Critic tools为237；阶段 instructions 内容和工具列表均不同。v5的1.3394%与v6的1.2594%来自不同实时事实和请求，不能当受控A/B；没有收益证据。

Luna进一步建议固定完整工具列表/顺序，以具名 tool_choice 或 allowed_tools 限制本阶段函数，并把阶段指令放在固定公共前缀之后。该候选现已实施，接口、消息边界、预算/hash与回归证据见 [2026-10-04补验](context-prefix-verification-2026-10-04.md)；真实收益仍未证实。原设计要求同步请求预算、hash和回归测试，保留完整当次冻结事实与原 schema 校验。目标网关对 explicit cache 参数的兼容性未核验，不能据上游主分支源码直接启用。未发送额外预热或研究请求。

同版本完整联网恢复被HTX HTTP200中的401 IP白名单拒绝阻断，未到decision replay；它不是恢复成功证据。新增 `terminal-run-replay-check.mjs` 在实际v6 DB副本上对3条终态各重放2次，6次均使用原runId/结果/失败原因，模型和网络调用均0，账本与原DB不变。复现入口与原始输出在 [Luna验收](r5-luna-teacherli-2026-10-03.md)。


最新实现将标识扩展为profile/cohort稳定，完整快照独立成消息；本节的run-scoped v6为历史对照，不能当成新布局的效果验证。


## 2026-10-04 新布局真实验证

同一完整历史快照的三阶段回放后，critic/final各返回48768 cached tokens，冻结user内容46402/46932 tokens命中；公共工具/指令也命中。完整前缀复用已实测，具体原始计数、边界、费用与局限见 [补验](context-prefix-live-2026-10-04.md)。首可见输出仍约47–79s，未证明TTFT改善；不将该回放计入前向经济段。
