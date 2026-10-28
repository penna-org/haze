import { definePolicy, deny } from '@hazejs/core'
import { User } from '~/app/model/User'

/**
 * 用户的授权策略（app/policy 下自动注册）：
 * 控制器中 await ctx.authorize('update', user)；路由上也可用 .middleware('can:update,User,id')
 * 未登录用户默认被拒绝（authorize 返回 401），已登录但无权限返回 403 与 deny() 的消息。
 */
export default definePolicy(User, {
  // 管理员拥有全部权限
  before: (actor: User | undefined) => actor?.role === 'admin' || undefined,
  update: (actor: User, user: User) => actor.id === user.id || deny('只能修改自己的资料'),
  delete: (actor: User, user: User) => actor.id === user.id || deny('只能删除自己的账号'),
})
