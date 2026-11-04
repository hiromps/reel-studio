import fs from 'node:fs';
import path from 'node:path';
import {resolvedPaths, settingsDir} from './settings';
import {isLocalMediaPath} from '../shared/media';

/** 移行データの置き場。原本・生成物は設定済み uploadsRoot / workDir をそのまま参照する。 */
export const localMediaRoot = (): string => path.resolve(process.env.REEL_STUDIO_MEDIA_ROOT?.trim() || path.join(resolvedPaths().dataRoot, 'media'));

const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

/** DB の任意パス・symlink 経由で設定範囲外を読ませない。Storage URL は決して fetch しない。 */
export const requireLocalMedia = (file: string): string => {
  if (!isLocalMediaPath(file)) throw new Error('外部 Storage のファイルです。先にローカル移行を実行してください');
  const roots = [...Object.values(resolvedPaths()), settingsDir(), localMediaRoot()];
  const real = fs.realpathSync(file);
  if (!roots.some((root) => fs.existsSync(root) && inside(fs.realpathSync(root), real))) throw new Error('ローカル保存先の範囲外です');
  if (!fs.statSync(real).isFile()) throw new Error('メディアファイルではありません');
  return real;
};

/** コピーが必要な場合も、同じ実体ならそのまま参照する。既存ファイルは上書きしない。 */
export const copyLocalMedia = (source: string, target: string): void => {
  const real = requireLocalMedia(source);
  if (path.resolve(real) === path.resolve(target)) return;
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(real, target, fs.constants.COPYFILE_EXCL);
};

let migratedCache: {file: string; stamp: string; index: Record<string, string>} | undefined;
/** 移行済みのファイルは複製せず、索引から参照する。変更時だけ JSON を読み直す。 */
export const migratedMedia = (slug: string, mode: string, kind: string, rel: string): string | null => {
  const file = path.join(localMediaRoot(), 'asset-index.json');
  try {
    const st = fs.statSync(file);
    const stamp = `${st.mtimeMs}-${st.size}`;
    if (migratedCache?.file !== file || migratedCache.stamp !== stamp) migratedCache = {file, stamp, index: JSON.parse(fs.readFileSync(file, 'utf8'))};
    const key = `${slug}/${mode}/${kind}/${rel}`;
    const fallback = `${slug}/light/${kind}/${rel}`;
    const value = migratedCache.index[key] ?? (mode === 'full' ? migratedCache.index[fallback] : null);
    return value ? requireLocalMedia(value) : null;
  } catch { return null; }
};
