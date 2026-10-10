import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createRequire} from 'node:module';
import {installBundledEngine} from '../core/bundled-engine';

const {backendEnvironment, externalUrl, permissionAllowed} = createRequire(import.meta.url)('../desktop/runtime.cjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-bundled-'));
  dirs.push(dir);
  const engine = path.join(dir, 'engine');
  const project = path.join(dir, 'project');
  for (const [rel, content] of Object.entries({
    'node_modules/remotion/package.json': '{"version":"4.0.522"}',
    'node_modules/@remotion/cli/remotion-cli.js': 'bundled cli',
    'node_modules/.cache/ignored': 'cache',
    'package.json': '{"name":"engine"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'remotion.config.ts': 'bundled config',
  })) {
    const file = path.join(engine, rel);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(project);
  return {engine, project};
}

describe('offline rendering dependencies', () => {
  it('prepares an offline project, preserves old configuration, and skips a prepared project', async () => {
    const {engine, project} = fixture();
    fs.writeFileSync(path.join(project, 'remotion.config.ts'), 'old configuration');
    await installBundledEngine(project, engine);
    expect(fs.readFileSync(path.join(project, 'node_modules/@remotion/cli/remotion-cli.js'), 'utf8')).toBe('bundled cli');
    expect(fs.existsSync(path.join(project, 'node_modules/.cache'))).toBe(false);
    const backups = fs.readdirSync(path.join(project, '.studio/backups'));
    expect(fs.readFileSync(path.join(project, '.studio/backups', backups[0], 'remotion.config.ts'), 'utf8')).toBe('old configuration');
    const messages: string[] = [];
    await installBundledEngine(project, engine, (line) => messages.push(line));
    expect(messages).toEqual([]);
    fs.rmSync(path.join(project, 'node_modules'), {recursive: true});
    expect(fs.existsSync(path.join(engine, 'node_modules/remotion/package.json'))).toBe(true);
    await installBundledEngine(project, engine);
    expect(fs.existsSync(path.join(project, 'node_modules/remotion/package.json'))).toBe(true);
  });
  it('unlinks old files before updating so shared installed components are not overwritten', async () => {
    const {engine, project} = fixture();
    await installBundledEngine(project, engine);
    const previous = path.join(project, 'node_modules/@remotion/cli/remotion-cli.js');
    fs.unlinkSync(previous);
    fs.writeFileSync(previous, 'project-specific old version');
    fs.writeFileSync(path.join(engine, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    await installBundledEngine(project, engine);
    expect(fs.readFileSync(previous, 'utf8')).toBe('bundled cli');
    expect(fs.readFileSync(path.join(engine, 'node_modules/@remotion/cli/remotion-cli.js'), 'utf8')).toBe('bundled cli');
  });
  it('rejects an incomplete bundled engine', async () => {
    const {engine, project} = fixture();
    fs.unlinkSync(path.join(engine, 'node_modules/@remotion/cli/remotion-cli.js'));
    await expect(installBundledEngine(project, engine)).rejects.toThrow('再インストール');
    expect(fs.existsSync(path.join(project, '.studio/bundled-engine.json'))).toBe(false);
  });
});

describe('desktop runtime isolation', () => {
  it('uses bundled executables and keeps the parent PATH unchanged', () => {
    const paths = {node: path.resolve('runtime/node/node.exe'), ffmpeg: path.resolve('runtime/ffmpeg/bin'), browser: path.resolve('runtime/chrome/chrome-headless-shell.exe'), backend: path.resolve('backend')};
    const base = {Path: 'system-path', NODE_OPTIONS: '--inspect', NODE_PATH: 'elsewhere', ELECTRON_RUN_AS_NODE: '1', REEL_STUDIO_BROWSER_EXECUTABLE: 'elsewhere'};
    const env = backendEnvironment(base, paths, 'data', 'secret', 'home');
    expect(env.Path.split(path.delimiter).slice(0, 2)).toEqual([path.dirname(paths.node), paths.ffmpeg]);
    expect(env.REEL_STUDIO_BROWSER_EXECUTABLE).toBe(paths.browser);
    expect(env.REEL_STUDIO_HOST).toBe('127.0.0.1');
    expect(env.REEL_STUDIO_PORT).toBe('0');
    expect(env.REEL_STUDIO_DESKTOP_TOKEN).toBe('secret');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(base.Path).toBe('system-path');
  });
  it('only permits ordinary web links to open externally', () => {
    expect(externalUrl('https://example.com/help')).toBe(true);
    for (const url of ['file:///C:/Windows', 'javascript:alert(1)', 'cmd:run', 'https://user:password@example.com', 'invalid']) expect(externalUrl(url)).toBe(false);
  });
  it('allows caption copy within the editor while denying clipboard reads and foreign pages', () => {
    const origin = 'http://127.0.0.1:50001';
    expect(permissionAllowed('clipboard-sanitized-write', `${origin}/`, origin)).toBe(true);
    expect(permissionAllowed('clipboard-read', origin, origin)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', 'https://example.com/', origin)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', 'invalid', origin)).toBe(false);
  });
});
