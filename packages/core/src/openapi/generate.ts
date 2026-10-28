import type { AuthConfig } from '../auth/config'
import type { Config, ResponseConfig } from '../config/config'
import type { RouteRecord } from '../routing/router'
import type { JSONSchema, OpenAPIConfig, OpenAPIDocument, OpenAPIOperation, ResponseDoc, SecurityScheme } from './types'
import { Router } from '../routing/router'
import { hasBinary, toJSONSchema } from './schema'

/** 生成文档所需的应用部分（Application 满足该接口） */
export interface OpenAPISource {
  router: Router
  config?: Config
}

const DEFAULT_RESPONSE: ResponseConfig = { envelope: true, successCode: 0, successMessage: 'ok' }
const VERSION_SEGMENT_RE = /^v\d+$/i
const JSON_TYPE = 'application/json'

/** `:id` → `{id}`，`**:path` → `{path}`，匿名通配符按顺序命名 */
export function toOpenAPIPath(path: string): { path: string, params: string[] } {
  const params: string[] = []
  let index = 0
  const converted = path
    .split('/')
    .map((segment) => {
      const named = /^\*{0,2}:(\w+)$/.exec(segment)
      if (named) {
        params.push(named[1])
        return `{${named[1]}}`
      }
      if (segment === '*' || segment === '**') {
        const name = `_${index++}`
        params.push(name)
        return `{${name}}`
      }
      return segment
    })
    .join('/')
  return { path: converted || '/', params }
}

/**
 * 根据已注册的路由生成 OpenAPI 3.1 文档：
 *
 * - 路径参数、query、headers、body 来自 `.validate()` 的 schema；
 * - 成功响应按统一响应格式包装（`.doc({ response })` 描述 `data`）；
 * - 有校验时附带 422，`auth` 中间件附带 401 与安全要求，`can:` / `guest` 附带 403。
 *
 * 需要在应用启动（路由编译）之后调用：`await generateOpenAPI(app)`。
 */
export async function generateOpenAPI(source: OpenAPISource | Router, options: OpenAPIConfig = {}): Promise<OpenAPIDocument> {
  const { router, config } = source instanceof Router
    ? { router: source, config: undefined }
    : source
  const settings: OpenAPIConfig = {
    ...config?.get<OpenAPIConfig>('openapi', {}),
    ...options,
  }
  const response = config?.get<ResponseConfig>('app.response', DEFAULT_RESPONSE) ?? DEFAULT_RESPONSE
  const envelope = settings.envelope ?? response.envelope

  const schemas: Record<string, JSONSchema> = {}
  const responses: Record<string, JSONSchema> = {}
  const security = securitySchemes(config, settings)
  const errorSchema = response.envelope
    ? {
        type: 'object',
        properties: {
          code: {
            type: ['integer', 'string'],
          },
          message: { type: 'string' },
          data: { type: 'null' },
        },
        required: ['code', 'message', 'data'],
      }
    : {
        type: 'object',
        properties: {
          status: { type: 'integer' },
          message: { type: 'string' },
          data: {},
        },
        required: ['status', 'message'],
      }
  const shared: Record<string, () => void> = {
    ValidationError: () => {
      schemas.Error = errorSchema
      schemas.ValidationError = {
        allOf: [
          { $ref: '#/components/schemas/Error' },
          {
            type: 'object',
            properties: {
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    target: {
                      type: 'string',
                      enum: ['params', 'query', 'headers', 'body'],
                    },
                    path: { type: 'string' },
                    message: { type: 'string' },
                  },
                  required: ['path', 'message'],
                },
              },
            },
            required: ['errors'],
          },
        ],
      }
      responses.ValidationError = errorResponse('Validation failed', 'ValidationError')
    },
    Unauthorized: () => {
      schemas.Error = errorSchema
      responses.Unauthorized = errorResponse('Unauthenticated', 'Error')
    },
    Forbidden: () => {
      schemas.Error = errorSchema
      responses.Forbidden = errorResponse('Forbidden', 'Error')
    },
  }
  const use = (name: string): JSONSchema => {
    if (!responses[name])
      shared[name]()
    return { $ref: `#/components/responses/${name}` }
  }
  // $defs 引用的是 schema 自身的根，放进文档后需提升到 components.schemas
  const prepare = (json: JSONSchema | undefined): JSONSchema | undefined => json && hoistDefs(json, schemas)
  const wrap = (data: JSONSchema, record: RouteRecord): JSONSchema => {
    if (record.definition.meta.envelope === false || !envelope)
      return data
    if (typeof envelope === 'function')
      return envelope(data)
    return {
      type: 'object',
      properties: {
        code: {
          type: typeof response.successCode === 'number'
            ? 'integer'
            : 'string',
          const: response.successCode,
        },
        message: {
          type: 'string',
          examples: [response.successMessage],
        },
        data,
      },
      required: ['code', 'message', 'data'],
    }
  }

  const paths: OpenAPIDocument['paths'] = {}
  const operationIds = new Set<string>()
  const usedTags: string[] = []

  for (const record of router.records()) {
    const { definition } = record
    const doc = definition.doc ?? {}
    if (doc.hidden || definition.meta.websocket || record.method === 'ALL' || settings.include?.(record) === false)
      continue

    const { path, params } = toOpenAPIPath(record.path)
    const validate = definition.validate ?? {}
    const [paramsJson, queryJson, headersJson, bodyJson] = await Promise.all([
      validate.params,
      validate.query,
      validate.headers,
      validate.body,
    ].map(async schema => schema && prepare(await toJSONSchema(schema, 'input'))))

    const parameters: JSONSchema[] = [
      ...params.map(name => parameter(name, 'path', paramsJson?.properties?.[name] ?? { type: 'string' }, true)),
      ...objectParameters(queryJson, 'query'),
      ...objectParameters(headersJson, 'header'),
    ]

    const operation: OpenAPIOperation = {
      operationId: uniqueId(doc.operationId ?? record.name ?? defaultOperationId(record.method, path), operationIds),
      responses: {},
    }
    const tags = doc.tags ?? (definition.meta.tags as string[] | undefined) ?? defaultTags(record.path)
    if (tags.length) {
      operation.tags = tags
      usedTags.push(...tags.filter(tag => !usedTags.includes(tag)))
    }
    if (doc.summary)
      operation.summary = doc.summary
    if (doc.description)
      operation.description = doc.description
    if (doc.deprecated)
      operation.deprecated = true
    if (parameters.length)
      operation.parameters = parameters
    if (validate.body) {
      const contentType = doc.contentType ?? (hasBinary(bodyJson)
        ? 'multipart/form-data'
        : JSON_TYPE)
      operation.requestBody = {
        required: true,
        content: {
          [contentType]: { schema: bodyJson ?? {} },
        },
      }
    }

    // 成功响应
    const status = String(doc.status ?? 200)
    const data = doc.response
      ? (prepare(await toJSONSchema(doc.response, 'output')) ?? {})
      : {}
    operation.responses[status] = status === '204'
      ? { description: 'No content' }
      : {
          description: 'Successful response',
          content: {
            [JSON_TYPE]: {
              schema: wrap(data, record),
            },
          },
        }

    if (Object.values(validate).some(Boolean))
      operation.responses['422'] = use('ValidationError')

    const guards = authGuards(record.middleware)
    if (guards) {
      operation.responses['401'] = use('Unauthorized')
      operation.security = guards.map(guard => ({ [security.resolve(guard)]: [] }))
    }
    if (record.middleware.some(name => /^(?:can|guest)(?::|$)/.test(name)))
      operation.responses['403'] = use('Forbidden')
    if (doc.security)
      operation.security = doc.security

    for (const [code, extra] of Object.entries(doc.responses ?? {}))
      operation.responses[code] = await extraResponse(extra, prepare)

    paths[path] ??= {}
    paths[path][record.method.toLowerCase()] = operation
  }

  const info = {
    title: config?.get<string>('app.name', 'API') ?? 'API',
    version: '1.0.0',
    ...settings.info,
  }
  const url = config?.get<string | undefined>('app.url', undefined)
  const servers = settings.servers ?? (url
    ? [
        { url },
      ]
    : undefined)
  const described = new Map((settings.tags ?? []).map(tag => [tag.name, tag]))
  const tags = [
    ...(settings.tags ?? []),
    ...usedTags.filter(tag => !described.has(tag)).map(name => ({ name })),
  ]

  return {
    openapi: '3.1.0',
    info,
    ...(servers && { servers }),
    ...(tags.length && { tags }),
    paths,
    components: {
      schemas,
      responses,
      ...(Object.keys(security.schemes).length && { securitySchemes: security.schemes }),
    },
  }
}

function parameter(name: string, location: 'path' | 'query' | 'header', schema: JSONSchema, required: boolean): JSONSchema {
  const { description, ...rest } = schema
  return {
    name,
    in: location,
    required,
    ...(description && { description }),
    schema: rest,
  }
}

/** 对象 schema 的每个属性展开为一个参数 */
function objectParameters(schema: JSONSchema | undefined, location: 'query' | 'header'): JSONSchema[] {
  if (!schema?.properties)
    return []
  const required: string[] = schema.required ?? []
  return Object.entries<JSONSchema>(schema.properties).map(([name, property]) =>
    parameter(name, location, property, required.includes(name)))
}

async function extraResponse(extra: ResponseDoc, prepare: (json: JSONSchema | undefined) => JSONSchema | undefined): Promise<JSONSchema> {
  const description = extra.description ?? 'Response'
  if (!extra.schema)
    return { description }
  const schema = prepare(await toJSONSchema(extra.schema, 'output')) ?? {}
  return {
    description,
    content: {
      [extra.contentType ?? JSON_TYPE]: { schema },
    },
  }
}

function errorResponse(description: string, schema: string): JSONSchema {
  return {
    description,
    content: {
      [JSON_TYPE]: {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  }
}

/** `auth` → 默认 Guard，`auth:api,web` → 任一 Guard；没有认证中间件时返回 undefined */
function authGuards(middleware: string[]): Array<string | undefined> | undefined {
  const refs = middleware.filter(name => name === 'auth' || name.startsWith('auth:'))
  if (!refs.length)
    return undefined
  const guards = refs.flatMap(ref => ref === 'auth'
    ? [undefined]
    : ref.slice(5).split(',').map(guard => guard.trim()))
  return [
    ...new Set(guards),
  ]
}

function securitySchemes(config: Config | undefined, settings: OpenAPIConfig): { schemes: Record<string, SecurityScheme>, resolve: (guard: string | undefined) => string } {
  const auth = config?.get<AuthConfig | undefined>('auth', undefined)
  const cookie = config?.get<string>('session.cookie', 'haze_session') ?? 'haze_session'
  const schemes: Record<string, SecurityScheme> = {}
  for (const [name, guard] of Object.entries(auth?.guards ?? {})) {
    schemes[name] = guard.driver === 'jwt'
      ? { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
      : { type: 'apiKey', in: 'cookie', name: cookie }
  }
  Object.assign(schemes, settings.securitySchemes)
  return {
    schemes,
    resolve: (guard) => {
      const name = guard ?? auth?.default
      if (name && schemes[name])
        return name
      // 未配置 config/auth.ts（或自定义 Guard）时退回通用的 Bearer 方案
      schemes.bearerAuth ??= { type: 'http', scheme: 'bearer' }
      return 'bearerAuth'
    },
  }
}

function defaultTags(path: string): string[] {
  const segment = path
    .split('/')
    .find(part => part && !part.startsWith(':') && !part.startsWith('*') && part.toLowerCase() !== 'api' && !VERSION_SEGMENT_RE.test(part))
  return segment
    ? [segment]
    : []
}

function defaultOperationId(method: string, path: string): string {
  const words = path
    .split('/')
    .filter(Boolean)
    .map(segment => segment.startsWith('{')
      ? `by-${segment.slice(1, -1)}`
      : segment)
    .flatMap(segment => segment.split(/[^a-z0-9]+/i))
    .filter(Boolean)
  return [
    method.toLowerCase(),
    ...words.map(word => word[0].toUpperCase() + word.slice(1)),
  ].join('')
}

function uniqueId(id: string, used: Set<string>): string {
  let candidate = id
  for (let i = 2; used.has(candidate); i++)
    candidate = `${id}${i}`
  used.add(candidate)
  return candidate
}

/** 把 `$defs` / `definitions` 提升到 components.schemas，并改写对应的 `$ref` */
function hoistDefs(schema: JSONSchema, target: Record<string, JSONSchema>): JSONSchema {
  const { $defs, definitions, ...rest } = schema
  const defs: Record<string, JSONSchema> = {
    ...definitions,
    ...$defs,
  }
  if (!Object.keys(defs).length)
    return schema
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(rewrite)
    if (!value || typeof value !== 'object')
      return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string'
        ? item.replace(/^#\/(?:\$defs|definitions)\//, '#/components/schemas/')
        : rewrite(item),
    ]))
  }
  for (const [name, def] of Object.entries(defs))
    target[name] ??= rewrite(def) as JSONSchema
  return rewrite(rest) as JSONSchema
}
