import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0, // keep CSP simple: fonts as files, not data: URIs
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/dl': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
