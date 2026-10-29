/** 维护模式的配置（`config/maintenance.ts`） */
export interface MaintenanceConfig {
  /**
   * 状态保存在哪里：
   * - `'cache'`（默认）：缓存存储（`store`，默认缓存的默认存储）。多实例部署请使用共享存储（redis / upstash / kv）；
   *   存储是进程内的 memory 时状态无法跨进程共享，非测试模式下自动改用 `file`（并在 haze down 时提示）；
   * - `'file'`：本地文件（`file`），只影响本机。
   */
  driver?: 'cache' | 'file'
  /** cache 驱动使用的缓存存储名，默认缓存的默认存储 */
  store?: string
  /** cache 驱动的缓存键，默认 `framework:down`（还会加上缓存前缀） */
  key?: string
  /** file 驱动的文件（相对项目根目录），默认 `storage/framework/down` */
  file?: string
  /** 进程内缓存状态的毫秒数（避免每个请求都读取存储），默认 2000；haze up 最多在这段时间后全部生效 */
  interval?: number
  /** 始终放行的路径（支持 `*` 通配），与 haze down --except 合并 */
  except?: string[]
  /** 维护期间暂停队列 worker 与定时任务，默认 true */
  pauseWorkers?: boolean
  /** worker 暂停时检查状态的间隔（毫秒），默认 3000 */
  workerSleep?: number
  /** 绕过维护的 Cookie 名，默认 `haze_maintenance` */
  cookie?: string
  /** 绕过 Cookie 的有效期（秒），默认 12 小时 */
  bypassTtl?: number
}

export interface ResolvedMaintenanceConfig {
  driver: 'cache' | 'file'
  store: string | undefined
  key: string
  file: string
  interval: number
  except: string[]
  pauseWorkers: boolean
  workerSleep: number
  cookie: string
  bypassTtl: number
}

export const defaultMaintenanceConfig: ResolvedMaintenanceConfig = {
  driver: 'cache',
  store: undefined,
  key: 'framework:down',
  file: 'storage/framework/down',
  interval: 2000,
  except: [],
  pauseWorkers: true,
  workerSleep: 3000,
  cookie: 'haze_maintenance',
  bypassTtl: 12 * 3600,
}

/** `config/maintenance.ts` 的默认导出 */
export function defineMaintenanceConfig(config: MaintenanceConfig | (() => MaintenanceConfig)): MaintenanceConfig | (() => MaintenanceConfig) {
  return config
}

/** 维护状态（JSON，保存在缓存或文件中） */
export interface MaintenanceState {
  /** 进入维护的时间（毫秒时间戳） */
  time: number
  /** 绕过密钥的 SHA-256（十六进制），明文不保存 */
  secret?: string
  /** Retry-After 秒数 */
  retry?: number
  /** Refresh 秒数（浏览器自动刷新） */
  refresh?: number
  /** 状态码，默认 503 */
  status: number
  /** HTML 请求重定向到的路径 */
  redirect?: string
  /** 渲染的视图（app/view 下的名称，如 `Maintenance`） */
  render?: string
  /** 放行的路径（支持 `*` 通配） */
  except?: string[]
  /** 提示消息（可以是翻译键） */
  message?: string
}

/** haze down 的选项 */
export interface DownOptions {
  /** 绕过密钥：访问 `/<secret>` 后设置 Cookie，之后可以正常访问 */
  secret?: string
  /** 生成随机的绕过密钥（未传 secret 时） */
  withSecret?: boolean
  /** Retry-After 秒数，默认 60 */
  retry?: number
  refresh?: number
  /** 状态码，默认 503 */
  status?: number
  redirect?: string
  render?: string
  except?: string[]
  message?: string
}
