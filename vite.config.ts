import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/');
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/d3-geo') || id.includes('node_modules/topojson-client') || id.includes('node_modules/world-atlas')) {
            return 'vendor-map';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/@xterm/')) {
            return 'vendor-terminal';
          }
          if (normalizedId.includes('/src/modules/servers/')) {
            return 'module-servers';
          }
          if (normalizedId.includes('/src/modules/security/')) {
            return 'module-security';
          }
          if (normalizedId.includes('/src/modules/overview/')) {
            return 'module-overview';
          }
          if (normalizedId.includes('/src/modules/operations/')) {
            return 'module-operations';
          }
          if (normalizedId.includes('/src/modules/custom-api/')) {
            return 'module-custom-api';
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
});
