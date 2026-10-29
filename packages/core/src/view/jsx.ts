import type { RawHtml } from '../mail/layout'
import type { HtmlIntrinsicElements } from './types'
import { escapeHtml, rawHtml } from '../mail/layout'

const kNode = Symbol.for('hazejs.jsx')
const kRawHtml = Symbol.for('hazejs.mail.raw')

/** 可以渲染的内容：元素、字符串 / 数字（转义）、rawHtml()（原样）、数组、Promise；null / undefined / 布尔值不输出 */
export type ViewChild = ViewNode | RawHtml | string | number | bigint | boolean | null | undefined | Iterable<ViewChild> | Promise<ViewChild>

/** 组件：接收 props（含 children），返回可渲染的内容，可以是 async 函数 */
export type Component<P = Record<string, unknown>> = (props: P) => ViewChild

/** JSX 表达式的值（`<Home />`）：惰性的节点，`renderToString()` / `ctx.view()` 时才执行组件 */
export interface ViewNode {
  readonly [kNode]: true
  readonly type: string | Component<any>
  readonly props: Record<string, unknown>
  readonly key?: unknown
}

/** 是否为 JSX 节点（响应格式化据此把 `return <Home />` 渲染为 HTML） */
export function isViewNode(value: unknown): value is ViewNode {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[kNode] === true
}

/** 自动运行时（`jsx: 'react-jsx'`）的工厂函数 */
export function jsx(type: string | Component<any>, props: Record<string, unknown> | null, key?: unknown): ViewNode {
  return {
    [kNode]: true,
    type,
    props: props ?? {},
    ...(key !== undefined && { key }),
  }
}

/** 多个静态子节点（与 jsx 相同） */
export const jsxs = jsx

/** 开发模式的工厂函数（忽略 source / self 等调试信息） */
export function jsxDEV(type: string | Component<any>, props: Record<string, unknown> | null, key?: unknown): ViewNode {
  return jsx(type, props, key)
}

/** 片段：`<>...</>` */
export function Fragment(props: { children?: ViewChild }): ViewChild {
  return props.children
}

/** `<!DOCTYPE html>`（JSX 无法直接书写；`ctx.view()` 渲染以 `<html>` 开头的页面时也会自动补上） */
export function Doctype(): RawHtml {
  return rawHtml('<!DOCTYPE html>')
}

/** 无结束标签的元素 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** 不加 px 的数值样式（与 React 的列表一致的常见部分） */
const UNITLESS = new Set([
  'animation-iteration-count',
  'aspect-ratio',
  'column-count',
  'columns',
  'flex',
  'flex-grow',
  'flex-shrink',
  'font-weight',
  'grid-column',
  'grid-row',
  'line-clamp',
  'line-height',
  'opacity',
  'order',
  'orphans',
  'tab-size',
  'widows',
  'z-index',
  'zoom',
])

/** 合法的属性名（拒绝空白、引号、尖括号、斜杠与等号，防止属性注入） */
const ATTR_NAME_RE = /^[^\s"'<>/=]+$/

const ATTR_ALIASES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  httpEquiv: 'http-equiv',
  acceptCharset: 'accept-charset',
}

function isRawHtml(value: unknown): value is RawHtml {
  return typeof value === 'object' && value !== null && kRawHtml in value
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
}

function hyphenate(name: string): string {
  return name.startsWith('--')
    ? name
    : name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

/** `style={{ fontSize: 14, color: 'red' }}` → `font-size:14px;color:red` */
function styleString(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, value]) => value !== null && value !== undefined && value !== false && value !== '')
    .map(([name, value]) => {
      const property = hyphenate(name)
      const text = typeof value === 'number' && value !== 0 && !UNITLESS.has(property) && !property.startsWith('--')
        ? `${value}px`
        : String(value)
      return `${property}:${text}`
    })
    .join(';')
}

/** `class={['btn', { active: true }]}` → `btn active`（字符串、数组与对象可以组合） */
function classString(value: unknown): string {
  if (!value)
    return ''
  if (typeof value === 'string' || typeof value === 'number')
    return String(value)
  if (Array.isArray(value))
    return value.map(classString).filter(Boolean).join(' ')
  if (typeof value === 'object')
    return Object.entries(value).filter(([, on]) => on).map(([name]) => name).join(' ')
  return ''
}

function renderAttribute(name: string, value: unknown): string {
  const attr = ATTR_ALIASES[name] ?? name
  if (!ATTR_NAME_RE.test(attr))
    return ''
  // 事件处理函数等无法序列化的值不输出
  if (value === null || value === undefined || value === false || typeof value === 'function' || typeof value === 'symbol')
    return ''
  if (value === true)
    return ` ${attr}`
  if (attr === 'class') {
    const text = classString(value)
    return text
      ? ` class="${escapeHtml(text)}"`
      : ''
  }
  if (attr === 'style' && typeof value === 'object' && !isRawHtml(value)) {
    const text = styleString(value as Record<string, unknown>)
    return text
      ? ` style="${escapeHtml(text)}"`
      : ''
  }
  return ` ${attr}="${escapeHtml(value)}"`
}

function renderAttributes(props: Record<string, unknown>): string | Promise<string> {
  let sync = ''
  let pending: Array<string | Promise<string>> | undefined
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'dangerouslySetInnerHTML' || name === 'key' || name === 'ref')
      continue
    // 属性值可以是 Promise（如异步取得的旧输入）
    const part = isPromiseLike(value)
      ? Promise.resolve(value).then(resolved => renderAttribute(name, resolved))
      : renderAttribute(name, value)
    if (typeof part === 'string' && !pending) {
      sync += part
    }
    else {
      pending ??= [sync]
      pending.push(part)
    }
  }
  return pending
    ? Promise.all(pending).then(parts => parts.join(''))
    : sync
}

function renderElement(tag: string, props: Record<string, unknown>): string | Promise<string> {
  const attributes = renderAttributes(props)
  const inner = (): string | Promise<string> => {
    const html = props.dangerouslySetInnerHTML as { __html?: unknown } | undefined
    if (html && html.__html !== undefined && html.__html !== null)
      return String(html.__html)
    return renderChild(props.children as ViewChild)
  }
  const close = (attrs: string): string | Promise<string> => {
    if (VOID_ELEMENTS.has(tag))
      return `<${tag}${attrs}>`
    const content = inner()
    return typeof content === 'string'
      ? `<${tag}${attrs}>${content}</${tag}>`
      : content.then(text => `<${tag}${attrs}>${text}</${tag}>`)
  }
  return typeof attributes === 'string'
    ? close(attributes)
    : attributes.then(close)
}

function renderList(items: Iterable<ViewChild>): string | Promise<string> {
  const parts: Array<string | Promise<string>> = []
  let async = false
  for (const item of items) {
    const part = renderChild(item)
    async ||= typeof part !== 'string'
    parts.push(part)
  }
  // 同级的异步组件并发执行，输出顺序不变
  return async
    ? Promise.all(parts).then(texts => texts.join(''))
    : (parts as string[]).join('')
}

/**
 * 渲染为 HTML 字符串：没有异步组件时同步返回字符串，否则返回 Promise。
 * 文本与属性值都会转义；rawHtml() / html`` / dangerouslySetInnerHTML 原样输出。
 */
export function renderChild(input: ViewChild): string | Promise<string> {
  // 按 unknown 收窄，避免递归的 ViewChild 类型展开过深
  const child = input as unknown
  if (child === null || child === undefined || typeof child === 'boolean')
    return ''
  if (typeof child === 'string')
    return escapeHtml(child)
  if (typeof child === 'number' || typeof child === 'bigint')
    return String(child)
  if (isPromiseLike(child))
    return Promise.resolve(child).then(value => renderChild(value as ViewChild))
  if (isRawHtml(child))
    return child.toString()
  if (isViewNode(child)) {
    if (typeof child.type === 'function')
      return renderChild((child.type as Component<any>)(child.props))
    return renderElement(child.type as string, child.props)
  }
  if (typeof child === 'object' && Symbol.iterator in child)
    return renderList(child as Iterable<ViewChild>)
  return escapeHtml(String(child))
}

/** 渲染 JSX 节点（或任意可渲染的内容）为 HTML 字符串 */
export async function renderToString(node: ViewChild): Promise<string> {
  return renderChild(node)
}

/** 自定义 JSX 命名空间（`jsxImportSource: '@hazejs/core'` 时 TypeScript 从 jsx-runtime 读取） */
// eslint-disable-next-line ts/no-namespace
export namespace JSX {
  export type Element = ViewNode
  /** 组件可以返回任意可渲染的内容（包括 Promise，即 async 组件） */
  export type ElementType = string | Component<any>
  export interface ElementChildrenAttribute {
    children: unknown
  }
  export interface IntrinsicAttributes {
    key?: string | number
  }
  export interface IntrinsicElements extends HtmlIntrinsicElements {}
}
