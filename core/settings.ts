// ユーザー設定（REEL_STUDIO_HOME ?? ~/.reel-studio/settings.json）の読み書きとパス解決。
//
// - studio.config.ts から呼ばれるので、ここから studio.config.ts を import しない（循環になる）
// - 環境変数は遅延で読む（テストがファイルごとに REEL_STUDIO_HOME を差し替えるため）
// - 鍵の値はここから外に出すだけで、ログ・例外文・画面用の view には載せない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PATH_KEYS, SettingsSchema, type PathKey, type SecretView, type Settings, type SettingsPatch, type SettingsView, type ValueSource} from '../shared/schema/settings';
import {writeJsonAtomic} from './json-io';

/** アプリ（このリポジトリ）のルート */
export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const settingsDir = (): string => process.env.REEL_STUDIO_HOME?.trim() || path.join(os.homedir(), '.reel-studio');
export const settingsFile = (): string => path.join(settingsDir(), 'settings.json');
export const personasFile = (): string => path.join(settingsDir(), 'personas.json');
export const settingsBackupDir = (): string => path.join(settingsDir(), 'backups');

export const defaultSettings = (): Settings => SettingsSchema.parse({version: 1});

type Cache = {file: string; settings: Settings; problem: string | null};
let cache: Cache | null = null;

/**
 * 設定を読む。無ければ既定値、壊れていても既定値で動かして problem に理由を残す
 * （設定ファイル 1 つのせいで GUI が開けなくなると、直す手段が無くなる）。
 */
export const loadSettings = (): Settings => {
  const file = settingsFile();
  if (cache && cache.file === file) return cache.settings;
  let settings = defaultSettings();
  let problem: string | null = null;
  if (fs.existsSync(file)) {
    try {
      const r = SettingsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (r.success) settings = r.data;
      else {
        const first = r.error.issues[0];
        problem = `${file} の検証に失敗: ${first?.path.join('.') || '(root)'} ${first?.message}（既定値で動いています）`;
      }
    } catch (e) {
      problem = `${file} を読めません: ${(e as Error).message}（既定値で動いています）`;
    }
  }
  cache = {file, settings, problem};
  return settings;
};

export const settingsProblem = (): string | null => {
  loadSettings();
  return cache?.problem ?? null;
};

/** 保存後・テストで読み直す */
export const resetSettings = (): void => {
  cache = null;
};

export const saveSettings = (next: Settings): Settings => {
  const data = SettingsSchema.parse(next);
  // Windows では mode は効かない（ユーザープロファイル配下の ACL 任せ）。README に明記
  writeJsonAtomic(settingsFile(), data, {backupDir: settingsBackupDir(), mode: 0o600});
  resetSettings();
  return data;
};

const isClear = (v: unknown): v is null | '' => v === null || v === '';

/** patch に書いてあるキーだけ変える。null / '' は「消す（既定に戻す）」 */
export const mergeSettings = (cur: Settings, patch: SettingsPatch): Settings => {
  const next: Record<string, unknown> = {
    version: 1,
    dataRoot: cur.dataRoot,
    paths: {...cur.paths},
    tts: {...cur.tts, voices: [...cur.tts.voices]},
    agent: {...cur.agent},
  };
  const setOrClear = (obj: Record<string, unknown>, key: string, v: unknown) => {
    if (v === undefined) return;
    if (isClear(v)) delete obj[key];
    else obj[key] = typeof v === 'string' ? v.trim() : v;
  };
  setOrClear(next, 'dataRoot', patch.dataRoot);
  if (patch.paths) for (const k of ['workDir', 'uploadsRoot', 'outputsDir', 'sfxDir'] as const) setOrClear(next.paths as Record<string, unknown>, k, patch.paths[k]);
  if (patch.tts) {
    const tts = next.tts as Record<string, unknown>;
    setOrClear(tts, 'apiKey', patch.tts.apiKey);
    setOrClear(tts, 'modelId', patch.tts.modelId);
    if (patch.tts.voices) tts.voices = patch.tts.voices;
  }
  if (patch.agent) {
    const agent = next.agent as Record<string, unknown>;
    setOrClear(agent, 'claudeBin', patch.agent.claudeBin);
    setOrClear(agent, 'model', patch.agent.model);
    for (const k of ['tagBatchSize', 'tagConcurrency', 'timeoutMin'] as const) if (patch.agent[k] !== undefined) agent[k] = patch.agent[k];
  }
  return SettingsSchema.parse(next);
};

// ───────────────────────── パス解決 ─────────────────────────

const ENV_OF: Record<PathKey, string> = {
  dataRoot: 'REEL_STUDIO_DATA_ROOT',
  workDir: 'REEL_STUDIO_WORK_DIR',
  uploadsRoot: 'REEL_STUDIO_UPLOADS_ROOT',
  outputsDir: 'REEL_STUDIO_OUTPUTS_DIR',
  sfxDir: 'REEL_SFX_DIR',
};
const SUBDIR: Record<Exclude<PathKey, 'dataRoot'>, string> = {workDir: 'work', uploadsRoot: 'uploads', outputsDir: 'outputs', sfxDir: 'sfx'};

const envValue = (key: PathKey): string | null => {
  const v = process.env[ENV_OF[key]]?.trim();
  return v ? v : null;
};

export type ResolvedPaths = Record<PathKey, string>;
export type PathSources = Record<PathKey, ValueSource>;

const resolveAll = (s: Settings = loadSettings()): {paths: ResolvedPaths; sources: PathSources} => {
  const paths = {} as ResolvedPaths;
  const sources = {} as PathSources;
  const envRoot = envValue('dataRoot');
  if (envRoot) {
    paths.dataRoot = path.resolve(envRoot);
    sources.dataRoot = 'env';
  } else if (s.dataRoot) {
    paths.dataRoot = path.resolve(s.dataRoot);
    sources.dataRoot = 'settings';
  } else {
    paths.dataRoot = path.join(appRoot, 'data');
    sources.dataRoot = 'default';
  }
  for (const k of PATH_KEYS) {
    if (k === 'dataRoot') continue;
    const e = envValue(k);
    const conf = s.paths[k];
    if (e) {
      paths[k] = path.resolve(e);
      sources[k] = 'env';
    } else if (conf) {
      paths[k] = path.resolve(paths.dataRoot, conf); // 絶対ならそのまま、相対なら dataRoot 基準
      sources[k] = 'settings';
    } else {
      paths[k] = path.join(paths.dataRoot, SUBDIR[k]);
      sources[k] = 'default';
    }
  }
  return {paths, sources};
};

export const resolvedPaths = (): ResolvedPaths => resolveAll().paths;
export const pathSources = (): PathSources => resolveAll().sources;

// ───────────────────────── 画面用 ─────────────────────────

export const maskSecret = (v: string): string => (v.length <= 4 ? '••••' : `••••${v.slice(-4)}`);

/** Fish Audio の鍵の在り処（値は返さない） */
export const fishKeyView = (): SecretView => {
  const env = process.env.FISH_API_KEY?.trim();
  if (env && !env.startsWith('${')) return {present: true, masked: maskSecret(env), source: 'env'};
  const conf = loadSettings().tts.apiKey?.trim();
  if (conf) return {present: true, masked: maskSecret(conf), source: 'settings'};
  return {present: false, masked: '', source: null};
};

/** GET /api/settings の本体。claude の情報は呼び出し側（core/agent.ts を知っている層）が足す */
export const settingsView = (claude: SettingsView['claude'], templateDir: string): SettingsView => {
  const s = loadSettings();
  const {paths, sources} = resolveAll(s);
  const {apiKey: _omit, ...ttsRest} = s.tts;
  void _omit;
  const pathsView = {} as SettingsView['paths'];
  for (const k of PATH_KEYS) pathsView[k] = {value: paths[k], source: sources[k], exists: fs.existsSync(paths[k])};
  pathsView.templateDir = templateDir;
  return {
    dir: settingsDir(),
    file: settingsFile(),
    exists: fs.existsSync(settingsFile()),
    problem: settingsProblem(),
    settings: {...s, tts: {...ttsRest, apiKey: fishKeyView()}},
    paths: pathsView,
    env: {
      fishApiKey: !!process.env.FISH_API_KEY?.trim(),
      fishModelId: !!process.env.FISH_MODEL_ID?.trim(),
      claudeBin: !!process.env.REEL_STUDIO_CLAUDE_BIN?.trim(),
      agentModel: !!process.env.REEL_STUDIO_AGENT_MODEL?.trim(),
    },
    claude,
  };
};
