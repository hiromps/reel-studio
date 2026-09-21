// メディアの実体置き場（Vercel Blob）。
//
// ここに載るのは**軽いものだけ**（サムネ・ストリップ・軽量プロキシ 540x960・完成動画・ナレーション音声）。
// 原本の 4K 素材は PC の uploads/ に置いたままで、ここには上げない。
//
// URL は推測困難なランダム接尾辞つきの公開 URL（Blob のプライベート配信には制限があるため）。
// 差し替えのたびに URL が変わるので、呼び出し側は古い URL を delBlob で消す（assets テーブルが現在の URL の正）。
// 画面からは `/p/<slug>/<mode>/<kind>/<rel>` で引き、cloud/routes/media.ts が 307 で飛ばす。
import {del, put} from '@vercel/blob';

/**
 * sfx と fonts は案件に属さない（slug は '_global'）。
 * sfx = 効果音ライブラリの試聴、fonts = テロップの自前フォント（PC の <設定の置き場>/fonts/ の写し）
 */
export type AssetKind = 'uploads' | 'studio' | 'out' | 'qc' | 'narration' | 'sfx' | 'fonts';
export const ASSET_KINDS: readonly AssetKind[] = ['uploads', 'studio', 'out', 'qc', 'narration', 'sfx', 'fonts'];
export const isAssetKind = (v: string): v is AssetKind => (ASSET_KINDS as readonly string[]).includes(v);

export type AssetMode = 'full' | 'light';
export const isAssetMode = (v: string): v is AssetMode => v === 'full' || v === 'light';

/** Blob 上のパス（この後ろにランダム接尾辞が付く） */
export const blobPath = (slug: string, kind: AssetKind, mode: AssetMode, relPath: string): string => `p/${slug}/${mode}/${kind}/${relPath.replace(/^\/+/, '')}`;

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export const contentTypeOf = (relPath: string): string => {
  const i = relPath.lastIndexOf('.');
  return (i >= 0 ? CONTENT_TYPES[relPath.slice(i).toLowerCase()] : undefined) ?? 'application/octet-stream';
};

/** token を省略すると環境変数 BLOB_READ_WRITE_TOKEN を使う（ワーカーは受け取った token を渡す） */
export const putBlob = async (path: string, body: Buffer | ReadableStream, contentType: string, token?: string): Promise<{url: string}> => {
  const r = await put(path, body, {access: 'public', contentType, addRandomSuffix: true, ...(token ? {token} : {})});
  return {url: r.url};
};

export const delBlob = async (url: string, token?: string): Promise<void> => {
  try {
    await del(url, token ? {token} : undefined);
  } catch {
    /* 既に無いものを消そうとしただけなら気にしない */
  }
};
