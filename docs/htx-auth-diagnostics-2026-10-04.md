# HTX V5 鉴权对照（2026-10-04）

完整数据与私有路径见 [JSON](htx-auth-diagnostics-2026-10-04.json)。全部为只读请求，未下单或撤单。

| 分项 | 权威观测 |
|---|---|
| 代理实际连接 | Node TCP连接到172.17.0.1:7890，包括HTX域名 |
| 出口 | IPv4 179.253.233.113；IPv6 2605:52c0:2:1bc9:f8b0:8eff:fe48:f225 |
| 现货账户查询 | status=ok，1条账户 |
| 当前key元数据 | 匹配当前key的1条记录，normal，readOnly,trade；服务端绑定两条上述IP |
| V5合约余额 | 2026-10-04重测仍HTTP200/业务401 Incorrect IP address |
| 客户端对照 | curl发送同一CCXT签名也业务401；独立HMAC计算与CCXT相同 |
| 域名对照 | api.hbdm.vn和api.hbdm.com均拒绝 |

当前问题不能归为“用户未配置白名单”或“代理未生效”。[ccxt上游实现](https://github.com/ccxt/ccxt/blob/master/ts/src/htx.ts)的linear swap余额仍使用V5，签名路径/参数与本地一致。按负责人纠正，旧合约接口不再用于后续鉴权结论；其失败记录原样保留。

工作区与~/.dsh中的HTX凭据不同；负责人确认使用工作区key，本轮始终使用该key，未切换另一组或修改凭据文件。此前真实FIL生产runtime成功证据仍成立，但已脱敏日志不能证明两次一定使用相同key。

合约返回与当前key元数据的矛盾尚未定位。保持paper与拒绝未知账户状态，继续以V5请求排查；现货成功不冒充合约对账成功。权限查询原响应中的accessKey/UID未写入此报告或诊断日志。
