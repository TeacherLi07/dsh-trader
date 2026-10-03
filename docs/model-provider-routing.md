# 模型 provider 路由

交易判断通过 `trade-supervisor.l3.provider/model` 选择 DSH LLM route。`model-provider.ts` 将冻结的 route 请求交给 `ctx.llm.stream` 并核对 provider/model。provider 协议、凭据、流解析及重试由 DSH adapter 管理。

## DeepSeek Responses API

`cordis.patch.yml` 显式配置 DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai`，默认交易 route 为 `deepseek-responses/deepseek-flash`。profile 使用 DeepSeek 官方 `https://api.deepseek.com` Responses HTTP/SSE、`reasoning: high`，输出能力上限不少于 32768，并将 SDK 与 DSH retry executor 重试数设为 0。R5 隔离 route `deepseek-r5-responses` 使用独立的 `TRADER_R5_API_KEY` reference。

同样的 profile 可程序化挂载到隔离 DSH Context，不需要改共享 settings：

```ts
ctx.plugin('@deepseek-ai/dsh-llm-pi-ai', deepseekResponsesPiAiConfig({
  productionApiKeyEnv: 'DEEPSEEK_API_KEY',
  r5ApiKeyEnv: 'TRADER_R5_API_KEY',
}))
```

此工厂返回 pi-ai 插件实际接受的 `{ providers: { [route]: profile } }` 形状；只包含环境变量 reference，不读取或复制 key。

官方 DeepSeek 文档定义 `POST /responses`，并明确 `stream: true` 使用语义 SSE；没有文档化 WebSocket 传输，所以官方 route 固定走真实可用的 SSE。

2026-10-03 用官方 OpenAI SDK 做仅握手探针：官方 /responses 与 /v1/responses 均返回 HTTP405，未发送 response.create。
当前标准 Responses WS 握手不可用；这不推断其它未公开接口。真实输出走 SSE，原始探针结果见
`docs/r5-provider-connections-2026-10-03.json`，HTTP/WS/模型流原文保留在私有测试目录。

## Sub2API Responses WebSocket

公开 DSH `@godd6366/dsh-sub2api` 插件把 `llm-sub2api:` settings 翻译到 DSH `llm-pi-ai` route；其 `sub2api-openai` 使用 generic `openai-responses` HTTP/SSE adapter。Sub2API gateway 本身另有标准 Responses WebSocket v2 ingress，本项目提供 `sub2api-openai-ws` 作为单独 DSH LLM provider route。

已检查 DSH ChatGPT OAuth 的 `openai-codex-responses`：它要求 OAuth JWT 与 chatgpt-account-id，且原生实现有重连和 SSE fallback。网关 API key 不能替代该 OAuth 会话。这里复用其共享的 Responses 序列化与流处理，并将系统提示写入顶层 `instructions`，认证仍使用 gateway credential ref。

此 route 使用官方 OpenAI Node SDK `ResponsesWS` 负责 WebSocket transport，复用 pi-ai 的 Responses message/tool serializer 和 terminal event processor。通用 `openai-responses` 的 `transport: websocket` 不会被读取，不能用来打开 WS。

输入转换遵循 DSH `dsh-llm-pi-ai` 的历史转换方式，支持 system/user/assistant 与 tool-result 文本多轮历史；图片和文件内容明确拒绝，等接入 attachment converter 后再声明支持。

```yaml
- id: llm-sub2api-responses-ws
  name: dsh-trader/plugins/sub2api-responses-ws
  config:
    enabled: true
    baseURL: https://sub2api.example
    apiKeyEnv: SUB2API_KEY
    connectTimeoutMs: 10000
    models:
      - id: sub2api:gpt-6-luna
        wireModelId: gpt-6-luna
        name: Gateway GPT-6 Luna
        contextWindow: 1050000
        maxTokens: 32768
        reasoningEfforts: [none, xhigh, max]
        defaultReasoningEffort: max
```

把 `trade-supervisor.l3` 设为 `provider: sub2api-openai-ws, model: sub2api:gpt-6-luna` 后，DSH route 使用 `sub2api:gpt-6-luna` 记账，网关收到 `wireModelId: gpt-6-luna`。Sub2API key 只通过 `apiKeyEnv: SUB2API_KEY` reference 解析。adapter 发 `OpenAI-Beta: responses_websockets=2026-02-06`，使用 `HttpsProxyAgent` 读取 HTTPS proxy 环境变量；loopback 地址绕过代理。

reasoning `none` / `xhigh` / `max` 会原样写进 `reasoning.effort`。reasoning 不是 `none` 时会丢弃工作流给出的 `temperature: 0`，并始终不发送 `top_p`；`none` 可以保留 temperature。

OpenAI SDK 自动重连关闭，DSH provider retry policy 的 `maxRetries` 为 0；此 WS route 没有 HTTP fallback。请求发送后若未收到 `response.completed`、`response.incomplete` 或 `response.failed`，adapter 返回 `OUTCOME_UNKNOWN` 并停止，绝不重新发送 `response.create`。已解析的 API key 会从流错误文本中精确脱敏。

`sub2api:` model alias 保持与 DeepSeek 价目表不同；如无该 alias 对应、可审计的价格行，现有 cost gate 将其识别为未知并 fail-closed。不能按同名 wire model 借用 DeepSeek 单价。

## 验证与来源

- [DeepSeek Responses API 参考](https://api-docs.deepseek.com/api/create-response/) 与 [指南](https://api-docs.deepseek.com/guides/responses_api/)：HTTP endpoint、SSE、thinking effort。
- [DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)：context 和 output cap。
- [DSH `dsh-llm-pi-ai` adapter](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)：DSH provider route 配置。
- [DSH sub2api plugin](https://github.com/GodD6366/dsh-sub2api)：settings 到 pi-ai 的 route 适配。
- [Sub2API gateway routes](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/gateway.go) 和 [WS 配置](https://github.com/Wei-Shaw/sub2api/blob/main/deploy/config.example.yaml)：Responses WebSocket v2 ingress。
- [OpenAI Node SDK Responses WS](https://github.com/openai/openai-node/blob/main/docs/responses.md)：官方 WebSocket client/events。

Loopback WS 服务模拟覆盖了非空 `response.create`、pi-ai 事件处理、未终结断线无重连/HTTP 重发、错误中 fake key 脱敏与 usage 完整性。真实 DeepSeek/Sub2API 连接与网关账单仍由主 agent 在预算/隔离凭据护栏内验证。


## Codex CLI 网关标识与 strict 工具

Sub2API WS 请求使用配套 `codex_cli_rs` UA/originator/version，默认版本0.160.0可用 `codexVersion` 配置。会话身份从 DSH `sessionId` 读取，缺省生成UUID；session-id/thread-id/x-client-request-id 与 prompt_cache_key、client_metadata 共用身份。API key 仍由网关 credential ref 解析。指纹来源与真实往返见 [Luna验收](r5-luna-teacherli-2026-10-03.md)。

`strictTools: true` 可开启服务端 strict 结构。只对互斥 discriminator 的 oneOf 做等价 anyOf 转换，复用SDK required/closed-object 处理，optional null 仅还原原schema中允许缺省的字段。必填null/未知字段仍交原校验拒绝。目标服务端实测不支持uniqueItems，该约束保留在原工具schema与本地计划校验，派生wire只约束服务端支持的结构；原执行合同始终要验。授权Luna测试已开启，通用provider默认关闭，没有失败自动降级。
