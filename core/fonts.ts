// 自前フォントの置き場（<設定の置き場>/fonts/）の読み書きと、案件への配り方。
//
// なぜ 2 か所にあるか:
//   置き場（~/.reel-studio/fonts/）… ユーザーが取り込んだフォントの原本。案件をまたいで共有する
//   案件の public/fonts/           … Remotion が読める場所。staticFile('fonts/<file>') で参照される
// cuts.json の `font` にファイル名が書かれたとき、原本を案件へコピーして初めて絵に出る。
// コピーは cuts.json の保存時とレンダー直前に行うので、ユーザーは置き場だけを意識すればよい。
import fs from 'node:fs';
import path from 'node:path';
import {checkFontUpload, fontFamilyOf, fontLabelOf, isFontFileName, safeFontFile, type FontEntry} from '../shared/schema/fonts';
import {settingsDir} from './settings';

export const fontsDir = (): string => path.join(settingsDir(), 'fonts');

const statOrNull = (p: string): fs.Stats | null => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

const entryOf = (dir: string, file: string): FontEntry | null => {
  const st = statOrNull(path.join(dir, file));
  if (!st || !st.isFile()) return null;
  return {file, label: fontLabelOf(file), family: fontFamilyOf(file), sizeBytes: st.size, addedAt: st.mtime.toISOString()};
};

/** 置き場にあるフォントの一覧（名前順） */
export const listFonts = (): FontEntry[] => {
  const dir = fontsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isFontFileName)
    .map((f) => entryOf(dir, f))
    .filter((e): e is FontEntry => e !== null)
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
};

export const fontExists = (file: string): boolean => {
  const name = safeFontFile(file);
  return !!name && fs.existsSync(path.join(fontsDir(), name));
};

/** 取り込む。同じ名前のものがあれば置き換える（案件へは次のコピーで追いつく） */
export const saveFont = (name: string, body: Buffer): FontEntry => {
  const file = safeFontFile(name);
  const problem = checkFontUpload(file, body.length, body.subarray(0, 4));
  if (problem) throw new Error(problem);
  const dir = fontsDir();
  fs.mkdirSync(dir, {recursive: true});
  const dst = path.join(dir, file);
  // 書きかけのファイルを読まれないように、別名で書いてから置き換える
  const tmp = `${dst}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, dst);
  return entryOf(dir, file)!;
};

/** 置き場から消す。案件へ配り済みのもの（public/fonts/）はそのまま残す＝既存の動画は変わらない */
export const deleteFont = (file: string): boolean => {
  const name = safeFontFile(file);
  if (!name || !isFontFileName(name)) return false;
  const p = path.join(fontsDir(), name);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
};

export type FontDelivery = {
  /** 案件で参照するファイル名（cuts.json の font と同じ） */
  file: string | null;
  /** このとき実際にコピーしたか */
  copied: boolean;
  /** 案件にも置き場にも無い＝絵に出ない（同梱の明朝で描かれる） */
  missing: boolean;
};

/**
 * cuts.json の font が指すフォントを、案件の public/fonts/ に用意する。
 * 置き場に無くても案件側に実体があればそれを使う（人から貰った案件フォルダがそのまま動く）。
 */
export const ensureProjectFont = (projectDir: string, file?: string | null): FontDelivery => {
  const name = file ? safeFontFile(file) : '';
  if (!name || !isFontFileName(name)) return {file: null, copied: false, missing: false};
  const dst = path.join(projectDir, 'public', 'fonts', name);
  const src = path.join(fontsDir(), name);
  const srcStat = statOrNull(src);
  const dstStat = statOrNull(dst);
  if (!srcStat) return {file: name, copied: false, missing: !dstStat};
  // 中身が同じなら触らない（数 MB を毎回コピーしない）。置き場で差し替えたら案件側も追いつく
  if (dstStat && dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) return {file: name, copied: false, missing: false};
  fs.mkdirSync(path.dirname(dst), {recursive: true});
  fs.copyFileSync(src, dst);
  return {file: name, copied: true, missing: false};
};
