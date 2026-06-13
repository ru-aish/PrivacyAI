import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.js'),
        content: resolve(__dirname, 'src/content.js'),
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
