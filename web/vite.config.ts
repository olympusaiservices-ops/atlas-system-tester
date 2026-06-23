import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build outputs to web/dist, which the server serves as static files.
// During `vite dev`, proxy the tester API + SSE + health to the backend.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/vapi': {
        target: process.env.VARIFY_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VARIFY_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
