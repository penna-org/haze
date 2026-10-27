import process from 'node:process'

/**
 * 最小的 ANSI 颜色工具（不依赖 node:tty，可运行于 Workers / Deno 等环境）。
 * 设置 NO_COLOR 时关闭颜色。
 */
const enabled = !('NO_COLOR' in (process.env ?? {}))

function wrap(open: number, close: number): (text: string) => string {
  return text => enabled
    ? `\u001B[${open}m${text}\u001B[${close}m`
    : text
}

export const colors = {
  bold: wrap(1, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  gray: wrap(90, 39),
}
