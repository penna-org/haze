import type { DevServer, ReloadResult } from '../src'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
let counter = 0

/** 复制 fixture 到 test/.tmp 下（仍可沿目录向上解析到 @hazejs/core） */
export function copyFixture(name: string): { root: string, write: (file: string, content: string) => void, edit: (file: string, from: string, to: string) => void, cleanup: () => void } {
  const root = join(testDir, '.tmp', `${name}-${process.pid}-${++counter}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(dirname(root), { recursive: true })
  cpSync(join(testDir, 'fixtures', name), root, { recursive: true })

  return {
    root,
    write(file, content) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), content)
    },
    edit(file, from, to) {
      const path = join(root, file)
      const source = readFileSync(path, 'utf8')
      if (!source.includes(from))
        throw new Error(`"${from}" not found in ${file}`)
      writeFileSync(path, source.replace(from, to))
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export function nextReload(dev: DevServer, timeout = 10_000): Promise<ReloadResult> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = dev.onReload((result) => {
      clearTimeout(timer)
      off()
      resolve(result)
    })
    timer = setTimeout(() => {
      off()
      reject(new Error('Timed out waiting for reload'))
    }, timeout)
  })
}

export async function getJson(dev: DevServer, path: string): Promise<{ status: number, body: any, headers: Headers }> {
  const res = await fetch(new URL(path, dev.url))
  return { status: res.status, body: await res.json(), headers: res.headers }
}

/** 等待文件监听器完成初始扫描，避免启动后立即修改的文件被漏掉 */
export function settle(ms = 150): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
