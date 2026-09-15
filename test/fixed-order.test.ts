// brief.order.fixed を cuts.json の並びに追従させる（手で並べ替えたあとの記録合わせ）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {syncFixedOrder, writeCuts} from '../core/project';
import type {ReelData} from '@shared/schema';
import {makeBrief, makeCatalog, makeClip} from './helpers';

let dir: string;
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

const cutsOf = (srcs: string[]): ReelData => ({
  fps: 60,
  cuts: srcs.map((src, i) => ({id: `c${String(i + 1).padStart(2, '0')}`, src, inSec: 0, outSec: 1.2, main: {text: `t${i}`}})),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fixed-'));
  const catalog = makeCatalog('t', [
    makeClip({id: '01', slug: 'a', dur: 4, kind: 'sizzle'}),
    makeClip({id: '02', slug: 'b', dur: 4, kind: 'interior'}),
    makeClip({id: '03', slug: 'c', dur: 4, kind: 'menu'}),
  ]);
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard', order: {mode: 'fixed', fixed: ['01', '02', '03']}})));
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

describe('syncFixedOrder', () => {
  it('並べ替えたら固定順が実物に追従する', () => {
    const r = syncFixedOrder(dir, cutsOf(['uploads/03_c.mov', 'uploads/01_a.mov', 'uploads/02_b.mov']));
    expect(r).toEqual(['03', '01', '02']);
    expect(read('brief.json').order.fixed).toEqual(['03', '01', '02']);
  });

  it('並びが同じなら brief を書き換えない', () => {
    expect(syncFixedOrder(dir, cutsOf(['uploads/01_a.mov', 'uploads/02_b.mov', 'uploads/03_c.mov']))).toBeNull();
  });

  it('cuts.json を保存すると自動で追従する', () => {
    writeCuts(dir, cutsOf(['uploads/02_b.mov', 'uploads/01_a.mov']));
    expect(read('brief.json').order.fixed).toEqual(['02', '01']);
  });

  it('固定順を使っていない案件では何もしない', () => {
    fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard', order: {mode: 'auto'}})));
    expect(syncFixedOrder(dir, cutsOf(['uploads/03_c.mov']))).toBeNull();
    expect(read('brief.json').order.fixed).toBeUndefined();
  });

  it('カタログが無くても cuts.json の保存は成功させる', () => {
    fs.rmSync(path.join(dir, 'catalog.json'));
    expect(() => writeCuts(dir, cutsOf(['uploads/01_a.mov']))).not.toThrow();
    expect(read('cuts.json').cuts).toHaveLength(1);
  });
});
