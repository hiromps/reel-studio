/** Storage に依存しないメディア契約。 */
export type AssetKind = 'uploads' | 'studio' | 'out' | 'qc' | 'narration' | 'sfx' | 'fonts';
export const ASSET_KINDS: readonly AssetKind[] = ['uploads', 'studio', 'out', 'qc', 'narration', 'sfx', 'fonts'];
export const isAssetKind = (v: string): v is AssetKind => (ASSET_KINDS as readonly string[]).includes(v);
export type AssetMode = 'full' | 'light';
export const isAssetMode = (v: string): v is AssetMode => v === 'full' || v === 'light';

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', wav: 'audio/wav', mp3: 'audio/mpeg',
  ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8', json: 'application/json',
};
export const contentTypeOf = (file: string): string => CONTENT_TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** DB は既存の url カラムを互換利用するが、値は絶対ローカルパスのみ。 */
export const isLocalMediaPath = (file: string): boolean =>
  !/[\x00-\x1f]/.test(file) && !file.split(/[\\/]/).includes('..') && (/^[A-Za-z]:[\\/]/.test(file) || /^\/(?!\/)/.test(file));

export const assertMetadataOnly = (data: unknown): void => {
  if (typeof data === 'string') {
    if (/data:(?:audio|video|image|application\/octet-stream)[^,]*[;,]/i.test(data) || (data.length > 65_536 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(data))) {
      throw new Error('バイナリはローカルファイルに保存し、DB にはパスとメタデータを指定してください');
    }
  } else if (data && typeof data === 'object') {
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer || ('type' in data && data.type === 'Buffer' && 'data' in data)) {
      throw new Error('バイナリはローカルファイルに保存してください');
    }
    for (const value of Object.values(data)) assertMetadataOnly(value);
  }
};
