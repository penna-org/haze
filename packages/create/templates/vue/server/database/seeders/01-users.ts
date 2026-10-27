import { Hash } from '@think-h3/core'
import { User } from '~/app/model/User'

/** think-h3 db:seed：按文件名顺序执行 database/seeders 下的文件 */
export default async function seed(): Promise<void> {
  if (await User.where('email', 'admin@example.com').exists())
    return
  // 开发用账号，上线前请修改密码
  await User.create({ name: 'Admin', email: 'admin@example.com', password: await Hash.make('password') })
}
