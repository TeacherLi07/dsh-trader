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

一次真实decision run的draft/critic/final/repair现在传同一opaque sessionId；provider保持原Codex会话图。每次仍发送完整当次冻结context，没有previous_response_id或本地答案缓存。77文件/867测试通过，新增非空四调用回归；稳定键的命中/延迟收益待新的有界真实请求验证。

后续可用已有请求的cache diagnostics检查重用边界，先核实目标网关支持。跨run独立缓存namespace、改变静态prefix/材料消息位置或WS复用需要分别验证；动态asOf/contextHash和实时事实始终保留。max effort保持原值，首可见长尾不会由小比例cache hit自动消失。服务端WS retry配置独立于本地maxRetries=0，部署侧尚未核验。
