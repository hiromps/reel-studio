// PWA（ホーム画面に追加して、アプリのように開く）の登録。
//
// Service Worker が受け持つのは**画面の枠（HTML / JS / CSS / フォント）と、一度見たメディア**だけ。
// API とジョブは必ずネットワークに出る（古い案件情報を掴ませない）。
// 開発中（vite dev）は登録しない —— 変更が反映されなくなって混乱するため。

let updateAvailable = false;
const updateListeners = new Set<() => void>();
export const hasPwaUpdate = (): boolean => updateAvailable;
export const onPwaUpdate = (listener: () => void): (() => void) => {
  updateListeners.add(listener);
  return () => {updateListeners.delete(listener);};
};

/** Never reload an editor automatically: its in-memory work may be unsaved. */
export const startPwaRegistration = (serviceWorker: ServiceWorkerContainer): (() => void) => {
  let controlled = !!serviceWorker.controller;
  let registration: ServiceWorkerRegistration | null = null;
  let lastCheck = 0;
  const check = () => {
    if (!registration || document.visibilityState === 'hidden' || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    void registration.update().catch(() => {});
  };
  const controllerChanged = () => {
    if (!controlled) {controlled = true; return;}
    updateAvailable = true;
    for (const listener of updateListeners) listener();
  };
  const register = () => {
    void serviceWorker.register('/sw.js', {updateViaCache: 'none'}).then((value) => {
      registration = value; lastCheck = Date.now();
    }).catch(() => { /* The online app remains usable when registration fails. */ });
  };
  serviceWorker.addEventListener('controllerchange', controllerChanged);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
  return () => {
    serviceWorker.removeEventListener('controllerchange', controllerChanged);
    window.removeEventListener('load', register);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', check);
  };
};

export const registerServiceWorker = (): void => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;
  startPwaRegistration(navigator.serviceWorker);
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
