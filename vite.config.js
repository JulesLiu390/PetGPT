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
    port: 2887,
    // Tauri 的 devUrl 写死了 2887：端口被占时若让 Vite 自动换端口，
    // Tauri 只会打开一个空白窗口，所以这里宁可直接报错。
    strictPort: true,
    hmr: {
      overlay: true, // ✅ 确保红色报错提示会出现
    },
  },
  base: './', // ✅ 这个必须加！否则加载不到 js/css
})
