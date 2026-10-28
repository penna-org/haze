import { fileURLToPath, URL } from 'node:url'
import { haze } from '@hazejs/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    // 开发时把 /api/** 交给 server/ 下的后端（同端口、热替换）；
    // vite build 一次产出 dist/client 与 dist/server，vite preview 运行构建产物
    haze(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
