import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'socketio',
    environment: 'node',
  },
})
