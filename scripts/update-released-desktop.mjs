// Public GitHub releases are the update feed. No Git checkout/pull touches user work.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {appRoot} from './runtime.mjs';
import {run, ensureDependencies} from './setup-lib.mjs';
import {inspectInstallation, updateDesktop, waitForDesktopClosed} from './update-desktop.mjs';

export const DESKTOP_REPOSITORY = 'hiromps/reel-studio';
const API = `https://api.github.com/repos/${DESKTOP_REPOSITORY}`;
const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'Reel-Studio-Updater'};
const allowedHosts = new Set(['api.github.com', 'github.com', 'codeload.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export const releaseVersion = value => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  if (!match || match.slice(1).some(x => !Number.isSafeInteger(Number(x)))) throw new Error('配布バージョンが不正です。');
  return match.slice(1).map(Number).join('.');
};
export const compareVersions = (a, b) => {
  const left = releaseVersion(a).split('.').map(Number), right = releaseVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
};
export const chooseDesktopUpdate = (installed, local, remote) => {
  if (local && (!remote || compareVersions(local, remote) >= 0) && (!installed || compareVersions(local, installed) > 0)) return 'local';
  if (remote && (!installed || compareVersions(remote, installed) > 0)) return 'release';
  return 'current';
};
const trustedUrl = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname) || (url.port && url.port !== '443')) throw new Error('更新ファイルの取得先が不正です。');
  return url;
};
export const releaseFiles = release => {
  const version = releaseVersion(release.tag_name);
  if (release.draft || release.prerelease) throw new Error('正式公開前のバージョンは更新しません。');
  const name = `Reel-Studio-${version}-Setup.exe`;
  const expected = `https://github.com/${DESKTOP_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/`;
  const asset = release.assets?.find(a => a.name === name && a.state === 'uploaded');
  const checksum = release.assets?.find(a => a.name === name + '.sha256' && a.state === 'uploaded');
  if (asset && (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2_000_000_000)) throw new Error('配布ファイルのサイズが不正です。');
  for (const file of [asset, checksum].filter(Boolean)) {
    trustedUrl(file.browser_download_url);
    if (file.browser_download_url !== expected + file.name) throw new Error('配布ファイルのリポジトリが一致しません。');
  }
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? '')?.[1]?.toLowerCase();
  return {version, name, asset, checksum, digest};
};
export const fetchTrusted = async (url, {fetcher = fetch, signal, ...options} = {}) => {
  for (let i = 0; i < 6; i++) {
    const response = await fetcher(trustedUrl(url).href, {...options, signal, headers, redirect: 'manual'});
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = response.headers.get('location');
    await response.body?.cancel();
    if (!next) throw new Error('更新ファイルの転送先がありません。');
    url = new URL(next, url).href;
  }
  throw new Error('更新ファイルの転送回数が多すぎます。');
};
export const latestDesktopRelease = async (fetcher = fetch) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchTrusted(API + '/releases/latest', {fetcher, signal: AbortSignal.timeout(15000)});
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('配布情報が大きすぎます。');
      const release = JSON.parse(text);
      releaseFiles(release);
      return release;
    } catch (error) {lastError = error;}
  }
  throw lastError;
};
export const downloadReleaseFile = async (url, file, {sha256, size, maxBytes = 2_000_000_000, fetcher = fetch} = {}) => {
  const part = file + '.part';
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (sha256 && fs.existsSync(file) && (!size || fs.statSync(file).size === size)) {
    const cachedHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) cachedHash.update(chunk);
    if (cachedHash.digest('hex') === sha256.toLowerCase()) return sha256.toLowerCase();
  }
  for (let attempt = 0; attempt < 3; attempt++) try {
    const response = await fetchTrusted(url, {fetcher, signal: AbortSignal.timeout(15 * 60 * 1000)});
    if (!response.ok || !response.body) throw new Error(`更新ファイルを取得できません（HTTP ${response.status}）。`);
    const hash = createHash('sha256'); let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), async function* (input) {
      for await (const chunk of input) {
        bytes += chunk.length;
        if (bytes > maxBytes || (size && bytes > size)) throw new Error('更新ファイルのサイズが不正です。');
        hash.update(chunk); yield chunk;
      }
    }, fs.createWriteStream(part, {flags: 'w'}));
    const actual = hash.digest('hex');
    if (!bytes || (size && bytes !== size) || (sha256 && actual !== sha256.toLowerCase())) throw new Error('更新ファイルのSHA256またはサイズが一致しません。');
    fs.renameSync(part, file);
    return actual;
  } catch (error) {
    if (attempt === 2) throw error;
  } finally {if (fs.existsSync(part)) fs.unlinkSync(part);}
};
const checksumFor = async files => {
  if (files.digest) return files.digest;
  if (!files.checksum) return null;
  const response = await fetchTrusted(files.checksum.browser_download_url, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('チェックサムを取得できません。');
  const text = await response.text();
  const match = text.length < 4096 && /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(text.trim());
  if (!match || match[2] !== files.name) throw new Error('チェックサムのファイル名が一致しません。');
  return match[1].toLowerCase();
};
export const snapshotDesktopSource = (workspace, parent) => {
  fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'local-'));
  const excluded = new Set(['node_modules', '__pycache__', '.runtime', '.studio', 'data', 'work', 'uploads', 'outputs', 'out', 'dist', 'narration', 'qc', '_app.cjs']);
  const filter = file => {
    const name = path.basename(file);
    if (excluded.has(name) || name.startsWith('.env') || /\.(log|tmp|part)$/.test(name)) return false;
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('ビルド対象にシンボリックリンクが含まれています。');
    return true;
  };
  for (const name of ['assets', 'bin', 'cli', 'core', 'shared', 'server', 'worker', 'cloud', 'src', 'engine', 'scripts', 'desktop', 'docs', 'public', 'api', 'modal_backend']) {
    const source = path.join(workspace, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(root, name), {recursive: true, filter});
  }
  for (const name of ['package.json', 'package-lock.json', 'index.html', 'studio.config.ts', 'tsconfig.json', 'vite.config.ts', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
    const source = path.join(workspace, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, name));
  }
  return root;
};
const buildSource = async root => {
  await waitForDesktopClosed();
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/bootstrap-windows.ps1'), '-ToolsOnly', '-PrivateNode'], {cwd: root});
  ensureDependencies(root, ['tsx/package.json', 'vite/package.json', 'electron/package.json', 'typescript/bin/tsc']);
  run(process.execPath, [path.join(root, 'scripts/update.mjs'), '--desktop', '--local-build'], {cwd: root});
  const report = JSON.parse(fs.readFileSync(path.join(root, '.runtime/desktop-update-result.json'), 'utf8'));
  fs.mkdirSync(path.join(appRoot, '.runtime'), {recursive: true});
  fs.writeFileSync(path.join(appRoot, '.runtime/desktop-update-result.json'), JSON.stringify({...report, sourceRoot: root}, null, 2));
  return report;
};
export const updateReleasedDesktop = async ({workspace = appRoot, checkOnly = false} = {}) => {
  const before = inspectInstallation();
  let local = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    if (pkg.devDependencies?.electron && fs.existsSync(path.join(workspace, 'scripts/prepare-desktop.mjs'))) local = releaseVersion(pkg.version);
  } catch { /* No source workspace is also supported. */ }
  console.log(`デスクトップ版の更新を確認しています（現在 ${before.version || '未インストール'}）…`);
  let release = null, offline = false;
  try {release = await latestDesktopRelease();}
  catch {offline = true; console.log('公開版の確認ができませんでした。ネット接続・GitHubの復旧後に同じ更新コマンドを再実行できます。');}
  const remote = release ? releaseVersion(release.tag_name) : null;
  console.log(`公開済み: ${remote || (offline ? '未確認' : '配布なし')} / 手元: ${local || 'なし'}`);
  const choice = chooseDesktopUpdate(before.version || null, local, remote);
  if (choice === 'current') {
    console.log(offline ? '今回は変更していません。公開版の最新版確認は未完了です。' : 'すでに最新版です。再ビルド・再インストールは不要です。');
    return {status: offline ? 'offline' : 'current', installed: before.version, remote, local};
  }
  const version = choice === 'local' ? local : remote;
  console.log(`${before.version || '未インストール'} → ${version} に更新します。`);
  if (checkOnly) {console.log('確認完了。まだビルド・インストールは行っていません。'); return {status: 'available', version, source: choice};}
  if (choice === 'local') {
    const root = snapshotDesktopSource(workspace, path.join(appRoot, '.runtime/released-sources'));
    if (releaseVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version) !== version) throw new Error('準備中に手元の版が変わりました。もう一度実行してください。');
    await buildSource(root);
    return {status: 'updated', version, source: choice};
  }
  const files = releaseFiles(release);
  const sha256 = files.asset ? await checksumFor(files) : null;
  if (files.asset && sha256) {
    console.log('検証用SHA256付きのインストーラーをダウンロードしています…');
    const file = path.join(appRoot, 'desktop-out', files.name);
    await downloadReleaseFile(files.asset.browser_download_url, file, {sha256, size: files.asset.size});
    await updateDesktop({prepared: {version, sha256}});
  } else {
    console.log('この版はソース配布のため、専用フォルダでアプリを自動作成します。初回は数分かかります。');
    const sources = path.join(appRoot, '.runtime/released-sources');
    fs.mkdirSync(sources, {recursive: true});
    const cache = fs.mkdtempSync(path.join(sources, 'release-'));
    const archive = path.join(cache, 'source.zip');
    await downloadReleaseFile(API + '/zipball/' + encodeURIComponent(release.tag_name), archive, {maxBytes: 200_000_000});
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appRoot, 'scripts/extract-release-source.ps1'), '-Archive', archive, '-Destination', path.join(cache, 'source')]);
    const roots = fs.readdirSync(path.join(cache, 'source'), {withFileTypes: true}).filter(d => d.isDirectory());
    if (roots.length !== 1) throw new Error('配布ソースのフォルダが不正です。');
    const root = path.join(cache, 'source', roots[0].name);
    if (releaseVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version) !== version) throw new Error('配布ソースとリリースの版が一致しません。');
    await buildSource(root);
  }
  return {status: 'updated', version, source: choice};
};
