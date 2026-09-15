import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mixScriptPath} from '../core/mix';

const run = (args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync(process.execPath, [mixScriptPath(), ...args], {encoding: 'utf8', env: {...process.env, REEL_SFX_DIR: undefined, ...env}, windowsHide: true});

describe('mix-narration.cjs', () => {
  it('同梱の .cjs を指す（ESM パッケージなので .js だと require が使えない）', () => {
    expect(mixScriptPath().endsWith('mix-narration.cjs')).toBe(true);
    expect(fs.existsSync(mixScriptPath())).toBe(true);
  });

  it('引数が無ければ使い方を出して終了コード 1', () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('使い方');
  });

  it('効果音があるのに置き場（sfxDir / REEL_SFX_DIR）が無ければ日本語で止まる（ffmpeg は要らない）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mix-'));
    const spec = path.join(dir, 'narration.json');
    fs.writeFileSync(spec, JSON.stringify({segments: [{id: 'n01', at: 0, text: 'テスト'}], sfx: [{id: 's1', at: 0, file: 'x.mp3'}]}));
    const r = run([spec, path.join(dir, 'narration'), path.join(dir, 'in.mp4'), path.join(dir, 'out.mp4')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('効果音の置き場');
    fs.rmSync(dir, {recursive: true, force: true});
  });
});
