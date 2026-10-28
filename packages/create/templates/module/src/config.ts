/** 模块配置：宿主项目的 config/{{moduleName}}.ts 可以覆盖其中任意项（深合并） */
export interface PostsConfig {
  /** 列表接口每页条数 */
  perPage: number
}

export const defaults: PostsConfig = {
  perPage: 20,
}

// 配置类型随包发布：宿主项目中 config('{{moduleName}}.perPage') 得到 number
declare module '@hazejs/core' {
  interface ConfigSchema {
    '{{moduleName}}': PostsConfig
  }
}
