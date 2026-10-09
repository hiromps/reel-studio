import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeProxy} from '../core/proxy';
import {execOk} from '../core/exec';
import {ffprobe} from '../core/ffprobe';
import type {Probe} from '../shared/schema/catalog';

vi.mock('../core/exec', () => ({execOk: vi.fn()}));
vi.mock('../core/ffprobe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/ffprobe')>()),
  ffprobe: vi.fn(),
}));

const probe: Probe = {codec: 'hevc', width: 1080, height: 1920, rotation: 0, fps: 30, durationSec: 5, hasAudio: true, pixFmt: 'yuv420p'};
const dirs: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

describe('makeProxy', () => {
  it('failed conversion leaves the previous file intact and removes the partial file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-proxy-'));
    dirs.push(dir);
    const output = path.join(dir, 'clip.mp4');
    fs.writeFileSync(output, 'existing');
    vi.mocked(execOk).mockImplementation(async (_command, args) => {
      fs.writeFileSync(args[args.length - 1], 'partial');
      throw new Error('conversion failed');
    });

    await expect(makeProxy('source.mp4', output, probe)).rejects.toThrow('conversion failed');
    expect(fs.readFileSync(output, 'utf8')).toBe('existing');
    expect(fs.readdirSync(dir)).toEqual(['clip.mp4']);
  });

  it('replaces the previous file only after the new proxy passes probing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-proxy-'));
    dirs.push(dir);
    const output = path.join(dir, 'clip.mp4');
    fs.writeFileSync(output, 'existing');
    vi.mocked(execOk).mockImplementation(async (_command, args) => {
      fs.writeFileSync(args[args.length - 1], 'converted');
      return {code: 0, signal: null, durationMs: 1, stdout: '', stderr: ''};
    });
    vi.mocked(ffprobe).mockResolvedValue(probe);

    await makeProxy('source.mp4', output, probe);
    expect(fs.readFileSync(output, 'utf8')).toBe('converted');
    expect(fs.readdirSync(dir)).toEqual(['clip.mp4']);
  });
});
