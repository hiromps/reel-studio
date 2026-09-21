// 投稿し終えた案件を一覧から隠す／戻す。**隠すだけで消さない**ので、
// 契約ファイル・素材・書き出しに触っていないことと、開いている案件が一覧から消えないことを固める。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DOC_FILES, parseProjectMeta, withArchived} from '@shared/project';
import {projectInfo, projectMetaPath, readProjectMeta, setProjectArchived} from '../core/project';
import {archivedCount, visibleProjects} from '../src/components/projectList';

let dir: string;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reel-archive-')), 'sakana-reel');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'cuts.json'), JSON.stringify({fps: 60, cuts: []}));
});
afterEach(() => fs.rmSync(path.dirname(dir), {recursive: true, force: true}));

describe('案件フォルダ側（.studio/meta.json）', () => {
  it('meta が無ければ「隠していない」', () => {
    expect(fs.existsSync(projectMetaPath(dir))).toBe(false);
    expect(readProjectMeta(dir).archivedAt).toBeNull();
    expect(projectInfo(dir).archivedAt).toBeUndefined();
  });

  it('隠す → 日時が入り、戻す → null に戻る', () => {
    const at = setProjectArchived(dir, true).archivedAt;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(projectInfo(dir).archivedAt).toBe(at);

    // 2 回押しても最初に隠した日時のまま（「いつ投稿済みにしたか」が押し直しで動かない）
    expect(setProjectArchived(dir, true).archivedAt).toBe(at);

    expect(setProjectArchived(dir, false).archivedAt).toBeNull();
    expect(projectInfo(dir).archivedAt).toBeUndefined();
  });

  it('置き場はワーカーが同期する doc と同じファイル', () => {
    setProjectArchived(dir, true);
    expect(projectMetaPath(dir)).toBe(path.join(dir, DOC_FILES.meta));
    expect(fs.existsSync(path.join(dir, '.studio', 'meta.json'))).toBe(true);
  });

  it('契約ファイルには触らない（隠しても中身は元のまま）', () => {
    const before = fs.readFileSync(path.join(dir, 'cuts.json'), 'utf8');
    setProjectArchived(dir, true);
    expect(fs.readFileSync(path.join(dir, 'cuts.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('壊れた meta は「隠していない」扱いにして一覧を止めない', () => {
    fs.mkdirSync(path.dirname(projectMetaPath(dir)), {recursive: true});
    fs.writeFileSync(projectMetaPath(dir), '{壊れた');
    expect(readProjectMeta(dir).archivedAt).toBeNull();
    expect(projectInfo(dir).archivedAt).toBeUndefined();
  });

  it('parseProjectMeta / withArchived は素の値でも落ちない', () => {
    expect(parseProjectMeta(null).archivedAt).toBeNull();
    expect(parseProjectMeta({archivedAt: 12345}).archivedAt).toBeNull(); // 型違いは既定に落とす
    expect(withArchived(parseProjectMeta(null), true, new Date('2026-09-21T10:00:00.000Z')).archivedAt).toBe('2026-09-21T10:00:00.000Z');
  });
});

describe('一覧の出し分け', () => {
  const p = (slug: string, archivedAt?: string) => ({slug, archivedAt});
  const list = [p('a-reel'), p('b-reel', '2026-09-20T00:00:00.000Z'), p('c-reel')];

  it('既定では隠した案件を出さない', () => {
    expect(visibleProjects(list, {active: 'a-reel', showArchived: false}).map((x) => x.slug)).toEqual(['a-reel', 'c-reel']);
    expect(archivedCount(list)).toBe(1);
  });

  it('開いている案件は、隠していても必ず出る（一覧から操作できなくならない）', () => {
    expect(visibleProjects(list, {active: 'b-reel', showArchived: false}).map((x) => x.slug)).toEqual(['a-reel', 'c-reel', 'b-reel']);
  });

  it('表示に切り替えると戻り、隠したものは下にまとまる', () => {
    expect(visibleProjects(list, {active: null, showArchived: true}).map((x) => x.slug)).toEqual(['a-reel', 'c-reel', 'b-reel']);
  });

  it('元の配列を壊さない（サーバーから来た一覧をそのまま使い回す）', () => {
    const src = [...list];
    visibleProjects(src, {active: null, showArchived: true});
    expect(src.map((x) => x.slug)).toEqual(['a-reel', 'b-reel', 'c-reel']);
  });
});
