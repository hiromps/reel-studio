// IN / OUT のドラッグトリミングの純粋ロジック（DOM に触らないので node 環境でテストできる）。
// 秒はすべて「素材内の時間」。playbackRate はタイムライン上の見え方だけを変えるのでここでは扱わない。
import {round3, snapSec} from '@shared/timeline';

/** これ以上は短くできない尺。0 秒カットや反転を防ぐ */
export const MIN_CUT_SEC = 0.2;

export type TrimRange = {inSec: number; outSec: number};
export const QUICK_TRIM_SEC = 0.8;

/** 指定した位置から約 0.8 秒の窓を作る。素材端では窓全体を内側へ寄せる。 */
export const fixedTrimRange = (startSec: number, durationSec: number, fps: number, lengthSec = QUICK_TRIM_SEC): TrimRange | null => {
  if (!Number.isFinite(durationSec) || !Number.isFinite(fps) || fps <= 0 || durationSec < lengthSec) return null;
  const frames = Math.max(1, Math.round(lengthSec * fps));
  const length = round3(frames / fps);
  if (durationSec < length) return null;
  const maxIn = round3(durationSec - length);
  const inSec = clamp(snapSec(startSec, fps), 0, maxIn);
  return {inSec, outSec: round3(inSec + length)};
};

/** 固定区間の周囲だけを帯に表示するための拡大範囲。 */
export const trimZoomView = (range: TrimRange, durationSec: number, zoomSec: number): TrimRange => {
  const span = Math.min(durationSec, Math.max(range.outSec - range.inSec, zoomSec));
  const start = clamp(range.inSec - (span - (range.outSec - range.inSec)) / 2, 0, Math.max(0, durationSec - span));
  return {inSec: round3(start), outSec: round3(start + span)};
};
/** in = 頭を掴む / out = 尻を掴む / move = 尺を保ったまま窓ごと動かす */
export type TrimHandle = 'in' | 'out' | 'move';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** バー上の x（px・左端基準）→ 素材内の秒 */
export const secAtX = (x: number, width: number, durationSec: number): number => (width <= 0 ? 0 : clamp((x / width) * durationSec, 0, durationSec));

/** 秒 → バー上の割合（0〜1）。表示位置の計算に使う */
export const ratioOf = (sec: number, durationSec: number): number => (durationSec <= 0 ? 0 : clamp(sec / durationSec, 0, 1));

/**
 * ドラッグ量（秒）を base に適用した新しい区間。
 * フレームグリッドに丸めたうえで、0〜durationSec と最小尺 MIN_CUT_SEC で挟む。
 */
export const applyTrim = (base: TrimRange, handle: TrimHandle, deltaSec: number, durationSec: number, fps: number): TrimRange => {
  const dur = Math.max(0, durationSec);
  const minLen = Math.min(MIN_CUT_SEC, dur);
  if (handle === 'in') {
    const inSec = clamp(snapSec(base.inSec + deltaSec, fps), 0, Math.max(0, round3(base.outSec - minLen)));
    return {inSec, outSec: base.outSec};
  }
  if (handle === 'out') {
    const outSec = clamp(snapSec(base.outSec + deltaSec, fps), Math.min(dur, round3(base.inSec + minLen)), dur);
    return {inSec: base.inSec, outSec};
  }
  const len = round3(base.outSec - base.inSec);
  const maxIn = Math.max(0, round3(dur - len));
  const snapped = snapSec(base.inSec + deltaSec, fps);
  // 右端まで寄せたときは末尾にぴったり付ける（フレーム丸めで数フレーム余らせない）
  if (snapped >= maxIn) return {inSec: maxIn, outSec: dur};
  const inSec = Math.max(0, snapped);
  return {inSec, outSec: round3(inSec + len)};
};

/** 矢印キーでの微調整（1 フレーム、Shift で 10 フレーム） */
export const nudgeSec = (fps: number, frames: number): number => frames / fps;

/** 素材尺が分からないとき（catalog に無い src）の代替。今の OUT より少し広く取る */
export const fallbackDuration = (r: TrimRange): number => Math.max(round3(r.outSec * 1.25), round3(r.outSec + 1), 1);
