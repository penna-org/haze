import type { User } from '~/app/model/User'
import { defineResource, when } from '@hazejs/core'

/**
 * 用户的接口输出（API 资源）：只暴露需要的字段。
 * 单个：UserResource.make(user)；列表 / 分页：UserResource.collection(await User.paginate(page, 20))
 */
export const UserResource = defineResource((user: User, ctx) => ({
  id: user.id,
  name: user.name,
  // 邮箱只对有权修改该用户的人（本人与管理员，见 app/policy/UserPolicy.ts）可见
  email: when(ctx.can('update', user), user.email),
  role: user.role,
  createdAt: user.createdAt,
}))
