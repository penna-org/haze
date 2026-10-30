/** 一条自动导入 */
export interface AutoImportEntry {
  /** 模块中的导出名：具名导出的名字、`default` 或 `*`（命名空间） */
  name: string
  /** 代码中使用的标识符 */
  as: string
  /** 模块：扫描到的文件为绝对路径，依赖包为包名 */
  from: string
  /** 只有类型（interface / type 等）：只生成类型声明，运行时不注入 */
  type?: boolean
}

/**
 * `imports` 中的一项：
 * - `'ref'`：具名导入
 * - `['default', 'dayjs']` / `['*', 'v']`：起别名（`*` 为命名空间导入）
 * - `{ name: 'Ref', type: true }`：只有类型
 */
export type ImportItem = string | [name: string, as: string] | { name: string, as?: string, type?: boolean }

/** 来自依赖包（或任意模块）的自动导入 */
export interface ImportSource {
  from: string
  imports: ImportItem[]
}

export interface AutoImportOptions {
  /** 后端源码目录（绝对路径），`dirs` 相对它解析 */
  srcDir: string
  /**
   * 扫描导出的目录（相对 srcDir 的 glob）：`app/service` 只扫描第一层，`app/service/**` 包含子目录；
   * 最后一段带扩展名时按文件 glob 处理。默认 `DEFAULT_DIRS`。排在前面的目录在重名时优先
   */
  dirs?: string[]
  /** 依赖包等其它模块的自动导入（重名时目录中的导出优先） */
  imports?: ImportSource[]
  /**
   * 预设：包名，读取包的 `<包名>/auto-imports` 子路径（默认导出 `ImportSource` 或其数组）。
   * 默认使用项目 package.json 中所有提供了预设的 `@hazejs/*` 包；`[]` 关闭。重名时优先级最低
   */
  presets?: string[]
  /** 项目根目录（解析预设包的位置），默认 srcDir */
  root?: string
  /** 不自动导入的名字 */
  ignore?: string[]
}

/** 预设模块（`<包名>/auto-imports`）的默认导出 */
export type AutoImportPreset = ImportSource | ImportSource[]

/** 重名：保留第一个，其余忽略 */
export interface AutoImportConflict {
  name: string
  used: AutoImportEntry
  ignored: AutoImportEntry[]
}
