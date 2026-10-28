import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'fallback'),
}))
