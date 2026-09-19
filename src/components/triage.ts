// 選別モードで素材を編集するときの純粋な部分（DOM に触らないので node でテストできる）。
//
// 「使える区間（usableRanges）」は 0 個でも複数でもよいが、選別しながら決めるのは
// **いま使いたい 1 区間**だけ。それを「主区間」と呼び、avoid 以外の最初のものとする
// （avoid は「ここは使わない」の指定なので、掴んで動かす対象にしない）。
import type {Clip, UsableRange} from '@shared/schema';

/** 主区間の位置。無ければ -1 */
export const primaryRangeIndex = (c: Clip): number => c.usableRanges.findIndex((r) => r.label !== 'avoid');

export const primaryRange = (c: Clip): UsableRange | null => {
  const i = primaryRangeIndex(c);
  return i >= 0 ? c.usableRanges[i] : null;
};

/**
 * 帯を掴んで決めた区間を入れる。主区間が無ければ「見せ場（best）」として作る
 * —— 選別中にわざわざ区間を作ってから動かす、という 2 手間を無くすため。
 */
export const withRange = (c: Clip, next: {inSec: number; outSec: number}): Clip => {
  const i = primaryRangeIndex(c);
  if (i >= 0) return {...c, usableRanges: c.usableRanges.map((r, k) => (k === i ? {...r, ...next} : r))};
  return {...c, usableRanges: [{...next, label: 'best'}, ...c.usableRanges]};
};

/** 主区間の扱い（best / ok / motion-full / avoid）を変える。無ければ今の範囲で作る */
export const withRangeLabel = (c: Clip, label: UsableRange['label'], fallback: {inSec: number; outSec: number}): Clip => {
  const i = primaryRangeIndex(c);
  if (i >= 0) return {...c, usableRanges: c.usableRanges.map((r, k) => (k === i ? {...r, label} : r))};
  return {...c, usableRanges: [{...fallback, label}, ...c.usableRanges]};
};

/** 主区間の指定をやめる（全尺から使う状態に戻す） */
export const withoutPrimaryRange = (c: Clip): Clip => {
  const i = primaryRangeIndex(c);
  return i >= 0 ? {...c, usableRanges: c.usableRanges.filter((_, k) => k !== i)} : c;
};

/** 帯に出す IN / OUT。区間が無ければ全尺（掴んだ瞬間にそこから区間になる） */
export const rangeForBar = (c: Clip): {inSec: number; outSec: number} => {
  const r = primaryRange(c);
  const dur = c.probe.durationSec;
  if (!r) return {inSec: 0, outSec: dur};
  return {inSec: Math.max(0, Math.min(r.inSec, dur)), outSec: Math.min(r.outSec, dur)};
};

/** 未タグのクリップにも書けるよう、既定値を敷いてから patch を当てる */
export const withTags = (c: Clip, patch: Partial<NonNullable<Clip['tags']>>, now = new Date().toISOString()): Clip => ({
  ...c,
  tags: {
    kind: 'other',
    signage: false,
    signageSize: 'none',
    angle: 'mid',
    motion: 'handheld',
    sizzleScore: 3,
    quality: 3,
    hasSpeech: false,
    subject: '',
    description: c.slug,
    ...(c.tags ?? {}),
    ...patch,
    source: 'user',
    taggedAt: now,
  },
});
