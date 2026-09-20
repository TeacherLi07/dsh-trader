/**
 * 同一 runtime 的开仓/撤保护操作共用一把内存互斥锁。
 *
 * 交易所快照无法原子预留敞口；若模型工具与机械执行并发读取同一旧快照，两笔不同 client id
 * 都可能通过总敞口闸门。以共享 DecisionJournal 实例作账户锁键，串行化“读状态→过闸→落意图→副作用”。
 * 崩溃后的在途状态仍由持久化 intent + 启动恢复处理；本锁不替代交易所对账。
 */

const tails = new WeakMap<object, Promise<void>>()

export async function withExposureLock<T>(key: object, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  tails.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (tails.get(key) === current) tails.delete(key)
  }
}
