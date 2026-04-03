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
        editor:     resolve(__dirname, 'src/editor.html'),
        messages:   resolve(__dirname, 'src/messages.html'),
        health:     resolve(__dirname, 'src/health.html'),
        kb:         resolve(__dirname, 'src/kb.html'),
        workspace:  resolve(__dirname, 'src/workspace.html'),
        monitor:    resolve(__dirname, 'src/monitor.html'),
        login:      resolve(__dirname, 'src/login.html'),
        people:     resolve(__dirname, 'src/people.html'),
        skills:     resolve(__dirname, 'src/skills.html'),
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
