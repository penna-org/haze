import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'

/** 256 位随机密钥（base64url），与 @think-h3/core 的 generateKey() 相同 */
export function generateAppKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}

export default defineCommand({
  meta: { name: 'key:generate', description: '生成 APP_KEY（签名 Cookie、加密 Session、JWT 默认密钥）并写入 .env' },
  args: {
    ...rootArg,
    show: { type: 'boolean', description: '只输出，不写入文件', default: false },
    force: { type: 'boolean', description: '覆盖已有的 APP_KEY（已签发的 Cookie / Session / 令牌会失效）', default: false },
  },
  run({ args }) {
    const key = generateAppKey()
    if (args.show) {
      console.log(key)
      return
    }
    const root = resolveRoot(args.root)
    const file = join(root, '.env')
    const source = existsSync(file)
      ? readFileSync(file, 'utf8')
      : ''
    const line = /^APP_KEY=(.*)$/m.exec(source)
    if (line?.[1] && !args.force) {
      consola.warn(`APP_KEY already exists in ${relative(process.cwd(), file) || '.env'}; use --force to replace it`)
      process.exitCode = 1
      return
    }
    const next = line
      ? source.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
      : `${source}${source && !source.endsWith('\n')
        ? '\n'
        : ''}APP_KEY=${key}\n`
    writeFileSync(file, next)
    consola.success(`APP_KEY written to ${relative(process.cwd(), file) || '.env'}`)
  },
})
