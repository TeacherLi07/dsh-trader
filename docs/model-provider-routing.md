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

此 route 使用官方 OpenAI Node SDK `ResponsesWS` 负责 WebSocket transport，复用 pi-ai 的 Responses message/tool serializer 和 terminal event processor。通用 `openai-responses` 的 `transport: websocket` 不会被读取，不能用来打开 WS。

输入转换遵循 DSH `dsh-llm-pi-ai` 的历史转换方式，支持 system/user/assistant 与 tool-result 文本多轮历史；图片和文件内容明确拒绝，等接入 attachment converter 后再声明支持。

```yaml
- id: llm-sub2api-responses-ws
  name: dsh-trader/plugins/sub2api-responses-ws
  config:
    enabled: true
    baseURL: https://sub2api.example
    apiKeyEnv: SUB2API_OPENAI_API_KEY
    connectTimeoutMs: 10000
    models:
      - id: sub2api:gpt-6
        wireModelId: gpt-6
        name: Gateway GPT-6
        contextWindow: 262144
        maxTokens: 32768
        reasoningEfforts: [high]
        defaultReasoningEffort: high
```

把 `trade-supervisor.l3` 设为 `provider: sub2api-openai-ws, model: sub2api:gpt-6` 后，DSH route 使用 `sub2api:gpt-6` 记账，网关收到 `wireModelId: gpt-6`。Sub2API key 只通过 `apiKeyEnv` reference 解析。adapter 发 `OpenAI-Beta: responses_websockets=2026-02-06`，使用 `HttpsProxyAgent` 读取 HTTPS proxy 环境变量；loopback 地址绕过代理。

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
