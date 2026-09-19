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
      workbox: {
        // 画面の枠だけを先読みする。7MB のフォントは入れない（要求されたときに拾う）
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['fonts/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        // API・通知・メディアの入口はキャッシュの対象から外す（古い案件情報を掴ませない）
        navigateFallbackDenylist: [/^\/api\//, /^\/events$/, /^\/p\//],
        runtimeCaching: [
          {
            // テロップのフォント。一度取れば変わらない
            urlPattern: /\/fonts\/.*\.(ttf|otf|woff2?)$/i,
            handler: 'CacheFirst',
            options: {cacheName: 'reel-fonts', expiration: {maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365}},
          },
          {
            // サムネイル・軽量プロキシ・完成動画。実体は差し替わるので短めに持つ
            urlPattern: /\/p\/.*\/(studio|uploads|out|qc|narration)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'reel-media',
              expiration: {maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 14},
              cacheableResponse: {statuses: [0, 200]},
              rangeRequests: true,
            },
          },
        ],
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
