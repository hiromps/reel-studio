// 勝ちパターンの二次活用：トライアルで伸びた 1 本を、**締めの一言だけ変えて 1.1 倍速で出し直す**。純粋。
//
// ユーザーの運用ルール（2026-09-14）:
//   - 最後の一言（締めのテロップ／ナレーション）のみ変更する
//   - 動画全体を 1.1 倍速で書き出し直す
//   - キャプションを新しく書く（同じ文面での再投稿は使い回しになる）
//   - 新しいトライアルリールとして再投稿する
// 映像の中身（並び・素材・締め以外のテロップ）は変えない。変えるのは締めと速度だけ。
import type {ReelData} from './schema/cuts';
import type {Narration} from './schema/narration';
import {countChars} from './telop-text';

/** 書き出し直す倍速の既定 */
export const DEFAULT_WINNER_SPEED = 1.1;
/** 倍速の許容範囲（1.0 未満は遅くなるだけ、1.5 超は声が不自然） */
export const WINNER_SPEED_RANGE: readonly [number, number] = [1.0, 1.5];

/**
 * 締めのテロップが乗っているカット番号（0 始まり）。
 * 末尾から見て、main を持つ最後のカットと同じ文言が続く範囲（＝最後のテロップグループ）。
 */
export const tailCutIndices = (cuts: ReelData): number[] => {
  let last = cuts.cuts.length - 1;
  while (last >= 0 && !cuts.cuts[last].main?.text?.trim()) last--;
  if (last < 0) return [];
  const text = cuts.cuts[last].main!.text.trim();
  const idx = [last];
  for (let i = last - 1; i >= 0; i--) {
    if ((cuts.cuts[i].main?.text ?? '').trim() === text) idx.unshift(i);
    else break;
  }
  return idx;
};

/** いまの締めテロップ（無ければ空） */
export const tailTelopOf = (cuts: ReelData): string => {
  const idx = tailCutIndices(cuts);
  return idx.length ? (cuts.cuts[idx[0]].main?.text ?? '').trim() : '';
};

/** 締めテロップだけ差し替えた cuts（元は書き換えない） */
export const applyTailTelop = (cuts: ReelData, text: string): {cuts: ReelData; cutIds: string[]; before: string} => {
  const t = text.trim();
  const idx = tailCutIndices(cuts);
  const before = idx.length ? (cuts.cuts[idx[0]].main?.text ?? '') : '';
  if (!t || !idx.length) return {cuts, cutIds: [], before};
  const next: ReelData = {...cuts, cuts: cuts.cuts.map((c) => ({...c}))};
  for (const i of idx) next.cuts[i] = {...next.cuts[i], main: {...(next.cuts[i].main ?? {}), text: t}};
  return {cuts: next, cutIds: idx.map((i) => next.cuts[i].id ?? `#${i + 1}`), before};
};

/** 最後のナレーションブロック（at が最大） */
export const lastNarrationId = (narration: Narration): string | null => [...narration.segments].sort((a, b) => a.at - b.at).at(-1)?.id ?? null;

/**
 * 締めのナレーションだけ差し替えた narration。id を `<元id>__W<suffix>` に変えて wav がぶつからないようにする。
 * 空なら何もしない。
 */
export const applyTailNarration = (narration: Narration, text: string, suffix: string): {narration: Narration; wavId: string | null; before: string; at: number | null} => {
  const t = text.trim();
  const lastId = lastNarrationId(narration);
  if (!t || !lastId) return {narration, wavId: null, before: '', at: null};
  const wavId = `${lastId}__W${suffix}`;
  const last = narration.segments.find((s) => s.id === lastId)!;
  return {
    narration: {...narration, segments: narration.segments.map((s) => (s.id === lastId ? {...s, id: wavId, text: t, needsTts: true, durSec: undefined} : s))},
    wavId,
    before: last.text,
    at: last.at,
  };
};

/** 締めナレーションに使える文字数の目安（最後のブロック開始から動画の終わりまで × 話速 × 0.9） */
export const tailNarrationBudget = (narration: Narration, videoSec: number, charsPerSec: number): number => {
  const lastId = lastNarrationId(narration);
  const last = narration.segments.find((s) => s.id === lastId);
  if (!last) return 0;
  return Math.max(0, Math.floor((videoSec - last.at) * charsPerSec * 0.9));
};

export type WinnerIssue = {severity: 'E' | 'W'; code: string; message: string};

/** 二次活用の指定の点検（「締めだけ変える」「文面を変える」「倍速の範囲」） */
export const checkWinner = (o: {
  tailTelop: string;
  prevTelop: string;
  tailNarration: string;
  prevNarration: string;
  caption: string;
  prevCaption: string;
  speed: number;
  ctaPatterns?: readonly string[];
  maxTelopChars?: number;
}): WinnerIssue[] => {
  const out: WinnerIssue[] = [];
  const telop = o.tailTelop.trim();
  const max = o.maxTelopChars ?? 13;
  if (!telop) out.push({severity: 'E', code: 'TAIL_TELOP_EMPTY', message: '締めのテロップが空です'});
  else {
    if (telop === o.prevTelop.trim()) out.push({severity: 'E', code: 'TAIL_TELOP_SAME', message: `締めのテロップが今と同じです（「${telop}」）。二次活用は締めを変えるのが決まり`});
    if (countChars(telop) > max) out.push({severity: 'W', code: 'TAIL_TELOP_LONG', message: `締めのテロップが ${countChars(telop)} 文字（目安 ${max} 文字）`});
    if (/[。]$/.test(telop)) out.push({severity: 'W', code: 'TAIL_TELOP_PERIOD', message: 'テロップの文末に句点は付けない'});
    if (o.ctaPatterns?.length && !o.ctaPatterns.some((p) => telop.includes(p)))
      out.push({severity: 'W', code: 'TAIL_NOT_CTA', message: `締めが来店を促す言い回し（${o.ctaPatterns.join('／')}）になっていません`});
  }
  const narr = o.tailNarration.trim();
  if (narr && narr === o.prevNarration.trim()) out.push({severity: 'W', code: 'TAIL_NARRATION_SAME', message: '締めのナレーションが今と同じです'});
  if (/[\r\n]/.test(narr)) out.push({severity: 'E', code: 'TAIL_NARRATION_MULTILINE', message: '締めのナレーションに改行があります（1 ブロック 1 文）'});
  const cap = o.caption.trim();
  if (cap && cap === o.prevCaption.trim()) out.push({severity: 'W', code: 'CAPTION_SAME', message: 'キャプションが元と同じ文面です（同じ文面での再投稿は使い回しになる）'});
  if (!(o.speed >= WINNER_SPEED_RANGE[0] && o.speed <= WINNER_SPEED_RANGE[1]))
    out.push({severity: 'E', code: 'SPEED_RANGE', message: `倍速 ${o.speed} は範囲外（${WINNER_SPEED_RANGE[0]}〜${WINNER_SPEED_RANGE[1]}）`});
  return out;
};

/** 倍速後の尺 */
export const spedUpSec = (sec: number, speed: number): number => Math.round((sec / speed) * 1000) / 1000;
