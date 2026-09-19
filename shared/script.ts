// 自然言語の台本から動画を組み立てる。純粋（ファイルも AI も触らない）。
//
// 使い方の想定は「台本を書いた（or もらった）ので、素材をそれに合わせて並べたい」。
// 台本の書式は決め打ちにしない（人が書いたものをそのまま貼れることが大事）。
// 代わりに **時間の範囲だけ緩く読み取って**、AI が返してきた組み立てが台本の尺どおりかを検算する。
import {z} from 'zod';
import {ReelDataSchema, type Cut, type ReelData} from './schema/cuts';
import type {Catalog} from './schema/catalog';
import type {Narration} from './schema/narration';
import {stableHash} from './hash';
import {cutRanges, totalSec} from './timeline';

/** 台本から読み取った 1 区間（【0〜3秒】フック のような見出し） */
export type ScriptSection = {
  /** 見出しの行そのもの */
  heading: string;
  /** 区間名（フック / 実食 など。無ければ空） */
  label: string;
  fromSec: number;
  toSec: number;
};

// 【0〜3秒】/ 【4〜10秒】/ [0-3秒] / 0:00〜0:03 あたりを拾う。全角・半角どちらも
const HEAD = /^[\s]*[【\[(]?\s*(\d+(?:[:：]\d+)?)\s*[〜~\-–—]\s*(\d+(?:[:：]\d+)?)\s*秒?\s*[】\])]?\s*(.*)$/;

const toSec = (s: string): number => {
  const m = /^(\d+)[:：](\d+)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number(s);
};

/**
 * 台本から時間の区間を拾う。**書式が違っても落ちない**（拾えなければ空を返すだけ）。
 * 拾えた区間は「AI の組み立てが台本どおりの尺になっているか」の検算に使う。
 */
export const parseSections = (script: string): ScriptSection[] => {
  const out: ScriptSection[] = [];
  for (const line of script.split(/\r?\n/)) {
    const m = HEAD.exec(line.trim());
    if (!m) continue;
    const fromSec = toSec(m[1]);
    const toSecV = toSec(m[2]);
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSecV) || toSecV <= fromSec) continue;
    out.push({heading: line.trim(), label: m[3].replace(/^[】\])\s]+/, '').trim(), fromSec, toSec: toSecV});
  }
  return out.sort((a, b) => a.fromSec - b.fromSec);
};

/** 台本が想定している全体尺（最後の区間の終わり）。区間が拾えなければ undefined */
export const scriptTotalSec = (sections: readonly ScriptSection[]): number | undefined => (sections.length ? sections[sections.length - 1].toSec : undefined);

// ───────────────────────── AI が返す組み立て ─────────────────────────

export const ScriptCutSchema = z.object({
  /** catalog の clipId */
  clipId: z.string(),
  inSec: z.number().min(0),
  outSec: z.number().min(0),
  /** 画面に出すテロップ。空なら出さない */
  telop: z.string().default(''),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  /** 中央上部のラベル（エリア名など） */
  badge: z.string().optional(),
  /** 台本のどの区間か（【0〜3秒】フック の見出しをそのまま） */
  section: z.string().default(''),
});
export type ScriptCut = z.infer<typeof ScriptCutSchema>;

export const ScriptPlanSchema = z.object({
  cuts: z.array(ScriptCutSchema).default([]),
  narration: z.array(z.object({id: z.string(), at: z.number().min(0), text: z.string()})).default([]),
  /** 台本にあるが素材が見つからなかったもの。撮り足しの指示になる */
  unmatched: z.array(z.string()).default([]),
  notes: z.string().default(''),
});
export type ScriptPlan = z.infer<typeof ScriptPlanSchema>;

export type ScriptIssue = {severity: 'E' | 'W'; code: string; message: string};

export type ScriptCheckContext = {
  sections: readonly ScriptSection[];
  /** 使える素材（id → 尺）。ここに無い id は E */
  clipDurations: Map<string, number>;
  /** ユーザーが NG にした素材 */
  ngClipIds?: ReadonlySet<string>;
  /** テロップの文字数上限 */
  maxTelopChars?: number;
  /** 区間の尺が台本とどれだけずれてよいか（秒） */
  toleranceSec?: number;
};

/** 区間ごとに、割り当てられたカットの合計尺を出す */
export const sectionDurations = (plan: ScriptPlan, sections: readonly ScriptSection[]): Map<string, number> => {
  const byHeading = new Map<string, number>();
  for (const s of sections) byHeading.set(s.heading, 0);
  for (const c of plan.cuts) {
    const key = c.section || '';
    if (!byHeading.has(key)) continue;
    byHeading.set(key, (byHeading.get(key) ?? 0) + Math.max(0, c.outSec - c.inSec));
  }
  return byHeading;
};

/**
 * AI が返した組み立てを検算する。
 * **台本の尺どおりか**が一番大事（そこがずれると、書いたナレーションが入らない）。
 */
export const checkScriptPlan = (plan: ScriptPlan, ctx: ScriptCheckContext): ScriptIssue[] => {
  const out: ScriptIssue[] = [];
  const tol = ctx.toleranceSec ?? 1.5;
  const maxChars = ctx.maxTelopChars ?? 13;

  if (!plan.cuts.length) return [{severity: 'E', code: 'SCRIPT_NO_CUTS', message: 'カットが 1 つも返ってきませんでした'}];

  plan.cuts.forEach((c, i) => {
    const label = `カット${i + 1}（${c.clipId}）`;
    const dur = ctx.clipDurations.get(c.clipId);
    if (dur === undefined) {
      out.push({severity: 'E', code: 'SCRIPT_UNKNOWN_CLIP', message: `${label}: catalog に無い素材`});
      return;
    }
    if (ctx.ngClipIds?.has(c.clipId)) out.push({severity: 'E', code: 'SCRIPT_NG_CLIP', message: `${label}: NG にした素材が使われています`});
    if (c.outSec <= c.inSec) out.push({severity: 'E', code: 'SCRIPT_BAD_RANGE', message: `${label}: 区間が逆または 0（${c.inSec}〜${c.outSec}）`});
    else if (c.outSec > dur + 0.05) out.push({severity: 'E', code: 'SCRIPT_OUT_OF_RANGE', message: `${label}: 素材の長さ ${dur.toFixed(2)} 秒を超えています（${c.outSec.toFixed(2)}）`});
    const t = c.telop.trim();
    if (t && [...t].length > maxChars) out.push({severity: 'W', code: 'SCRIPT_TELOP_LONG', message: `${label}: テロップが ${[...t].length} 文字（目安 ${maxChars}）「${t}」`});
    if (/[。]$/.test(t)) out.push({severity: 'W', code: 'SCRIPT_TELOP_PERIOD', message: `${label}: テロップの文末に句点は付けない`});
  });

  // 同じ素材が連続している（同じ画が続いて見える）
  for (let i = 1; i < plan.cuts.length; i++)
    if (plan.cuts[i].clipId === plan.cuts[i - 1].clipId && plan.cuts[i].inSec < plan.cuts[i - 1].outSec + 0.01)
      out.push({severity: 'W', code: 'SCRIPT_SAME_CLIP_RUN', message: `カット${i}と${i + 1}が同じ素材の連続区間です（切り替わって見えません）`});

  // 区間ごとの尺が台本どおりか
  const durs = sectionDurations(plan, ctx.sections);
  for (const s of ctx.sections) {
    const want = s.toSec - s.fromSec;
    const got = durs.get(s.heading) ?? 0;
    if (got === 0) out.push({severity: 'W', code: 'SCRIPT_SECTION_EMPTY', message: `${s.heading}: カットが割り当てられていません`});
    else if (Math.abs(got - want) > tol)
      out.push({
        severity: 'W',
        code: 'SCRIPT_SECTION_LENGTH',
        message: `${s.heading}: 台本は ${want.toFixed(1)} 秒ですが ${got.toFixed(1)} 秒です（${got > want ? '長い' : '短い'}）`,
      });
  }

  // 全体尺
  const total = plan.cuts.reduce((n, c) => n + Math.max(0, c.outSec - c.inSec), 0);
  const wantTotal = scriptTotalSec(ctx.sections);
  if (wantTotal && Math.abs(total - wantTotal) > tol * 2)
    out.push({severity: 'W', code: 'SCRIPT_TOTAL_LENGTH', message: `全体が ${total.toFixed(1)} 秒（台本は ${wantTotal} 秒）`});

  // ナレーション
  const sorted = [...plan.narration].sort((a, b) => a.at - b.at);
  const ids = new Set<string>();
  for (const n of sorted) {
    if (ids.has(n.id)) out.push({severity: 'E', code: 'SCRIPT_NARR_DUP_ID', message: `ナレーションの id が重複: ${n.id}`});
    ids.add(n.id);
    if (!n.text.trim()) out.push({severity: 'E', code: 'SCRIPT_NARR_EMPTY', message: `${n.id}: 本文が空`});
    if (/[\r\n]/.test(n.text)) out.push({severity: 'E', code: 'SCRIPT_NARR_NEWLINE', message: `${n.id}: 本文に改行がある（1 ブロック 1 文）`});
    if (n.at > total + 0.05) out.push({severity: 'E', code: 'SCRIPT_NARR_AFTER_END', message: `${n.id}: 動画尺（${total.toFixed(1)} 秒）より後ろに置かれています`});
  }
  if (!sorted.length) out.push({severity: 'W', code: 'SCRIPT_NARR_MISSING', message: 'ナレーションが 1 本もありません'});
  return out;
};

/** 組み立て結果を、台本の区間ごとに読める形にする（ログ・画面用） */
export const formatScriptPlan = (plan: ScriptPlan, sections: readonly ScriptSection[], cuts?: ReelData): string[] => {
  const lines: string[] = [];
  const ranges = cuts ? cutRanges(cuts) : null;
  let last = '';
  plan.cuts.forEach((c, i) => {
    if (c.section && c.section !== last) {
      const s = sections.find((x) => x.heading === c.section);
      lines.push(`${c.section}${s ? `（台本 ${s.toSec - s.fromSec} 秒）` : ''}`);
      last = c.section;
    }
    const at = ranges?.[i];
    const dur = (c.outSec - c.inSec).toFixed(2);
    lines.push(`  ${at ? `${at.startSec.toFixed(2)}〜${at.endSec.toFixed(2)}` : `(${dur}s)`} ${c.clipId} ${c.telop ? `「${c.telop}」` : '（テロップなし）'}`);
  });
  if (cuts) lines.push(`合計 ${totalSec(cuts).toFixed(2)} 秒 / ${plan.cuts.length} カット`);
  return lines;
};

// ───────────────────────── 組み立て結果 → 契約ファイル ─────────────────────────

export type ScriptBuildContext = {
  catalog: Pick<Catalog, 'clips' | 'dominantFps'>;
  theme: ReelData['theme'];
  specId: string;
  briefHash: string;
  catalogHash: string;
  /** meta.generated.at（テストで固定する） */
  at?: string;
};

const cutIdOf = (i: number) => `c${String(i + 1).padStart(2, '0')}`;

/** AI の組み立て（clipId と素材内の秒）を cuts.json にする。src は**いまの** catalog から引く（slug を変えていても合う） */
export const scriptPlanToCuts = (plan: ScriptPlan, ctx: ScriptBuildContext): ReelData => {
  const byId = new Map(ctx.catalog.clips.map((c) => [c.id, c]));
  const cuts: Cut[] = plan.cuts.map((c, i) => {
    const cut: Cut = {
      id: cutIdOf(i),
      src: byId.get(c.clipId)?.src ?? c.clipId,
      inSec: Math.max(0, Math.round(c.inSec * 1000) / 1000),
      outSec: Math.round(c.outSec * 1000) / 1000,
    };
    if (c.telop.trim()) cut.main = {text: c.telop.trim(), ...(c.orientation === 'horizontal' ? {orientation: 'horizontal' as const} : {})};
    if (c.badge?.trim()) cut.badge = c.badge.trim();
    return cut;
  });
  return ReelDataSchema.parse({
    fps: ctx.catalog.dominantFps,
    theme: ctx.theme,
    cuts,
    meta: {
      slots: plan.cuts.map((c, i) => ({cutId: cutIdOf(i), segment: c.section, role: 'info', clipId: c.clipId, textStatus: 'draft', locked: false, qc: []})),
      generated: {tool: 'reel-studio/script', at: ctx.at ?? new Date().toISOString(), briefHash: ctx.briefHash, catalogHash: ctx.catalogHash, specId: ctx.specId},
    },
  });
};

/** カットの合計尺（倍速は使わないので単純な和） */
export const scriptPlanTotalSec = (plan: ScriptPlan): number => Math.round(plan.cuts.reduce((n, c) => n + Math.max(0, c.outSec - c.inSec), 0) * 1000) / 1000;

/** ナレーションを narration.json にする（音声はまだ無いので全ブロック要生成）。ブロックが無ければ null */
export const scriptPlanToNarration = (plan: ScriptPlan, voice: {voiceId: string; voiceTitle: string; speed: number}): Narration | null =>
  plan.narration.length
    ? {
        voice: voice.voiceId,
        voiceTitle: voice.voiceTitle,
        latency: 'normal',
        speed: voice.speed,
        videoSec: scriptPlanTotalSec(plan),
        note: plan.notes,
        segments: plan.narration.map((n) => ({id: n.id, at: Math.round(n.at * 1000) / 1000, text: n.text.trim(), needsTts: true})),
      }
    : null;

// ───────────────────────── 割り当ての案（見てから書き込む） ─────────────────────────

/**
 * AI が返した組み立ての保存形（.studio/script-plan.json）。
 * 「割り当てを見るだけ」で作り、**ユーザーが承認したらこれをそのまま書き込む**（AI をもう一度走らせない。
 * 1 回 5〜7 分・課金があるため）。
 */
export const ScriptProposalSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  /** 作ったときの script.md のハッシュ。台本を直したら、この案は使えない */
  scriptHash: z.string(),
  model: z.string().default(''),
  costUsd: z.number().default(0),
  plan: ScriptPlanSchema,
  /** 書き込んだ日時（「台本から組み立てる」でそのまま書いたときと、承認して書いたとき） */
  appliedAt: z.string().optional(),
});
export type ScriptProposal = z.infer<typeof ScriptProposalSchema>;

export const scriptTextHash = (text: string): string => stableHash(text);

export type ScriptProposalReview = {
  /** 承認すれば書き込める */
  canApply: boolean;
  /** 書き込めない理由（台本が変わった・E がある） */
  blockers: string[];
  /** **いまの** catalog・台本で検算し直した結果（作ったあとに素材を NG にした等も拾う） */
  issues: ScriptIssue[];
  lines: string[];
  totalSec: number;
  cutCount: number;
  narrationCount: number;
};

/** 保存してある案を、いまの台本・素材で見直す（純粋。書き込む直前と画面表示の両方で使う） */
export const reviewScriptProposal = (
  proposal: ScriptProposal,
  now: {scriptText: string | null; check: ScriptCheckContext; cuts: ReelData},
): ScriptProposalReview => {
  const blockers: string[] = [];
  if (!now.scriptText?.trim()) blockers.push('script.md がありません');
  else if (scriptTextHash(now.scriptText) !== proposal.scriptHash) blockers.push('この案を作ったあとに台本（script.md）が変わっています。「割り当てを見るだけ」をやり直してください');
  const issues = checkScriptPlan(proposal.plan, now.check);
  const errors = issues.filter((i) => i.severity === 'E');
  if (errors.length) blockers.push(`検算の E が ${errors.length} 件あります（${errors.map((e) => e.code).join(', ')}）`);
  return {
    canApply: blockers.length === 0,
    blockers,
    issues,
    lines: formatScriptPlan(proposal.plan, now.check.sections, now.cuts),
    totalSec: scriptPlanTotalSec(proposal.plan),
    cutCount: proposal.plan.cuts.length,
    narrationCount: proposal.plan.narration.length,
  };
};
