import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Multi-page build: each HTML entry maps to one of the existing /ui/*.html URLs
// Server.ts is updated to serve dist/ui/ at the /ui/ path.
export default defineConfig({
  plugins: [react()],
  root: 'src',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:      resolve(__dirname, 'src/index.html'),
        processes:  resolve(__dirname, 'src/processes.html'),
        workitems:  resolve(__dirname, 'src/workitems.html'),
        reminders:  resolve(__dirname, 'src/reminders.html'),
        cases:      resolve(__dirname, 'src/cases.html'),
        eventlog:   resolve(__dirname, 'src/eventlog.html'),
        agents:     resolve(__dirname, 'src/agents.html'),
        roles:      resolve(__dirname, 'src/roles.html'),
        documents:  resolve(__dirname, 'src/documents.html'),
        connectors: resolve(__dirname, 'src/connectors.html'),
        admin:      resolve(__dirname, 'src/admin.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/workflows':  'http://127.0.0.1:3100',
      '/workitems':  'http://127.0.0.1:3100',
      '/cases':      'http://127.0.0.1:3100',
      '/reminders':  'http://127.0.0.1:3100',
      '/agents':     'http://127.0.0.1:3100',
      '/roles':      'http://127.0.0.1:3100',
      '/documents':  'http://127.0.0.1:3100',
      '/adapters':   'http://127.0.0.1:3100',
      '/messages':   'http://127.0.0.1:3100',
      '/events':     'http://127.0.0.1:3100',
      '/health':     'http://127.0.0.1:3100',
    },
  },
});
