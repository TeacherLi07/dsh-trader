# 真实 WS 请求身份与生产判断链（2026-10-04）

[原始判定/日志摘要](responses-ws-identity-2026-10-04.json)。`pnpm verify` 82 文件 / 926 测试通过。

## 实测

| 分项 | 非空结果 |
|---|---|
| 短协议探针 | 2 次 Luna/max WS；独立请求ID与本地参考费用预留逐一匹配；同 session/thread/cache 标识；完整 envelope 严格校验与真实工具结果历史通过 |
| 生产判断链 | 真实 1431 根 bar / 9 个 series → 冻结 Context → draft/critic/final；3 次实际 socket 请求 ID 全匹配 SQLite reservation；3 次已知 usage/2 scopes 记账/阶段落盘；repair=0 |
| 缓存 | 输入149840，cached97536（65.09%）；后两次各48768；公共 instructions、tools、完整事实与cache key一致 |
| 结果与重放 | completed/NO_TRADE；同 terminal trigger 重放新增模型请求0；paper与真实交易所订单0 |
| 护栏 | 过期、缺日预算、invalidation分别落expired/failed/done；模型/判断callback0 |
| 当前合约连接 | V5余额/持仓/ordinary+algo merged成功，权益24.904121200514755 USDT，持仓/挂单0 |

两条短探针的参考上界估算0.00076175 USD；完整三阶段为0.02026172 USD，未知usage预留0。按[官方Luna价目](https://developers.openai.com/api/docs/models/gpt-6-luna)的普通短上下文费率复算，三阶段参考值0.00969576 USD；本地预算使用长上下文/写缓存上界，网关实付账单未核验。不能根据Codex兼容头认定计费计划或cache-write免费。

实际 socket 观测来自本地 OpenAI SDK 6.40.0 的创建入口；loopback 验证真实握手包含认证/查询信息，但日志只保留准许的关联/Codex头及origin/path。代理后的服务端计费分类仍未核验，日志不含认证头、查询串和其他头。真实 full runtime 同时核验 header-ID/SQLite reservation，而非仅根据高层配置推断。

完整请求使用gpt-6-luna/max、32768输出上限、900秒整轮上限、0.3 USD参考预算与100万token cap；没有新增DeepSeek调用。短探针检验协议/身份/历史，输入布局不同于共享前缀实验；缓存证据来自完整生产判断链。各阶段首个非空工具参数字节/terminal用时见JSON，角色与输出量不同，不能宣称TTFT因果改善。

## 保留的问题与范围

模型 final 引用了不存在的 `/sections/portfolio/value/openOrders/0`，而真实计数叶子 `/sections/portfolio/value/account/openOrders=0` 存在。资格闸保留诊断并降为 decision_only，没有计划/订单。调查确认draft的代码诊断被计算/持久化却没有传到critic/final；后续最小修复单独交付，不改写这条错误样本。

Funding V5读取可用但行数0，不能当作已核验零资金费；生产resolver仍未接线。单个NO_TRADE与结构通过不构成判断质量、独立经济段或14天保护验收。当前默认paper，生产日预算仍未配置。
