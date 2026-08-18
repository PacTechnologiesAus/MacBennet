import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /*
     * Proxying /api means the browser talks to a single origin in development,
     * exactly as it will in production. That keeps the session cookie
     * same-origin and removes an entire class of CORS and SameSite problems
     * that would otherwise only appear in one environment.
     */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
