import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.js'),
        content: resolve(__dirname, 'src/content.js'),
        'page-bridge-main': resolve(__dirname, 'src/page-bridge-main.js'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      }
    }
  },
  resolve: {
    alias: {
      '@privacy-ai/sdk/browser': resolve(__dirname, '../../packages/sdk/src/browser.js'),
      'node:fs': resolve(__dirname, 'src/empty-module.js'),
      'node:path': resolve(__dirname, 'src/empty-module.js'),
    }
  },
  publicDir: 'public',
});