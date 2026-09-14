# Polymarket 客户端实测记录（T1.8，2026-09-14）

> 由 `createPmClients` 直接打三家真实端点产出（原始 JSON 见
> `docs/pm-client-live-2026-09-14.json`）。不是推测，也不是 mock。

## 这次实测推翻/修正了三处与 plan §4.4 表格不一致的假设

| # | 假设 | 实测 | 处理 |
|---|---|---|---|
| 1 | `book.timestamp` 是**秒** | 实际是**毫秒**（`1789399859695`）⇒ 按秒解析会抛错，按"容错"解析会静默回到 1970 年 | 新增 `normalizeSourceMillis()`，与 `normalizeSourceSeconds()` 分开；两个方向都判错（共用 `UNIT_BOUNDARY = 1e11`） |
| 2 | 任何 token 的 `/book` 都是 200 | **尚无盘口的新市场返回 404**（`{"error":"No orderbook exists for the requested token id"}`） | 404 视为**正常数据状态**（`book()` 返回 `null`），**不计入降级计数** —— 否则每冒出一个新市场就会把客户端打到降级 |
| 3 | v1 `prices-history?market=` 可传市场标识 | 必须是 **CLOB token id**；传 `conditionId`（`0x…`）返回 **200 + 空序列**（静默骗人） | `assertTokenId()` 直接拒非十进制 token id |

第 3 条是最危险的：空序列与"概率没变化"在数据上无法区分。

## 实测输出

```json
{
  "ranAt": "2026-09-14T15:32:06.816Z",
  "gamma": {
    "markets": 3,
    "sample": {
      "slug": "xi-jinping-out-before-2027",
      "createdAt": 1751574356889,
      "createdAtIso": "2025-07-03T20:25:56.889Z",
      "clobTokenIds": 2,
      "outcomePrices": [
        0.0355,
        0.9645
      ],
      "spread": 0.001,
      "liquidity": null
    }
  },
  "clobBook": {
    "bids": 34,
    "asks": 130,
    "tickSize": 0.001,
    "minOrderSize": 5,
    "observedAt": 1789399923000,
    "observedAtIso": "2026-09-14T15:32:03.000Z",
    "negRisk": false
  },
  "clobPricesHistoryV1": {
    "points": 169,
    "first": {
      "ts": 1788796816000,
      "price": 0.0405
    },
    "last": {
      "ts": 1789399873000,
      "price": 0.0355
    }
  },
  "dataApiPricesHistoryV2": {
    "points": 1442,
    "first": {
      "ts": 1789313460000,
      "price": 0.0375
    },
    "last": {
      "ts": 1789399912000,
      "price": 0.0355
    }
  },
  "stats": {
    "requests": 4,
    "retries": 0,
    "failures": 0,
    "consecutiveFailures": 0,
    "degraded": false,
    "asOfCalls": 0,
    "tokens": {
      "gamma:markets": 59,
      "clob:book": 299,
      "clob:prices-history": 199,
      "dataApi:prices-history": 39
    }
  },
  "note": "book.timestamp 实测为毫秒；history 的 t/timestamp 实测为秒 ⇒ 两条归一化路径不同（见 normalizeSourceMillis/normalizeSourceSeconds）"
}
```

## 与 plan §10 专项验收的对应

- **⑤ 令牌桶**：各桶剩余令牌可见（`gamma:markets` 59 / `clob:book` 299 等），
  容量 = 官方限额 × 20%；10s 窗口请求数上界有单测（`tests/predictions-client.test.ts`）。
- **⑦ 热路径 `as_of` = 0**：本次实测 `asOfCalls = 0`；热路径传 `asOf` 会抛
  `PmAsOfInHotPathError` 且**不发请求**（有单测）。
- **② 毫秒整数**：v1 的 `t`、v2 的 `timestamp` 与 book 的毫秒时间戳都归一到毫秒整数，
  且单位判错会抛 `PmTimeError`。
- **⑥ 降级不影响主循环**：连续失败达阈值抛 `PmUnavailableError` 并置 `degraded`；
  本次实测 `degraded = false`、`failures = 0`。
