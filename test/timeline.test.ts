// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {calcTotalFrames, cutFrames, cutStartFrame, telopGroupsOf, totalSec, snapSec} from '@shared/timeline';
import {ReelDataSchema} from '@shared/schema';
// エンジン本体（hiro マスター）。Root.tsx は ../cuts.json を import するので絶対に読まない
import {calcTotalFrames as engineCalcTotalFrames, cutFrames as engineCutFrames} from '@engine/GourmetReel';

const fixtures = path.resolve(__dirname, 'fixtures');
const load = (name: string) => ReelDataSchema.parse(JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.cuts.json`), 'utf8')));

describe('timeline とエンジンの一致', () => {
  it('2050coffee は 1641 フレーム（render_log10 と一致）', () => {
    const d = load('2050coffee');
    expect(d.fps).toBe(60);
    expect(d.cuts.length).toBe(17);
    expect(calcTotalFrames(d)).toBe(1641);
    expect(engineCalcTotalFrames(d as any)).toBe(1641);
  });

  it('全フィクスチャで cutFrames / calcTotalFrames がエンジンと一致する', () => {
    for (const name of ['2050coffee', 'musch-aki', 'katsugyocenter-nagi', 'reunion-hiro']) {
      const d = load(name);
      expect(calcTotalFrames(d), name).toBe(engineCalcTotalFrames(d as any));
      d.cuts.forEach((c, i) => expect(cutFrames(c, d.fps), `${name} cut${i + 1}`).toBe(engineCutFrames(c as any, d.fps)));
    }
  });

  it('cutStartFrame は前カットの累積になる', () => {
    const d = load('2050coffee');
    expect(cutStartFrame(d, 0)).toBe(0);
    expect(cutStartFrame(d, 1)).toBe(cutFrames(d.cuts[0], d.fps));
    expect(cutStartFrame(d, d.cuts.length)).toBe(calcTotalFrames(d));
  });

  it('telopGroupsOf は同一 text・orientation の連続カットをまとめる', () => {
    const d = load('musch-aki');
    const groups = telopGroupsOf(d);
    // 19 カットのうち同文言の連続（①②, ④⑤, ⑨⑩, ⑬⑭, ⑮⑯⑰）が結合され 13 グループになる
    expect(groups.length).toBe(13);
    expect(groups[0].cutIndices).toEqual([0, 1]);
    expect(groups[0].def.text).toBe('東梅田、9割が知らない');
    expect(groups.reduce((s, g) => s + g.dur, 0)).toBe(calcTotalFrames(d));
    expect(totalSec(d)).toBeCloseTo(33.7, 0);
  });

  it('subs を持つカットはグループ対象外、main の無いカットは隙間になる', () => {
    const d = load('reunion-hiro');
    const groups = telopGroupsOf(d);
    const framesInGroups = groups.reduce((s, g) => s + g.dur, 0);
    expect(framesInGroups).toBeLessThan(calcTotalFrames(d)); // main 無しの看板カット 0.9 秒分
  });

  it('snapSec はフレームグリッドに丸める', () => {
    expect(snapSec(1.234, 60)).toBe(1.233);
    expect(snapSec(0.15, 60)).toBe(0.15);
  });
});
