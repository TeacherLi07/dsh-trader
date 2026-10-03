/** 可选的 Responses strict schema 边界；保留原约束，仅做协议表达转换。 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Context as PiAiContext } from '@earendil-works/pi-ai'
import type { Tool as OpenAIResponsesTool } from 'openai/resources/responses/responses'
import { toStrictJsonSchema } from 'openai/lib/transform'

export type JsonSchemaObject = Record<string, unknown>
type PiAiTool = NonNullable<PiAiContext['tools']>[number]

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strictSchemaFailure(path: string, reason: string): never {
  throw new LlmError('Strict Responses tool schema is unsupported at ' + path + ': ' + reason, 'UNSUPPORTED_SCHEMA')
}

function literalValues(schema: unknown): readonly (string | number | boolean | null)[] | undefined {
  if (!isJsonSchemaObject(schema)) return undefined
  if (Object.hasOwn(schema, 'const')) {
    const value = schema['const']
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value]
    return undefined
  }
  const values = schema['enum']
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) =>
    value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) return undefined
  return values as readonly (string | number | boolean | null)[]
}

function discriminatorKey(variants: readonly unknown[]): string | undefined {
  const objects = variants.filter(isJsonSchemaObject)
  if (objects.length !== variants.length || objects.length < 2) return undefined
  const firstProperties = objects[0]?.['properties']
  const firstRequired = objects[0]?.['required']
  if (!isJsonSchemaObject(firstProperties) || !Array.isArray(firstRequired)) return undefined
  const common = firstRequired.filter((key): key is string => typeof key === 'string' && objects.every((variant) => {
    const required = variant['required']
    return Array.isArray(required) && required.includes(key)
  }))
  for (const key of common) {
    const values = objects.map((variant) => {
      const properties = variant['properties']
      return isJsonSchemaObject(properties) ? literalValues(properties[key]) : undefined
    })
    if (values.some((entry) => entry === undefined)) continue
    const seen = new Set<string>()
    let disjoint = true
    for (const branchValues of values as readonly (readonly (string | number | boolean | null)[])[]) {
      for (const value of branchValues) {
        const identity = JSON.stringify([typeof value, value])
        if (seen.has(identity)) disjoint = false
        seen.add(identity)
      }
    }
    if (disjoint) return key
  }
  return undefined
}

function primitiveTypeSet(schema: unknown): ReadonlySet<string> | undefined {
  if (!isJsonSchemaObject(schema)) return undefined
  const values = literalValues(schema)
  if (values !== undefined) {
    return new Set(values.map((value) => value === null ? 'null' : typeof value === 'number' ? 'number' : typeof value))
  }
  const type = schema['type']
  if (Array.isArray(type) && type.every((entry) => typeof entry === 'string')) {
    return new Set(type.map((entry) => entry === 'integer' ? 'number' : entry))
  }
  if (typeof type === 'string') return new Set([type === 'integer' ? 'number' : type])
  return undefined
}

function hasDisjointTypes(variants: readonly unknown[]): boolean {
  if (variants.length < 2) return false
  const types = variants.map(primitiveTypeSet)
  if (types.some((entry) => entry === undefined)) return false
  const seen = new Set<string>()
  for (const branch of types as readonly ReadonlySet<string>[]) {
    for (const type of branch) {
      if (seen.has(type)) return false
      seen.add(type)
    }
  }
  return true
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isJsonSchemaObject(schema)) return false
  const type = schema['type']
  if (type === 'null' || (Array.isArray(type) && type.includes('null')) || schema['const'] === null) return true
  if (Array.isArray(schema['enum']) && schema['enum'].includes(null)) return true
  for (const key of ['oneOf', 'anyOf']) {
    const variants = schema[key]
    if (Array.isArray(variants) && variants.some(schemaAllowsNull)) return true
  }
  return false
}

function prepareStrictSchemaNode(value: unknown, path: string): JsonSchemaObject {
  if (!isJsonSchemaObject(value)) strictSchemaFailure(path, 'boolean or non-object schemas are unsupported')
  const schema: JsonSchemaObject = { ...value }
  // 标准 JSON Schema 可由 const/enum 隐含类型；上游 strict decoder 要求明确 type，补类型不改变允许值。
  if (schema['type'] === undefined && (Object.hasOwn(schema, 'const') || schema['enum'] !== undefined)) {
    const values = literalValues(schema)
    if (values === undefined || values.some((value) => typeof value === 'number' && !Number.isFinite(value))) {
      strictSchemaFailure(path, 'const/enum must declare a type or contain finite primitive literals')
    }
    const types = [...new Set(values.map((value) => value === null ? 'null' : typeof value))]
    schema['type'] = types.length === 1 ? types[0] : types
  }
  const unsupported = ['$ref', '$defs', 'definitions', 'allOf', 'patternProperties', 'dependentSchemas', 'dependencies',
    'unevaluatedProperties', 'propertyNames', 'contains', 'prefixItems', 'not', 'if', 'then', 'else']
  const unsupportedKey = unsupported.find((key) => schema[key] !== undefined)
  if (unsupportedKey !== undefined) strictSchemaFailure(path, unsupportedKey + ' is not supported')

  const oneOf = schema['oneOf']
  if (oneOf !== undefined) {
    if (!Array.isArray(oneOf) || oneOf.length < 2 || schema['anyOf'] !== undefined) {
      strictSchemaFailure(path, 'oneOf must contain at least two uncombined variants')
    }
    if (discriminatorKey(oneOf) === undefined && !hasDisjointTypes(oneOf)) {
      strictSchemaFailure(path, 'oneOf variants are not provably disjoint by type or required const/enum discriminator')
    }
    // 只改写已证明互斥的分支；否则 anyOf 会放宽 oneOf 的原语义。
    schema['anyOf'] = oneOf.map((variant, index) => prepareStrictSchemaNode(variant, path + '.oneOf[' + index + ']'))
    delete schema['oneOf']
  }

  const properties = schema['properties']
  if (properties !== undefined) {
    if (schema['type'] !== 'object' || !isJsonSchemaObject(properties)) {
      strictSchemaFailure(path, 'properties require an object schema')
    }
    const required = schema['required'] ?? []
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) {
      strictSchemaFailure(path, 'required must be a string array')
    }
    const propertyNames = Object.keys(properties)
    if (required.some((key) => !propertyNames.includes(key))) strictSchemaFailure(path, 'required names an unknown property')
    const requiredSet = new Set(required as string[])
    const prepared: JsonSchemaObject = {}
    for (const [key, property] of Object.entries(properties)) {
      const converted = prepareStrictSchemaNode(property, path + '.properties.' + key)
      prepared[key] = requiredSet.has(key) || schemaAllowsNull(property)
        ? converted
        : { anyOf: [converted, { type: 'null' }] }
    }
    schema['properties'] = prepared
  }

  // 上游实测拒绝 uniqueItems。原 schema 不变，调用方仍按原合同校验；wire 仅约束其支持的结构。
  if (schema['uniqueItems'] !== undefined) {
    if (schema['type'] !== 'array' || typeof schema['uniqueItems'] !== 'boolean') {
      strictSchemaFailure(path, 'uniqueItems requires an array and a boolean constraint')
    }
    if (schema['uniqueItems'] === true) {
      schema['description'] = [schema['description'], 'Items must be unique; the caller validates this against the original schema.'].filter(Boolean).join(' ')
    }
    delete schema['uniqueItems']
  }
  const items = schema['items']
  if (items !== undefined) {
    if (Array.isArray(items)) strictSchemaFailure(path + '.items', 'tuple schemas are unsupported')
    schema['items'] = prepareStrictSchemaNode(items, path + '.items')
  }

  const anyOf = schema['anyOf']
  if (anyOf !== undefined && oneOf === undefined) {
    if (!Array.isArray(anyOf) || anyOf.length === 0) strictSchemaFailure(path, 'anyOf must contain at least one variant')
    schema['anyOf'] = anyOf.map((variant, index) => prepareStrictSchemaNode(variant, path + '.anyOf[' + index + ']'))
  }

  if (schema['type'] === 'object' && schema['additionalProperties'] !== undefined && schema['additionalProperties'] !== false) {
    strictSchemaFailure(path, 'additionalProperties must be false')
  }
  return schema
}

function makeStrictResponsesSchema(parameters: JsonSchemaObject): JsonSchemaObject {
  const prepared = prepareStrictSchemaNode(parameters, '$')
  if (prepared['type'] !== 'object') strictSchemaFailure('$', 'the root must be an object')
  try {
    // 复用 OpenAI SDK 的 strict 规范化，避免自行维护 required 与闭合 object 的规则。
    return toStrictJsonSchema(prepared as never) as JsonSchemaObject
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    strictSchemaFailure('$', detail)
  }
}

export function strictResponsesTools(tools: readonly PiAiTool[]): OpenAIResponsesTool[] {
  const names = new Set<string>()
  return tools.map((tool) => {
    if (names.has(tool.name)) strictSchemaFailure('tools.' + tool.name, 'tool names must be unique')
    names.add(tool.name)
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: makeStrictResponsesSchema(tool.parameters as JsonSchemaObject),
      strict: true,
    }
  })
}

function valueMatchesType(value: unknown, schema: JsonSchemaObject): boolean {
  const type = schema['type']
  if (Array.isArray(type)) return type.some((entry) => valueMatchesType(value, { type: entry }))
  if (type === undefined) return true
  if (type === 'null') return value === null
  if (type === 'object') return isJsonSchemaObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  return true
}

function selectSchemaVariant(value: unknown, variants: readonly unknown[]): JsonSchemaObject | undefined {
  const key = discriminatorKey(variants)
  if (key !== undefined && isJsonSchemaObject(value)) {
    const matches = variants.filter((variant): variant is JsonSchemaObject => {
      if (!isJsonSchemaObject(variant) || !isJsonSchemaObject(variant['properties'])) return false
      const values = literalValues(variant['properties'][key])
      return values !== undefined && values.some((candidate) => candidate === value[key])
    })
    return matches.length === 1 ? matches[0] : undefined
  }
  const literalMatches = variants.filter((variant): variant is JsonSchemaObject => {
    const values = literalValues(variant)
    return isJsonSchemaObject(variant) && values !== undefined && values.some((candidate) => candidate === value)
  })
  if (literalMatches.length === 1) return literalMatches[0]
  const matches = variants.filter((variant): variant is JsonSchemaObject =>
    isJsonSchemaObject(variant) && valueMatchesType(value, variant))
  return matches.length === 1 ? matches[0] : undefined
}

export function restoreOptionalNulls(value: unknown, schema: unknown): unknown {
  if (!isJsonSchemaObject(schema)) return value
  const oneOf = schema['oneOf']
  if (Array.isArray(oneOf)) {
    const selected = selectSchemaVariant(value, oneOf)
    return selected === undefined ? value : restoreOptionalNulls(value, selected)
  }
  const anyOf = schema['anyOf']
  if (Array.isArray(anyOf)) {
    const selected = selectSchemaVariant(value, anyOf)
    return selected === undefined ? value : restoreOptionalNulls(value, selected)
  }
  const properties = schema['properties']
  if (schema['type'] === 'object' && isJsonSchemaObject(properties) && isJsonSchemaObject(value)) {
    const required = new Set(Array.isArray(schema['required']) ? schema['required'] as string[] : [])
    const restored: JsonSchemaObject = { ...value }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue
      const propertyValue = value[key]
      if (propertyValue === null && !required.has(key) && !schemaAllowsNull(propertySchema)) {
        delete restored[key]
      } else {
        restored[key] = restoreOptionalNulls(propertyValue, propertySchema)
      }
    }
    return restored
  }
  const items = schema['items']
  if (schema['type'] === 'array' && Array.isArray(value) && isJsonSchemaObject(items)) {
    return value.map((item) => restoreOptionalNulls(item, items))
  }
  return value
}

