<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/api'
import { chat } from '@/socket'

const title = import.meta.env.VITE_APP_TITLE
const hello = ref('')
const name = ref('')
const reply = ref('')
const error = ref('')
const online = ref(0)

onMounted(async () => {
  chat.on('online', (count: number) => (online.value = count))
  chat.connect()
  hello.value = (await api<{ message: string }>('/api/hello')).message
})

onUnmounted(() => {
  chat.off('online')
  chat.disconnect()
})

async function greet() {
  error.value = ''
  try {
    const data = await api<{ message: string }>('/api/hello', {
      method: 'POST',
      body: JSON.stringify({ name: name.value }),
    })
    reply.value = data.message
  }
  catch (e) {
    reply.value = ''
    error.value = (e as Error).message
  }
}
</script>

<template>
  <main class="page">
    <h1>{{ title }}</h1>
    <p class="hello">
      {{ hello || '加载中…' }}
    </p>
    <p class="online">
      在线 {{ online }} 人（Socket.IO）
    </p>

    <form class="form" @submit.prevent="greet">
      <input v-model="name" placeholder="输入名字" aria-label="名字">
      <button type="submit">
        打招呼
      </button>
    </form>
    <p v-if="reply" class="reply">
      {{ reply }}
    </p>
    <p v-if="error" class="error">
      {{ error }}
    </p>

    <p class="tip">
      修改 <code>server/app/service/GreetingService.ts</code>，刷新页面即可看到后端变化，无需重启。
    </p>
  </main>
</template>

<style scoped>
.page {
  max-width: 560px;
  margin: 64px auto;
  padding: 0 16px;
  font-family: system-ui, sans-serif;
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
.tip {
  margin-top: 32px;
  color: #666;
  font-size: 14px;
}
</style>
