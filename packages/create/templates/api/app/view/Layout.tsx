import type { ViewChild } from '@hazejs/core'

export interface LayoutProps {
  title: string
  children?: ViewChild
}

const style = `
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC',sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:Canvas;color:CanvasText}
main{max-width:560px;line-height:1.6}
a{color:#2563eb}
code{padding:2px 6px;border-radius:4px;background:color-mix(in srgb,CanvasText 8%,transparent)}
`

/** 布局就是组件：<Layout title="..."><Page /></Layout> */
export default function Layout({ title, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: style }} />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
