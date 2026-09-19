// クラウド版：レンダーや仕上げが終わったときの通知（Web Push）の設定。
//
// レンダーは 10 分以上かかることがある。画面を開いたまま待たなくて済むように、
// 終わったらスマホに知らせる。iOS は**ホーム画面に追加した PWA でのみ**届く（16.4 以降）。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {isStandalone} from '../pwa';

/** VAPID の公開鍵（base64url）を pushManager が要る形（ArrayBuffer）に直す */
const toKey = (base64: string): ArrayBuffer => {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
};

const deviceLabel = (): string => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'ブラウザ';
};

type KeyInfo = {key: string | null; available: boolean; subscriptions: number};

export const NotificationsCard: React.FC = () => {
  const s = useStudio();
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

  const load = useCallback(async () => {
    try {
      const r = await api.get<KeyInfo>('/api/push/key');
      setInfo(r.data);
    } catch {
      setInfo(null);
    }
    if (!supported) return setSubscribed(false);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      setSubscribed(!!(await reg?.pushManager.getSubscription()));
    } catch {
      setSubscribed(false);
    }
  }, [supported]);

  useEffect(() => {
    if (s.isCloud) void load();
  }, [s.isCloud, load]);

  if (!s.isCloud) return null;

  const enable = async () => {
    if (!info?.key) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        s.toast(perm === 'denied' ? '通知が拒否されています（ブラウザの設定から許可してください）' : '通知が許可されませんでした', 'error');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: toKey(info.key)});
      await api.post('/api/push/subscribe', {subscription: sub.toJSON(), label: deviceLabel()});
      s.toast('この端末に通知が届くようになりました', 'ok');
      await load();
    } catch (e) {
      s.toast(`通知を有効にできません: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api.post('/api/push/unsubscribe', {endpoint: sub.endpoint});
        await sub.unsubscribe();
      }
      s.toast('この端末への通知を止めました', 'ok');
      await load();
    } catch (e) {
      s.toast(`解除できません: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await api.post<{sent: number; dropped: number}>('/api/push/test', {});
      s.toast(r.data.sent ? `${r.data.sent} 台に送りました` : '送り先がありません（先に「通知を受け取る」を押してください）', r.data.sent ? 'ok' : 'error');
    } catch (e) {
      s.toast(`テスト送信に失敗: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const iosNeedsInstall = /iPhone|iPad/.test(navigator.userAgent) && !isStandalone();

  return (
    <section className="card">
      <h2>通知</h2>
      <p className="hint">
        レンダー・仕上げ・AI の作業が終わったら、この端末に知らせます（失敗したときは必ず）。画面を開いたまま待たなくて済みます。
      </p>
      {!info?.available && <p className="warn-text">通知の鍵（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）が Vercel に設定されていません。</p>}
      {!supported && <p className="warn-text">このブラウザは通知に対応していません。</p>}
      {iosNeedsInstall && <p className="warn-text">iPhone / iPad では、先に「ホーム画面に追加」してそこから開いてください（Safari のタブのままでは通知を受け取れません）。</p>}
      <div className="row">
        <span className={`pill${subscribed ? '' : ' warn'}`}>{subscribed ? 'この端末: 受け取る' : 'この端末: 受け取らない'}</span>
        {info && <span className="pill">登録 {info.subscriptions} 台</span>}
        <span style={{flex: 1}} />
        {subscribed ? (
          <button onClick={() => void disable()} disabled={busy}>
            通知を止める
          </button>
        ) : (
          <button className="primary" onClick={() => void enable()} disabled={busy || !supported || !info?.available || iosNeedsInstall}>
            {busy ? '設定中…' : '通知を受け取る'}
          </button>
        )}
        <button className="small" onClick={() => void test()} disabled={busy || !info?.available}>
          テスト送信
        </button>
      </div>
    </section>
  );
};
