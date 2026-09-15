// 人格の「キャプションの型」「ハッシュタグの選び方」を、裏で走る claude が Read できる場所に用意する。
//
// - skillDir がある人格: そのフォルダの SKILL.md と references/hashtag-bank.md を使い、--add-dir で読めるようにする
// - 無い人格: persona の captionGuide / hashtagBank（markdown 文字列）を <案件>/.studio/persona/ に書き出す。
//   cwd（案件フォルダ）の中なので --add-dir は要らない。中身が同じなら書き直さない（mtime を動かさない）
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import type {Persona} from '../shared/personas';

export type PersonaDocs = {
  /** キャプションの型（絶対パス）。無ければ null */
  captionGuide: string | null;
  /** ハッシュタグの選び方（絶対パス）。無ければ null */
  hashtagBank: string | null;
  /** runAgent の addDirs に渡す（cwd の外を読ませるとき） */
  addDirs: string[];
  source: 'skillDir' | 'inline';
};

const writeIfChanged = (file: string, text: string): void => {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text, 'utf8');
};

export const personaDocsDir = (projectDir: string): string => path.join(projectDir, studioConfig.studioDirName, 'persona');

export const materializePersonaDocs = (projectDir: string, persona: Persona): PersonaDocs => {
  if (persona.skillDir) {
    const dir = path.resolve(persona.skillDir);
    const skill = path.join(dir, 'SKILL.md');
    const bank = path.join(dir, 'references', 'hashtag-bank.md');
    return {captionGuide: fs.existsSync(skill) ? skill : null, hashtagBank: fs.existsSync(bank) ? bank : null, addDirs: [dir], source: 'skillDir'};
  }
  const dir = personaDocsDir(projectDir);
  const guide = persona.captionGuide.trim();
  const bank = persona.hashtagBank.trim();
  const guideFile = path.join(dir, 'caption-guide.md');
  const bankFile = path.join(dir, 'hashtag-bank.md');
  if (guide) writeIfChanged(guideFile, `${guide}\n`);
  if (bank) writeIfChanged(bankFile, `${bank}\n`);
  return {captionGuide: guide ? guideFile : null, hashtagBank: bank ? bankFile : null, addDirs: [], source: 'inline'};
};

/** プロンプトに書くパス。cwd（案件）の中なら相対、外なら絶対。区切りは / に揃える */
export const promptPath = (projectDir: string, file: string): string => {
  const rel = path.relative(projectDir, file);
  const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : path.resolve(file)).replace(/\\/g, '/');
};

/** 「まず Read すること」の 1 行目の書き方（skillDir の SKILL.md は節を指す） */
export const captionGuideLabel = (docs: PersonaDocs, projectDir: string): string | null =>
  docs.captionGuide ? `${promptPath(projectDir, docs.captionGuide)}${docs.source === 'skillDir' ? ' の「Step 4: キャプションの生成」' : '（キャプションの型）'}` : null;

/** runAgent に渡す addDirs（docs の skillDir ＋ 手本が別案件にあるときの work/）。重複は落とす */
export const agentAddDirs = (docs: PersonaDocs, projectDir: string, extraFiles: string[] = []): string[] => {
  const out = new Set<string>(docs.addDirs);
  for (const f of extraFiles) {
    const rel = path.relative(projectDir, f);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) out.add(path.dirname(f));
  }
  return [...out];
};
