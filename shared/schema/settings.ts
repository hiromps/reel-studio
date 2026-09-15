// ユーザー設定（~/.reel-studio/settings.json）のスキーマ。
// フォルダ・音声生成の鍵・裏で走らせる claude の設定を持つ。リポジトリの外に置くので誤コミットが起きない。
// 優先順位は 環境変数 > settings.json > 既定（core/settings.ts が解決する）。
import {z} from 'zod';

export const VoiceEntrySchema = z.object({
  /** Fish Audio の reference_id（32 桁の 16 進数） */
  id: z.string().regex(/^[0-9a-f]{32}$/, 'Fish Audio の reference_id（32 桁の 16 進数）'),
  title: z.string().min(1),
  note: z.string().optional(),
});
export type VoiceEntry = z.infer<typeof VoiceEntrySchema>;

const PathsSchema = z.object({
  workDir: z.string().min(1).optional(),
  uploadsRoot: z.string().min(1).optional(),
  outputsDir: z.string().min(1).optional(),
  sfxDir: z.string().min(1).optional(),
});

const TtsSchema = z.object({
  provider: z.literal('fish-audio').default('fish-audio'),
  /** 平文で保存する（ユーザープロファイル配下。画面やログには出さない） */
  apiKey: z.string().optional(),
  modelId: z.string().min(1).default('s2.1-pro-free'),
  /** 人格の既定ボイス以外に選べるようにしたいボイス（他人の公開モデルは self 一覧に出ないため） */
  voices: z.array(VoiceEntrySchema).default([]),
});

const AgentSchema = z.object({
  /** claude 実行ファイルの場所。省略＝PATH から探す */
  claudeBin: z.string().min(1).optional(),
  /** --model に渡す値。エイリアス（opus / sonnet / haiku）でも完全な id でもよい */
  model: z.string().min(1).default('opus'),
  /** タグ付け 1 回で見せるクリップ数 */
  tagBatchSize: z.number().int().min(1).max(50).default(8),
  /** タグ付けを何本並列で走らせるか */
  tagConcurrency: z.number().int().min(1).max(8).default(3),
  /** 1 回あたりの上限時間（分） */
  timeoutMin: z.number().min(1).max(180).default(20),
});

export const SettingsSchema = z.object({
  version: z.literal(1),
  /** 案件・素材・納品・効果音の親フォルダ。省略＝<アプリ>/data */
  dataRoot: z.string().min(1).optional(),
  /** 個別の上書き。絶対パス、または dataRoot からの相対 */
  paths: PathsSchema.default({}),
  tts: TtsSchema.default({}),
  agent: AgentSchema.default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** PUT /api/settings の本文。書いたキーだけ変える。文字列は null か '' で「消す（既定に戻す）」 */
const nullable = () => z.string().nullable().optional();
export const SettingsPatchSchema = z
  .object({
    dataRoot: nullable(),
    paths: z.object({workDir: nullable(), uploadsRoot: nullable(), outputsDir: nullable(), sfxDir: nullable()}).strict().optional(),
    tts: z
      .object({
        apiKey: nullable(),
        modelId: nullable(),
        voices: z.array(VoiceEntrySchema).optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        claudeBin: nullable(),
        model: nullable(),
        tagBatchSize: z.number().int().min(1).max(50).optional(),
        tagConcurrency: z.number().int().min(1).max(8).optional(),
        timeoutMin: z.number().min(1).max(180).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export type PathKey = 'dataRoot' | 'workDir' | 'uploadsRoot' | 'outputsDir' | 'sfxDir';
export const PATH_KEYS: PathKey[] = ['dataRoot', 'workDir', 'uploadsRoot', 'outputsDir', 'sfxDir'];
export type ValueSource = 'env' | 'settings' | 'default';

/** 鍵の見せ方。値そのものは決して返さない */
export type SecretView = {present: boolean; masked: string; source: 'env' | 'settings' | null};

/** GET /api/settings が返す形（鍵は SecretView に置き換わる） */
export type SettingsView = {
  dir: string;
  file: string;
  exists: boolean;
  /** 設定ファイルが壊れている等の問題（無ければ null）。壊れていても既定値で動く */
  problem: string | null;
  settings: Omit<Settings, 'tts'> & {tts: Omit<Settings['tts'], 'apiKey'> & {apiKey: SecretView}};
  paths: Record<PathKey, {value: string; source: ValueSource; exists: boolean}> & {templateDir: string};
  /** 環境変数で固定されているキー（画面では変更不可にする） */
  env: {fishApiKey: boolean; fishModelId: boolean; claudeBin: boolean; agentModel: boolean};
  claude: {bin: string; available: boolean; source: 'env' | 'settings' | 'path' | 'none'; version: string | null};
};
