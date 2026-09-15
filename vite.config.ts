import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 同梱の Remotion エンジン（テロップ描画）。GUI のプレビューはこれをそのままバンドルする
const engineDir = path.resolve(here, 'engine', 'src');
// 開発時のプロキシ先（サーバー）。検証で別ポートに立てるときは REEL_STUDIO_PORT を揃える
const api = `http://127.0.0.1:${process.env.REEL_STUDIO_PORT ?? 4310}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': engineDir,
      '@shared': path.resolve(here, 'shared'),
    },
    // エンジンは別 package.json を持つので react / remotion をこのパッケージの node_modules に固定する
    dedupe: ['react', 'react-dom', 'remotion'],
  },
  optimizeDeps: {include: ['remotion', '@remotion/player', 'react', 'react-dom']},
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': api,
      '/events': api,
      '/uploads': api,
      '/fonts': api,
      '/studio': api,
      '/out': api,
      '/qc': api,
      '/p': api,
    },
  },
  build: {outDir: 'dist', sourcemap: false},
});
