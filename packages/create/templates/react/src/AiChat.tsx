import { useChat } from '@hazejs/ai/react'
import { csrfHeader } from '@/api'

/** 流式对话：消息发往 server/route/api.ts 的 POST /api/chat（ChatController），回复逐字显示 */
export function AiChat() {
  const { messages, input, setInput, status, error, handleSubmit, stop } = useChat({
    api: '/api/chat',
    headers: () => csrfHeader('POST'),
  })
  const busy = status === 'streaming' || status === 'submitted'

  return (
    <section className="chat">
      <h2>AI 对话</h2>
      <ul className="messages">
        {messages.map(message => (
          <li key={message.id} className={message.role}>
            {message.parts.map((part, index) => part.type === 'text'
              ? <span key={index}>{part.text}</span>
              : part.type === 'tool'
                ? (
                    <small key={index} className="tool">
                      调用工具
                      {' '}
                      {part.toolName}
                      …
                    </small>
                  )
                : null)}
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={handleSubmit}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="问点什么（需在 .env 配置模型的 API Key）" aria-label="消息" />
        {busy
          ? <button type="button" onClick={stop}>停止</button>
          : <button type="submit">发送</button>}
      </form>
      {error && <p className="error">{error.message}</p>}
    </section>
  )
}
