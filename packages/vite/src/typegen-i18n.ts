import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalizePath } from 'vite'
import { PLUGIN_NAME } from './constants'

export interface I18nTypegenOptions {
  root: string
  srcDir: string
  /** 作为类型来源的语言目录，默认 `en`（不存在时取第一个语言目录） */
  locale?: string
}

export interface I18nTypegenResult {
  file: string
  content: string
  /** 作为类型来源的语言，没有 lang/ 目录时为 undefined */
  locale: string | undefined
  /** 翻译文件（相对语言目录、不带扩展名），如 `messages`、`admin/users` */
  files: string[]
}

const LANG_FILE_RE = /\.(?:[cm]?[jt]s|json)$/

/** 生成位置（与 haze.d.ts 同目录，tsconfig 的 `.haze/types/**\/*.d.ts` 已包含） */
export function i18nTypesFile(root: string): string {
  return join(root, '.haze', 'types', 'i18n.d.ts')
}

interface Tree {
  [key: string]: Tree | string
}

/**
 * 由 `lang/<locale>/**\/*.{ts,json}` 生成 `GeneratedTranslations`，使 `t('messages.welcome')` 的键
 * 经过类型检查（嵌套对象展开为点号路径，`{ one, other }` 视为一个复数键）。
 */
export function generateI18nTypes({ root, srcDir, locale }: I18nTypegenOptions): I18nTypegenResult {
  const file = i18nTypesFile(root)
  const typesDir = join(file, '..')
  const langDir = join(srcDir, 'lang')
  const locales = existsSync(langDir)
    ? readdirSync(langDir).filter(name => statSync(join(langDir, name)).isDirectory()).sort()
    : []
  const source = locale && locales.includes(locale)
    ? locale
    : locales.includes('en')
      ? 'en'
      : locales[0]

  const files = source
    ? collect(join(langDir, source))
    : []
  const tree: Tree = {}
  for (const name of files) {
    const absolute = join(langDir, source!, name)
    let path = normalizePath(relative(typesDir, absolute.replace(/\.[cm]?[jt]s$/, '')))
    if (!path.startsWith('.'))
      path = `./${path}`
    const segments = name.replace(LANG_FILE_RE, '').split('/')
    let node = tree
    for (const segment of segments.slice(0, -1))
      node = (node[segment] ??= {}) as Tree
    node[segments.at(-1)!] = `typeof import(${JSON.stringify(path)})${name.endsWith('.json')
      ? ''
      : '.default'}`
  }

  const content = `// 由 ${PLUGIN_NAME} 自动生成（haze dev / haze typegen），请勿手动修改
// 翻译键的类型来源：lang/${source ?? '<locale>'}
declare module '@hazejs/core' {
  interface GeneratedTranslations {
${render(tree, '    ')}
  }
}

export {}
`
  return {
    file,
    content,
    locale: source,
    files: files.map(name => name.replace(LANG_FILE_RE, '')),
  }
}

/** 内容变化时才写入 */
export async function writeI18nTypes(options: I18nTypegenOptions): Promise<I18nTypegenResult & { changed: boolean }> {
  const result = generateI18nTypes(options)
  const previous = await readFile(result.file, 'utf8').catch(() => undefined)
  if (previous === result.content)
    return { ...result, changed: false }
  await mkdir(join(result.file, '..'), { recursive: true })
  await writeFile(result.file, result.content)
  return { ...result, changed: true }
}

/** 语言目录下的翻译文件（含子目录），相对路径 */
function collect(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.isDirectory())
        return collect(join(dir, entry.name), `${prefix}${entry.name}/`)
      return LANG_FILE_RE.test(entry.name) && !entry.name.endsWith('.d.ts')
        ? [`${prefix}${entry.name}`]
        : []
    })
}

function render(tree: Tree, indent: string): string {
  return Object.entries(tree)
    .map(([key, value]) => typeof value === 'string'
      ? `${indent}${JSON.stringify(key)}: ${value}`
      : `${indent}${JSON.stringify(key)}: {\n${render(value, `${indent}  `)}\n${indent}}`)
    .join('\n')
}
