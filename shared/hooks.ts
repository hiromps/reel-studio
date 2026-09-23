// トライアルリール：冒頭のフックだけを差し替えた複数バージョン。純粋（ファイルも ffmpeg も触らない）。
//
// フック以外は同じものを出すのが要件（比べる対象を 1 つに絞らないと、どれが効いたか分からない）。
// **差し替えるのは冒頭 3 カット**が既定。1 カット（1 秒前後）だけ変えても見た印象がほとんど
// 変わらず、A/B の差が出ないため（2026-09-12 のユーザー指示）。
//
// キャプションは**パターンごとに文面を変える**（2026-09-14 のユーザー指示）。同じ文面で複数投稿すると
// Instagram に使い回しとして扱われるため。空なら共通の caption.txt を使う。
import {z} from 'zod';
import type {ReelData} from './schema/cuts';
import type {Narration} from './schema/narration';
import {countChars, normalizeEllipsis} from './telop-text';
import {cutDurationSec} from './timeline';

/** フック区間の segment id（format-specs 共通で 1_hook） */
export const HOOK_SEGMENT = '1_hook';

/** 差し替える冒頭カット数の既定 */
export const DEFAULT_HOOK_CUTS = 3;

/** 差し替え範囲の上限（カット数・秒）。「冒頭 3〜5 秒」の指示に合わせる */
export const MAX_HOOK_CUTS = 6;
export const MAX_HOOK_SEC = 5.5;

export const HookVariantSchema = z.object({
  /** A / B / C。ファイル名に入る（`_フックA`） */
  id: z.string().regex(/^[A-Za-z0-9]{1,4}$/, 'id は英数字 1〜4 文字（A / B / C など）'),
  /** 何を試すパターンなのかのメモ（画面に出るだけ） */
  label: z.string().default(''),
  /** 切り口（疑問形 / 結果先出し / 煽り・警告形 など）。画面と納品ログに出るだけ */
  angle: z.string().default(''),
  /**
   * カットごとのテロップ。i 番目が冒頭 i 番目のカットに入る。
   * 空文字のところと、配列が足りないぶんのカットは**今の文言のまま**。
   */
  telops: z.array(z.string()).default([]),
  /** カットごとの差し替え素材（catalog の clipId）。空文字は今のまま */
  clipIds: z.array(z.string()).default([]),
  /** バッジ（エリア名）。フック 1 枚目に出す。null で消す、省略で今のまま */
  badge: z.string().nullable().optional(),
  /** フック区間のナレーション文（区間に始まるブロックを 1 本にまとめて差し替える）。空なら今のまま */
  narration: z.string().default(''),
  /** このパターン専用のキャプション。空なら共通の caption.txt を使う */
  caption: z.string().default(''),
});
export type HookVariant = z.infer<typeof HookVariantSchema>;

export const HooksSchema = z.object({
  version: z.literal(1).default(1),
  /** 差し替える冒頭カット数 */
  cutCount: z.number().int().min(1).max(MAX_HOOK_CUTS).default(DEFAULT_HOOK_CUTS),
  variants: z.array(HookVariantSchema).default([]),
});
export type Hooks = z.infer<typeof HooksSchema>;

/**
 * トライアルリールの投稿の運用ルール（ユーザー指示・2026-09-14）。画面と README と CLI で同じ文を出す。
 * ここに書いてあることは Instagram 側の操作なので、ツールは代行できない＝忘れないように毎回見せる。
 */
export const TRIAL_POSTING_RULES = [
  '投稿は 18:00 / 19:00 / 20:00 の 1 時間おきに、A → B → C の順で 3 本',
  'トライアル設定の「全員に自動的にシェア」を必ず OFF にする',
  '投稿後は最低 24 時間空けてから、保存率・再生数で伸びを比べる',
  '一番伸びたパターンだけ「全員にシェア」で全フォロワーに展開する',
  '伸びた 1 本が出たら「勝ちパターンの二次活用」：締めの一言だけ変えて 1.1 倍速で書き出し、キャプションを新しく書いて、新しいトライアルとして再投稿する',
] as const;

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

/** 差し替え範囲の秒数（冒頭 idx.length カットの合計） */
export const hookSpanSec = (cuts: ReelData, count = DEFAULT_HOOK_CUTS): number =>
  hookCutIndices(cuts, count).reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0);

/**
 * 差し替え範囲を**テロップの切れ目に合わせて**伸ばす。
 * 同じ文言が続くカット（＝1 つのテロップグループ）の途中で範囲が切れると、
 * 前半だけ文言が変わって後半に古い文言が 1 カットだけ残る（「生卵が食べ放題」→「衝撃を受ける・・・」のような
 * つながらない並び）。上限は MAX_HOOK_CUTS カット・MAX_HOOK_SEC 秒。伸ばせないときは元の範囲のまま。
 */
export const alignedHookCutCount = (cuts: ReelData, count = DEFAULT_HOOK_CUTS): number => {
  const idx = hookCutIndices(cuts, count);
  if (!idx.length) return count;
  let n = idx.length;
  let sec = idx.reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0);
  const textOf = (i: number) => cuts.cuts[i]?.main?.text?.trim() ?? '';
  while (n < cuts.cuts.length && n < MAX_HOOK_CUTS) {
    const last = textOf(n - 1);
    const next = textOf(n);
    if (!last || last !== next) break;
    const add = cutDurationSec(cuts.cuts[n]);
    if (sec + add > MAX_HOOK_SEC) break;
    sec += add;
    n++;
  }
  return n;
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
    const text = normalizeEllipsis((v.telops[i] ?? '').trim()); // 三点リーダーは「・・・」に揃える
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

const segEstSec = (s: Narration['segments'][number], charsPerSec: number): number => s.durSec ?? countChars(s.text) / charsPerSec;

/**
 * フック区間に属するナレーションブロックの id（at 順）。
 * **ブロックの中点が区間内にあるもの**を「区間のナレーション」と見なす。
 * 次のテロップ用のブロックは区間の終わりの 0.2 秒ほど前に始まることがあるので、at だけで判定すると
 * 巻き込んでしまう（那由多: 3 本目が 4.66 秒開始・区間の終わりが 4.86 秒）。
 */
export const hookNarrationIds = (narration: Narration, spanEndSec: number, charsPerSec = 9): string[] => {
  const segs = [...narration.segments].sort((a, b) => a.at - b.at);
  return segs.filter((s) => s.at + segEstSec(s, charsPerSec) / 2 < spanEndSec).map((s) => s.id);
};

/**
 * バリアント用の narration を作る。
 * `spanEndSec` を渡すと**フック区間に属するブロックをまとめて 1 本**に差し替える（at は最初のブロックのもの）。
 * 渡さなければ 1 本目だけを差し替える（旧来の動き）。
 * id を変えるのは、共有の narration/ フォルダで wav がぶつからないようにするため。
 */
export const applyHookNarration = (
  narration: Narration,
  v: HookVariant,
  opt: {spanEndSec?: number; charsPerSec?: number} = {},
): {narration: Narration; wavId: string | null; replaced: string[]; nextAt: number | null} => {
  if (!v.narration.trim()) return {narration, wavId: null, replaced: [], nextAt: null};
  const firstId = firstNarrationId(narration);
  if (!firstId) return {narration, wavId: null, replaced: [], nextAt: null};
  const replaced = opt.spanEndSec !== undefined ? hookNarrationIds(narration, opt.spanEndSec, opt.charsPerSec) : [firstId];
  if (!replaced.length) replaced.push(firstId);
  const wavId = `${firstId}__${v.id}`;
  const segs = [...narration.segments].sort((a, b) => a.at - b.at);
  const kept = segs.filter((s) => !replaced.includes(s.id));
  const first = segs.find((s) => s.id === firstId)!;
  const merged = {...first, id: wavId, text: v.narration.trim(), needsTts: true, durSec: undefined};
  const nextAt = kept.find((s) => s.at > first.at)?.at ?? null;
  return {
    narration: {...narration, segments: [merged, ...kept].sort((a, b) => a.at - b.at)},
    wavId,
    replaced,
    nextAt,
  };
};

/** そのパターンで使うキャプション（専用が無ければ共通） */
export const trialCaptionOf = (v: HookVariant, common: string | null | undefined): string => (v.caption.trim() ? v.caption.trim() : (common ?? '').trim());

export type HookIssue = {severity: 'E' | 'W'; code: string; message: string};

/** そのバリアントが何かを変えているか */
export const variantTouches = (v: HookVariant): boolean =>
  v.telops.some((t) => t.trim()) || v.clipIds.some((c) => c.trim()) || !!v.narration.trim() || v.badge !== undefined;

/** 比較の対象になっているか（同じ内容が 2 つあっても意味がない） */
const variantKey = (v: HookVariant): string => `${v.telops.map((t) => t.trim()).join('|')}#${v.clipIds.map((c) => c.trim()).join('|')}#${v.narration.trim()}#${v.badge ?? '-'}`;

/** 「フック以外は同じ」を守れているかの点検 */
export const checkHooks = (hooks: Hooks, opt: {cuts?: ReelData; maxTelopChars?: number; caption?: string | null} = {}): HookIssue[] => {
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
  // キャプションの使い回し（同じ文面で複数投稿すると使い回しとして扱われる）
  if (opt.caption !== undefined) {
    const seenCap = new Map<string, string>();
    for (const v of vs) {
      const c = trialCaptionOf(v, opt.caption);
      if (!c) continue;
      const dup = seenCap.get(c);
      if (dup) out.push({severity: 'W', code: 'HOOK_CAPTION_SHARED', message: `${dup} と ${v.id} はキャプションが同じ文面です（使い回し検知を避けるためパターンごとに文面を変える）`});
      else seenCap.set(c, v.id);
    }
  }
  if (opt.cuts && !hookCutIndices(opt.cuts, hooks.cutCount).length) out.push({severity: 'E', code: 'HOOK_NO_CUT', message: 'cuts.json にカットがありません'});
  return out;
};
