import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端只连本地 server，/api 反代到 8787（参考图那种"前端 web ts 反代后端"的架构）
// ws: true —— IDE 内置终端走 /api/terminal 的 WebSocket，也要一起代理
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } },
  },
});
