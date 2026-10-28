import type { Middleware as H3Middleware } from 'h3'
import type { OpenAPISource } from './generate'
import type { OpenAPIConfig, OpenAPIDocument } from './types'
import { escapeHtml } from '../mail/layout'
import { generateOpenAPI } from './generate'

/** 文档页面从 jsDelivr 加载，版本固定 */
export const SCALAR_VERSION = '1.76.0'
export const SWAGGER_UI_VERSION = '5.34.0'

/** `config/openapi.ts` 的默认导出 */
export function defineOpenAPIConfig(config: OpenAPIConfig | (() => OpenAPIConfig)): OpenAPIConfig | (() => OpenAPIConfig) {
  return config
}

export interface ResolvedOpenAPIConfig extends OpenAPIConfig {
  enabled: boolean
  path: string
  docsPath: string | false
  ui: 'scalar' | 'swagger'
}

/** 填充默认值：生产环境默认关闭，JSON 位于 /openapi.json，页面位于 /docs */
export function resolveOpenAPIConfig(source: OpenAPISource): ResolvedOpenAPIConfig {
  const config = source.config?.get<OpenAPIConfig>('openapi', {}) ?? {}
  const mode = source.config?.get<string>('app.mode', 'development')
  return {
    ...config,
    enabled: config.enabled ?? mode !== 'production',
    path: config.path ?? '/openapi.json',
    docsPath: config.docsPath ?? '/docs',
    ui: config.ui ?? 'scalar',
  }
}

/** 文档页面 HTML（Scalar 或 Swagger UI） */
export function renderDocsPage(options: { url: string, title: string, ui?: 'scalar' | 'swagger', uiOptions?: Record<string, unknown> }): string {
  const title = escapeHtml(options.title)
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>`

  if (options.ui === 'swagger') {
    const base = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`
    return `${head}
<link rel="stylesheet" href="${base}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${base}/swagger-ui-bundle.js" crossorigin></script>
<script>window.ui = SwaggerUIBundle(${scriptJson({ url: options.url, dom_id: '#swagger-ui', ...options.uiOptions })})</script>
</body>
</html>
`
  }

  return `${head}
</head>
<body>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js" crossorigin></script>
<script>Scalar.createApiReference('#app', ${scriptJson({ url: options.url, ...options.uiOptions })})</script>
</body>
</html>
`
}

/** 嵌入 <script> 的 JSON：转义 `<`，避免 `</script>` 提前结束脚本 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * 提供 OpenAPI 文档（JSON）与文档页面的 h3 中间件；未启用时直接放行。
 * 文档在首个请求时生成并缓存，开发服务器热重载会创建新的应用，因此总是最新的。
 */
export function openAPIMiddleware(source: OpenAPISource): H3Middleware {
  const config = resolveOpenAPIConfig(source)
  if (!config.enabled) {
    return (_event, next) => next()
  }
  let document: Promise<OpenAPIDocument> | undefined

  return async (event, next) => {
    const method = event.req.method
    if (method !== 'GET' && method !== 'HEAD')
      return next()
    const pathname = event.url.pathname

    if (pathname === config.path) {
      document ??= generateOpenAPI(source).catch((error) => {
        // 失败时不缓存，下次请求重试
        document = undefined
        throw error
      })
      // 返回 Response，跳过统一响应格式
      return new Response(JSON.stringify(await document), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (config.docsPath && pathname === config.docsPath) {
      const html = renderDocsPage({
        url: config.path,
        title: config.info?.title ?? source.config?.get<string>('app.name', 'API') ?? 'API',
        ui: config.ui,
        uiOptions: config.uiOptions,
      })
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    return next()
  }
}
