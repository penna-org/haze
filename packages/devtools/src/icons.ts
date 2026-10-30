/**
 * 面板图标：内联 SVG（data URI），不依赖 hub-ui 运行时从 api.iconify.design 拉取，离线也能显示。
 * `<img>` 中的 SVG 无法继承 currentColor，按明暗主题各给一种颜色。
 */
interface Icon { light: string, dark: string }

const LIGHT = '#52525b'
const DARK = '#d4d4d8'

function icon(body: string): Icon {
  const svg = (color: string): string => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`
  return {
    light: svg(LIGHT),
    dark: svg(DARK),
  }
}

/** 与文档站相同的 logo（docs/public/logo.svg，不带背景色） */
export const LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><defs><linearGradient id="hz" x1="10" y1="8" x2="58" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="#7a6bff"/><stop offset="1" stop-color="#30a9e4"/></linearGradient></defs><path d="M14 7v44M14 36c0-12.5 8-19 18-19s18 6.5 18 19v4" stroke="url(#hz)" stroke-width="8" stroke-linecap="round"/><path d="M42 48.5c2.7-2 5.3-2 8 0s5.3 2 8 0" stroke="url(#hz)" stroke-opacity=".62" stroke-width="6" stroke-linecap="round"/><path d="M36 57c3.3-2.4 6.7-2.4 10 0s6.7 2.4 10 0 4-1.6 6-1" stroke="url(#hz)" stroke-opacity=".3" stroke-width="5.5" stroke-linecap="round"/></svg>')}`

/** 仪表盘：概览 */
export const OVERVIEW_ICON = icon('<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><circle cx="12" cy="15" r="1.2"/><path d="M4 19h16"/>')

/** 路标：路由 */
export const ROUTES_ICON = icon('<path d="M12 3v18"/><path d="M5 6h11l3 2.5L16 11H5z"/><path d="M19 13H8l-3 2.5L8 18h11z"/>')

/** 脉搏：开发面板 */
export const DASHBOARD_ICON = icon('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>')

/** 节点与连线：模块联动图 */
export const GRAPH_ICON = icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.3 7.2l7.3.6M7 8.4l1.4 7.2M16.6 10.1l-5.8 6.2"/>')

/** 瀑布条：请求 */
export const REQUESTS_ICON = icon('<path d="M4 5h9M7 10h10M10 15h6M5 20h14"/>')

/** 星芒：AI */
export const AI_ICON = icon('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>')

/** 时钟：定时任务与队列 */
export const TASKS_ICON = icon('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>')

/** 积木：容器、提供者与事件 */
export const INTERNALS_ICON = icon('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>')

/** 花括号：API 文档 */
export const API_ICON = icon('<path d="M9 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/>')
