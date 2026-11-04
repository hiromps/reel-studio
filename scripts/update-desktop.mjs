// Apply this workspace to the installed app without touching Git or project data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {appRoot, runtimeEnv} from './runtime.mjs';
import {run, runNpm} from './setup-lib.mjs';

const installerScript = path.join(appRoot, 'scripts', 'install-desktop-update.ps1');
const digest = (file) => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
export const inspectInstallation = () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerScript, '-Inspect'], {cwd: appRoot, encoding: 'utf8', windowsHide: true});
  if (result.status !== 0) throw new Error((result.stdout || result.stderr).trim() || 'インストール先を確認できません');
  return JSON.parse(result.stdout.trim());
};

export const waitForDesktopClosed = async (inspect = inspectInstallation, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) => {
  if (!inspect().running) return;
  console.log('Reel Studio が起動しています。編集を保存してアプリを閉じてください。閉じると自動で更新を続けます（強制終了しません）。');
  while (inspect().running) await delay(2000);
};

export const updateDesktop = async ({checkOnly = false, buildOnly = false, prepared = null} = {}) => {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Windows と Node.js 22 以上が必要です。「Reel Studio 更新.cmd」から実行してください。');
  const version = prepared?.version ?? JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('更新するバージョンが不正です。');
  const before = inspectInstallation();
  const installer = path.join(appRoot, 'desktop-out', `Reel-Studio-${version}-Setup.exe`);
  console.log(`デスクトップ版の更新: ${before.version || '未インストール'} → ${version}`);
  console.log(`インストール先: ${before.directory}`);
  console.log('このフォルダの変更を含めてアプリを作成します。Git の取得・退避・上書きは行いません。');
  if (checkOnly) { console.log('確認完了。まだビルド・インストールは行っていません。'); return {version, before, installer, checkOnly: true}; }
  if (!buildOnly) await waitForDesktopClosed();

  if (!prepared) runNpm(['run', 'desktop:installer']);
  if (!fs.existsSync(installer)) throw new Error('作成したインストーラーが見つかりません。');
  const installerHash = digest(installer);
  if (prepared && installerHash !== prepared.sha256) throw new Error('ダウンロードしたインストーラーのSHA256が一致しません。');
  fs.writeFileSync(`${installer}.sha256`, `${installerHash}  ${path.basename(installer)}\n`);
  // Verify the packaged runtime before changing the installed app.
  if (!prepared) run(process.execPath, [path.join(appRoot, 'scripts', 'verify-desktop.mjs')]);
  if (buildOnly) { console.log(`インストーラー作成・検証完了: ${installer}`); return {version, installer, buildOnly: true}; }
  await waitForDesktopClosed();
  if (digest(installer) !== installerHash) throw new Error('検証後にインストーラーが変更されました。');

  const home = process.env.REEL_STUDIO_HOME?.trim() || path.join(os.homedir(), '.reel-studio');
  const settings = ['settings.json', 'personas.json', 'oc-eat.json', 'emotion_tags.json', 'modal-cloud.json', 'modal-vault.key'].map((name) => ({name, file: path.join(home, name)}));
  const original = new Map(settings.map(({file}) => [file, digest(file)]));
  const backup = path.join(appRoot, '.runtime', 'desktop-update-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, {recursive: true});
  const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8', windowsHide: true});
  const sid = who.stdout?.match(/S-1-[0-9-]+/)?.[0];
  if (!sid || spawnSync('icacls.exe', [path.dirname(backup), '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], {windowsHide: true, stdio: 'ignore'}).status !== 0) throw new Error('設定バックアップのアクセス権を保護できません。');
  for (const {name, file} of settings) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, name), fs.constants.COPYFILE_EXCL);
  console.log('検証済みのインストーラーを適用しています…');
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerScript, '-Installer', installer, '-ExpectedVersion', version]);
  const installed = inspectInstallation();
  for (const {file} of settings) if (digest(file) !== original.get(file)) throw new Error(`設定の内容が更新前と異なります。バックアップを確認してください: ${backup}`);
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installed.directory, 'resources', 'backend', 'package.json'), 'utf8'));
  if (installedPackage.version !== version) throw new Error('インストールされたバックエンドの版が一致しません。');
  // Use a separate test home, never the user's actual projects or credentials.
  run(process.execPath, [path.join(appRoot, 'scripts', 'verify-desktop.mjs'), installed.executable], {env: {...runtimeEnv(), REEL_DESKTOP_EXPECTED_VERSION: version}});
  const report = {ok: true, updatedAt: new Date().toISOString(), version, previousVersion: before.version, executable: installed.executable, installer, installerHash, settingsPreserved: true, backup};
  fs.writeFileSync(path.join(appRoot, '.runtime', 'desktop-update-result.json'), JSON.stringify(report, null, 2));
  console.log(`\nデスクトップ版 ${version} への更新が完了しました。デスクトップまたはスタートメニューから起動できます。`);
  console.log('案件・素材・設定・人格は引き継いでいます。');
  return report;
};
