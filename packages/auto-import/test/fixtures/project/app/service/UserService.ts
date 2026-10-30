interface Secret {
  secret: string
}

export const ErrorCode = { EmailTaken: 10001 } as const

export class UserService {
  list(): string[] {
    return ['ada', 'grace']
  }
}

/** 泛型约束引用了本文件私有的类型 */
export class Box<T extends Secret | number = number> {
  constructor(public value: T) {}
}

export interface UserDto {
  id: number
}

export type UserId = number

export enum Role {
  Admin = 'admin',
  User = 'user',
}

export declare const declared: number
