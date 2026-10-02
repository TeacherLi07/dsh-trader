# 模型 provider 路由

交易判断通过 `trade-supervisor.l3.provider/model` 选择 DSH LLM route。`model-provider.ts` 只把冻结的 route 请求交给 `ctx.llm.stream` 并核对 provider/model；凭据、协议序列化、流解析和重试策略都由 DSH adapter 管理。没有交易插件自己的 HTTP、SSE 或 WebSocket 客户端。

## DeepSeek Responses API

当前 DSH 的 `deepseek-official` route 由 `@deepseek-ai/dsh-llm-deepseek` 提供，协议是 DeepSeek Chat Completions + SSE。要优先使用官方 Responses API，配置一个由已挂载 `@deepseek-ai/dsh-llm-pi-ai` 提供的新 route，并将 `trade-supervisor.l3.provider` 指向它。DSH base 已挂载该 adapter；它默认 dormant，可从 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai:` section 注册 route。凭据字段只写环境变量引用：

```yaml
llm-pi-ai:
  providers:
    deepseek-responses:
      displayName: DeepSeek Responses
      apiKeyEnv: DEEPSEEK_API_KEY
      api: openai-responses
      baseURL: https://api.deepseek.com
      reasoning: high
      transport: sse
      retryPolicy:
        mode: normal
        maxRetries: 0
      models:
        - id: deepseek-flash
          name: DeepSeek Flash
          contextWindow: 1048576
          maxTokens: 32768
          reasoningEfforts:
            high: high
            max: max
```

运行时请求 cap 仍由 `trade-supervisor.maxOutputTokens` 设定，必须至少 32768；profile 的 `maxTokens` 是所声明模型的能力上限。生产 W1/W2/W3 仍受 daily budget、token budget 与已知价目闸门控制。

官方 DeepSeek 文档定义 `POST /responses`，并说明 `stream: true` 产生 Responses 事件格式的 SSE。文档没有声明 Responses WebSocket 传输，因此此 route 固定走 SSE。DSH 安装包的 `dsh-llm-pi-ai` 使用 pi-ai `openai-responses` adapter；该 adapter 当前走 OpenAI SDK HTTP/SSE 路径，未实现通用 Responses WebSocket。pi-ai 的 WebSocket 实现位于 OpenAI Codex 专用 Responses adapter，不能据此推断 DeepSeek 或普通 OpenAI-compatible 网关也支持 WS。

这条路由没有 SDK 级重试或 transport fallback：`dsh-llm-pi-ai` 为 pi-ai 固定传 `maxRetries: 0`，OpenAI SDK 请求也固定 `maxRetries: 0`；`retryPolicy.maxRetries: 0` 关闭可选的 DSH `llm-retry` 重放。流中断由上层作为失败/成本未决处理。不要改成 Codex adapter 或打开不受此协议支持的 WebSocket transport。

## Sub2API

公开的 `@godd6366/dsh-sub2api` 插件不实现 LLM wire client。它将 `llm-sub2api:` settings 翻译成 DSH `llm-pi-ai` profile；OpenAI group 的默认协议是 `openai-responses`，其请求仍由 pi-ai 序列化与流解析。启用该第三方插件并配置其模型后，`trade-supervisor.l3` 可以使用该插件实际注册的 route，例如 `sub2api-openai`：

```yaml
llm-sub2api:
  baseURL: http://localhost:8080
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      models:
        - id: <gateway-model-id>
```

`<gateway-model-id>` 必须替换成该 gateway group 实际服务的模型。key 由 DSH credential/env 机制提供，不写入交易配置、prompt 或日志。公开插件说明的是 SSE streaming；本项目不强制 WebSocket，也不假设网关支持 WS。无 DSH/OpenAI SDK 的重试或 WS→HTTP fallback。若未来网关单独证明 WS 支持，应由其 DSH provider adapter 实现并确保“请求已发送但无明确终态”不会被自动重发。

交易成本价目表不能因更换 route 而沿用 DeepSeek 官方价。任何未有独立、可审计 price row 的 sub2api model 都保持 `cost_known=false`，模型判断继续 fail-closed。

## 来源与验证边界

- [DeepSeek Responses API 参考](https://api-docs.deepseek.com/api/create-response/) 与 [Responses API 指南](https://api-docs.deepseek.com/guides/responses_api/)：端点、streaming SSE、thinking effort 和参数支持。
- [DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)：按当前模型返回 context/output 上限与协议能力。
- [DSH `dsh-llm-pi-ai` adapter](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)：配置化 provider route 与 pi-ai adapter。
- [DSH sub2api plugin README](https://github.com/GodD6366/dsh-sub2api) 与 [其 plugin entry source](https://github.com/GodD6366/dsh-sub2api/blob/master/src/index.ts)：插件把 sub2api settings 转成 `llm-pi-ai` profile。

本地只检查了安装包源码和离线接口；没有读取凭据、发起 provider 请求或验证真实 sub2api gateway。Responses route 与模型 quality/cost 仍需独立连接和账单验证。
