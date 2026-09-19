// 案件の「形」。fs を触らないので、ブラウザ側（画面）からも読める。
// 実体の操作（探索・作成・エンジン同期）は core/project.ts。
import {BriefSchema, type Brief, type PersonaId} from './schema/brief';
import {getPersona} from './personas';

/** エンジンの系統。standard（同梱エンジン＝Noto Serif JP）だけがマスターとの同期対象。yui / instagram は別デザインなので触らない */
export type EngineFamily = 'standard' | 'yui' | 'instagram' | 'unknown';
export type EngineDiff = {stale: boolean; family: EngineFamily; files: {file: string; status: 'ok' | 'differs' | 'missing'}[]};

export type ProjectInfo = {
  slug: string;
  dir: string;
  has: {catalog: boolean; brief: boolean; cuts: boolean; narration: boolean};
  /** out/ の書き出し物。GUI が「レンダー前に mix を押す」のを防ぐために見る */
  out: {draft: boolean; final: boolean; narration: boolean};
  engine: EngineDiff;
  nodeModules: boolean;
  updatedAt: string;
  persona?: PersonaId;
  format?: string;
};

export const CONTRACT_FILES = ['catalog', 'brief', 'cuts', 'narration'] as const;
export type ContractName = (typeof CONTRACT_FILES)[number];

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
