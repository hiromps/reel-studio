import {defineConfig} from 'vitest/config';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': path.resolve(here, 'engine/src'),
      '@shared': path.resolve(here, 'shared'),
      '@core': path.resolve(here, 'core'),
    },
    dedupe: ['react', 'react-dom', 'remotion'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120000,
  },
});
