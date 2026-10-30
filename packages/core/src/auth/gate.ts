import type { MaybePromise } from '../utils'
import type { AuthUser } from './auth'
import { ForbiddenException, UnauthorizedException } from '../exception/exceptions'

const kPolicy = Symbol.for('hazejs.policy')
const kAbilities = Symbol.for('hazejs.abilities')
const kGuest = Symbol.for('hazejs.guest')
const kResponse = Symbol.for('hazejs.gate.response')

/**
 * Gate 拒绝已登录用户时抛出的 403：带上被拒绝的能力与 deny() 给出的原因，
 * 异常处理器可据此改写消息（如列出缺少的权限码、按语言本地化）
 */
export class AuthorizationException extends ForbiddenException {
  /** 被拒绝的能力（authorizeAny 时为全部候选） */
  readonly abilities: string[]
  /** deny('原因') 给出的原因；没有时消息为默认的“无权执行此操作” */
  readonly reason: string | undefined

  constructor(abilities: string[], reason?: string) {
    super(reason ?? '无权执行此操作')
    this.abilities = abilities
    this.reason = reason
  }
}

/** 能力函数的明确结果：`allow()` / `deny('原因')` */
export interface GateResponse {
  readonly [kResponse]: true
  readonly allowed: boolean
  readonly message?: string
}

export function allow(): GateResponse {
  return { [kResponse]: true, allowed: true }
}

/** 拒绝并给出原因（`ctx.authorize()` 抛出的 403 使用此消息） */
export function deny(message?: string): GateResponse {
  return { [kResponse]: true, allowed: false, message }
}

export type AbilityResult = boolean | GateResponse | undefined | null

// 以方法签名声明（参数双变）：能力函数可以把 user 标注为更具体的类型
interface AbilityMethod<U, A extends unknown[]> {
  // eslint-disable-next-line ts/method-signature-style -- 方法签名才是参数双变
  fn(user: U, ...args: A): MaybePromise<AbilityResult>
}

/** 能力函数：未登录用户默认直接拒绝，不调用（用 allowGuest() 包装后允许） */
export type AbilityFn<U = AuthUser, A extends unknown[] = any[]> = AbilityMethod<U, A>['fn']
/** allowGuest() 包装后的能力：user 可能为 undefined */
export type GuestAbilityFn<U = AuthUser, A extends unknown[] = any[]> = AbilityMethod<U | undefined, A>['fn'] & { readonly [kGuest]: true }

/** 允许未登录用户调用该能力（user 为 undefined） */
export function allowGuest<U = AuthUser, A extends unknown[] = any[]>(fn: (user: U | undefined, ...args: A) => MaybePromise<AbilityResult>): GuestAbilityFn<U, A> {
  return Object.assign(fn, { [kGuest]: true as const })
}

type Constructor<T = any> = abstract new (...args: any[]) => T

interface BeforeMethod<U> {
  // eslint-disable-next-line ts/method-signature-style -- 同上
  fn(user: U | undefined, ability: string, args: unknown[]): MaybePromise<AbilityResult>
}

/** 前置判断：返回 true / false 直接决定结果，undefined 继续判断（如超级管理员） */
export type BeforeHook<U = AuthUser> = BeforeMethod<U>['fn']
/** 后置观察（审计日志等），不改变结果 */
export type AfterHook<U = AuthUser> = (user: U | undefined, ability: string, allowed: boolean, args: unknown[]) => MaybePromise<void>

/**
 * 未定义的能力由它决定（数据驱动的权限：权限码存在数据库的角色里、运行时新增）。
 * 返回 undefined 时拒绝；未登录的用户为 undefined
 */
export type FallbackHook<U = AuthUser> = (user: U | undefined, ability: string, args: unknown[]) => MaybePromise<AbilityResult>

export interface PolicyAbilities<U, M> {
  [ability: string]: AbilityFn<U, [M, ...any[]]> | GuestAbilityFn<U, [M, ...any[]]> | BeforeHook<U> | undefined
}

export interface Policy<M = unknown, A = Record<string, unknown>> {
  readonly [kPolicy]: true
  readonly model: Constructor<M>
  readonly abilities: A
}

export interface AbilitySet<A = Record<string, unknown>> {
  readonly [kAbilities]: true
  readonly abilities: A
}

/**
 * 模型策略（app/policy/*.ts 的默认导出，自动发现）。
 * 能力函数的第二个参数为模型实例；类级能力（如 create）通过 `ctx.can('create', Post)` 调用，只收到 user。
 *
 * ```ts
 * export default definePolicy(Post, {
 *   before: user => user?.role === 'admin' || undefined,
 *   view: allowGuest((user, post) => post.published || post.userId === user?.id),
 *   update: (user, post) => post.userId === user.id || deny('只能修改自己的文章'),
 *   create: user => Boolean(user.verified),
 * })
 * ```
 */
export function definePolicy<M, const A extends PolicyAbilities<AuthUser, M> & { before?: BeforeHook<AuthUser> }>(model: Constructor<M>, abilities: A): Policy<M, A> {
  return { [kPolicy]: true, model, abilities }
}

/** 与模型无关的能力：`defineAbilities({ 'admin.access': user => user.role === 'admin' })` */
export function defineAbilities<const A extends Record<string, AbilityFn<AuthUser> | GuestAbilityFn<AuthUser>>>(abilities: A): AbilitySet<A> {
  return { [kAbilities]: true, abilities }
}

export function isPolicy(value: unknown): value is Policy {
  return typeof value === 'object' && value !== null && kPolicy in value
}

export function isAbilitySet(value: unknown): value is AbilitySet {
  return typeof value === 'object' && value !== null && kAbilities in value
}

/** typegen 根据 app/policy/*.ts 生成（模块扩充），用于约束能力名 */
export interface GeneratedPolicies {}

type Entries = GeneratedPolicies[keyof GeneratedPolicies]
type HasGenerated = [keyof GeneratedPolicies] extends [never] ? false : true

/** 与模型无关的能力名 */
export type PlainAbility = HasGenerated extends true
  ? Entries extends infer E ? E extends AbilitySet<infer A> ? keyof A & string : never : never
  : string

/** 模型 M 的策略中可用的能力名 */
export type ModelAbility<M> = HasGenerated extends true
  ? Entries extends infer E ? E extends Policy<infer I, infer A> ? M extends I ? Exclude<keyof A & string, 'before'> : never : never : never
  : string

export interface GateInspection {
  allowed: boolean
  message?: string
  /** 因未登录被拒绝（authorize 抛 401 而不是 403） */
  guest: boolean
}

/** 授权网关：注册能力与策略，按用户判断。应用内单例，可 `app.make(Gate)` / `inject(Gate)` */
export class Gate {
  readonly #abilities = new Map<string, AbilityFn<any> | GuestAbilityFn<any>>()
  readonly #policies = new Map<Constructor, Policy<any, any>>()
  readonly #before: BeforeHook<any>[] = []
  readonly #after: AfterHook<any>[] = []
  #fallback: FallbackHook<any> | undefined

  /** 注册能力 */
  define(ability: string, fn: AbilityFn<any> | GuestAbilityFn<any>): this {
    this.#abilities.set(ability, fn)
    return this
  }

  /** 注册策略（definePolicy 的结果） */
  policy(policy: Policy<any, any>): this {
    this.#policies.set(policy.model, policy)
    return this
  }

  /** 注册 app/policy 的模块（Policy 或 AbilitySet） */
  register(item: unknown): this {
    if (isPolicy(item))
      return this.policy(item)
    if (isAbilitySet(item)) {
      for (const [name, fn] of Object.entries(item.abilities))
        this.define(name, fn as AbilityFn)
      return this
    }
    throw new TypeError('app/policy/*.ts must export default definePolicy(...) or defineAbilities(...)')
  }

  before(hook: BeforeHook<any>): this {
    this.#before.push(hook)
    return this
  }

  after(hook: AfterHook<any>): this {
    this.#after.push(hook)
    return this
  }

  /**
   * 未定义的能力交给它判断，而不是报错 `Unknown ability`：
   *
   * ```ts
   * gate.fallback((user, ability) => user?.permissions.includes(ability))
   * ```
   */
  fallback(hook: FallbackHook<any>): this {
    this.#fallback = hook
    return this
  }

  has(ability: string): boolean {
    return this.#abilities.has(ability)
  }

  /** 按模型类名查找策略对应的模型类（can:update,Post 中间件使用） */
  modelNamed(name: string): Constructor | undefined {
    for (const model of this.#policies.keys()) {
      if (model.name === name)
        return model
    }
    return undefined
  }

  /** 实例或类对应的策略（沿原型链查找，子类继承父类的策略） */
  policyFor(target: unknown): Policy<any, any> | undefined {
    let current = typeof target === 'function'
      ? target as Constructor
      : (target as object | null)?.constructor as Constructor | undefined
    while (current && current !== Object) {
      const policy = this.#policies.get(current)
      if (policy)
        return policy
      current = Object.getPrototypeOf(current)
    }
    return undefined
  }

  async inspect(user: unknown, ability: string, ...args: unknown[]): Promise<GateInspection> {
    const [target] = args
    const policy = (typeof target === 'object' && target !== null) || typeof target === 'function'
      ? this.policyFor(target)
      : undefined
    let fn: AbilityFn<any> | GuestAbilityFn<any> | undefined
    let rest = args
    if (policy) {
      fn = policy.abilities[ability]
      if (!fn || ability === 'before')
        throw new Error(`Policy for ${policy.model.name} has no "${ability}" ability`)
      // 类级能力（传入的是模型类）只传 user
      if (typeof target === 'function')
        rest = args.slice(1)
    }
    else {
      fn = this.#abilities.get(ability)
      if (!fn && this.#fallback) {
        // 未定义的能力：before 钩子仍然先执行，之后交给 fallback（访客同样交给它判断）
        const fallback = this.#fallback
        fn = Object.assign((user: unknown, ...rest: unknown[]) => fallback(user, ability, rest), { [kGuest]: true as const }) as GuestAbilityFn<any>
      }
      if (!fn)
        throw new Error(`Unknown ability "${ability}": define it with defineAbilities() / definePolicy() in app/policy, or register gate.fallback()`)
    }

    const decide = async (): Promise<GateInspection> => {
      for (const hook of [
        ...this.#before,
        ...(policy?.abilities.before
          ? [policy.abilities.before as BeforeHook]
          : []),
      ]) {
        const result = normalize(await hook(user, ability, args))
        if (result)
          return { ...result, guest: user === undefined && !result.allowed }
      }
      if (user === undefined && !(kGuest in fn!))
        return { allowed: false, guest: true }
      const result = normalize(await (fn as AbilityFn<any>)(user, ...rest)) ?? { allowed: false }
      return { ...result, guest: user === undefined && !result.allowed }
    }

    const decision = await decide()
    for (const hook of this.#after)
      await hook(user, ability, decision.allowed, args)
    return decision
  }

  async allows(user: unknown, ability: string, ...args: unknown[]): Promise<boolean> {
    return (await this.inspect(user, ability, ...args)).allowed
  }

  async denies(user: unknown, ability: string, ...args: unknown[]): Promise<boolean> {
    return !(await this.allows(user, ability, ...args))
  }

  /** 无权限时抛出：未登录 401，已登录 403（消息取自 deny()） */
  async authorize(user: unknown, ability: string, ...args: unknown[]): Promise<void> {
    const result = await this.inspect(user, ability, ...args)
    if (result.allowed)
      return
    if (result.guest)
      throw new UnauthorizedException(result.message ?? '未登录或登录已过期')
    throw new AuthorizationException([ability], result.message)
  }

  /** 拥有其中任一能力即通过；全部被拒绝时抛出（未登录 401，已登录 403，消息取自最后一个） */
  async authorizeAny(user: unknown, abilities: readonly string[], ...args: unknown[]): Promise<void> {
    if (!abilities.length)
      throw new Error('authorizeAny() needs at least one ability')
    let last: GateInspection | undefined
    for (const ability of abilities) {
      last = await this.inspect(user, ability, ...args)
      if (last.allowed)
        return
    }
    if (last!.guest)
      throw new UnauthorizedException(last!.message ?? '未登录或登录已过期')
    throw new AuthorizationException([...abilities], last!.message)
  }

  /** 绑定用户（请求之外：任务、脚本） */
  forUser(user: unknown): UserGate {
    return new UserGate(this, user)
  }
}

/** 绑定了用户的 Gate */
export class UserGate {
  constructor(readonly gate: Gate, readonly user: unknown) {}

  can<M extends object>(ability: ModelAbility<M>, model: M, ...args: unknown[]): Promise<boolean>
  can<C extends Constructor>(ability: ModelAbility<InstanceType<C>>, model: C, ...args: unknown[]): Promise<boolean>
  can(ability: PlainAbility, ...args: unknown[]): Promise<boolean>
  can(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.gate.allows(this.user, ability, ...args)
  }

  cannot<M extends object>(ability: ModelAbility<M>, model: M, ...args: unknown[]): Promise<boolean>
  cannot<C extends Constructor>(ability: ModelAbility<InstanceType<C>>, model: C, ...args: unknown[]): Promise<boolean>
  cannot(ability: PlainAbility, ...args: unknown[]): Promise<boolean>
  cannot(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.gate.denies(this.user, ability, ...args)
  }

  authorize<M extends object>(ability: ModelAbility<M>, model: M, ...args: unknown[]): Promise<void>
  authorize<C extends Constructor>(ability: ModelAbility<InstanceType<C>>, model: C, ...args: unknown[]): Promise<void>
  authorize(ability: PlainAbility, ...args: unknown[]): Promise<void>
  authorize(ability: string, ...args: unknown[]): Promise<void> {
    return this.gate.authorize(this.user, ability, ...args)
  }

  inspect(ability: string, ...args: unknown[]): Promise<GateInspection> {
    return this.gate.inspect(this.user, ability, ...args)
  }
}

function normalize(result: AbilityResult): { allowed: boolean, message?: string } | undefined {
  if (result === undefined || result === null)
    return undefined
  if (typeof result === 'boolean')
    return { allowed: result }
  return { allowed: result.allowed, message: result.message }
}
