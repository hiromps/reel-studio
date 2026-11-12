import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {narrationRange, narrationUsedSec, trimNarrationHead, trimNarrationTail} from '../shared/narration';
import {mixClipsOf, planPlayback} from '../src/editor/mixPreview';
import {mixScriptPath} from '../core/mix';
import type {Narration} from '../shared/schema';

describe('ナレーションの頭のカット', () => {
  const seg = {at: 2, durSec: 3, text: 'x', id: 'a'};

  it('使う範囲は startSec〜trimSec。trimSec だけの古いデータは今までどおり頭から', () => {
    expect(narrationRange({durSec: 3, trimSec: 2})).toEqual({start: 0, end: 2});
    expect(narrationRange({durSec: 3, startSec: 0.5, trimSec: 2})).toEqual({start: 0.5, end: 2});
    expect(narrationUsedSec({durSec: 3, startSec: 0.5, trimSec: 2})).toBe(1.5);
    expect(narrationUsedSec({durSec: 3, startSec: 0.5})).toBe(2.5);
  });

  it('頭を飛ばすと、声の位置が変わらないよう配置秒も同じだけ後ろへずれる', () => {
    expect(trimNarrationHead(seg, 0.8)).toEqual({startSec: 0.8, at: 2.8});
    // 0 に戻すと startSec は外れ、配置秒も元に戻る
    expect(trimNarrationHead({...seg, startSec: 0.8, at: 2.8}, 0)).toEqual({startSec: undefined, at: 2});
  });

  it('終わりの 0.1 秒手前より先へは削れず、配置秒が 0 未満になる分も戻せない', () => {
    expect(trimNarrationHead({...seg, trimSec: 1}, 5)).toEqual({startSec: 0.9, at: 2.9});
    expect(trimNarrationHead({...seg, at: 0.2, startSec: 1}, 0)).toEqual({startSec: 0.8, at: 0});
  });

  it('終わりは頭のカット位置より前に行かず、全長まで戻すと trimSec は外れる', () => {
    expect(trimNarrationTail({durSec: 3, startSec: 1}, 0.5)).toBe(1.1);
    expect(trimNarrationTail({durSec: 3, startSec: 1}, 9)).toBeUndefined();
  });

  it('プレビューは wav の頭を飛ばした位置から、使う長さだけ鳴らす', () => {
    const n: Narration = {voice: 'v', segments: [{id: 'a', at: 2, durSec: 3, text: 'x', startSec: 0.5, trimSec: 2}]};
    const clips = mixClipsOf(n, '/m');
    expect(planPlayback(clips, () => 3, 0)[0]).toMatchObject({delaySec: 2, offsetSec: 0.5, durationSec: 1.5});
    // 途中から再生しても、飛ばした頭の分を足した位置から鳴る
    expect(planPlayback(clips, () => 3, 2.5)[0]).toMatchObject({delaySec: 0, offsetSec: 1, durationSec: 1});
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], {windowsHide: true}).status === 0;

describe.skipIf(!hasFfmpeg)('書き出しのミックスに頭のカットが効く', () => {
  it('頭 1 秒の無音を飛ばし、at の位置から声（正弦波）が鳴る', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-headtrim-'));
    const ff = (args: string) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args.split(' ')], {cwd: dir, windowsHide: true});
    try {
      fs.mkdirSync(path.join(dir, 'narration'));
      ff('-f lavfi -i color=c=black:s=64x64:d=4:r=30 -f lavfi -i anullsrc=r=48000:cl=stereo -t 4 -c:v libx264 -c:a aac in.mp4');
      // 頭 1 秒が無音、続く 1 秒が音、残り 1 秒が無音の録音
      ff('-f lavfi -i sine=f=440:d=1:r=48000 -af adelay=1000|1000,apad=whole_dur=3 narration/a.wav');
      const spec = path.join(dir, 'narration.json');
      fs.writeFileSync(spec, JSON.stringify({voice: '', segments: [{id: 'a', at: 0.5, durSec: 3, startSec: 1, trimSec: 2, text: ''}]}));
      const r = spawnSync(process.execPath, [mixScriptPath(), spec, path.join(dir, 'narration'), path.join(dir, 'in.mp4'), path.join(dir, 'out.mp4')], {encoding: 'utf8', windowsHide: true});
      expect(r.status, r.stderr).toBe(0);
      const mean = (ss: number, t: number) => {
        const v = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', path.join(dir, 'out.mp4'), '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8', windowsHide: true});
        return Number(v.stderr.match(/mean_volume: (-?[\d.]+)/)?.[1] ?? -91);
      };
      const before = mean(0, 0.4);
      const during = mean(0.6, 0.8);
      const after = mean(1.7, 1);
      expect(during).toBeGreaterThan(before + 20);
      expect(during).toBeGreaterThan(after + 20);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }, 60000);
});
