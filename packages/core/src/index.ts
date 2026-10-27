export { createLambdaHandler, lambdaEventToRequest, lambdaResultToResponse, requestToLambdaEvent, responseToLambdaResult } from './adapters/aws-lambda'
export type { LambdaEvent, LambdaResult } from './adapters/aws-lambda'
export { Application, config, createApplication, useApp } from './application'
export type { ApplicationOptions, AppMode, DisposeOptions } from './application'

export { matchApp, matchDomain } from './apps'
export type { SubAppConfig } from './apps'
export { Config, defineConfig } from './config/config'
export type { AppConfig, ConfigInput, ConfigKey, ConfigPath, ConfigPathValue, ConfigSchema, ConfigValue, CoreConfig, GeneratedConfig, PathValue, ResolvedConfigSchema, ResponseConfig } from './config/config'

export { env, loadEnv } from './config/env'

export type { LoadEnvOptions } from './config/env'
export * from './container'
export { parseStack, renderErrorPage } from './exception/error-page'
export type { ErrorPageInput, StackFrame } from './exception/error-page'
export * from './exception/exceptions'

export { ExceptionHandler } from './exception/handler'
export type { NormalizedError } from './exception/handler'
export { getHttpContext, HttpContext } from './http/context'
export type { ContextState, Validated, ValidationTargets } from './http/context'
export { ResponseFormatter } from './http/formatter'
export { defineInterceptor } from './http/interceptor'
export type { Interceptor } from './http/interceptor'
export { isFormattable, isRaw, raw } from './http/response'
export type { RawValue } from './http/response'
export { createStaticMiddleware } from './http/static'

export type { StaticOptions } from './http/static'
export { validate } from './http/validation'

export { Logger } from './logger'
export type { AccessLogEntry, LogContext, LogFormat, LoggerConfig, LogLevel } from './logger'
export { MiddlewareRegistry } from './middleware/registry'
export type { ResolvedMiddleware } from './middleware/registry'

export { defineMiddleware, defineMiddlewareConfig } from './middleware/types'
export type { Middleware, MiddlewareClass, MiddlewareConfig, MiddlewareHandler, MiddlewareRef, Next } from './middleware/types'

export { definePersistent, disposePersistent } from './persistent'
export type { PersistentOptions } from './persistent'
export { setPlatformBindings, usePlatformBinding } from './platform'

export { defineProvider } from './provider'

export type { ProviderInput, ServiceProvider } from './provider'
export { useContext, useEvent } from './request'
export { defineRoutes, isRouteModule, ResourceRoutes, RouteBuilder } from './routing/builder'
export type { GroupOptions, ResourceAction, ResourceOptions, RouteModule, RouteRegistrar } from './routing/builder'
export { Route } from './routing/route'
export type { ControllerAction, HandlerFn, HttpMethod, RouteDefinition, RouteHandler, RouteMeta, RouteMethod } from './routing/route'

export { Router } from './routing/router'

export type { ControllerMiddleware, MountOptions, RouteInfo, RouteName, RouteNames } from './routing/router'
export type { Constructor, MaybePromise } from './utils'

// 部署适配（vercel 预设使用）
export { H3Event, HTTPError, toNodeHandler } from 'h3'
