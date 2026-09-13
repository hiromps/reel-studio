// トライアルリール：冒頭のフックだけを差し替えた複数バージョン。純粋（ファイルも ffmpeg も触らない）。
//
// フック以外は同じものを出すのが要件（比べる対象を 1 つに絞らないと、どれが効いたか分からない）。
// **差し替えるのは冒頭 3 カット**が既定。1 カット（1 秒前後）だけ変えても見た印象がほとんど
// 変わらず、A/B の差が出ないため（2026-09-12 のユーザー指示）。
import {z} from 'zod';
import type {ReelData} from './schema/cuts';
import type {Narration} from './schema/narration';

/** フック区間の segment id（format-specs 共通で 1_hook） */
export const HOOK_SEGMENT = '1_hook';

/** 差し替える冒頭カット数の既定 */
export const DEFAULT_HOOK_CUTS = 3;

export const HookVariantSchema = z.object({
  /** A / B / C。ファイル名に入る（`_フックA`） */
  id: z.string().regex(/^[A-Za-z0-9]{1,4}$/, 'id は英数字 1〜4 文字（A / B / C など）'),
  /** 何を試すパターンなのかのメモ（画面に出るだけ） */
  label: z.string().default(''),
  /**
   * カットごとのテロップ。i 番目が冒頭 i 番目のカットに入る。
   * 空文字のところと、配列が足りないぶんのカットは**今の文言のまま**。
   */
  telops: z.array(z.string()).default([]),
  /** カットごとの差し替え素材（catalog の clipId）。空文字は今のまま */
  clipIds: z.array(z.string()).default([]),
  /** バッジ（エリア名）。フック 1 枚目に出す。null で消す、省略で今のまま */
  badge: z.string().nullable().optional(),
  /** 1 本目のナレーション文。空なら今のまま */
  narration: z.string().default(''),
});
export type HookVariant = z.infer<typeof HookVariantSchema>;

export const HooksSchema = z.object({
  version: z.literal(1).default(1),
  /** 差し替える冒頭カット数 */
  cutCount: z.number().int().min(1).max(6).default(DEFAULT_HOOK_CUTS),
  variants: z.array(HookVariantSchema).default([]),
});
export type Hooks = z.infer<typeof HooksSchema>;

/**
 * 差し替え対象のカット番号（0 始まり）。
 * **冒頭から count カット**を対象にする。`meta.slots` の `1_hook` がそれより長ければそちらに合わせる
 * （型がフックを 4 カット取っているのに 3 カットだけ変える、というちぐはぐを避ける）。
 */
export const hookCutIndices = (cuts: ReelData, count = DEFAULT_HOOK_CUTS): number[] => {
  const n = cuts.cuts.length;
  if (!n) return [];
  const slots = cuts.meta?.slots ?? [];
  const bySegment = cuts.cuts.map((_, i) => i).filter((i) => (slots[i] as {segment?: string} | undefined)?.segment === HOOK_SEGMENT);
  const span = Math.min(n, Math.max(count, bySegment.length));
  return Array.from({length: span}, (_, i) => i);
};

/**
 * バリアントを当てた cuts を作る（元は書き換えない）。
 * テロップも素材も**カットごと**に指定する。指定が無いカットは今のまま残すので、
 * 「1 枚目だけ変える」「3 枚とも変える」のどちらもできる。
 */
export const applyHookVariant = (
  cuts: ReelData,
  v: HookVariant,
  opt: {count?: number; clipOf?: (clipId: string) => {src: string; durationSec?: number} | undefined} = {},
): {cuts: ReelData; changes: string[]} => {
  const changes: string[] = [];
  const idx = hookCutIndices(cuts, opt.count);
  if (!idx.length) return {cuts, changes};
  const next: ReelData = {...cuts, cuts: cuts.cuts.map((c) => ({...c}))};

  idx.forEach((cutIndex, i) => {
    const c = next.cuts[cutIndex];
    const text = (v.telops[i] ?? '').trim();
    if (text) {
      c.main = {...(c.main ?? {}), text};
      changes.push(`${i + 1}枚目「${text}」`);
    }
    const clipId = (v.clipIds[i] ?? '').trim();
    if (clipId) {
      const clip = opt.clipOf?.(clipId);
      if (clip) {
        const keep = c.outSec - c.inSec; // 尺は保つ（合計尺を変えないため）
        c.src = clip.src;
        c.inSec = 0;
        c.outSec = clip.durationSec ? Math.min(clip.durationSec, keep) : keep;
        changes.push(`${i + 1}枚目の素材 ${clip.src.replace(/^uploads\//, '')}`);
      }
    }
  });

  // バッジはフック 1 枚目だけ（エリア名を本文から出す用途）
  if (v.badge !== undefined) {
    const head = next.cuts[idx[0]];
    if (v.badge === null || v.badge === '') delete (head as {badge?: string}).badge;
    else head.badge = v.badge;
    changes.push(v.badge ? `バッジ「${v.badge}」` : 'バッジなし');
  }
  return {cuts: next, changes};
};

/** ナレーション 1 本目の id（at が最小のもの） */
export const firstNarrationId = (narration: Narration): string | null =>
  [...narration.segments].sort((a, b) => a.at - b.at)[0]?.id ?? null;

/**
 * バリアント用の narration を作る。1 本目だけ文言と id を差し替える
 * （id を変えるのは、共有の narration/ フォルダで wav がぶつからないようにするため）。
 */
export const applyHookNarration = (narration: Narration, v: HookVariant): {narration: Narration; wavId: string | null} => {
  if (!v.narration.trim()) return {narration, wavId: null};
  const firstId = firstNarrationId(narration);
  if (!firstId) return {narration, wavId: null};
  const wavId = `${firstId}__${v.id}`;
  return {
    narration: {
      ...narration,
      segments: narration.segments.map((s) => (s.id === firstId ? {...s, id: wavId, text: v.narration.trim(), needsTts: true, durSec: undefined} : s)),
    },
    wavId,
  };
};

export type HookIssue = {severity: 'E' | 'W'; code: string; message: string};

/** そのバリアントが何かを変えているか */
export const variantTouches = (v: HookVariant): boolean =>
  v.telops.some((t) => t.trim()) || v.clipIds.some((c) => c.trim()) || !!v.narration.trim() || v.badge !== undefined;

/** 比較の対象になっているか（同じ内容が 2 つあっても意味がない） */
const variantKey = (v: HookVariant): string => `${v.telops.map((t) => t.trim()).join('|')}#${v.clipIds.map((c) => c.trim()).join('|')}#${v.narration.trim()}#${v.badge ?? '-'}`;

/** 「フック以外は同じ」を守れているかの点検 */
export const checkHooks = (hooks: Hooks, opt: {cuts?: ReelData; maxTelopChars?: number} = {}): HookIssue[] => {
  const out: HookIssue[] = [];
  const vs = hooks.variants;
  if (vs.length < 2) out.push({severity: 'W', code: 'HOOK_TOO_FEW', message: '比べるには 2 パターン以上が要ります'});
  const span = opt.cuts ? hookCutIndices(opt.cuts, hooks.cutCount).length : hooks.cutCount;
  const ids = new Set<string>();
  for (const v of vs) {
    if (ids.has(v.id)) out.push({severity: 'E', code: 'HOOK_DUP_ID', message: `id が重複しています: ${v.id}`});
    ids.add(v.id);
    if (!variantTouches(v)) out.push({severity: 'E', code: 'HOOK_EMPTY', message: `${v.id}: 何も変えていません（テロップ・素材・ナレーションのどれかを入れる）`});
    if (v.telops.length > span) out.push({severity: 'W', code: 'HOOK_OVER_SPAN', message: `${v.id}: ${v.telops.length} 枚分の文言がありますが、差し替えるのは ${span} カットまでです`});
    const max = opt.maxTelopChars ?? 13;
    v.telops.forEach((t, i) => {
      const s = t.trim();
      if (s && [...s].length > max) out.push({severity: 'W', code: 'HOOK_TELOP_LONG', message: `${v.id} の ${i + 1} 枚目: ${[...s].length} 文字（目安 ${max} 文字）`});
      if (/[。]$/.test(s)) out.push({severity: 'W', code: 'HOOK_TELOP_PERIOD', message: `${v.id} の ${i + 1} 枚目: テロップの文末に句点は付けない`});
    });
    // 1 枚目しか変えていないと、視聴者にはほとんど違いが分からない
    const changed = v.telops.filter((t) => t.trim()).length + v.clipIds.filter((c) => c.trim()).length;
    if (changed === 1 && span > 1 && !v.narration.trim())
      out.push({severity: 'W', code: 'HOOK_ONLY_ONE_CUT', message: `${v.id}: 1 カットしか変えていません。冒頭 ${span} カットぶん変えないと違いが伝わりにくいです`});
  }
  const seen = new Map<string, string>();
  for (const v of vs) {
    const dup = seen.get(variantKey(v));
    if (dup) out.push({severity: 'W', code: 'HOOK_SAME', message: `${dup} と ${v.id} は中身が同じです`});
    else seen.set(variantKey(v), v.id);
  }
  if (opt.cuts && !hookCutIndices(opt.cuts, hooks.cutCount).length) out.push({severity: 'E', code: 'HOOK_NO_CUT', message: 'cuts.json にカットがありません'});
  return out;
};
