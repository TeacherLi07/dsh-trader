# Git 工作流

## 分支

- **trunk-based**：`main` 是唯一长期分支，始终保持在可验证状态（`pnpm verify` 全绿）。
- 只在两种情况下开分支，合并用 `git merge --no-ff` 保留决策痕迹，合并后删除：
  - 可能被**否决**的实验 —— 例如 plan §10 P1.5 的 W2/W3 通道有效性门禁（证不出正贡献就要关掉这条通道）；
  - 超过一次提交的重构。
- 命名：`exp/<topic>`、`refactor/<topic>`。

## 提交

**一次提交 = 一个 WBS 任务**（或一次可独立回滚的修复）。格式：

```
<type>(<scope>): <TASK-ID> <subject>

<body：改了什么 / 为什么 / 验证了哪条验收>
```

- `type`：`feat` / `fix` / `test` / `docs` / `refactor` / `chore` / `perf`
- `scope`：`market` / `plan` / `rules` / `trigger` / `exec` / `predictions` / `memory` / `supervisor` / `db` / `docs` / `repo`
- `TASK-ID`：plan.md §11 的任务编号（如 `T0.4`）；无对应任务时省略
- 提交信息里写**验证了什么**（哪条量化验收、多少测试通过），而不是"改了哪些文件"

## 提交前门禁（不可跳过）

```bash
cd dsh-trader && pnpm verify     # typecheck + build + test
```

- **不允许把红色的状态提交到 `main`。**
- 未实现的部分用 `TODO(T<x>)` 显式标注；**不留"看起来绿"的半成品**（测试里不许把未实现路径写成跳过）。

## 标签

- **阶段完成**打 annotated tag：`phase-p0`、`phase-p1`、`phase-p1.5`、`phase-p2` …（对应 plan §10）
- 实盘里程碑另打语义化版本：`v0.1.0-paper`、`v1.0.0-live`
- 打标签的条件是**该阶段 §10 的量化验收全部通过**，并把验收结论写进标签信息（`git tag -a -m`）

## 环境限制（已实测，影响 CI 与验收）

| 限制 | 影响 | 处置 |
|---|---|---|
| `@deepseek-ai/*` 是**运行时 peer**，本机靠 `tsconfig.paths` + `pnpm link:peers` 解析 | 标准 CI 环境没有 DSH 安装 ⇒ typecheck/build 在 CI 失败 | CI 只跑 `pnpm test`（测试不依赖 peer）；**typecheck/build 必须在装有 DSH 的环境执行**。接入远端后应加"先装 DSH 再 verify"的 job |
| 交易所端点**经代理可达**，但 ccxt 自带 fetch 不读 `HTTP(S)_PROXY` | 不注入时表现成"网络不通"（`ECONNREFUSED`），容易误判为环境封锁 | `applyProxyAwareFetch()` 把 Node 全局 fetch 注入 ccxt，`createMarketRuntime` 默认启用；实测 HTX 30 天 1h 回补成功（plan §12 #14） |
| Node `ws` 与 ccxt 都不自动走代理 | WSS 实时流不可用（同端点 HTTPS 正常） | 轮询为默认路径；要用 WSS 需显式 proxy agent（plan §12 #10/#15） |
