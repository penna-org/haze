import { defineEvent } from '@hazejs/core'

/** 用户注册成功（AuthController.register 触发，监听器见 app/listener） */
const UserRegistered = defineEvent<{ userId: number, email: string }>()

export default UserRegistered
