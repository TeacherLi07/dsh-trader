# Draft 证据诊断反馈（2026-10-04）

[判定与日志摘要](draft-evidence-feedback-2026-10-04.json)。`pnpm verify`：82 文件 / 928 测试通过。

## 修改

代码已经计算并持久化 draft.evidenceIssues，但只把 draft candidate 传给 critic/final。现在把原诊断作为独立末尾材料传给已有两阶段，并要求对照同一冻结事实修正到真实叶子、移除无支持声明或明确标为假设/不确定性。诊断不指定 outcome；原 candidate/错误记录不改写，本地校验不放宽，没有新增调用或 repair。提示行为版本升为 decision-r3-v6，公共 instructions、tools 与完整 Context 的前缀保持不变。

非空 fixture 证明空挂单的 /0 不存在、account.openOrders=0 是可用叶子；critic/final 均收到诊断，hash/预算包含完整材料。最终仍坏的 act 候选保留错误且被资格闸限制为 decision_only，3次调用/repair0，计划/意图/持仓0。

## 真实连接

- **新行情生产链**：1431 根真实 bar / 9 series，3次 teacherli Luna/max WS，与SQLite reservation 3/3匹配；draft/critic/final完成，repair0、terminal重放新增调用0。最终NO_TRADE，4条观察没有无效路径，公共前两条消息一致；新draft诊断为空，不能用此样本冒充非空诊断回归。输入150031、cached97536（65.01%）、输出11803，参考上界0.02392672 USD，订单0。
- **非空历史回放**：从旧真实DeepSeek draft读取1条诊断 `/sections/mandate/value/missing/1`，保持原Context/draft/DB不变；复用draft后只调用teacherli Luna/max的critic/final，两阶段均收到非空代码诊断。2次WS、repair0，final有5条声明且没有无效路径，参考0.02714558 USD、未知预留0。源文件hash未变，不是新增DeepSeek请求或经济样本，没有执行器。
- **保留的前置失败**：第一次选择的v5样本，其错误实际上由final引入，draft诊断为空；非空守卫拒绝继续，API请求0，失败记录保留。诊断漏传是代码审阅确认的独立缺口，不声称它导致了该条v5最终错误。

模型仍可能生成错误；通过路径检查也不证明每段自然语言语义正确。这些连接/回归不能替代独立经济验收、网关实付账单、生产资金费来源或14天观察。当前默认paper，生产日预算未配置。
