<script setup lang="ts">
import type { Component } from 'vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import AiPage from './pages/AiPage.vue'
import GraphPage from './pages/GraphPage.vue'
import RequestsPage from './pages/RequestsPage.vue'
import TasksPage from './pages/TasksPage.vue'

// 每个面板是同一个 SPA 的一个 hash 路由（#/requests、#/ai …），默认为模块联动图
const pages: Record<string, Component> = {
  graph: GraphPage,
  requests: RequestsPage,
  ai: AiPage,
  tasks: TasksPage,
}

const hash = ref(location.hash)
function onHash(): void {
  hash.value = location.hash
}
window.addEventListener('hashchange', onHash)
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash))

const page = computed(() => pages[hash.value.replace(/^#\/?/, '').split('?')[0] || 'graph'] ?? GraphPage)
</script>

<template>
  <component :is="page" />
</template>
