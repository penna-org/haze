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

export const LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><defs><radialGradient id="g" cx="18" cy="14" r="56" gradientUnits="userSpaceOnUse"><stop stop-color="#948aff"/><stop offset="1" stop-color="#4f3fdc"/></radialGradient></defs><rect x="4" y="4" width="56" height="56" rx="16" fill="url(#g)"/><path d="M19 15v34M19 40c0-9 5.5-14 12-14s12 5 12 14" stroke="#fff" stroke-width="6" stroke-linecap="round"/><path d="M41.5 40h5" stroke="#fff" stroke-width="6" stroke-linecap="round"/><path d="M39 47h11" stroke="#fff" stroke-opacity=".6" stroke-width="5" stroke-linecap="round"/><path d="M37 53.5h15" stroke="#fff" stroke-opacity=".3" stroke-width="4.5" stroke-linecap="round"/></svg>')}`

/** 仪表盘：概览 */
export const OVERVIEW_ICON = icon('<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><circle cx="12" cy="15" r="1.2"/><path d="M4 19h16"/>')

/** 路标：路由 */
export const ROUTES_ICON = icon('<path d="M12 3v18"/><path d="M5 6h11l3 2.5L16 11H5z"/><path d="M19 13H8l-3 2.5L8 18h11z"/>')

/** 脉搏：开发面板 */
export const DASHBOARD_ICON = icon('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>')
