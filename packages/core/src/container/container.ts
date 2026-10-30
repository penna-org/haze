import type { AbstractConstructor, Constructor } from '../utils'
import type { InjectionKey } from './token'
import { getRequestStore } from '../request'
import { isClass } from '../utils'
import { CircularDependencyError, ContainerError, ResolutionError, ScopeError } from './errors'
import { keyName } from './token'

export const Scope = {
  /** 应用级单例（HMR 重载后随容器重建） */
  Singleton: 'singleton',
  /** 每个请求一个实例 */
  Request: 'request',
  /** 每次解析都新建 */
  Transient: 'transient',
} as const

// 与常量同名的类型：既可 `Scope.Request` 取值，也可作为类型注解
// eslint-disable-next-line ts/no-redeclare
export type Scope = (typeof Scope)[keyof typeof Scope]

export type Factory<T> = (container: Container) => T
export type Provider<T> = Constructor<T> | Factory<T>

export interface BindOptions {
  scope?: Scope
}

interface Binding<T = unknown> {
  key: InjectionKey<T>
  factory: Factory<T>
  scope: Scope
  kind: BindingKind
  /** 绑定所在的容器，单例缓存在这里 */
  owner: Container
}

/** 绑定的来源：类、工厂函数或 `instance()` 注入的现成实例 */
export type BindingKind = 'class' | 'factory' | 'instance'

/** 一条绑定的描述（开发工具 / 调试用） */
export interface BindingInfo {
  key: string
  scope: Scope
  kind: BindingKind
  /** 单例是否已创建 */
  resolved: boolean
}

interface Frame {
  key: InjectionKey<any>
  scope: Scope
}

interface InjectionContext {
  container: Container
  stack: Frame[]
}

/**
 * 实例化是同步的（`inject()` 只能在字段初始化器/构造函数里同步调用），
 * 因此用模块级变量保存当前注入上下文即可，无需 AsyncLocalStorage。
 */
let currentContext: InjectionContext | undefined

/** 读取类上声明的 `static scope` */
export function scopeOf(target: AbstractConstructor, fallback: Scope = Scope.Singleton): Scope {
  return (target as { scope?: Scope }).scope ?? fallback
}

export class Container {
  readonly parent?: Container
  readonly #bindings = new Map<InjectionKey<any>, Binding>()
  readonly #instances = new Map<InjectionKey<any>, unknown>()
  /** 由容器创建（而非 instance() 注入）的实例，dispose 时负责释放 */
  readonly #owned: unknown[] = []
  #disposed = false

  constructor(parent?: Container) {
    this.parent = parent
  }

  get root(): Container {
    return this.parent ? this.parent.root : this
  }

  /** 是否为请求级子容器 */
  get isRequestScope(): boolean {
    return this.parent !== undefined
  }

  /**
   * 绑定依赖。`provider` 可以是类或工厂函数，省略时 `key` 本身必须是类。
   * 未指定作用域时，类读取 `static scope`，否则默认 Singleton。
   */
  bind<T>(key: InjectionKey<T>, provider?: Provider<T>, options: BindOptions = {}): this {
    const impl = provider ?? key
    let factory: Factory<T>
    let defaultScope: Scope = Scope.Singleton
    let kind: BindingKind = 'factory'

    if (isClass(impl)) {
      factory = () => new (impl as Constructor<T>)()
      defaultScope = scopeOf(impl)
      kind = 'class'
    }
    else if (typeof impl === 'function') {
      factory = impl as Factory<T>
    }
    else {
      throw new ContainerError(`Cannot bind ${keyName(key)}: provider must be a class or factory function`)
    }

    this.#bindings.set(key, {
      key,
      factory,
      scope: options.scope ?? defaultScope,
      kind,
      owner: this,
    })
    this.#instances.delete(key)
    return this
  }

  singleton<T>(key: InjectionKey<T>, provider?: Provider<T>): this {
    return this.bind(key, provider, { scope: Scope.Singleton })
  }

  scoped<T>(key: InjectionKey<T>, provider?: Provider<T>): this {
    return this.bind(key, provider, { scope: Scope.Request })
  }

  transient<T>(key: InjectionKey<T>, provider?: Provider<T>): this {
    return this.bind(key, provider, { scope: Scope.Transient })
  }

  /** 直接注册一个已存在的实例（容器不负责释放它） */
  instance<T>(key: InjectionKey<T>, value: T): this {
    const scope = this.isRequestScope ? Scope.Request : Scope.Singleton
    this.#bindings.set(key, {
      key,
      factory: () => value,
      scope,
      kind: 'instance',
      owner: this,
    })
    this.#instances.set(key, value)
    return this
  }

  /** 本容器的绑定（不含父容器），按注册顺序 */
  bindings(): BindingInfo[] {
    return [
      ...this.#bindings.values(),
    ].map(binding => ({
      key: keyName(binding.key),
      scope: binding.scope,
      kind: binding.kind,
      resolved: this.#instances.has(binding.key),
    }))
  }

  has(key: InjectionKey<any>): boolean {
    return this.#bindings.has(key) || (this.parent?.has(key) ?? false)
  }

  make<T>(key: InjectionKey<T>): T {
    if (this.#disposed)
      throw new ContainerError(`Cannot resolve ${keyName(key)}: container has been disposed`)

    const binding = (this.#lookup(key) ?? this.#autoBind(key)) as Binding<T>

    switch (binding.scope) {
      case Scope.Singleton:
        return binding.owner.#cached(binding, () => this.#construct(binding, binding.owner))
      case Scope.Request: {
        assertNoSingletonParent(binding.key)
        const target = this.#requestContainer(binding)
        return target.#cached(binding, () => this.#construct(binding, target))
      }
      default:
        return this.#construct(binding, this)
    }
  }

  /** 在本容器的注入上下文中执行函数，函数内可直接调用 `inject()` */
  call<T>(fn: () => T): T {
    const prev = currentContext
    currentContext = { container: this, stack: prev?.stack ?? [] }
    try {
      return fn()
    }
    finally {
      currentContext = prev
    }
  }

  /** 创建请求级子容器 */
  createChild(): Container {
    return new Container(this)
  }

  /** 释放容器创建的实例（支持 `Symbol.asyncDispose` / `Symbol.dispose`），按创建顺序逆序执行 */
  async dispose(): Promise<void> {
    if (this.#disposed)
      return
    this.#disposed = true
    for (const instance of this.#owned.reverse()) {
      const target = instance as Partial<AsyncDisposable & Disposable> | null
      const asyncDispose = target?.[Symbol.asyncDispose]
      const dispose = target?.[Symbol.dispose]
      if (typeof asyncDispose === 'function')
        await asyncDispose.call(target)
      else if (typeof dispose === 'function')
        dispose.call(target)
    }
    this.#owned.length = 0
    this.#instances.clear()
  }

  #lookup(key: InjectionKey<any>): Binding | undefined {
    return this.#bindings.get(key) ?? (this.parent
      ? this.parent.#lookup(key)
      : undefined)
  }

  #autoBind(key: InjectionKey<any>): Binding {
    if (!isClass(key))
      throw new ResolutionError(key, currentContext?.stack.map(f => f.key) ?? [])
    // 未显式绑定的类自动注册到根容器
    this.root.bind(key)
    return this.root.#bindings.get(key)!
  }

  #requestContainer(binding: Binding): Container {
    if (this.isRequestScope)
      return this
    throw new ScopeError(`${keyName(binding.key)} is request-scoped and can only be resolved within a request`)
  }

  #cached<T>(binding: Binding<T>, create: () => T): T {
    if (this.#instances.has(binding.key))
      return this.#instances.get(binding.key) as T
    const instance = create()
    this.#instances.set(binding.key, instance)
    return instance
  }

  #construct<T>(binding: Binding<T>, context: Container): T {
    const stack = currentContext?.stack ?? []
    const chain = stack.map(frame => frame.key)

    if (chain.includes(binding.key))
      throw new CircularDependencyError(binding.key, chain)

    const prev = currentContext
    currentContext = {
      container: context,
      stack: [
        ...stack,
        { key: binding.key, scope: binding.scope },
      ],
    }
    try {
      const instance = binding.factory(context)
      // 瞬态实例不跟踪，避免根容器无限增长
      if (binding.scope !== Scope.Transient)
        context.#owned.push(instance)
      return instance
    }
    finally {
      currentContext = prev
    }
  }
}

/** 单例（含其瞬态依赖链）不能依赖请求作用域对象，否则会“捕获”第一个请求的数据 */
function assertNoSingletonParent(key: InjectionKey<any>): void {
  const singleton = currentContext?.stack.find(frame => frame.scope === Scope.Singleton)
  if (singleton)
    throw new ScopeError(`${keyName(singleton.key)} (singleton) cannot depend on ${keyName(key)} (request-scoped)`)
}

/**
 * 注入依赖。可在以下位置调用：
 * - 由容器实例化的类的字段初始化器 / 构造函数中
 * - `container.call()` 的回调中
 * - 请求处理过程中（自动使用当前请求的子容器）
 */
export function inject<T>(key: InjectionKey<T>): T {
  const container = currentContext?.container ?? getRequestStore()?.container
  if (!container) {
    throw new ContainerError(
      `inject(${keyName(key)}) must be called during construction by the container, inside container.call(), or within a request`,
    )
  }
  return container.make(key)
}
