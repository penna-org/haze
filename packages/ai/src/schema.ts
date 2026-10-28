import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { JSONSchema } from './types'
import { AIError } from './errors'

const kSchema = Symbol.for('hazejs.ai.schema')

export type ValidationResult<T> = { success: true, value: T } | { success: false, issues: ReadonlyArray<{ message: string, path?: ReadonlyArray<unknown> }> }

/** 框架内部统一的 schema：JSON Schema（交给模型）+ 可选的校验函数 */
export interface Schema<T = unknown> {
  readonly [kSchema]: true
  readonly 'jsonSchema': JSONSchema
  'validate'?: (value: unknown) => ValidationResult<T> | Promise<ValidationResult<T>>
  /** 仅用于类型推断 */
  readonly '~output'?: T
}

/**
 * 直接用 JSON Schema 定义（可附带校验函数）：
 *
 * ```ts
 * jsonSchema<{ city: string }>({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] })
 * ```
 */
export function jsonSchema<T = unknown>(schema: JSONSchema, options: { validate?: Schema<T>['validate'] } = {}): Schema<T> {
  return { [kSchema]: true, jsonSchema: schema, validate: options.validate }
}

export function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && kSchema in value
}

/**
 * 工具参数与结构化输出接受的 schema：
 * - 实现 Standard JSON Schema 的库（zod 4、arktype 等）直接转换；
 * - valibot 通过可选依赖 `@valibot/to-json-schema` 转换；
 * - 或者用 `jsonSchema()` 包装的 JSON Schema。
 */
export type SchemaInput<T = any> = StandardSchemaV1<unknown, T> | Schema<T>

export type InferSchema<S> = S extends Schema<infer T> ? T : S extends StandardSchemaV1<any, infer T> ? T : unknown

interface StandardJSONSchemaProps {
  jsonSchema?: {
    input?: (options: { target: string }) => Record<string, unknown>
  }
}

const cache = new WeakMap<object, Promise<Schema>>()

async function convertValibot(schema: unknown): Promise<JSONSchema> {
  let module: { toJsonSchema: (schema: unknown, options?: Record<string, unknown>) => JSONSchema }
  try {
    module = await import('@valibot/to-json-schema' as string) as typeof module
  }
  catch (error) {
    throw new AIError('Using valibot schemas with @hazejs/ai requires @valibot/to-json-schema. Install it with: pnpm add @valibot/to-json-schema', { cause: error })
  }
  // 校验类动作（如 email、minLength）尽量转换，无法表达的忽略而不是报错
  return module.toJsonSchema(schema, { errorMode: 'ignore' })
}

function stripMeta(schema: JSONSchema): JSONSchema {
  const { $schema: _, ...rest } = schema
  return rest
}

/** 把任意支持的 schema 转为内部 Schema（结果按对象缓存） */
export function toSchema<T>(input: SchemaInput<T>): Promise<Schema<T>> {
  if (isSchema(input))
    return Promise.resolve(input as Schema<T>)
  let promise = cache.get(input as object)
  if (!promise) {
    promise = (async () => {
      const standard = (input as StandardSchemaV1)['~standard'] as StandardSchemaV1['~standard'] & StandardJSONSchemaProps
      if (!standard)
        throw new AIError('Expected a Standard Schema (zod, valibot, arktype, …) or jsonSchema({...})')
      const json = standard.jsonSchema?.input
        ? standard.jsonSchema.input({ target: 'draft-07' })
        : standard.vendor === 'valibot'
          ? await convertValibot(input)
          : undefined
      if (!json)
        throw new AIError(`Cannot convert a "${standard.vendor}" schema to JSON Schema: the library does not implement Standard JSON Schema. Use jsonSchema({...}) instead.`)
      return {
        [kSchema]: true,
        jsonSchema: stripMeta(json),
        validate: async (value: unknown) => {
          const result = await standard.validate(value)
          return result.issues
            ? { success: false, issues: result.issues }
            : { success: true, value: result.value }
        },
      } satisfies Schema as Schema
    })()
    cache.set(input as object, promise)
  }
  return promise as Promise<Schema<T>>
}

/** 按 schema 校验；没有校验函数时原样通过 */
export async function validateWithSchema<T>(schema: Schema<T>, value: unknown): Promise<ValidationResult<T>> {
  if (!schema.validate)
    return { success: true, value: value as T }
  return schema.validate(value)
}

export function formatIssues(issues: ReadonlyArray<{ message: string, path?: ReadonlyArray<unknown> }>): string {
  return issues.map((issue) => {
    const path = issue.path?.map(segment => typeof segment === 'object' && segment !== null && 'key' in segment
      ? String((segment as { key: unknown }).key)
      : String(segment)).join('.')
    return path
      ? `${path}: ${issue.message}`
      : issue.message
  }).join('; ')
}
