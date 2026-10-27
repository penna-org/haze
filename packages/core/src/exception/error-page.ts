import type { RouteInfo } from '../routing/router'
import type { ValidationIssue } from './exceptions'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { FRAMEWORK_NAME } from '../constants'

export interface ErrorPageInput {
  error: unknown
  status: number
  message: string
  code?: number | string
  request?: Request
  requestId?: string
  params?: Record<string, string>
  issues?: ValidationIssue[]
  /** 404 时列出可用路由 */
  routes?: readonly RouteInfo[]
  /** 显示相对路径的基准目录，默认 process.cwd() */
  rootDir?: string
}

export interface StackFrame {
  fn: string
  file: string
  line: number
  column: number
  /** node_modules、node 内置、框架内部 */
  internal: boolean
}

const FRAME_RE = /^\s*at (?:(.+?) \()?((?:file:\/\/)?(?:\/|[A-Z]:\\)[^():]*):(\d+):(\d+)\)?$/i
const CONTEXT_LINES = 5

const STYLES = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#6b7280;--border:#e5e7eb;--accent:#e5484d;--warn:#d97706;--hl:#fff1f0;--code:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d21;--text:#e6e8eb;--muted:#9aa0a6;--border:#2b3036;--hl:#3a1f22;--code:#22262b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 16px 48px}
header{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px}
.badge{flex:none;font:600 15px/1 ui-monospace,monospace;padding:10px 12px;border-radius:8px;color:#fff;background:var(--warn)}
.badge.server{background:var(--accent)}
.name{margin:0;color:var(--muted);font-size:13px}
h1{margin:4px 0 0;font-size:22px;line-height:1.35;word-break:break-word}
h2{font-size:14px;margin:0 0 10px;display:inline-block}h3{font-size:13px;margin:16px 0 8px;color:var(--muted)}
section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-top:14px;overflow:hidden}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}summary h2::after{content:" ▾";color:var(--muted)}
pre,code{font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
code{background:var(--code);padding:1px 5px;border-radius:4px;word-break:break-all}
.code{width:100%;border-collapse:collapse;overflow-x:auto;display:block}
.code td{padding:0 10px;vertical-align:top}.code .ln{color:var(--muted);text-align:right;user-select:none;width:1%}
.code tr.current{background:var(--hl)}.caret{color:var(--accent);font-weight:700}
.stack{margin:0;padding-left:20px}.stack li{padding:3px 0;word-break:break-all}
.stack li.internal{color:var(--muted)}.stack li.app .fn{font-weight:600}.loc{color:var(--muted);font-family:ui-monospace,monospace;font-size:12px}
.grid{width:100%;border-collapse:collapse}.grid th,.grid td{text-align:left;padding:6px 8px;border-top:1px solid var(--border);vertical-align:top}
.grid th{color:var(--muted);font-weight:500;border-top:0}.kv td:first-child{width:180px;color:var(--muted)}
.muted{color:var(--muted)}footer{margin-top:24px;color:var(--muted);font-size:12px;text-align:center}
`

/** 开发错误页（仅在 app.debug 开启时使用，包含源码与请求信息） */
export function renderErrorPage(input: ErrorPageInput): string {
  const error = input.error instanceof Error
    ? input.error
    : undefined
  // 框架异常的 name 固定为 HTTPError（h3 依赖它识别），展示真实类名更直观
  const className = error?.constructor?.name
  const name = className && className !== 'Error' && className !== 'HTTPError'
    ? className
    : error?.name && error.name !== 'Error' && error.name !== 'HTTPError'
      ? error.name
      : `HTTP ${input.status}`
  const rootDir = input.rootDir ?? process.cwd()
  const frames = parseStack(error?.stack)
  const focus = frames.find(frame => !frame.internal)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(`${input.status} ${input.message}`)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <header>
    <div class="badge ${input.status >= 500
      ? 'server'
      : 'client'}">${input.status}</div>
    <div>
      <p class="name">${escape(name)}${input.code !== undefined && input.code !== input.status
        ? ` · code ${escape(String(input.code))}`
        : ''}</p>
      <h1>${escape(input.message)}</h1>
    </div>
  </header>
  ${focus
    ? codeFrame(focus, rootDir)
    : ''}
  ${input.issues?.length
    ? issuesTable(input.issues)
    : ''}
  ${showStack(frames, input.status)
    ? stackList(frames, rootDir, input.status)
    : ''}
  ${input.routes
    ? routesTable(input.routes)
    : ''}
  ${input.request
    ? requestInfo(input)
    : ''}
  <footer>${FRAMEWORK_NAME} · 此页面仅在 <code>app.debug</code> 开启时显示</footer>
</main>
</body>
</html>`
}

export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack)
    return []
  return stack.split('\n').flatMap((line) => {
    const match = FRAME_RE.exec(line)
    if (!match)
      return []
    const file = match[2].startsWith('file://')
      ? fileURLToPath(match[2])
      : match[2]
    return [
      {
        fn: match[1] ?? '<anonymous>',
        file,
        line: Number(match[3]),
        column: Number(match[4]),
        internal: /[/\\]node_modules[/\\]|[/\\]packages[/\\](?:core|vite)[/\\](?:dist|src)[/\\]/.test(file),
      },
    ]
  })
}

function codeFrame(frame: StackFrame, rootDir: string): string {
  let source: string
  try {
    source = readFileSync(frame.file, 'utf8')
  }
  catch {
    return ''
  }
  const lines = source.split('\n')
  const start = Math.max(0, frame.line - 1 - CONTEXT_LINES)
  const end = Math.min(lines.length, frame.line + CONTEXT_LINES)
  const rows = lines.slice(start, end).map((text, index) => {
    const number = start + index + 1
    const current = number === frame.line
    return `<tr class="${current ? 'current' : ''}"><td class="ln">${number}</td><td><pre>${escape(text) || ' '}</pre>${current
      ? `<pre class="caret">${' '.repeat(Math.max(0, frame.column - 1))}^</pre>`
      : ''}</td></tr>`
  }).join('')
  return `<section>
    <h2>${escape(displayPath(frame.file, rootDir))}:${frame.line}:${frame.column}</h2>
    <table class="code">${rows}</table>
  </section>`
}

/** 4xx 且只有框架内部调用时，调用栈没有排查价值 */
function showStack(frames: StackFrame[], status: number): boolean {
  return frames.length > 0 && (status >= 500 || frames.some(frame => !frame.internal))
}

function stackList(frames: StackFrame[], rootDir: string, status: number): string {
  const items = frames.map(frame =>
    `<li class="${frame.internal ? 'internal' : 'app'}"><span class="fn">${escape(frame.fn)}</span> <span class="loc">${escape(displayPath(frame.file, rootDir))}:${frame.line}:${frame.column}</span></li>`).join('')
  // 有业务代码帧时上方已展示源码，调用栈默认折叠；否则（5xx 来自框架内部）默认展开
  const open = status >= 500 && !frames.some(frame => !frame.internal)
  return `<section><details ${open ? 'open' : ''}><summary><h2>调用栈</h2></summary><ol class="stack">${items}</ol></details></section>`
}

function issuesTable(issues: ValidationIssue[]): string {
  const rows = issues.map(issue =>
    `<tr><td>${escape(issue.target ?? '')}</td><td><code>${escape(issue.path || '(root)')}</code></td><td>${escape(issue.message)}</td></tr>`).join('')
  return `<section><h2>校验错误</h2><table class="grid"><thead><tr><th>位置</th><th>字段</th><th>信息</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

function routesTable(routes: readonly RouteInfo[]): string {
  if (!routes.length)
    return '<section><h2>可用路由</h2><p class="muted">尚未定义任何路由，在 route/*.ts 中使用 defineRoutes() 添加。</p></section>'
  const rows = routes.map(route =>
    `<tr><td><b>${escape(route.method)}</b></td><td><code>${escape(route.path)}</code></td><td>${escape(route.name ?? '')}</td><td>${escape(route.handler)}</td></tr>`).join('')
  return `<section><h2>可用路由</h2><table class="grid"><thead><tr><th>方法</th><th>路径</th><th>名称</th><th>处理器</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

function requestInfo(input: ErrorPageInput): string {
  const request = input.request!
  const url = new URL(request.url)
  const pairs = (entries: Iterable<[string, string]>): string =>
    [...entries].map(([key, value]) => `<tr><td>${escape(key)}</td><td><code>${escape(redact(key, value))}</code></td></tr>`).join('')
  const params = Object.entries(input.params ?? {})
  return `<section>
    <h2>请求</h2>
    <table class="grid kv">
      <tr><td>URL</td><td><code>${escape(`${request.method} ${url.pathname}${url.search}`)}</code></td></tr>
      ${input.requestId
        ? `<tr><td>Request ID</td><td><code>${escape(input.requestId)}</code></td></tr>`
        : ''}
      ${params.length
        ? pairs(params)
        : ''}
    </table>
    ${url.searchParams.size
      ? `<h3>Query</h3><table class="grid kv">${pairs(url.searchParams)}</table>`
      : ''}
    <h3>Headers</h3><table class="grid kv">${pairs(request.headers)}</table>
  </section>`
}

const SENSITIVE_HEADER = /^(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i

function redact(key: string, value: string): string {
  return SENSITIVE_HEADER.test(key)
    ? `${value.slice(0, 6)}…（已隐藏）`
    : value
}

function displayPath(file: string, rootDir: string): string {
  const rel = relative(rootDir, file)
  return rel.startsWith('..')
    ? file
    : rel
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}
