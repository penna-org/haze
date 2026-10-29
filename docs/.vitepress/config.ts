import type { DefaultTheme } from 'vitepress'
import { defineConfig } from 'vitepress'

const repo = 'https://github.com/penna-org/haze'

type Title = [en: string, zh: string]

/** 指南的页面结构：英文与中文共用，保证两种语言的页面一一对应 */
const guide: Array<{ text: Title, items: Array<[slug: string, title: Title]> }> = [
  {
    text: ['Introduction', '介绍'],
    items: [
      ['', ['What is hazejs?', '什么是 hazejs']],
      ['getting-started', ['Getting Started', '快速开始']],
      ['directory-structure', ['Directory Structure', '目录结构']],
      ['configuration', ['Configuration', '配置']],
    ],
  },
  {
    text: ['The Basics', '基础'],
    items: [
      ['routing', ['Routing', '路由']],
      ['controllers', ['Controllers', '控制器']],
      ['container', ['Service Container', '服务容器']],
      ['middleware', ['Middleware', '中间件']],
      ['requests', ['Requests & Validation', '请求与校验']],
      ['responses', ['Responses', '响应']],
      ['resources', ['API Resources', 'API 资源']],
      ['errors', ['Errors & Logging', '异常与日志']],
      ['observability', ['Observability', '可观测性']],
      ['openapi', ['OpenAPI', 'OpenAPI 文档']],
    ],
  },
  {
    text: ['Database', '数据库'],
    items: [
      ['database', ['Getting Started', '快速开始']],
      ['query-builder', ['Query Builder', '查询构造器']],
      ['transactions', ['Transactions', '事务']],
      ['models', ['Models', '模型']],
      ['relations', ['Relations', '模型关联']],
      ['search', ['Search', '全文搜索']],
    ],
  },
  {
    text: ['Security', '安全'],
    items: [
      ['authentication', ['Authentication', '认证']],
      ['api-tokens', ['API Tokens', 'API 令牌']],
      ['two-factor', ['Two-Factor & Passkeys', '两步验证与通行密钥']],
      ['oauth', ['OAuth Social Login', '第三方登录']],
      ['authorization', ['Authorization', '授权']],
      ['security', ['Sessions, CSRF & More', 'Session、CSRF 等']],
    ],
  },
  {
    text: ['Digging Deeper', '进阶'],
    items: [
      ['cache', ['Cache', '缓存']],
      ['redis', ['Redis', 'Redis']],
      ['queues', ['Queues', '队列']],
      ['scheduling', ['Task Scheduling', '定时任务']],
      ['events', ['Events', '事件']],
      ['notifications', ['Notifications', '通知']],
      ['broadcasting', ['Broadcasting', '广播']],
      ['websocket', ['WebSocket', 'WebSocket']],
      ['socket-io', ['Socket.IO', 'Socket.IO']],
      ['storage', ['File Storage', '文件存储']],
      ['mail', ['Mail', '邮件']],
      ['localization', ['Localization', '多语言']],
      ['ai', ['AI', 'AI']],
      ['graphql', ['GraphQL', 'GraphQL']],
      ['microservices', ['Microservices', '微服务']],
    ],
  },
  {
    text: ['Full-stack & Deployment', '全栈与部署'],
    items: [
      ['fullstack', ['Full-stack with Vite', 'Vite 全栈']],
      ['multi-app', ['Multiple Apps', '多应用']],
      ['modules', ['Modules', '模块']],
      ['tenancy', ['Multi-tenancy', '多租户']],
      ['testing', ['Testing', '测试']],
      ['deployment', ['Deployment', '部署']],
      ['console', ['Console Commands', '自定义命令']],
      ['cli', ['CLI Reference', '命令行参考']],
    ],
  },
]

function sidebar(lang: 0 | 1, prefix: string): DefaultTheme.SidebarItem[] {
  return guide.map(group => ({
    text: group.text[lang],
    collapsed: false,
    items: group.items.map(([slug, title]) => ({ text: title[lang], link: `${prefix}/guide/${slug}` })),
  }))
}

export default defineConfig({
  title: 'hazejs',
  description: 'A batteries-included TypeScript backend framework for Node.js, Bun, Deno and the edge',
  base: '/haze/',
  cleanUrls: true,
  lastUpdated: true,
  // 内部设计记录只在仓库中阅读
  srcExclude: ['design.md'],
  // 文档中的本地地址（如 Mailpit 的 http://localhost:8025）不做死链检查
  ignoreDeadLinks: 'localhostLinks',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/haze/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#6d5dfc' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [{ icon: 'github', link: repo }],
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                noResultsText: '没有找到结果',
                resetButtonTitle: '清除',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Changelog', link: `${repo}/releases` },
        ],
        sidebar: { '/guide/': sidebar(0, '') },
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
        footer: { message: 'Released under the MIT License.', copyright: 'Copyright © 2026-present hazejs contributors' },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description: '开箱即用的 TypeScript 后端框架，运行在 Node.js、Bun、Deno 与 Edge 上',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started', activeMatch: '/zh/guide/' },
          { text: '路线图', link: '/zh/roadmap' },
          { text: '更新日志', link: `${repo}/releases` },
        ],
        sidebar: { '/zh/guide/': sidebar(1, '/zh') },
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: '在 GitHub 上编辑此页' },
        footer: { message: '基于 MIT 许可证发布', copyright: 'Copyright © 2026-present hazejs contributors' },
        outline: { label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '外观',
        langMenuLabel: '语言',
      },
    },
  },
})
