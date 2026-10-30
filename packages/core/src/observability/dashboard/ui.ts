import { FRAMEWORK_NAME } from '../../constants'

export interface DashboardPageOptions {
  /** 页面所在路径（如 /__haze） */
  base: string
  /** 记录的 JSON API 前缀（如 /__haze/api），仅队列模式时为 undefined */
  api?: string
  /** 队列 API 前缀 */
  queuesApi: string
  /** full：完整面板；queues：仅队列（生产环境挂载） */
  mode: 'full' | 'queues'
  /** 打开页面时显示的视图（hash 路由，如 `#/requests/<id>`） */
  initial?: string
}

/** 嵌入 <script> 的 JSON：转义 `<`，避免 `</script>` 提前结束脚本 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const STYLES = `
:root{--bg:#f7f8fa;--panel:#fff;--text:#1c2024;--muted:#6b7280;--border:#e6e8eb;--hover:#f2f4f7;--accent:#5b5bd6;--accent-soft:#eef0ff;--ok:#16a34a;--warn:#d97706;--err:#e5484d;--code:#f3f4f6;--shadow:0 1px 2px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#16191e;--text:#e6e8eb;--muted:#9aa0a6;--border:#262b31;--hover:#1d2127;--accent:#8b8dfc;--accent-soft:#23254a;--code:#1d2127;--shadow:none}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--panel)}
header .brand{font-weight:700;font-size:14px;letter-spacing:.2px}header .brand span{color:var(--accent)}
header .spacer{flex:1}
.live{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.live i{width:8px;height:8px;border-radius:50%;background:var(--muted)}.live.on i{background:var(--ok);box-shadow:0 0 0 3px rgba(22,163,74,.18)}
input[type=search]{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 9px;min-width:220px;font:inherit}
button{font:inherit;border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:6px;padding:4px 10px;cursor:pointer}button:hover{background:var(--hover)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--err)}button:disabled{opacity:.5;cursor:default}
.layout{flex:1;display:flex;min-height:0}
nav{width:184px;flex:none;border-right:1px solid var(--border);padding:10px 8px;overflow:auto;background:var(--panel)}
nav a{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-radius:6px;color:var(--text)}nav a:hover{background:var(--hover);text-decoration:none}
nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:600}nav a small{color:var(--muted);font-variant-numeric:tabular-nums}
main{flex:1;overflow:auto;padding:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);margin-bottom:14px;overflow:hidden}
.card h3{margin:0;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;display:flex;gap:8px;align-items:center}
.card h3 .count{color:var(--muted);font-weight:400}.card .body{padding:12px 14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;background:var(--panel);position:sticky;top:0}
tbody tr:last-child td{border-bottom:0}tr.row{cursor:pointer}tr.row:hover td{background:var(--hover)}tr.fresh td{animation:fresh 1.2s ease-out}
@keyframes fresh{from{background:var(--accent-soft)}}
code,pre,.mono{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{margin:0;padding:10px 12px;background:var(--code);border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.sql{max-width:640px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;background:var(--code);color:var(--muted);white-space:nowrap}
.b-ok{background:rgba(22,163,74,.12);color:var(--ok)}.b-warn{background:rgba(217,119,6,.14);color:var(--warn)}.b-err{background:rgba(229,72,77,.14);color:var(--err)}.b-info{background:var(--accent-soft);color:var(--accent)}
.method{font-weight:700;font-size:11px}.muted{color:var(--muted)}.num{font-variant-numeric:tabular-nums;white-space:nowrap}.right{text-align:right}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px}.stat b{display:block;font-size:16px}.stat span{color:var(--muted);font-size:12px}
.kv td:first-child{width:220px;color:var(--muted)}
.empty{padding:28px;text-align:center;color:var(--muted)}
.title{display:flex;align-items:center;gap:10px;margin:0 0 14px}.title h2{margin:0;font-size:16px}
iframe.preview{width:100%;height:520px;border:0;background:#fff;border-radius:6px}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
@media (max-width:760px){nav{display:none}input[type=search]{min-width:0;width:140px}}
`

/** 面板前端：原生 JS，hash 路由，SSE 实时更新 */
const SCRIPT = String.raw`
const C = window.__HAZE__
const $ = (sel, root = document) => root.querySelector(sel)
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';')
const TABS = C.mode === 'queues'
  ? [['queues', 'Queues']]
  : [['requests', 'Requests'], ['query', 'Queries'], ['job', 'Jobs'], ['mail', 'Mail'], ['event', 'Events'], ['cache', 'Cache'], ['log', 'Logs'], ['exception', 'Exceptions'], ['ai', 'AI'], ['http', 'HTTP Client'], ['schedule', 'Schedule'], ['queues', 'Queues']]
const TYPE_OF_TAB = { requests: 'request' }
let counts = {}
let filter = ''
let fresh = new Set()
let renderQueued = false

async function api(path, init) {
  const headers = { 'x-haze-dashboard': '1', ...(init && init.headers) }
  const xsrf = document.cookie.split('; ').find(item => item.startsWith('XSRF-TOKEN='))
  if (xsrf) headers['x-xsrf-token'] = decodeURIComponent(xsrf.slice(11))
  const response = await fetch(path, { ...init, headers })
  if (!response.ok) throw new Error((await response.text()) || response.statusText)
  return response.json()
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '')
  const [first, ...rest] = hash.split('/')
  const tab = TABS.some(([key]) => key === first) ? first : TABS[0][0]
  return { tab, id: rest.length && rest.join('/') ? decodeURIComponent(rest.join('/')) : undefined }
}

function time(ms) {
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
function duration(ms) {
  if (ms === undefined || ms === null) return ''
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : (Math.round(ms * 100) / 100) + ' ms'
}
function statusBadge(status) {
  const cls = status >= 500 ? 'b-err' : status >= 400 ? 'b-warn' : status >= 300 ? 'b-info' : 'b-ok'
  return '<span class="badge ' + cls + '">' + esc(status) + '</span>'
}
function jobBadge(status) {
  const cls = { ok: 'b-ok', failed: 'b-err', retry: 'b-warn', released: 'b-warn', dispatched: 'b-info' }[status] || ''
  return '<span class="badge ' + cls + '">' + esc(status) + '</span>'
}
function levelBadge(level) {
  const cls = { error: 'b-err', warn: 'b-warn', info: 'b-info' }[level] || ''
  return '<span class="badge ' + cls + '">' + esc(level) + '</span>'
}
function reqLink(entry) {
  return entry.requestId ? '<a href="#/requests/' + encodeURIComponent(entry.requestId) + '" class="mono">' + esc(entry.requestId.slice(0, 8)) + '</a>' : '<span class="muted">—</span>'
}
function json(value) {
  return '<pre>' + esc(JSON.stringify(value, null, 2)) + '</pre>'
}

const COLUMNS = {
  request: [['Method', e => '<span class="method">' + esc(e.content.method) + '</span>'], ['Path', e => '<span class="mono">' + esc(e.content.path) + '</span>' + (e.content.route && e.content.route !== e.content.path ? ' <span class="muted mono">' + esc(e.content.route) + '</span>' : '')], ['Status', e => statusBadge(e.content.status)], ['Duration', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  query: [['SQL', e => '<div class="sql mono" title="' + esc(e.content.sql) + '">' + esc(e.content.sql) + '</div>' + (e.content.error ? ' <span class="badge b-err">error</span>' : '')], ['Connection', e => esc(e.content.connection || '') + (e.content.replica ? ' <span class="muted">(replica)</span>' : '')], ['Duration', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  job: [['Job', e => '<b>' + esc(e.content.job) + '</b>' + (e.content.chain ? ' <span class="badge" title="chain ' + esc(e.content.chain) + '">chain</span>' : '') + (e.content.batch ? ' <span class="badge" title="batch ' + esc(e.content.batch) + '">batch</span>' : '')], ['Status', e => jobBadge(e.content.status)], ['Queue', e => esc(e.content.queue) + (e.content.connection ? ' <span class="muted">(' + esc(e.content.connection) + ')</span>' : '')], ['Attempt', e => esc(e.content.attempt ?? '')], ['Duration', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  mail: [['Subject', e => '<b>' + esc(e.content.subject) + '</b>' + (e.content.error ? ' <span class="badge b-err">failed</span>' : '')], ['To', e => esc((e.content.to || []).join(', '))], ['Mailer', e => esc(e.content.mailer)], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  event: [['Event', e => '<b>' + esc(e.content.event) + '</b>'], ['Listeners', e => esc(e.content.listeners)], ['Payload', e => '<div class="sql mono">' + esc(JSON.stringify(e.content.payload)) + '</div>'], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  cache: [['Operation', e => '<span class="badge">' + esc(e.content.operation) + '</span>' + (e.content.hit === true ? ' <span class="badge b-ok">hit</span>' : e.content.hit === false ? ' <span class="badge b-warn">miss</span>' : '')], ['Key', e => '<span class="mono">' + esc(e.content.key ?? '') + '</span>'], ['Store', e => esc(e.content.store)], ['Duration', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Request', reqLink]],
  log: [['Level', e => levelBadge(e.content.level)], ['Message', e => esc(e.content.msg)], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  exception: [['Exception', e => '<b>' + esc(e.content.name) + '</b>'], ['Message', e => esc(e.content.message)], ['Status', e => statusBadge(e.content.status)], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  ai: [['Model', e => '<b>' + esc(e.content.model) + '</b> <span class="muted">' + esc(e.content.provider) + '</span>' + (e.content.error ? ' <span class="badge b-err">error</span>' : '')], ['Operation', e => '<span class="badge">' + esc(e.content.operation) + '</span>'], ['Tokens', e => '<span class="num">' + esc(e.content.inputTokens ?? '–') + ' → ' + esc(e.content.outputTokens ?? '–') + '</span>'], ['Latency', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Request', reqLink]],
  schedule: [['Task', e => '<b>' + esc(e.content.name) + '</b>' + (e.content.kind === 'job' ? ' <span class="badge">job</span>' : '')], ['Status', e => e.content.status === 'ok' ? '<span class="badge b-ok">ok</span>' : e.content.status === 'failed' ? '<span class="badge b-err" title="' + esc(e.content.error) + '">failed</span>' : '<span class="badge b-warn">skipped' + (e.content.reason ? ' (' + esc(e.content.reason) + ')' : '') + '</span>'], ['Duration', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
  http: [['Method', e => '<span class="method">' + esc(e.content.method) + '</span>'], ['URL', e => '<div class="sql mono" title="' + esc(e.content.url) + '">' + esc(e.content.url) + '</div>' + (e.content.client ? ' <span class="badge">' + esc(e.content.client) + '</span>' : '') + (e.content.faked ? ' <span class="badge b-info">fake</span>' : '') + (e.content.attempt > 1 ? ' <span class="badge b-warn">retry ' + esc(e.content.attempt - 1) + '</span>' : '')], ['Status', e => e.content.status ? statusBadge(e.content.status) : '<span class="badge b-err">failed</span>'], ['Duration', e => '<span class="num">' + duration(e.content.duration) + '</span>'], ['Request', reqLink], ['Time', e => '<span class="num muted">' + time(e.time) + '</span>']],
}

function matches(entry) {
  if (!filter) return true
  return JSON.stringify(entry).toLowerCase().includes(filter)
}

function table(type, entries, link) {
  const columns = COLUMNS[type]
  if (!entries.length) return '<div class="empty">No entries yet.</div>'
  return '<table><thead><tr>' + columns.map(([name]) => '<th>' + name + '</th>').join('') + '</tr></thead><tbody>'
    + entries.map(entry => '<tr class="row' + (fresh.has(entry.id) ? ' fresh' : '') + '" data-href="' + esc(link(entry)) + '">' + columns.map(([, cell]) => '<td>' + cell(entry) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
}

function entryLink(entry) {
  return entry.type === 'request' ? '#/requests/' + encodeURIComponent(entry.requestId) : '#/' + entry.type + '/' + entry.id
}

async function renderList(tab) {
  const type = TYPE_OF_TAB[tab] || tab
  const { entries } = await api(C.api + '/entries?type=' + type + '&limit=300')
  const shown = entries.filter(matches)
  return '<div class="title"><h2>' + esc(TABS.find(([key]) => key === tab)[1]) + '</h2><span class="muted">' + shown.length + ' entries</span></div><div class="card">' + table(type, shown, entryLink) + '</div>'
}

function headersTable(headers) {
  const rows = Object.entries(headers || {})
  if (!rows.length) return '<div class="empty">None</div>'
  return '<table class="kv">' + rows.map(([key, value]) => '<tr><td class="mono">' + esc(key) + '</td><td class="mono">' + esc(value) + '</td></tr>').join('') + '</table>'
}

async function renderRequest(id) {
  const { request, entries } = await api(C.api + '/requests/' + encodeURIComponent(id))
  const groups = {}
  for (const entry of entries) (groups[entry.type] = groups[entry.type] || []).push(entry)
  let html = '<div class="title"><a href="#/requests">← Requests</a></div>'
  if (request) {
    const c = request.content
    html += '<div class="title"><span class="method">' + esc(c.method) + '</span><h2 class="mono">' + esc(c.path) + '</h2>' + statusBadge(c.status) + '<span class="muted num">' + duration(c.duration) + '</span></div>'
    html += '<div class="card"><h3>Overview</h3><table class="kv">'
      + [['Request ID', '<span class="mono">' + esc(request.requestId) + '</span>'], ['Route', '<span class="mono">' + esc(c.route || '—') + '</span>'], ['Query', '<span class="mono">' + esc(c.query || '—') + '</span>'], ['Client IP', esc(c.ip || '—')], ['Time', new Date(request.time).toLocaleString()], ['Queries', String((groups.query || []).length) + ' · ' + duration((groups.query || []).reduce((sum, q) => sum + (q.content.duration || 0), 0))]]
        .map(([k, v]) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>').join('') + '</table></div>'
    html += '<div class="card"><h3>Request headers</h3>' + headersTable(c.requestHeaders) + '</div>'
    html += '<div class="card"><h3>Response headers</h3>' + headersTable(c.responseHeaders) + '</div>'
  }
  else {
    html += '<div class="card"><div class="empty">Request <span class="mono">' + esc(id) + '</span> is still running or has been evicted from the buffer.</div></div>'
  }
  for (const [type, title] of [['exception', 'Exceptions'], ['query', 'Queries'], ['job', 'Jobs'], ['mail', 'Mail'], ['event', 'Events'], ['cache', 'Cache'], ['ai', 'AI'], ['http', 'HTTP Client'], ['log', 'Logs']]) {
    const list = groups[type]
    if (!list) continue
    html += '<div class="card"><h3>' + title + ' <span class="count">' + list.length + '</span></h3>' + table(type, list, entryLink) + '</div>'
  }
  return html
}

async function renderEntry(type, id) {
  const { entry } = await api(C.api + '/entries/' + id)
  const c = entry.content
  let html = '<div class="title"><a href="#/' + type + '">← Back</a>' + (entry.requestId ? ' <span class="muted">request</span> ' + reqLink(entry) : '') + (entry.jobId ? ' <span class="muted">job</span> <span class="mono">' + esc(entry.jobId.slice(0, 8)) + '</span>' : '') + '</div>'
  if (type === 'query') {
    html += '<div class="card"><h3>SQL <span class="count">' + duration(c.duration) + '</span></h3><div class="body"><pre>' + esc(c.sql) + '</pre></div></div>'
    html += '<div class="card"><h3>Bindings</h3><div class="body">' + json(c.params || []) + '</div></div>'
    if (c.error) html += '<div class="card"><h3>Error</h3><div class="body"><pre>' + esc(c.error) + '</pre></div></div>'
    return html
  }
  if (type === 'mail') {
    html += '<div class="card"><h3>' + esc(c.subject) + '</h3><table class="kv">' + [['From', c.from], ['To', (c.to || []).join(', ')], ['Cc', (c.cc || []).join(', ')], ['Bcc', (c.bcc || []).join(', ')], ['Mailer', c.mailer + ' (' + c.driver + ')'], ['Message ID', c.messageId || '—']].filter(([, v]) => v).map(([k, v]) => '<tr><td>' + k + '</td><td>' + esc(v) + '</td></tr>').join('') + '</table></div>'
    if (c.html) html += '<div class="card"><h3>Preview</h3><div class="body"><iframe class="preview" sandbox src="' + esc(C.api + '/mail/' + entry.id + '/preview') + '"></iframe></div></div>'
    if (c.text) html += '<div class="card"><h3>Plain text</h3><div class="body"><pre>' + esc(c.text) + '</pre></div></div>'
    return html
  }
  if (type === 'exception' || (type === 'job' && c.error)) {
    html += '<div class="card"><h3>' + esc(c.name || c.job) + '</h3><div class="body"><pre>' + esc(c.stack || c.error || c.message) + '</pre></div></div>'
  }
  html += '<div class="card"><h3>Details</h3><div class="body">' + json(c) + '</div></div>'
  return html
}

async function renderQueues() {
  const { connections } = await api(C.queuesApi)
  if (!connections.length) return '<div class="title"><h2>Queues</h2></div><div class="card"><div class="empty">No queue connections.</div></div>'
  let html = '<div class="title"><h2>Queues</h2></div>'
  for (const conn of connections) {
    html += '<div class="card"><h3>' + esc(conn.name) + ' <span class="badge">' + esc(conn.driver) + '</span>' + (conn.default ? ' <span class="badge b-info">default</span>' : '') + '</h3><div class="body">'
    if (conn.error) {
      html += '<div class="muted">' + esc(conn.error) + '</div></div></div>'
      continue
    }
    if (conn.counts) html += '<div class="grid" style="margin-bottom:12px">' + ['waiting', 'delayed', 'active', 'failed'].map(key => '<div class="stat"><b class="num">' + esc(conn.counts[key]) + '</b><span>' + key + '</span></div>').join('') + '</div>'
    const failed = conn.failed || []
    html += '<div class="toolbar" style="margin-bottom:8px"><b>Failed jobs</b><span class="muted">' + failed.length + '</span><span style="flex:1"></span>'
      + '<button data-action="retry" data-conn="' + esc(conn.name) + '"' + (failed.length ? '' : ' disabled') + '>Retry all</button>'
      + '<button class="danger" data-action="flush" data-conn="' + esc(conn.name) + '"' + (failed.length ? '' : ' disabled') + '>Flush</button></div>'
    html += failed.length
      ? '<table><thead><tr><th>Job</th><th>Queue</th><th>Attempts</th><th>Failed at</th><th>Error</th><th></th></tr></thead><tbody>' + failed.map(job => '<tr><td><b>' + esc(job.job) + '</b><div class="muted mono">' + esc(job.id) + '</div>' + (job.batch ? '<div class="muted mono">batch ' + esc(job.batch) + '</div>' : '') + (job.chain ? '<div class="muted mono">chain ' + esc(job.chain) + '</div>' : '') + '</td><td>' + esc(job.queue) + '</td><td class="num">' + esc(job.attempts) + '</td><td class="num muted">' + new Date(job.failedAt).toLocaleString() + '</td><td><details><summary class="mono">' + esc(String(job.error).split('\n')[0]) + '</summary><pre>' + esc(job.error) + '</pre><b>Payload</b>' + json(job.payload) + '</details></td><td class="right" style="white-space:nowrap"><button data-action="retry" data-conn="' + esc(conn.name) + '" data-id="' + esc(job.id) + '">Retry</button> <button class="danger" data-action="forget" data-conn="' + esc(conn.name) + '" data-id="' + esc(job.id) + '">Forget</button></td></tr>').join('') + '</tbody></table>'
      : '<div class="empty">No failed jobs.</div>'
    html += '</div></div>'
  }
  return html
}

function renderNav() {
  const { tab } = route()
  $('nav').innerHTML = TABS.map(([key, title]) => {
    const count = counts[TYPE_OF_TAB[key] || key]
    return '<a href="#/' + key + '" class="' + (key === tab ? 'active' : '') + '"><span>' + title + '</span><small>' + (count ?? '') + '</small></a>'
  }).join('')
}

async function render() {
  renderQueued = false
  const { tab, id } = route()
  renderNav()
  const main = $('main')
  try {
    let html
    if (tab === 'queues') html = await renderQueues()
    else if (tab === 'requests' && id) html = await renderRequest(id)
    else if (id) html = await renderEntry(tab, id)
    else html = await renderList(tab)
    main.innerHTML = html
    fresh = new Set()
  }
  catch (error) {
    main.innerHTML = '<div class="card"><div class="empty">' + esc(error.message) + '</div></div>'
  }
}

function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  setTimeout(render, 150)
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]')
  if (button) {
    const { action, conn, id } = button.dataset
    if (action === 'flush' && !confirm('Delete all failed jobs on "' + conn + '"?')) return
    button.disabled = true
    try {
      await api(C.queuesApi + '/' + encodeURIComponent(conn) + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(id ? { id } : {}) })
    }
    catch (error) { alert(error.message) }
    return render()
  }
  const row = event.target.closest('tr[data-href]')
  if (row && !event.target.closest('a')) location.hash = row.dataset.href
})

window.addEventListener('hashchange', render)

function init() {
  $('#filter').addEventListener('input', (event) => {
    filter = event.target.value.trim().toLowerCase()
    scheduleRender()
  })
  if (C.initial && !location.hash) history.replaceState(null, '', C.initial)
  const clear = $('#clear')
  if (C.mode === 'queues') {
    clear.remove()
    $('.live').remove()
    return render()
  }
  clear.addEventListener('click', async () => {
    await api(C.api + '/clear', { method: 'POST' })
    counts = {}
    render()
  })
  api(C.api + '/stats').then((stats) => {
    counts = stats.counts
    renderNav()
  }).catch(() => {})
  const source = new EventSource(C.api + '/stream')
  source.onopen = () => $('.live').classList.add('on')
  source.onerror = () => $('.live').classList.remove('on')
  source.addEventListener('entry', (message) => {
    const entry = JSON.parse(message.data)
    counts[entry.type] = (counts[entry.type] || 0) + 1
    fresh.add(entry.id)
    const { tab, id } = route()
    const type = TYPE_OF_TAB[tab] || tab
    if ((!id && type === entry.type) || (tab === 'requests' && id && entry.requestId === id)) scheduleRender()
    else renderNav()
  })
  render()
}
init()
`

/** 面板页面：单个自包含的 HTML（内联样式与脚本，无需 CDN） */
export function renderDashboardPage(options: DashboardPageOptions): string {
  const title = options.mode === 'queues'
    ? `Queues · ${FRAMEWORK_NAME}`
    : `${FRAMEWORK_NAME} dashboard`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="brand"><span>haze</span>${options.mode === 'queues'
    ? ' queues'
    : ' dashboard'}</div>
  <span class="live"><i></i>live</span>
  <div class="spacer"></div>
  <input id="filter" type="search" placeholder="Filter…" aria-label="Filter entries">
  <button id="clear" type="button">Clear</button>
</header>
<div class="layout">
  <nav aria-label="Sections"></nav>
  <main></main>
</div>
<script>window.__HAZE__ = ${scriptJson({
  base: options.base,
  api: options.api,
  queuesApi: options.queuesApi,
  mode: options.mode,
  initial: options.initial,
})}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}
