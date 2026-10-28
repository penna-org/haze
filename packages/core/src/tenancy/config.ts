import type { HttpContext } from '../http/context'
import type { MaybePromise } from '../utils'

/**
 * 租户。业务项目可通过声明合并补充字段（find() 返回的对象，如租户模型）：
 *
 * ```ts
 * declare module '@hazejs/core' {
 *   interface Tenant { name: string, database: string }
 * }
 * ```
 */
export interface Tenant {
  id: string | number
}

/** 从请求中识别租户标识的方式 */
export type TenantResolver
  /** 完整域名作为标识：`acme.com` */
  = | 'domain'
  /** 子域名作为标识：`acme.example.com` → `acme`（需要配置 domain） */
    | 'subdomain'
  /** 请求头（默认 `X-Tenant`） */
    | 'header'
  /** 路径前缀：`/t/acme/posts` → `acme`（路由需包含该段，如 `/t/:tenant/posts`） */
    | 'path'
  /** 自定义：返回标识，undefined 表示未识别 */
    | ((ctx: HttpContext) => MaybePromise<string | undefined>)

/** 每个租户使用独立的数据库连接（连接配置由租户计算，连接池按租户缓存） */
export interface TenantDatabaseConfig {
  /**
   * 按租户切换的连接名（config/database.ts 中的连接，作为模板），默认只有默认连接。
   * 中央数据（租户表等）放在不在列表中的连接上。
   */
  connections?: string[]
  /**
   * 计算租户的连接配置：`(tenant, base) => ({ ...base, url: \`file:./data/${tenant.id}.db\` })`。
   * 不设置时所有租户共用一个数据库，用模型的 `static belongsToTenant = true` 按 tenant_id 列隔离。
   */
  config?: (tenant: Tenant, base: Record<string, any>, name: string) => Record<string, any>
}

export interface TenancyConfig {
  /** 识别方式，按顺序尝试，默认 `['header']` */
  resolvers?: TenantResolver[]
  /** 按标识查找租户，返回 null / undefined 时响应 404 */
  find: (key: string) => MaybePromise<Tenant | null | undefined>
  /** 租户 ID（写入 tenant_id 列、作为缓存 / 路径 / 连接名的标识），默认 `tenant.id` */
  id?: (tenant: Tenant) => string | number
  /** 查找结果在进程内缓存的时间（秒数或 `'1m'`），默认不缓存 */
  remember?: string | number
  /** header 识别的请求头，默认 `X-Tenant` */
  header?: string
  /** subdomain 识别的主域名，如 `example.com` */
  domain?: string
  /** path 识别的前缀，默认 `/t` */
  path?: string
  /** 中央域名：这些域名上的请求不识别租户（subdomain 识别时主域名自动视为中央域名） */
  centralDomains?: string[]
  /** 不识别租户的路径（中央路由），支持结尾的 `*` 通配：`['/health', '/admin/*']` */
  except?: string[]
  /** 未识别出租户标识时是否响应 404，默认 true；false 时以“无租户”继续 */
  required?: boolean
  /**
   * 框架安装的全局识别，默认 true；false 时只在使用了 `tenancy` 中间件的路由上识别租户
   */
  global?: boolean
  /** 缓存隔离：键前缀加上 `tenant:<id>:`，默认开启；可指定只隔离的存储 */
  cache?: boolean | { stores?: string[], prefix?: (id: string) => string }
  /** 文件存储隔离：路径加上 `tenants/<id>/`，默认开启；可指定只隔离的磁盘 */
  storage?: boolean | { disks?: string[], prefix?: (id: string) => string }
  /** Session 隔离：Cookie 名加租户后缀、签名 / 加密密钥按租户派生，默认开启 */
  session?: boolean
  /** 队列任务携带租户 ID，worker 中恢复租户上下文，默认开启 */
  queue?: boolean
  /** 数据库：每租户独立连接（见 TenantDatabaseConfig），或单库 + tenant_id 列（模型上设置 belongsToTenant） */
  database?: TenantDatabaseConfig
}

/** `config/tenancy.ts` 的默认导出 */
export function defineTenancyConfig(config: TenancyConfig | (() => TenancyConfig)): TenancyConfig | (() => TenancyConfig) {
  return config
}
