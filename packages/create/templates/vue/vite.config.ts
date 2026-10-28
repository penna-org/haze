import { fileURLToPath, URL } from 'node:url'
import { haze } from '@hazejs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    // 开发时把 /api/** 交给 server/ 下的后端（同端口、热替换）；
    // vite build 一次产出 dist/client 与 dist/server
    haze(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
