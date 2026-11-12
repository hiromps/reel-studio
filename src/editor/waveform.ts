// ナレーション音声の波形。トリミングで「どこに声があるか」を目で見るためのもの。
// 計算（純粋）と、wav を読み込んで一度だけ計算するキャッシュ付きの読み込みに分ける。

/** 1 秒あたりの山の数。タイムラインを最大に拡大しても粗く見えない程度 */
export const PEAKS_PER_SEC = 200;

export type Waveform = {
  /** 区間ごとの振幅の最大値（0〜1） */
  peaks: Float32Array;
  perSec: number;
  durSec: number;
  /** peaks の最大値。小さい録音でも見えるよう、描くときはこれで割る */
  max: number;
};

/** チャンネルをまとめて、perSec 個/秒の区間ごとに振幅の最大値を取る */
export const computePeaks = (channels: readonly Float32Array[], sampleRate: number, perSec = PEAKS_PER_SEC): Waveform => {
  const frames = channels[0]?.length ?? 0;
  const size = Math.max(1, Math.ceil((frames / sampleRate) * perSec));
  const step = sampleRate / perSec;
  const peaks = new Float32Array(size);
  let max = 0;
  for (let i = 0; i < size; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(frames, Math.floor((i + 1) * step));
    let p = 0;
    for (const ch of channels) for (let k = from; k < to; k++) {
      const v = Math.abs(ch[k]);
      if (v > p) p = v;
    }
    peaks[i] = Math.min(1, p);
    if (p > max) max = p;
  }
  return {peaks, perSec, durSec: frames / sampleRate, max: Math.min(1, max)};
};

/**
 * 波形を width 本の縦棒にまとめる（各棒は 0〜1 の高さ）。startSec〜endSec の範囲だけを描く。
 * 拡大して棒が区間より細くなっても、近い区間の値を使うので途切れない
 */
export const barsFor = (wave: Waveform, startSec: number, endSec: number, width: number): Float32Array => {
  const n = Math.max(0, Math.floor(width));
  const bars = new Float32Array(n);
  const span = Math.max(0, endSec - startSec);
  if (!n || !span || !wave.max) return bars;
  for (let x = 0; x < n; x++) {
    const a = Math.floor((startSec + (span * x) / n) * wave.perSec);
    const b = Math.max(a + 1, Math.floor((startSec + (span * (x + 1)) / n) * wave.perSec));
    let p = 0;
    for (let i = Math.max(0, a); i < Math.min(wave.peaks.length, b); i++) if (wave.peaks[i] > p) p = wave.peaks[i];
    // 小さい音も見えるよう少し持ち上げる（0.7 乗）
    bars[x] = Math.pow(p / wave.max, 0.7);
  }
  return bars;
};

const cache = new Map<string, Promise<Waveform>>();
const CACHE_LIMIT = 120;

/** wav を読んで波形にする。同じ key（id と実測尺など）は 1 回しか読まない */
export const loadWaveform = (url: string, key: string): Promise<Waveform> => {
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const res = await fetch(url, {cache: 'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    // 鳴らさないので OfflineAudioContext で足りる（ユーザー操作なしで作れる）
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(data);
    return computePeaks(Array.from({length: buf.numberOfChannels}, (_, i) => buf.getChannelData(i)), buf.sampleRate);
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return job;
};
