import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { JSONSchema, SchemaLike } from './types'

type Mode = 'input' | 'output'

interface StandardJSONSchemaProps {
  jsonSchema?: Partial<Record<Mode, (options: { target: string }) => JSONSchema>>
}

interface ValibotConverter {
  toJsonSchema: (schema: unknown, config?: Record<string, unknown>) => JSONSchema
}

const BINARY = { type: 'string', format: 'binary' }

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === 'object' && value !== null && '~standard' in value
}

let valibot: Promise<ValibotConverter | undefined> | undefined

/** valibot 通过可选依赖 `@valibot/to-json-schema` 转换，未安装时返回 undefined */
function loadValibot(): Promise<ValibotConverter | undefined> {
  valibot ??= import('@valibot/to-json-schema' as string)
    .then(module => module as ValibotConverter)
    .catch(() => undefined)
  return valibot
}

const cache = new WeakMap<object, Partial<Record<Mode, Promise<JSONSchema | undefined>>>>()

/**
 * 把 schema 转为 JSON Schema（2020-12）：
 * - 实现 Standard JSON Schema 的库（zod 4、arktype 等）直接转换；
 * - valibot 需要安装 `@valibot/to-json-schema`，文件字段转为 `format: binary`；
 * - 普通对象视为 JSON Schema 原样使用。
 *
 * 无法转换时返回 undefined（文档中显示为任意值），不会抛错。
 */
export function toJSONSchema(schema: SchemaLike, mode: Mode = 'input'): Promise<JSONSchema | undefined> {
  if (!isStandardSchema(schema))
    return Promise.resolve(schema)
  let entry = cache.get(schema)
  if (!entry)
    cache.set(schema, entry = {})
  entry[mode] ??= convert(schema, mode).then(json => json && stripMeta(json), () => undefined)
  return entry[mode]
}

async function convert(schema: StandardSchemaV1, mode: Mode): Promise<JSONSchema | undefined> {
  const standard = schema['~standard'] as StandardSchemaV1['~standard'] & StandardJSONSchemaProps
  const native = standard.jsonSchema?.[mode]
  if (native) {
    try {
      return native({ target: 'draft-2020-12' })
    }
    catch {
      return native({ target: 'draft-07' })
    }
  }
  if (standard.vendor !== 'valibot')
    return undefined
  const converter = await loadValibot()
  return converter?.toJsonSchema(schema, {
    target: 'draft-2020-12',
    typeMode: mode,
    // 校验动作尽量转换，无法表达的忽略
    errorMode: 'ignore',
    overrideSchema: ({ valibotSchema }: { valibotSchema: { type?: string } }) =>
      valibotSchema.type === 'file' || valibotSchema.type === 'blob'
        ? { ...BINARY }
        : undefined,
  })
}

function stripMeta(schema: JSONSchema): JSONSchema {
  const { $schema: _, ...rest } = schema
  return rest
}

/** 是否含文件字段（`format: binary` 或 `contentMediaType`），用于选择 multipart/form-data */
export function hasBinary(schema: JSONSchema | undefined): boolean {
  if (!schema || typeof schema !== 'object')
    return false
  if (schema.format === 'binary' || (schema.type === 'string' && typeof schema.contentMediaType === 'string' && !schema.contentMediaType.startsWith('text/')))
    return true
  const children = [
    ...Object.values<JSONSchema>(schema.properties ?? {}),
    schema.items,
    ...(['anyOf', 'oneOf', 'allOf'] as const).flatMap(key => schema[key] ?? []),
  ]
  return children.some(child => hasBinary(child))
}
