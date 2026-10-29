import Layout from './Layout'

export interface WelcomeProps {
  app: string
}

/** GET / 的欢迎页（服务端渲染的 TSX 视图，文本与属性值自动转义） */
export default function Welcome({ app }: WelcomeProps) {
  const links = [
    { href: '/api/hello', label: 'GET /api/hello' },
    { href: '/health', label: 'Health check' },
  ]
  return (
    <Layout title={app}>
      <h1>{app}</h1>
      <p>
        Your hazejs app is running. Edit
        {' '}
        <code>app/view/Welcome.tsx</code>
        {' '}
        to change this page.
      </p>
      <ul>
        {links.map(link => <li><a href={link.href}>{link.label}</a></li>)}
      </ul>
    </Layout>
  )
}
