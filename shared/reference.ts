// 参考動画（他の人が投稿して伸びたリール）の「型」を写す。純粋（ファイルも ffmpeg も AI も触らない）。
//
// 流れ:
//   参考動画 ──ffmpeg──▶ シーン検出・コンタクトシート・カット頭のコマ・無音検出
//            ──Claude──▶ reference.json（カットごとのテロップと映像・区間・型・写すときの規則）
//   reference.json ＋ 自分の素材・店の事実・人格 ──Claude──▶ script.md（同じ区間・秒数・カット数・テロップの型）
//   script.md ──既存の「台本から組み立てる」──▶ cuts.json + narration.json
//
// **写すのは構成・テンポ・テロップの型だけ。** 参考動画の映像・音声・文言そのものは使わない
// （他人の投稿の流用は避ける。型を学ぶのは正当なやり方だが、中身は自分の素材と事実で作る）。
import {z} from 'zod';
import {AngleSchema, ClipKindSchema} from './schema/catalog';
import {SlotRoleSchema, ThemeSchema} from './schema/cuts';
import {countChars} from './telop-text';

/** 参考動画として受け付ける長さ（ショート動画なので 3 分あれば足りる。長いと分析の画が増えすぎる） */
export const REFERENCE_MAX_SEC = 180;

/** コンタクトシート：1 秒に 2 コマを 3 列 × 4 段（1 枚 = 6 秒）。テロップが読める大きさで 1 枚に収める */
export const SHEET_FPS = 2;
export const SHEET_COLS = 3;
export const SHEET_ROWS = 4;
export const SHEET_TILE_W = 360;
/** カット頭のコマの横幅（px） */
export const FRAME_W = 360;
/** シーン検出の境界どうしの最小間隔（秒）。これより近い境界は同じカットの揺れとみなす */
export const MIN_CUT_GAP_SEC = 0.3;
/** カット頭のコマを切り出す上限（多すぎると分析の Read が増えて時間と費用がかかる） */
export const MAX_REFERENCE_CUTS = 120;

// ───────────────────────── reference.json ─────────────────────────

export const ReferenceSourceSchema = z.object({
  /** .studio 相対（reference/source.mp4）。取り込んだ実体 */
  file: z.string().min(1),
  originalName: z.string().default(''),
  durationSec: z.number().positive(),
  fps: z.number().positive(),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
  hasAudio: z.boolean().default(false),
  importedAt: z.string(),
});
export type ReferenceSource = z.infer<typeof ReferenceSourceSchema>;

export const ReferenceOrientationSchema = z.enum(['vertical', 'horizontal', 'none']);

export const ReferenceCutSchema = z.object({
  /** 1 始まり（シーン検出の順） */
  index: z.number().int().min(1),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  /** 画面に焼き込まれている文言（読めた通り。無ければ空） */
  telop: z.string().default(''),
  orientation: ReferenceOrientationSchema.default('none'),
  /** 中央上部などの短いラベル（エリア名・順位）。無ければ空 */
  badge: z.string().default(''),
  shot: z
    .object({
      kind: ClipKindSchema.default('other'),
      angle: AngleSchema.default('mid'),
      subject: z.string().default(''),
      description: z.string().default(''),
    })
    .default({}),
  role: SlotRoleSchema.default('filler'),
  /** カット頭のコマ（.studio 相対）。画面の一覧に出す */
  frame: z.string().optional(),
});
export type ReferenceCut = z.infer<typeof ReferenceCutSchema>;

export const ReferenceSegmentSchema = z.object({
  id: z.string().min(1),
  /** フック / 証明 / 店名リビール / 本編 / 締め など */
  label: z.string().default(''),
  fromSec: z.number().min(0),
  toSec: z.number().min(0),
  role: SlotRoleSchema.default('info'),
  /** この区間が視聴者に何をさせているか */
  purpose: z.string().default(''),
  /** テロップの型（疑問形・数字・体言止め・煽り …） */
  telopPattern: z.string().default(''),
  cutCount: z.number().int().min(0).default(0),
  cutIndices: z.array(z.number().int().min(1)).default([]),
  /** 声（発話）がある区間か（無音検出から） */
  narration: z.boolean().default(false),
  notes: z.string().default(''),
});
export type ReferenceSegment = z.infer<typeof ReferenceSegmentSchema>;

export const ReferencePatternSchema = z.object({
  /** 疑問形 / 結果先出し / 数字 / 警告・煽り / ギャップ / 断言 … */
  hookType: z.string().default(''),
  hookText: z.string().default(''),
  /** 店名や正体が分かる秒。無ければ null */
  revealSec: z.number().nullable().default(null),
  revealStyle: z.string().default(''),
  ctaText: z.string().default(''),
  ctaStyle: z.string().default(''),
  /** 文字数の傾向・語尾・記号・改行・強調の癖 */
  telopStyle: z.string().default(''),
  /** カット尺の傾向・どこで速く／遅くするか */
  tempoStyle: z.string().default(''),
  /** 保存したくなる実用情報として出しているもの */
  saveReasons: z.array(z.string()).default([]),
  narrationStyle: z.string().default(''),
  theme: ThemeSchema.optional(),
});
export type ReferencePattern = z.infer<typeof ReferencePatternSchema>;

export const ReferenceSchema = z.object({
  version: z.literal(1).default(1),
  /** null ＝ 取り込んでいない（消したあとの墓標。クラウドと同期するので、ファイルを消す代わりにこれを書く） */
  source: ReferenceSourceSchema.nullable().default(null),
  analyzedAt: z.string().optional(),
  model: z.string().default(''),
  costUsd: z.number().default(0),
  /** シーン検出で見つけた境界（秒） */
  sceneCuts: z.array(z.number()).default([]),
  /** 声（発話）の区間（無音検出の補集合） */
  speech: z.array(z.object({startSec: z.number(), endSec: z.number()})).default([]),
  /** 分析に使ったコンタクトシート（.studio 相対） */
  sheets: z.array(z.string()).default([]),
  cuts: z.array(ReferenceCutSchema).default([]),
  segments: z.array(ReferenceSegmentSchema).default([]),
  pattern: ReferencePatternSchema.default({}),
  /** なぜ伸びているか（1〜3 行） */
  summary: z.string().default(''),
  /** 自分の素材で同じ型を作るときに守る規則 */
  mimicRules: z.array(z.string()).default([]),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export const emptyReference = (): Reference => ReferenceSchema.parse({version: 1, source: null});

/** reference.json（docs の reference）の中身に「取り込んだ動画」があるか。墓標（source: null）は無い扱い */
export const isReferencePresent = (data: unknown): boolean => {
  if (!data || typeof data !== 'object') return false;
  const src = (data as {source?: unknown}).source;
  return !!src && typeof src === 'object';
};

/** 分析まで済んでいるか（取り込んだだけ、はまだ写せない）。型の絞り込みはしない（false でも Reference のまま扱えるように） */
export const isReferenceAnalyzed = (ref: Reference | null | undefined): boolean => !!ref?.source && !!ref.analyzedAt && ref.segments.length > 0;

// ───────────────────────── カットの境界・コンタクトシート ─────────────────────────

export type TimeRange = {startSec: number; endSec: number};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * シーン検出の時刻（秒）からカットの区間を作る。
 * - 頭と尻に近すぎる境界、近すぎる境界どうし（minGapSec 未満）は捨てる（同じカットの揺れ）
 * - 多すぎるときは間隔を広げて maxCuts 以下にする（分析の画が増えすぎないように）
 * - 境界が 1 つも無ければ全体で 1 カット
 */
export const cutBoundaries = (sceneTimes: readonly number[], durationSec: number, opt: {minGapSec?: number; maxCuts?: number} = {}): TimeRange[] => {
  const maxCuts = opt.maxCuts ?? MAX_REFERENCE_CUTS;
  let gap = opt.minGapSec ?? MIN_CUT_GAP_SEC;
  if (!(durationSec > 0)) return [];
  const sorted = [...new Set(sceneTimes.map(r3))].filter((t) => Number.isFinite(t) && t > 0 && t < durationSec).sort((a, b) => a - b);
  const pick = (g: number): number[] => {
    const out: number[] = [];
    for (const t of sorted) {
      if (t < g || durationSec - t < g) continue;
      if (!out.length || t - out[out.length - 1] >= g) out.push(t);
    }
    return out;
  };
  let bounds = pick(gap);
  // 多すぎるときは最小間隔を広げる（等間隔に間引くより、近い境界＝同じ場面の揺れを落とす方が自然）
  while (bounds.length + 1 > maxCuts && gap < durationSec) {
    gap = r3(gap * 1.5);
    bounds = pick(gap);
  }
  const edges = [0, ...bounds, durationSec];
  const out: TimeRange[] = [];
  for (let i = 0; i + 1 < edges.length; i++) if (edges[i + 1] - edges[i] > 0.01) out.push({startSec: r3(edges[i]), endSec: r3(edges[i + 1])});
  return out;
};

export type TempoStats = {count: number; avgSec: number; medianSec: number; minSec: number; maxSec: number; cutsPer10Sec: number};

export const tempoStats = (cuts: readonly TimeRange[], durationSec?: number): TempoStats => {
  const lens = cuts.map((c) => c.endSec - c.startSec).filter((n) => n > 0);
  if (!lens.length) return {count: 0, avgSec: 0, medianSec: 0, minSec: 0, maxSec: 0, cutsPer10Sec: 0};
  const total = durationSec ?? lens.reduce((a, b) => a + b, 0);
  const sorted = [...lens].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: lens.length,
    avgSec: r3(lens.reduce((a, b) => a + b, 0) / lens.length),
    medianSec: r3(median),
    minSec: r3(sorted[0]),
    maxSec: r3(sorted[sorted.length - 1]),
    cutsPer10Sec: total > 0 ? Math.round((lens.length / total) * 100) / 10 : 0,
  };
};

/** 声の区間が全体の何割を占めるか（0〜1） */
export const speechCoverage = (speech: readonly TimeRange[], durationSec: number): number => {
  if (!(durationSec > 0)) return 0;
  const sum = speech.reduce((s, r) => s + Math.max(0, Math.min(r.endSec, durationSec) - Math.max(0, r.startSec)), 0);
  return Math.min(1, Math.round((sum / durationSec) * 1000) / 1000);
};

/** 2 つの区間が重なる秒数 */
export const overlapSec = (a: TimeRange, b: TimeRange): number => Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));

/** コンタクトシートの枚数（1 枚 = SHEET_COLS × SHEET_ROWS コマ） */
export const sheetCount = (durationSec: number): number => {
  const frames = Math.max(1, Math.floor(durationSec * SHEET_FPS) + 1);
  return Math.ceil(frames / (SHEET_COLS * SHEET_ROWS));
};

/** k 枚目（0 始まり）のシートが覆う時間。最後のコマは toSec の位置 */
export const sheetSpan = (sheetIndex: number): {fromSec: number; toSec: number} => {
  const per = SHEET_COLS * SHEET_ROWS;
  return {fromSec: (sheetIndex * per) / SHEET_FPS, toSec: (sheetIndex * per + per - 1) / SHEET_FPS};
};

/** 秒 → どのシートの何段・何列か（プロンプトで「どこを見ればよいか」を書くため） */
export const sheetTileOf = (sec: number): {sheet: number; row: number; col: number} => {
  const n = Math.max(0, Math.round(sec * SHEET_FPS));
  const per = SHEET_COLS * SHEET_ROWS;
  const sheet = Math.floor(n / per);
  const k = n - sheet * per;
  return {sheet, row: Math.floor(k / SHEET_COLS), col: k % SHEET_COLS};
};

/**
 * 区間にカットと声の有無を付ける。カットは**中点が区間に入るもの**（境界の揺れで両方に入らないように）。
 * 区間の外にはみ出したカットは、いちばん近い区間に入れる（数え漏れを作らない）。
 */
export const attachCutsToSegments = (segments: readonly ReferenceSegment[], cuts: readonly TimeRange[], speech: readonly TimeRange[] = []): ReferenceSegment[] => {
  const segs = [...segments].sort((a, b) => a.fromSec - b.fromSec);
  const indices = segs.map(() => [] as number[]);
  cuts.forEach((c, i) => {
    const mid = (c.startSec + c.endSec) / 2;
    let k = segs.findIndex((s) => mid >= s.fromSec && mid < s.toSec);
    if (k < 0 && segs.length) {
      // どこにも入らない（区間の隙間・末尾の揺れ）→ 中点にいちばん近い区間
      let best = Infinity;
      segs.forEach((s, j) => {
        const d = mid < s.fromSec ? s.fromSec - mid : mid - s.toSec;
        if (d < best) {
          best = d;
          k = j;
        }
      });
    }
    if (k >= 0) indices[k].push(i + 1);
  });
  return segs.map((s, k) => ({
    ...s,
    cutIndices: indices[k],
    cutCount: indices[k].length,
    narration: speech.some((r) => overlapSec(r, {startSec: s.fromSec, endSec: s.toSec}) >= 0.3),
  }));
};

// ───────────────────────── 分析（AI の返答 → reference.json） ─────────────────────────

/** 分析の AI が返す形（緩く受けて、足りないものは既定で埋める） */
export const AnalysisResponseSchema = z.object({
  cuts: z
    .array(
      z.object({
        index: z.number().int(),
        telop: z.string().default(''),
        orientation: ReferenceOrientationSchema.default('none'),
        badge: z.string().default(''),
        kind: ClipKindSchema.default('other'),
        angle: AngleSchema.default('mid'),
        subject: z.string().default(''),
        description: z.string().default(''),
        role: SlotRoleSchema.default('filler'),
      }),
    )
    .default([]),
  segments: z
    .array(
      z.object({
        id: z.string().default(''),
        label: z.string().default(''),
        fromSec: z.number(),
        toSec: z.number(),
        role: SlotRoleSchema.default('info'),
        purpose: z.string().default(''),
        telopPattern: z.string().default(''),
        notes: z.string().default(''),
      }),
    )
    .default([]),
  pattern: ReferencePatternSchema.extend({
    /** JSON Schema の都合で null を使えないので、無いときは -1 で返させる */
    revealSec: z.number().nullable().default(null),
  }).default({}),
  summary: z.string().default(''),
  mimicRules: z.array(z.string()).default([]),
});
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;

export type PreparedReference = {
  sceneCuts: number[];
  cuts: TimeRange[];
  /** カットごとのコマ（.studio 相対）。取れなかったものは undefined */
  frames: (string | undefined)[];
  sheets: string[];
  speech: TimeRange[];
};

/**
 * AI の返答を reference.json にまとめる。カットの秒数はシーン検出のもの（AI は変えられない）。
 * 区間は AI のものを尺の中に収め、id を揃え、カットと声を付ける。
 */
export const mergeAnalysis = (base: Reference, prep: PreparedReference, res: AnalysisResponse, meta: {model: string; costUsd: number; analyzedAt: string}): Reference => {
  if (!base.source) throw new Error('参考動画が取り込まれていません');
  const dur = base.source.durationSec;
  const byIndex = new Map(res.cuts.map((c) => [c.index, c]));
  const cuts: ReferenceCut[] = prep.cuts.map((c, i) => {
    const a = byIndex.get(i + 1);
    return ReferenceCutSchema.parse({
      index: i + 1,
      startSec: c.startSec,
      endSec: c.endSec,
      telop: (a?.telop ?? '').trim(),
      orientation: a?.orientation ?? 'none',
      badge: (a?.badge ?? '').trim(),
      shot: {kind: a?.kind ?? 'other', angle: a?.angle ?? 'mid', subject: (a?.subject ?? '').trim(), description: (a?.description ?? '').trim()},
      role: a?.role ?? 'filler',
      frame: prep.frames[i],
    });
  });
  const seen = new Set<string>();
  const segments: ReferenceSegment[] = res.segments
    .map((s) => ({...s, fromSec: Math.max(0, Math.min(dur, r3(s.fromSec))), toSec: Math.max(0, Math.min(dur, r3(s.toSec)))}))
    .filter((s) => s.toSec - s.fromSec >= 0.1)
    .sort((a, b) => a.fromSec - b.fromSec)
    .map((s, k) => {
      let id = s.id.trim() || `s${k + 1}`;
      if (seen.has(id)) id = `${id}_${k + 1}`;
      seen.add(id);
      return ReferenceSegmentSchema.parse({...s, id, label: s.label.trim() || id});
    });
  const pattern = ReferencePatternSchema.parse({
    ...res.pattern,
    revealSec: res.pattern.revealSec === null || res.pattern.revealSec < 0 || res.pattern.revealSec > dur ? null : r3(res.pattern.revealSec),
    saveReasons: (res.pattern.saveReasons ?? []).map((s) => s.trim()).filter(Boolean),
  });
  return ReferenceSchema.parse({
    ...base,
    analyzedAt: meta.analyzedAt,
    model: meta.model,
    costUsd: meta.costUsd,
    sceneCuts: prep.sceneCuts,
    speech: prep.speech,
    sheets: prep.sheets,
    cuts,
    segments: attachCutsToSegments(segments, prep.cuts, prep.speech),
    pattern,
    summary: res.summary.trim(),
    mimicRules: res.mimicRules.map((s) => s.trim()).filter(Boolean),
  });
};

// ───────────────────────── 表示用 ─────────────────────────

export const fmtSec = (n: number): string => {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

export type ReferenceStats = TempoStats & {durationSec: number; speechRatio: number; segments: number};

export const referenceStats = (ref: Reference): ReferenceStats | null => {
  if (!ref.source) return null;
  const cuts = ref.cuts.length ? ref.cuts : cutBoundaries(ref.sceneCuts, ref.source.durationSec);
  return {...tempoStats(cuts, ref.source.durationSec), durationSec: ref.source.durationSec, speechRatio: speechCoverage(ref.speech, ref.source.durationSec), segments: ref.segments.length};
};

/** 区間 1 つを 1 行にする（CLI・ログ・プロンプトで共用） */
export const segmentLine = (ref: Reference, s: ReferenceSegment): string => {
  const cuts = s.cutIndices.map((i) => ref.cuts.find((c) => c.index === i)).filter((c): c is ReferenceCut => !!c);
  const lens = cuts.map((c) => fmtSec(c.endSec - c.startSec)).join(', ');
  const telops = cuts.map((c) => c.telop.trim()).filter((t, i, a) => t && a.indexOf(t) === i);
  const shots = cuts.map((c) => `${c.shot.subject || c.shot.kind}（${c.shot.angle}）`).filter((t, i, a) => a.indexOf(t) === i);
  return [
    `${fmtSec(s.fromSec)}〜${fmtSec(s.toSec)}秒 ${s.label || s.id}（${s.role}）`,
    `${s.cutCount} カット${lens ? `（${lens} 秒）` : ''}`,
    s.purpose ? `目的: ${s.purpose}` : '',
    s.telopPattern ? `テロップの型: ${s.telopPattern}` : '',
    telops.length ? `参考のテロップ: ${telops.map((t) => `「${t}」`).join('')}` : 'テロップなし',
    shots.length ? `映像: ${shots.join(' → ')}` : '',
    `声: ${s.narration ? 'あり' : 'なし'}`,
  ]
    .filter(Boolean)
    .join(' / ');
};

/** 分析結果の要約（CLI と画面のログ用） */
export const describeReference = (ref: Reference): string[] => {
  if (!ref.source) return ['参考動画は取り込まれていません'];
  const st = referenceStats(ref)!;
  const lines = [`参考動画: ${ref.source.originalName || ref.source.file}（${fmtSec(st.durationSec)} 秒・${st.count} カット・平均 ${fmtSec(st.avgSec)} 秒/カット・声 ${Math.round(st.speechRatio * 100)}%）`];
  if (!ref.analyzedAt) return [...lines, '（まだ分析していません）'];
  const p = ref.pattern;
  if (ref.summary) lines.push(`要約: ${ref.summary}`);
  lines.push(`フック: ${p.hookType || '-'}${p.hookText ? `「${p.hookText}」` : ''}`);
  lines.push(`リビール: ${p.revealSec === null ? '無し' : `${fmtSec(p.revealSec)} 秒`}${p.revealStyle ? `（${p.revealStyle}）` : ''}`);
  lines.push(`締め: ${p.ctaText ? `「${p.ctaText}」` : '-'}${p.ctaStyle ? `（${p.ctaStyle}）` : ''}`);
  if (p.telopStyle) lines.push(`テロップの癖: ${p.telopStyle}`);
  if (p.tempoStyle) lines.push(`テンポ: ${p.tempoStyle}`);
  if (p.saveReasons.length) lines.push(`保存理由: ${p.saveReasons.join('・')}`);
  lines.push('区間:');
  for (const s of ref.segments) lines.push(`  - ${segmentLine(ref, s)}`);
  if (ref.mimicRules.length) {
    lines.push('写すときの規則:');
    for (const r of ref.mimicRules) lines.push(`  - ${r}`);
  }
  return lines;
};

// ───────────────────────── 型を写した台本 ─────────────────────────

export const MimicSectionSchema = z.object({
  fromSec: z.number().min(0),
  toSec: z.number().min(0),
  label: z.string().default(''),
  /** 映像の指示（手元の素材の id を添えてよい） */
  video: z.string().default(''),
  cutCount: z.number().int().min(0).default(0),
  /** 1 カットの尺の目安（「0.8〜1.2」のような文字列） */
  cutSec: z.string().default(''),
  telop: z.string().default(''),
  badge: z.string().default(''),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  narration: z.string().default(''),
  /** 参考のどの要素を写したか */
  why: z.string().default(''),
});
export type MimicSection = z.infer<typeof MimicSectionSchema>;

export const MimicPlanSchema = z.object({
  sections: z.array(MimicSectionSchema).default([]),
  notes: z.string().default(''),
  /** 参考にはあるが手元の素材に無いもの（撮り足しの指示になる） */
  unmatched: z.array(z.string()).default([]),
});
export type MimicPlan = z.infer<typeof MimicPlanSchema>;

/**
 * AI が返した区間の秒数を、参考動画の区間に**強制的に**合わせる（区間数が同じとき）。
 * 「徹底的に写す」が要件なので、AI の丸め・ずれで秒数が動かないようにする。カット数も 0 なら参考のもの。
 */
export const fitMimicToReference = (plan: MimicPlan, ref: Reference): {plan: MimicPlan; fitted: boolean} => {
  const segs = [...ref.segments].sort((a, b) => a.fromSec - b.fromSec);
  if (!segs.length || plan.sections.length !== segs.length) return {plan, fitted: false};
  const sections = [...plan.sections]
    .sort((a, b) => a.fromSec - b.fromSec)
    .map((s, i) => ({...s, fromSec: segs[i].fromSec, toSec: segs[i].toSec, cutCount: s.cutCount || segs[i].cutCount, label: s.label || segs[i].label}));
  return {plan: {...plan, sections}, fitted: true};
};

export type MimicIssue = {severity: 'E' | 'W'; code: string; message: string};

const norm = (s: string) => s.replace(/\s+/g, '').replace(/[、。・…！？!?]/g, '');

/** 型を写した台本の検算。E があれば script.md を書かない */
export const checkMimicPlan = (plan: MimicPlan, ref: Reference, opt: {maxTelopChars?: number} = {}): MimicIssue[] => {
  const out: MimicIssue[] = [];
  const max = opt.maxTelopChars ?? 13;
  const segs = [...ref.segments].sort((a, b) => a.fromSec - b.fromSec);
  if (!plan.sections.length) return [{severity: 'E', code: 'MIMIC_NO_SECTIONS', message: '区間が 1 つも返ってきませんでした'}];
  if (segs.length && plan.sections.length !== segs.length)
    out.push({severity: 'E', code: 'MIMIC_SECTION_COUNT', message: `参考動画は ${segs.length} 区間ですが ${plan.sections.length} 区間で返ってきました（同じ区間数で写す）`});
  const refTelops = new Set(ref.cuts.map((c) => norm(c.telop)).filter((t) => countChars(t) >= 4));
  plan.sections.forEach((s, i) => {
    const label = `[${i + 1}] ${s.label || `${fmtSec(s.fromSec)}〜${fmtSec(s.toSec)}秒`}`;
    if (s.toSec <= s.fromSec) out.push({severity: 'E', code: 'MIMIC_BAD_RANGE', message: `${label}: 区間が逆または 0（${s.fromSec}〜${s.toSec}）`});
    const r = segs[i];
    if (r && segs.length === plan.sections.length && (Math.abs(r.fromSec - s.fromSec) > 0.05 || Math.abs(r.toSec - s.toSec) > 0.05))
      out.push({severity: 'E', code: 'MIMIC_SECTION_TIME', message: `${label}: 参考は ${fmtSec(r.fromSec)}〜${fmtSec(r.toSec)} 秒ですが ${fmtSec(s.fromSec)}〜${fmtSec(s.toSec)} 秒になっています`});
    if (r && r.cutCount > 0 && s.cutCount > 0 && s.cutCount !== r.cutCount)
      out.push({severity: 'W', code: 'MIMIC_CUTS_DIFFER', message: `${label}: 参考は ${r.cutCount} カットですが ${s.cutCount} カットです`});
    const t = s.telop.trim();
    if (t && countChars(t) > max) out.push({severity: 'W', code: 'MIMIC_TELOP_LONG', message: `${label}: テロップが ${countChars(t)} 文字（目安 ${max}）「${t}」`});
    if (/[。]$/.test(t)) out.push({severity: 'W', code: 'MIMIC_TELOP_PERIOD', message: `${label}: テロップの文末に句点は付けない`});
    if (t && refTelops.has(norm(t))) out.push({severity: 'W', code: 'MIMIC_TELOP_COPIED', message: `${label}: 参考動画のテロップと同じ文言です「${t}」（型だけ写して中身は自分の店に置き換える）`});
    if (r && r.narration && !s.narration.trim()) out.push({severity: 'W', code: 'MIMIC_NARRATION_MISSING', message: `${label}: 参考では声がある区間ですがナレーションがありません`});
    if (/[\r\n]/.test(s.narration)) out.push({severity: 'W', code: 'MIMIC_NARRATION_NEWLINE', message: `${label}: ナレーションに改行があります（1 行にまとめる）`});
  });
  return out;
};

/**
 * 型を写した台本（script.md）を書き出す。見出しは「台本から組み立てる」が読める形
 * （【0〜2.5秒】フック）。先頭のコメント行は組み立ての AI が意図を掴むためのもの。
 */
export const renderMimicScript = (plan: MimicPlan, ref: Reference, opt: {shopName?: string} = {}): string => {
  const st = referenceStats(ref);
  const p = ref.pattern;
  const head = [
    `# 参考動画の型を写した台本${opt.shopName ? `（${opt.shopName}）` : ''}`,
    st ? `# 参考: ${ref.source?.originalName || ref.source?.file || '-'}（${fmtSec(st.durationSec)} 秒・${st.count} カット・平均 ${fmtSec(st.avgSec)} 秒/カット）` : '',
    '# 写すのは構成・テンポ・テロップの型だけ。参考動画の映像・音声・文言そのものは使わない',
    `# フック: ${p.hookType || '-'} / リビール: ${p.revealSec === null ? '無し' : `${fmtSec(p.revealSec)} 秒`} / 締め: ${p.ctaStyle || '-'}`,
    p.telopStyle ? `# テロップの癖: ${p.telopStyle}` : '',
    p.tempoStyle ? `# テンポ: ${p.tempoStyle}` : '',
    plan.notes ? `# 意図: ${plan.notes.replace(/\s*\n\s*/g, ' ')}` : '',
  ].filter(Boolean);
  const body: string[] = [];
  const sections = [...plan.sections].sort((a, b) => a.fromSec - b.fromSec);
  sections.forEach((s, i) => {
    if (s.toSec - s.fromSec < 0.1) return;
    const t = (v: string | undefined) => (v ?? '').trim();
    const lines = [`【${fmtSec(s.fromSec)}〜${fmtSec(s.toSec)}秒】${t(s.label) || `区間${i + 1}`}`];
    if (t(s.video)) lines.push(`映像： ${t(s.video)}`);
    if (s.cutCount > 0) lines.push(`カット割り： ${s.cutCount} カット${t(s.cutSec) ? `（1 カット ${t(s.cutSec)} 秒）` : ''}`);
    lines.push(`テロップ： ${t(s.telop)}`);
    if (s.orientation === 'horizontal') lines.push('テロップの向き： 横書き');
    if (t(s.badge)) lines.push(`バッジ： ${t(s.badge)}`);
    if (t(s.narration)) lines.push(`ナレーション： ${t(s.narration).replace(/\s*\n\s*/g, ' ')}`);
    if (t(s.why)) lines.push(`狙い： ${t(s.why)}`);
    body.push(lines.join('\n'));
  });
  const tail = plan.unmatched.length ? ['', '# 参考にはあるが手元の素材に無いもの（撮り足しの候補）', ...plan.unmatched.map((u) => `# - ${u}`)] : [];
  return [...head, '', body.join('\n\n'), ...tail].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
};
