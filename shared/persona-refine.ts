// 既存の人格を、利用者の指示どおりに AI で磨く（ブラウザでも Node でも動く。fs を使わない）。
//
// 例「フックはターゲットを広く。グルメ好き以外にも刺さる言葉で」
// - AI は人格の「言葉に関わる項目」だけを書き直した案を返す。ボイス・話速・id・スキルフォルダは触らせない
// - **保存はしない**。画面は案を編集欄に流し込み、利用者が見比べて「人格を保存」で確定する
// - 案と一緒に、新しい方針で試しに書いたフックの例を返させる（効き方を保存前に確かめるため）
import {z} from 'zod';
import {HookStyleSchema, PersonaSchema, type Persona} from './schema/persona';

/** AI が書き直してよい項目。これ以外（ボイス・話速・id・型・配色・スキルフォルダ）は元の人格のまま */
export const REFINABLE_KEYS = ['tone', 'hookStyle', 'hookRules', 'narrationRules', 'cta', 'ctaPatterns', 'captionGuide', 'hashtagBank'] as const;
export type RefinableKey = (typeof REFINABLE_KEYS)[number];

export const PersonaRefineDraftSchema = z.object({
  tone: z.string(),
  hookStyle: HookStyleSchema,
  hookRules: z.array(z.string()),
  narrationRules: z.array(z.string()),
  cta: z.array(z.string()),
  ctaPatterns: z.array(z.string()),
  captionGuide: z.string(),
  hashtagBank: z.string(),
  /** 何をどう変えたか（画面に出す。1 要素 1 行） */
  changes: z.array(z.string()).default([]),
  /** 新しい方針で試しに書いたフックの例（店名・地名なしで通るもの） */
  samples: z.array(z.string()).default([]),
});
export type PersonaRefineDraft = z.infer<typeof PersonaRefineDraftSchema>;

/** claude の --json-schema に渡す形（PersonaRefineDraftSchema と同じ） */
export const PERSONA_REFINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...REFINABLE_KEYS, 'changes', 'samples'],
  properties: {
    tone: {type: 'string', description: '文体を 1 行で。プロンプトに「文体: …」としてそのまま入る'},
    hookStyle: {type: 'string', enum: [...HookStyleSchema.options], description: 'areaDigit＝冒頭フックを「エリア名＋一桁数字」型に縛る（エリア名はバッジへ）、free＝縛らない'},
    hookRules: {type: 'array', items: {type: 'string'}, description: 'フック（冒頭のテロップとナレーション）の書き方の方針。1 要素 1 行。誰に向けた言葉か・どんな語を使う／避けるか・何を最初に見せるか。◯✕の短い例を添えてよい（0〜6 個）'},
    narrationRules: {type: 'array', items: {type: 'string'}, description: 'ナレーション原稿の禁則。1 要素 1 行'},
    cta: {type: 'array', items: {type: 'string'}, description: '締めテロップの既定文。1〜3 個、先頭が既定。店名・地名を含めない'},
    ctaPatterns: {type: 'array', items: {type: 'string'}, description: '締めテロップとして認める語（部分一致）。cta の核になる語を含める'},
    captionGuide: {type: 'string', description: 'キャプションの型（markdown）。依頼に関係なければ今の値をそのまま返す'},
    hashtagBank: {type: 'string', description: 'ハッシュタグの選び方（markdown）。依頼に関係なければ今の値をそのまま返す'},
    changes: {type: 'array', items: {type: 'string'}, description: '変えた項目と理由。「フックの方針: 〜を足した（依頼の〜に対応）」の形で 1〜8 行。変えていない項目は書かない'},
    samples: {type: 'array', items: {type: 'string'}, description: '書き直した人格で試しに書いたフックのテロップ例 3〜5 個。どの店でも通るよう店名・地名・具体的な金額を入れない（「◯◯」で置いてよい）'},
  },
} as const;

export type PersonaRefineInput = {
  persona: Persona;
  /** 利用者の指示（「フックはターゲットを広く」など） */
  instruction: string;
};

const block = (title: string, body: string): string => `### ${title}\n${body.trim() ? body.trim() : '（空）'}`;
const list = (v: readonly string[]): string => (v.length ? v.map((x) => `- ${x}`).join('\n') : '（なし）');

/** 人格を磨かせるプロンプト */
export const buildPersonaRefinePrompt = (input: PersonaRefineInput): string => {
  const p = input.persona;
  const external = !!p.skillDir;
  return [
    'グルメのショート動画を作る「人格（persona）」を、利用者の指示どおりに書き直してほしい。',
    'この人格は、AI が別の店の素材でテロップ・ナレーション・台本・キャプションを書くときのプロンプトにそのまま入る。',
    '項目ごとに「どこに効くか」: 文体＝テロップとナレーションの全体 / フックの方針＝冒頭のテロップとナレーション / ナレーションの禁則＝ナレーション原稿 / 締め＝最後のテロップ / キャプションの型・ハッシュタグの選び方＝投稿文。',
    '',
    '## 利用者の指示',
    input.instruction.trim(),
    '',
    '## 守ること',
    '- **指示に関係する項目だけ変える。** 関係しない項目は、今の値を一字一句そのまま返す（言い換えて整えない）',
    '- 指示が「フック」についてなら、まず hookRules（フックの方針）で応える。hookStyle が指示と食い違うとき（例: 地元に縛る areaDigit と「ターゲットを広く」）は free にしてよい。その場合は changes に理由を書く',
    '- 方針は、AI がそのまま守れる具体的な書き方にする（「刺さる言葉で」だけで終わらせず、どんな語を使う／避けるかまで書く）。必要なら ◯✕ の短い例を添える',
    '- 今ある規則を消すのは、指示と矛盾するときだけ。消したら changes に書く',
    '- 店名・料理名・地名・価格を人格に入れない（例は「◯◯」で置く）',
    '- 三点リーダーは全角の中黒 3 つ「・・・」にする（「…」は使わない）',
    '- samples は、書き直した人格に従って試しに書いたフックのテロップ例（13 文字前後・句点なし・絵文字なし）',
    external ? '- キャプションの型とハッシュタグの選び方は外部のスキルフォルダで管理しているので、captionGuide と hashtagBank は下の値（空）をそのまま返す' : '',
    '',
    `## 今の人格: ${p.label}（${p.id}）`,
    block('文体（tone）', p.tone),
    block('フックの型（hookStyle）', p.hookStyle === 'areaDigit' ? 'areaDigit（エリア名＋一桁数字。エリア名はバッジへ）' : 'free（縛らない）'),
    block('フックの方針（hookRules）', list(p.hookRules)),
    block('ナレーションの禁則（narrationRules）', list(p.narrationRules)),
    block('締めテロップの既定文（cta）', list(p.cta)),
    block('締めとして認める語（ctaPatterns）', list(p.ctaPatterns)),
    block('キャプションの型（captionGuide）', external ? '' : p.captionGuide),
    block('ハッシュタグの選び方（hashtagBank）', external ? '' : p.hashtagBank),
  ]
    .filter((l) => l !== '')
    .join('\n');
};

/** 前後の空白だけの違いなら元の値を残す（AI が末尾の改行を落としただけで「変わった」扱いにしない） */
const keepIfSame = (before: string, after: string): string => (before.trim() === after.trim() ? before : after.trim());

const trimList = (v: readonly string[]): string[] => v.map((s) => s.trim()).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i);

/**
 * AI の案を元の人格に重ねる。書き直してよい項目だけを差し替え、ボイス・話速・id・スキルフォルダは元のまま。
 * 締めが空で返ってきたら元の値を残す（空だとスキーマを通らない）。スキルフォルダのある人格は投稿文の型を触らない
 */
export const applyPersonaRefine = (base: Persona, draft: PersonaRefineDraft): Persona => {
  const cta = trimList(draft.cta);
  const ctaPatterns = trimList(draft.ctaPatterns);
  return PersonaSchema.parse({
    ...base,
    tone: keepIfSame(base.tone, draft.tone),
    hookStyle: draft.hookStyle,
    hookRules: trimList(draft.hookRules),
    narrationRules: trimList(draft.narrationRules),
    cta: cta.length ? cta : base.cta,
    ctaPatterns: ctaPatterns.length ? ctaPatterns : base.ctaPatterns,
    captionGuide: base.skillDir ? base.captionGuide : keepIfSame(base.captionGuide, draft.captionGuide),
    hashtagBank: base.skillDir ? base.hashtagBank : keepIfSame(base.hashtagBank, draft.hashtagBank),
  });
};

/** 変わった項目（画面で印を付ける・ログに出す） */
export const refinedKeys = (before: Persona, after: Persona): RefinableKey[] =>
  REFINABLE_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));

export const REFINABLE_LABEL: Record<RefinableKey, string> = {
  tone: '文体',
  hookStyle: 'フックの型',
  hookRules: 'フックの方針',
  narrationRules: 'ナレーションの禁則',
  cta: '締めテロップの既定文',
  ctaPatterns: '締めとして認める語',
  captionGuide: 'キャプションの型',
  hashtagBank: 'ハッシュタグの選び方',
};

/** ジョブの結果（画面が読む形） */
export type PersonaRefineResult = {
  id: string;
  /** 磨いたあとの人格（保存はしていない） */
  persona: Persona;
  changed: RefinableKey[];
  changes: string[];
  samples: string[];
  costUsd: number;
};
