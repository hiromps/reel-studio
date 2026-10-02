// 人格（persona）を、分析済みの動画から言語化して作る。純粋（ファイルも MCP も AI も触らない）。
//
// 流れ:
//   Instagram のユーザー名 ──Smartgram MCP get_user_posts──▶ 最新の動画 N 本（直リンク・キャプション付き）
//   動画 1 本ずつ ──「バズ動画の型を写す」と同じ分析（analyzeReference）──▶ reference.json（型の言語化）
//   分析 N 本 ＋ 案件で分析済みの参考動画 ＋ 投稿のキャプション ──claude──▶ 人格の下書き（文体・締め・フック・キャプションの型）
//   下書き ──personaFromDraft──▶ Persona（ボイスは空のまま。Settings で入れる）
//
// **写すのは言葉の癖・構成・締め方・キャプションの型だけ。** 店名・料理名・地名などの中身は人格に入れない。
import {z} from 'zod';
import {FormatIdSchema, PersonaIdSchema} from './schema/brief';
import {ThemeSchema} from './schema/cuts';
import {HookStyleSchema, PersonaSchema, type Persona} from './schema/persona';
import {FORMAT_SPECS, FORMAT_IDS} from './format-specs';
import {describeReference, isReferenceAnalyzed, type Reference} from './reference';

/** 1 回で分析する動画数の上限（1 本あたり数分・API 課金があるので抑える） */
export const MAX_STUDY_VIDEOS = 20;
export const DEFAULT_STUDY_VIDEOS = 6;
/** get_user_posts の count の上限（MCP 側の制約） */
export const POSTS_FETCH_MAX = 50;

// ───────────────────────── Instagram の投稿一覧（get_user_posts の返り） ─────────────────────────

export type InstagramPost = {
  id: string;
  /** 投稿の shortcode（/reel/<code>/） */
  code: string;
  url: string;
  caption: string;
  mediaType: string;
  /** ISO。取れなければ空 */
  takenAt: string;
  likeCount: number;
  commentCount: number;
  /** 動画の直リンク（署名付き・数時間で失効）。写真は null */
  videoUrl: string | null;
  thumbnailUrl: string | null;
  username: string;
  fullName: string;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);
const httpsUrl = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\//i.test(v) ? v : null);
const CODE_RE = /^[A-Za-z0-9_-]{5,64}$/;

/** 1 件分。code が無いもの（読めない形）は null */
export const pickInstagramPost = (raw: unknown): InstagramPost | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const code = str(o.code ?? o.shortcode);
  if (!CODE_RE.test(code)) return null;
  const takenRaw = o.takenAt ?? o.taken_at;
  let takenAt = '';
  if (typeof takenRaw === 'string') takenAt = Number.isNaN(Date.parse(takenRaw)) ? '' : new Date(takenRaw).toISOString();
  else if (typeof takenRaw === 'number') takenAt = new Date(takenRaw > 1e12 ? takenRaw : takenRaw * 1000).toISOString();
  const mediaTypeRaw = o.mediaType ?? o.media_type;
  // mediaType は "video" のような文字列か、Instagram の数値（2 = 動画）
  const mediaType = typeof mediaTypeRaw === 'number' ? (mediaTypeRaw === 2 ? 'video' : mediaTypeRaw === 8 ? 'carousel' : 'image') : str(mediaTypeRaw).toLowerCase();
  // caption は文字列か、{text: ...} の入れ子
  const caption = o.caption && typeof o.caption === 'object' ? str((o.caption as {text?: unknown}).text) : str(o.caption);
  return {
    id: str(o.id ?? o.pk),
    code,
    url: `https://www.instagram.com/reel/${code}/`,
    caption,
    mediaType,
    takenAt,
    likeCount: num(o.likeCount ?? o.like_count),
    commentCount: num(o.commentCount ?? o.comment_count),
    videoUrl: httpsUrl(o.videoUrl ?? o.video_url),
    thumbnailUrl: httpsUrl(o.thumbnailUrl ?? o.thumbnail_url),
    username: str(o.username ?? (o.user as {username?: unknown} | undefined)?.username ?? ''),
    fullName: str(o.fullName ?? o.full_name ?? ''),
  };
};

/** get_user_posts の結果（JSON）から投稿の一覧を取り出す。{posts: [...]} / {items: [...]} / 配列 を受ける */
export const pickInstagramPosts = (raw: unknown): InstagramPost[] => {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const k of ['posts', 'items', 'medias', 'data']) {
      if (Array.isArray(o[k])) {
        list = o[k] as unknown[];
        break;
      }
    }
  }
  const out: InstagramPost[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const p = pickInstagramPost(x);
    if (!p || seen.has(p.code)) continue;
    seen.add(p.code);
    out.push(p);
  }
  return out;
};

export const isVideoPost = (p: InstagramPost): boolean => !!p.videoUrl && (p.mediaType === 'video' || p.mediaType === 'reel' || p.mediaType === 'clips' || p.mediaType === '');

/** 動画（直リンクがあるもの）だけを新しい順に count 本。日時が無いものは返ってきた順を保つ */
export const selectStudyPosts = (posts: readonly InstagramPost[], count: number): InstagramPost[] => {
  const n = Math.max(1, Math.min(MAX_STUDY_VIDEOS, Math.floor(count) || DEFAULT_STUDY_VIDEOS));
  const videos = posts.map((p, i) => ({p, i})).filter(({p}) => isVideoPost(p));
  videos.sort((a, b) => {
    if (a.p.takenAt && b.p.takenAt && a.p.takenAt !== b.p.takenAt) return a.p.takenAt < b.p.takenAt ? 1 : -1;
    return a.i - b.i;
  });
  return videos.slice(0, n).map(({p}) => p);
};

/** 写真や複数枚投稿が混ざるので、欲しい本数より多めに取る（MCP の上限 50 まで） */
export const postsFetchCount = (count: number): number => Math.min(POSTS_FETCH_MAX, Math.max(12, Math.ceil(count * 2)));

/** フォルダ名に使う（code は英数字と _- だけだが、念のため） */
export const studyFolderName = (code: string): string => code.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'post';

/** Instagram のユーザー名として受ける形（@ は剥がす） */
export const normalizeInstagramUser = (input: string): string | null => {
  const t = input.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(t) ? t : null;
};

// ───────────────────────── 1 本分の記録（study.json） ─────────────────────────

export const PersonaStudySchema = z.object({
  version: z.literal(1).default(1),
  target: z.string().min(1),
  code: z.string().min(1),
  url: z.string().min(1),
  takenAt: z.string().default(''),
  caption: z.string().default(''),
  likeCount: z.number().default(0),
  commentCount: z.number().default(0),
  username: z.string().default(''),
  fullName: z.string().default(''),
  savedAt: z.string(),
});
export type PersonaStudy = z.infer<typeof PersonaStudySchema>;

export const studyFromPost = (target: string, p: InstagramPost, savedAt = new Date().toISOString()): PersonaStudy =>
  PersonaStudySchema.parse({version: 1, target, code: p.code, url: p.url, takenAt: p.takenAt, caption: p.caption, likeCount: p.likeCount, commentCount: p.commentCount, username: p.username, fullName: p.fullName, savedAt});

// ───────────────────────── 言語化（AI の返答 → Persona） ─────────────────────────

/** 人格づくりの材料 1 件。Instagram の動画なら study が付き、案件の参考動画なら slug が付く */
export type PersonaSource = {
  reference: Reference;
  study?: PersonaStudy;
  slug?: string;
  shopName?: string;
};

export const PersonaDraftSchema = z.object({
  label: z.string().default(''),
  tone: z.string().default(''),
  cta: z.array(z.string()).default([]),
  ctaPatterns: z.array(z.string()).default([]),
  hookStyle: HookStyleSchema.default('free'),
  narrationRules: z.array(z.string()).default([]),
  defaultFormat: FormatIdSchema.default('F0'),
  theme: ThemeSchema.default('pop'),
  allowEmptyReveal: z.boolean().default(false),
  captionGuide: z.string().default(''),
  hashtagBank: z.string().default(''),
  hashtags: z.number().int().min(0).max(30).default(3),
  maxChars: z.number().int().min(0).default(600),
  /** この人格の要約（画面とログに出す） */
  summary: z.string().default(''),
  /** 根拠（どの動画のどこからそう判断したか） */
  evidence: z.array(z.string()).default([]),
});
export type PersonaDraft = z.infer<typeof PersonaDraftSchema>;

const enumOf = (v: readonly string[]) => ({type: 'string', enum: [...v]});

/** claude の --json-schema に渡す形（PersonaDraftSchema と同じ） */
export const PERSONA_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'tone', 'cta', 'ctaPatterns', 'hookStyle', 'narrationRules', 'defaultFormat', 'theme', 'allowEmptyReveal', 'captionGuide', 'hashtagBank', 'hashtags', 'maxChars', 'summary', 'evidence'],
  properties: {
    label: {type: 'string', description: '人格の表示名（20 文字まで。例「おっしー風（関西・発見型）」）'},
    tone: {type: 'string', description: '文体を 1 行で。プロンプトに「文体: …」としてそのまま入る（方言・語尾・一人称・テンション・言い切り方・絵文字の有無）'},
    cta: {type: 'array', items: {type: 'string'}, description: '締めテロップの既定文。動画の締めで実際に使われていた言い回しを一般化したもの（店名・地名を含めない）。1〜3 個、先頭が既定'},
    ctaPatterns: {type: 'array', items: {type: 'string'}, description: '締めテロップとして認める語（部分一致）。cta の核になる語を含める。2〜6 個'},
    hookStyle: {...enumOf(HookStyleSchema.options), description: 'areaDigit＝冒頭フックが「エリア名＋一桁数字」型（地元の9割が知らない 等）、free＝縛らない'},
    narrationRules: {type: 'array', items: {type: 'string'}, description: 'ナレーション原稿の禁則。1 要素 1 行。根拠のあるものだけ（0〜5 個）'},
    defaultFormat: {...enumOf(FormatIdSchema.options), description: '一番多かった構成の型'},
    theme: {...enumOf(ThemeSchema.options), description: 'テロップの配色の傾向'},
    allowEmptyReveal: {type: 'boolean', description: '店名をテロップに書かず映像だけで明かすことが多ければ true'},
    captionGuide: {type: 'string', description: 'キャプションの型（markdown）。実際のキャプションから抽出した構成を、番号付きの手順として書く。固有名詞は例としてだけ'},
    hashtagBank: {type: 'string', description: 'ハッシュタグの選び方（markdown）。本数・エリア／ジャンル／決め手の並び・使わないタグ'},
    hashtags: {type: 'integer', description: 'キャプションのハッシュタグ本数（投稿の中央値）'},
    maxChars: {type: 'integer', description: 'キャプションの長さの目安（文字。投稿の典型を 50 の倍数に丸める。0 なら上限なし）'},
    summary: {type: 'string', description: 'この人格の特徴を 2〜4 行'},
    evidence: {type: 'array', items: {type: 'string'}, description: '根拠。「動画 2 の締め「〜行ってみて」」のように出どころを添えて 5〜12 個'},
  },
} as const;

/** 動画の分析を人格づくりの材料として 1 本ずつ書く */
export const describeSource = (s: PersonaSource, index: number): string[] => {
  const head = s.study
    ? `### 動画 ${index}: Instagram @${s.study.username || s.study.target} の投稿 ${s.study.code}${s.study.takenAt ? `（${s.study.takenAt.slice(0, 10)}）` : ''} いいね ${s.study.likeCount}・コメント ${s.study.commentCount}`
    : `### 動画 ${index}: 案件「${s.slug ?? '-'}」の参考動画${s.shopName ? `（${s.shopName} の案件で参考にしたもの）` : ''}`;
  const lines = [head, ...describeReference(s.reference).map((l) => (l.startsWith('  ') ? l : `- ${l}`))];
  if (s.study?.caption.trim()) lines.push('', '投稿のキャプション（そのまま）:', '```', s.study.caption.trim(), '```');
  return lines;
};

export type PersonaPromptInput = {
  /** 元にした Instagram のユーザー名（無ければ案件の参考動画だけ） */
  target?: string;
  sources: PersonaSource[];
  /** 既存の人格を出発点にする（ボイス・話速はこちらから引き継ぐ） */
  base?: Persona;
  /** 利用者からの補足（「関西弁で」「女性の口調で」など） */
  hint?: string;
};

/** 人格を言語化させるプロンプト */
export const buildPersonaPrompt = (input: PersonaPromptInput): string => {
  const formats = FORMAT_IDS.map((f) => `${f}: ${FORMAT_SPECS[f].name}`).join(' / ');
  const studies = input.sources.filter((s) => s.study);
  const captions = studies.filter((s) => s.study!.caption.trim()).length;
  return [
    'グルメのショート動画を作る「人格（persona）」を、分析済みの動画から言語化してほしい。',
    '人格は「誰の声・文体で作るか」のまとまりで、文体・締めテロップの言い回し・フックの型・ナレーションの禁則・既定の構成の型・テロップの配色・キャプションの型・ハッシュタグの選び方からなる。',
    'この人格は、このあと**別の店の素材**で動画を作るときに AI のテロップ・ナレーション・キャプションに効く。',
    input.target ? `元にするのは Instagram の @${input.target} の最新の動画 ${studies.length} 本${input.sources.length > studies.length ? `と、案件で分析済みの参考動画 ${input.sources.length - studies.length} 本` : ''}。` : `元にするのは案件で分析済みの参考動画 ${input.sources.length} 本。`,
    '',
    '## 守ること',
    '- **言葉の癖・構成・締め方・キャプションの型だけを写す。** 店名・料理名・地名・価格・数字そのものは人格に入れない（cta や tone に固有名詞を残さない）',
    '- 分析に書いてあること（テロップ・区間・締め・キャプション）だけを根拠にする。推測で方言や口調を決めない。根拠が無い項目は無難な既定（hookStyle=free、narrationRules=[]）にする',
    '- cta は締めテロップで実際に使われていた言い回しを一般化したもの（「ぜひ行ってみて」「一度は行っとこ」のような、店名無しで通る形）。ctaPatterns は cta の核になる語',
    '- hookStyle は、冒頭フックが「エリア名＋一桁数字」（地元の9割が知らない、〜で3本の指に入る 等）の型なら areaDigit、そうでなければ free',
    `- defaultFormat は一番近い構成の型を選ぶ（${formats}）。F7 は店名を伏せて発見させる型、F0 は一点突破型`,
    '- theme は pop（明るい・丸い）/ bold（太い・強い）/ human（人肌・手書き風）/ stylish（細い・洗練）からテロップの見た目に近いもの',
    captions
      ? '- captionGuide は、投稿のキャプションの構成（行数・順番・絵文字の付け方・区切り線・「頂いたもの」などの見出し・実用情報の並び・ハッシュタグの位置と本数）を**番号付きの手順**として書く。固有名詞は書かず、「店名」「料理名」のような置き場で書く。既存の型と同じく「書かないこと」も箇条書きで添える'
      : '- captionGuide は、動画の締め方・保存させている情報から推測できる範囲で書き、推測した部分には「（要確認）」と添える',
    captions ? '- hashtagBank は実際のタグの選び方（エリア → ジャンル → 店名や決め手、本数、使っていない種類のタグ）をまとめる。hashtags はキャプションのタグ本数の中央値' : '- hashtagBank は無難な既定（エリア 1・ジャンル 1・決め手 1）でよい',
    '- narrationRules は、声の使い方の分析から確かに言えることだけ（例「語尾に「〜わ」を使わない」）。無ければ空',
    '- evidence には「動画 2 の締め「〜」」「動画 1〜4 のキャプションが全部〜で始まる」のように、どの動画のどこを根拠にしたかを書く',
    '- 三点リーダーを書くときは全角の中黒 3 つ「・・・」にする（「…」は使わない）',
    '',
    input.base
      ? [
          '## 出発点にする既存の人格（違いが分析から読み取れた項目だけ変える。読み取れない項目はこの値を残す）',
          `- 表示名: ${input.base.label}`,
          `- 文体: ${input.base.tone || '-'}`,
          `- 締め: ${input.base.cta.join('／')}（認める語: ${input.base.ctaPatterns.join('／')}）`,
          `- フックの型: ${input.base.hookStyle} / 既定の型: ${input.base.defaultFormat} / テーマ: ${input.base.theme}`,
          ...input.base.narrationRules.map((r) => `- ナレーションの禁則: ${r}`),
          `- ハッシュタグ ${input.base.caption.hashtags} 本 / 長さの目安 ${input.base.caption.maxChars || '上限なし'}`,
          '',
        ].join('\n')
      : '',
    input.hint?.trim() ? `## 利用者からの補足\n${input.hint.trim()}\n` : '',
    '## 分析済みの動画',
    ...input.sources.flatMap((s, i) => [...describeSource(s, i + 1), '']),
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
};

/** 既存の人格を下敷きにするときに引き継ぐ値（ボイス・話速は分析からは分からない） */
const carry = (base: Persona | undefined) => ({
  narration: base ? {...base.narration} : {voiceId: '', voiceTitle: '', speed: 1.2, charsPerSec: 8, charsPerSecMeasured: 8},
  caption: {repostAccount: base?.caption.repostAccount},
  skillDir: undefined as string | undefined,
});

/**
 * AI の下書きから Persona を組み立てる。id は呼び出し側が決める（AI には決めさせない）。
 * ボイスは base から引き継ぐか空（空のままだと音声生成が「未設定です」で止まるので Settings で入れる）。
 */
export const personaFromDraft = (id: string, draft: PersonaDraft, opt: {base?: Persona; label?: string} = {}): Persona => {
  const pid = PersonaIdSchema.parse(id);
  const c = carry(opt.base);
  const trimList = (v: readonly string[]) => v.map((s) => s.trim()).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i);
  const cta = trimList(draft.cta);
  const ctaPatterns = trimList(draft.ctaPatterns);
  const label = (opt.label?.trim() || draft.label.trim() || `AI 生成 ${pid}`).slice(0, 40);
  return PersonaSchema.parse({
    id: pid,
    label,
    defaultFormat: draft.defaultFormat,
    theme: draft.theme,
    cta: cta.length ? cta : (opt.base?.cta ?? ['ぜひ行ってみて']),
    ctaPatterns: ctaPatterns.length ? ctaPatterns : cta.length ? cta : (opt.base?.ctaPatterns ?? ['行ってみて']),
    narration: c.narration,
    tone: draft.tone.trim(),
    hookStyle: draft.hookStyle,
    narrationRules: trimList(draft.narrationRules),
    captionGuide: draft.captionGuide.trim() || (opt.base?.captionGuide ?? ''),
    hashtagBank: draft.hashtagBank.trim() || (opt.base?.hashtagBank ?? ''),
    caption: {hashtags: draft.hashtags, maxChars: draft.maxChars, ...(c.caption.repostAccount ? {repostAccount: c.caption.repostAccount} : {})},
    allowEmptyReveal: draft.allowEmptyReveal,
  });
};

/** 使える材料だけに絞る（分析まで済んでいないものは落とす） */
export const usableSources = (sources: readonly PersonaSource[]): PersonaSource[] => sources.filter((s) => isReferenceAnalyzed(s.reference));

/** 画面・CLI・ログ用の要約 */
export const describePersonaDraft = (p: Persona, draft?: PersonaDraft): string[] => {
  const lines = [
    `人格: ${p.label}（${p.id}）`,
    `文体: ${p.tone || '-'}`,
    `締め: ${p.cta.join('／')}（認める語: ${p.ctaPatterns.join('／')}）`,
    `フックの型: ${p.hookStyle === 'areaDigit' ? 'エリア名＋一桁数字' : '縛らない'} / 既定の型: ${p.defaultFormat} ${FORMAT_SPECS[p.defaultFormat].name} / テーマ: ${p.theme}`,
    `ハッシュタグ ${p.caption.hashtags} 本 / 長さの目安 ${p.caption.maxChars || '上限なし'}${p.allowEmptyReveal ? ' / F7 で店名テロップを空にしてよい' : ''}`,
  ];
  for (const r of p.narrationRules) lines.push(`ナレーションの禁則: ${r}`);
  if (draft?.summary) lines.push(`要約: ${draft.summary}`);
  if (draft?.evidence.length) {
    lines.push('根拠:');
    for (const e of draft.evidence) lines.push(`  - ${e}`);
  }
  lines.push(p.narration.voiceId ? `ボイス: ${p.narration.voiceTitle || p.narration.voiceId}` : 'ボイス: 未設定（Settings の「人格」で Fish Audio のボイスを入れてください）');
  return lines;
};
