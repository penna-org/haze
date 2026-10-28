import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'graphql',
    environment: 'node',
  },
})
