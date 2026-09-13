import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', strictPort: true, port: 5173 },
  build: { outDir: 'dist', target: 'chrome140', sourcemap: true }
});
