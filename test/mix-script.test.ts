import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {missingMixAssets, mixScriptPath} from '../core/mix';
import type {Narration} from '@shared/schema';

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

describe('missingMixAssets（レンダー前に mix の材料を確かめる）', () => {
  const narration = (): Narration => ({
    voice: 'v',
    segments: [
      {id: '01_hook', at: 0, text: 'あ'},
      {id: '02_body', at: 2, text: 'い'},
    ],
  });

  it('wav が 1 本も無ければ、足りない id を並べて「音声を生成」に誘導する', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mixassets-'));
    const problems = missingMixAssets(dir, narration());
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('01_hook, 02_body');
    expect(problems[0]).toContain('音声を生成');
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('これから TTS で作る wav（フック差し替え）は足りない扱いにしない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mixassets-'));
    fs.mkdirSync(path.join(dir, 'narration'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'narration', '02_body.wav'), '');
    expect(missingMixAssets(dir, narration(), {ignoreWavIds: ['01_hook']})).toEqual([]);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('効果音のファイルが無いことも拾う（mix はここでも exit 1 になる）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mixassets-'));
    fs.mkdirSync(path.join(dir, 'narration'), {recursive: true});
    for (const id of ['01_hook', '02_body']) fs.writeFileSync(path.join(dir, 'narration', `${id}.wav`), '');
    const n = {...narration(), sfxDir: dir, sfx: [{id: 's1', at: 0, file: 'nope.mp3'}]} as Narration;
    const problems = missingMixAssets(dir, n);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('nope.mp3');
    fs.rmSync(dir, {recursive: true, force: true});
  });
});
