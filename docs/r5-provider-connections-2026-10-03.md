# R5 provider 真实连接（2026-10-03）

证据摘要见 [JSON](r5-provider-connections-2026-10-03.json)。私有目录保留完整 WS、HTTP 与 SQLite 工件；Sub2API 凭据仅在内存解析，未复制到环境或报告。

- DeepSeek：官方 Responses HTTP/SSE，Flash/high/32768；两条完整 critique、六次调用，NO_TRADE，记录用量估算 0.071231088 USD；重复终态不调用 provider。
- 官方 DeepSeek 两个标准 Responses URL 的只读 WS 握手均 HTTP405，未发送生成请求；文档只列 SSE，当前保留官方 SSE 路由。
- Sub2API：复用官方 OpenAI ResponsesWS 与 pi-ai 序列化/终态处理，独立 DSH provider；真实 gpt-5.6-sol 工具调用通过，非空用量 153 输入 + 19 输出 = 172，发送一次，无 HTTP fallback。
- 首次脚本调用了不存在的 resolveModel 方法，尚未发请求；第二次 gpt-5.4-mini 被该 ChatGPT 账户明确拒绝。全部失败保留；adapter 现保留原始网关错误并脱敏，未知结果/成本不自动重发。
- 凭据由 credentials-local reference 在内存解析。网关价格与账单未核验，费用保持未知；sub2api: 模型 alias 不使用 DeepSeek 价目，交易成本闸继续关闭。

本地 pnpm verify 通过 74 文件 / 832 测试，含非空多轮工具历史、WS 断线/取消无重试和未知 usage 回归。此处是连接与协议证据，不代表模型质量、经济效果或 R5 全阶段通过。
