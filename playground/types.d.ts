import type { User } from './app/repository/UserRepository'

declare module '@think-h3/core' {
  interface ContextState {
    user: User
    requestId: string
  }

  interface ConfigSchema {
    auth: { token: string }
  }
}

export {}
