/** 决策错误进入审计、rationale 前的共同凭据脱敏边界。 */

const SENSITIVE_ASSIGNMENT = /(["']?(?:api[_-]?key|api[_-]?secret|secret[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key)["']?\s*[:=]\s*)(["']?)(?:(?:bearer|basic)\s+)?([^\s"'`,;{}\]]+)(["']?)/gi

export function redactDecisionErrorText(value: string): string {
  return value.replace(SENSITIVE_ASSIGNMENT, '$1$2[REDACTED]$4')
}
