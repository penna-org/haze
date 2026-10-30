<script setup lang="ts">
import type { JobIntrospection, ScheduleIntrospection } from '@hazejs/core'
import { reactive } from 'vue'
import { ago, clock, ms } from '../format'
import { call, useQuery } from '../rpc'

interface Tasks {
  schedules: Array<ScheduleIntrospection & { lastRun?: { status: string, reason?: string, duration: number, error?: string, time: number } }>
  jobs: Array<JobIntrospection & { stats: { ok: number, failed: number, dispatched: number } }>
  queues: Array<{ connection: string, counts?: Record<string, number>, error?: string }>
  dashboard?: string
}

interface RunResult {
  status: string
  reason?: string
  duration?: number
  error?: string
}

const { data, error, reload } = useQuery<Tasks>('tasks')
const runs = reactive<Record<string, RunResult | 'running'>>({})

async function run(name: string): Promise<void> {
  runs[name] = 'running'
  try {
    runs[name] = await call<RunResult>('run-schedule', { name })
  }
  catch (cause) {
    runs[name] = { status: 'failed', error: (cause as Error).message }
  }
  await reload()
}

function statusClass(status: string | undefined): string {
  return status === 'ok'
    ? 'ok'
    : status === 'failed'
      ? 'bad'
      : 'warn'
}
</script>

<template>
  <div class="page">
    <div class="scroll">
      <div v-if="error" class="empty error">
        {{ error }}
      </div>
      <template v-else-if="data">
        <div class="section">
          <h2>Scheduled tasks</h2>
          <div v-if="!data.schedules.length" class="faint">
            No scheduled tasks. Define them in <code>schedule/*.ts</code> with <code>defineSchedule()</code>.
          </div>
          <table v-else>
            <thead>
              <tr><th>Task</th><th>Schedule</th><th>Next run</th><th>Last run</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="task in data.schedules" :key="task.name">
                <td>
                  <b>{{ task.name }}</b>
                  <span v-if="task.module" class="badge info">{{ task.module }}</span>
                  <span v-if="task.withoutOverlapping" class="badge" title="withoutOverlapping()">no overlap</span>
                  <span v-if="task.onOneServer" class="badge" title="onOneServer()">one server</span>
                </td>
                <td class="mono">
                  {{ task.expression }}<span v-if="task.timezone" class="muted"> {{ task.timezone }}</span>
                </td>
                <td class="num" :title="task.nextRun">
                  {{ ago(task.nextRun) }}
                </td>
                <td>
                  <template v-if="task.lastRun">
                    <span class="badge" :class="[statusClass(task.lastRun.status)]" :title="task.lastRun.error">{{ task.lastRun.status }}{{ task.lastRun.reason ? ` (${task.lastRun.reason})` : '' }}</span>
                    <span class="num muted"> {{ ms(task.lastRun.duration) }} · {{ clock(task.lastRun.time) }}</span>
                  </template>
                  <span v-else class="faint">–</span>
                </td>
                <td style="text-align: right; white-space: nowrap">
                  <span v-if="runs[task.name] && runs[task.name] !== 'running'" class="badge" :class="[statusClass((runs[task.name] as RunResult).status)]" :title="(runs[task.name] as RunResult).error">
                    {{ (runs[task.name] as RunResult).status }}
                  </span>
                  <button :disabled="runs[task.name] === 'running'" @click="run(task.name)">
                    {{ runs[task.name] === 'running' ? 'Running…' : 'Run now' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="section">
          <h2>Queues</h2>
          <div class="cards">
            <div v-for="queue in data.queues" :key="queue.connection" class="card">
              <div class="label">
                {{ queue.connection }}
              </div>
              <div v-if="queue.error" class="error">
                {{ queue.error }}
              </div>
              <div v-else-if="queue.counts" class="counts">
                <span v-for="(count, name) in queue.counts" :key="name"><b class="num">{{ count }}</b> <span class="muted">{{ name }}</span></span>
              </div>
              <div v-else class="faint">
                no counts
              </div>
            </div>
          </div>
          <p v-if="data.dashboard" class="muted">
            Retry or delete failed jobs in the <a :href="`${data.dashboard}/queues`" target="_blank">queue dashboard</a>.
          </p>
        </div>

        <div class="section">
          <h2>Jobs</h2>
          <table>
            <thead>
              <tr><th>Job</th><th>Queue</th><th>Tries</th><th>Dispatched</th><th>Processed</th><th>Failed</th></tr>
            </thead>
            <tbody>
              <tr v-for="job in data.jobs" :key="job.name">
                <td>
                  <b>{{ job.name }}</b>
                  <span v-if="job.module" class="badge info">{{ job.module }}</span>
                </td>
                <td>{{ job.queue ?? 'default' }}<span v-if="job.connection" class="muted"> ({{ job.connection }})</span></td>
                <td class="num">
                  {{ job.tries ?? 1 }}
                </td>
                <td class="num">
                  {{ job.stats.dispatched || '' }}
                </td>
                <td class="num">
                  {{ job.stats.ok || '' }}
                </td>
                <td class="num">
                  <span v-if="job.stats.failed" class="badge bad">{{ job.stats.failed }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="faint">
            Counts cover what the dev dashboard recorded since the dev server started.
          </p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.counts {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}

button {
  margin-left: 6px;
}
</style>
