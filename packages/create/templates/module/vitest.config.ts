import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

// 测试使用 tests/app 下的宿主应用：它在 config/modules.ts 中启用本模块（源码），与真实项目的接入方式相同
export default defineConfig(defineHazeTestConfig({
  haze: { srcDir: 'tests/app' },
}))
