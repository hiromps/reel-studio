// サーバーの可変状態（既定の案件）と、静的配信のファイル解決。
//
// 「いま編集している案件」はタブごとに違う（複数案件を並行して進められるように）。
// なので解決はすべて呼び出し側から案件フォルダを渡す形にしてあり、ここに持つ activeSlug は
// 「案件を指定しないで来たとき（CLI・古い画面・?p= なしで開いた新しいタブ）の既定」でしかない。
import fs from 'node:fs';
import path from 'node:path';
import {resolveProjectDir} from '../core/project';
import {studioConfig} from '../studio.config';

export type ServerState = {
  /** 最後に開かれた案件。新しいタブの初期値と、slug 省略のジョブ投入に使う */
  activeSlug: string | null;
};

export const state: ServerState = {activeSlug: null};

export const activeDir = (): string | null => (state.activeSlug ? resolveProjectDir(state.activeSlug) : null);

/** `..` で案件フォルダの外へ出さない */
const safeRel = (rel: string): string => path.normalize(rel).replace(/^([.][.][\\/])+/, '');

/**
 * /uploads/... /fonts/... の実ファイルを解決する（無ければ null）。
 * light = Materials の「軽量プレビュー生成」で作った .studio/preview/ を優先する（タブごとの表示設定）
 */
export const resolvePublic = (dir: string | null, rel: string, light = false): string | null => {
  if (!dir) return null;
  const safe = safeRel(rel);
  if (light && safe.startsWith('uploads')) {
    const prev = path.join(dir, studioConfig.studioDirName, 'preview', path.basename(safe));
    if (fs.existsSync(prev)) return prev;
  }
  const p = path.join(dir, 'public', safe);
  if (fs.existsSync(p)) return p;
  if (safe.startsWith('fonts')) {
    const t = path.join(studioConfig.templateDir, 'public', safe);
    if (fs.existsSync(t)) return t;
  }
  return null;
};

export const resolveStudio = (dir: string | null, rel: string): string | null => {
  if (!dir) return null;
  const p = path.join(dir, studioConfig.studioDirName, safeRel(rel));
  return fs.existsSync(p) ? p : null;
};

export const resolveInProject = (dir: string | null, sub: 'out' | 'qc' | 'narration', rel: string): string | null => {
  if (!dir) return null;
  const p = path.join(dir, sub, safeRel(rel));
  return fs.existsSync(p) ? p : null;
};
