// 編集画面の多段トラック（映像 / テロップ / ナレーション / 効果音）の配置計算。純粋（DOM に触らない）。
// 映像トラックの配置は components/track.ts（layoutBlocks）。ここはそれ以外の段と、段をまたぐ吸着。
import type {ReelData} from '@shared/schema';
import type {Narration, NarrationSegment, Sfx} from '@shared/schema';
import {cutRanges, round3, telopGroupsOf} from '@shared/timeline';
import {isPlaceholder} from '@shared/telop-text';
import {sfxEndSec, type SfxLibrary} from '@shared/sfx';
import {OVERLAP_TOLERANCE_SEC} from '@shared/narration';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ───────────────────────── テロップ段 ─────────────────────────

/** テロップ段の 1 ブロック。group はテロップグループ（同じ文言が続くカット群）の index、無しの区間は cut だけ持つ */
export type TelopBlock =
  | {kind: 'group'; group: number; cutIndices: number[]; left: number; width: number; startSec: number; endSec: number; text: string; placeholder: boolean; orientation: 'vertical' | 'horizontal'; badge?: string}
  | {kind: 'subs'; cut: number; left: number; width: number; startSec: number; endSec: number; text: string}
  | {kind: 'none'; cut: number; left: number; width: number; startSec: number; endSec: number};

/** カット列 → テロップ段。グループの範囲は telopGroupsOf（エンジンと同一判定）、テロップの無いカットは 'none' */
export const telopBlocks = (cuts: Pick<ReelData, 'fps' | 'cuts'>, pxPerSec: number): TelopBlock[] => {
  const ranges = cutRanges(cuts);
  const out: TelopBlock[] = [];
  const covered = new Set<number>();
  telopGroupsOf(cuts).forEach((g, gi) => {
    const startSec = g.from / cuts.fps;
    const endSec = (g.from + g.dur) / cuts.fps;
    const head = cuts.cuts[g.cutIndices[0]];
    g.cutIndices.forEach((i) => covered.add(i));
    out.push({
      kind: 'group',
      group: gi,
      cutIndices: [...g.cutIndices],
      left: startSec * pxPerSec,
      width: Math.max(2, (endSec - startSec) * pxPerSec),
      startSec,
      endSec,
      text: g.def.text,
      placeholder: isPlaceholder(g.def.text),
      orientation: g.def.orientation ?? 'vertical',
      badge: head?.badge,
    });
  });
  ranges.forEach((r) => {
    if (covered.has(r.index)) return;
    const c = cuts.cuts[r.index];
    const base = {left: r.startSec * pxPerSec, width: Math.max(2, r.durSec * pxPerSec), startSec: r.startSec, endSec: r.endSec};
    if (c.subs?.length) out.push({kind: 'subs', cut: r.index, ...base, text: c.subs.map((s) => s.text).join(' / ')});
    else out.push({kind: 'none', cut: r.index, ...base});
  });
  return out.sort((a, b) => a.startSec - b.startSec);
};

// ───────────────────────── ナレーション段 ─────────────────────────

export type NarrBlock = {
  index: number;
  id: string;
  left: number;
  width: number;
  at: number;
  endSec: number;
  /** durSec が無く文字数からの見積もり */
  estimated: boolean;
  needsTts: boolean;
  /** 前のブロックの読み終わりと重なっている（許容ぶんを超えて） */
  overlap: boolean;
  /** 動画尺をはみ出す */
  overrun: boolean;
  text: string;
};

/**
 * narration.json → ナレーション段。幅は実測 durSec（無ければ estimate）。
 * index は narration.segments の添字（並べ替えていても取り違えない）。
 */
export const narrationBlocks = (narration: Narration | null, estimate: (s: NarrationSegment) => number, pxPerSec: number, videoSec?: number): NarrBlock[] => {
  if (!narration) return [];
  const sec = (s: NarrationSegment) => (s.durSec && s.durSec > 0 ? s.durSec : Math.max(0.3, estimate(s)));
  const sorted = narration.segments.map((s, index) => ({s, index})).sort((a, b) => a.s.at - b.s.at);
  const out: NarrBlock[] = [];
  let prevEnd = -Infinity;
  for (const {s, index} of sorted) {
    const dur = sec(s);
    const endSec = s.at + dur;
    const overlap = s.at < prevEnd - OVERLAP_TOLERANCE_SEC - 0.001;
    out.push({
      index,
      id: s.id,
      left: s.at * pxPerSec,
      width: Math.max(6, dur * pxPerSec),
      at: s.at,
      endSec,
      estimated: !(s.durSec && s.durSec > 0),
      needsTts: !!(s as {needsTts?: boolean}).needsTts,
      overlap,
      overrun: videoSec !== undefined && endSec > videoSec + 0.05,
      text: s.text,
    });
    prevEnd = Math.max(prevEnd, endSec);
  }
  return out;
};

// ───────────────────────── 効果音段 ─────────────────────────

export type SfxMarker = {index: number; id: string; left: number; width: number; at: number; endSec: number; label: string; role?: string; missing: boolean};

export const sfxMarkers = (sfx: readonly Sfx[] | undefined, pxPerSec: number, lib?: SfxLibrary): SfxMarker[] =>
  (sfx ?? []).map((s, index) => {
    const endSec = sfxEndSec(s, lib);
    const dur = Math.max(0, endSec - s.at);
    return {
      index,
      id: s.id,
      left: s.at * pxPerSec,
      width: Math.max(10, dur * pxPerSec),
      at: s.at,
      endSec,
      label: s.label ?? s.file,
      role: s.role,
      missing: !!lib && !lib.sounds.some((x) => x.file === s.file),
    };
  });

// ───────────────────────── 吸着・ドラッグ ─────────────────────────

/** 吸着の候補になる時刻：カットの境界（0 と各カットの終わり） */
export const cutBoundaries = (cuts: Pick<ReelData, 'fps' | 'cuts'>): number[] => {
  const r = cutRanges(cuts);
  return [0, ...r.map((x) => round3(x.endSec))];
};

/** sec を候補のどれかに吸着させる（thresholdSec 以内なら）。無ければそのまま */
export const snapToBoundaries = (sec: number, boundaries: readonly number[], thresholdSec: number): number => {
  let best = sec;
  let bestD = thresholdSec;
  for (const b of boundaries) {
    const d = Math.abs(b - sec);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return round3(best);
};

/**
 * ドラッグで動かした配置秒。0〜maxSec に収め、境界に吸着し（thresholdPx を秒に換算）、1/1000 秒に丸める。
 * 吸着はブロックの頭だけ（尻は素材の長さで決まるので動かせない）。
 */
export const draggedAt = (baseAt: number, dxPx: number, pxPerSec: number, opt: {maxSec: number; boundaries?: readonly number[]; thresholdPx?: number; snap?: boolean}): number => {
  const raw = baseAt + dxPx / Math.max(1, pxPerSec);
  const clamped = clamp(raw, 0, Math.max(0, opt.maxSec));
  if (opt.snap === false || !opt.boundaries?.length) return round3(clamped);
  return snapToBoundaries(clamped, opt.boundaries, (opt.thresholdPx ?? 8) / Math.max(1, pxPerSec));
};

/** ナレーションの at を差し替える（index は segments の添字） */
export const setNarrationAt = (n: Narration, index: number, at: number): Narration => ({
  ...n,
  segments: n.segments.map((s, k) => (k === index ? {...s, at: round3(at)} : s)),
});

export const setSfxAt = (n: Narration, index: number, at: number): Narration => ({
  ...n,
  sfx: (n.sfx ?? []).map((s, k) => (k === index ? {...s, at: round3(at)} : s)),
});

/** カット index → そのカットが始まる秒（ナレーションを「このカットの頭に置く」用） */
export const cutStartSec = (cuts: Pick<ReelData, 'fps' | 'cuts'>, index: number): number => {
  const r = cutRanges(cuts)[index];
  return r ? round3(r.startSec) : 0;
};

/** 秒 → その時刻に映っているカットの index（無ければ -1） */
export const cutIndexAtSec = (cuts: Pick<ReelData, 'fps' | 'cuts'>, sec: number): number => cutRanges(cuts).findIndex((r) => sec >= r.startSec && sec < r.endSec);
