// PWA（ホーム画面に追加して、アプリのように開く）の登録。
//
// Service Worker が受け持つのは**画面の枠（HTML / JS / CSS / フォント）と、一度見たメディア**だけ。
// API とジョブは必ずネットワークに出る（古い案件情報を掴ませない）。
// 開発中（vite dev）は登録しない —— 変更が反映されなくなって混乱するため。

let reloading = false;

export const registerServiceWorker = (): void => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 登録できなくてもアプリは普通に動く */
    });
  });
  // 新しい版が有効になったら 1 回だけ読み直す（古い画面のまま使い続けない）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
};

/** iOS は「ホーム画面に追加」を自動で案内しない。初回だけ自分で出すための判定 */
export const canPromptIosInstall = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & {standalone?: boolean}).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  return isIos && !standalone;
};

/** ホーム画面から開いているか（余白の取り方を変えるのに使う） */
export const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false;
  return (navigator as Navigator & {standalone?: boolean}).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
};
