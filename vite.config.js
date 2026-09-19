import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 给所有构建产物的 JS chunk 注入 `<link rel="modulepreload">`。
 *
 * 路由是按窗口 lazy 切分的，Vite 默认只把入口写进 HTML，其余 chunk 要等入口
 * 执行到 `import()` 那一行才开始请求。实测 manage 窗口：入口 62ms 开始下载、
 * 159ms 执行完，路由 chunk 到 185ms 才发起请求，最大的那个又花了 216ms ——
 * 这中间的串行等待纯属浪费，五个窗口在启动时各付一次。
 *
 * modulepreload 只下载并编译，不执行模块，所以代价是带宽和编译缓存，
 * 不会凭空创建用不到的模块实例。这是刻意拿内存换启动流畅。
 */
const preloadAllChunks = () => ({
  name: 'petgpt-preload-all-chunks',
  apply: 'build',
  transformIndexHtml: {
    // post：要等 bundle 生成完才知道带 hash 的文件名
    order: 'post',
    handler(html, ctx) {
      if (!ctx.bundle) return undefined;
      const tags = Object.keys(ctx.bundle)
        .filter((file) => file.endsWith('.js'))
        // 入口已经有 <script> 标签了，再 preload 一次是多余的
        .filter((file) => !html.includes(file))
        .map((file) => ({
          tag: 'link',
          attrs: { rel: 'modulepreload', crossorigin: true, href: `./${file}` },
          injectTo: 'head',
        }));
      return { html, tags };
    },
  },
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react(), preloadAllChunks()],
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
