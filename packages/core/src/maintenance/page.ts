import type { ViewNode } from '../view/jsx'
import { jsx, jsxs } from '../view/jsx'

export interface MaintenancePageProps {
  status: number
  title: string
  message: string
  lang?: string
  /** Retry-After 秒数（页面上显示大约的恢复时间） */
  retry?: number
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#64748b;--accent:#2563eb;--border:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--text:#e5e7eb;--muted:#94a3b8;--accent:#60a5fa;--border:#1f2937}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}
main{max-width:480px;width:100%;padding:40px 32px;background:var(--card);border:1px solid var(--border);border-radius:16px;text-align:center}
.status{display:inline-block;margin-bottom:16px;padding:2px 10px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-size:13px;font-weight:600;letter-spacing:.04em}
h1{margin:0 0 12px;font-size:24px;line-height:1.3}
p{margin:0;color:var(--muted);line-height:1.6}
.retry{margin-top:20px;font-size:13px}
`

/** 内置的维护页（用 JSX 运行时渲染，内联样式，不依赖外部资源） */
export function maintenancePage(props: MaintenancePageProps): ViewNode {
  return jsxs('html', {
    lang: props.lang ?? 'en',
    children: [
      jsxs('head', {
        children: [
          jsx('meta', { charset: 'utf-8' }),
          jsx('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
          jsx('meta', { name: 'robots', content: 'noindex' }),
          jsx('title', { children: props.title }),
          jsx('style', {
            dangerouslySetInnerHTML: { __html: STYLE },
          }),
        ],
      }),
      jsx('body', {
        children: jsxs('main', {
          children: [
            jsx('span', { class: 'status', children: props.status }),
            jsx('h1', { children: props.title }),
            jsx('p', { children: props.message }),
            props.retry
              ? jsx('p', { 'class': 'retry', 'data-retry': props.retry, 'children': `Retry-After: ${props.retry}s` })
              : null,
          ],
        }),
      }),
    ],
  })
}
