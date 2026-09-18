/**
 * `when` 表达式 DSL v0（plan.md §3.2）。
 *
 * 设计取向：**受限 DSL，不是通用表达式语言**。
 *   · 只暴露指标/价格/时间/持仓/资金费率等有限词汇；
 *   · 禁止赋值、循环、字符串、任意属性访问、网络、时间函数；
 *   · 只用已收盘 bar 的特征；
 *   · 求值失败一律 **UNCOVERED**（记 `ok:false`），**绝不静默当作 false**。
 *
 * 纯函数、零依赖：同样的输入永远给同样的输出，可离线回放、可单元测试。
 */

export type Primitive = number | boolean

export interface DslContext {
  /** 解析一个取值路径（如 `bar.close`、`position.qty`）；未知返回 undefined。 */
  get(path: string): Primitive | undefined
  /** 解析一个函数调用；未知或参数非法返回 undefined。 */
  call(name: string, args: readonly Primitive[]): Primitive | undefined
  /**
   * 取值路径在**前一根已收盘 bar** 上的值。只有 `crossAbove` / `crossBelow` 需要它。
   * 未提供（例如回放的第一根 bar、指标暖机中）⇒ cross 求值失败 ⇒ 整式 `ok:false` ⇒ UNCOVERED，
   * **不静默当成"没有穿越"**（fail-closed，与本文件其它错误一致）。
   */
  previous?(path: string): Primitive | undefined
}

export class DslError extends Error {
  readonly pos: number
  constructor(message: string, pos: number) {
    super(pos >= 0 ? `${message}（位置 ${pos}）` : message)
    this.name = 'DslError'
    this.pos = pos
  }
}

export type EvalResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly reason: string }

type BinOp = '+' | '-' | '*' | '/' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'and' | 'or'

/** 计划卡来自模型；限制 AST 规模避免深递归/超长表达式拖垮每根 bar 的求值。 */
export const MAX_AST_NODES = 500

export type Expr =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Expr[] }
  | { readonly kind: 'unary'; readonly op: 'not' | '-'; readonly operand: Expr }
  | { readonly kind: 'binary'; readonly op: BinOp; readonly left: Expr; readonly right: Expr }

interface Token {
  readonly type: 'num' | 'id' | 'op' | 'eof'
  readonly value: string
  readonly pos: number
}

/** 多字符运算符必须排在单字符之前。 */
const OPERATORS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '(', ')', ','] as const
const COMPARISONS = ['<', '<=', '>', '>=', '==', '!='] as const

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i] as string
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1
      if (input[j] === '.') {
        j += 1
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1
      }
      tokens.push({ type: 'num', value: input.slice(i, j), pos: i })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j] as string)) j += 1
      tokens.push({ type: 'id', value: input.slice(i, j), pos: i })
      i = j
      continue
    }
    const op = OPERATORS.find((candidate) => input.startsWith(candidate, i))
    if (op !== undefined) {
      tokens.push({ type: 'op', value: op, pos: i })
      i += op.length
      continue
    }
    throw new DslError(`非法字符 ${JSON.stringify(ch)}`, i)
  }
  tokens.push({ type: 'eof', value: '', pos: input.length })
  return tokens
}

class Parser {
  #tokens: readonly Token[]
  #index = 0
  #nodes = 0

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens
  }

  #peek(): Token {
    return this.#tokens[this.#index] as Token
  }

  #next(): Token {
    const token = this.#peek()
    this.#index += 1
    return token
  }

  #isKeyword(keyword: string): boolean {
    const token = this.#peek()
    return token.type === 'id' && token.value === keyword
  }

  #isOp(value: string): boolean {
    const token = this.#peek()
    return token.type === 'op' && token.value === value
  }

  #node<T extends Expr>(node: T): T {
    this.#nodes += 1
    if (this.#nodes > MAX_AST_NODES) {
      throw new DslError(`表达式复杂度超过上限 ${MAX_AST_NODES} 个 AST 节点`, this.#peek().pos)
    }
    return node
  }

  parse(): Expr {
    const expr = this.#parseOr()
    const token = this.#peek()
    if (token.type !== 'eof') throw new DslError(`多余的内容 ${JSON.stringify(token.value)}`, token.pos)
    return expr
  }

  #parseOr(): Expr {
    let left = this.#parseAnd()
    while (this.#isKeyword('or')) {
      this.#next()
      left = this.#node({ kind: 'binary', op: 'or', left, right: this.#parseAnd() })
    }
    return left
  }

  #parseAnd(): Expr {
    let left = this.#parseNot()
    while (this.#isKeyword('and')) {
      this.#next()
      left = this.#node({ kind: 'binary', op: 'and', left, right: this.#parseNot() })
    }
    return left
  }

  #parseNot(): Expr {
    if (this.#isKeyword('not')) {
      this.#next()
      return this.#node({ kind: 'unary', op: 'not', operand: this.#parseNot() })
    }
    return this.#parseComparison()
  }

  #parseComparison(): Expr {
    const left = this.#parseAdditive()
    const token = this.#peek()
    if (token.type === 'op' && (COMPARISONS as readonly string[]).includes(token.value)) {
      this.#next()
      return this.#node({ kind: 'binary', op: token.value as BinOp, left, right: this.#parseAdditive() })
    }
    return left
  }

  #parseAdditive(): Expr {
    let left = this.#parseMultiplicative()
    while (this.#isOp('+') || this.#isOp('-')) {
      const op = this.#next().value as BinOp
      left = this.#node({ kind: 'binary', op, left, right: this.#parseMultiplicative() })
    }
    return left
  }

  #parseMultiplicative(): Expr {
    let left = this.#parseUnary()
    while (this.#isOp('*') || this.#isOp('/')) {
      const op = this.#next().value as BinOp
      left = this.#node({ kind: 'binary', op, left, right: this.#parseUnary() })
    }
    return left
  }

  #parseUnary(): Expr {
    if (this.#isOp('-')) {
      this.#next()
      return this.#node({ kind: 'unary', op: '-', operand: this.#parseUnary() })
    }
    return this.#parsePrimary()
  }

  #parsePrimary(): Expr {
    const token = this.#peek()
    if (token.type === 'num') {
      this.#next()
      return this.#node({ kind: 'num', value: Number(token.value) })
    }
    if (token.type === 'op' && token.value === '(') {
      this.#next()
      const expr = this.#parseOr()
      if (!this.#isOp(')')) throw new DslError('缺少右括号', this.#peek().pos)
      this.#next()
      return expr
    }
    if (token.type === 'id') {
      this.#next()
      if (this.#isOp('(')) {
        this.#next()
        const args: Expr[] = []
        if (!this.#isOp(')')) {
          for (;;) {
            args.push(this.#parseOr())
            if (this.#isOp(',')) {
              this.#next()
              continue
            }
            break
          }
        }
        if (!this.#isOp(')')) throw new DslError(`函数 ${token.value} 缺少右括号`, this.#peek().pos)
        this.#next()
        return this.#node({ kind: 'call', name: token.value, args })
      }
      return this.#node({ kind: 'path', path: token.value })
    }
    throw new DslError(`意外的记号 ${JSON.stringify(token.value || 'EOF')}`, token.pos)
  }
}

/** 解析表达式；语法错误抛 `DslError`（对应"表达式编译成功率"指标）。 */
export function parseExpression(expression: string): Expr {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new DslError('表达式为空', 0)
  }
  return new Parser(tokenize(expression)).parse()
}

function truthy(value: Primitive): boolean {
  return typeof value === 'boolean' ? value : value !== 0
}

function evaluateNode(node: Expr, ctx: DslContext): Primitive {
  switch (node.kind) {
    case 'num':
      return node.value
    case 'path': {
      const value = ctx.get(node.path)
      if (value === undefined) throw new DslError(`未知取值 ${node.path}`, -1)
      return value
    }
    case 'call': {
      // `cross*` 需要前一根 bar 的取值，不能像纯数学函数那样只拿"已求值参数"（前值已丢）。
      if (node.name === 'crossAbove' || node.name === 'crossBelow') {
        return evaluateCross(node.name, node.args, ctx)
      }
      const args = node.args.map((arg) => evaluateNode(arg, ctx))
      const value = ctx.call(node.name, args)
      if (value === undefined) {
        throw new DslError(`未知函数或参数非法 ${node.name}(${args.join(', ')})`, -1)
      }
      return value
    }
    case 'unary': {
      if (node.op === 'not') return !truthy(evaluateNode(node.operand, ctx))
      const value = evaluateNode(node.operand, ctx)
      if (typeof value !== 'number') throw new DslError('一元负号需要数值操作数', -1)
      return -value
    }
    case 'binary':
      return evaluateBinary(node, ctx)
  }
}

/**
 * `crossAbove(a, b)` / `crossBelow(a, b)` —— **边沿**语义，需要前一根 bar。
 *
 * 为什么是特殊形式而不是 `defaultFunctions` 里的普通函数：求值器传给普通函数的参数**已经求值**，
 * 那时"前一根的值"已经无从取得。这里把两个参数表达式分别在**当前**与**前一根**上下文里各求一次：
 *   crossAbove = 前一根 `a <= b` 且当前 `a > b`
 *   crossBelow = 前一根 `a >= b` 且当前 `a < b`
 *
 * 缺前值（第一根 bar / 指标暖机 / 未注入 `previous`）⇒ 抛错 ⇒ 整式 `ok:false` ⇒ UNCOVERED。
 * 这条正是 plan §3.2 承诺的"边沿表达"，也是 §12.2 I 的修复。
 */
function evaluateCross(
  name: 'crossAbove' | 'crossBelow',
  args: readonly Expr[],
  ctx: DslContext,
): boolean {
  const [leftNode, rightNode] = args
  if (args.length !== 2 || leftNode === undefined || rightNode === undefined) {
    throw new DslError(`${name} 需要恰好 2 个参数`, -1)
  }
  const previous = ctx.previous
  if (previous === undefined) {
    throw new DslError(`${name} 需要前一根 bar 的取值，但当前上下文未提供 previous`, -1)
  }
  const previousContext: DslContext = {
    get: (path) => previous(path),
    call: (fnName, fnArgs) => ctx.call(fnName, fnArgs),
  }
  const curLeft = evaluateNode(leftNode, ctx)
  const curRight = evaluateNode(rightNode, ctx)
  const prevLeft = evaluateNode(leftNode, previousContext)
  const prevRight = evaluateNode(rightNode, previousContext)
  if (
    typeof curLeft !== 'number' ||
    typeof curRight !== 'number' ||
    typeof prevLeft !== 'number' ||
    typeof prevRight !== 'number'
  ) {
    throw new DslError(`${name} 需要数值操作数`, -1)
  }
  return name === 'crossAbove'
    ? prevLeft <= prevRight && curLeft > curRight
    : prevLeft >= prevRight && curLeft < curRight
}

function evaluateBinary(
  node: Extract<Expr, { kind: 'binary' }>,
  ctx: DslContext,
): Primitive {
  if (node.op === 'and') {
    // ⚠️ **不短路**：`and`/`or` 两侧都必须求值。若短路，`bar.close < ema20 and rsi14 < 30`
    // 在 rsi14 未注册/暖机时左侧为假就直接返回 false（ok:true），把"未知"伪装成"没命中"。
    // 项目纪律：任何未知取值必须让整式 ok:false → UNCOVERED（fail-closed）。
    const left = truthy(evaluateNode(node.left, ctx))
    const right = truthy(evaluateNode(node.right, ctx))
    return left && right
  }
  if (node.op === 'or') {
    const left = truthy(evaluateNode(node.left, ctx))
    const right = truthy(evaluateNode(node.right, ctx))
    return left || right
  }

  const left = evaluateNode(node.left, ctx)
  const right = evaluateNode(node.right, ctx)

  if (node.op === '==') return left === right
  if (node.op === '!=') return left !== right

  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new DslError(`运算符 ${node.op} 需要数值操作数`, -1)
  }

  switch (node.op) {
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    case '+':
      return left + right
    case '-':
      return left - right
    case '*':
      return left * right
    case '/':
      if (right === 0) throw new DslError('除数为 0', -1)
      return left / right
    default:
      throw new DslError(`不支持的运算符 ${String(node.op)}`, -1)
  }
}

/**
 * 求值。顶层必须是布尔值：`bar.close` 这种"裸值"不是合法条件。
 * 任何失败都返回 `ok:false`，由调用方记为 UNCOVERED 并告警。
 */
export function evaluateExpression(expression: string, ctx: DslContext): EvalResult {
  let ast: Expr
  try {
    ast = parseExpression(expression)
  } catch (error) {
    return { ok: false, reason: `解析失败：${(error as Error).message}` }
  }
  try {
    const value = evaluateNode(ast, ctx)
    if (typeof value !== 'boolean') {
      return { ok: false, reason: `when 必须是布尔值，实际得到 ${typeof value}` }
    }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, reason: `求值失败：${(error as Error).message}` }
  }
}

/** 编译一次、复用多次（回放时每根 bar 求值，不重复解析）。 */
export function compileExpression(expression: string): (ctx: DslContext) => EvalResult {
  const ast = parseExpression(expression)
  return (ctx) => {
    try {
      const value = evaluateNode(ast, ctx)
      if (typeof value !== 'boolean') {
        return { ok: false, reason: `when 必须是布尔值，实际得到 ${typeof value}` }
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, reason: `求值失败：${(error as Error).message}` }
    }
  }
}

/** 收集表达式引用的全部取值路径 —— 用于"只允许词汇表内的字段"的准入校验。 */
export function collectPaths(node: Expr, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'path':
      into.add(node.path)
      break
    case 'call':
      for (const arg of node.args) collectPaths(arg, into)
      break
    case 'unary':
      collectPaths(node.operand, into)
      break
    case 'binary':
      collectPaths(node.left, into)
      collectPaths(node.right, into)
      break
    default:
      break
  }
  return into
}

export function referencedPaths(expression: string): readonly string[] {
  return [...collectPaths(parseExpression(expression))].sort()
}

/**
 * 纯数学函数。`crossAbove` / `crossBelow` **刻意不在这里** ——
 * 它们需要前一根 bar，属于特征层，由 `DslContext.call` 提供。
 */
export function defaultFunctions(name: string, args: readonly Primitive[]): Primitive | undefined {
  const allNumbers = args.every((arg) => typeof arg === 'number')
  if (!allNumbers) return undefined
  const nums = args as readonly number[]
  switch (name) {
    case 'abs':
      return nums.length === 1 ? Math.abs(nums[0] as number) : undefined
    case 'min':
      return nums.length === 2 ? Math.min(nums[0] as number, nums[1] as number) : undefined
    case 'max':
      return nums.length === 2 ? Math.max(nums[0] as number, nums[1] as number) : undefined
    case 'pct':
      if (nums.length !== 2 || nums[1] === 0) return undefined
      return ((nums[0] as number) / (nums[1] as number)) * 100
    case 'between':
      return nums.length === 3
        ? (nums[0] as number) >= (nums[1] as number) && (nums[0] as number) <= (nums[2] as number)
        : undefined
    default:
      return undefined
  }
}
