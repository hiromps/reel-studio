// 効果音の役割・ライブラリ・自動配置の規則。純粋（ファイルも ffmpeg も触らない）。
//
// 狙いは「飽きさせない」こと。効果音は入れれば入れるほど良いわけではなく、**入れどころを絞って
// 毎回同じ役割に同じ音を当てる**のが要点（統一感＝視聴者が音で構成を覚える）。
// なので配置は「役割（role）→ ライブラリから音を引く」の 2 段にしてある。
import {z} from 'zod';
import type {ReelData} from './schema/cuts';
import type {Sfx} from './schema/narration';
import {cutRanges, telopGroupsOf, totalSec} from './timeline';
import {isPlaceholder} from './telop-text';

/**
 * 効果音の役割。ここに無い場所には自動で置かない。
 * - hook: 冒頭。視聴者の手を止めさせる 1 発（アラーム・インパクト・ドン）
 * - telop: 主要テロップの出現（ポップ・ピョコ）。全テロップではなく序盤の数枚だけ
 * - transition: 場面の切り替わり（ウーシュ・スワイプ）。同じ被写体が続く箇所には置かない
 * - reveal: 店名・正体が出る瞬間（キラッ・ジャーン）
 * - eat: 実食・シズルのカット（シャキ・パクッ）
 * - outro: 締め（余韻・ポン）
 */
export const SFX_ROLES = ['hook', 'telop', 'transition', 'reveal', 'eat', 'outro'] as const;
export type SfxRole = (typeof SFX_ROLES)[number];

export const SFX_ROLE_LABEL: Record<SfxRole, string> = {
  hook: '冒頭のつかみ',
  telop: 'テロップ出現',
  transition: '場面転換',
  reveal: '店名リビール',
  eat: '実食・シズル',
  outro: '締め',
};

/** ライブラリ 1 音。sfx/library.json の中身 */
export const SfxSoundSchema = z.object({
  /** sfx/ からの相対パス */
  file: z.string(),
  /** 表示名（効果音ラボのファイル名そのままでよい） */
  label: z.string(),
  /** この音を当てる役割。複数可。空＝自動配置では使わない（手で置くだけ） */
  roles: z.array(z.enum(SFX_ROLES)).default([]),
  /** 実測の長さ（秒）。core/sfx.ts が ffprobe で入れる */
  durSec: z.number().optional(),
  /** 自動配置のときに使う既定値 */
  defaultTrimSec: z.number().positive().optional(),
  defaultFadeOutSec: z.number().min(0).optional(),
  defaultGainDb: z.number().min(-30).max(12).optional(),
  /** 出典（効果音ラボ 等）。再配布禁止の素材を混ぜないための記録 */
  source: z.string().optional(),
});
export type SfxSound = z.infer<typeof SfxSoundSchema>;

export const SfxLibrarySchema = z.object({
  version: z.literal(1).default(1),
  sounds: z.array(SfxSoundSchema).default([]),
});
export type SfxLibrary = z.infer<typeof SfxLibrarySchema>;

/** その役割に使える音（先頭が既定）。1 役割 1 音に固定すると動画をまたいだ統一感が出る */
export const soundsForRole = (lib: SfxLibrary, role: SfxRole): SfxSound[] => lib.sounds.filter((s) => s.roles.includes(role));

// ───────────────────────── 自動配置 ─────────────────────────

export type SfxPlacementOptions = {
  /** 効果音同士の最小間隔（秒）。近すぎると音が団子になって逆に飽きる */
  minGapSec?: number;
  /** 全体の上限個数。0 で無制限 */
  max?: number;
  /** 置かない役割 */
  exclude?: SfxRole[];
  /** 動画尺（省略時は cuts から計算） */
  videoSec?: number;
};

export const SFX_DEFAULTS = {
  minGapSec: 1.2,
  /** 20 秒で 6 個くらいが上限の目安（1 秒あたり 0.3 個） */
  perSec: 0.3,
  trimSec: 1.2,
  fadeOutSec: 0.25,
  gainDb: -4,
} as const;

export type SfxCandidate = {at: number; role: SfxRole; why: string};

/**
 * cuts.json から「効果音を置くとよい位置」を出す。音源は見ない（役割だけ返す）。
 * 規則:
 *   - hook: 0 秒（フックの 1 枚目）
 *   - telop: 序盤のテロップグループの頭。2 枚目以降から拾う（0 秒は hook と重なる）
 *   - transition: 被写体が変わるカット境界だけ。同じ素材の連続では鳴らさない
 *   - reveal: 店名リビールのグループ（meta.slots の role か、看板カット）の頭
 *   - eat: 実食・シズルのカット頭
 *   - outro: 最後のテロップグループの頭
 */
export const sfxCandidates = (cuts: ReelData, opt: {revealAt?: number; eatAtList?: number[]; transitionAtList?: number[]} = {}): SfxCandidate[] => {
  const out: SfxCandidate[] = [];
  const ranges = cutRanges(cuts);
  if (!ranges.length) return out;
  const groups = telopGroupsOf(cuts);

  out.push({at: 0, role: 'hook', why: 'フックの1枚目'});

  // テロップ出現。序盤（動画の前半）の、文言が入っているグループだけ
  const half = totalSec(cuts) / 2;
  groups.forEach((g, i) => {
    const at = g.from / cuts.fps;
    if (i === 0 || at > half) return;
    if (!g.def.text || isPlaceholder(g.def.text)) return;
    out.push({at, role: 'telop', why: `テロップ「${g.def.text}」の出現`});
  });

  for (const at of opt.transitionAtList ?? []) out.push({at, role: 'transition', why: '被写体が変わるカット境界'});
  if (opt.revealAt !== undefined) out.push({at: opt.revealAt, role: 'reveal', why: '店名リビール'});
  for (const at of opt.eatAtList ?? []) out.push({at, role: 'eat', why: '実食・シズル'});

  const last = groups[groups.length - 1];
  if (last && groups.length > 1) out.push({at: last.from / cuts.fps, role: 'outro', why: '締めのテロップ'});

  return out.sort((a, b) => a.at - b.at);
};

/** 役割の優先度（間隔が足りず 1 つ選ぶときに強い方を残す） */
const ROLE_PRIORITY: Record<SfxRole, number> = {hook: 100, reveal: 90, outro: 70, eat: 60, telop: 50, transition: 40};

/**
 * 候補を間隔・個数で間引く。**近い候補は優先度の高い役割を残す**。
 * 「全部のカットに音」を防ぐのがこの関数の役目（それをやると耳が慣れて逆効果）。
 */
export const thinCandidates = (candidates: readonly SfxCandidate[], videoSec: number, opt: SfxPlacementOptions = {}): SfxCandidate[] => {
  const minGap = opt.minGapSec ?? SFX_DEFAULTS.minGapSec;
  const max = opt.max ?? Math.max(2, Math.round(videoSec * SFX_DEFAULTS.perSec));
  const exclude = new Set(opt.exclude ?? []);
  const usable = candidates.filter((c) => !exclude.has(c.role) && c.at >= 0 && c.at <= videoSec).sort((a, b) => a.at - b.at);

  // 近すぎるものをまとめる（優先度の高い役割を残す）
  const kept: SfxCandidate[] = [];
  for (const c of usable) {
    const prev = kept[kept.length - 1];
    if (prev && c.at - prev.at < minGap) {
      if (ROLE_PRIORITY[c.role] > ROLE_PRIORITY[prev.role]) kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }
  if (!max || kept.length <= max) return kept;
  // 個数を超えたら優先度の低いものから落とす（時系列は保つ）
  const drop = new Set(
    [...kept]
      .sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role] || b.at - a.at)
      .slice(0, kept.length - max)
      .map((c) => `${c.role}@${c.at}`),
  );
  return kept.filter((c) => !drop.has(`${c.role}@${c.at}`));
};

/** 役割つき候補にライブラリの音を当てて narration.json の sfx 配列にする */
export const assignSounds = (candidates: readonly SfxCandidate[], lib: SfxLibrary): {sfx: Sfx[]; missing: SfxRole[]} => {
  const sfx: Sfx[] = [];
  const missing = new Set<SfxRole>();
  const seq = new Map<SfxRole, number>();
  for (const c of candidates) {
    const sound = soundsForRole(lib, c.role)[0];
    if (!sound) {
      missing.add(c.role);
      continue;
    }
    const n = (seq.get(c.role) ?? 0) + 1;
    seq.set(c.role, n);
    const trim = sound.defaultTrimSec ?? Math.min(sound.durSec ?? SFX_DEFAULTS.trimSec, SFX_DEFAULTS.trimSec);
    sfx.push({
      id: `${c.role}${n > 1 ? n : ''}`,
      at: Math.round(c.at * 1000) / 1000,
      file: sound.file,
      role: c.role,
      trimSec: Math.round(trim * 1000) / 1000,
      fadeOutSec: sound.defaultFadeOutSec ?? SFX_DEFAULTS.fadeOutSec,
      gainDb: sound.defaultGainDb ?? SFX_DEFAULTS.gainDb,
      label: sound.label,
    });
  }
  return {sfx, missing: [...missing]};
};

/** 鳴り終わる秒（trim と素材尺の小さい方） */
export const sfxEndSec = (s: Sfx, lib?: SfxLibrary): number => {
  const sound = lib?.sounds.find((x) => x.file === s.file);
  const dur = Math.min(s.trimSec ?? Infinity, sound?.durSec ?? Infinity);
  return s.at + (Number.isFinite(dur) ? dur : 0);
};

export type SfxIssue = {severity: 'E' | 'W'; code: string; message: string};

/** 置き方の点検。音源の有無・尺はみ出し・団子・過剰な数・ナレーションとの被り */
export const checkSfx = (
  sfx: readonly Sfx[],
  opt: {videoSec?: number; lib?: SfxLibrary; minGapSec?: number; narration?: readonly {id: string; at: number; durSec?: number}[]} = {},
): SfxIssue[] => {
  const out: SfxIssue[] = [];
  const minGap = opt.minGapSec ?? SFX_DEFAULTS.minGapSec;
  const sorted = [...sfx].sort((a, b) => a.at - b.at);
  const ids = new Set<string>();
  for (const s of sorted) {
    if (ids.has(s.id)) out.push({severity: 'E', code: 'SFX_DUP_ID', message: `id が重複しています: ${s.id}`});
    ids.add(s.id);
    if (opt.lib && !opt.lib.sounds.some((x) => x.file === s.file)) out.push({severity: 'E', code: 'SFX_MISSING_FILE', message: `${s.id}: 音源が見つかりません（${s.file}）`});
    if (opt.videoSec && s.at > opt.videoSec) out.push({severity: 'E', code: 'SFX_AFTER_END', message: `${s.id}: 動画尺（${opt.videoSec.toFixed(2)}秒）より後ろに置かれています`});
    else if (opt.videoSec && sfxEndSec(s, opt.lib) > opt.videoSec + 0.05)
      out.push({severity: 'W', code: 'SFX_OVERRUN', message: `${s.id}: 鳴り終わりが動画尺を ${(sfxEndSec(s, opt.lib) - opt.videoSec).toFixed(2)} 秒はみ出します（trimSec を短く）`});
  }
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    if (prev && s.at - prev.at < minGap) out.push({severity: 'W', code: 'SFX_TOO_CLOSE', message: `${prev.id} と ${s.id} が ${(s.at - prev.at).toFixed(2)} 秒しか離れていません（音が団子になります）`});
  });
  // ナレーションの上に重ねると声が聞き取りにくくなる。完全に禁止ではないので W（下げるか位置をずらす判断は人）
  for (const s of sorted) {
    const end = sfxEndSec(s, opt.lib);
    for (const n of opt.narration ?? []) {
      if (!n.durSec) continue;
      const ov = Math.min(end, n.at + n.durSec) - Math.max(s.at, n.at);
      if (ov > 0.15) out.push({severity: 'W', code: 'SFX_OVER_NARRATION', message: `${s.id} がナレーション ${n.id} に ${ov.toFixed(2)} 秒かぶります（声が埋もれるなら gainDb を下げるか at をずらす）`});
    }
  }
  if (opt.videoSec) {
    const max = Math.max(2, Math.round(opt.videoSec * SFX_DEFAULTS.perSec));
    if (sorted.length > max) out.push({severity: 'W', code: 'SFX_TOO_MANY', message: `${sorted.length} 個は多すぎます（${opt.videoSec.toFixed(0)} 秒なら ${max} 個くらいまで）。耳が慣れて効果が薄れます`});
  }
  return out;
};

export const formatSfxIssues = (issues: readonly SfxIssue[]): string => (issues.length ? issues.map((i) => `  ${i.severity} ${i.code} ${i.message}`).join('\n') : '  指摘なし');
