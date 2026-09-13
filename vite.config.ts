import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const engineDir = path.resolve(repoRoot, '.claude/skills/hiro-daihon/assets/remotion-template/src');
const api = 'http://127.0.0.1:4310';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': engineDir,
      '@shared': path.resolve(here, 'shared'),
    },
    // エンジンはパッケージ外にあるので react / remotion をこのパッケージの node_modules に固定する
    dedupe: ['react', 'react-dom', 'remotion'],
  },
  optimizeDeps: {include: ['remotion', '@remotion/player', 'react', 'react-dom']},
  server: {
    port: 5173,
    strictPort: false,
    fs: {allow: [repoRoot]},
    proxy: {
      '/api': api,
      '/events': api,
      '/uploads': api,
      '/fonts': api,
      '/studio': api,
      '/out': api,
      '/qc': api,
    },
  },
  build: {outDir: 'dist', sourcemap: false},
});
