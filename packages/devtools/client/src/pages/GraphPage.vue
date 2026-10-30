<script setup lang="ts">
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeType, ModuleGraph } from '../../../src/data'
import type { Point } from '../layout'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { json } from '../format'
import { forceLayout } from '../layout'
import { useQuery } from '../rpc'

const { data, error } = useQuery<ModuleGraph>('graph')

const show = reactive({
  event: true,
  job: true,
  declared: true,
  runtime: true,
})
const search = ref('')
const selected = ref<string>()
const hovered = ref<string>()

const TYPE_LABEL: Record<GraphNodeType, string> = {
  app: 'Project',
  module: 'Module',
  subapp: 'Sub-app',
  event: 'Event',
  job: 'Job',
}
const EDGE_LABEL: Record<GraphEdgeKind, string> = {
  owns: 'defines',
  listens: 'listened by',
  middleware: 'uses middleware of',
  mounted: 'mounted into',
  schedules: 'schedules',
  emits: 'emitted',
  dispatches: 'dispatched',
}

const visible = computed(() => {
  const graph = data.value ?? { nodes: [], edges: [] }
  const nodes = graph.nodes.filter(node => (node.type !== 'event' || show.event) && (node.type !== 'job' || show.job))
  const ids = new Set(nodes.map(node => node.id))
  const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && (edge.runtime ? show.runtime : show.declared))
  return { nodes, edges }
})

// 布局：数据变化时重新计算，已有节点从原位置继续
const positions = shallowRef(new Map<string, Point>())
const pinned = new Set<string>()
watch(visible, ({ nodes, edges }) => {
  positions.value = forceLayout(nodes.map(node => node.id), edges, { previous: positions.value, pinned })
}, { immediate: true })

const neighbors = computed(() => {
  const focus = hovered.value ?? selected.value
  if (!focus)
    return undefined
  const set = new Set([focus])
  for (const edge of visible.value.edges) {
    if (edge.from === focus)
      set.add(edge.to)
    if (edge.to === focus)
      set.add(edge.from)
  }
  return set
})

const matches = computed(() => {
  const query = search.value.trim().toLowerCase()
  return query
    ? new Set(visible.value.nodes.filter(node => node.label.toLowerCase().includes(query)).map(node => node.id))
    : undefined
})

function dimmed(id: string): boolean {
  if (matches.value)
    return !matches.value.has(id)
  return neighbors.value
    ? !neighbors.value.has(id)
    : false
}

function edgeDimmed(edge: GraphEdge): boolean {
  const focus = hovered.value ?? selected.value
  return focus
    ? edge.from !== focus && edge.to !== focus
    : false
}

// ---------- 视图：平移与缩放 ----------
const view = reactive({ x: 0, y: 0, k: 1 })
const svg = ref<SVGSVGElement>()
const size = reactive({ width: 800, height: 600 })
const resize = new ResizeObserver(([entry]) => {
  if (entry) {
    size.width = entry.contentRect.width
    size.height = entry.contentRect.height
  }
})
watch(svg, (element, previous) => {
  if (previous)
    resize.unobserve(previous)
  if (element)
    resize.observe(element)
})

function fit(): void {
  const points = [
    ...positions.value.values(),
  ]
  if (!points.length)
    return
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const width = Math.max(...xs) - Math.min(...xs) + 160
  const height = Math.max(...ys) - Math.min(...ys) + 120
  view.k = Math.min(2, Math.max(0.2, Math.min(size.width / width, size.height / height)))
  view.x = size.width / 2 - (Math.min(...xs) + Math.max(...xs)) / 2 * view.k
  view.y = size.height / 2 - (Math.min(...ys) + Math.max(...ys)) / 2 * view.k
}
// 用户平移 / 缩放之前，布局或面板尺寸变化时自动适配
let adjusted = false
watch([
  positions,
  () => size.width,
  () => size.height,
], () => {
  if (!adjusted && positions.value.size && size.width > 0)
    fit()
})

function onWheel(event: WheelEvent): void {
  const rect = svg.value!.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top
  adjusted = true
  const k = Math.min(4, Math.max(0.15, view.k * Math.exp(-event.deltaY * 0.0015)))
  view.x = px - (px - view.x) * (k / view.k)
  view.y = py - (py - view.y) * (k / view.k)
  view.k = k
}

let drag: { node?: string, x: number, y: number, moved: boolean } | undefined
function onPointerDown(event: PointerEvent, node?: string): void {
  drag = {
    node,
    x: event.clientX,
    y: event.clientY,
    moved: false,
  }
  ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
  event.stopPropagation()
}
function onPointerMove(event: PointerEvent): void {
  if (!drag)
    return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 2)
    drag.moved = true
  drag.x = event.clientX
  drag.y = event.clientY
  if (drag.node) {
    const point = positions.value.get(drag.node)
    if (point) {
      point.x += dx / view.k
      point.y += dy / view.k
      pinned.add(drag.node)
      positions.value = new Map(positions.value)
    }
  }
  else {
    adjusted = true
    view.x += dx
    view.y += dy
  }
}
function onPointerUp(): void {
  if (drag && !drag.moved)
    selected.value = drag.node
  drag = undefined
}

// ---------- 绘制 ----------
const nodeById = computed(() => new Map((data.value?.nodes ?? []).map(node => [node.id, node])))
const RADIUS: Record<GraphNodeType, number> = {
  app: 26,
  module: 22,
  subapp: 20,
  event: 11,
  job: 11,
}

function edgePath(edge: GraphEdge): string {
  const a = positions.value.get(edge.from)
  const b = positions.value.get(edge.to)
  if (!a || !b)
    return ''
  const from = nodeById.value.get(edge.from)!
  const to = nodeById.value.get(edge.to)!
  const dx = b.x - a.x
  const dy = b.y - a.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const start = { x: a.x + dx / distance * RADIUS[from.type], y: a.y + dy / distance * RADIUS[from.type] }
  const end = { x: b.x - dx / distance * (RADIUS[to.type] + 4), y: b.y - dy / distance * (RADIUS[to.type] + 4) }
  // 运行时的连线略带弧度，与声明的连线区分开
  if (edge.runtime) {
    const mx = (start.x + end.x) / 2 - dy / distance * 18
    const my = (start.y + end.y) / 2 + dx / distance * 18
    return `M${start.x},${start.y} Q${mx},${my} ${end.x},${end.y}`
  }
  return `M${start.x},${start.y} L${end.x},${end.y}`
}

function edgeLabelPosition(edge: GraphEdge): Point {
  const a = positions.value.get(edge.from) ?? { x: 0, y: 0 }
  const b = positions.value.get(edge.to) ?? { x: 0, y: 0 }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - (edge.runtime ? 10 : 0) }
}

function diamond(r: number): string {
  return `0,${-r} ${r},0 0,${r} ${-r},0`
}

const selectedNode = computed<GraphNode | undefined>(() => selected.value
  ? nodeById.value.get(selected.value)
  : undefined)
const selectedEdges = computed(() => {
  const id = selected.value
  if (!id)
    return { incoming: [], outgoing: [] }
  const edges = data.value?.edges ?? []
  return {
    outgoing: edges.filter(edge => edge.from === id),
    incoming: edges.filter(edge => edge.to === id),
  }
})

const counts = computed(() => {
  const graph = data.value ?? { nodes: [], edges: [] }
  return {
    modules: graph.nodes.filter(node => node.type === 'module').length,
    events: graph.nodes.filter(node => node.type === 'event').length,
    jobs: graph.nodes.filter(node => node.type === 'job').length,
    runtime: graph.edges.filter(edge => edge.runtime).length,
  }
})

function label(id: string): string {
  return nodeById.value.get(id)?.label ?? id
}
</script>

<template>
  <div class="page graph-page">
    <div class="toolbar">
      <input v-model="search" type="search" placeholder="Find a module, event or job…" style="width: 220px">
      <label><input v-model="show.event" type="checkbox"> Events</label>
      <label><input v-model="show.job" type="checkbox"> Jobs</label>
      <label><input v-model="show.declared" type="checkbox"> Declared</label>
      <label><input v-model="show.runtime" type="checkbox"> Runtime</label>
      <span class="spacer" />
      <span class="muted">{{ counts.modules }} modules · {{ counts.events }} events · {{ counts.jobs }} jobs · {{ counts.runtime }} runtime links</span>
      <button @click="adjusted = false; fit()">
        Fit
      </button>
    </div>
    <div class="split">
      <div class="canvas">
        <div v-if="error" class="empty error">
          {{ error }}
        </div>
        <svg
          ref="svg"
          width="100%"
          height="100%"
          @wheel.prevent="onWheel"
          @pointerdown="onPointerDown($event)"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--faint)" />
            </marker>
            <marker id="arrow-runtime" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--primary)" />
            </marker>
          </defs>
          <g :transform="`translate(${view.x},${view.y}) scale(${view.k})`">
            <g v-for="edge in visible.edges" :key="`${edge.from}|${edge.to}|${edge.kind}`" class="edge" :class="[edge.kind, { runtime: edge.runtime, dim: edgeDimmed(edge) }]">
              <path :d="edgePath(edge)" :marker-end="edge.runtime ? 'url(#arrow-runtime)' : 'url(#arrow)'" />
              <text v-if="edge.runtime && edge.count" :x="edgeLabelPosition(edge).x" :y="edgeLabelPosition(edge).y" class="edge-label">×{{ edge.count }}</text>
              <text v-else-if="edge.kind === 'middleware' || edge.kind === 'schedules'" :x="edgeLabelPosition(edge).x" :y="edgeLabelPosition(edge).y" class="edge-label">{{ edge.labels.join(', ') }}</text>
            </g>
            <g
              v-for="node in visible.nodes"
              :key="node.id"
              class="node" :class="[node.type, { dim: dimmed(node.id), selected: node.id === selected }]"
              :transform="`translate(${positions.get(node.id)?.x ?? 0},${positions.get(node.id)?.y ?? 0})`"
              @pointerdown="onPointerDown($event, node.id)"
              @pointerenter="hovered = node.id"
              @pointerleave="hovered = undefined"
            >
              <polygon v-if="node.type === 'event'" :points="diamond(RADIUS.event)" />
              <rect v-else-if="node.type === 'job'" :x="-RADIUS.job" :y="-RADIUS.job" :width="RADIUS.job * 2" :height="RADIUS.job * 2" rx="4" />
              <rect v-else-if="node.type === 'module' || node.type === 'subapp'" :x="-RADIUS[node.type]" :y="-RADIUS[node.type]" :width="RADIUS[node.type] * 2" :height="RADIUS[node.type] * 2" rx="9" />
              <circle v-else :r="RADIUS.app" />
              <text :y="RADIUS[node.type] + 14" class="node-label">{{ node.label }}</text>
            </g>
          </g>
        </svg>
        <div v-if="data && !data.nodes.length" class="empty overlay">
          The app has not loaded yet.
        </div>
        <div class="legend">
          <span><i class="dot app" /> project</span>
          <span><i class="dot module" /> module</span>
          <span><i class="dot subapp" /> sub-app</span>
          <span><i class="dot event" /> event</span>
          <span><i class="dot job" /> job</span>
          <span><i class="line" /> declared</span>
          <span><i class="line runtime" /> seen at runtime</span>
        </div>
      </div>
      <aside class="detail side">
        <template v-if="selectedNode">
          <h2>{{ selectedNode.label }} <span class="badge primary">{{ TYPE_LABEL[selectedNode.type] }}</span></h2>
          <p v-if="selectedNode.module && selectedNode.type !== 'module'" class="muted">
            Defined in module <b>{{ selectedNode.module }}</b>
          </p>
          <div class="section">
            <h2>Links out</h2>
            <div v-if="!selectedEdges.outgoing.length" class="faint">
              None
            </div>
            <div v-for="edge in selectedEdges.outgoing" :key="`${edge.to}${edge.kind}`" class="link" @click="selected = edge.to">
              <span class="badge" :class="[edge.runtime ? 'primary' : '']">{{ EDGE_LABEL[edge.kind] }}</span>
              <b>{{ label(edge.to) }}</b>
              <span v-if="edge.labels.length" class="muted">{{ edge.labels.join(', ') }}</span>
              <span v-if="edge.count" class="muted">×{{ edge.count }}</span>
            </div>
          </div>
          <div class="section">
            <h2>Links in</h2>
            <div v-if="!selectedEdges.incoming.length" class="faint">
              None
            </div>
            <div v-for="edge in selectedEdges.incoming" :key="`${edge.from}${edge.kind}`" class="link" @click="selected = edge.from">
              <b>{{ label(edge.from) }}</b>
              <span class="badge" :class="[edge.runtime ? 'primary' : '']">{{ EDGE_LABEL[edge.kind] }}</span>
              <span v-if="edge.labels.length" class="muted">{{ edge.labels.join(', ') }}</span>
              <span v-if="edge.count" class="muted">×{{ edge.count }}</span>
            </div>
          </div>
          <div v-if="Object.keys(selectedNode.detail).length" class="section">
            <h2>Details</h2>
            <pre>{{ json(selectedNode.detail) }}</pre>
          </div>
        </template>
        <div v-else class="muted help">
          <h2>Module graph</h2>
          <p>Modules don't declare dependencies on each other, so the graph is put together from two sources:</p>
          <p><b>Declared</b> links come from definitions: which module defines an event or job, who listens to it, which scheduled tasks run a job, which routes use another module's middleware, and which sub-app a module is mounted into.</p>
          <p><b>Runtime</b> links (curved, with counts) come from what the dev dashboard recorded: events emitted and jobs dispatched while handling requests and jobs.</p>
          <p>Click a node for its links. Drag nodes to rearrange, scroll to zoom.</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  flex: 1;
  position: relative;
  min-width: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.canvas:active {
  cursor: grabbing;
}

.side {
  flex: 0 0 300px !important;
  border-left: 1px solid var(--border);
}

.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.node {
  cursor: pointer;
  transition: opacity .15s;
}

.node > circle, .node > rect, .node > polygon {
  stroke-width: 2;
  fill: var(--panel);
}

.node.app > circle { stroke: var(--c-app); fill: color-mix(in srgb, var(--c-app) 22%, var(--bg)); }
.node.module > rect { stroke: var(--c-module); fill: color-mix(in srgb, var(--c-module) 16%, var(--bg)); }
.node.subapp > rect { stroke: var(--c-subapp); stroke-dasharray: 4 3; }
.node.event > polygon { stroke: var(--c-event); fill: color-mix(in srgb, var(--c-event) 20%, var(--bg)); }
.node.job > rect { stroke: var(--c-job); fill: color-mix(in srgb, var(--c-job) 20%, var(--bg)); }
.node.selected > * { stroke-width: 3.5; }

.node-label {
  text-anchor: middle;
  font-size: 11px;
  fill: var(--text);
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 3px;
  pointer-events: none;
}

.node.app .node-label, .node.module .node-label {
  font-weight: 600;
  font-size: 12px;
}

.edge path {
  fill: none;
  stroke: var(--faint);
  stroke-width: 1.3;
  transition: opacity .15s;
}

.edge.listens path { stroke: var(--c-event); }
.edge.middleware path { stroke: var(--c-module); stroke-dasharray: 5 3; }
.edge.mounted path { stroke: var(--c-subapp); stroke-dasharray: 2 3; }
.edge.schedules path { stroke: var(--c-job); stroke-dasharray: 5 3; }

.edge.runtime path {
  stroke: var(--primary);
  stroke-width: 1.8;
  stroke-dasharray: 6 4;
  animation: flow 1s linear infinite;
}

@keyframes flow {
  to { stroke-dashoffset: -10; }
}

.edge-label {
  font-size: 10px;
  fill: var(--muted);
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 3px;
}

.dim {
  opacity: .15;
}

.legend {
  position: absolute;
  left: 12px;
  bottom: 10px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--muted);
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  padding: 4px 8px;
  border-radius: 6px;
}

.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 3px;
  vertical-align: -1px;
}

.dot.app { background: var(--c-app); border-radius: 50%; }
.dot.module { background: var(--c-module); }
.dot.subapp { border: 1.5px dashed var(--c-subapp); }
.dot.event { background: var(--c-event); transform: rotate(45deg) scale(.85); }
.dot.job { background: var(--c-job); }

.line {
  display: inline-block;
  width: 18px;
  border-top: 1.5px solid var(--faint);
  vertical-align: 3px;
}

.line.runtime {
  border-top: 2px dashed var(--primary);
}

.link {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 4px 0;
  cursor: pointer;
}

.link:hover b {
  color: var(--primary);
}

.help p {
  margin: 0 0 10px;
}

label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
</style>
