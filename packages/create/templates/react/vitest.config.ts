import { defineThinkTestConfig } from '@think-h3/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineThinkTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
}))
