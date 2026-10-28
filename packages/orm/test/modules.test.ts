import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApplication, defineModule } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { databaseProvider, Db, refreshDatabase, runMigrations } from '../src'

let dir: string | undefined
let app: Awaited<ReturnType<typeof createApplication>> | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
  if (dir)
    rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** 写一个 drizzle-kit 形式的迁移目录 */
function writeMigrations(folder: string, tag: string, when: number, statement: string): void {
  mkdirSync(join(folder, 'meta'), { recursive: true })
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
    entries: [
      { tag, when, breakpoints: true },
    ],
  }))
  writeFileSync(join(folder, `${tag}.sql`), statement)
}

async function tables(): Promise<string[]> {
  const rows = await Db.execute(sql.raw(`select name from sqlite_master where type = 'table' order by name`)) as Array<{ name: string }>
  return rows.map(row => row.name)
}

describe('module migrations', () => {
  it('db:migrate (runMigrations) and refreshDatabase include enabled modules, app last', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hazejs-orm-modules-'))
    // 本地模块：相对 srcDir 的 modules/<name>/database/migrations
    writeMigrations(join(dir, 'modules/blog/database/migrations'), '0000_posts', 1900000000000, 'create table blog_posts (id integer primary key)')
    // 模块包：new URL('../database/migrations', import.meta.url)
    writeMigrations(join(dir, 'packages/shop/database/migrations'), '0000_items', 1800000000000, 'create table shop_items (id integer primary key)')
    // 项目自身的迁移（时间戳最早，若与模块共用记录表会被跳过）
    writeMigrations(join(dir, 'database/migrations'), '0000_init', 1700000000000, 'create table notes (id integer primary key)')

    app = await createApplication({
      mode: 'test',
      env: false,
      rootDir: dir,
      srcDir: dir,
      config: {
        database: {
          default: 'main',
          connections: {
            main: { driver: 'sqlite', url: ':memory:' },
          },
        },
        logger: { level: 'silent' },
      },
      providers: [
        databaseProvider(),
      ],
      modules: [
        defineModule({
          name: 'shop',
          migrations: new URL('../database/migrations', pathToFileURL(join(dir, 'packages/shop/dist/index.mjs'))),
        }),
      ],
      localModules: {
        '/modules/blog/config/blog.ts': { default: {} },
      },
    })
    expect(app.modules().map(module => [module.name, module.migrations])).toEqual([
      [
        'shop',
        join(dir, 'packages/shop/database/migrations'),
      ],
      ['blog', 'modules/blog/database/migrations'],
    ])

    const results = await runMigrations()
    expect(results.map(result => [result.module ?? 'app', result.applied])).toEqual([
      ['shop', 1],
      ['blog', 1],
      ['app', 1],
    ])
    expect((await runMigrations()).map(result => result.applied)).toEqual([0, 0, 0])
    expect(await tables()).toEqual(expect.arrayContaining([
      '__drizzle_migrations',
      '__drizzle_migrations_blog',
      '__drizzle_migrations_shop',
      'blog_posts',
      'notes',
      'shop_items',
    ]))

    // refreshDatabase：重建内存库并按同样的顺序执行
    await refreshDatabase({
      migrations: join(dir, 'database/migrations'),
    })
    expect(await tables()).toEqual(expect.arrayContaining(['blog_posts', 'notes', 'shop_items']))
    // modules: false 只执行项目自身的迁移
    await refreshDatabase({
      migrations: join(dir, 'database/migrations'),
      modules: false,
    })
    expect(await tables()).not.toContain('blog_posts')
  })
})
