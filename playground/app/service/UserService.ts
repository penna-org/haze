import type { User } from '~/app/repository/UserRepository'
import type { CreateUserInput, UpdateUserInput } from '~/app/validate/user'
import { BusinessException, inject, NotFoundException } from '@think-h3/core'
import { UserRepository } from '~/app/repository/UserRepository'

export const ErrorCode = {
  EmailTaken: 10001,
} as const

/** 业务层：规则与流程，不感知 HTTP */
export class UserService {
  private users = inject(UserRepository)

  list(): User[] {
    return this.users.all()
  }

  find(id: number): User {
    const user = this.users.find(id)
    if (!user)
      throw new NotFoundException(`用户 ${id} 不存在`)
    return user
  }

  create(input: CreateUserInput): User {
    this.assertEmailAvailable(input.email)
    return this.users.create(input)
  }

  update(id: number, input: UpdateUserInput): User {
    const user = this.find(id)
    if (input.email && input.email !== user.email)
      this.assertEmailAvailable(input.email)
    return this.users.update(id, input)
  }

  delete(id: number): void {
    this.find(id)
    this.users.delete(id)
  }

  private assertEmailAvailable(email: string): void {
    if (this.users.findByEmail(email))
      throw new BusinessException(ErrorCode.EmailTaken, '邮箱已被注册')
  }
}
