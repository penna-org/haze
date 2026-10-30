import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { createDevServer } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { importFromApp } from '../app-import'
import { resolveRoot, rootArg } from '../args'

type GenerateOpenAPI = (app: unknown) => Promise<{ paths: Record<string, unknown> }>

export default defineCommand({
  meta: { name: 'openapi', description: '生成 OpenAPI 3.1 文档（默认输出到标准输出）' },
  args: {
    ...rootArg,
    output: { type: 'string', alias: 'o', description: '写入文件，例如 openapi.json' },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const server = await createDevServer({ root, listen: false })
    try {
      if (!server.app)
        throw new Error('Application failed to start')
      // 从应用的模块图加载 @hazejs/core，与应用使用同一份实例
      const { generateOpenAPI } = await importFromApp<{ generateOpenAPI?: GenerateOpenAPI }>(server, root, '@hazejs/core')
      if (typeof generateOpenAPI !== 'function')
        throw new TypeError('The installed @hazejs/core does not support OpenAPI generation; please upgrade it')
      const document = await generateOpenAPI(server.app)
      const json = `${JSON.stringify(document, null, 2)}\n`
      if (!args.output) {
        process.stdout.write(json)
        return
      }
      const file = resolve(process.cwd(), args.output)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, json)
      consola.success(`OpenAPI document written to ${relative(process.cwd(), file)} (${Object.keys(document.paths).length} path(s))`)
    }
    finally {
      await server.close()
    }
  },
})
