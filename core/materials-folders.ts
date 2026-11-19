// 素材フォルダの下調べ。フォルダを選ぶだけで案件を作るために、
// 「動画が何本あるか」「同じ素材を読み込んだ案件が既にあるか」「最近使ったフォルダはどこか」を返す。
// 読むだけで、何も書き換えない。
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {listMaterials} from './catalog';
import {folderNameOf, type FixedMaterials, type FolderInspection, type MaterialsFolders} from '../shared/project-from-folder';

/** 比較用。区切り・末尾の区切り・大文字小文字（Windows）の違いを吸収する */
const samePathKey = (p: string): string => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** 既存の案件が読み込んだ素材フォルダ（catalog.json の materialsDir）。catalog の更新が新しい順 */
export const materialsDirsInUse = (workDir = studioConfig.workDir): {dir: string; slug: string}[] => {
  if (!fs.existsSync(workDir)) return [];
  const found: {dir: string; slug: string; mtime: number}[] = [];
  for (const d of fs.readdirSync(workDir)) {
    if (!d.endsWith(studioConfig.projectSuffix)) continue;
    const file = path.join(workDir, d, 'catalog.json');
    try {
      const mtime = fs.statSync(file).mtimeMs;
      // 一覧に使うだけなので zod は通さない（古い形式の catalog でも materialsDir は読める）
      const dir = (JSON.parse(fs.readFileSync(file, 'utf8')) as {materialsDir?: unknown}).materialsDir;
      if (typeof dir === 'string' && dir.trim()) found.push({dir: path.resolve(dir), slug: d, mtime});
    } catch {
      /* catalog が無い・壊れている案件は対象外 */
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({dir, slug}) => ({dir, slug}));
};

/** 最近使った素材フォルダ（重複なし・いまも存在するものだけ） */
export const recentMaterialsFolders = (limit = 12, workDir = studioConfig.workDir): MaterialsFolders => {
  const seen = new Set<string>();
  const recent: MaterialsFolders['recent'] = [];
  for (const m of materialsDirsInUse(workDir)) {
    const key = samePathKey(m.dir);
    if (seen.has(key) || !fs.existsSync(m.dir)) continue;
    seen.add(key);
    recent.push(m);
    if (recent.length >= limit) break;
  }
  return {recent};
};

const countVideos = (dir: string): number => {
  try {
    return listMaterials(dir).length;
  } catch {
    return 0; // 権限が無いフォルダなどは「動画なし」として扱う
  }
};

/** 選ばれたフォルダを調べる。動画はカタログ実行と同じく直下だけを数える */
export const inspectMaterialsFolder = (dirInput: string, workDir = studioConfig.workDir): FolderInspection => {
  const dir = path.resolve(String(dirInput ?? '').trim());
  if (!String(dirInput ?? '').trim() || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`フォルダが見つかりません: ${dirInput}`);
  const videoCount = countVideos(dir);
  const subfoldersWithVideos =
    videoCount > 0
      ? []
      : fs
          .readdirSync(dir, {withFileTypes: true})
          .filter((e) => e.isDirectory() && countVideos(path.join(dir, e.name)) > 0)
          .map((e) => e.name);
  const key = samePathKey(dir);
  return {
    dir,
    folderName: folderNameOf(dir),
    videoCount,
    subfoldersWithVideos,
    sameMaterials: materialsDirsInUse(workDir)
      .filter((m) => samePathKey(m.dir) === key)
      .map((m) => m.slug),
  };
};

/** 固定素材フォルダ（毎回入れるロゴ・外観など）。無ければ作ってから、直下の動画を返す */
export const fixedMaterials = (dir = studioConfig.fixedMaterialsDir): FixedMaterials => {
  fs.mkdirSync(dir, {recursive: true});
  return {dir, videos: countable(dir)};
};

const countable = (dir: string): string[] => {
  try {
    return listMaterials(dir);
  } catch {
    return [];
  }
};

/**
 * カタログ実行で読み込む固定素材フォルダ。指定（include）→ 案件の前回の選択 → 既定（読み込む）の順で決める。
 * 読み込まないなら null
 */
export const fixedDirFor = (include: boolean | undefined, previous: boolean | undefined): string | null =>
  (include ?? previous ?? true) ? studioConfig.fixedMaterialsDir : null;
