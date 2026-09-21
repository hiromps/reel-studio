// Materials のタイムライン（横一列・時間比例）の純粋ロジック。DOM に触らないので node 環境でテストできる。
// 見た目（ClipTimeline.tsx）と切り離し、「秒 ⇄ px」「挿入位置」「既定の採用区間」「cuts.json の書き換え」をここに置く。
import type {Clip, Cut, ReelData, ThemeName} from '@shared/schema';
import {cutRanges, round3, snapSec} from '@shared/timeline';
import {stripStepSec} from '@shared/strip';
import {MIN_CUT_SEC} from './trim';
import {reorderBlock} from './reorder';

/**
 * 拡大率（1 秒あたりの px）の範囲。
 *
 * 下限は「**いちばん狭い画面でも全体が入る**」で決める。掴みやすさで決めてはいけない
 * —— 以前は 24 にしていたが、それだとスマホ（トラック幅およそ 310px）では 13 秒ぶんしか
 * 映らず、45 秒の動画は画面 3.5 枚分になって「全体を見る」が一生できなかった。
 * 上限の長い型（F6 = 50 秒）が 320px 幅の端末にも収まる値にしてある。
 * 掴みにくさは layoutBlocks の最低幅（2px）と、寄って作業することで吸収する。
 */
export const PX_PER_SEC_MIN = 4;
export const PX_PER_SEC_MAX = 400;
export const PX_PER_SEC_DEFAULT = 90;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const clampZoom = (v: number): number => clamp(Number.isFinite(v) ? v : PX_PER_SEC_DEFAULT, PX_PER_SEC_MIN, PX_PER_SEC_MAX);

/** 全体が幅に収まる拡大率（右端に少し余白を残す） */
export const fitPxPerSec = (totalSec: number, availPx: number, padSec = 1): number => clampZoom((Math.max(0, availPx) - 16) / Math.max(totalSec + padSec, 0.5));

/** トラック上のブロック 1 つ（px はトラック左端基準） */
export type Block = {index: number; left: number; width: number; startSec: number; durSec: number; endSec: number};

/** カット列 → ブロック配置。幅は実時間（倍速で縮む）に比例、最低 2px は確保して掴めるようにする */
export const layoutBlocks = (data: Pick<ReelData, 'fps' | 'cuts'>, pxPerSec: number): Block[] =>
  cutRanges(data).map((r) => ({
    index: r.index,
    left: r.startSec * pxPerSec,
    width: Math.max(2, r.durSec * pxPerSec),
    startSec: r.startSec,
    durSec: r.durSec,
    endSec: r.endSec,
  }));

/** トラック全体の幅（px）。末尾に 1 秒ぶんの余白を足して最後のブロックの尻を掴みやすくする */
export const trackWidth = (blocks: Block[], pxPerSec: number, padSec = 1): number => ((blocks.length ? blocks[blocks.length - 1].endSec : 0) + padSec) * pxPerSec;

/** トラック上の x（px）→ そこへ落としたときの挿入位置（0〜n）。各ブロックの中央より左なら手前 */
export const insertIndexAtX = (blocks: Block[], x: number): number => {
  for (const b of blocks) if (x < b.left + b.width / 2) return b.index;
  return blocks.length;
};

/** トラック上の x（px）→ フレーム番号（0 以上） */
export const frameAtX = (x: number, pxPerSec: number, fps: number): number => Math.max(0, Math.round((Math.max(0, x) / pxPerSec) * fps));

/** ドラッグ量（px）→ 素材内の秒。倍速カットはタイムライン上で縮んで見えるので、その分だけ素材の秒は多く進む */
export const trimDeltaSec = (dxPx: number, pxPerSec: number, playbackRate = 1): number => (dxPx / pxPerSec) * (playbackRate > 0 ? playbackRate : 1);

/** 目盛りの刻み（秒）。主目盛りの間隔が minPx 以上になる最小の刻みを選ぶ */
export const rulerStep = (pxPerSec: number, minPx = 64): number => {
  for (const s of [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60]) if (s * pxPerSec >= minPx) return s;
  return 60;
};

export type Tick = {sec: number; major: boolean};

/** 目盛り列。主目盛りは rulerStep ごと、その中間に副目盛り */
export const rulerTicks = (totalSec: number, pxPerSec: number, minMajorPx = 64): Tick[] => {
  const step = rulerStep(pxPerSec, minMajorPx);
  const minor = step / 2;
  const end = Math.max(0, totalSec) + step;
  const ticks: Tick[] = [];
  for (let k = 0; k * minor <= end + 1e-9; k++) ticks.push({sec: round3(k * minor), major: k % 2 === 0});
  return ticks;
};

/** 目盛りの文字（0.5s / 1s / 12.5s） */
export const fmtSec = (sec: number): string => {
  const r = round3(sec);
  if (Number.isInteger(r)) return `${r}s`;
  return `${r.toFixed(Number.isInteger(round3(r * 10)) ? 1 : 2)}s`;
};

/** ブロックの中に敷くストリップのコマ（left / width は % 単位） */
export type FilmCell = {src: string; left: number; width: number};

/**
 * 採用区間 [inSec, outSec] に掛かるコマだけを、素材の時間位置どおりに並べる。
 * ブロックが細くて maxCells 枚に収まらないときは先頭のコマ 1 枚で埋める。
 */
export const filmCells = (strip: string[], durationSec: number, inSec: number, outSec: number, maxCells: number): FilmCell[] => {
  if (!strip.length || !(outSec > inSec)) return [];
  const step = stripStepSec(durationSec);
  const len = outSec - inSec;
  const first = clamp(Math.floor(inSec / step + 1e-6), 0, strip.length - 1);
  const last = clamp(Math.ceil(outSec / step - 1e-6) - 1, first, strip.length - 1);
  if (last - first + 1 > Math.max(1, maxCells)) return [{src: strip[first], left: 0, width: 100}];
  const cells: FilmCell[] = [];
  for (let k = first; k <= last; k++) cells.push({src: strip[k], left: ((k * step - inSec) / len) * 100, width: (step / len) * 100});
  return cells;
};

const LABEL_ORDER: Record<string, number> = {best: 0, ok: 1, 'motion-full': 2, avoid: 9};

/** 会話・語りのクリップ（尺を切らずに全部使う） */
export const isSpeechClip = (clip: Clip): boolean => clip.tags?.hasSpeech === true || clip.tags?.kind === 'conversation' || (clip.speech?.length ?? 0) > 0;

/**
 * 素材をタイムラインに落としたときの既定の採用区間。
 * usableRanges（avoid 以外・best 優先）があればその先頭、無ければ planCuts と同じ既定（2.5 秒以上は頭尾 0.2 秒を避ける）。
 * 会話クリップ以外は maxSec で切る（あとから右端を引いて伸ばせる）。フレームグリッドに乗せて返す。
 */
export const defaultRangeFor = (clip: Clip, fps: number, maxSec: number): {inSec: number; outSec: number} => {
  const dur = clip.probe.durationSec;
  const usable = clip.usableRanges
    .filter((r) => r.label !== 'avoid' && r.outSec > r.inSec)
    .sort((a, b) => (LABEL_ORDER[a.label] ?? 5) - (LABEL_ORDER[b.label] ?? 5) || a.inSec - b.inSec);
  let inSec: number;
  let outSec: number;
  if (usable.length) {
    inSec = usable[0].inSec;
    outSec = Math.min(usable[0].outSec, dur);
  } else {
    const margin = dur >= 2.5 ? 0.2 : 0;
    inSec = margin;
    outSec = round3(dur - margin);
  }
  if (!isSpeechClip(clip) && maxSec > 0 && outSec - inSec > maxSec) outSec = inSec + maxSec;
  inSec = clamp(snapSec(inSec, fps), 0, dur);
  outSec = clamp(snapSec(outSec, fps), 0, dur);
  if (outSec - inSec < MIN_CUT_SEC) {
    outSec = Math.min(dur, round3(inSec + MIN_CUT_SEC));
    if (outSec - inSec < MIN_CUT_SEC) inSec = Math.max(0, round3(outSec - MIN_CUT_SEC));
  }
  return {inSec: round3(inSec), outSec: round3(outSec)};
};

/** 空いている最小の c01 … 形式の id（Timeline 画面の採番と同じ） */
export const newCutId = (cuts: Cut[]): string => {
  const used = new Set(cuts.map((c) => c.id));
  for (let n = 1; ; n++) {
    const id = `c${String(n).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
};

/** 素材からカットを 1 つ作る。テロップは付けない（空文字の main を付けると絵コンテのグループ判定で 1 かたまりに見えてしまう） */
export const makeCut = (clip: Clip, range: {inSec: number; outSec: number}, id: string): Cut => ({id, src: clip.src, inSec: range.inSec, outSec: range.outSec});

/** cuts.json がまだ無い案件で、最初のカットから作る。font は Settings で選んだ既定のフォント */
export const createReel = (fps: number, theme: ThemeName | undefined, first: Cut, font?: string | null): ReelData => ({
  fps,
  ...(theme ? {theme} : {}),
  ...(font ? {font} : {}),
  cuts: [first],
});

export const insertCutAt = (data: ReelData, cut: Cut, index: number): ReelData => {
  const cuts = [...data.cuts];
  cuts.splice(clamp(Math.round(index), 0, cuts.length), 0, cut);
  return {...data, cuts};
};

/** 削除。最後の 1 カットは消せない（cuts.json は 1 カット以上が前提）ので null */
export const removeCutAt = (data: ReelData, index: number): ReelData | null => {
  if (index < 0 || index >= data.cuts.length || data.cuts.length <= 1) return null;
  const target = data.cuts[index];
  const cuts = data.cuts.filter((_, k) => k !== index);
  if (!data.meta?.slots) return {...data, cuts};
  return {...data, cuts, meta: {...data.meta, slots: data.meta.slots.filter((s) => s.cutId !== target.id)}};
};

/** 並べ替え（連続ブロック [s,e] を削除前 index の to へ）。id と meta.slots はそのまま */
export const moveCuts = (data: ReelData, block: [number, number], to: number): ReelData => ({...data, cuts: reorderBlock(data.cuts, block, to)});

/** 区間だけ差し替える */
export const setCutRange = (data: ReelData, index: number, range: {inSec: number; outSec: number}): ReelData => ({
  ...data,
  cuts: data.cuts.map((c, k) => (k === index ? {...c, inSec: range.inSec, outSec: range.outSec} : c)),
});

/**
 * カットを素材内の atSec で 2 つに割る。前半が元の id と slot を持ち、後半は新しい id（テロップは両方に残す＝同じ文言が続く）。
 * 端に寄りすぎて最小尺が残らないときは null
 */
export const splitCutAt = (data: ReelData, index: number, atSec: number, fps: number): ReelData | null => {
  const c = data.cuts[index];
  if (!c) return null;
  const at = snapSec(atSec, fps);
  if (at - c.inSec < MIN_CUT_SEC || c.outSec - at < MIN_CUT_SEC) return null;
  const second: Cut = {...c, id: newCutId(data.cuts), inSec: at};
  delete (second as {badge?: string}).badge; // バッジはグループ先頭にだけ出すもの
  const first: Cut = {...c, outSec: at};
  const cuts = [...data.cuts];
  cuts.splice(index, 1, first, second);
  return {...data, cuts};
};

/** タイムライン上の秒（そのカットの頭からの実時間）→ 素材内の秒 */
export const sourceSecAt = (cut: Cut, offsetSec: number): number => round3(cut.inSec + Math.max(0, offsetSec) * (cut.playbackRate ?? 1));

/** src ごとの使用回数（素材グリッドの「使用中」バッジ）。alias コピーは元の src に寄せる */
export const usageBySrc = (data: Pick<ReelData, 'cuts'> | null, resolve: (src: string) => string = (s) => s): Map<string, number> => {
  const m = new Map<string, number>();
  for (const c of data?.cuts ?? []) {
    const k = resolve(c.src);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};
