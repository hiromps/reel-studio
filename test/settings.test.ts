import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appRoot, defaultSettings, fishKeyView, loadSettings, maskSecret, mergeSettings, pathSources, resetSettings, resolvedPaths, saveSettings, settingsFile, settingsProblem, settingsView} from '../core/settings';
import {fishEnv, resetFishEnv} from '../core/tts';
import {studioConfig} from '../studio.config';

let home: string;
const ENV_KEYS = ['REEL_STUDIO_DATA_ROOT', 'REEL_STUDIO_WORK_DIR', 'REEL_STUDIO_UPLOADS_ROOT', 'REEL_STUDIO_OUTPUTS_DIR', 'REEL_SFX_DIR', 'FISH_API_KEY', 'FISH_MODEL_ID'];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-settings-'));
  process.env.REEL_STUDIO_HOME = home;
  for (const k of ENV_KEYS) delete process.env[k];
  resetSettings();
  resetFishEnv();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetSettings();
  resetFishEnv();
  fs.rmSync(home, {recursive: true, force: true});
});

describe('settings: 既定値と置き場', () => {
  it('ファイルが無ければ既定値で、フォルダは <appRoot>/data 配下', () => {
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(loadSettings()).toEqual(defaultSettings());
    const p = resolvedPaths();
    expect(p.dataRoot).toBe(path.join(appRoot, 'data'));
    expect(p.workDir).toBe(path.join(appRoot, 'data', 'work'));
    expect(p.sfxDir).toBe(path.join(appRoot, 'data', 'sfx'));
    expect(pathSources()).toEqual({dataRoot: 'default', workDir: 'default', uploadsRoot: 'default', outputsDir: 'default', sfxDir: 'default'});
    expect(settingsProblem()).toBeNull();
  });

  it('settings.json の dataRoot と個別上書き（絶対／dataRoot 相対）が効き、studioConfig の getter に反映される', () => {
    const root = path.join(home, 'my-data');
    saveSettings(mergeSettings(defaultSettings(), {dataRoot: root, paths: {workDir: 'projects', sfxDir: path.join(home, 'sounds')}}));
    const p = resolvedPaths();
    expect(p.dataRoot).toBe(root);
    expect(p.workDir).toBe(path.join(root, 'projects'));
    expect(p.uploadsRoot).toBe(path.join(root, 'uploads'));
    expect(p.sfxDir).toBe(path.join(home, 'sounds'));
    expect(pathSources().workDir).toBe('settings');
    expect(pathSources().uploadsRoot).toBe('default');
    expect(studioConfig.workDir).toBe(path.join(root, 'projects'));
  });

  it('環境変数は settings.json より強い', () => {
    saveSettings(mergeSettings(defaultSettings(), {dataRoot: path.join(home, 'a')}));
    process.env.REEL_STUDIO_DATA_ROOT = path.join(home, 'b');
    process.env.REEL_SFX_DIR = path.join(home, 'fx');
    expect(resolvedPaths().dataRoot).toBe(path.join(home, 'b'));
    expect(resolvedPaths().workDir).toBe(path.join(home, 'b', 'work'));
    expect(resolvedPaths().sfxDir).toBe(path.join(home, 'fx'));
    expect(pathSources().dataRoot).toBe('env');
  });

  it('壊れたファイルでも既定値で動き、problem に理由が残る', () => {
    fs.mkdirSync(home, {recursive: true});
    fs.writeFileSync(settingsFile(), '{not json');
    expect(loadSettings()).toEqual(defaultSettings());
    expect(settingsProblem()).toMatch(/読めません/);
    fs.writeFileSync(settingsFile(), JSON.stringify({version: 1, agent: {tagBatchSize: 'x'}}));
    resetSettings();
    expect(loadSettings().agent.tagBatchSize).toBe(8);
    expect(settingsProblem()).toMatch(/検証に失敗/);
  });
});

describe('settings: merge と保存', () => {
  it('書いたキーだけ変わり、null / 空文字で消える', () => {
    const cur = mergeSettings(defaultSettings(), {tts: {apiKey: 'abcd1234', modelId: 's2-pro', voices: [{id: 'a'.repeat(32), title: 'v'}]}, agent: {claudeBin: 'C:/x/claude.exe', model: 'sonnet', tagBatchSize: 4}});
    expect(cur.tts.apiKey).toBe('abcd1234');
    expect(cur.tts.modelId).toBe('s2-pro');
    expect(cur.agent.tagBatchSize).toBe(4);
    const next = mergeSettings(cur, {tts: {apiKey: ''}, agent: {claudeBin: null, model: ''}});
    expect(next.tts.apiKey).toBeUndefined();
    expect(next.tts.modelId).toBe('s2-pro'); // 触っていない
    expect(next.tts.voices).toHaveLength(1);
    expect(next.agent.claudeBin).toBeUndefined();
    expect(next.agent.model).toBe('opus'); // 既定に戻る
    expect(next.agent.tagBatchSize).toBe(4);
  });

  it('voices は配列ごと置き換わる', () => {
    const cur = mergeSettings(defaultSettings(), {tts: {voices: [{id: 'a'.repeat(32), title: 'A'}, {id: 'b'.repeat(32), title: 'B'}]}});
    const next = mergeSettings(cur, {tts: {voices: [{id: 'c'.repeat(32), title: 'C'}]}});
    expect(next.tts.voices.map((v) => v.title)).toEqual(['C']);
  });

  it('保存すると読み直せて、バックアップも作られる', () => {
    saveSettings(mergeSettings(defaultSettings(), {tts: {modelId: 's1'}}));
    saveSettings(mergeSettings(loadSettings(), {tts: {modelId: 's2-pro'}}));
    resetSettings();
    expect(loadSettings().tts.modelId).toBe('s2-pro');
    expect(fs.readdirSync(path.join(home, 'backups')).some((f) => f.startsWith('settings.'))).toBe(true);
  });
});

describe('settings: 鍵の扱い', () => {
  it('maskSecret は末尾 4 文字だけ見せる', () => {
    expect(maskSecret('abcdefgh')).toBe('••••efgh');
    expect(maskSecret('ab')).toBe('••••');
  });

  it('fishEnv は環境変数 → settings.json の順で、source に値を含めない', () => {
    expect(fishEnv()).toBeNull();
    expect(fishKeyView()).toEqual({present: false, masked: '', source: null});
    saveSettings(mergeSettings(defaultSettings(), {tts: {apiKey: 'settings-key-0001', modelId: 's2-pro'}}));
    resetFishEnv();
    const a = fishEnv();
    expect(a?.apiKey).toBe('settings-key-0001');
    expect(a?.modelId).toBe('s2-pro');
    expect(a?.source).not.toContain('0001');
    expect(fishKeyView()).toEqual({present: true, masked: '••••0001', source: 'settings'});
    process.env.FISH_API_KEY = 'env-key-9999';
    resetFishEnv();
    expect(fishEnv()?.apiKey).toBe('env-key-9999');
    expect(fishEnv()?.modelId).toBe('s2-pro'); // modelId は settings のまま
    expect(fishKeyView().source).toBe('env');
  });

  it('${VAR} 参照や空白だけの鍵は無視する', () => {
    process.env.FISH_API_KEY = '${FISH_API_KEY}';
    expect(fishEnv()).toBeNull();
    process.env.FISH_API_KEY = '   ';
    resetFishEnv();
    expect(fishEnv()).toBeNull();
  });

  it('settingsView は鍵を出さない', () => {
    saveSettings(mergeSettings(defaultSettings(), {tts: {apiKey: 'secret-key-7777'}}));
    const v = settingsView({bin: 'claude', available: false, source: 'none', version: null}, studioConfig.templateDir);
    expect(JSON.stringify(v)).not.toContain('secret-key');
    expect(v.settings.tts.apiKey).toEqual({present: true, masked: '••••7777', source: 'settings'});
    expect(v.paths.dataRoot.source).toBe('default');
    expect(v.paths.templateDir).toBe(studioConfig.templateDir);
  });
});
