// cloudflare:workers 的最小声明（完整类型见 @cloudflare/workers-types）
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    constructor(state: DurableObjectState, env: Env)
    fetch?(request: Request): Response | Promise<Response>
    webSocketMessage?(ws: WebSocket, message: ArrayBuffer | string): void | Promise<void>
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>
  }
}

interface DurableObjectState {
  readonly id: unknown
}
