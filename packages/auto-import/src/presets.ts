import type { AutoImportPreset, ImportSource } from './types'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 预设所在的子路径 */
export const PRESET_SUBPATH = 'auto-imports'

/** 自动发现预设的包名范围（其它包需要在 presets 中显式列出） */
const DETECTED_SCOPE = '@hazejs/'

/** 项目 package.json 中提供了预设的 `@hazejs/*` 包 */
export function detectPresets(root: string): string[] {
  let pkg: { dependencies?: Record<string, string>, devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  }
  catch {
    return []
  }
  const require = createRequire(join(root, 'package.json'))
  return Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  })
    .filter(name => name.startsWith(DETECTED_SCOPE))
    .sort()
    .filter((name) => {
      try {
        require.resolve(`${name}/${PRESET_SUBPATH}`)
        return true
      }
      catch {
        return false
      }
    })
}

/** 从项目根加载预设 */
export async function loadPreset(root: string, name: string): Promise<ImportSource[]> {
  let entry: string
  try {
    entry = createRequire(join(root, 'package.json')).resolve(`${name}/${PRESET_SUBPATH}`)
  }
  catch {
    throw new Error(`[@hazejs/auto-import] Cannot find the auto-import preset of "${name}" (${name}/${PRESET_SUBPATH}). Is the package installed and does it provide a preset?`)
  }
  const preset = (await import(pathToFileURL(entry).href) as { default: AutoImportPreset }).default
  return Array.isArray(preset)
    ? preset
    : [preset]
}
