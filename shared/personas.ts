// 人格（persona）のレジストリ。ブラウザでも Node でも動く（fs を使わない）。
//
// - サーバー / CLI は起動時に core/personas-store.ts が ~/.reel-studio/personas.json を読んで setPersonas() する
// - ブラウザは GET /api/personas の結果を store が setPersonas() する
// - BUILTIN_PERSONAS は初回起動時の seed（汎用サンプル）。ユーザーは Settings「人格」で自由に編集・削除できる
import {PersonaSchema, type Persona} from './schema/persona';

export {PersonaSchema, PersonasFileSchema, HookStyleSchema} from './schema/persona';
export type {Persona, HookStyle, PersonasFile} from './schema/persona';

/** キャプションの型（汎用）。人格ごとに Settings で書き換えられる */
export const GENERIC_CAPTION_GUIDE = `# キャプションの型

動画に出ているテロップ・ナレーション・裏取り済みの事実だけで書く。推測で料理名・価格・住所・営業時間を作らない。

1. **フック 2 行**: 動画の冒頭フックと同じ切り口の一言（末尾に絵文字 1 個まで）。2 行目に「まさかの〜を見つけた」のような発見のリアクション
2. **ファクト 3〜4 行**: 新しさ（オープン時期）・営業時間の特徴・内装や仕入れのこだわり・設備を 1 情報 1 行で。驚き・情景の行だけに絵文字を添える（全行には付けない）
3. **料理の感想 1〜2 行**: 見た目と味の両方を肯定する一言。ドリンク等のバリエーションがあれば軽く触れる
4. **「頂いたもの🍽️」見出し＋「・」箇条書き**: 5 品まで、価格つき。各品の行には絵文字を付けない。複数種をまとめるときは「／」でつなぎ「各◯円」。**素材映像で実食・手持ちが確認できる品だけ**を書く（メニュー表やのぼりに載っているだけの品を食べたことにしない）
5. 区切り線「———————————————」
6. **店名＋pr 表記＋IG ハンドル**（PR 案件のみ。「『店名』pr」の 1 行、次の行に「@店の IG ハンドル」。PR でなければこのブロックごと省略する）
7. **実用情報**: 📍住所　🚶アクセス　🕘営業時間（定休日）、必要なら※で特記事項
8. 区切り線「———————————————」
9. **ハッシュタグ**（本数は人格の設定どおり。hashtag-bank.md の枠で厳選する）

- 来店を促す一文（「ぜひ行ってみて」等）は必須ではない。入れるなら 3 の直後か実用情報の後に 1 行
- 保存・いいね・シェア・コメント・フォローを促す文言は書かない
- 文末に句点「。」を付けない
- 全体で 12〜18 行（空行込み）。注文点数が多い店でも「頂いたもの」は 5 品に絞り、残りは点数と合計金額の一言に要約する（全品を書くと長文化して離脱される）
`;

/** ハッシュタグの選び方（汎用） */
export const GENERIC_HASHTAG_BANK = `# ハッシュタグの選び方

本数は人格の設定どおり。少数精鋭で、投稿ごとに一番刺さるものだけを選ぶ。

1. **エリア（1 個）**: 市・区レベルを基本にする（例 #東大阪グルメ）。駅・街レベルの方が刺さるならそちらを優先してよい（例 #布施グルメ）
2. **ジャンル・企画の核（1 個）**: 料理ジャンルか、その回の企画の核を 1 語で（例 #食べ放題 #町中華 #デカ盛り #新店グルメ）
3. **決め手（1 個）**: 店名タグ、またはその投稿で一番保存に効きそうな語（例 #しゃぶしゃぶ）
4. 4 個目以降を使う人格は、料理名 → シーン（#デート #女子会 等）→ 近隣エリアの順に足す

- コミュニティ系（#グルメ好きな人と繋がりたい 等）は使わない
- PR 案件は #PR ではなく、本文の店名直後に小文字「pr」で表記する
- 関係ないビッグタグ（エリア違い等）は入れない
- 設定の本数を超えて付けない
`;

const builtin = (p: Omit<Persona, 'captionGuide' | 'hashtagBank'> & Partial<Pick<Persona, 'captionGuide' | 'hashtagBank'>>): Persona =>
  PersonaSchema.parse({captionGuide: GENERIC_CAPTION_GUIDE, hashtagBank: GENERIC_HASHTAG_BANK, ...p});

/**
 * 同梱のサンプル人格。ボイスは未設定（Settings「人格」で Fish Audio のボイスを入れると音声生成が動く）。
 * ここの値を変えても既に seed 済みの personas.json には反映されない（そちらが正）。
 */
export const BUILTIN_PERSONAS: Persona[] = [
  builtin({
    id: 'standard',
    label: 'スタンダード（落ち着いた男性）',
    defaultFormat: 'F0',
    theme: 'pop',
    cta: ['ぜひ行ってみて'],
    ctaPatterns: ['行ってみて', '詳細はキャプションへ'],
    narration: {voiceId: '', voiceTitle: '', speed: 1.2, charsPerSec: 8.2, charsPerSecMeasured: 8.5},
    tone: '関西弁控えめの落ち着いた男性口調。言い切りは柔らかく',
    hookStyle: 'areaDigit',
    narrationRules: ['語尾に「〜わ」を使わない。「〜んや」「〜のや」で言い切らない（「〜んやって」「〜んやった」と後ろへ接続するのは可）'],
    caption: {hashtags: 3, maxChars: 600},
    allowEmptyReveal: false,
  }),
  builtin({
    id: 'discovery',
    label: '発見型（正体隠し・淡々）',
    defaultFormat: 'F7',
    theme: 'human',
    cta: ['これは布教したい'],
    ctaPatterns: ['布教', '教えたくない', '通いたい', '行くしかない', '行ってみて'],
    narration: {voiceId: '', voiceTitle: '', speed: 1.2, charsPerSec: 5.6, charsPerSecMeasured: 6.3},
    tone: '標準語・体言止めの短文。オタク語彙（沼・尊い等）は 1 台本 2〜3 語まで',
    hookStyle: 'areaDigit',
    narrationRules: [],
    caption: {hashtags: 3, maxChars: 600},
    allowEmptyReveal: true,
  }),
  builtin({
    id: 'casual',
    label: 'カジュアル（親しみやすい女性）',
    defaultFormat: 'F0',
    theme: 'pop',
    cta: ['行ってみてな'],
    ctaPatterns: ['行ってみて', '詳細はキャプションへ'],
    narration: {voiceId: '', voiceTitle: '', speed: 1.2, charsPerSec: 7.2, charsPerSecMeasured: 7.2},
    tone: '砕けた関西弁・女性。テロップの「〜わ」は OK、ナレーションでは使わない',
    hookStyle: 'free',
    narrationRules: ['語尾に「〜わ」を使わない'],
    caption: {hashtags: 5, maxChars: 0},
    allowEmptyReveal: false,
  }),
];

// ───────────────────────── レジストリ ─────────────────────────

let registry = new Map<string, Persona>(BUILTIN_PERSONAS.map((p) => [p.id, p]));

/** 一覧を丸ごと差し替える（サーバー起動時・保存後・ブラウザの取得後） */
export const setPersonas = (list: Persona[]): void => {
  registry = new Map(list.map((p) => [p.id, PersonaSchema.parse(p)]));
};

export const listPersonas = (): Persona[] => [...registry.values()];

export const findPersona = (id: string): Persona | undefined => registry.get(id);

/** 無ければ例外（どこで直すかを文に入れる） */
export const getPersona = (id: string): Persona => {
  const p = registry.get(id);
  if (!p) throw new Error(`人格「${id}」が登録されていません。Settings の「人格」で追加するか、brief.json の persona を直してください（登録済み: ${[...registry.keys()].join(', ') || 'なし'}）`);
  return p;
};

/** 新規案件の既定（一覧の先頭） */
export const defaultPersonaId = (): string => listPersonas()[0]?.id ?? 'standard';
