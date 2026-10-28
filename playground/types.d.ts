import type { User } from './app/repository/UserRepository'

// 配置键与路由名类型由 hazejs 自动生成（.haze/types），这里只需声明请求级状态
declare module '@hazejs/core' {
  interface ContextState {
    user: User
  }
}

export {}
