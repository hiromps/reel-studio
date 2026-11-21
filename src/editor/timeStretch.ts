// 音程を保ったまま速さだけ変える（プレビュー用）。本番の合成は ffmpeg の atempo が行う。
// 方式は WSOLA（波形の似た位置を探して窓を重ね足す）。声のプレビューには十分な品質で、純粋関数なのでテストできる。

/**
 * channels（各チャンネルのサンプル列）を rate 倍速にした新しいサンプル列を返す。
 * rate > 1 で速く（短く）、< 1 で遅く（長く）なる。出力の長さは round(元の長さ / rate)。
 */
export const timeStretch = (channels: readonly Float32Array[], sampleRate: number, rate: number): Float32Array<ArrayBuffer>[] => {
  const len = channels[0]?.length ?? 0;
  if (!len || !Number.isFinite(rate) || rate <= 0 || Math.abs(rate - 1) < 1e-6) return channels.map((c) => c.slice());
  const outLen = Math.max(1, Math.round(len / rate));
  const N = Math.max(64, Math.round(sampleRate * 0.04)); // 窓 40ms
  const hs = Math.floor(N / 2); // 出力側の送り（50% 重ね）
  const ha = hs * rate; // 入力側の送り
  const delta = Math.round(sampleRate * 0.012); // 似た位置を探す幅 ±12ms
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // 位置合わせはモノラルにまとめた波形で 1 回だけ決め、全チャンネルに同じ位置を使う
  const mono = new Float32Array(len);
  for (const c of channels) for (let i = 0; i < len; i++) mono[i] += c[i] / channels.length;
  const at = (i: number) => (i >= 0 && i < len ? mono[i] : 0);
  const STEP = 4; // 相関の計算を間引く（速さ優先。プレビューなので十分）

  const out = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  let prev = 0; // 直前に使った入力の位置
  for (let k = 0; k * hs < outLen; k++) {
    const ideal = Math.round(k * ha);
    let pos = ideal;
    if (k > 0) {
      // 直前の窓の「自然な続き」に最も似た位置を ideal の周りで探す
      const natural = prev + hs;
      let best = -Infinity;
      for (let d = -delta; d <= delta; d += 2) {
        const cand = ideal + d;
        if (cand < 0 || cand >= len) continue;
        let sum = 0;
        for (let i = 0; i < N; i += STEP) sum += at(cand + i) * at(natural + i);
        if (sum > best) {
          best = sum;
          pos = cand;
        }
      }
    }
    const o = k * hs;
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      for (let i = 0; i < N; i++) {
        const j = pos + i;
        if (j >= 0 && j < len) dst[o + i] += src[j] * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[o + i] += win[i];
    prev = pos;
  }
  return out.map((dst) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? dst[i] / norm[i] : dst[i];
    return r;
  });
};
