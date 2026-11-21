// プレビュー再生に合わせて、生成済みのナレーション wav と効果音を鳴らすための計算（純粋。Web Audio には触らない）。
// レンダー（Remotion）には手を入れない：narration は mix 工程で載せるものなので、エンジンに入れると二重になる。
// ここで出した「いつ・どこから・どれだけ鳴らすか」を useMixPreview が AudioBufferSourceNode に渡す。
import type {Narration, NarrationSegment, Sfx} from '@shared/schema';
import {NARRATION_GAIN_DB_DEFAULT} from '@shared/schema';
import {sfxEndSec, type SfxLibrary} from '@shared/sfx';
import {narrationRate} from '@shared/narration';

export type MixClip = {
  /** キャッシュのキー（同じ id でも wav を作り直したら変わるよう durSec を含める） */
  key: string;
  url: string;
  kind: 'narr' | 'sfx';
  id: string;
  /** 動画の先頭からの配置秒 */
  at: number;
  /** 線形ゲイン */
  gain: number;
  /** 使う範囲の終わり（wav の頭からの秒）。無ければ wav の全長 */
  trimSec?: number;
  /** 使う範囲の始まり（wav の頭から飛ばす秒）。無ければ 0 */
  startSec?: number;
  fadeOutSec?: number;
  /** 再生速度（1 以外なら読み込み時に音程を保って伸縮する。trimSec/startSec は伸縮後の秒） */
  rate?: number;
};

/** ナレーションの基準音量。mix-narration.js は声を -14 LUFS に揃えるが、プレビューはおおよそでよい */
export const NARR_BASE_GAIN = 0.9;
/** 環境音（素材の音）の既定。mix-narration.js の volume=0.22 と同じ */
export const AMBIENT_DEFAULT = 0.22;
/** これ以上ずれたら鳴らし直す（秒）。Player の frameupdate は 1 コマごとに来るので 0.25 秒あれば十分 */
export const DRIFT_TOLERANCE_SEC = 0.25;

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

const wavReady = (s: NarrationSegment): boolean => !(s as {needsTts?: boolean}).needsTts && !!s.durSec && s.durSec > 0 && (!!s.text.trim() || !!s.recorded);

/**
 * narration.json から鳴らす候補を作る。**音声が未生成（needsTts）のブロックは鳴らさない**
 * （古い wav が残っていても別の文言なので）。効果音はライブラリに音源があるものだけ。
 */
export const mixClipsOf = (narration: Narration | null, mediaBase: string | null, lib?: SfxLibrary | null): MixClip[] => {
  if (!narration || !mediaBase) return [];
  const out: MixClip[] = [];
  const narrGain = NARR_BASE_GAIN * dbToGain(narration.narrationGainDb ?? NARRATION_GAIN_DB_DEFAULT);
  for (const s of narration.segments) {
    if (!wavReady(s)) continue;
    // 速度を変えたブロックは伸縮後のバッファで鳴らすので、使う範囲も伸縮後の秒に直す
    const rate = narrationRate(s);
    out.push({
      key: `narr:${s.id}:${s.durSec}${rate !== 1 ? `:x${rate}` : ''}`,
      url: `${mediaBase}/narration/${encodeURIComponent(s.id)}.wav`,
      kind: 'narr',
      id: s.id,
      at: s.at,
      gain: narrGain * dbToGain(s.gainDb ?? 0),
      trimSec: s.trimSec !== undefined ? s.trimSec / rate : undefined,
      startSec: s.startSec !== undefined ? s.startSec / rate : undefined,
      ...(rate !== 1 ? {rate} : {}),
    });
  }
  const sfxGain = dbToGain(narration.sfxGainDb ?? 0);
  for (const x of narration.sfx ?? []) {
    if (lib && !lib.sounds.some((y) => y.file === x.file)) continue;
    out.push({
      key: `sfx:${x.file}`,
      url: `/api/sfx/file/${x.file.split('/').map(encodeURIComponent).join('/')}`,
      kind: 'sfx',
      id: x.id,
      at: x.at,
      gain: sfxGain * dbToGain(x.gainDb ?? 0),
      trimSec: x.trimSec,
      fadeOutSec: x.fadeOutSec,
    });
  }
  return out.sort((a, b) => a.at - b.at);
};

/** まだ wav が無い（要再生成）ブロックの数。表示用 */
export const pendingNarration = (narration: Narration | null): number => (narration?.segments ?? []).filter((s) => s.text.trim() && !wavReady(s)).length;

export type PlaybackItem = {
  key: string;
  /** いまから何秒後に始めるか（0 = すぐ） */
  delaySec: number;
  /** バッファの何秒目から始めるか */
  offsetSec: number;
  /** 何秒鳴らすか */
  durationSec: number;
  gain: number;
  fadeOutSec: number;
};

/**
 * 再生ヘッドが mediaSec にあるとき、各クリップをどう鳴らすか。
 * 既に鳴り終わっているものは省く。途中から再生する場合は offset で頭を飛ばす。
 */
export const planPlayback = (clips: readonly MixClip[], bufferSec: (key: string) => number | undefined, mediaSec: number): PlaybackItem[] => {
  const out: PlaybackItem[] = [];
  for (const c of clips) {
    const full = bufferSec(c.key);
    if (full === undefined || full <= 0) continue;
    const stop = Math.min(full, c.trimSec && c.trimSec > 0 ? c.trimSec : full);
    const head = Math.min(Math.max(0, c.startSec ?? 0), stop);
    const len = stop - head;
    const end = c.at + len;
    if (end <= mediaSec + 0.001) continue;
    const offset = Math.max(0, mediaSec - c.at);
    out.push({
      key: c.key,
      delaySec: Math.max(0, c.at - mediaSec),
      offsetSec: head + offset,
      durationSec: Math.max(0, len - offset),
      gain: c.gain,
      fadeOutSec: Math.min(c.fadeOutSec ?? 0, Math.max(0, len - offset)),
    });
  }
  return out;
};

/** 前回の同期点からの予測位置と、Player の実際の位置がずれているか */
export const driftExceeded = (anchor: {ctxSec: number; mediaSec: number} | null, ctxNowSec: number, mediaSec: number, tolerance = DRIFT_TOLERANCE_SEC): boolean => {
  if (!anchor) return true;
  const expected = anchor.mediaSec + (ctxNowSec - anchor.ctxSec);
  return Math.abs(expected - mediaSec) > tolerance;
};

/** 効果音の鳴り終わり（表示用の補助。sfxEndSec と同じ） */
export const sfxEnd = (s: Sfx, lib?: SfxLibrary): number => sfxEndSec(s, lib);
