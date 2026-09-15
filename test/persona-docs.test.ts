import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentAddDirs, captionGuideLabel, materializePersonaDocs, promptPath} from '../core/persona-docs';
import {makePersona} from './helpers';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('materializePersonaDocs', () => {
  it('skillDir が無ければ persona の文字列を案件の .studio/persona/ に書き出し、cwd の中なので addDirs は空', () => {
    const project = tmp('reel-proj-');
    const p = makePersona({id: 'inline', captionGuide: '# 型\n1 行目', hashtagBank: '# タグ\n3 個'});
    const d = materializePersonaDocs(project, p);
    expect(d.source).toBe('inline');
    expect(d.addDirs).toEqual([]);
    expect(fs.readFileSync(d.captionGuide!, 'utf8')).toBe('# 型\n1 行目\n');
    expect(fs.readFileSync(d.hashtagBank!, 'utf8')).toBe('# タグ\n3 個\n');
    expect(promptPath(project, d.captionGuide!)).toBe('.studio/persona/caption-guide.md');
    expect(captionGuideLabel(d, project)).toBe('.studio/persona/caption-guide.md（キャプションの型）');
  });

  it('中身が同じなら書き直さない（mtime が動かない）、空なら null', () => {
    const project = tmp('reel-proj-');
    const p = makePersona({id: 'inline', captionGuide: 'x', hashtagBank: ''});
    const a = materializePersonaDocs(project, p);
    expect(a.hashtagBank).toBeNull();
    const before = fs.statSync(a.captionGuide!).mtimeMs;
    const b = materializePersonaDocs(project, p);
    expect(fs.statSync(b.captionGuide!).mtimeMs).toBe(before);
    const c = materializePersonaDocs(project, makePersona({id: 'inline', captionGuide: 'y'}));
    expect(fs.readFileSync(c.captionGuide!, 'utf8')).toBe('y\n');
  });

  it('skillDir があれば SKILL.md と references/hashtag-bank.md を使い、--add-dir で渡す。無いファイルは null', () => {
    const project = tmp('reel-proj-');
    const skill = tmp('reel-skill-');
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill');
    const p = makePersona({id: 'ext', skillDir: skill, captionGuide: '使われない'});
    const d = materializePersonaDocs(project, p);
    expect(d.source).toBe('skillDir');
    expect(d.captionGuide).toBe(path.join(skill, 'SKILL.md'));
    expect(d.hashtagBank).toBeNull(); // references/hashtag-bank.md が無い
    expect(d.addDirs).toEqual([skill]);
    expect(fs.existsSync(path.join(project, '.studio', 'persona'))).toBe(false);
    expect(captionGuideLabel(d, project)).toBe(`${skill.replace(/\\/g, '/')}/SKILL.md の「Step 4: キャプションの生成」`);
  });
});

describe('promptPath / agentAddDirs', () => {
  it('案件の中は相対、外は絶対（区切りは /）', () => {
    const project = 'C:\\work\\a-reel';
    expect(promptPath(project, 'C:\\work\\a-reel\\caption.txt')).toBe('caption.txt');
    expect(promptPath(project, 'C:\\work\\b-reel\\caption.txt')).toBe('C:/work/b-reel/caption.txt');
  });

  it('手本が別の案件にあるときだけ、その案件フォルダを addDirs に足す（重複なし）', () => {
    const project = 'C:\\work\\a-reel';
    const docs = {captionGuide: null, hashtagBank: null, addDirs: ['C:\\skills\\x'], source: 'skillDir' as const};
    expect(agentAddDirs(docs, project, ['C:\\work\\a-reel\\caption.txt'])).toEqual(['C:\\skills\\x']);
    expect(agentAddDirs(docs, project, ['C:\\work\\b-reel\\caption.txt', 'C:\\work\\b-reel\\caption.md'])).toEqual(['C:\\skills\\x', 'C:\\work\\b-reel']);
  });
});
