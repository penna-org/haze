import { User } from '~/app/model/User'

/** think-h3 db:seed：按文件名顺序执行 database/seeders 下的文件 */
export default async function seed(): Promise<void> {
  if (await User.where('email', 'admin@example.com').exists())
    return
  await User.create({ name: 'Admin', email: 'admin@example.com' })
}
