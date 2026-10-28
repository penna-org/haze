import { defineConfig } from 'tsdown'

export default defineConfig({
  // client / vue / react 是浏览器端入口（@hazejs/ai/client、@hazejs/ai/vue、@hazejs/ai/react）
  entry: [
    'src/index.ts',
    'src/client/index.ts',
    'src/client/vue.ts',
    'src/client/react.ts',
  ],
  platform: 'neutral',
  dts: true,
  // 与其它包一致输出 .mjs / .d.mts
  fixedExtension: true,
  // 框架由使用方提供（可选 peerDependencies），不打包
  deps: {
    neverBundle: ['vue', 'react'],
  },
})
