<script setup lang="ts">
import { useChat } from '@hazejs/ai/vue'
import { csrfHeader } from '@/api'

// 流式对话：消息发往 server/route/api.ts 的 POST /api/chat（ChatController），回复逐字显示
const { messages, input, status, error, handleSubmit, stop } = useChat({
  api: '/api/chat',
  headers: () => csrfHeader('POST'),
})
</script>

<template>
  <section class="chat">
    <h2>AI 对话</h2>
    <ul class="messages">
      <li v-for="message in messages" :key="message.id" :class="message.role">
        <template v-for="(part, index) in message.parts" :key="index">
          <span v-if="part.type === 'text'">{{ part.text }}</span>
          <small v-else-if="part.type === 'tool'" class="tool">调用工具 {{ part.toolName }}…</small>
        </template>
      </li>
    </ul>
    <form class="form" @submit="handleSubmit">
      <input v-model="input" placeholder="问点什么（需在 .env 配置模型的 API Key）" aria-label="消息">
      <button v-if="status === 'streaming' || status === 'submitted'" type="button" @click="stop">
        停止
      </button>
      <button v-else type="submit">
        发送
      </button>
    </form>
    <p v-if="error" class="error">
      {{ error.message }}
    </p>
  </section>
</template>

<style scoped>
.chat {
  margin-top: 40px;
}
.messages {
  list-style: none;
  padding: 0;
}
.messages li {
  margin: 8px 0;
  white-space: pre-wrap;
}
.messages .user {
  font-weight: 600;
}
.tool {
  color: #888;
}
.form {
  display: flex;
  gap: 8px;
}
.form input {
  flex: 1;
  padding: 6px 10px;
}
.error {
  color: #c0392b;
}
</style>
