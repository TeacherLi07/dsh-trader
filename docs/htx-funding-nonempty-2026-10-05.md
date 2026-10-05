# HTX 非空资金费与时间对照（2026-10-05）

本文件归档 2026-10-04 的新增只读证据，[原始目录、hash 与判定](htx-funding-nonempty-2026-10-05.json)。本轮没有付费模型或交易请求。

## 非空来源

指定代理、当前工作区凭据、同实例 UID 摘要绑定下，全合约 cross 账单筛选 type30/31：2 天与 7 天窗口各 0 行，30 天窗口出现 1 条 SUI-USDT/USDT 收入。随后用生产严格读取器单独查询 SUI：第一页 1 行、第二页明确空页，分页成功。

实测 type=30 的现金流为 **+0.000794100514755 USDT**，与[官方 V5 账单合同](https://www.htx.com/oplt/api/open_api/interface/detail?interface_id=8cb89359-77b5-11ed-9966-19b930b8bee)的资金费收入分类一致。此次获得非空收入符号证据；支出样本仍缺。账单 scope 与执行 runtime 的同 UID 范围一致，未将旧手动持仓改归属到新的模型决策。

## 创建时间不能直接替代评估时间

[官方历史 funding 接口](https://www.htx.com/oplt/api/open_api/interface/detail?interface_id=8cb89359-77b5-11ed-9966-19b97ea5941)在账单附近返回一条 SUI 事件，funding_time=1788969600000、rate=0.0001；私人账单 created_time=1788969604877，相差 **4877 ms**。

这是两个字段的实测时间差；两端没有共同的 assessment ID，不能据此证明这条公共事件就是私人账单的精确持仓评估时点。[HTX 资金费说明](https://www.htx.com/support/en-us/detail/900001326466)也说明不同合约周期可变，结算处理可能有数秒延迟，边界附近成交可能进入不同批次。因此不按固定 8 小时、创建时间或最近公共事件强行分配模型费用。

本次读取仍返回 `knownDecisionFundingCost=false`。数量/决策归属、评估与发布时点、完整覆盖和生产 resolver 继续待验；空页没有被转成 known-zero，默认 paper。
