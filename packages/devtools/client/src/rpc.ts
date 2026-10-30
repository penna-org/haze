import type { DevframeRpcClient } from 'devframe/client'
import type { Ref, ShallowRef } from 'vue'
import type { Revision } from '../../src/frame'
import { connectDevframe } from 'devframe/client'
import { onScopeDispose, ref, shallowRef, watch } from 'vue'

let client: Promise<DevframeRpcClient> | undefined

/** 与 devframe 的连接（同一页面共用一个） */
export function rpc(): Promise<DevframeRpcClient> {
  client ??= connectDevframe()
  return client
}

export async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const connection = await rpc()
  return (connection.call as (name: string, ...args: unknown[]) => Promise<T>)(`hazejs:${name}`, ...args)
}

const revision = ref<Revision>({ reload: 0, entries: 0 })
let subscribed = false

/** 应用重载 / 有新记录时递增，页面据此重新拉取数据 */
export function useRevision(): Ref<Revision> {
  if (!subscribed) {
    subscribed = true
    void rpc().then(async (connection) => {
      const state = await connection.sharedState.get<Revision>('hazejs:revision')
      revision.value = {
        ...state.value(),
      }
      state.on('updated', (value: Revision) => {
        revision.value = { ...value }
      })
    })
  }
  return revision
}

/**
 * 查询并在数据变化时自动刷新。`live` 为 false 时只在应用重载后刷新（不随每条新记录刷新）。
 */
export interface Query<T> {
  data: ShallowRef<T | undefined>
  error: Ref<string | undefined>
  loading: Ref<boolean>
  reload: () => Promise<void>
}

export function useQuery<T>(name: string, args: () => unknown[] = () => [], options: { live?: boolean } = {}): Query<T> {
  const data = shallowRef<T>()
  const error = ref<string>()
  const loading = ref(true)
  const current = useRevision()
  let seq = 0

  async function load(): Promise<void> {
    const id = ++seq
    loading.value = true
    try {
      const result = await call<T>(name, ...args())
      if (id === seq) {
        data.value = result
        error.value = undefined
      }
    }
    catch (cause) {
      if (id === seq)
        error.value = (cause as Error).message
    }
    finally {
      if (id === seq)
        loading.value = false
    }
  }

  const stop = watch(
    () => [
      options.live === false
        ? 0
        : current.value.entries,
      current.value.reload,
      ...args(),
    ],
    () => void load(),
    { immediate: true, deep: true },
  )
  onScopeDispose(stop)
  return { data, error, loading, reload: load }
}
