import type { HttpContext, MiddlewareHandler } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BroadcastManager,
  createApplication,
  defineAbilities,
  defineChannels,
  defineCommand,
  defineEvent,
  defineJob,
  defineListener,
  defineModule,
  defineModulesConfig,
  defineNotification,
  defineProvider,
  defineRoutes,
  defineSchedule,
  EventManager,
  Gate,
  groupLocalModules,
  inject,
  NotificationManager,
  QueueManager,
  resolveModules,
  Scheduler,
} from '../src'

const trace: string[] = []
let app: Awaited<ReturnType<typeof createApplication>> | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
  trace.length = 0
})

function mark(name: string): MiddlewareHandler {
  return (_ctx, next) => {
    trace.push(name)
    return next()
  }
}

class Greeter {
  greet(): string {
    return 'module'
  }
}

class AppGreeter extends Greeter {
  override greet(): string {
    return 'app'
  }
}

class GreetController {
  private greeter = inject(Greeter)

  show(ctx: HttpContext) {
    return {
      greeting: this.greeter.greet(),
      perPage: ctx.config.get('blog.perPage', 0),
      title: ctx.config.get('blog.title', ''),
    }
  }
}

const blogRoutes = defineRoutes((r) => {
  r.get('/posts', () => ({ posts: [] })).name('posts.index').middleware('blog.owner')
  r.get('/greet', [GreetController, 'show']).name('greet')
})

const blog = defineModule({
  name: 'blog',
  config: {
    blog: () => ({
      perPage: 20,
      title: 'Blog',
      nested: { a: 1, b: 2 },
    }),
  },
  routes: [blogRoutes],
  middleware: {
    alias: {
      'blog.owner': mark('blog.owner'),
    },
    groups: {
      blog: ['blog.owner'],
    },
    global: [
      mark('blog.global'),
    ],
  },
  providers: [
    defineProvider({
      register(container) {
        trace.push('blog:register')
        container.singleton(Greeter, Greeter)
      },
      boot() {
        trace.push('blog:boot')
      },
    }),
  ],
  options: (options: { perPage?: number }) => options.perPage
    ? {
        config: {
          blog: { perPage: options.perPage },
        },
      }
    : undefined,
})

describe('defineModule', () => {
  it('can be enabled as is or called with options', () => {
    const [plain] = resolveModules({
      explicit: [blog],
    })
    expect(plain).toMatchObject({
      name: 'blog',
      source: 'package',
      prefix: '',
      as: 'blog.',
      middleware: [],
    })
    const [configured] = resolveModules({
      explicit: [
        blog({
          prefix: 'api/blog/',
          as: 'b.',
          middleware: ['auth'],
          perPage: 5,
        }),
      ],
    })
    expect(configured).toMatchObject({
      prefix: '/api/blog',
      as: 'b.',
      middleware: ['auth'],
    })
    // options() 的返回值与定义合并（同名配置深合并）
    expect((configured.definition.config?.blog as () => unknown)()).toEqual({
      perPage: 5,
      title: 'Blog',
      nested: { a: 1, b: 2 },
    })
    expect(() => resolveModules({
      explicit: [
        blog,
        blog({}),
      ],
    })).toThrow('Module "blog" is enabled twice')
    expect(() => resolveModules({
      explicit: [{}],
    })).toThrow('defineModule()')
    expect(() => resolveModules({
      explicit: [
        defineModule({}),
      ],
    })).toThrow('needs a name')
  })

  it('normalizes migration folders', () => {
    const url = new URL('../database/migrations/', 'file:///pkg/dist/index.mjs')
    const [fromUrl, fromPath, none] = resolveModules({
      explicit: [
        defineModule({ name: 'a', migrations: url }),
        defineModule({ name: 'b', migrations: 'node_modules/b/database/migrations/' }),
        defineModule({ name: 'c' }),
      ],
    })
    expect(fromUrl.migrations).toBe('/pkg/database/migrations')
    expect(fromPath.migrations).toBe('node_modules/b/database/migrations')
    expect(none.migrations).toBeUndefined()
  })
})

describe('modules in the application', () => {
  it('merges config defaults under the project config', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        modules: defineModulesConfig({
          modules: [
            blog({ perPage: 30 }),
          ],
        }),
        // 项目配置深合并在模块默认值之上
        blog: {
          nested: { b: 3 },
        },
      },
    })
    expect(app.config.get('blog')).toEqual({
      perPage: 30,
      title: 'Blog',
      nested: { a: 1, b: 3 },
    })
  })

  it('registers module providers before app providers so the app can override bindings', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      modules: [blog],
      providers: [
        defineProvider({
          register(container) {
            trace.push('app:register')
            container.singleton(Greeter, AppGreeter)
          },
        }),
      ],
    })
    expect(trace).toEqual(['blog:register', 'app:register', 'blog:boot'])
    expect(app.make(Greeter).greet()).toBe('app')
    const res = await app.request('/greet')
    expect(((await res.json()) as { data: unknown }).data).toEqual({ greeting: 'app', perPage: 20, title: 'Blog' })
  })

  it('mounts routes with a prefix, a name prefix and extra middleware', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        middleware: {
          alias: {
            audit: mark('audit'),
          },
        },
        modules: {
          modules: [
            blog({
              prefix: '/api/blog',
              middleware: ['audit'],
            }),
          ],
        },
      },
      routes: [
        defineRoutes(r => void r.get('/home', () => 'home').name('home')),
      ],
    })
    trace.length = 0
    const res = await app.request('/api/blog/posts')
    expect(res.status).toBe(200)
    // 全局（模块的全局中间件在项目之后）→ 启用时追加的中间件 → 路由自己的中间件
    expect(trace).toEqual(['blog.global', 'audit', 'blog.owner'])
    expect((await app.request('/posts')).status).toBe(404)
    expect(app.router.url('blog.posts.index')).toBe('/api/blog/posts')
    expect(app.router.list().map(route => [route.path, route.name, route.module])).toEqual([
      ['/home', 'home', undefined],
      ['/api/blog/posts', 'blog.posts.index', 'blog'],
      ['/api/blog/greet', 'blog.greet', 'blog'],
    ])
    expect(app.modules().map(module => module.name)).toEqual(['blog'])
  })

  it('reports route name conflicts with their sources', async () => {
    const other = defineModule({
      name: 'news',
      routes: defineRoutes(r => void r.get('/news', () => 'news').name('posts.index')),
    })
    await expect(createApplication({
      mode: 'test',
      env: false,
      modules: [
        blog,
        other({ as: 'blog.' }),
      ],
    })).rejects.toThrow('Duplicate route name "blog.posts.index" (module "blog" and module "news")')
    await expect(createApplication({
      mode: 'test',
      env: false,
      modules: [
        blog({ as: '' }),
      ],
      routes: [
        defineRoutes(r => void r.get('/x', () => 'x').name('greet')),
      ],
    })).rejects.toThrow('Duplicate route name "greet" (the app and module "blog")')
  })

  it('merges middleware aliases and rejects conflicts unless the app overrides them', async () => {
    const clash = defineModule({
      name: 'clash',
      middleware: {
        alias: {
          'blog.owner': mark('clash'),
        },
      },
    })
    await expect(createApplication({
      mode: 'test',
      env: false,
      modules: [blog, clash],
    }))
      .rejects
      .toThrow('Middleware alias "blog.owner" is defined by both module "blog" and module "clash"')
    const builtin = defineModule({
      name: 'auth2',
      middleware: {
        alias: {
          auth: mark('mine'),
        },
      },
    })
    await expect(createApplication({
      mode: 'test',
      env: false,
      modules: [builtin],
    }))
      .rejects
      .toThrow('Middleware alias "auth" is defined by both the built-in middleware and module "auth2"')

    // 项目的 config/middleware.ts 显式声明同名别名：覆盖模块的定义，不报错
    app = await createApplication({
      mode: 'test',
      env: false,
      modules: [blog, clash],
      config: {
        middleware: {
          alias: {
            'blog.owner': mark('app.owner'),
          },
          groups: { blog: [] },
        },
      },
    })
    trace.length = 0
    await app.request('/posts')
    expect(trace).toEqual(['blog.global', 'app.owner'])
  })

  it('mounts a module into a sub-app', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        app: {
          apps: {
            admin: { prefix: '/admin' },
          },
        },
      },
      modules: [
        blog({ app: 'admin', prefix: '/blog' }),
      ],
    })
    expect((await app.request('/admin/blog/posts')).status).toBe(200)
    expect((await app.request('/blog/posts')).status).toBe(404)
    expect(app.router.url('admin.blog.posts.index')).toBe('/admin/blog/posts')
    expect(app.router.list().find(route => route.name === 'admin.blog.greet')).toMatchObject({ app: 'admin', module: 'blog' })
    await expect(createApplication({
      mode: 'test',
      env: false,
      modules: [
        blog({ app: 'nope' }),
      ],
    }))
      .rejects
      .toThrow('Module "blog" is mounted into app "nope"')
  })

  it('registers jobs, events, listeners, schedules, commands, policies, notifications and channels', async () => {
    const Digest = defineJob({
      handle: () => void trace.push('digest'),
    })
    const Published = defineEvent<{ id: number }>()
    const shop = defineModule({
      name: 'shop',
      jobs: { SendDigest: Digest },
      events: { PostPublished: Published },
      listeners: [
        defineListener(Published, ({ id }) => void trace.push(`published:${id}`), { name: 'LogPublished' }),
      ],
      schedules: [
        defineSchedule(s => s.job(Digest, {}).daily()),
      ],
      commands: [
        defineCommand({
          name: 'shop:sync',
          description: 'sync',
          run: () => 0,
        }),
      ],
      policies: [
        defineAbilities({
          'shop.manage': () => true,
        }),
      ],
      notifications: {
        OrderShipped: defineNotification({
          via: () => [],
        }),
      },
      channels: [
        defineChannels(c => c.private('orders.{id}', () => true)),
      ],
      discovered: {
        sockets: [
          { fake: true },
        ],
      },
    })
    app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        queue: {
          default: 'sync',
          connections: {
            sync: { driver: 'sync' },
          },
        },
      },
      modules: [shop],
      discovered: {
        commands: {
          '/app/command/Inspire.ts': {
            default: defineCommand({
              description: 'inspire',
              run: () => 0,
            }),
          },
        },
      },
    })
    expect([
      ...app.make(QueueManager).jobs().keys(),
    ]).toContain('SendDigest')
    expect(app.make(EventManager).nameOf(Published)).toBe('PostPublished')
    await Published.emit({ id: 1 })
    expect(trace).toEqual(['published:1'])
    expect(app.make(Scheduler).tasks().map(task => task.name)).toEqual(['job:SendDigest'])
    expect(app.make(Gate).has('shop.manage')).toBe(true)
    expect(app.make(NotificationManager).nameOf(app.discovered<any>('notifications')[0][1])).toBe('OrderShipped')
    expect(app.make(BroadcastManager).channels.size).toBe(1)
    expect(app.discovered('sockets')).toHaveLength(1)
    expect((await app.commands()).map(item => [item.name, item.module])).toEqual([
      ['inspire', undefined],
      ['shop:sync', 'shop'],
    ])

    const twice = defineModule({
      name: 'twice',
      commands: {
        inspire: defineCommand({
          run: () => 0,
        }),
      },
    })
    const other = await createApplication({
      mode: 'test',
      env: false,
      modules: [twice],
      discovered: {
        commands: {
          '/app/command/Inspire.ts': {
            default: defineCommand({
              run: () => 0,
            }),
          },
        },
      },
    })
    await expect(other.commands()).rejects.toThrow('Duplicate command "inspire" (module "twice" and Inspire)')
    await other.dispose()
  })
})

/** 模拟 vite 插件生成的 import.meta.glob('/modules/*\/...') */
function localRecord(): Record<string, unknown> {
  return {
    '/modules/blog/module.ts': {
      default: defineModule({
        prefix: '/blog',
        routeMiddleware: ['blog.owner'],
        config: {
          blog: { title: 'Local' },
        },
      }),
    },
    '/modules/blog/route/web.ts': {
      default: defineRoutes(r => void r.get('/', () => 'local blog').name('home')),
    },
    '/modules/blog/config/blog.ts': {
      default: () => ({ perPage: 10, title: 'From file' }),
    },
    '/modules/blog/config/middleware.ts': {
      default: {
        alias: {
          'blog.owner': mark('local.owner'),
        },
      },
    },
    '/modules/blog/app/job/SendDigest.ts': {
      default: defineJob({
        handle: () => {},
      }),
    },
    // 命令按需加载，子目录作为命令分组
    '/modules/blog/app/command/db/Prune.ts': async () => ({
      default: defineCommand({
        run: () => 0,
      }),
    }),
    '/modules/blog/app/event/PostPublished.ts': {
      default: defineEvent(),
    },
    '/modules/shop/route/api.ts': {
      default: defineRoutes(r => void r.get('/shop', () => 'shop').name('index')),
    },
  }
}

describe('local modules', () => {
  it('groups files by module and keeps file-based names', async () => {
    const grouped = groupLocalModules(localRecord())
    expect([
      ...grouped.keys(),
    ]).toEqual(['blog', 'shop'])
    const blogDefinition = grouped.get('blog')!
    expect(blogDefinition.prefix).toBe('/blog')
    // module.ts 的配置与 config/*.ts 的同名项深合并
    expect(Object.keys(blogDefinition.config!)).toEqual(['blog'])

    app = await createApplication({
      mode: 'test',
      env: false,
      localModules: localRecord(),
      config: {
        modules: {
          local: {
            shop: { prefix: '/api', as: 'store.' },
          },
        },
      },
    })
    expect(app.modules().map(module => [
      module.name,
      module.source,
      module.prefix,
      module.migrations,
    ])).toEqual([
      [
        'blog',
        'local',
        '/blog',
        'modules/blog/database/migrations',
      ],
      [
        'shop',
        'local',
        '/api',
        'modules/shop/database/migrations',
      ],
    ])
    const res = await app.request('/blog')
    expect(await res.text()).toContain('local blog')
    expect(trace).toEqual(['local.owner'])
    expect(app.router.url('store.index')).toBe('/api/shop')
    expect([
      ...app.make(QueueManager).jobs().keys(),
    ]).toContain('SendDigest')
    expect((await app.commands()).map(item => item.name)).toEqual(['db:prune'])
    expect(app.config.get('blog')).toEqual({ perPage: 10, title: 'Local' })
  })

  it('can disable local modules and rejects unknown names', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      localModules: localRecord(),
      config: {
        modules: {
          local: { blog: false },
        },
      },
    })
    expect(app.modules().map(module => module.name)).toEqual(['shop'])
    await expect(createApplication({
      mode: 'test',
      env: false,
      localModules: localRecord(),
      config: {
        modules: {
          local: { cms: true },
        },
      },
    })).rejects.toThrow('local module "cms" does not exist')
  })

  it('enables packages before local modules and rejects duplicate names', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      localModules: localRecord(),
      config: {
        modules: {
          modules: [
            defineModule({ name: 'news' }),
          ],
          local: { blog: false },
        },
      },
    })
    expect(app.modules().map(module => module.name)).toEqual(['news', 'shop'])
    await expect(createApplication({
      mode: 'test',
      env: false,
      localModules: localRecord(),
      modules: [blog],
    })).rejects.toThrow('Module "blog" is enabled twice (a package and modules/blog)')
  })
})
