// 人格（persona）のスキーマ。~/.reel-studio/personas.json の 1 要素。
// 文体・声・テロップの色・既定の構成の型・キャプションの型をまとめて持つ。brief.json の persona がこの id を指す。
import {z} from 'zod';
import {FormatIdSchema, PersonaIdSchema} from './brief';
import {ThemeSchema} from './cuts';

export const HookStyleSchema = z.enum(['areaDigit', 'free']);
export type HookStyle = z.infer<typeof HookStyleSchema>;

export const PersonaSchema = z.object({
  id: PersonaIdSchema,
  label: z.string().min(1).max(40),
  defaultFormat: FormatIdSchema.default('F0'),
  theme: ThemeSchema.default('pop'),
  /** 締めテロップの既定文（先頭が draft に使われる） */
  cta: z.array(z.string().min(1)).min(1),
  /** 締めテロップとして認める語族（validate の CTA_TEXT 判定） */
  ctaPatterns: z.array(z.string().min(1)).min(1),
  narration: z.object({
    /** Fish Audio の reference_id。空＝未設定（黙って別の声にしない。音声生成が「未設定です」で止まる） */
    voiceId: z.string().regex(/^(|[0-9a-f]{32})$/, 'Fish Audio の reference_id（32 桁の 16 進数）か空'),
    voiceTitle: z.string().default(''),
    speed: z.number().min(0.5).max(2).default(1.6),
    /** 文字数設計に使う値（ブロック秒数 × charsPerSec が上限） */
    charsPerSec: z.number().positive().default(9),
    /** 参考：実測話速 */
    charsPerSecMeasured: z.number().positive().default(9),
  }),
  /** 文体（プロンプトにそのまま入る 1 行） */
  tone: z.string().default(''),
  /** フックの型。areaDigit＝「エリア名＋一桁数字」（エリア名はバッジへ出す）。free＝縛らない */
  hookStyle: HookStyleSchema.default('free'),
  /** ナレーション原稿の禁則。1 要素 1 行でプロンプトの箇条書きになる */
  narrationRules: z.array(z.string().min(1)).default([]),
  /** キャプションの型（markdown）。skillDir が無いとき <案件>/.studio/persona/caption-guide.md に書き出して読ませる */
  captionGuide: z.string().default(''),
  /** ハッシュタグの選び方（markdown）。同上 hashtag-bank.md */
  hashtagBank: z.string().default(''),
  /** 外部のスキルフォルダ（絶対パス）。あれば SKILL.md と references/hashtag-bank.md をこちらで使い、--add-dir で渡す */
  skillDir: z.string().min(1).optional(),
  /** キャプション（型の文書）のうち、コード側で機械的に点検できる部分だけ */
  caption: z
    .object({
      /** ハッシュタグの本数（ちょうどこの数） */
      hashtags: z.number().int().min(0).max(30).default(3),
      /** 「他の投稿はコチラ」で誘導する自分のアカウント。無ければその行を書かない */
      repostAccount: z
        .string()
        .regex(/^[A-Za-z0-9._]{1,30}$/, 'Instagram のユーザー名（@ 無し）')
        .optional(),
      /** 長さの目安（文字）。0 = 上限なし */
      maxChars: z.number().int().min(0).default(600),
    })
    .default({}),
  /** F7 の店名リビールグループを空テロップにしてよい（店名を文字で書かない人格） */
  allowEmptyReveal: z.boolean().default(false),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const PersonasFileSchema = z
  .object({version: z.literal(1), personas: z.array(PersonaSchema).min(1, '人格は 1 つ以上必要です')})
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.personas.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({code: z.ZodIssueCode.custom, path: ['personas', i, 'id'], message: `id が重複しています: ${p.id}`});
      seen.add(p.id);
    });
  });
export type PersonasFile = z.infer<typeof PersonasFileSchema>;
