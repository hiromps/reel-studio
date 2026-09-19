// 通知（Web Push）。レンダーや仕上げは 10 分以上かかることがあるので、
// 終わったらスマホに知らせる（画面を開いたままにしておかなくて済む）。
//
// iOS はホーム画面に追加した PWA でのみ届く（16.4 以降）。
// 鍵は VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（無ければ通知の機能そのものを出さない）。
import {eq} from 'drizzle-orm';
import webpush from 'web-push';
import {db} from './db/client';
import {pushSubs} from './db/schema';

export type PushPayload = {title: string; body: string; url?: string; tag?: string};

let configured: boolean | null = null;

/** 鍵が揃っていれば true。1 回だけ web-push に渡す */
export const pushAvailable = (): boolean => {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return (configured = false);
  // mailto: は VAPID の仕様上いる（配信側が連絡先として使う）
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || 'mailto:reel-studio@localhost', pub, priv);
  return (configured = true);
};

export const publicKey = (): string | null => process.env.VAPID_PUBLIC_KEY?.trim() || null;

export const saveSubscription = async (sub: {endpoint: string; keys: {p256dh: string; auth: string}}, label?: string): Promise<void> => {
  await db()
    .insert(pushSubs)
    .values({endpoint: sub.endpoint, keys: sub.keys, label: label ?? null})
    .onConflictDoUpdate({target: pushSubs.endpoint, set: {keys: sub.keys, label: label ?? null}});
};

export const removeSubscription = async (endpoint: string): Promise<void> => {
  await db().delete(pushSubs).where(eq(pushSubs.endpoint, endpoint));
};

export const countSubscriptions = async (): Promise<number> => (await db().select({endpoint: pushSubs.endpoint}).from(pushSubs)).length;

/**
 * 全端末へ送る（自分専用の 1 アカウントなので宛先の絞り込みはしない）。
 * 失効した購読（404 / 410）はその場で消す —— 残すと毎回失敗し続ける。
 */
export const sendToAll = async (payload: PushPayload): Promise<{sent: number; dropped: number}> => {
  if (!pushAvailable()) return {sent: 0, dropped: 0};
  const rows = await db().select().from(pushSubs);
  let sent = 0;
  let dropped = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification({endpoint: r.endpoint, keys: r.keys}, JSON.stringify(payload), {TTL: 3600});
        sent++;
      } catch (e) {
        const status = (e as {statusCode?: number}).statusCode;
        if (status === 404 || status === 410) {
          await removeSubscription(r.endpoint);
          dropped++;
        }
      }
    }),
  );
  if (sent) await db().update(pushSubs).set({lastSent: new Date()});
  return {sent, dropped};
};

/** 通知を出す価値があるジョブ（一瞬で終わるものまで鳴らさない） */
const NOTIFY_TYPES = new Set(['render', 'draft', 'build', 'mix', 'deliver', 'trial', 'winner', 'catalog', 'mosaic', 'ingest', 'ai-script', 'ai-order', 'ai-telop', 'ai-narration', 'ai-caption', 'ai-tag', 'tts']);

const LABEL: Record<string, string> = {
  render: 'レンダー',
  draft: '下書きレンダー',
  build: '仕上げ',
  mix: 'ナレーション合成',
  deliver: '納品',
  trial: 'トライアル',
  winner: '二次活用',
  catalog: '素材のカタログ化',
  mosaic: '顔モザイク',
  ingest: '素材の取り込み',
  tts: '音声生成',
  'ai-script': '台本からの組み立て',
  'ai-order': '並べ替え',
  'ai-telop': 'テロップ',
  'ai-narration': 'ナレーション原稿',
  'ai-caption': 'キャプション',
  'ai-tag': 'タグ付け',
};

/** ジョブが終わったときの通知。失敗は必ず、成功は時間のかかるものだけ */
export const notifyJobFinished = async (job: {type: string; slug: string; status: string; error?: string}): Promise<void> => {
  if (!pushAvailable()) return;
  if (job.status === 'cancelled') return;
  if (job.status === 'done' && !NOTIFY_TYPES.has(job.type)) return;
  const what = LABEL[job.type] ?? job.type;
  const shop = job.slug.replace(/-reel$/, '');
  await sendToAll({
    title: job.status === 'done' ? `${what}が終わりました` : `${what}が失敗しました`,
    body: job.status === 'done' ? shop : `${shop}: ${(job.error ?? '').slice(0, 120)}`,
    url: `/?p=${encodeURIComponent(job.slug)}`,
    tag: `job-${job.slug}`,
  });
};
