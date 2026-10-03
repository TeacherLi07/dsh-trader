# R2 HTX 原生最小量口径（2026-10-03）

真实 ccxt 元数据把线性合约 amount.min 写成基础币 contractSize（ADA=10、BTC=0.001、FIL=0.1），但提交的 volume/amount 是张数，step=1。

归一化只有在 symbol/id/contract_code、线性 swap、USDT 分区及 contract_size 均匹配时采用原生整张规则：最小一张，无额外报价币 floor，并保存 minimumRule。未知、缺失或错配身份仍保留 NULL，不静默推断零。

非空真实 FIL 一张开仓成功（约0.105USD）和完整metadata已保存在私有测试目录；源规格与回归见 [JSON](r2-htx-specification-2026-10-03.json)。当前规则只适用于已核验的HTX线性永续，非通用venue猜测。
