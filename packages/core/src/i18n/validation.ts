import type { StandardSchemaV1 } from '@standard-schema/spec'
import { i18nEnabled, useI18n } from './manager'

interface Rule {
  /** 翻译键（相对 `validation.`），如 `required`、`min.string` */
  key: string
  params?: Record<string, unknown>
}

/** valibot / zod 的默认英文消息；自定义消息（含翻译键）不会被替换 */
const DEFAULT_MESSAGE_RE = /^(?:Invalid\b|Too (?:small|big)\b|Unrecognized key)/

const TYPES: Record<string, string> = {
  string: 'string',
  number: 'number',
  bigint: 'integer',
  int: 'integer',
  integer: 'integer',
  boolean: 'boolean',
  array: 'array',
  tuple: 'array',
  object: 'object',
  record: 'object',
  date: 'date',
  file: 'file',
  blob: 'file',
  picklist: 'in',
  enum: 'in',
  literal: 'in',
}

const FORMATS: Record<string, string> = {
  email: 'email',
  url: 'url',
  uuid: 'uuid',
  guid: 'uuid',
  ip: 'ip',
  ipv4: 'ip',
  ipv6: 'ip',
  regex: 'regex',
}

/**
 * 把 Standard Schema 的校验问题翻译为当前语言（存在 config/i18n.ts 时生效）：
 *
 * 1. 消息本身是已存在的翻译键（`v.string('validation.custom_name')`）→ 翻译该键；
 * 2. 校验库的默认消息 → 按问题类型映射到 `validation.*`，字段级覆盖为 `validation.custom.<path>.<rule>`；
 * 3. 其它自定义消息原样保留。
 */
export function localizeIssue(issue: StandardSchemaV1.Issue, path: string, target: string | undefined, input: unknown): string {
  if (!i18nEnabled())
    return issue.message
  const i18n = useI18n()
  if (i18n.has(issue.message))
    return i18n.translate(issue.message)
  if (!DEFAULT_MESSAGE_RE.test(issue.message))
    return issue.message

  const value = valueAt(input, issue.path)
  const rule = classify(issue as unknown as Record<string, unknown>, value) ?? { key: 'invalid' }
  const segments = path.split('.')
  const field = segments.at(-1)
  const attribute = [path, field]
    .filter(Boolean)
    .map(name => `validation.attributes.${name}`)
    .find(key => i18n.has(key))
  const params = {
    ...rule.params,
    attribute: attribute
      ? i18n.translate(attribute)
      : (path || target || 'value'),
  }
  const base = rule.key.split('.')[0]
  const custom = path && [`validation.custom.${path}.${base}`, `validation.custom.${path}.${rule.key}`].find(key => i18n.has(key))
  return i18n.translate(custom || `validation.${rule.key}`, params)
}

/** 识别 valibot（kind / type）与 zod 4（code）的问题类型 */
function classify(issue: Record<string, unknown>, value: unknown): Rule | undefined {
  if (typeof issue.code === 'string')
    return classifyZod(issue, value)
  if (typeof issue.type === 'string')
    return classifyValibot(issue, value)
  return value === undefined
    ? { key: 'required' }
    : undefined
}

function classifyValibot(issue: Record<string, unknown>, value: unknown): Rule | undefined {
  const type = issue.type as string
  const requirement = issue.requirement
  if (issue.kind === 'schema') {
    if (value === undefined || issue.received === 'undefined')
      return { key: 'required' }
    return TYPES[type]
      ? { key: TYPES[type] }
      : undefined
  }
  switch (type) {
    case 'non_empty':
      return { key: 'required' }
    case 'min_length':
      return {
        key: `min.${lengthOrigin(value)}`,
        params: { min: requirement },
      }
    case 'max_length':
      return {
        key: `max.${lengthOrigin(value)}`,
        params: { max: requirement },
      }
    case 'length':
      return {
        key: `size.${lengthOrigin(value)}`,
        params: { size: requirement },
      }
    case 'min_value':
      return {
        key: 'min.number',
        params: { min: requirement },
      }
    case 'max_value':
      return {
        key: 'max.number',
        params: { max: requirement },
      }
    case 'min_size':
      return {
        key: 'min.file',
        params: {
          min: formatBytes(requirement),
        },
      }
    case 'max_size':
      return {
        key: 'max.file',
        params: {
          max: formatBytes(requirement),
        },
      }
    case 'mime_type':
      return {
        key: 'mimes',
        params: {
          values: Array.isArray(requirement)
            ? requirement.join(', ')
            : requirement,
        },
      }
    case 'multiple_of':
      return {
        key: 'multiple_of',
        params: { value: requirement },
      }
    case 'integer':
    case 'safe_integer':
      return { key: 'integer' }
    case 'value':
    case 'values':
      return { key: 'in' }
  }
  return FORMATS[type]
    ? { key: FORMATS[type] }
    : undefined
}

function classifyZod(issue: Record<string, unknown>, value: unknown): Rule | undefined {
  const origin = zodOrigin(issue.origin, value)
  switch (issue.code) {
    case 'invalid_type':
      if (value === undefined)
        return { key: 'required' }
      return TYPES[issue.expected as string]
        ? { key: TYPES[issue.expected as string] }
        : undefined
    case 'too_small':
      if (issue.exact && origin !== 'number') {
        return {
          key: `size.${origin}`,
          params: { size: issue.minimum },
        }
      }
      return {
        key: `min.${origin}`,
        params: {
          min: origin === 'file'
            ? formatBytes(issue.minimum)
            : issue.minimum,
        },
      }
    case 'too_big':
      if (issue.exact && origin !== 'number') {
        return {
          key: `size.${origin}`,
          params: { size: issue.maximum },
        }
      }
      return {
        key: `max.${origin}`,
        params: {
          max: origin === 'file'
            ? formatBytes(issue.maximum)
            : issue.maximum,
        },
      }
    case 'invalid_format':
      return { key: FORMATS[issue.format as string] ?? 'regex' }
    case 'invalid_value':
      return { key: 'in' }
    case 'not_multiple_of':
      return {
        key: 'multiple_of',
        params: { value: issue.divisor },
      }
    case 'unrecognized_keys':
      return {
        key: 'unknown_keys',
        params: {
          keys: Array.isArray(issue.keys)
            ? issue.keys.join(', ')
            : '',
        },
      }
  }
  return undefined
}

function lengthOrigin(value: unknown): 'string' | 'array' {
  return Array.isArray(value)
    ? 'array'
    : 'string'
}

function zodOrigin(origin: unknown, value: unknown): 'string' | 'number' | 'array' | 'file' {
  switch (origin) {
    case 'number':
    case 'int':
    case 'bigint':
    case 'date':
      return 'number'
    case 'array':
    case 'set':
      return 'array'
    case 'file':
      return 'file'
    case 'string':
      return 'string'
  }
  return typeof value === 'number'
    ? 'number'
    : lengthOrigin(value)
}

function formatBytes(value: unknown): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes))
    return String(value)
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${Number.isInteger(size)
    ? size
    : size.toFixed(1)} ${units[unit]}`
}

/** 按问题路径取出输入值（判断缺失字段与长度的来源类型） */
function valueAt(input: unknown, path: StandardSchemaV1.Issue['path']): unknown {
  let current = input
  for (const segment of path ?? []) {
    const key = typeof segment === 'object'
      ? segment.key
      : segment
    if (current === null || typeof current !== 'object')
      return undefined
    current = (current as Record<PropertyKey, unknown>)[key as PropertyKey]
  }
  return current
}
