import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'
import { STUBS_DIR } from '../make/generator'

export default defineCommand({
  meta: { name: 'stub:publish', description: '把内置 stub 复制到项目 stubs/ 目录以便定制 make:* 生成的代码' },
  args: {
    ...rootArg,
    force: { type: 'boolean', description: '覆盖已存在的 stub', default: false },
  },
  async run({ args }) {
    const target = join(resolveRoot(args.root), 'stubs')
    await mkdir(target, { recursive: true })
    let copied = 0
    for (const file of readdirSync(STUBS_DIR)) {
      const destination = join(target, file)
      if (existsSync(destination) && !args.force)
        continue
      await copyFile(join(STUBS_DIR, file), destination)
      copied++
    }
    consola.success(`Published ${copied} stub(s) to ${relative(process.cwd(), target) || '.'}/`)
  },
})
