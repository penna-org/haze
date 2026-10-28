export interface GraphiQLOptions {
  /** 页面标题，默认 GraphiQL */
  title?: string
  /** 编辑器中的默认查询 */
  defaultQuery?: string
  /** 请求附带的默认请求头（JSON 文本，显示在 Headers 面板） */
  defaultHeaders?: string
}

/**
 * GraphiQL 5 从 CDN（esm.sh）加载，版本固定并带 SRI 校验（与 GraphiQL 官方 CDN 示例一致）。
 * 升级时同步修改版本号与 integrity。
 */
export const GRAPHIQL_VERSIONS = {
  'graphiql': '5.4.0',
  '@graphiql/react': '0.39.1',
  '@graphiql/toolkit': '0.12.1',
  'graphql': '17.0.2',
  'graphql-ws': '6.4.1',
  'react': '19.3.1',
} as const

const v = GRAPHIQL_VERSIONS
const cdn = 'https://esm.sh'

const integrity: Record<string, string> = {
  [`${cdn}/react@${v.react}`]: 'sha384-ut1U+oIs0ClaOE7uF1+DZAaHVvYvEJZME3mUuqn95yVqQ70a+8u2LN2LD37JgJkO',
  [`${cdn}/react-dom@${v.react}`]: 'sha384-FKbbSw/nINZRM0ej/iwjfXbJeAZMJdBKqKmn/I+aIM4Io5qupmM8sZJxaJZDO0sv',
  [`${cdn}/graphiql@${v.graphiql}`]: 'sha384-moUMjxK/ZmHQE08otOtzYT/Zke32MqPb9l0uUXUdsf8aXl53LPYBciaAf9ON2nuR',
  [`${cdn}/graphiql@${v.graphiql}?standalone&external=react,react-dom,@graphiql/react,graphql`]: 'sha384-P5rs3WtMR+YUHbk+eUuomiB3Grin+04e9jKjuOY5KMBdjnl/qOUaCALfnVqVpIL8',
  [`${cdn}/@graphiql/react@${v['@graphiql/react']}?standalone&external=react,react-dom,graphql,@graphiql/toolkit,@emotion/is-prop-valid`]: 'sha384-O2Ppg9pxo2BB+gS3tMDALOpNCDvNyQH3+YJQnV1GvKV7yX53RHH6O5ltuLv2/Zn2',
  [`${cdn}/@graphiql/toolkit@${v['@graphiql/toolkit']}?standalone&external=graphql`]: 'sha384-+cNTwZgIW33q7A4E+ZoCMqzcXdfVIc2VthQvJ0uDpRXERBWYuDKPVMzvdQU8x48o',
  [`${cdn}/graphql@${v.graphql}`]: 'sha384-IPvlcmnvWT91sKqwbg9MxPXJUuPmSdwXCp22x6hcbBkAEhlfSKkMLR3v19K9iRUp',
}

/** 嵌入 <script> 的 JSON：转义 `<` 防止提前闭合标签 */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

/** GraphiQL 页面；subscriptions 为 true 时经 graphql-ws 客户端连接同一路径的 WebSocket */
export function renderGraphiQL(options: GraphiQLOptions & { endpoint: string, subscriptions?: boolean }): string {
  const imports: Record<string, string> = {
    'react': `${cdn}/react@${v.react}`,
    'react/': `${cdn}/react@${v.react}/`,
    'react-dom': `${cdn}/react-dom@${v.react}`,
    'react-dom/': `${cdn}/react-dom@${v.react}/`,
    'graphiql': `${cdn}/graphiql@${v.graphiql}?standalone&external=react,react-dom,@graphiql/react,graphql`,
    'graphiql/': `${cdn}/graphiql@${v.graphiql}/`,
    '@graphiql/react': `${cdn}/@graphiql/react@${v['@graphiql/react']}?standalone&external=react,react-dom,graphql,@graphiql/toolkit,@emotion/is-prop-valid`,
    '@graphiql/toolkit': `${cdn}/@graphiql/toolkit@${v['@graphiql/toolkit']}?standalone&external=graphql`,
    'graphql': `${cdn}/graphql@${v.graphql}`,
    '@emotion/is-prop-valid': 'data:text/javascript,',
    ...(options.subscriptions && { 'graphql-ws': `${cdn}/graphql-ws@${v['graphql-ws']}?external=graphql` }),
  }
  const config = {
    endpoint: options.endpoint,
    subscriptions: Boolean(options.subscriptions),
    defaultQuery: options.defaultQuery,
    defaultHeaders: options.defaultHeaders,
  }
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(options.title ?? 'GraphiQL')}</title>
    <style>
      body { margin: 0; }
      #graphiql { height: 100dvh; }
      .loading { height: 100%; display: flex; align-items: center; justify-content: center; font: 1.5rem system-ui, sans-serif; }
    </style>
    <link rel="stylesheet" href="${cdn}/graphiql@${v.graphiql}/dist/style.css" integrity="sha384-TFpQQKp325U5sd3PddH4cS0KOB3Gz/aqdEe12Mqkkq3wm2MGcDhRX5WhWf+o8akh" crossorigin="anonymous" />
    <script type="importmap">${json({ imports, integrity })}</script>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import { GraphiQL, HISTORY_PLUGIN } from 'graphiql';
      import { createGraphiQLFetcher } from '@graphiql/toolkit';
      import 'graphiql/setup-workers/esm.sh';

      const config = ${json(config)};
      const url = new URL(config.endpoint, location.href);
      const options = { url: url.href };
      if (config.subscriptions) {
        const { createClient } = await import('graphql-ws');
        const ws = new URL(url);
        ws.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        options.wsClient = createClient({ url: ws.href });
      }
      const fetcher = createGraphiQLFetcher(options);
      const props = { fetcher, plugins: [HISTORY_PLUGIN], defaultEditorToolsVisibility: true };
      if (config.defaultQuery) props.defaultQuery = config.defaultQuery;
      if (config.defaultHeaders) props.defaultHeaders = config.defaultHeaders;
      ReactDOM.createRoot(document.getElementById('graphiql')).render(React.createElement(GraphiQL, props));
    </script>
  </head>
  <body>
    <div id="graphiql"><div class="loading">Loading…</div></div>
  </body>
</html>
`
}
