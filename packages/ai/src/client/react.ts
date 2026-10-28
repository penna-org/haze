/**
 * @hazejs/ai/react：React 19 的 useChat。
 *
 * ```tsx
 * import { useChat } from '@hazejs/ai/react'
 *
 * export function ChatBox() {
 *   const { messages, input, setInput, status, handleSubmit, stop } = useChat({ api: '/api/chat' })
 *   return (
 *     <form onSubmit={handleSubmit}>
 *       {messages.map(m => <p key={m.id}>{m.parts.map(p => p.type === 'text' ? p.text : '').join('')}</p>)}
 *       <input value={input} onChange={e => setInput(e.target.value)} />
 *       {status === 'streaming' && <button type="button" onClick={stop}>停止</button>}
 *     </form>
 *   )
 * }
 * ```
 */
import type { Chat, ChatMessage, ChatOptions, ChatRequestOptions, ChatStatus } from './index'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createChat } from './index'

export type { ChatFilePart, ChatMessage, ChatOptions, ChatPart, ChatReasoningPart, ChatRequestOptions, ChatStatus, ChatTextPart, ChatToolPart, ChatToolState } from './index'

export interface UseChatReturn {
  /** 底层的状态容器（组件生命周期内不变） */
  chat: Chat
  messages: ChatMessage[]
  status: ChatStatus
  error: Error | undefined
  input: string
  setInput: (value: string) => void
  sendMessage: Chat['sendMessage']
  regenerate: Chat['regenerate']
  stop: Chat['stop']
  setMessages: Chat['setMessages']
  addToolResult: Chat['addToolResult']
  clearError: Chat['clearError']
  /** 表单提交：发送 input 的内容并清空（阻止默认提交） */
  handleSubmit: (event?: { preventDefault?: () => void }, options?: ChatRequestOptions) => Promise<void>
}

/**
 * 每个组件持有一个稳定的 createChat 实例（useRef），状态通过 useSyncExternalStore 订阅。
 * `api`、`fetch`、`initialMessages` 等只在首次渲染时读取；`headers`、`body` 与回调总是使用最新一次渲染传入的值。
 */
export function useChat(options: ChatOptions = {}): UseChatReturn {
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const chatRef = useRef<Chat | null>(null)
  if (!chatRef.current) {
    chatRef.current = createChat({
      ...options,
      headers: () => typeof optionsRef.current.headers === 'function'
        ? optionsRef.current.headers()
        : optionsRef.current.headers ?? {},
      body: () => typeof optionsRef.current.body === 'function'
        ? optionsRef.current.body()
        : optionsRef.current.body ?? {},
      onEvent: event => optionsRef.current.onEvent?.(event),
      onFinish: (message, info) => optionsRef.current.onFinish?.(message, info),
      onError: error => optionsRef.current.onError?.(error),
    })
  }
  const chat = chatRef.current

  // 状态快照每次变化都是新对象，未变化时保持同一引用
  const state = useSyncExternalStore(chat.subscribe, () => chat.state, () => chat.state)
  const [input, setInput] = useState('')

  // 卸载时中止进行中的请求
  useEffect(() => () => chat.stop(), [chat])

  const handleSubmit = useCallback(async (event?: { preventDefault?: () => void }, requestOptions?: ChatRequestOptions) => {
    event?.preventDefault?.()
    const text = input.trim()
    if (!text)
      return
    setInput('')
    await chat.sendMessage(text, requestOptions)
  }, [chat, input])

  return {
    chat,
    messages: state.messages,
    status: state.status,
    error: state.error,
    input,
    setInput,
    sendMessage: chat.sendMessage,
    regenerate: chat.regenerate,
    stop: chat.stop,
    setMessages: chat.setMessages,
    addToolResult: chat.addToolResult,
    clearError: chat.clearError,
    handleSubmit,
  }
}
