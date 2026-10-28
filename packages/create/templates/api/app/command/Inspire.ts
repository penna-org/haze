import process from 'node:process'
import { defineCommand } from '@hazejs/core'

const quotes = [
  '千里之行，始于足下。——老子',
  '学而不思则罔，思而不学则殆。——孔子',
  'Well begun is half done. — Aristotle',
  'Simplicity is the ultimate sophistication. — Leonardo da Vinci',
  'Knowledge is power. — Francis Bacon',
]

/**
 * 示例命令（app/command 下自动发现，文件名即命令名）：npx haze inspire [--all]
 * 生产环境：node dist/worker.mjs command inspire；生成新命令：npx haze make:command SendReport
 */
export default defineCommand({
  description: '打印一句名言',
  args: {
    all: { type: 'boolean', alias: 'a', description: '打印全部名言' },
  },
  run(args) {
    const lines = args.all
      ? quotes
      : [quotes[Math.floor(Math.random() * quotes.length)]]
    for (const line of lines)
      process.stdout.write(`${line}\n`)
  },
})
