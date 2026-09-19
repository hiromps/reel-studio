// Service Worker（PWA の本体）。vite-plugin-pwa の injectManifest で `self.__WB_MANIFEST` が埋まる。
//
// 受け持つのは 3 つだけ:
//   1. 画面の枠（HTML / JS / CSS）を先読みして、電波が細い場所でもすぐ開く
//   2. 一度見たメディア（サムネ・軽量プロキシ・完成動画）とフォントを取り置く
//   3. レンダーなどが終わったときの通知を出す
// **API とジョブは必ずネットワークに出す**（古い案件情報を掴ませない）。
/// <reference lib="webworker" />
import {cleanupOutdatedCaches, precacheAndRoute} from 'workbox-precaching';
import {registerRoute} from 'workbox-routing';
import {CacheFirst} from 'workbox-strategies';
import {CacheableResponsePlugin} from 'workbox-cacheable-response';
import {ExpirationPlugin} from 'workbox-expiration';
import {RangeRequestsPlugin} from 'workbox-range-requests';

declare const self: ServiceWorkerGlobalScope & {__WB_MANIFEST: {url: string; revision: string | null}[]};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// テロップのフォント（7MB）。一度取れば変わらない
registerRoute(
  ({url}) => /\/fonts\/.*\.(ttf|otf|woff2?)$/i.test(url.pathname),
  new CacheFirst({
    cacheName: 'reel-fonts',
    plugins: [new CacheableResponsePlugin({statuses: [0, 200]}), new ExpirationPlugin({maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365})],
  }),
);

// サムネイル・軽量プロキシ・完成動画。動画のシーク（Range 要求）も扱えるようにする
registerRoute(
  ({url}) => /^\/p\/.*\/(studio|uploads|out|qc|narration)\//.test(url.pathname),
  new CacheFirst({
    cacheName: 'reel-media',
    plugins: [
      new CacheableResponsePlugin({statuses: [0, 200]}),
      new ExpirationPlugin({maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 14, purgeOnQuotaError: true}),
      new RangeRequestsPlugin(),
    ],
  }),
);

// 新しい版が来たらすぐ入れ替える（古い画面のまま使い続けない）
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', () => void self.clients.claim());

// ───────────────────────── 通知 ─────────────────────────

type PushBody = {title?: string; body?: string; url?: string; tag?: string};

self.addEventListener('push', (event) => {
  let d: PushBody = {};
  try {
    d = (event.data?.json() ?? {}) as PushBody;
  } catch {
    d = {body: event.data?.text() ?? ''};
  }
  event.waitUntil(
    self.registration.showNotification(d.title ?? 'Reel Studio', {
      body: d.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // 同じ案件の通知は積み上げずに置き換える
      tag: d.tag ?? 'reel-studio',
      data: {url: d.url ?? '/'},
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as {url?: string} | null)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
      // 既に開いているタブがあればそれを前に出す
      for (const c of list) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c && url !== '/') await (c as WindowClient).navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
