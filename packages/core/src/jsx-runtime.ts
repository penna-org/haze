/**
 * JSX 自动运行时（`"jsx": "react-jsx"` + `"jsxImportSource": "@hazejs/core"`）：
 * 服务端渲染为转义后的 HTML 字符串，零依赖，各运行时（含 Workers）可用。
 */
export { Fragment, jsx, jsxs } from './view/jsx'
export type { Component, JSX, ViewChild, ViewNode } from './view/jsx'
