import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build outputs to web/dist, which the server serves as static files.
// During `vite dev`, proxy the tester API + SSE + health to the backend.
//
// VERIFY_WEB_HOST controls the dev-server bind address: unset → localhost only
// (default); "true" → all interfaces (0.0.0.0), so other machines on the LAN can
// reach the UI; or an explicit IP/hostname to bind. run-mock.sh sets "true".
const webHostEnv = process.env.VERIFY_WEB_HOST;
const webHost = webHostEnv === 'true' ? true : webHostEnv || 'localhost';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: webHost,
    port: 5173,
    proxy: {
      '/vapi': {
        target: process.env.VERIFY_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VERIFY_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
