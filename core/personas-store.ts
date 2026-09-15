// ~/.reel-studio/personas.json の読み書き。読んだ結果は shared/personas.ts のレジストリに流す。
import fs from 'node:fs';
import {BUILTIN_PERSONAS, PersonasFileSchema, listPersonas, setPersonas, type Persona} from '../shared/personas';
import {personasFile, settingsBackupDir} from './settings';
import {writeJsonAtomic} from './json-io';

let problem: string | null = null;

/**
 * 起動時に 1 回呼ぶ。無ければ同梱のサンプル人格で seed する（ユーザーが編集・削除できるようファイルとして置く）。
 * 壊れていても同梱の人格で動かし、problem に理由を残す（Settings に出す）。
 */
export const loadPersonasFromDisk = (): Persona[] => {
  const file = personasFile();
  problem = null;
  if (!fs.existsSync(file)) {
    writeJsonAtomic(file, {version: 1, personas: BUILTIN_PERSONAS});
    setPersonas(BUILTIN_PERSONAS);
    return listPersonas();
  }
  try {
    const r = PersonasFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (r.success) setPersonas(r.data.personas);
    else {
      const first = r.error.issues[0];
      problem = `${file} の検証に失敗: ${first?.path.join('.') || '(root)'} ${first?.message}（同梱の人格で動いています）`;
      setPersonas(BUILTIN_PERSONAS);
    }
  } catch (e) {
    problem = `${file} を読めません: ${(e as Error).message}（同梱の人格で動いています）`;
    setPersonas(BUILTIN_PERSONAS);
  }
  return listPersonas();
};

export const personasProblem = (): string | null => problem;

/** 一覧を丸ごと保存してレジストリも更新する（id 重複・0 件はここで弾かれる） */
export const savePersonas = (list: Persona[]): Persona[] => {
  const data = PersonasFileSchema.parse({version: 1, personas: list});
  writeJsonAtomic(personasFile(), data, {backupDir: settingsBackupDir()});
  setPersonas(data.personas);
  problem = null;
  return data.personas;
};
