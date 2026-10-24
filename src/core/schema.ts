import type { JsonSchema } from './types.js'

const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value

/** Check a value against the parameter schema subset; returns readable problems, empty when valid. */
export function validate(schema: JsonSchema, value: unknown, path = '参数'): string[] {
  const problems: string[] = []
  if (schema.type) {
    const actual = typeOf(value)
    const ok = schema.type === 'number' ? actual === 'number' || actual === 'integer' : actual === schema.type
    if (!ok) return [`${path} 应为 ${typeName(schema.type)}，实际是 ${typeName(actual)}`]
  }
  if (schema.enum && !schema.enum.includes(value as never)) problems.push(`${path} 只能是 ${schema.enum.map(v => JSON.stringify(v)).join(' / ')}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(schema.minLength === 1 ? `${path} 不能为空` : `${path} 至少 ${schema.minLength} 个字`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} 最多 ${schema.maxLength} 个字`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} 不能小于 ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} 不能大于 ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} 最多 ${schema.maxItems} 项`)
    if (schema.items) value.forEach((item, index) => problems.push(...validate(schema.items!, item, `${path}[${index}]`)))
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (record[key] === undefined) problems.push(`缺少必填参数 ${key}`)
    for (const [key, item] of Object.entries(record)) {
      const child = schema.properties?.[key]
      if (child) { if (item !== undefined) problems.push(...validate(child, item, key)) }
      else if (schema.additionalProperties === false) problems.push(`不认识的参数 ${key}`)
    }
  }
  return problems
}

function typeName(type: string): string {
  return ({ object: '对象', string: '字符串', number: '数字', integer: '整数', boolean: '布尔值', array: '数组', null: '空值', undefined: '未填写' } as Record<string, string>)[type] ?? type
}

/** One line per parameter, for the skill body and for correction hints. */
export function describeParams(schema: JsonSchema): string[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([key, child]) => {
    const parts = [`${key}（${typeName(child.type ?? 'string')}${required.has(key) ? '，必填' : '，可选'}）`]
    if (child.description) parts.push(child.description)
    if (child.enum) parts.push(`可选值：${child.enum.map(v => JSON.stringify(v)).join(' / ')}`)
    return parts.join('：')
  })
}

/** A plausible argument object built from the schema, used as the example in correction hints. */
export function exampleArgs(schema: JsonSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (!(schema.required ?? []).includes(key) && child.examples === undefined) continue
    result[key] = sample(child)
  }
  return result
}

function sample(schema: JsonSchema): unknown {
  if (schema.examples?.length) return schema.examples[0]
  if (schema.default !== undefined) return schema.default
  if (schema.enum?.length) return schema.enum[0]
  switch (schema.type) {
    case 'number': case 'integer': return schema.minimum ?? 1
    case 'boolean': return true
    case 'array': return schema.items ? [sample(schema.items)] : []
    case 'object': return exampleArgs(schema)
    default: return '…'
  }
}
