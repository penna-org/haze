import { defineConfig, env } from '@think-h3/core'

export default defineConfig(() => ({
  token: env('API_TOKEN', ''),
}))
