import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dbToGain, mixClipsOf} from '../src/editor/mixPreview';
import {mixScriptPath} from '../core/mix';
import {NarrationSegmentSchema, type Narration} from '../shared/schema';

describe('ナレーションごとの音量', () => {
  it('-30〜+12 dB だけ受け付ける', () => {
    expect(NarrationSegmentSchema.safeParse({id: 'a', at: 0, text: '', gainDb: -6}).success).toBe(true);
    expect(NarrationSegmentSchema.safeParse({id: 'a', at: 0, text: '', gainDb: 13}).success).toBe(false);
    expect(NarrationSegmentSchema.safeParse({id: 'a', at: 0, text: '', gainDb: -31}).success).toBe(false);
  });

  it('プレビューはそのブロックだけ音量が変わる', () => {
    const n: Narration = {voice: 'v', narrationGainDb: 0, segments: [{id: 'a', at: 0, durSec: 1, text: 'x', gainDb: -6}, {id: 'b', at: 2, durSec: 1, text: 'y'}]};
    const [a, b] = mixClipsOf(n, '/m');
    expect(a.gain / b.gain).toBeCloseTo(dbToGain(-6), 5);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], {windowsHide: true}).status === 0;

describe.skipIf(!hasFfmpeg)('書き出しにブロックごとの音量が効く', () => {
  it('同じ音の 2 ブロックで片方を -10 dB にすると、声の音量ならしの後も差が残る', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-gain-'));
    const ff = (args: string) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args.split(' ')], {cwd: dir, windowsHide: true});
    try {
      fs.mkdirSync(path.join(dir, 'narration'));
      ff('-f lavfi -i color=c=black:s=64x64:d=5:r=30 -f lavfi -i anullsrc=r=48000:cl=stereo -t 5 -c:v libx264 -c:a aac in.mp4');
      ff('-f lavfi -i sine=f=440:d=1:r=48000 narration/a.wav');
      ff('-f lavfi -i sine=f=440:d=1:r=48000 narration/b.wav');
      const spec = path.join(dir, 'narration.json');
      fs.writeFileSync(spec, JSON.stringify({voice: '', segments: [{id: 'a', at: 0.5, durSec: 1, text: ''}, {id: 'b', at: 3, durSec: 1, text: '', gainDb: -10}]}));
      const r = spawnSync(process.execPath, [mixScriptPath(), spec, path.join(dir, 'narration'), path.join(dir, 'in.mp4'), path.join(dir, 'out.mp4')], {encoding: 'utf8', windowsHide: true});
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('b -10dB');
      const mean = (ss: number, t: number) => {
        const v = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', path.join(dir, 'out.mp4'), '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8', windowsHide: true});
        return Number(v.stderr.match(/mean_volume: (-?[\d.]+)/)?.[1] ?? -91);
      };
      const loud = mean(0.7, 0.6);
      const quiet = mean(3.2, 0.6);
      // ならしで多少は縮むが、はっきり小さく聞こえる差（8 dB 以上）が残ること
      expect(loud - quiet).toBeGreaterThan(8);
      expect(loud - quiet).toBeLessThan(12);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }, 60000);
});
