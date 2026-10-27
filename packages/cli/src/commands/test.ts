import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { resolveRoot } from '../args'

export default defineCommand({
  meta: { name: 'test', description: '运行 Vitest（其余参数原样透传）' },
  args: {
    root: { type: 'string', description: '项目根目录', default: '.' },
  },
  async run({ args, rawArgs }) {
    const root = resolveRoot(args.root)
    let bin: string
    try {
      const pkgPath = createRequire(join(root, 'package.json')).resolve('vitest/package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> }
      bin = join(dirname(pkgPath), pkg.bin.vitest)
    }
    catch {
      throw new Error('vitest is not installed. Run `pnpm add -D vitest` first.')
    }

    const passthrough = stripRootArg(rawArgs)
    const vitestArgs = passthrough.length
      ? passthrough
      : ['run']
    const child = spawn(process.execPath, [bin, ...vitestArgs], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    })
    const code = await new Promise<number>(resolve => child.on('close', code => resolve(code ?? 1)))
    process.exitCode = code
  },
})

function stripRootArg(rawArgs: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--root')
      i++
    else if (!rawArgs[i].startsWith('--root='))
      result.push(rawArgs[i])
  }
  return result
}
