/**
 * 反思检索（plan §4.2 `memory/recall.ts` / T1.4）。
 *
 * 为什么单独一层：`lessons.expires_at` 这个 TTL 如果只有写入而**没有读取侧执行**，
 * 它就只是一列装饰 —— 过期的教训会继续进入判断。检索必须自己执行 TTL。
 *
 * 另外：检索是**按需**的（`trade_recall`），不是把全部教训塞进每次 context；
 * 无条件注入历史反思正是 Reflexion 消融里 0.60 → 0.52 的那条路径。
 */

import type { DecisionJournal, LessonSummary } from '../exec/journal.js'

export interface RecallOptions {
  /** 判断时点 —— TTL 以此为界。 */
  readonly now: number
  readonly symbol?: string
  /** 当前 regime 桶；同桶教训优先。 */
  readonly regimeBucket?: string
  readonly limit?: number
  /** 原始候选池上限（TTL 过滤前）。 */
  readonly scanLimit?: number
}

export interface RecalledLesson extends LessonSummary {
  /** 是否与当前 regime 桶同桶（同桶 → 排序加权）。 */
  readonly regimeMatch: boolean
}

export interface RecallResult {
  /** 过期而**被剔除**的条数 —— 让"TTL 真的在执行"可观测。 */
  readonly expired: number
  readonly lessons: readonly RecalledLesson[]
}

/**
 * 取回**未过期**的教训，同 regime 桶优先、其余按新鲜度降序。
 * 无 `expires_at`（null）的教训视为未过期（旧数据兼容），但排序降权。
 */
export function recallLessons(journal: DecisionJournal, options: RecallOptions): RecallResult {
  const limit = Math.max(1, options.limit ?? 20)
  const scanLimit = Math.max(limit, options.scanLimit ?? Math.min(200, limit * 5))
  const raw = journal.recentLessons(
    options.symbol === undefined ? { limit: scanLimit } : { symbol: options.symbol, limit: scanLimit },
  )

  let expired = 0
  const alive: RecalledLesson[] = []
  for (const lesson of raw) {
    if (lesson.expiresAt !== null && lesson.expiresAt <= options.now) {
      expired += 1
      continue
    }
    alive.push({
      ...lesson,
      regimeMatch: options.regimeBucket !== undefined && lesson.regimeBucket === options.regimeBucket,
    })
  }

  alive.sort((a, b) => {
    if (a.regimeMatch !== b.regimeMatch) return a.regimeMatch ? -1 : 1
    return b.createdAt - a.createdAt
  })

  return { expired, lessons: alive.slice(0, limit) }
}
