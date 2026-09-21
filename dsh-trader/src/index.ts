/**
 * dsh-trader 的包根只作为 DSH host carrier。
 *
 * 执行组合根、交易所 broker 和动作执行器都属于包内实现，不从这里重导出：
 * 否则调用方可绕过插件启动校验，直接持有真实 broker 下单。运行期只由
 * cordis.patch.yml 挂载并经统一组合根接线。
 */
export const name = 'dsh-trader'
export const version = '0.0.1'

/**
 * 纯 UI 包的 host carrier：让 DSH client-modules 发现 ./client。
 * 这里不能启动交易服务；交易行为仍只由 cordis.patch.yml 的 plugins/* 接线。
 */
export function apply(): void {}
