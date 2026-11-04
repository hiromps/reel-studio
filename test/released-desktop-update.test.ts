import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {chooseDesktopUpdate, compareVersions, releaseFiles, latestDesktopRelease, fetchTrusted, downloadReleaseFile, snapshotDesktopSource} from '../scripts/update-released-desktop.mjs';
import {waitForDesktopClosed} from '../scripts/update-desktop.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Reel Studio updater test '));
const bytes = Buffer.from('verified desktop installer');
const hash = createHash('sha256').update(bytes).digest('hex');
const installerUrl = 'https://github.com/hiromps/reel-studio/releases/download/v0.4.11/Reel-Studio-0.4.11-Setup.exe';
const release = () => ({tag_name: 'v0.4.11', draft: false, prerelease: false, assets: [{name: 'Reel-Studio-0.4.11-Setup.exe', state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash, browser_download_url: installerUrl}]});
afterEach(() => vi.restoreAllMocks());

describe('最新版の自動選択', () => {
  it('数値順で版を比較し、最新版の再インストールとダウングレードをしない', () => {
    expect(compareVersions('0.4.10', 'v0.4.9')).toBe(1);
    expect(chooseDesktopUpdate('0.4.11', '0.4.11', '0.4.10')).toBe('current');
    expect(chooseDesktopUpdate('0.4.10', '0.4.11', '0.4.2')).toBe('local');
    expect(chooseDesktopUpdate('0.4.10', '0.4.9', '0.4.11')).toBe('release');
    expect(chooseDesktopUpdate(null, null, '0.4.11')).toBe('release');
    expect(() => compareVersions('garbage', '0.4.11')).toThrow();
  });
  it('正式版の自リポジトリのEXEとSHA256だけを受け入れる', () => {
    expect(releaseFiles(release()).digest).toBe(hash);
    expect(() => releaseFiles({...release(), prerelease: true})).toThrow();
    const bad = release(); bad.assets[0].browser_download_url = installerUrl.replace('hiromps', 'someone');
    expect(() => releaseFiles(bad)).toThrow();
  });
  it('一時的な接続失敗を再試行して公開済みの最新版を取得する', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response(JSON.stringify(release())));
    expect((await latestDesktopRelease(fetcher))?.tag_name).toBe('v0.4.11');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('正規ダウンロードの転送には追従し、外部サイトへの転送を止める', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: 'https://release-assets.githubusercontent.com/asset'}})).mockResolvedValueOnce(new Response(bytes));
    expect((await fetchTrusted(installerUrl, {fetcher})).ok).toBe(true);
    const bad = vi.fn().mockResolvedValue(new Response(null, {status: 302, headers: {location: 'https://example.com/bad.exe'}}));
    await expect(fetchTrusted(installerUrl, {fetcher: bad})).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
  });
  it('完全なファイルを検証してから確定し、破損ファイルを残さない', async () => {
    const file = path.join(root, 'good.exe');
    await downloadReleaseFile(installerUrl, file, {sha256: hash, size: bytes.length, fetcher: vi.fn(async () => new Response(bytes))});
    expect(fs.readFileSync(file)).toEqual(bytes);
    const cachedFetch = vi.fn();
    await downloadReleaseFile(installerUrl, file, {sha256: hash, size: bytes.length, fetcher: cachedFetch});
    expect(cachedFetch).not.toHaveBeenCalled();
    const bad = path.join(root, 'bad.exe');
    await expect(downloadReleaseFile(installerUrl, bad, {sha256: '0'.repeat(64), fetcher: vi.fn(async () => new Response(bytes))})).rejects.toThrow('SHA256');
    expect(fs.existsSync(bad)).toBe(false); expect(fs.existsSync(bad + '.part')).toBe(false);
  });
  it('保存してアプリが閉じられるまで待ち、強制終了しない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const inspect = vi.fn().mockReturnValueOnce({running: true}).mockReturnValueOnce({running: true}).mockReturnValueOnce({running: false});
    const delay = vi.fn(async () => {});
    await waitForDesktopClosed(inspect, delay);
    expect(delay).toHaveBeenCalledTimes(1);
  });
  it('編集中の依存部品に触らず、素材・鍵を除いたソースのコピーでビルドする', () => {
    const source = path.join(root, 'source');
    for (const name of ['src', 'node_modules', 'data', 'engine/public/uploads', 'engine/public/fonts', 'scripts']) fs.mkdirSync(path.join(source, name), {recursive: true});
    for (const name of ['src/App.tsx', 'node_modules/active.exe', 'data/user.wav', 'engine/public/uploads/user.mp4', 'engine/public/fonts/font.ttf', 'scripts/.env.local', 'package.json']) fs.writeFileSync(path.join(source, name), name);
    const snapshot = snapshotDesktopSource(source, path.join(root, 'cache'));
    expect(fs.readFileSync(path.join(snapshot, 'src/App.tsx'), 'utf8')).toBe('src/App.tsx');
    expect(fs.existsSync(path.join(snapshot, 'engine/public/fonts/font.ttf'))).toBe(true);
    for (const name of ['node_modules', 'data', 'engine/public/uploads', 'scripts/.env.local']) expect(fs.existsSync(path.join(snapshot, name))).toBe(false);
    expect(fs.existsSync(path.join(source, 'node_modules/active.exe'))).toBe(true);
  });
});
