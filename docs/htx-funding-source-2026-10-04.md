# HTX V5 资金费来源（2026-10-04）

[结构化证据](htx-funding-source-2026-10-04.json)。本轮没有模型或交易请求。

## 已核验

通过指定代理读取官方页面的公开动态数据，[V5账单合同](https://www.htx.com/oplt/api/open_api/interface/detail?interface_id=8cb89359-77b5-11ed-9966-19b930b8bee)列明GET /v5/account/bills、Read权限、type30资金费收入/type31支出、毫秒start/end/created_time、from游标与prev/next、单页最多100。

真实只读对照显示：显式from=0报1067，首次省略from可取得2条非空FIL-USDT/cross/USDT账单；older-prev以最后ID为锚点，再取得2条严格更旧ID且不重复。资金费筛选仍为空。已观察到交易手续费为负现金流、平仓收益为正现金流；资金费本身的符号尚无非空样本，不能声称已实测。

新HtxFundingLedger直接核验业务code/data、合约/margin mode/币种、毫秒区间、金额、ID与严格游标推进；from首次省略，之后保留字符串ID避免64位精度丢失。短页继续，明确空页才终止；错误/缺data/重复或反向游标/超页上限均抛错，不返回部分成功。返回原现金流、响应指纹与查询范围，不生成FundingCost或known-zero。

`pnpm verify`：83文件/957测试；29个读取器用例含非空三记录、多页、短非末页、超上限、缺data、401、错误币种/contract/margin/time/type/sign与未来区间。新CLI以同一签名key查询UID、仅保存其hash，绑定V5读取；真实1页/0资金费行，knownDecisionFundingCost=false，交易动作0。

```bash
cd dsh-trader
pnpm verify
HTTP_PROXY=http://host.docker.internal:7890 HTTPS_PROXY=http://host.docker.internal:7890 NODE_USE_ENV_PROXY=1 \
  node --env-file=.env scripts/htx-funding-ledger-check.mjs /tmp/new-private-funding-check FROM_MS UNTIL_MS FIL-USDT
```

## 尚未完成的合同

读取器的paginationExhausted只表示游标收到明确空页，不证明历史留存、延迟发布与每个decision持仓归因完整。后续已完成[账户来源基础](execution-account-scope-2026-10-04.md)，并获得[一条真实收入及时间对照](htx-funding-nonempty-2026-10-05.md)；首轮空样本记录保留。数量/decision归因、支出样本与准确评估时点仍未完成，不能把同合约汇总账单分给一笔决策。

现有SettlementScheduler在没有resolver时会保存gross、将net/funding置NULL；临时API或分页错误应保持pending而非写成未知终态。生产resolver本轮尚未接线，未把空历史当作0。paper不能查询live账单为自身虚拟持仓补成本。净收益/独立经济验收仍阻塞，默认paper不变。
