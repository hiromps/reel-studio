import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 同梱の Remotion エンジン（テロップ描画）。GUI のプレビューはこれをそのままバンドルする
const engineDir = path.resolve(here, 'engine', 'src');
// 開発時のプロキシ先（サーバー）。検証で別ポートに立てるときは REEL_STUDIO_PORT を揃える
const api = `http://127.0.0.1:${process.env.REEL_STUDIO_PORT ?? 4310}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 登録は自前でやる（src/pwa.ts）。開発中に勝手に効くと混乱するため
      injectRegister: null,
      registerType: 'autoUpdate',
      // Service Worker は自分で書く（通知を受け取るため）。中身は src/sw.ts
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Reel Studio',
        short_name: 'Reel Studio',
        description: '素材動画から縦型ショート動画を仕上げる',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#12141a',
        theme_color: '#12141a',
        icons: [
          {src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png'},
          {src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
        ],
      },
      injectManifest: {
        // 画面の枠だけを先読みする。7MB のフォントは入れない（要求されたときに拾う）
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['fonts/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: {enabled: false},
    }),
  ],
  // engine/public/fonts/*.ttf を dist/fonts/ に置く（クラウドではここから配信する）
  publicDir: path.resolve(here, 'public'),
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
      '/studio': api,
      '/out': api,
      '/qc': api,
      '/p': api,
    },
  },
  build: {outDir: 'dist', sourcemap: false},
});
