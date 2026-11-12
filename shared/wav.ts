// マイク録音したナレーションを narration/<id>.wav として置くための WAV（16bit PCM）の書き出しと検査。
// ブラウザ（録音の書き出し）とサーバー（受け取った中身の検査）の両方で使う。

/** 受け付ける録音の上限（48kHz モノラル 16bit で約 4.5 分） */
export const RECORDING_MAX_BYTES = 25 * 1024 * 1024;

/** 複数チャンネルを平均してモノラルの 16bit PCM WAV にする */
export const encodeWav = (channels: Float32Array[], sampleRate: number): ArrayBuffer => {
  if (!channels.length) throw new Error('音声がありません');
  const frames = channels[0].length;
  const buf = new ArrayBuffer(44 + frames * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + frames * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // モノラル
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    const x = Math.max(-1, Math.min(1, sum / channels.length));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
};

export type WavInfo = {sampleRate: number; channels: number; bitsPerSample: number; durSec: number};

/** PCM WAV のヘッダを読む。WAV でなければ null（チャンクを順に辿るので fmt/data の間に他のチャンクがあっても読める） */
export const readWavInfo = (bytes: Uint8Array): WavInfo | null => {
  if (bytes.length < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let at = 12;
  let fmt: {format: number; channels: number; sampleRate: number; bitsPerSample: number} | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 24 <= bytes.length) {
      fmt = {format: v.getUint16(at + 8, true), channels: v.getUint16(at + 10, true), sampleRate: v.getUint32(at + 12, true), bitsPerSample: v.getUint16(at + 22, true)};
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || !fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample) return null;
      const dataBytes = Math.min(size, bytes.length - at - 8);
      const frameBytes = fmt.channels * (fmt.bitsPerSample / 8);
      return {sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, durSec: Math.round((dataBytes / frameBytes / fmt.sampleRate) * 1000) / 1000};
    }
    at += 8 + size + (size % 2);
  }
  return null;
};
