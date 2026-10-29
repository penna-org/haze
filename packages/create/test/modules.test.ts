import type { createProject as CreateProject } from './utils'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildServer } from '@hazejs/vite'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, run, sqliteRows, startProduction } from './utils'

const projects: Array<ReturnType<typeof CreateProject>> = []
afterEach(() => {
  projects.splice(0).forEach(project => project.cleanup())
})

function create(template: Parameters<typeof CreateProject>[0]): ReturnType<typeof CreateProject> {
  const project = createProject(template)
  projects.push(project)
  return project
}

async function json(url: string, init?: RequestInit): Promise<any> {
  return (await fetch(url, init)).json()
}

describe('module template', () => {
  it('typechecks, passes its own tests against a host app and builds a publishable package', async () => {
    const pkg = create('module')
    expect(JSON.parse(pkg.read('package.json'))).toMatchObject({
      name: 'demo-module',
      hazejs: { module: true },
      files: ['database', 'dist'],
    })
    expect(pkg.read('src/index.ts')).toContain(`name: 'demoModule'`)
    for (const file of pkg.files)
      expect(pkg.read(file), file).not.toMatch(/\{\{\w+\}\}/)

    const tsc = await run(binOf('typescript', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], pkg.root)
    expect(tsc.output).toBe('')
    expect(tsc.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], pkg.root)
    expect(tests.output, tests.output).toContain('3 passed')
    expect(tests.code).toBe(0)

    const build = await run(binOf('tsdown'), [], pkg.root)
    expect(build.code, build.output).toBe(0)
    const bundle = pkg.read('dist/index.mjs')
    // 迁移目录相对产物定位（dist/ 与 src/ 同级），宿主项目的生产构建会把它改写为内嵌迁移的键
    expect(bundle).toContain('new URL("../database/migrations", import.meta.url)')
    // 配置类型的声明扩充随类型声明发布
    expect(pkg.read('dist/index.d.mts')).toMatch(/interface ConfigSchema \{\s+["']?demoModule["']?: PostsConfig/)
  })
})

describe('modules in a project', () => {
  it('runs local and package modules through make, migrations, typegen, tests, build and worker', async () => {
    // 模块包：构建后以 link: 方式安装到 api 项目
    const pkg = create('module')
    expect((await run(binOf('tsdown'), [], pkg.root)).code).toBe(0)

    const project = create('api')
    mkdirSync(join(project.root, 'node_modules'), { recursive: true })
    symlinkSync(pkg.root, join(project.root, 'node_modules/demo-module'), 'dir')
    const manifest = JSON.parse(project.read('package.json'))
    manifest.dependencies['demo-module'] = `link:${pkg.root}`
    project.write('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    project.write('config/modules.ts', `import { defineModulesConfig } from '@hazejs/core'
import demoModule from 'demo-module'

export default defineModulesConfig({
  modules: [demoModule({ perPage: 5 })],
})
`)

    const cli = binOf('@hazejs/cli', 'haze')
    const haze = (...args: string[]) => run(cli, [...args, '--root', project.root], project.root, {})

    // 本地模块：骨架 → 模型 → 迁移 → 命令 → 定时任务
    const scaffolded = await haze('make:module', 'blog')
    expect(scaffolded.code, scaffolded.output).toBe(0)
    expect(scaffolded.output).toContain('modules/blog/module.ts')
    const model = await haze('make:model', 'Article', '--module', 'blog')
    expect(model.output, model.output).toContain('modules/blog/database/schema/articles.ts')
    const generate = await haze('db:generate', '--module', 'blog', '--name', 'create_articles')
    expect(generate.code, generate.output).toBe(0)
    expect(existsSync(join(project.root, 'modules/blog/database/migrations/0000_create_articles.sql'))).toBe(true)
    // 项目自身的迁移目录不受影响
    expect(existsSync(join(project.root, 'database/migrations/0004_create_articles.sql'))).toBe(false)
    expect((await haze('make:command', 'Report', '--module', 'blog')).code).toBe(0)
    project.write('modules/blog/schedule/blog.ts', `import { defineSchedule } from '@hazejs/core'

export default defineSchedule((s) => {
  s.call('blog:tick', () => console.log('blog tick')).everyMinute()
})
`)

    // 迁移：模块按启用顺序（包 → 本地模块），项目最后；再次执行不重复
    const migrate = await haze('db:migrate')
    expect(migrate.code, migrate.output).toBe(0)
    expect(migrate.output).toMatch(/module demoModule: migrated: 1 of 1[\s\S]*module blog: migrated: 1 of 1[\s\S]*\[main\] migrated: 4 of 4/)
    expect((await haze('db:migrate')).output).toMatch(/module demoModule: migrated: 0 of 1[\s\S]*module blog: migrated: 0 of 1[\s\S]*\[main\] migrated: 0 of 4/)
    expect(await sqliteRows(join(project.root, 'data/app.db'), `select name from sqlite_master where name like '%articles' or name like 'demo_module%' or name like '__drizzle%' order by name`)).toEqual([
      { name: '__drizzle_migrations' },
      { name: '__drizzle_migrations_blog' },
      { name: '__drizzle_migrations_demo_module' },
      { name: 'articles' },
      { name: 'demo_module_posts' },
    ])

    const list = await haze('module:list')
    expect(list.code, list.output).toBe(0)
    expect(list.output).toMatch(/demoModule\s+package\s+\/api\/demo-module\s+demoModule\.\*\s+2/)
    expect(list.output).toMatch(/blog\s+local\s+\/api\/blog\s+blog\.\*\s+1\s+modules\/blog\/database\/migrations/)
    const routes = await haze('route:list')
    expect(routes.output).toMatch(/MODULE[\s\S]*blog\s+GET\s+\/api\/blog\s+blog\.index/)
    // 模块的命令出现在命令列表中
    expect((await haze('report')).code).toBe(0)

    // 类型：模块的路由名、本地模块的配置文件与模块包的配置扩充
    const typegen = await haze('typegen')
    expect(typegen.code, typegen.output).toBe(0)
    const types = project.read('.haze/types/haze.d.ts')
    expect(types).toContain('"blog.index": Record<never, never>')
    expect(types).toContain('"demoModule.posts.index": Record<never, never>')
    expect(types).toContain('"blog": ConfigValue<typeof import("../../modules/blog/config/blog").default>')
    writeFileSync(join(project.root, 'probe.ts'), `
import { config, Router } from '@hazejs/core'
declare const router: Router
const perPage: number = config('demoModule.perPage')
const blogPerPage: number = config('blog.perPage')
router.url('blog.index')
router.url('demoModule.posts.store')
// @ts-expect-error 未知的模块路由名
router.url('blog.nope')
export { blogPerPage, perPage }
`)
    const tsc = await run(binOf('typescript', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], project.root)
    expect(tsc.output).toBe('')

    // 模板测试 + 本地模块骨架自带的测试（refreshDatabase 同时执行模块迁移）
    const tests = await run(binOf('vitest'), ['run'], project.root)
    // greeting 3 + users 4 + auth 5 + chat 3 + account 4 + home 1 + modules/blog 1
    expect(tests.output, tests.output).toContain('21 passed')

    // 生产构建：模块迁移打包进产物，migrate.mjs 在全新的数据库上按同样顺序执行
    const build = await buildServer({ root: project.root })
    expect(build.migrate).toBeDefined()
    rmSync(join(project.root, 'data'), { recursive: true, force: true })
    const first = await run(build.migrate!, [], project.root, { NODE_ENV: 'production' })
    expect(first.code, first.output).toBe(0)
    expect(await sqliteRows(join(project.root, 'data/app.db'), `select (select count(*) from __drizzle_migrations_demo_module) as pkg, (select count(*) from __drizzle_migrations_blog) as local, (select count(*) from __drizzle_migrations) as app`)).toEqual([
      { pkg: 1, local: 1, app: 4 },
    ])
    const second = await run(build.migrate!, [], project.root, { NODE_ENV: 'production' })
    expect(second.output).toContain('0 of 1 migrations applied (node_modules/demo-module/database/migrations)')

    const server = await startProduction(build.entry, project.root)
    try {
      const created = await json(`${server.url}/api/demo-module/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'From production' }),
      })
      expect(created.data).toMatchObject({ title: 'From production' })
      expect((await json(`${server.url}/api/demo-module/posts`)).data).toHaveLength(1)
      expect((await json(`${server.url}/api/blog`)).data).toEqual({ module: 'blog', perPage: 20 })
    }
    finally {
      await server.stop()
    }

    // worker.mjs：模块的命令与定时任务
    const worker = join(build.layout.serverDir, 'worker.mjs')
    const commands = await run(worker, ['command'], project.root, { NODE_ENV: 'production' })
    expect(commands.output).toMatch(/report/)
    const tick = await run(worker, ['schedule:run'], project.root, { NODE_ENV: 'production' })
    expect(tick.output, tick.output).toContain('blog tick')
    expect(readFileSync(join(build.layout.serverDir, 'index.mjs'), 'utf8')).toBeTruthy()
  })
})
