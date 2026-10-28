const kRaw = Symbol.for('hazejs.mail.raw')

export interface RawHtml {
  readonly [kRaw]: string
  toString: () => string
}

/** 不转义的 HTML 片段（用于 html`` 模板中插入已经安全的 HTML） */
export function rawHtml(value: string): RawHtml {
  return {
    [kRaw]: value,
    toString: () => value,
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function interpolate(value: unknown): string {
  if (Array.isArray(value))
    return value.map(interpolate).join('')
  if (typeof value === 'object' && value !== null && kRaw in value)
    return (value as RawHtml)[kRaw]
  if (value === false || value === null || value === undefined)
    return ''
  return escapeHtml(value)
}

/**
 * HTML 模板：插值自动转义，数组拼接，`rawHtml()` / 嵌套的 html`` 原样插入。
 *
 * ```ts
 * html`<p>你好，${user.name}</p>${items.map(item => html`<li>${item}</li>`)}`
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let result = strings[0]
  values.forEach((value, index) => {
    result += interpolate(value) + strings[index + 1]
  })
  return rawHtml(result)
}

export interface ButtonOptions {
  color?: string
}

/** 邮件按钮（表格布局，兼容主流客户端） */
export function button(text: string, url: string, options: ButtonOptions = {}): RawHtml {
  const color = options.color ?? '#2563eb'
  return html`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="border-radius:6px;background:${color}"><a href="${url}" target="_blank" style="display:inline-block;padding:12px 24px;color:#ffffff;font-weight:600;text-decoration:none;border-radius:6px">${text}</a></td></tr></table>`
}

export interface LayoutOptions {
  /** 正文 HTML（html`` 模板或字符串） */
  body: RawHtml | string
  /** 预览文本（收件箱列表中标题后的摘要） */
  preheader?: string
  /** 顶部品牌名 */
  brand?: string
  footer?: RawHtml | string
  /** 主色，默认 #2563eb */
  color?: string
}

/**
 * 简单的响应式邮件布局（内联样式）：
 *
 * ```ts
 * export default defineMail((payload: { name: string, url: string }) => ({
 *   subject: '欢迎加入',
 *   html: mailLayout({
 *     brand: 'Demo',
 *     body: html`<h1>你好，${payload.name}</h1>${button('开始使用', payload.url)}`,
 *   }),
 * }))
 * ```
 */
export function mailLayout(options: LayoutOptions): string {
  const color = options.color ?? '#2563eb'
  const body = typeof options.body === 'string'
    ? rawHtml(options.body)
    : options.body
  const footer = typeof options.footer === 'string'
    ? rawHtml(escapeHtml(options.footer))
    : options.footer
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#18181b">
${options.preheader
  ? html`<div style="display:none;max-height:0;overflow:hidden">${options.preheader}</div>`
  : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
${options.brand
  ? html`<tr><td style="padding:0 0 16px;font-size:20px;font-weight:700;color:${color}">${options.brand}</td></tr>`
  : ''}
<tr><td style="background:#ffffff;border-radius:8px;padding:32px;font-size:15px;line-height:1.6">${body}</td></tr>
${footer
  ? html`<tr><td style="padding:16px 0 0;font-size:12px;color:#71717a;text-align:center">${footer}</td></tr>`
  : ''}
</table>
</td></tr></table>
</body>
</html>`.toString()
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
  apos: '\'',
}

/** 由 HTML 生成纯文本版本（链接保留为 `文字 (地址)`） */
export function htmlToText(input: string): string {
  return input
    .replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, '').trim()
      return label && label !== href
        ? `${label} (${href})`
        : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith('#x'))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16))
      if (code.startsWith('#'))
        return String.fromCodePoint(Number(code.slice(1)))
      return ENTITIES[code.toLowerCase()] ?? entity
    })
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
