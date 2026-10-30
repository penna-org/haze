<script setup lang="ts">
import type { RequestDetail, RequestSummary, Span } from '../../../src/data'
import { computed, ref, watch } from 'vue'
import { clock, json, ms, statusClass } from '../format'
import { useQuery } from '../rpc'

const filter = ref('')
const selectedId = ref<string>()
const selectedSpan = ref<Span>()

const { data: requests, error } = useQuery<RequestSummary[]>('requests', () => [
  { limit: 200 },
])
const { data: detail } = useQuery<RequestDetail | null>('request', () => [
  { requestId: selectedId.value ?? '' },
], { live: false })

const rows = computed(() => {
  const query = filter.value.trim().toLowerCase()
  const list = requests.value ?? []
  return query
    ? list.filter(row => `${row.method} ${row.path} ${row.route ?? ''} ${row.name ?? ''} ${row.module ?? ''} ${row.status}`.toLowerCase().includes(query))
    : list
})

// 默认选中最新的请求
watch(requests, (list) => {
  if (!selectedId.value && list?.length)
    selectedId.value = list[0]!.requestId
})
watch(selectedId, () => {
  selectedSpan.value = undefined
})

const TYPES = [
  'query',
  'cache',
  'event',
  'job',
  'mail',
  'ai',
  'http',
  'log',
  'exception',
] as const

const total = computed(() => {
  const request = detail.value?.request
  if (!request)
    return 1
  const end = Math.max(Number(request.content.duration ?? 0), ...(detail.value?.spans ?? []).map(span => span.start + span.duration))
  return Math.max(1, end)
})

function barStyle(span: Span): Record<string, string> {
  const left = Math.max(0, span.start) / total.value * 100
  const width = Math.max(span.duration / total.value * 100, 0.4)
  return { left: `${Math.min(left, 99.6)}%`, width: `${Math.min(width, 100 - left)}%` }
}

const repeated = computed(() => new Set(detail.value?.repeatedQueries.map(group => group.sql) ?? []))

const summary = computed(() => {
  const spans = detail.value?.spans ?? []
  const sum = (type: string): number => spans.filter(span => span.type === type).reduce((total, span) => total + span.duration, 0)
  return {
    queries: spans.filter(span => span.type === 'query').length,
    queryTime: sum('query'),
    cacheHits: spans.filter(span => span.type === 'cache' && span.content.hit === true).length,
    cacheMisses: spans.filter(span => span.type === 'cache' && span.content.hit === false).length,
    aiTime: sum('ai'),
  }
})
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <input v-model="filter" type="search" placeholder="Filter by path, route, module or status…" style="width: 280px">
      <span class="spacer" />
      <span class="muted">{{ requests?.length ?? 0 }} requests</span>
    </div>
    <div v-if="error" class="empty error">
      {{ error }}
    </div>
    <div v-else-if="requests && !requests.length" class="empty">
      No requests recorded yet. Requests show up here once the app handles them (the dev dashboard must be on, which is the default in development).
    </div>
    <div v-else class="split">
      <div class="list">
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Status</th>
              <th>Time</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id" class="clickable" :class="[{ selected: row.requestId === selectedId }]" @click="selectedId = row.requestId">
              <td style="max-width: 0; width: 60%">
                <div class="ellipsis">
                  <b class="mono">{{ row.method }}</b> <span class="mono">{{ row.path }}</span>
                </div>
                <div class="muted ellipsis" style="font-size: 11px">
                  {{ row.name || row.route || '' }}
                  <span v-if="row.module" class="badge info">{{ row.module }}</span>
                  <span v-if="row.app" class="badge">{{ row.app }}</span>
                </div>
              </td>
              <td><span class="badge" :class="[statusClass(row.status)]">{{ row.status }}</span></td>
              <td class="num">
                {{ ms(row.duration) }}<div class="faint" style="font-size: 11px">
                  {{ clock(row.time) }}
                </div>
              </td>
              <td class="num" style="font-size: 11px">
                <span v-if="row.counts.query" class="muted" title="queries">{{ row.counts.query }} SQL</span>
                <span v-if="row.repeatedQueries" class="badge warn" title="Repeated queries (likely N+1)">N+1</span>
                <span v-if="row.counts.exception" class="badge bad">error</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="detail">
        <template v-if="detail">
          <h2>
            <span class="mono">{{ detail.request.content.method }} {{ detail.request.content.path }}</span>
            <span class="badge" :class="[statusClass(Number(detail.request.content.status))]">{{ detail.request.content.status }}</span>
          </h2>
          <div class="kv">
            <span>Duration</span><span class="num">{{ ms(detail.request.content.duration) }}</span>
            <span>Route</span><span class="mono">{{ detail.request.content.route ?? '–' }}<span v-if="detail.request.content.name" class="muted"> ({{ detail.request.content.name }})</span></span>
            <span v-if="detail.request.content.module">Module</span><span v-if="detail.request.content.module">{{ detail.request.content.module }}</span>
            <span>Queries</span><span class="num">{{ summary.queries }} · {{ ms(summary.queryTime) }}</span>
            <span>Cache</span><span class="num">{{ summary.cacheHits }} hits · {{ summary.cacheMisses }} misses</span>
            <span>Request ID</span><span class="mono">{{ detail.request.requestId }}</span>
          </div>

          <div v-if="detail.repeatedQueries.length" class="section warning">
            <b>Repeated queries (possible N+1)</b>
            <div v-for="group in detail.repeatedQueries" :key="group.sql" class="repeat">
              <span class="badge warn">×{{ group.count }}</span>
              <span class="mono ellipsis">{{ group.sql }}</span>
              <span class="num muted">{{ ms(group.total) }}</span>
            </div>
          </div>

          <div class="section">
            <h2>Timeline</h2>
            <div class="legend">
              <span v-for="type in TYPES" :key="type"><i class="swatch" :class="[type]" /> {{ type }}</span>
            </div>
            <div class="waterfall">
              <div class="row request">
                <div class="label mono">
                  request
                </div>
                <div class="track">
                  <div class="bar request" :style="{ left: '0%', width: `${Number(detail.request.content.duration ?? 0) / total * 100}%` }" />
                </div>
                <div class="num time">
                  {{ ms(detail.request.content.duration) }}
                </div>
              </div>
              <div
                v-for="span in detail.spans"
                :key="span.id"
                class="row clickable" :class="[{ selected: selectedSpan?.id === span.id, failed: span.error }]"
                @click="selectedSpan = span"
              >
                <div class="label ellipsis" :title="span.label">
                  <span v-if="span.jobId" class="badge" title="Ran inside a queued job dispatched by this request">job</span>
                  <span v-if="span.type === 'query' && repeated.has(span.label)" class="badge warn">N+1</span>
                  <span :class="span.type === 'query' ? 'mono' : ''">{{ span.label }}</span>
                </div>
                <div class="track">
                  <div class="bar" :class="[span.type]" :style="barStyle(span)" />
                </div>
                <div class="num time">
                  {{ span.duration ? ms(span.duration) : '' }}
                </div>
              </div>
              <div v-if="!detail.spans.length" class="faint" style="padding: 8px 0">
                This request made no queries, cache calls, events, jobs or other recorded operations.
              </div>
            </div>
          </div>

          <div v-if="selectedSpan" class="section">
            <h2>{{ selectedSpan.type }} <span class="muted num">at +{{ ms(selectedSpan.start) }}</span></h2>
            <p v-if="selectedSpan.error" class="error">
              {{ selectedSpan.error }}
            </p>
            <pre>{{ json(selectedSpan.content) }}</pre>
          </div>
        </template>
        <div v-else class="empty">
          Select a request.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.waterfall {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: minmax(140px, 38%) 1fr 64px;
  gap: 8px;
  align-items: center;
  padding: 3px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.row:last-child {
  border-bottom: none;
}

.row.clickable {
  cursor: pointer;
}

.row.clickable:hover, .row.selected {
  background: var(--primary-soft);
}

.row.failed .label {
  color: var(--bad);
}

.row.request {
  background: var(--panel);
  font-weight: 600;
}

.track {
  position: relative;
  height: 12px;
  background: var(--sunken);
  border-radius: 3px;
}

.bar {
  position: absolute;
  top: 1px;
  bottom: 1px;
  min-width: 2px;
  border-radius: 2px;
  background: var(--faint);
}

.time {
  text-align: right;
  color: var(--muted);
}

.bar.request, .swatch.request { background: var(--primary); }
.bar.query, .swatch.query { background: var(--c-query); }
.bar.cache, .swatch.cache { background: var(--c-cache); }
.bar.event, .swatch.event { background: var(--c-event); }
.bar.job, .swatch.job { background: var(--c-job); }
.bar.mail, .swatch.mail { background: var(--c-mail); }
.bar.ai, .swatch.ai { background: var(--c-ai); }
.bar.http, .swatch.http { background: var(--c-http); }
.bar.log, .swatch.log { background: var(--c-log); }
.bar.exception, .swatch.exception { background: var(--bad); }

.legend {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 8px;
}

.swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  vertical-align: -1px;
}

.warning {
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
}

.repeat {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
  margin-top: 6px;
}
</style>
