import { spawn } from 'node:child_process'
import process from 'node:process'
import { defineCommand } from 'citty'
import { resolveRoot } from '../args'
import { binOf } from '../resolve'

export default defineCommand({
  meta: { name: 'test', description: '运行 Vitest（其余参数原样透传）' },
  args: {
    root: { type: 'string', description: '项目根目录', default: '.' },
  },
  async run({ args, rawArgs }) {
    const root = resolveRoot(args.root)
    const bin = binOf(root, 'vitest')

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
