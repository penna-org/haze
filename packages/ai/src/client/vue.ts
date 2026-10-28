/**
 * @hazejs/ai/vue：Vue 3 的 useChat。
 *
 * ```vue
 * <script setup lang="ts">
 * import { useChat } from '@hazejs/ai/vue'
 *
 * const { messages, input, status, handleSubmit, stop } = useChat({ api: '/api/chat' })
 * </script>
 *
 * <template>
 *   <div v-for="message in messages" :key="message.id">
 *     <template v-for="(part, i) in message.parts" :key="i">
 *       <p v-if="part.type === 'text'">{{ part.text }}</p>
 *     </template>
 *   </div>
 *   <form @submit="handleSubmit">
 *     <input v-model="input">
 *     <button v-if="status === 'streaming'" type="button" @click="stop">停止</button>
 *   </form>
 * </template>
 * ```
 */
import type { Ref, ShallowRef } from 'vue'
import type { Chat, ChatMessage, ChatOptions, ChatRequestOptions, ChatStatus } from './index'
import { getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import { createChat } from './index'

export type { ChatFilePart, ChatMessage, ChatOptions, ChatPart, ChatReasoningPart, ChatRequestOptions, ChatStatus, ChatTextPart, ChatToolPart, ChatToolState } from './index'

export interface UseChatReturn {
  /** 底层的状态容器 */
  chat: Chat
  /** 只读快照；修改请用 setMessages */
  messages: Readonly<ShallowRef<ChatMessage[]>>
  status: Readonly<ShallowRef<ChatStatus>>
  error: Readonly<ShallowRef<Error | undefined>>
  /** 输入框内容（v-model） */
  input: Ref<string>
  sendMessage: Chat['sendMessage']
  regenerate: Chat['regenerate']
  stop: Chat['stop']
  setMessages: Chat['setMessages']
  addToolResult: Chat['addToolResult']
  clearError: Chat['clearError']
  /** 表单提交：发送 input 的内容并清空（阻止默认提交） */
  handleSubmit: (event?: { preventDefault?: () => void }, options?: ChatRequestOptions) => Promise<void>
}

/** 包装 createChat，状态以 shallowRef 暴露；在组件（或 effectScope）销毁时取消订阅并中止请求 */
export function useChat(options: ChatOptions = {}): UseChatReturn {
  const chat = createChat(options)
  const messages = shallowRef(chat.messages)
  const status = shallowRef(chat.status)
  const error = shallowRef(chat.error)
  const input = ref('')

  const unsubscribe = chat.subscribe(() => {
    messages.value = chat.messages
    status.value = chat.status
    error.value = chat.error
  })
  if (getCurrentScope()) {
    onScopeDispose(() => {
      unsubscribe()
      chat.stop()
    })
  }

  return {
    chat,
    messages,
    status,
    error,
    input,
    sendMessage: chat.sendMessage,
    regenerate: chat.regenerate,
    stop: chat.stop,
    setMessages: chat.setMessages,
    addToolResult: chat.addToolResult,
    clearError: chat.clearError,
    async handleSubmit(event, requestOptions) {
      event?.preventDefault?.()
      const text = input.value.trim()
      if (!text)
        return
      input.value = ''
      await chat.sendMessage(text, requestOptions)
    },
  }
}
