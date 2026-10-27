import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { api } from '@/api'
import './App.css'

const title = import.meta.env.VITE_APP_TITLE

export function App() {
  const [hello, setHello] = useState('')
  const [name, setName] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    api<{ message: string }>('/api/hello').then(data => setHello(data.message))
  }, [])

  async function greet(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const data = await api<{ message: string }>('/api/hello', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setReply(data.message)
    }
    catch (e) {
      setReply('')
      setError((e as Error).message)
    }
  }

  return (
    <main className="page">
      <h1>{title}</h1>
      <p className="hello">{hello || '加载中…'}</p>

      <form className="form" onSubmit={greet}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="输入名字" aria-label="名字" />
        <button type="submit">打招呼</button>
      </form>
      {reply && <p className="reply">{reply}</p>}
      {error && <p className="error">{error}</p>}

      <p className="tip">
        修改
        {' '}
        <code>server/app/service/GreetingService.ts</code>
        ，刷新页面即可看到后端变化，无需重启。
      </p>
    </main>
  )
}
