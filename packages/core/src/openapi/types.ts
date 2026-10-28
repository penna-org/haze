import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { RouteRecord } from '../routing/router'

/** JSON Schema（OpenAPI 3.1 使用 2020-12 方言） */
export type JSONSchema = Record<string, any>

/** Standard Schema（valibot / zod / arktype …）或直接写的 JSON Schema */
export type SchemaLike = StandardSchemaV1 | JSONSchema

export interface ResponseDoc {
  description?: string
  /** 响应体 schema（原样输出，不包装统一响应格式） */
  schema?: SchemaLike
  /** 默认 `application/json` */
  contentType?: string
}

/** 路由级文档信息：`.doc({ summary, tags, response })` */
export interface RouteDoc {
  summary?: string
  description?: string
  /** 默认取路径的第一个有效段（跳过 `api` 与 `v1` 这类版本段） */
  tags?: string[]
  deprecated?: boolean
  /** 默认取路由名，未命名时由方法与路径生成 */
  operationId?: string
  /** 不出现在文档中 */
  hidden?: boolean
  /** 成功响应数据的 schema（统一响应格式中的 `data`） */
  response?: SchemaLike
  /** 成功响应的状态码，默认 200 */
  status?: number
  /** 额外的响应：`{ 404: { description: 'Post not found' } }` */
  responses?: Record<number | string, ResponseDoc>
  /** 请求体类型，默认按 body schema 推断（含文件字段时为 multipart/form-data） */
  contentType?: string
  /** 覆盖安全要求，`[]` 表示无需认证；默认按 auth 中间件推断 */
  security?: Array<Record<string, string[]>>
}

export interface OpenAPIInfo {
  title: string
  version: string
  description?: string
  termsOfService?: string
  contact?: { name?: string, url?: string, email?: string }
  license?: { name: string, identifier?: string, url?: string }
  [key: string]: unknown
}

export interface OpenAPIServer {
  url: string
  description?: string
  variables?: Record<string, { default: string, enum?: string[], description?: string }>
}

export type SecurityScheme
  = | { type: 'http', scheme: string, bearerFormat?: string, description?: string }
    | { type: 'apiKey', in: 'header' | 'query' | 'cookie', name: string, description?: string }
    | { type: 'oauth2' | 'openIdConnect' | 'mutualTLS', [key: string]: unknown }

export interface OpenAPIConfig {
  /** 是否提供文档接口，默认生产环境关闭、其它环境开启 */
  enabled?: boolean
  /** JSON 文档地址，默认 `/openapi.json` */
  path?: string
  /** 文档页面地址，默认 `/docs`；false 只提供 JSON */
  docsPath?: string | false
  /** 文档页面，默认 `scalar` */
  ui?: 'scalar' | 'swagger'
  /** 传给 Scalar / Swagger UI 的额外配置 */
  uiOptions?: Record<string, unknown>
  /** 默认 title 取 `config/app.ts` 的 name，version 为 `1.0.0` */
  info?: Partial<OpenAPIInfo>
  /** 默认取 `app.url`（APP_URL） */
  servers?: OpenAPIServer[]
  tags?: Array<{ name: string, description?: string }>
  /**
   * 成功响应的外层格式：默认跟随 `app.response.envelope`；
   * 自定义了 ResponseFormatter 时可传函数，把 `data` 的 schema 包装为实际格式
   */
  envelope?: boolean | ((data: JSONSchema) => JSONSchema)
  /** 额外 / 覆盖的安全方案；默认按 config/auth.ts 的 guards 生成 */
  securitySchemes?: Record<string, SecurityScheme>
  /** 过滤要写入文档的路由 */
  include?: (route: RouteRecord) => boolean
}

export interface OpenAPIOperation {
  operationId: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  parameters?: JSONSchema[]
  requestBody?: JSONSchema
  responses: Record<string, JSONSchema>
  security?: Array<Record<string, string[]>>
  [key: string]: unknown
}

export interface OpenAPIDocument {
  openapi: '3.1.0'
  info: OpenAPIInfo
  servers?: OpenAPIServer[]
  tags?: Array<{ name: string, description?: string }>
  paths: Record<string, Record<string, OpenAPIOperation>>
  components: {
    schemas: Record<string, JSONSchema>
    responses: Record<string, JSONSchema>
    securitySchemes?: Record<string, SecurityScheme>
  }
  [key: string]: unknown
}
