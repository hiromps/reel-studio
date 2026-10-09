// 過去案件の編集から抽出する、店やジャンルをまたいで使う型。
import {z} from 'zod';
import type {Catalog} from './schema/catalog';
import {CropSchema, type ReelData} from './schema/cuts';
import type {Narration} from './schema/narration';

export const STYLE_FIELDS = ['hook', 'words', 'cutting', 'sequence', 'telop', 'ending'] as const;
export const STYLE_LABELS: Record<(typeof STYLE_FIELDS)[number], string> = {
  hook: '冒頭フック', words: 'ワードチョイス', cutting: 'カットの切り方・尺',
  sequence: 'カットの並び順', telop: 'テロップ・声の関係', ending: '締め方',
};
const rule = z.string().trim().min(1).max(2000);
export const VideoStyleRulesSchema = z.object({hook: rule, words: rule, cutting: rule, sequence: rule, telop: rule, ending: rule});
export const StyleCutSchema = z.object({
  durationSec: z.number().positive(), role: z.string().max(80),
  playbackRate: z.number().positive().optional(), crop: CropSchema.optional(), motion: z.string().max(80).optional(),
  kind: z.string().max(80), angle: z.string().max(80),
  subject: z.string().max(300), telop: z.string().max(1000), narration: z.string().max(3000),
});
export const VideoStyleDraftSchema = z.object({
  label: z.string().trim().min(1).max(60), summary: z.string().trim().min(1).max(400),
  rules: VideoStyleRulesSchema,
  source: z.object({slug: z.string().min(1).max(100), shop: z.string().max(300), capturedAt: z.string()}),
  referenceCuts: z.array(StyleCutSchema).min(1).max(300),
  instruction: z.string().max(3000),
});
export const VideoStyleSnapshotSchema = VideoStyleDraftSchema.extend({
  id: z.string().regex(/^style-[a-f0-9]{16}$/), revision: z.number().int().positive(), savedAt: z.string(),
});
export const VideoStyleEntrySchema = z.object({id: VideoStyleSnapshotSchema.shape.id, revisions: z.array(VideoStyleSnapshotSchema).min(1)});
export type VideoStyleDraft = z.infer<typeof VideoStyleDraftSchema>;
export type VideoStyleSnapshot = z.infer<typeof VideoStyleSnapshotSchema>;
export type VideoStyleEntry = z.infer<typeof VideoStyleEntrySchema>;

/** 実際の再生尺と、順序を記録。素材のパス・ID は再利用する型に入れない。 */
export const captureStyleCuts = (cuts: ReelData, catalog: Catalog | null, narration: Narration | null) => {
  let at = 0;
  return cuts.cuts.map((cut, i) => {
    const durationSec = (cut.outSec - cut.inSec) / (cut.playbackRate ?? 1);
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('尺が不正なカットがあります。先に Timeline で直してください');
    let src = cut.src;
    const seen = new Set<string>();
    while (!seen.has(src)) {
      seen.add(src);
      const alias = cuts.meta?.aliases?.find((a) => a.to === src);
      if (!alias) break;
      src = alias.from;
    }
    const clip = catalog?.clips.find((c) => c.src === src || c.proxyOf === src);
    const slot = cuts.meta?.slots?.find((s) => s.cutId === cut.id);
    const text = narration?.segments.filter((s) => s.at >= at - 0.001 && s.at < at + durationSec - 0.001).map((s) => s.text).join(' / ') ?? '';
    at += durationSec;
    return {
      durationSec: Math.round(durationSec * 1000) / 1000,
      playbackRate: cut.playbackRate ?? 1, ...(cut.crop ? {crop: cut.crop} : {}), motion: clip?.tags?.motion ?? '未確認',
      role: slot?.role ?? (i === 0 ? 'hook' : '未分類'),
      kind: clip?.tags?.kind ?? '未確認', angle: clip?.tags?.angle ?? '未確認',
      subject: clip?.tags?.subject ?? '',
      telop: [cut.main?.text, ...(cut.subs ?? []).map((s) => s.text)].filter(Boolean).join(' / '), narration: text,
    };
  });
};

/** 店固有の情報は手本であると明示し、コピー先の事実へ置き換える。 */
export const videoStylePrompt = (style?: VideoStyleSnapshot | null): string => {
  if (!style) return '';
  return [
    '## この案件に適用する動画の型: ' + style.label + ' v' + style.revision,
    '型ID: ' + style.id + ' / ' + style.summary,
    '今回の明示的な指示・確定台本・全案件共通の禁則・コピー先の事実を優先。その範囲でこの型を人格の既定より優先する。',
    ...STYLE_FIELDS.map((key) => STYLE_LABELS[key] + ': ' + style.rules[key]),
    '以下は元案件の観測例。料理名・店名・価格・地名・映像・音声はコピー先のものに置き換える。未確認の特徴や実績は捏造しない。',
    '単語の置換だけで済ませず、同じ役割を果たすコピー先の画へ対応付ける。カット尺の強弱、言葉の長さ、情報を明かす順番を再現する。',
    '尺の指定が異なる場合は区間の比率とテンポの強弱を残して調整する。素材が無い役割は代替案または unmatched へ記載。',
    '元案件のカット順（秒・役割・画・テロップ・声）:\n' + JSON.stringify(style.referenceCuts),
    'notes / why に、どの型をどう適用し、素材やジャンルに合わせて何を変えたかを記す。',
  ].join('\n');
};

/** 自己完結する通常の SKILL.md。スナップショットごとに再生成できる。 */
export const renderVideoStyleSkill = (style: VideoStyleSnapshot): string => [
  '---',
  'name: reel-' + style.id,
  'description: ' + JSON.stringify('「' + style.label + '」の型で、別の店・ジャンルのショート動画の台本とカット構成を作る。過去案件のフック、言葉選び、尺と並び順を引き継ぐときに使う。'),
  '---', '',
  '# ' + style.label + '（v' + style.revision + '）', '',
  videoStylePrompt(style), '',
  '## 使い方',
  'コピー先の brief（店の事実・意図・尺）、catalog（素材とタグ）、確定済みの台本があれば読む。',
  '新しい台本では各区間の秒数、映像の役割、コピー先の素材、カット数・尺、テロップ、ナレーション、狙いを提示する。',
  'Reel Studio では Brief の型を選んで台本を作り、割り当てを確認して Timeline に反映する。',
  '修正のうち次の案件にも通じるものを、この型の各項目へ反映し新しい版として保存する。今回の店だけの修正は案件へ残す。',
  '元の版と使用中の案件の型を勝手に書き換えない。会話で得た知見はファイルへ保存して初めて永続化される。', '',
  '元案件: ' + style.source.slug + ' / 保存: ' + style.savedAt,
].join('\n') + '\n';
