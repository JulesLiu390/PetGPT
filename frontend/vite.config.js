import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'


// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(),react()],
  css: {
    postcss: {},
  },
  server: {
    hmr: {
      overlay: true, // ✅ 确保红色报错提示会出现
    },
  },
})
