import { defineConfig, env } from '@think-h3/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'fallback'),
}))
