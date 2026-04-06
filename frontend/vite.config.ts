import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Multi-page build: each HTML entry maps to one of the existing /ui/*.html URLs
// Server.ts is updated to serve dist/ui/ at the /ui/ path.
export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: '/ui/',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'src/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3100',
        rewrite: (path: string) => path.replace(/^\/api/, ''),
      },
    },
  },
});
