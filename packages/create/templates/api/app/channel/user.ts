import type { User } from '~/app/model/User'
import { defineChannels } from '@hazejs/core'

/**
 * 广播频道授权（app/channel 下自动注册）：前端订阅私有 / 在线频道时调用。
 * - 私有频道：echo.private('User.1')，只有用户本人可以订阅（通知的 broadcast 渠道默认推送到这里）；
 * - 在线频道：echo.join('lobby').here(...).joining(...).leaving(...)，返回的信息对其他成员可见。
 * 服务端推送：await broadcast({ channel: privateChannel(`User.${id}`), event: 'OrderShipped', data })
 */
export default defineChannels((c) => {
  c.private('User.{id}', (user: User, { id }) => user.id === Number(id))
  c.presence('lobby', (user: User) => ({ id: user.id, name: user.name }))
})
