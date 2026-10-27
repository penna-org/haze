import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: ['docs/**'],
}, {
  // 业务代码依赖返回类型推导（后续用于生成类型安全的 API 客户端），不强制显式声明
  files: ['playground/**', 'packages/*/test/**'],
  rules: {
    'ts/explicit-function-return-type': 'off',
  },
})
