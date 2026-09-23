// 自然言語の台本から動画を組み立てる。純粋（ファイルも AI も触らない）。
//
// 使い方の想定は「台本を書いた（or もらった）ので、素材をそれに合わせて並べたい」。
// 台本の書式は決め打ちにしない（人が書いたものをそのまま貼れることが大事）。
// 代わりに **時間の範囲だけ緩く読み取って**、AI が返してきた組み立てが台本の尺どおりかを検算する。
import {z} from 'zod';
import {isDefaultCrop, ReelDataSchema, type Cut, type ReelData} from './schema/cuts';
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

// 【0〜3秒】/ 【4〜10秒】/ [0-3秒] / 0:00〜0:03 / 【2.5〜6.2秒】 あたりを拾う。全角・半角どちらも。
// 小数を読むのは、参考動画の型を写した台本（shared/reference.ts）がシーン検出の秒数をそのまま区間にするため
const HEAD = /^[\s]*[【\[(]?\s*(\d+(?:[:：]\d+)?(?:[.．]\d+)?)\s*[〜~\-–—]\s*(\d+(?:[:：]\d+)?(?:[.．]\d+)?)\s*秒?\s*[】\])]?\s*(.*)$/;

const toSec = (s: string): number => {
  const t = s.replace('．', '.');
  const m = /^(\d+)[:：](\d+(?:\.\d+)?)$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number(t);
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

// ───────────────────────── E の自動修正 ─────────────────────────

export type ScriptRepair = {
  /** 直したあとの組み立て（直すところが無ければ元と同じ内容） */
  plan: ScriptPlan;
  /** 何をどう直したか（1 件 1 行。空なら何も直していない） */
  fixes: string[];
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** 素材 id の読み替え用（パス・拡張子・大小文字を無視して比べる） */
const normalizeClipId = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/, '');

/**
 * checkScriptPlan が E にするもののうち、**機械的に直せるものを直す**。AI は走らせない（1 回 5〜7 分・課金があるため）。
 *
 * - 素材 id が catalog に無い → パス・拡張子違いで 1 つに決まるなら読み替える
 * - 区間が逆 → 入れ替える。素材の長さを超えている → 同じ長さのまま素材の終わりに詰める
 * - ナレーションの改行 → 1 行にする。本文が空 → 外す。id の重複 → 連番を足す
 * - ナレーションが動画尺より後ろ → **その秒が台本のどの区間かを見て、その区間の映像が実際に出ている位置に写す**
 *   （AI は台本の秒で at を書きがちで、カットの合計が台本より短いと最後のブロックが動画からはみ出る。今回はこれが一番多い）
 *
 * 直せないもの（NG にした素材・0 秒の区間・id が決まらない素材・カットが 1 つも無い）は E のまま残る。
 */
export const repairScriptPlan = (plan: ScriptPlan, ctx: ScriptCheckContext): ScriptRepair => {
  const fixes: string[] = [];

  // 1. カット：素材 id の読み替え → 区間の向き → 素材の長さ
  const byNorm = new Map<string, string[]>();
  for (const id of ctx.clipDurations.keys()) {
    const k = normalizeClipId(id);
    byNorm.set(k, [...(byNorm.get(k) ?? []), id]);
  }
  const cuts = plan.cuts.map((c, i) => {
    const cut = {...c};
    const label = `カット${i + 1}（${c.clipId}）`;
    if (!ctx.clipDurations.has(cut.clipId)) {
      const cands = byNorm.get(normalizeClipId(cut.clipId)) ?? [];
      if (cands.length !== 1) return cut; // 決められないので E のまま
      fixes.push(`${label}: catalog に無い id だったので、名前の合う ${cands[0]} に読み替えました`);
      cut.clipId = cands[0];
    }
    const dur = ctx.clipDurations.get(cut.clipId)!;
    if (cut.outSec < cut.inSec) {
      fixes.push(`${label}: 区間が逆（${cut.inSec}〜${cut.outSec}）だったので入れ替えました`);
      [cut.inSec, cut.outSec] = [cut.outSec, cut.inSec];
    }
    if (cut.outSec > cut.inSec && cut.outSec > dur + 0.05) {
      const len = Math.min(cut.outSec - cut.inSec, dur);
      const inSec = r3(Math.max(0, dur - len));
      const outSec = r3(dur);
      fixes.push(`${label}: 素材の長さ ${dur.toFixed(2)} 秒を超えていた（${cut.inSec.toFixed(2)}〜${cut.outSec.toFixed(2)}）ので ${inSec.toFixed(2)}〜${outSec.toFixed(2)} に詰めました`);
      cut.inSec = inSec;
      cut.outSec = outSec;
    }
    return cut;
  });

  // 2. ナレーションの本文と id
  const ids = new Set<string>();
  const narration: ScriptPlan['narration'] = [];
  for (const n of plan.narration) {
    let text = n.text;
    if (/[\r\n]/.test(text)) {
      text = text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join('');
      fixes.push(`${n.id}: 本文に改行があったので 1 行にしました`);
    }
    if (!text.trim()) {
      fixes.push(`${n.id}: 本文が空なので外しました`);
      continue;
    }
    let id = n.id;
    if (ids.has(id)) {
      let k = 2;
      while (ids.has(`${n.id}_${k}`)) k++;
      id = `${n.id}_${k}`;
      fixes.push(`ナレーションの id ${n.id} が重複していたので ${id} にしました`);
    }
    ids.add(id);
    narration.push({...n, id, text});
  }

  // 3. ナレーションの位置：動画尺より後ろのものを、台本の区間 → 実際の映像の位置 に写す
  const total = r3(cuts.reduce((n, c) => n + Math.max(0, c.outSec - c.inSec), 0));
  const actual = new Map<string, {start: number; end: number}>();
  let t = 0;
  for (const c of cuts) {
    const len = Math.max(0, c.outSec - c.inSec);
    const a = actual.get(c.section);
    if (a) a.end = t + len;
    else actual.set(c.section, {start: t, end: t + len});
    t += len;
  }
  const lastCut = cuts[cuts.length - 1];
  const lastCutStart = lastCut ? total - Math.max(0, lastCut.outSec - lastCut.inSec) : 0;
  const latest = Math.max(0, total - 0.1);
  const sorted = [...narration].sort((a, b) => a.at - b.at);
  let prevAt = 0;
  for (const n of sorted) {
    if (cuts.length && n.at > total + 0.05) {
      // 台本の秒としてどの区間か。どの区間にも入らなければ（台本の終わりより後ろ）最後の区間の頭に置く
      const inside = ctx.sections.find((s) => n.at >= s.fromSec && n.at < s.toSec);
      const sec = inside ?? [...ctx.sections].reverse().find((s) => (actual.get(s.heading)?.end ?? 0) > (actual.get(s.heading)?.start ?? 0));
      const a = sec ? actual.get(sec.heading) : undefined;
      let cand = lastCutStart;
      if (sec && a && a.end > a.start) {
        const rel = inside ? Math.min(Math.max(0, n.at - sec.fromSec), sec.toSec - sec.fromSec) / (sec.toSec - sec.fromSec) : 0;
        cand = a.start + rel * (a.end - a.start);
      }
      const at = r3(Math.min(Math.max(cand, prevAt), latest));
      fixes.push(`${n.id}: 動画尺（${total.toFixed(1)} 秒）より後ろ（${n.at.toFixed(1)} 秒）にあったので、${sec ? `${sec.heading} の映像に合わせて ` : ''}${at.toFixed(1)} 秒に動かしました`);
      n.at = at;
    }
    prevAt = Math.max(prevAt, n.at);
  }

  // 位置は sorted 経由で narration の要素を直接直しているので、並びは元のまま返す
  return {plan: {...plan, cuts, narration}, fixes};
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
  /** テロップのフォント（Settings で選んだ既定）。省略＝同梱の明朝 */
  font?: string | null;
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
    const clip = byId.get(c.clipId);
    const cut: Cut = {
      id: cutIdOf(i),
      src: clip?.src ?? c.clipId,
      inSec: Math.max(0, Math.round(c.inSec * 1000) / 1000),
      outSec: Math.round(c.outSec * 1000) / 1000,
    };
    // 素材側で決めた「ここを見せる」（切り出し）を引き継ぐ
    if (!isDefaultCrop(clip?.crop)) cut.crop = {...clip!.crop!};
    if (c.telop.trim()) cut.main = {text: c.telop.trim(), ...(c.orientation === 'horizontal' ? {orientation: 'horizontal' as const} : {})};
    if (c.badge?.trim()) cut.badge = c.badge.trim();
    return cut;
  });
  return ReelDataSchema.parse({
    fps: ctx.catalog.dominantFps,
    theme: ctx.theme,
    ...(ctx.font ? {font: ctx.font} : {}),
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
  /** AI の返答から自動で直したこと（repairScriptPlan）。plan は直したあとのもの */
  autoFixes: z.array(z.string()).default([]),
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
  /** いま見直したときに自動で直したこと（案を作ったときの分は proposal.autoFixes）。書き込むのは直したあとの plan */
  fixes: string[];
  /** 書き込む組み立て（自動修正のあと） */
  plan: ScriptPlan;
  lines: string[];
  totalSec: number;
  cutCount: number;
  narrationCount: number;
};

/**
 * 保存してある案を、いまの台本・素材で見直す（純粋。書き込む直前と画面表示の両方で使う）。
 * 機械的に直せる E は直してから検算する（直す前に作った案でも、承認すればそのまま書ける）。
 */
export const reviewScriptProposal = (
  proposal: ScriptProposal,
  now: {scriptText: string | null; check: ScriptCheckContext; toCuts: (plan: ScriptPlan) => ReelData},
): ScriptProposalReview => {
  const blockers: string[] = [];
  if (!now.scriptText?.trim()) blockers.push('script.md がありません');
  else if (scriptTextHash(now.scriptText) !== proposal.scriptHash) blockers.push('この案を作ったあとに台本（script.md）が変わっています。「割り当てを見るだけ」をやり直してください');
  const {plan, fixes} = repairScriptPlan(proposal.plan, now.check);
  const issues = checkScriptPlan(plan, now.check);
  const errors = issues.filter((i) => i.severity === 'E');
  if (errors.length) blockers.push(`検算の E が ${errors.length} 件あります（${errors.map((e) => e.code).join(', ')}）`);
  return {
    canApply: blockers.length === 0,
    blockers,
    issues,
    fixes,
    plan,
    lines: formatScriptPlan(plan, now.check.sections, now.toCuts(plan)),
    totalSec: scriptPlanTotalSec(plan),
    cutCount: plan.cuts.length,
    narrationCount: plan.narration.length,
  };
};
