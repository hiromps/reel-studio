import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runtimeEnv} from '../scripts/runtime.mjs';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
const fixture = (tools: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-runtime-'));
  tempDirs.push(dir);
  const browser = path.join(dir, 'chrome.exe');
  fs.writeFileSync(browser, 'fixture');
  const file = path.join(dir, 'tools.json');
  fs.writeFileSync(file, JSON.stringify(typeof tools === 'function' ? tools(dir, browser) : tools));
  return {dir, browser, file};
};

describe('保存した実行環境を各子プロセスへ渡す', () => {
  it('PATHを変更せずに、個別導入FFmpegと共有ブラウザを子へ渡す', () => {
    const {dir, browser, file} = fixture((dir: string, browser: string) => ({ffmpegDir: dir, browser}));
    const original = {Path: 'original-path'};
    const env = runtimeEnv(original, file);
    expect(env.Path?.split(path.delimiter)).toContain(dir);
    expect(env.Path?.split(path.delimiter)).toContain('original-path');
    expect(env.PATH).toBeUndefined();
    expect(env.REEL_STUDIO_BROWSER_EXECUTABLE).toBe(browser);
    expect(original).toEqual({Path: 'original-path'});
  });
  it('利用者が指定したブラウザを優先する', () => {
    const {file} = fixture((_dir: string, browser: string) => ({browser}));
    expect(runtimeEnv({REEL_STUDIO_BROWSER_EXECUTABLE: 'custom-browser'}, file).REEL_STUDIO_BROWSER_EXECUTABLE).toBe('custom-browser');
  });
  it('アプリを移動して保存済みツールが消えていても標準PATHを使える', () => {
    const {dir, file} = fixture({});
    fs.writeFileSync(file, JSON.stringify({ffmpegDir: path.join(dir, 'missing'), browser: path.join(dir, 'missing.exe')}));
    const env = runtimeEnv({PATH: 'original'}, file);
    expect(env.PATH).not.toContain('missing');
    expect(env.REEL_STUDIO_BROWSER_EXECUTABLE).toBeUndefined();
  });
  it('初回・壊れた記録でもCLI起動を妨げない', () => {
    const {file} = fixture({});
    fs.writeFileSync(file, '{');
    expect(runtimeEnv({PATH: 'original'}, file).PATH).toContain('original');
    fs.writeFileSync(file, 'null');
    expect(runtimeEnv({PATH: 'original'}, file).PATH).toContain('original');
    fs.unlinkSync(file);
    expect(runtimeEnv({PATH: 'original'}, file).PATH).toContain('original');
  });
});
