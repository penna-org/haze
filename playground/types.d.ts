import type { User } from './app/repository/UserRepository'

// 配置键与路由名类型由 think-h3 自动生成（.think/types），这里只需声明请求级状态
declare module '@think-h3/core' {
  interface ContextState {
    user: User
  }
}

export {}
