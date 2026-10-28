import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  token: env('API_TOKEN', ''),
}))
