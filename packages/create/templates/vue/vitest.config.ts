import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
}))
