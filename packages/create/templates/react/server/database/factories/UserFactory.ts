import { defineFactory } from '@hazejs/orm'
import { User } from '~/app/model/User'

/**
 * 用户工厂：在测试（tests/user.test.ts）与数据填充中生成用户。
 * await UserFactory.create()、await UserFactory.count(3).create()、await UserFactory.state('admin').create({ name: 'Ada' })
 * faker 的语言在 config/database.ts 的 factories.locale 设置
 */
export default defineFactory(User, ({ faker, sequence }) => ({
  name: faker.person.fullName(),
  email: sequence(n => `user${n}@example.com`),
}))
  .state('admin', { role: 'admin' })
