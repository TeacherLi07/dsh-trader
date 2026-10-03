# Luna / Teacherli 真实连接验收（2026-10-03，继续中）

原始汇总见 [JSON](r5-luna-teacherli-2026-10-03.json)。凭据引用为 `SUB2API_KEY`，端点来自负责人指定的 Codex TOML，模型固定 `gpt-6-luna/max`。全部测试保持 paper；完整脱敏 WS/HTTP、冻结 policy、上下文与 SQLite 位于 JSON 列出的私有目录。

| 分项 | 实测 |
|---|---|
| 来源发现 | `/v1/models` 与 `/v1/usage` HTTP200，模型目录包含 gpt-6-luna |
| WS 工具往返 | 两组均通过；每组工具提交 + 工具结果续接，共4次终态调用 |
| 完整 critique | 四组各1条，最终均 REVIEW：三条 schema失败，一条发出后无终态；未宣称通过 |
| 传输身份 | 原始 wire 的模型与 max、终态报告模型均已核对；不发送 temperature/top_p |
| 失败终态跨进程恢复 | 同runId、replayed=true、模型调用/WS提交/模型HTTP均0；仍为REVIEW，原失败保持 |
| 未决请求 | 1条，预留0.063202 USD官方参考上界，不重发、不核销 |
| DSH 包加载 | 独立 WS 插件入口、非空 catalog、paper、halt/resume 真启动通过；网络/模型调用0 |
| 本地检查 | 76文件 / 855测试，行87.09%、分支76.68%、函数90.73%、语句83.13% |

## 问题与改动

1. none/xhigh/max 曾不在 provider 白名单，且推理模型收到 temperature=0：现在保留 effort 原值并省略采样参数。
2. package 缺 WS 插件 exports，直接导入 lib 的探针掩盖了 DSH 包加载问题：补入口并真启动验证。
3. 对齐 DSH ChatGPT OAuth 的顶层 instructions 与输入转换；网关仍用 API key，不伪造 OAuth account header。简单真实工具往返通过。
4. Luna 把 plan 的 commitments/forbidden/noTrade 提升顶层：校验继续拒绝，repair 增加具体字段名，prompt 升 v4。修复后 draft/critic 可完成，最终仍复现错误，现已接通 strict 结构解码；服务端不支持的 uniqueItems 仍由原阶段计划合同验证。
5. 整条多阶段链的测试超时现可冻结配置；新独立组使用15分钟、32768输出、1 USD总额度、2M token。没有改生产上限或重发旧未决请求。

## 费用与范围

正常上下文的官方参考价每百万为输入0.10、缓存读0.01、缓存写0.125、输出0.50 USD；长上下文乘数按官方模型页。账本为避免写缓存/长上下文低估，测试 DB 使用0.25/0.02/0.75参考上界。标准参考与账本上界分别列在 JSON，不当作网关实付。[官方 Luna 模型与价格](https://developers.openai.com/api/docs/models/gpt-6-luna)

前四组开发尝试与两组基础探针共12次已知用量；新增Codex/full-schema探针另2次。标准官方参考与上界分别见 JSON。W2/W3真实队列与零付费守卫尚未进入，不能据本地测试或来源标签声称已通过。无模型交易动作、无真实交易所新单；旧 HTX 非空真实执行证据见 [生产runtime](r6-runtime-connection-2026-10-03.md)。经济有效性、资金费和长期观察仍未完成。

复现（先 pnpm build；输出必须是新私有目录，不自动重发未知结果）：

```sh
NODE_USE_ENV_PROXY=1 node --env-file=.env scripts/sub2api-connection-check.mjs /private/new-ws-probe ~/.codex/config.toml
NODE_USE_ENV_PROXY=1 node --env-file=.env scripts/real-connection-check.mjs --api sub2api-ws --execute-models --samples 6 --decision-timeout-ms 900000 --daily-budget-usd 1 --total-budget-usd 1 --daily-token-cap 2000000 --output-dir /private/new-critique
```


完成工件扫描674文件、430626488字节：当前4组凭据原文/URL编码命中0，私有目录/文件权限违规0。103个历史私有日志已收紧为600，内容不变；原始扫描见私有 JSON。


## Codex 标识与完整工具协议补验

WS 握手使用配套的 `codex_cli_rs/0.160.0` User-Agent、originator 与 version；会话头和请求体 session/thread/cache 元数据一致。版本来自本机 `codex --version`。实际网关完整工具往返2次通过，结果也通过原 DecisionEnvelope 校验；网关部署的分类日志不可读，因此没有宣称取得后台分类记录。

来源：[Codex默认HTTP客户端](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/default_client.rs)、[Codex会话头](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs)、[Codex请求元数据](https://github.com/openai/codex/blob/main/codex-rs/core/src/responses_metadata.rs)、[Sub2API检测与身份配对](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/openai/request.go)。

上游先拒绝隐式 const 类型，再明确拒绝 uniqueItems，两份原始400错误均保留。派生wire schema补显式type，服务端约束其支持的结构；原工具schema和阶段校验保留唯一性，非空重复forbidden回归拒绝。没有声称服务端执行它不支持的约束。

修复终态 reason 返回后，分别复制真实未知费用/输出失败的数据库重放：同runId、reason逐字相同、模型调用0、费用账本不变，原DB不改写。完整全量行情链 v5 正在独立目录中继续；这些短协议探针不计入交易判断样本。


## 全量行情 v5 与安全分支

W1/W2/W3 各完成一条合法三阶段判断（NO_TRADE、REVIEW、NO_TRADE），零schema repair；W2/W3持久队列各有非空done行。第四条Critic发送后无终态，保留未决0.0623335 USD官方上界并停止新调用，因此没有把6条目标标为通过。10次终态实际输入496944、缓存6656；缓存调查见 [报告](codex-cache-investigation-2026-10-03.md)。

真实DB副本另经生产dispatcher核验3条安全分支：过期expired、缺预算failed、P0冻结done；每条有非空审计、重复入队无新行、模型callback/requests为0、费用账本和原DB哈希不变。复现：

```sh
node scripts/trigger-safety-check.mjs /private/real-run/paper.sqlite /private/new-safety-probe
```

稳定run会话的全量v6仍在新目录验证，尚不宣称命中率或首可见延迟收益。
