/**
 * 预编译语句缓存。
 *
 * **为什么必须要有这个**：better-sqlite3 的 `db.prepare()` 每次调用都会新建一个 `Statement`
 * 并把它保留在 `Database` 上，直到数据库关闭。本机实测（`node --expose-gc`，5 万次插入）：
 *
 * | 写法 | RSS 增长 |
 * |---|---|
 * | 每次调用都 `db.prepare(...)` | **+139.5 MB** |
 * | 缓存 `Statement` 复用 | +0.3 MB |
 *
 * 也就是说每次 `prepare()` 泄漏约 **2.8 KB**。7×24 进程里这等于必死 —— 这正是 plan §4.6 R5
 * 与 §10 P0 验收 ⑥（24h 压测）要抓的东西。缓存以 SQL 文本为键；每个方法的 SQL 是固定的，
 * 因此缓存条目数是有限常数（含少量按过滤条件分支的变体）。
 *
 * 这条纪律由 `tests/db-discipline.test.ts` 守住：除本文件外，任何地方都不允许直接 `prepare(`。
 */

import type Database from 'better-sqlite3'

export class Statements {
  readonly #cache = new Map<string, Database.Statement>()

  constructor(private readonly db: Database.Database) {}

  get(sql: string): Database.Statement {
    const cached = this.#cache.get(sql)
    if (cached !== undefined) return cached
    const statement = this.db.prepare(sql)
    this.#cache.set(sql, statement)
    return statement
  }

  /**
   * 用同一连接执行一个原子状态迁移。
   *
   * 订单状态、决策与成交是同一条事实链；调用方若分开提交，SIGKILL 可以把
   * decision 留下却丢掉 intent，重启时反而无法判断是否应该继续执行。事务本身
   * 不调用 prepare，因此不破坏热路径语句缓存纪律。
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** 已缓存的语句数（诊断用；应当是一个很小的常数）。 */
  get size(): number {
    return this.#cache.size
  }
}
