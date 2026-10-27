export interface User {
  id: number
  name: string
  email: string
}

/** 数据访问层：演示用的内存实现，真实项目中替换为 ORM */
export class UserRepository {
  #users = new Map<number, User>()
  #nextId = 1

  all(): User[] {
    return [
      ...this.#users.values(),
    ]
  }

  find(id: number): User | undefined {
    return this.#users.get(id)
  }

  findByEmail(email: string): User | undefined {
    return this.all().find(user => user.email === email)
  }

  create(data: Omit<User, 'id'>): User {
    const user = { id: this.#nextId++, ...data }
    this.#users.set(user.id, user)
    return user
  }

  update(id: number, data: Partial<Omit<User, 'id'>>): User {
    const user = {
      ...this.#users.get(id)!,
      ...data,
    }
    this.#users.set(id, user)
    return user
  }

  delete(id: number): void {
    this.#users.delete(id)
  }
}
