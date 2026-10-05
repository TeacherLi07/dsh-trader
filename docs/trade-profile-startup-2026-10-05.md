# R4 部署 profile 重复 provider 修复（2026-10-05）

## 根因与修复

官方 dsh-base 已注册 llm-pi-ai，项目包却再次 insert 相同 id。真实 base/web/trader 合成得到两个条目，Loader 因 duplicate loader entry id 拒绝整棵插件树。将项目 provider 改为按 id 覆盖官方条目，保留两条 DeepSeek Responses/SSE 路由及 high 推理配置；没有修改提示词、上下文前缀或缓存标识。

旧 offline-startup-check 仅装载精简插件 fixture，不包含官方 base/web，因此过去的成功不能证明部署 profile 可启动。保留其局部验证范围，新增 profile-startup.test，直接复用官方启动解析器与合成器检查实际三层 bundle，不再依靠文本缩进判断 provider 所在层。

## 验证

- 原始失败保留；实际三层合成的 llm-pi-ai 数量从 **2 → 1**。修复后 **163 条 entry、163 个唯一 id**，两个 Responses 路由保留、webserver 只有一个、patch 警告 0。
- 定向回归 2 文件 / 5 测试通过；`pnpm verify` **86 文件 / 1018 测试全部通过**。
- 在当前部署的 trade profile 真正前台启动 paper，使用指定代理、端口 3082，组合根状态 ready。
- 无认证根地址返回 401；启动 URL 换取认证 cookie 返回 303。认证后 HTML、页面公告的带版本客户端资源、账户状态、周期列表均 HTTP 200，响应非空；客户端资源 11,443 bytes，包含 Trade Console 与只读状态请求。
- 账户权益 24.914；真实启动前后模型调用与订单意图都是 0，增量 0。测试进程正常中断退出，3082 已释放。
- 原精简隔离探针的 paper、halt/resume、非空 Sub2API 模型目录仍通过，网络和模型调用 0。

可复现的合成回归：

```bash
cd /workspace/dsh-trader
pnpm vitest run tests/profile-startup.test.ts tests/deploy-config.test.ts
```

当前页面启动：

```bash
HTTP_PROXY=http://host.docker.internal:7890 \
HTTPS_PROXY=http://host.docker.internal:7890 \
NODE_USE_ENV_PROXY=1 \
TRADER_MODE=paper TRADER_LIVE_ARMED=0 \
dsh --profile trade --port 3082 --no-open
```

打开终端打印的认证 URL；端口转发时保留查询参数，在侧栏进入 Trade Console。启动 token 和 cookie 没有进入报告，归档启动日志已脱敏。

## 未算作通过的探针

完整 Web 在全新临时 DSH_HOME 中的草稿探针超时，诊断时 settings、credentials、workspace 等初始化尚未完成，根因未定位。没有据此宣称全新安装验收通过，草稿脚本未交付；本次部署启动结论来自当前实际 trade profile。失败日志保留。

首次客户端探针猜测未公告的 /plugins/dsh-trader/client.js 和 /plugins/trade-ui-client/client.js 路径得到 404。官方实现只提供已公告的带版本 combo 资源；最终从 HTML 提取真实 URL 后 HTTP 200，没有为猜测的路径新增路由。

完整输出、范围与日志 hash 见 [JSON](trade-profile-startup-2026-10-05.json)。用户已有的默认 3081 patch 保留在工作区，不随本次修复提交。运行模式仍只有 paper / live_auto，live 需显式 arm、完整凭据和风险限额，并使用独立执行数据库；本次没有测试实盘下单。
