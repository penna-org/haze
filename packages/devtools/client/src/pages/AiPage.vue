<script setup lang="ts">
import type { DashboardEntry } from '@hazejs/core'
import type { AiSummary } from '../../../src/data'
import { computed, reactive, ref, watch } from 'vue'
import { clock, json, ms, tokens } from '../format'
import { call, useQuery } from '../rpc'

interface Models {
  available: boolean
  configured: boolean
  default?: string
  aliases: string[]
  providers: string[]
}

interface RunResult {
  text?: string
  usage?: { inputTokens?: number, outputTokens?: number }
  finishReason?: string
  duration?: number
  error?: string
}

const { data, error } = useQuery<AiSummary>('ai')
const { data: models } = useQuery<Models>('ai-models', () => [], { live: false })

const selected = ref<DashboardEntry>()
const calls = computed(() => [
  ...(data.value?.entries ?? []),
].reverse())
watch(calls, (list) => {
  if (!selected.value && list.length)
    selected.value = list[0]
})

const content = computed(() => selected.value?.content as {
  messages?: Array<{ role: string, content: string }>
  tools?: string[]
  output?: string
  toolCalls?: Array<{ name: string, input: unknown }>
  [key: string]: unknown
} | undefined)

// ---------- Playground ----------
const form = reactive({ model: '', system: '', prompt: '' })
const running = ref(false)
const result = ref<RunResult>()
watch(models, (value) => {
  if (value?.default && !form.model)
    form.model = value.default
})

async function run(): Promise<void> {
  if (!form.prompt.trim())
    return
  running.value = true
  result.value = undefined
  try {
    result.value = await call<RunResult>('ai-run', { ...form })
  }
  catch (cause) {
    result.value = { error: (cause as Error).message }
  }
  finally {
    running.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="scroll">
      <div v-if="error" class="empty error">
        {{ error }}
      </div>
      <template v-else-if="data">
        <div class="cards">
          <div class="card">
            <div class="value">
              {{ data.calls }}
            </div><div class="label">
              calls
            </div>
          </div>
          <div class="card">
            <div class="value">
              {{ tokens(data.inputTokens) }}
            </div><div class="label">
              input tokens
            </div>
          </div>
          <div class="card">
            <div class="value">
              {{ tokens(data.outputTokens) }}
            </div><div class="label">
              output tokens
            </div>
          </div>
          <div class="card">
            <div class="value" :class="[{ error: data.errors }]">
              {{ data.errors }}
            </div><div class="label">
              errors
            </div>
          </div>
        </div>

        <div v-if="data.models.length" class="section">
          <h2>By model</h2>
          <table>
            <thead>
              <tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Avg latency</th><th>Errors</th></tr>
            </thead>
            <tbody>
              <tr v-for="stats in data.models" :key="`${stats.provider}/${stats.model}`">
                <td><b>{{ stats.model }}</b> <span class="muted">{{ stats.provider }}</span></td>
                <td class="num">
                  {{ stats.calls }}
                </td>
                <td class="num">
                  {{ tokens(stats.inputTokens) }}
                </td>
                <td class="num">
                  {{ tokens(stats.outputTokens) }}
                </td>
                <td class="num">
                  {{ ms(stats.totalDuration / stats.calls) }}
                </td>
                <td class="num">
                  {{ stats.errors || '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="section calls">
          <div class="list">
            <h2>Recent calls</h2>
            <div v-if="!calls.length" class="faint">
              No AI calls recorded yet. Calls made through @hazejs/ai show up here, with their prompts while the dev dashboard is on.
            </div>
            <table v-else>
              <tbody>
                <tr v-for="entry in calls" :key="entry.id" class="clickable" :class="[{ selected: selected?.id === entry.id }]" @click="selected = entry">
                  <td>
                    <b>{{ entry.content.model }}</b>
                    <span class="badge">{{ entry.content.operation }}</span>
                    <span v-if="entry.content.error" class="badge bad">error</span>
                    <div class="faint" style="font-size: 11px">
                      {{ clock(entry.time) }}
                    </div>
                  </td>
                  <td class="num muted">
                    {{ entry.content.inputTokens ?? '–' }} → {{ entry.content.outputTokens ?? '–' }}
                  </td>
                  <td class="num">
                    {{ ms(entry.content.duration) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="selected && content" class="call">
            <h2>{{ content.provider }}/{{ content.model }} <span class="muted num">{{ ms(content.duration) }}</span></h2>
            <p v-if="content.error" class="error">
              {{ content.error }}
            </p>
            <div class="kv">
              <span>Finish reason</span><span>{{ content.finishReason ?? '–' }}</span>
              <span>Tokens</span><span class="num">{{ content.inputTokens ?? '–' }} in · {{ content.outputTokens ?? '–' }} out</span>
              <span v-if="content.tools?.length">Tools</span><span v-if="content.tools?.length">{{ content.tools.join(', ') }}</span>
              <span v-if="selected.requestId">Request</span><a v-if="selected.requestId" class="mono" href="#/requests">{{ selected.requestId }}</a>
            </div>
            <template v-if="content.messages">
              <div v-for="(message, index) in content.messages" :key="index" class="message" :class="[message.role]">
                <div class="role">
                  {{ message.role }}
                </div>
                <pre>{{ message.content }}</pre>
              </div>
              <div class="message assistant output">
                <div class="role">
                  output
                </div>
                <pre v-if="content.output">{{ content.output }}</pre>
                <div v-for="(tool, index) in content.toolCalls ?? []" :key="index" class="tool">
                  <span class="badge primary">→ {{ tool.name }}</span>
                  <pre>{{ json(tool.input) }}</pre>
                </div>
              </div>
            </template>
            <p v-else class="faint">
              Prompts and outputs are recorded only while the dev dashboard is on.
            </p>
          </div>
        </div>
      </template>

      <div class="section playground">
        <h2>Playground</h2>
        <p v-if="models && !models.available" class="muted">
          Install <code>@hazejs/ai</code> to try models here.
        </p>
        <template v-else>
          <div class="form">
            <label>Model
              <input v-model="form.model" list="hazejs-models" :placeholder="models?.default ?? 'provider:model or alias'">
              <datalist id="hazejs-models">
                <option v-for="alias in models?.aliases ?? []" :key="alias" :value="alias" />
              </datalist>
            </label>
            <label>System
              <input v-model="form.system" placeholder="Optional system prompt">
            </label>
            <label>Prompt
              <textarea v-model="form.prompt" rows="4" placeholder="Ask something…" @keydown.meta.enter="run" @keydown.ctrl.enter="run" />
            </label>
            <div>
              <button class="primary" :disabled="running || !form.prompt.trim()" @click="run">
                {{ running ? 'Running…' : 'Run' }}
              </button>
              <span class="faint"> ⌘/Ctrl + Enter · providers: {{ models?.providers.join(', ') || 'none configured' }}</span>
            </div>
          </div>
          <div v-if="result" class="result">
            <p v-if="result.error" class="error">
              {{ result.error }}
            </p>
            <template v-else>
              <pre>{{ result.text }}</pre>
              <p class="muted num">
                {{ result.usage?.inputTokens ?? '–' }} → {{ result.usage?.outputTokens ?? '–' }} tokens · {{ ms(result.duration) }} · {{ result.finishReason }}
              </p>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calls {
  display: grid;
  grid-template-columns: minmax(260px, 40%) 1fr;
  gap: 16px;
}

.call {
  min-width: 0;
}

.message {
  margin-bottom: 8px;
}

.role {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--muted);
  margin-bottom: 2px;
}

.message.system pre { border-left: 3px solid var(--faint); }
.message.user pre { border-left: 3px solid var(--info); }
.message.assistant pre { border-left: 3px solid var(--primary); }
.message.tool pre { border-left: 3px solid var(--c-job); }

.tool {
  margin-top: 6px;
}

.playground {
  border-top: 1px solid var(--border);
  padding-top: 14px;
}

.form {
  display: grid;
  gap: 8px;
  max-width: 720px;
}

.form label {
  display: grid;
  gap: 3px;
  color: var(--muted);
  font-size: 12px;
}

.form textarea, .form input {
  color: var(--text);
  font-size: 13px;
}

.result {
  margin-top: 12px;
  max-width: 720px;
}
</style>
