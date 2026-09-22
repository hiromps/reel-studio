// 案件の「形」。fs を触らないのでクラウド（Vercel）側からも読める。
// 実体の操作（探索・作成・エンジン同期）は core/project.ts。
import {z} from 'zod';
import {BriefSchema, type Brief, type PersonaId} from './schema/brief';
import {getPersona} from './personas';

/** エンジンの系統。standard（同梱エンジン＝Noto Serif JP）だけがマスターとの同期対象。yui / instagram は別デザインなので触らない */
export type EngineFamily = 'standard' | 'yui' | 'instagram' | 'unknown';
export type EngineDiff = {stale: boolean; family: EngineFamily; files: {file: string; status: 'ok' | 'differs' | 'missing'}[]};

export type ProjectInfo = {
  slug: string;
  dir: string;
  has: {
    catalog: boolean;
    brief: boolean;
    cuts: boolean;
    narration: boolean;
    /** 参考動画（型を写す元）を取り込んであるか。「別の案件の分析を使う」の候補に出す */
    reference?: boolean;
  };
  /** out/ の書き出し物。GUI が「レンダー前に mix を押す」のを防ぐために見る */
  out: {draft: boolean; final: boolean; narration: boolean};
  engine: EngineDiff;
  nodeModules: boolean;
  updatedAt: string;
  persona?: PersonaId;
  format?: string;
  /** 投稿し終えて一覧から隠した日時（ISO）。省略＝一覧に出す。中身は消さない */
  archivedAt?: string;
};

/**
 * 案件の付帯情報（`.studio/meta.json` ＝ docs の `meta`）。
 *
 * 「投稿し終えたか」は企画の中身ではないので **brief.json には入れない**。
 * brief を編集している最中に一覧から隠すと ETag がぶつかって「外部で変更されました」になるため、
 * 一覧の都合だけで書き換わる値は別の小さな doc に分けてある。
 * docs に載せてあるので、PC で隠せばスマホにも、スマホで隠せば PC にも、ワーカーの同期で伝わる。
 */
export const ProjectMetaSchema = z.object({
  version: z.literal(1).default(1),
  /** 投稿済みで編集が要らなくなった日時（ISO）。null＝一覧に出す */
  archivedAt: z.string().nullable().default(null),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export const emptyProjectMeta = (): ProjectMeta => ProjectMetaSchema.parse({});

/** 壊れていても既定（＝隠していない）で動かす。一覧が出なくなる方が困る */
export const parseProjectMeta = (v: unknown): ProjectMeta => {
  const r = ProjectMetaSchema.safeParse(v ?? {});
  return r.success ? r.data : emptyProjectMeta();
};

/** archived を立てた／下ろしたあとの meta */
export const withArchived = (meta: ProjectMeta, archived: boolean, now = new Date()): ProjectMeta => ({
  ...meta,
  archivedAt: archived ? (meta.archivedAt ?? now.toISOString()) : null,
});

export const CONTRACT_FILES = ['catalog', 'brief', 'cuts', 'narration'] as const;
export type ContractName = (typeof CONTRACT_FILES)[number];

/**
 * クラウドの docs テーブルが持つ単位。契約ファイル 4 つに、案件フォルダ直下の
 * caption.txt / script.md / hooks.json（いずれも画面が読み書きする）を足したもの。
 * テキストのもの（caption / script）は `{text: string}` の形で入れる。
 */
export const DOC_NAMES = [...CONTRACT_FILES, 'caption', 'script', 'hooks', 'scriptPlan', 'meta', 'reference'] as const;
export type DocName = (typeof DOC_NAMES)[number];

/** docs の名前 → 案件フォルダ内のパス（ワーカーの同期が使う） */
export const DOC_FILES: Record<DocName, string> = {
  catalog: 'catalog.json',
  brief: 'brief.json',
  cuts: 'cuts.json',
  narration: 'narration.json',
  caption: 'caption.txt',
  script: 'script.md',
  hooks: 'hooks.json',
  // AI の「割り当てを見るだけ」の結果。承認で cuts/narration に書き込まれる
  scriptPlan: '.studio/script-plan.json',
  // 一覧の都合だけの値（投稿済みで隠したか）。PC とスマホで揃うよう docs に乗せる
  meta: '.studio/meta.json',
  // 参考動画の型の分析（shared/reference.ts）。動画そのものとコマは .studio/reference/ にあり、クラウドにはコマだけ上がる
  reference: 'reference.json',
};

/** 中身が素のテキストのもの（docs には {text} で入る） */
export const TEXT_DOCS: readonly DocName[] = ['caption', 'script'];
export const isTextDoc = (name: DocName): boolean => TEXT_DOCS.includes(name);

/** 新しい案件の brief.json の雛形。ローカル（createProject）とクラウドの両方が使う */
export const briefSkeleton = (persona: PersonaId, shopName = ''): Brief =>
  BriefSchema.parse({
    version: 1,
    persona,
    shop: {name: shopName, area: '', genre: '', pr: false},
    materialMode: 'raw',
    format: getPersona(persona).defaultFormat,
    core: '',
    savePriorities: ['access', 'hours', 'budget'],
    order: {mode: 'auto'},
  });

/** 案件フォルダ名（<slug>-reel）に正規化する */
export const PROJECT_SUFFIX = '-reel';
export const normalizeSlug = (slug: string): string => (slug.endsWith(PROJECT_SUFFIX) ? slug : `${slug}${PROJECT_SUFFIX}`);

/** work/ の外や別フォルダを指す名前を弾く（クラウドでも同じ規則にしておく） */
export const isSafeSlug = (slug: string): boolean => /^[^\\/:*?"<>|]+$/.test(slug) && !slug.includes('..') && slug.trim() === slug && slug.length <= 120;
