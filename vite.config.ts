import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Relative base + hash routing keeps the identical renderer artifact
// relocatable (nested browser paths and flashfinger://app/ on desktop).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: true,
  },
  worker: {
    format: 'es',
  },
});
