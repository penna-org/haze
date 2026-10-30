import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 面板 SPA：构建到 dist/client，由 devframe 托管在 <base>hazejs/ 下（相对路径，挂载位置不固定）
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [
    vue(),
  ],
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
})
