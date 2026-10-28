import type { ChildProcess } from 'node:child_process'
import type { JSONRPCId, JSONRPCResponse } from './protocol'
import type { MCPTransport } from './transport'
import { isRequest, isResponse, MCPError } from './protocol'
import { answerServerRequest, MCPSessionExpiredError } from './transport'

export interface MCPStdioTransportConfig {
  type: 'stdio'
  /** 可执行文件，如 `npx`、`node`、`uvx` */
  command: string
  args?: string[]
  /**
   * 子进程的环境变量。默认只继承 PATH、HOME 等少量基础变量（避免把 API Key 等泄露给第三方服务端），
   * 服务端需要的变量在这里显式传入。
   */
  env?: Record<string, string>
  cwd?: string
  /** 子进程 stderr 的输出（日志）；默认忽略 */
  onStderr?: (chunk: string) => void
}

const INHERITED_ENV: Record<string, string[]> = {
  win32: [
    'APPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERNAME',
    'USERPROFILE',
    'PROGRAMFILES',
    'COMSPEC',
  ],
  default: [
    'HOME',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'USER',
    'TMPDIR',
    'LANG',
  ],
}

/** 关闭时等待子进程退出的时间，超时后依次发送 SIGTERM、SIGKILL */
const EXIT_TIMEOUT = 2000

interface Pending {
  resolve: (response: JSONRPCResponse) => void
  reject: (error: unknown) => void
}

function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout, false)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * stdio 传输：启动子进程，按行（newline-delimited JSON）读写 JSON-RPC 消息，按 id 匹配响应。
 * `node:child_process` 通过动态 import 加载，模块本身在边缘运行时也能导入。
 */
export function createStdioTransport(config: MCPStdioTransportConfig): MCPTransport {
  const pending = new Map<JSONRPCId, Pending>()
  let starting: Promise<ChildProcess> | undefined
  let protocolVersion: string | undefined
  /** legacy 会话所在的进程意外退出，需要重新 initialize */
  let expired = false
  let closed = false

  const failAll = (error: unknown): void => {
    for (const item of pending.values())
      item.reject(error)
    pending.clear()
  }

  const write = (child: ChildProcess, message: unknown): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  const handleLine = (child: ChildProcess, line: string): void => {
    let message: unknown
    try {
      message = JSON.parse(line)
    }
    catch {
      // 规范要求 stdout 只输出 MCP 消息；容忍误写的日志行
      return
    }
    if (isResponse(message)) {
      const item = message.id === undefined || message.id === null
        ? undefined
        : pending.get(message.id)
      if (item) {
        pending.delete(message.id!)
        item.resolve(message)
      }
    }
    else if (isRequest(message)) {
      write(child, answerServerRequest(message))
    }
    // 进度、日志等通知忽略
  }

  const start = (): Promise<ChildProcess> => {
    if (starting)
      return starting
    starting = (async () => {
      const [{ spawn }, { env, platform }] = await Promise.all([import('node:child_process'), import('node:process')])
      const inherited = Object.fromEntries((INHERITED_ENV[platform] ?? INHERITED_ENV.default)
        .filter(key => env[key] !== undefined && !env[key]!.startsWith('()'))
        .map(key => [key, env[key]!]))
      const child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        env: {
          ...inherited,
          ...config.env,
        },
        stdio: [
          'pipe',
          'pipe',
          config.onStderr ? 'pipe' : 'ignore',
        ],
        windowsHide: true,
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', error => reject(new MCPError(`Failed to start MCP server "${config.command}": ${error.message}`, { cause: error })))
      })
      let buffer = ''
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          if (line.trim())
            handleLine(child, line)
          index = buffer.indexOf('\n')
        }
      })
      if (config.onStderr) {
        child.stderr!.setEncoding('utf8')
        child.stderr!.on('data', config.onStderr)
      }
      // 进程退出后写入会触发 EPIPE，由 exit 统一处理
      child.stdin!.on('error', () => {})
      child.on('error', error => failAll(new MCPError(`MCP server process error: ${error.message}`, { cause: error })))
      child.once('exit', (code, signal) => {
        failAll(new MCPError(`MCP server process exited (${signal ?? `code ${code}`})`))
        starting = undefined
        // modern 协议无状态，下次请求直接重启进程；legacy 需要重新握手
        if (!closed && protocolVersion)
          expired = true
      })
      return child
    })()
    // 启动失败时允许下次重试
    starting.catch(() => {
      starting = undefined
    })
    return starting
  }

  return {
    type: 'stdio',
    async request(message, options = {}) {
      if (closed)
        throw new MCPError('MCP client is closed')
      if (expired)
        throw new MCPSessionExpiredError('MCP server process restarted')
      options.signal?.throwIfAborted()
      const child = await start()
      return new Promise<JSONRPCResponse>((resolve, reject) => {
        const signal = options.signal
        const onAbort = (): void => {
          pending.delete(message.id)
          // stdio 上取消请求需要显式通知服务端
          write(child, {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: {
              requestId: message.id,
              reason: String(signal?.reason ?? 'aborted'),
            },
          })
          reject(signal?.reason)
        }
        pending.set(message.id, {
          resolve: (response) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(response)
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort)
            reject(error)
          },
        })
        signal?.addEventListener('abort', onAbort, { once: true })
        write(child, message)
      })
    },
    async notify(message) {
      if (closed)
        throw new MCPError('MCP client is closed')
      write(await start(), message)
    },
    setProtocolVersion(version) {
      protocolVersion = version
      expired = false
    },
    async close() {
      closed = true
      const child = await starting?.catch(() => undefined)
      failAll(new MCPError('MCP client is closed'))
      if (!child)
        return
      // 先关闭 stdin 让服务端自行退出，超时再强制结束
      child.stdin?.end()
      if (await waitForExit(child, EXIT_TIMEOUT))
        return
      child.kill('SIGTERM')
      if (!await waitForExit(child, EXIT_TIMEOUT))
        child.kill('SIGKILL')
    },
  }
}
