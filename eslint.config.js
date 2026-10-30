import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  // 文档与 agent skills 中的代码片段是示意（片段、紧凑写法），不按源码规则检查
  ignores: ['docs/**', 'skills/**'],
}, {
  // 业务代码依赖返回类型推导（后续用于生成类型安全的 API 客户端），不强制显式声明
  files: ['playground/**', 'packages/*/test/**', 'packages/create/templates/**'],
  rules: {
    'ts/explicit-function-return-type': 'off',
  },
})
