// ストリップ（1 秒刻みのコマ画像）の間引き率。core/thumbnails.ts（生成）と GUI（表示位置の逆算）で同じ式を使う。
// ffmpeg の fps フィルタは k 枚目を k/fps 秒に出すので、表示側は 1/stripFps(尺) 秒刻みでコマを置けばよい。

/**
 * 間引き率（枚/秒）。fps フィルタは尺が 1/fps より短いと 1 枚も出さず、
 * その場合 ffmpeg は「フィルタ済みフレーム無し」のまま mjpeg エンコーダを開こうとして
 * 素材の range:tv を弾き -22 (Invalid argument) で落ちる。尺から最低 3 枚出る率を出す。
 */
export const stripFps = (durationSec: number): number => {
  if (!(durationSec > 0)) return 1;
  if (durationSec >= 3) return 1;
  return Math.min(60, Math.max(2, Math.ceil(3 / durationSec)));
};

/** ストリップ k 枚目が受け持つ秒数（k 枚目は k*step 秒から始まる） */
export const stripStepSec = (durationSec: number): number => 1 / stripFps(durationSec);
