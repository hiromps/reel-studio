// PC ワーカーの契約ファイル同期。片側だけ変わったときは流し、両方変わったときはクラウドを採って
// PC 側の版を .studio/conflicts/ に残す —— この判断が狂うと編集が黙って消えるので、ここを固める。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stableHash} from '@shared/hash';
import type {DocName} from '@shared/project';
import {readProjectMeta, setProjectArchived} from '../core/project';
import {syncDocs} from '../worker/sync';
import type {CloudClient, DocPull, DocPushResult} from '../worker/client';

let dir: string;
const cuts = (n: number) => ({fps: 60, cuts: [{src: 'uploads/01.mp4', inSec: 0, outSec: n}]});
const brief = (core: string) => ({version: 1, persona: 'standard', shop: {name: 'テスト', area: '', genre: '', pr: false}, materialMode: 'raw', core});

/** クラウドの代わり。持っている doc と、押し込まれたものを覚えておく */
class FakeCloud {
  docs = new Map<DocName, {data: unknown; rev: number; hash: string}>();
  pushed: {name: DocName; data: unknown; baseRev: number | null}[] = [];
  /** 次の push で「先を越された」ことにする doc */
  conflictOn: DocName | null = null;

  put(name: DocName, data: unknown, rev = 1) {
    this.docs.set(name, {data, rev, hash: stableHash(data)});
  }

  pullDocs = async (): Promise<{docs: DocPull[]}> => ({
    docs: [...this.docs.entries()].map(([name, d]) => ({name, data: d.data, rev: d.rev, hash: d.hash, updatedBy: 'cloud', updatedAt: new Date().toISOString()})),
  });

  pushDocs = async (_slug: string, items: {name: DocName; data: unknown; baseRev?: number | null}[]): Promise<{results: DocPushResult[]}> => {
    const results: DocPushResult[] = [];
    for (const it of items) {
      this.pushed.push({name: it.name, data: it.data, baseRev: it.baseRev ?? null});
      if (this.conflictOn === it.name) {
        const cur = this.docs.get(it.name)!;
        results.push({name: it.name, ok: false, conflict: {rev: cur.rev, hash: cur.hash, data: cur.data}});
        continue;
      }
      const rev = (this.docs.get(it.name)?.rev ?? 0) + 1;
      this.put(it.name, it.data, rev);
      results.push({name: it.name, ok: true, rev, hash: stableHash(it.data)});
    }
    return {results};
  };

  asClient(): CloudClient {
    return this as unknown as CloudClient;
  }
}

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const conflicts = () => {
  const d = path.join(dir, '.studio', 'conflicts');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-sync-')) + path.sep + 'test-reel';
  fs.mkdirSync(dir, {recursive: true});
});
afterEach(() => fs.rmSync(path.dirname(dir), {recursive: true, force: true}));

describe('ワーカーの契約ファイル同期', () => {
  it('PC にしか無いものはクラウドへ押し上げる', async () => {
    const cloud = new FakeCloud();
    write('cuts.json', cuts(2));
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.pushed).toEqual(['cuts']);
    expect(r.pulled).toEqual([]);
    expect(cloud.docs.get('cuts')?.data).toEqual(cuts(2));
  });

  it('クラウドにしか無いものは PC に書き出す', async () => {
    const cloud = new FakeCloud();
    cloud.put('brief', brief('クラウドで書いた'));
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.pulled).toEqual(['brief']);
    expect(read('brief.json').core).toBe('クラウドで書いた');
  });

  it('2 回目の同期では何も動かない（同じものを往復させない）', async () => {
    const cloud = new FakeCloud();
    write('cuts.json', cuts(2));
    await syncDocs(cloud.asClient(), dir);
    cloud.pushed = [];
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r).toEqual({pulled: [], pushed: [], conflicted: []});
    expect(cloud.pushed).toEqual([]);
  });

  it('クラウド側だけが進んだら PC を上書きする（退避はしない）', async () => {
    const cloud = new FakeCloud();
    write('cuts.json', cuts(2));
    await syncDocs(cloud.asClient(), dir); // 揃える
    cloud.put('cuts', cuts(5), 2); // スマホで編集した
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.pulled).toEqual(['cuts']);
    expect(r.conflicted).toEqual([]);
    expect(read('cuts.json').cuts[0].outSec).toBe(5);
  });

  it('両方が進んだらクラウドを採り、PC の版は .studio/conflicts/ に残す', async () => {
    const cloud = new FakeCloud();
    write('cuts.json', cuts(2));
    await syncDocs(cloud.asClient(), dir);
    cloud.put('cuts', cuts(9), 2); // スマホで編集
    write('cuts.json', cuts(3)); // PC でも編集
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.conflicted).toEqual(['cuts']);
    expect(read('cuts.json').cuts[0].outSec).toBe(9);
    expect(conflicts().some((f) => f.startsWith('cuts.'))).toBe(true);
  });

  it('押し上げる途中で先を越されたらクラウドを採り、PC の版を残す', async () => {
    const cloud = new FakeCloud();
    write('cuts.json', cuts(2));
    await syncDocs(cloud.asClient(), dir);
    write('cuts.json', cuts(4)); // PC で編集（クラウドはまだ同じ）
    cloud.conflictOn = 'cuts'; // 送っている間に別の誰かが書いた
    cloud.put('cuts', cuts(7), 5);
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.conflicted).toEqual(['cuts']);
    expect(read('cuts.json').cuts[0].outSec).toBe(7);
    expect(conflicts().some((f) => f.startsWith('cuts.'))).toBe(true);
  });

  it('テキストのもの（caption.txt / script.md）は {text} で往復する', async () => {
    const cloud = new FakeCloud();
    fs.writeFileSync(path.join(dir, 'caption.txt'), 'PC で書いたキャプション');
    await syncDocs(cloud.asClient(), dir);
    expect(cloud.docs.get('caption')?.data).toEqual({text: 'PC で書いたキャプション'});

    cloud.put('script', {text: '# 台本\n0:00 つかみ'}, 1);
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.pulled).toEqual(['script']);
    expect(fs.readFileSync(path.join(dir, 'script.md'), 'utf8')).toBe('# 台本\n0:00 つかみ');
  });

  it('「投稿済み（隠す）」も両方向に流れる（PC とスマホで一覧が揃う）', async () => {
    const cloud = new FakeCloud();
    // スマホで隠した → PC の .studio/meta.json に落ちる
    cloud.put('meta', {version: 1, archivedAt: '2026-09-21T09:00:00.000Z'});
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.pulled).toEqual(['meta']);
    expect(readProjectMeta(dir).archivedAt).toBe('2026-09-21T09:00:00.000Z');

    // PC で一覧に戻した → クラウドにも伝わる
    setProjectArchived(dir, false);
    const back = await syncDocs(cloud.asClient(), dir);
    expect(back.pushed).toEqual(['meta']);
    expect((cloud.docs.get('meta')?.data as {archivedAt: string | null}).archivedAt).toBeNull();
  });

  it('壊れた JSON は「無い」扱いにしてクラウドを壊さない', async () => {
    const cloud = new FakeCloud();
    fs.writeFileSync(path.join(dir, 'cuts.json'), '{壊れている');
    const r = await syncDocs(cloud.asClient(), dir);
    expect(r.pushed).toEqual([]);
    expect(cloud.docs.has('cuts')).toBe(false);
  });
});
