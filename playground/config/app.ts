// 读取环境变量时使用函数形式，确保在 .env 加载之后求值。
// app.debug 默认仅在开发环境开启（错误页、堆栈）；如需强制开启，可在此设置 debug: env('APP_DEBUG', false)
export default defineConfig(() => ({
  name: env('APP_NAME', 'hazejs'),
}))
