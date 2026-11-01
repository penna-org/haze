import type { UserProvider } from '@hazejs/core'
import type { ModelClass, ModelLike } from './model/model'
import type { ActiveRecord } from './model/record'
import { Hash } from '@hazejs/core'

export interface ModelUserProviderOptions {
  /** 登录名字段（可多个，凭据中出现的都参与匹配），默认 `email` */
  username?: string | string[]
  /** 密码哈希字段（凭据中同名字段为明文密码），默认 `password` */
  password?: string
  /**
   * 登录成功后，哈希的算法或参数已过时（`Hash.needsRehash()`，如从 bcrypt / argon2 迁移来的哈希）时
   * 用 `Hash.make()` 重新哈希并保存，默认 true
   */
  rehash?: boolean
}

/**
 * 基于模型的用户来源（config/auth.ts 的 providers）：
 *
 * ```ts
 * providers: { users: modelUserProvider(() => User, { username: 'email' }) }
 * ```
 *
 * 模型以函数传入，避免配置文件与模型之间的循环导入。密码字段使用 `Hash.make()` 生成的哈希；
 * 也可以是从其它系统迁移来的 bcrypt / argon2 哈希，登录成功后自动换成当前算法（`rehash: false` 关闭）。
 */
export function modelUserProvider<M extends ModelLike>(model: () => ModelClass<M>, options: ModelUserProviderOptions = {}): UserProvider<M> {
  const usernames = Array.isArray(options.username)
    ? options.username
    : [options.username ?? 'email']
  const password = options.password ?? 'password'
  // 静态方法以 this 参数推导模型类型，这里按 Model 的静态 API 调用
  const statics = (): { find: (id: unknown) => Promise<M | undefined>, where: (where: Record<string, unknown>) => { find: () => Promise<M | undefined> } } => model() as never
  return {
    retrieveById: id => statics().find(id),
    async retrieveByCredentials(credentials) {
      const where = Object.fromEntries(usernames.filter(field => credentials[field] !== undefined).map(field => [field, credentials[field]]))
      if (!Object.keys(where).length)
        return undefined
      return statics().where(where).find()
    },
    async validateCredentials(user, credentials) {
      const hash = (user as Record<string, unknown>)[password]
      const plain = credentials[password]
      if (typeof hash !== 'string' || typeof plain !== 'string' || !await Hash.verify(hash, plain))
        return false
      // 与 core 的 saveFields 一致：直接赋值再保存（不受 allowField() 限制）
      if (options.rehash !== false && Hash.needsRehash(hash)) {
        const record = user as Record<string, unknown> & { save?: () => Promise<unknown> }
        record[password] = await Hash.make(plain)
        await record.save?.()
      }
      return true
    },
    getId: user => (user as unknown as ActiveRecord).getKey() as string | number,
  }
}
