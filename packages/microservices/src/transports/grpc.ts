import type * as Grpc from '@grpc/grpc-js'
import type * as ProtoLoader from '@grpc/proto-loader'
import type { SerializedError } from '../errors'
import type { ListenOptions, Packet, Transport, TransportServer } from '../transport'
import { Buffer } from 'node:buffer'
import { MicroserviceTimeoutError, MicroserviceUnavailableError, NoHandlerError, RemoteError, serializeError } from '../errors'
import { importOptional, messageId } from '../transport'

export interface GrpcTransportConfig {
  driver: 'grpc'
  /** 服务端绑定 / 客户端连接的地址，如 `0.0.0.0:50051`、`orders:50051` */
  url: string
  /** .proto 文件路径（相对于进程工作目录，或绝对路径） */
  protoPath: string | string[]
  /** 只使用此 proto 包中的服务（如 `orders`），默认全部 */
  package?: string
  /** proto-loader 选项，默认 keepCase、longs: String、enums: String、defaults、oneofs */
  loader?: ProtoLoader.Options
  /**
   * 方法 → 消息模式；未列出的方法使用 `服务名.方法名`（如 `OrderService.FindOne`）。
   * 键可写 `OrderService.FindOne` 或带包名的 `orders.OrderService.FindOne`。
   */
  methods?: Record<string, string>
  /** 默认不加密（createInsecure）；生产环境传入 TLS 凭据 */
  credentials?: { server?: Grpc.ServerCredentials, client?: Grpc.ChannelCredentials }
  /** 透传给 Server / Client 的通道选项 */
  channelOptions?: Grpc.ChannelOptions
}

interface Method {
  /** 带包名的服务名 */
  service: string
  name: string
  pattern: string
  definition: ProtoLoader.MethodDefinition<object, object>
}

/** HTTP 状态码 → gRPC 状态码 */
function grpcStatus(status: typeof Grpc.status, httpStatus: number | undefined): number {
  const map: Record<number, number> = {
    400: 3, // INVALID_ARGUMENT
    401: 16, // UNAUTHENTICATED
    403: 7, // PERMISSION_DENIED
    404: 5, // NOT_FOUND
    409: 6, // ALREADY_EXISTS
    422: 3,
    429: 8, // RESOURCE_EXHAUSTED
    501: 12, // UNIMPLEMENTED
    503: 14, // UNAVAILABLE
    504: 4, // DEADLINE_EXCEEDED
  }
  return httpStatus === undefined
    ? status.INTERNAL
    : map[httpStatus] ?? (httpStatus < 500
      ? status.FAILED_PRECONDITION
      : status.INTERNAL)
}

/** 错误详情放在二进制元数据中（文本元数据只允许 ASCII） */
const ERROR_METADATA = 'x-haze-error-bin'

async function loadModules(): Promise<{ grpc: typeof Grpc, loader: typeof ProtoLoader }> {
  const [grpc, loader] = await Promise.all([
    importOptional(() => import('@grpc/grpc-js'), '@grpc/grpc-js', 'grpc'),
    importOptional(() => import('@grpc/proto-loader'), '@grpc/proto-loader', 'grpc'),
  ])
  return { grpc, loader }
}

/**
 * gRPC 传输（仅 Node，基于 @grpc/grpc-js 与 @grpc/proto-loader）：
 * - proto 中的一元方法映射为消息模式，服务端用同一个 defineMessageHandler 处理；
 * - send 发起一元调用并等待回复，emit 发起调用但不等待；
 * - 不支持流式方法（服务端返回 UNIMPLEMENTED）；载荷按 proto 定义编解码，未定义的字段会丢失。
 */
export function grpcTransport(config: Omit<GrpcTransportConfig, 'driver'>): Transport {
  let loaded: Promise<{ grpc: typeof Grpc, methods: Method[] }> | undefined
  let client: Grpc.Client | undefined

  const load = (): Promise<{ grpc: typeof Grpc, methods: Method[] }> => loaded ??= (async () => {
    const { grpc, loader } = await loadModules()
    const definition = await loader.load(config.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      ...config.loader,
    })
    const methods: Method[] = []
    for (const [service, value] of Object.entries(definition)) {
      // 服务定义的每一项都是带 path 的方法；消息类型带 format 字段
      if ('format' in value || (config.package && !service.startsWith(`${config.package}.`)))
        continue
      const shortName = service.split('.').pop()!
      for (const [name, method] of Object.entries(value as ProtoLoader.ServiceDefinition)) {
        const pattern = config.methods?.[`${service}.${name}`] ?? config.methods?.[`${shortName}.${name}`] ?? `${shortName}.${name}`
        methods.push({
          service,
          name,
          pattern,
          definition: method as ProtoLoader.MethodDefinition<object, object>,
        })
      }
    }
    if (!methods.length) {
      throw new Error(`No gRPC services found in ${String(config.protoPath)}${config.package
        ? ` (package ${config.package})`
        : ''}`)
    }
    return { grpc, methods }
  })()

  const methodFor = (methods: Method[], pattern: string): Method => {
    const method = methods.find(item => item.pattern === pattern)
    if (!method)
      throw new MicroserviceUnavailableError(pattern, `No gRPC method is mapped to "${pattern}"`)
    if (method.definition.requestStream || method.definition.responseStream)
      throw new MicroserviceUnavailableError(pattern, `gRPC method ${method.service}/${method.name} is streaming; only unary methods are supported`)
    return method
  }

  const call = async (pattern: string, data: unknown, timeout: number): Promise<unknown> => {
    const { grpc, methods } = await load()
    const method = methodFor(methods, pattern)
    client ??= new grpc.Client(config.url, config.credentials?.client ?? grpc.credentials.createInsecure(), config.channelOptions)
    const { definition } = method
    return new Promise((resolve, reject) => {
      client!.makeUnaryRequest(
        definition.path,
        definition.requestSerialize,
        definition.responseDeserialize,
        (data ?? {}) as object,
        new grpc.Metadata(),
        timeout > 0
          ? { deadline: Date.now() + timeout }
          : {},
        (error, response) => {
          if (!error)
            return resolve(response)
          if (error.code === grpc.status.DEADLINE_EXCEEDED)
            return reject(new MicroserviceTimeoutError(pattern, timeout))
          if (error.code === grpc.status.UNAVAILABLE && !error.metadata?.get(ERROR_METADATA).length)
            return reject(new MicroserviceUnavailableError(pattern, `gRPC server ${config.url} is unavailable: ${error.details}`))
          const [detail] = error.metadata?.get(ERROR_METADATA) ?? []
          const remote: SerializedError = detail
            ? JSON.parse(Buffer.from(detail as Buffer).toString('utf8')) as SerializedError
            : { name: 'GrpcError', message: error.details || error.message, code: error.code }
          reject(new RemoteError(pattern, remote))
        },
      )
    })
  }

  return {
    send: (pattern, data, { timeout }) => call(pattern, data, timeout),

    async emit(pattern, data) {
      // gRPC 没有单向消息：发起调用但不等待结果
      void call(pattern, data, 0).catch(() => {})
    },

    async listen({ dispatch, onError }: ListenOptions): Promise<TransportServer> {
      const { grpc, methods } = await load()
      const server = new grpc.Server(config.channelOptions)
      const services = new Map<string, { definition: Grpc.ServiceDefinition, implementation: Grpc.UntypedServiceImplementation }>()
      for (const method of methods) {
        const entry = services.get(method.service) ?? { definition: {} as Grpc.ServiceDefinition, implementation: {} }
        services.set(method.service, entry)
        ;(entry.definition as Record<string, unknown>)[method.name] = method.definition
        if (method.definition.requestStream || method.definition.responseStream)
          continue
        entry.implementation[method.name] = ((call: Grpc.ServerUnaryCall<unknown, unknown>, callback: Grpc.sendUnaryData<unknown>) => {
          const packet: Packet = {
            id: messageId(),
            pattern: method.pattern,
            kind: 'request',
            data: call.request,
          }
          dispatch(packet).then(
            result => callback(null, (result ?? {}) as object),
            (error: unknown) => {
              const serialized = serializeError(error)
              if (!(error instanceof NoHandlerError) && (serialized.status === undefined || serialized.status >= 500))
                onError(error, packet)
              const metadata = new grpc.Metadata()
              metadata.set(ERROR_METADATA, Buffer.from(JSON.stringify(serialized)))
              callback({
                code: error instanceof NoHandlerError
                  ? grpc.status.UNIMPLEMENTED
                  : grpcStatus(grpc.status, serialized.status),
                details: serialized.message,
                metadata,
              })
            },
          )
        }) as Grpc.handleUnaryCall<unknown, unknown>
      }
      for (const { definition, implementation } of services.values())
        server.addService(definition, implementation)
      await new Promise<number>((resolve, reject) => {
        server.bindAsync(config.url, config.credentials?.server ?? grpc.ServerCredentials.createInsecure(), (error, port) => error
          ? reject(error)
          : resolve(port))
      })
      return {
        async close() {
          await new Promise<void>((resolve) => {
            server.tryShutdown(() => resolve())
            // 进行中的调用 5 秒内未结束则强制关闭
            setTimeout(() => {
              server.forceShutdown()
              resolve()
            }, 5000).unref()
          })
        },
      }
    },

    async close() {
      client?.close()
      client = undefined
    },
  }
}
