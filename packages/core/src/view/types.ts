import type { RawHtml } from '../mail/layout'
import type { ViewChild } from './jsx'

/** 属性值：可以是 Promise（渲染时等待） */
type AttrValue<T> = T | Promise<T>

type Booleanish = boolean | 'true' | 'false'

/** `class` 支持字符串、数组与 `{ active: true }` 形式的对象 */
export type ClassValue = string | number | null | undefined | false | ClassValue[] | Record<string, unknown>

/** `style` 支持字符串或对象（驼峰属性名自动转为连字符，数值默认加 px） */
export type StyleValue = string | Record<string, string | number | null | undefined | false>

/** 全局属性（不是穷举：data-* / aria-* / hx-* / x-* 等前缀属性均可使用） */
export interface HtmlAttributes {
  /** 列表项的 key（服务端渲染时忽略，便于与前端代码共用写法） */
  key?: string | number
  children?: ViewChild
  /** 不转义的内部 HTML（等同于子节点使用 rawHtml()） */
  dangerouslySetInnerHTML?: { __html: string | RawHtml }
  id?: AttrValue<string>
  class?: AttrValue<ClassValue>
  className?: AttrValue<ClassValue>
  style?: AttrValue<StyleValue>
  title?: AttrValue<string>
  lang?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  hidden?: boolean | 'until-found'
  tabindex?: number | string
  tabIndex?: number | string
  role?: string
  slot?: string
  draggable?: Booleanish
  contenteditable?: Booleanish | 'plaintext-only'
  spellcheck?: Booleanish
  translate?: 'yes' | 'no'
  inert?: boolean
  popover?: boolean | 'auto' | 'manual'
  accesskey?: string
  autofocus?: boolean
  nonce?: string
  part?: string
  is?: string
  inputmode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search'
  enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send'
  itemscope?: boolean
  itemtype?: string
  itemprop?: string
  [key: `data-${string}`]: unknown
  [key: `aria-${string}`]: AttrValue<string | number | boolean | undefined>
  /** htmx */
  [key: `hx-${string}`]: unknown
  /** Alpine.js */
  [key: `x-${string}`]: unknown
}

export interface AnchorAttributes extends HtmlAttributes {
  href?: AttrValue<string>
  target?: '_self' | '_blank' | '_parent' | '_top' | (string & {})
  rel?: string
  download?: boolean | string
  hreflang?: string
  type?: string
  referrerpolicy?: string
  ping?: string
}

export interface ImgAttributes extends HtmlAttributes {
  src?: AttrValue<string>
  srcset?: string
  sizes?: string
  alt?: string
  width?: number | string
  height?: number | string
  loading?: 'eager' | 'lazy'
  decoding?: 'sync' | 'async' | 'auto'
  fetchpriority?: 'high' | 'low' | 'auto'
  crossorigin?: 'anonymous' | 'use-credentials' | ''
  referrerpolicy?: string
  usemap?: string
}

export interface FormAttributes extends HtmlAttributes {
  'action'?: AttrValue<string>
  'method'?: 'get' | 'post' | 'dialog' | 'GET' | 'POST'
  'enctype'?: 'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain'
  'novalidate'?: boolean
  'target'?: string
  'autocomplete'?: 'on' | 'off'
  'name'?: string
  'accept-charset'?: string
  'acceptCharset'?: string
}

export interface InputAttributes extends HtmlAttributes {
  type?: 'button' | 'checkbox' | 'color' | 'date' | 'datetime-local' | 'email' | 'file' | 'hidden' | 'image' | 'month' | 'number' | 'password' | 'radio' | 'range' | 'reset' | 'search' | 'submit' | 'tel' | 'text' | 'time' | 'url' | 'week'
  name?: string
  value?: AttrValue<string | number | null | undefined>
  checked?: AttrValue<boolean>
  disabled?: boolean
  readonly?: boolean
  required?: boolean
  placeholder?: string
  autocomplete?: string
  min?: number | string
  max?: number | string
  step?: number | string
  minlength?: number
  maxlength?: number
  pattern?: string
  multiple?: boolean
  accept?: string
  form?: string
  list?: string
  size?: number
  src?: string
  alt?: string
  width?: number | string
  height?: number | string
  capture?: boolean | 'user' | 'environment'
}

export interface ButtonAttributes extends HtmlAttributes {
  type?: 'button' | 'submit' | 'reset'
  name?: string
  value?: string | number
  disabled?: boolean
  form?: string
  formaction?: string
  formmethod?: string
  popovertarget?: string
  popovertargetaction?: 'hide' | 'show' | 'toggle'
}

export interface LabelAttributes extends HtmlAttributes {
  for?: string
  htmlFor?: string
  form?: string
}

export interface SelectAttributes extends HtmlAttributes {
  name?: string
  disabled?: boolean
  multiple?: boolean
  required?: boolean
  size?: number
  form?: string
  autocomplete?: string
}

export interface OptionAttributes extends HtmlAttributes {
  value?: string | number
  selected?: AttrValue<boolean>
  disabled?: boolean
  label?: string
}

export interface TextareaAttributes extends HtmlAttributes {
  name?: string
  rows?: number
  cols?: number
  placeholder?: string
  disabled?: boolean
  readonly?: boolean
  required?: boolean
  minlength?: number
  maxlength?: number
  wrap?: 'hard' | 'soft' | 'off'
  form?: string
  autocomplete?: string
}

export interface MetaAttributes extends HtmlAttributes {
  'charset'?: string
  'name'?: string
  'content'?: AttrValue<string>
  'http-equiv'?: string
  'httpEquiv'?: string
  'property'?: string
  'media'?: string
}

export interface LinkAttributes extends HtmlAttributes {
  rel?: string
  href?: AttrValue<string>
  type?: string
  media?: string
  as?: string
  sizes?: string
  hreflang?: string
  crossorigin?: 'anonymous' | 'use-credentials' | ''
  integrity?: string
  referrerpolicy?: string
  fetchpriority?: 'high' | 'low' | 'auto'
}

export interface ScriptAttributes extends HtmlAttributes {
  src?: AttrValue<string>
  type?: string
  async?: boolean
  defer?: boolean
  crossorigin?: 'anonymous' | 'use-credentials' | ''
  integrity?: string
  nomodule?: boolean
  referrerpolicy?: string
}

export interface StyleAttributes extends HtmlAttributes {
  media?: string
}

export interface HtmlRootAttributes extends HtmlAttributes {
  lang?: string
  xmlns?: string
}

export interface MediaAttributes extends HtmlAttributes {
  src?: AttrValue<string>
  controls?: boolean
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  preload?: 'none' | 'metadata' | 'auto' | ''
  playsinline?: boolean
  poster?: string
  width?: number | string
  height?: number | string
  crossorigin?: 'anonymous' | 'use-credentials' | ''
}

export interface SourceAttributes extends HtmlAttributes {
  src?: string
  srcset?: string
  type?: string
  media?: string
  sizes?: string
}

export interface IframeAttributes extends HtmlAttributes {
  src?: AttrValue<string>
  srcdoc?: string
  name?: string
  width?: number | string
  height?: number | string
  allow?: string
  allowfullscreen?: boolean
  loading?: 'eager' | 'lazy'
  sandbox?: string
  referrerpolicy?: string
}

export interface TableCellAttributes extends HtmlAttributes {
  colspan?: number
  rowspan?: number
  headers?: string
  scope?: 'row' | 'col' | 'rowgroup' | 'colgroup'
  abbr?: string
}

export interface TimeAttributes extends HtmlAttributes {
  datetime?: string
}

export interface DetailsAttributes extends HtmlAttributes {
  open?: boolean
  name?: string
}

export interface DialogAttributes extends HtmlAttributes {
  open?: boolean
}

export interface ProgressAttributes extends HtmlAttributes {
  value?: number | string
  max?: number | string
}

export interface MeterAttributes extends ProgressAttributes {
  min?: number | string
  low?: number | string
  high?: number | string
  optimum?: number | string
}

export interface OlAttributes extends HtmlAttributes {
  start?: number
  reversed?: boolean
  type?: '1' | 'a' | 'A' | 'i' | 'I'
}

export interface LiAttributes extends HtmlAttributes {
  value?: number
}

export interface QuoteAttributes extends HtmlAttributes {
  cite?: string
}

export interface FieldsetAttributes extends HtmlAttributes {
  disabled?: boolean
  form?: string
  name?: string
}

export interface OutputAttributes extends HtmlAttributes {
  for?: string
  htmlFor?: string
  form?: string
  name?: string
}

export interface BaseAttributes extends HtmlAttributes {
  href?: string
  target?: string
}

export interface SvgAttributes extends HtmlAttributes {
  [key: string]: unknown
}

type Common = HtmlAttributes

/** 内置 HTML 元素及其属性（不在列表中的标签，如自定义元素，使用全局属性） */
export interface HtmlIntrinsicElements {
  a: AnchorAttributes
  abbr: Common
  address: Common
  area: AnchorAttributes & { alt?: string, coords?: string, shape?: string }
  article: Common
  aside: Common
  audio: MediaAttributes
  b: Common
  base: BaseAttributes
  bdi: Common
  bdo: Common
  blockquote: QuoteAttributes
  body: Common
  br: Common
  button: ButtonAttributes
  canvas: Common & { width?: number | string, height?: number | string }
  caption: Common
  cite: Common
  code: Common
  col: Common & { span?: number }
  colgroup: Common & { span?: number }
  data: Common & { value?: string | number }
  datalist: Common
  dd: Common
  del: QuoteAttributes & { datetime?: string }
  details: DetailsAttributes
  dfn: Common
  dialog: DialogAttributes
  div: Common
  dl: Common
  dt: Common
  em: Common
  embed: Common & { src?: string, type?: string, width?: number | string, height?: number | string }
  fieldset: FieldsetAttributes
  figcaption: Common
  figure: Common
  footer: Common
  form: FormAttributes
  h1: Common
  h2: Common
  h3: Common
  h4: Common
  h5: Common
  h6: Common
  head: Common
  header: Common
  hgroup: Common
  hr: Common
  html: HtmlRootAttributes
  i: Common
  iframe: IframeAttributes
  img: ImgAttributes
  input: InputAttributes
  ins: QuoteAttributes & { datetime?: string }
  kbd: Common
  label: LabelAttributes
  legend: Common
  li: LiAttributes
  link: LinkAttributes
  main: Common
  map: Common & { name?: string }
  mark: Common
  menu: Common
  meta: MetaAttributes
  meter: MeterAttributes
  nav: Common
  noscript: Common
  object: Common & { data?: string, type?: string, width?: number | string, height?: number | string }
  ol: OlAttributes
  optgroup: Common & { label?: string, disabled?: boolean }
  option: OptionAttributes
  output: OutputAttributes
  p: Common
  picture: Common
  pre: Common
  progress: ProgressAttributes
  q: QuoteAttributes
  rp: Common
  rt: Common
  ruby: Common
  s: Common
  samp: Common
  script: ScriptAttributes
  search: Common
  section: Common
  select: SelectAttributes
  slot: Common & { name?: string }
  small: Common
  source: SourceAttributes
  span: Common
  strong: Common
  style: StyleAttributes
  sub: Common
  summary: Common
  sup: Common
  svg: SvgAttributes
  table: Common
  tbody: Common
  td: TableCellAttributes
  template: Common
  textarea: TextareaAttributes
  tfoot: Common
  th: TableCellAttributes
  thead: Common
  time: TimeAttributes
  title: Common
  tr: Common
  track: Common & { src?: string, kind?: string, srclang?: string, label?: string, default?: boolean }
  u: Common
  ul: Common
  var: Common
  video: MediaAttributes
  wbr: Common
  // SVG（属性不做约束）
  circle: SvgAttributes
  clipPath: SvgAttributes
  defs: SvgAttributes
  ellipse: SvgAttributes
  g: SvgAttributes
  line: SvgAttributes
  linearGradient: SvgAttributes
  mask: SvgAttributes
  path: SvgAttributes
  pattern: SvgAttributes
  polygon: SvgAttributes
  polyline: SvgAttributes
  radialGradient: SvgAttributes
  rect: SvgAttributes
  stop: SvgAttributes
  symbol: SvgAttributes
  text: SvgAttributes
  tspan: SvgAttributes
  use: SvgAttributes
  /** 自定义元素（`<my-widget>`，名称须带连字符） */
  [tag: `${string}-${string}`]: SvgAttributes
}
