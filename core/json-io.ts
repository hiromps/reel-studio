// JSON の読み書き。zod 検証、atomic write（tmp → rename）、.studio/backups への世代バックアップ。
import fs from 'node:fs';
import path from 'node:path';
import type {ZodTypeAny, z} from 'zod';
import {fileStamp} from '../shared/time';

const BACKUP_KEEP = 20;

export const readJsonFile = <T extends ZodTypeAny>(file: string, schema: T): z.infer<T> => {
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  const r = schema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(`${path.basename(file)} の検証に失敗: ${first?.path.join('.') || '(root)'} ${first?.message}`);
  }
  return r.data;
};

export const readJsonLoose = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

export const fileEtag = (file: string): string | null => {
  try {
    const st = fs.statSync(file);
    return `${Math.floor(st.mtimeMs)}-${st.size}`;
  } catch {
    return null;
  }
};

/** 既存ファイルを backupDir にコピーし、古い世代を間引く */
export const backupFile = (file: string, backupDir: string): string | null => {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, {recursive: true});
  const base = path.basename(file, path.extname(file));
  const dest = path.join(backupDir, `${base}.${fileStamp()}${path.extname(file)}`);
  fs.copyFileSync(file, dest);
  const olds = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(`${base}.`))
    .sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))) fs.rmSync(path.join(backupDir, f), {force: true});
  return dest;
};

export const writeJsonAtomic = (file: string, data: unknown, opt: {backupDir?: string; indent?: number} = {}): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (opt.backupDir) backupFile(file, opt.backupDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, opt.indent ?? 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
};
