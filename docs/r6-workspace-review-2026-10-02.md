# R6 工作区简化（2026-10-02）

本地检查的原始输出见 [同名 JSON](r6-workspace-review-2026-10-02.json)。不构成 R6 实盘验收。

| 判据 | 实测 |
|---|---|
| 删除禁用 watchdog 代码 | 3 文件 / 778 行；保留历史证据与拒绝启动的 systemd unit |
| 不存在源码或生成产物 | watchdog.ts、watchdog.js、daemon/check 脚本均不存在 |
| 完整检查 | pnpm verify：71 文件 / 783 用例通过，exit 0 |
| 非空 halt/保护样本 | 1 持仓、2 挂单；重复 halt 两次后只剩 1 张 stop=95 的保护单 |
| 隔离 DSH 真启动 | paper broker、24.914 模拟权益、2 个命令；halt/resume 均成功 |
| provider / 交易所调用 | 0 / 0，fetch/TCP 网络尝试 0 |

复现：在 dsh-trader 下运行 `pnpm verify`，再运行 `node scripts/offline-startup-check.mjs`。
脚本创建临时 DSH_HOME，以真正 `dsh --profile trade` 加载命令/LLM 服务和生产 db/exec/commands/supervisor 插件；不继承凭据、不挂载行情或 provider adapter，并拦截 fetch/TCP。成功后清理临时 profile 和数据库。

命令仅使用执行组合根，删除没有调用方的第二套 broker 注册入口；halt 提示与手册现在如实说明保留保护单。构建先清理 lib，防止已删源码的产物留在运行包；部署样例只列 paper/live_auto，默认 paper 且未 arm。AGENTS/README 的旧判断链说明已同步实际代码。

R5 真实 critique、forward-paper、资金费来源与经济证据，以及 R6 HTX 非空对账/安全观察仍按 plan.md §12 阻塞；上述隔离启动只验证本地插件接线。
