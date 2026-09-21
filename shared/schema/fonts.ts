// 自前フォント（テロップ用）の決まりごと。fs に触らないので画面・クラウドからも読める。
//
// 実体の置き場は <設定の置き場>/fonts/（core/fonts.ts）。案件で使うときは、そこから
// 案件の public/fonts/ へ配る。エンジン（engine/src/telops.tsx）は cuts.json の `font`
// （＝ここで言う file）を見て `staticFile('fonts/<file>')` を読み込む。

/** 受け付ける拡張子。Remotion（Chrome）が FontFace で読めるもの */
export const FONT_EXTS = ['.ttf', '.otf', '.ttc', '.woff2', '.woff'] as const;

/** 1 ファイルの上限（日本語フォントは 5〜20MB 程度） */
export const FONT_MAX_BYTES = 40 * 1024 * 1024;

export type FontEntry = {
  /** <設定の置き場>/fonts/ の中のファイル名。cuts.json の font にはこれを書く */
  file: string;
  /** 画面に出す名前（拡張子を落としたもの） */
  label: string;
  /** エンジンが FontFace に登録する名前 */
  family: string;
  sizeBytes: number;
  /** ファイルの更新時刻（＝取り込んだ時刻） */
  addedAt: string;
};

export const fontExt = (file: string): string => {
  const i = file.lastIndexOf('.');
  return i < 0 ? '' : file.slice(i).toLowerCase();
};

export const isFontFileName = (file: string): boolean => (FONT_EXTS as readonly string[]).includes(fontExt(file));

/** 拡張子を落とした表示名 */
export const fontLabelOf = (file: string): string => file.replace(/\.[^.]+$/, '');

/**
 * FontFace に登録する名前。**engine/src/telops.tsx の customFontFamily と同じ規則**
 * （エンジンは案件フォルダへコピーされる独立したコードなので、shared を import できない）。
 */
export const fontFamilyOf = (file: string): string => `reel-font-${fontLabelOf(file)}`;

/**
 * 受け取ったファイル名を、そのまま置き場に書ける形にする。
 * パスを含む名前（"../" や "C:\...")で置き場の外に出られないようにするのが主目的。
 */
export const safeFontFile = (name: string): string =>
  (name ?? '')
    .normalize('NFC')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f"'<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);

/** 中身がフォントか（拡張子だけでは判断しない）。先頭 4 バイトの署名で見る */
export const looksLikeFont = (head: Uint8Array): boolean => {
  if (head.length < 4) return false;
  const tag = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (tag === 'OTTO' || tag === 'true' || tag === 'ttcf' || tag === 'wOFF' || tag === 'wOF2') return true;
  // TrueType の 0x00010000
  return head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00;
};

/** 保存してよいかを確かめる。だめなら理由（日本語）を返す */
export const checkFontUpload = (file: string, bytes: number, head: Uint8Array): string | null => {
  if (!file) return 'ファイル名がありません';
  if (!isFontFileName(file)) return `対応していない拡張子です（${FONT_EXTS.join(' / ')} のいずれか）: ${file}`;
  if (bytes <= 0) return 'ファイルが空です';
  if (bytes > FONT_MAX_BYTES) return `ファイルが大きすぎます（${Math.round(bytes / 1024 / 1024)}MB。上限 ${FONT_MAX_BYTES / 1024 / 1024}MB）`;
  if (!looksLikeFont(head)) return 'フォントファイルではないようです（中身が ttf / otf / ttc / woff / woff2 のどれでもありません）';
  return null;
};
