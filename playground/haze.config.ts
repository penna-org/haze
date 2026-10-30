import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  // 控制器、服务、事件等与 @hazejs/core 的常用 API 无需手写 import（类型声明在 .haze/types/auto-imports.d.ts）
  autoImport: {
    // 依赖包的自动导入：valibot 以命名空间 v 使用
    imports: [
      {
        from: 'valibot',
        imports: [
          ['*', 'v'],
        ],
      },
    ],
  },
})
