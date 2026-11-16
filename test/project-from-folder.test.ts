// 素材フォルダから案件を作るときの名前の規則と、フォルダの調べ方。
// 案件名は日本語の店名をそのまま使う運用なので、「日本語が消えない」「既存と重ならない」を固める。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {folderNameOf, parentDirOf, slugBaseFromFolder, slugTaken, suggestSlug} from '@shared/project-from-folder';
import {inspectMaterialsFolder, materialsDirsInUse} from '../core/materials-folders';

describe('フォルダ名 → 案件名', () => {
  it('日本語と空白は残す', () => {
    expect(slugBaseFromFolder('居酒屋かぶき')).toBe('居酒屋かぶき');
    expect(slugBaseFromFolder('鶏酒場 暁 OC')).toBe('鶏酒場 暁 OC');
  });

  it('フォルダ名に使えない文字と末尾のドット・空白を落とす', () => {
    expect(slugBaseFromFolder('cafe: abc?')).toBe('cafe abc');
    expect(slugBaseFromFolder('  店名.  ')).toBe('店名');
    expect(slugBaseFromFolder('..')).toBe('');
  });

  it('案件フォルダを選んでも -reel が重ならない', () => {
    expect(slugBaseFromFolder('本町ウワバミ-hiro-reel')).toBe('本町ウワバミ-hiro');
  });

  it('パスの末尾と親を取り出す（\\ と / の両方）', () => {
    expect(folderNameOf('D:\\素材\\個人撮影\\とくちゃん\\')).toBe('とくちゃん');
    expect(parentDirOf('D:\\素材\\個人撮影\\とくちゃん')).toBe('D:\\素材\\個人撮影');
    expect(folderNameOf('/data/uploads/cafe')).toBe('cafe');
    expect(parentDirOf('/data/uploads/cafe/')).toBe('/data/uploads');
  });
});

describe('既存の案件と重ならない名前', () => {
  const existing = ['居酒屋かぶき-reel', '居酒屋かぶき-umaimon-reel', 'NOVA-hiro-reel'];

  it('重ならなければそのまま', () => {
    expect(suggestSlug('とくちゃん', 'hiro', existing)).toBe('とくちゃん');
  });

  it('重なったら人格を付け、それも重なれば連番', () => {
    expect(suggestSlug('居酒屋かぶき', 'hiro', existing)).toBe('居酒屋かぶき-hiro');
    expect(suggestSlug('居酒屋かぶき', 'umaimon', existing)).toBe('居酒屋かぶき-umaimon-2');
  });

  it('-reel の有無と大文字小文字を区別しない', () => {
    expect(slugTaken('nova-HIRO', existing)).toBe(true);
    expect(slugTaken('NOVA-hiro-reel', existing)).toBe(true);
    expect(slugTaken('NOVA', existing)).toBe(false);
    expect(slugTaken('', existing)).toBe(false);
  });

  it('名前が空なら候補も空（画面で入力してもらう）', () => {
    expect(suggestSlug('', 'hiro', existing)).toBe('');
  });
});

describe('素材フォルダを調べる', () => {
  let root: string;
  let work: string;
  const touch = (p: string) => {
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, '');
  };
  const project = (slug: string, materialsDir: string, mtime: number) => {
    const file = path.join(work, slug, 'catalog.json');
    touch(file);
    fs.writeFileSync(file, JSON.stringify({materialsDir, clips: []}));
    fs.utimesSync(file, mtime, mtime);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-folder-'));
    work = path.join(root, 'work');
    fs.mkdirSync(work);
  });
  afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

  it('直下の動画だけを数え、同じ素材の案件を新しい順に返す', () => {
    const shop = path.join(root, '素材', 'とくちゃん');
    touch(path.join(shop, 'IMG_0001.MOV'));
    touch(path.join(shop, 'IMG_0002.mp4'));
    touch(path.join(shop, 'memo.txt'));
    touch(path.join(shop, '別日', 'IMG_0003.MOV'));
    project('とくちゃん-reel', shop, 1000);
    project('とくちゃん大阪グルメ-reel', `${shop}${path.sep}`, 2000);
    project('NOVA-hiro-reel', path.join(root, '素材', 'NOVA'), 3000);

    const r = inspectMaterialsFolder(shop, work);
    expect(r.folderName).toBe('とくちゃん');
    expect(r.videoCount).toBe(2);
    expect(r.subfoldersWithVideos).toEqual([]);
    expect(r.sameMaterials).toEqual(['とくちゃん大阪グルメ-reel', 'とくちゃん-reel']);
  });

  it('直下に動画が無ければ、動画の入ったサブフォルダを知らせる', () => {
    const parent = path.join(root, '素材', '個人撮影');
    touch(path.join(parent, 'とくちゃん', 'a.mov'));
    fs.mkdirSync(path.join(parent, '空'), {recursive: true});
    const r = inspectMaterialsFolder(parent, work);
    expect(r.videoCount).toBe(0);
    expect(r.subfoldersWithVideos).toEqual(['とくちゃん']);
  });

  it('フォルダでなければエラー', () => {
    expect(() => inspectMaterialsFolder(path.join(root, '無い'), work)).toThrow(/見つかりません/);
  });

  it('最近使ったフォルダは重複なし・存在するものだけ・壊れた catalog は無視', () => {
    const a = path.join(root, 'a');
    fs.mkdirSync(a);
    project('a1-reel', a, 1000);
    project('a2-reel', a, 2000);
    project('gone-reel', path.join(root, 'gone'), 3000);
    touch(path.join(work, 'broken-reel', 'catalog.json'));
    fs.writeFileSync(path.join(work, 'broken-reel', 'catalog.json'), '{');
    project('not-a-project', a, 4000);
    expect(materialsDirsInUse(work).filter((m) => fs.existsSync(m.dir))).toEqual([
      {dir: a, slug: 'a2-reel'},
      {dir: a, slug: 'a1-reel'},
    ]);
  });
});
