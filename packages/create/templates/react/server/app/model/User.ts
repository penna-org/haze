import { Model } from '@hazejs/orm'
import { users } from '~/database/schema/users'

/**
 * 用户模型：字段与类型来自 database/schema/users.ts。
 * 常用：User.findOrFail(id)、User.where('name', 'Ada').paginate(1, 20)、User.create(data)、user.save()
 */
export class User extends Model.define(users) {
  // 序列化（接口返回）时隐藏密码哈希
  static override hidden = ['password']
}
