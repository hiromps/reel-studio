// Reel Studio の更新。git pull と依存の導入をまとめて行う。
//
//   npm run update
//
// 方針:
// - **早送りできないときは何もしない。** 勝手にマージやリベースをすると、手元を直している人が
//   復旧できない状態になる。何をすればよいかを表示して止める
// - 案件データ・設定・人格には一切触らない（リポジトリの外にある）
// - 依存やエンジンが変わったかを見て、次にやることを最後にまとめて出す
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {updateDesktop} from './update-desktop.mjs';
import {updateReleasedDesktop} from './update-released-desktop.mjs';

const updateArgs = new Set(process.argv.slice(2));
if (updateArgs.has('--desktop') && !updateArgs.has('--source')) {
  try {
    if (updateArgs.has('--local-build') || updateArgs.has('--build-only')) await updateDesktop({checkOnly: updateArgs.has('--check-only'), buildOnly: updateArgs.has('--build-only')});
    else await updateReleasedDesktop({checkOnly: updateArgs.has('--check-only'), workspace: process.argv.find(arg => arg.startsWith('--workspace='))?.slice('--workspace='.length) || undefined});
  }
  catch (error) { console.error(`デスクトップ版の更新に失敗: ${error.message}`); process.exitCode = 1; }
  // The desktop update must never fall through to git pull / dirty-tree checks.
  process.exit(process.exitCode ?? 0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const C = {dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m'};
const log = (m) => console.log(`${C.cyan}▸${C.reset} ${m}`);
const ok = (m) => console.log(`${C.green}✔${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✖${C.reset} ${m}`);

const git = (args, quiet = true) => {
  const r = spawnSync('git', args, {cwd: root, encoding: 'utf8', windowsHide: true, stdio: quiet ? 'pipe' : 'inherit'});
  return {code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim()};
};

const npm = (args, label) => {
  log(label);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], {cwd: root, stdio: 'inherit', windowsHide: true})
    : spawnSync(isWin ? 'npm.cmd' : 'npm', args, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (r.status !== 0) throw new Error(`${label} に失敗しました（終了コード ${r.status}）`);
};

console.log(`\n${C.cyan}Reel Studio の更新${C.reset} ${C.dim}${root}${C.reset}\n`);

if (!fs.existsSync(path.join(root, '.git'))) {
  fail('git clone で入れたものではないため、このコマンドでは更新できません（.git がありません）。');
  console.log('  新しく clone し直してください:');
  console.log(`  ${C.dim}git clone https://github.com/hiromps/reel-studio.git${C.reset}`);
  console.log('  設定・人格（~/.reel-studio/）と案件データはフォルダの外にあるので、そのまま引き継がれます。\n');
  process.exit(1);
}

if (git(['rev-parse', '--is-inside-work-tree']).code !== 0) {
  fail('git が使えません。git をインストールしてから実行してください。');
  process.exit(1);
}

const dirty = git(['status', '--porcelain']).out;
if (dirty) {
  fail('手元に未コミットの変更があるため、更新を止めました。');
  console.log(dirty.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
  console.log('  この更新はGitで管理するソース版向けです。インストール済みのデスクトップアプリは、新しいインストーラーで更新してください。');
  console.log('  手元で追加した機能はGitHubの更新に含まれない場合があります。変更を消さず、先にバックアップまたはコミットしてください。');
  console.log(`\n  未追跡ファイルも含めて退避する: ${C.dim}git stash push -u -m "before-reel-update" && npm run update && git stash pop${C.reset}`);
  console.log('  更新に失敗した場合、退避した変更はstashに残ります。git stash listで確認できます。\n');
  process.exit(1);
}

const before = git(['rev-parse', 'HEAD']).out;
log('GitHub から取得しています');
if (git(['fetch', '--tags', 'origin'], false).code !== 0) {
  fail('git fetch に失敗しました（ネットワークと git の設定を確認してください）。');
  process.exit(1);
}

const pull = git(['pull', '--ff-only'], false);
if (pull.code !== 0) {
  fail('早送りで更新できませんでした（手元のコミットが枝分かれしています）。');
  console.log(`  履歴を確認してください: ${C.dim}git log --oneline --graph -20${C.reset}\n`);
  process.exit(1);
}

const after = git(['rev-parse', 'HEAD']).out;
if (before === after) {
  ok('すでに最新です。');
  process.exit(0);
}

const changed = git(['diff', '--name-only', `${before}..${after}`]).out.split('\n').filter(Boolean);
const depsChanged = changed.some((f) => f === 'package-lock.json' || f === 'package.json');
const engineChanged = changed.some((f) => f.startsWith('engine/'));
ok(`${before.slice(0, 7)} → ${after.slice(0, 7)}（${changed.length} ファイル）`);

const subjects = git(['log', '--oneline', '--no-decorate', `${before}..${after}`]).out;
if (subjects) {
  console.log(`\n${C.dim}入った変更:${C.reset}`);
  console.log(subjects.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
}

console.log('');
if (depsChanged) npm(['install', '--no-audit', '--no-fund'], '依存パッケージを入れ直しています');
else log('依存パッケージの変更はありません');

const setup = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup.mjs'), '--no-build'], {cwd: root, stdio: 'inherit', windowsHide: true});
if (setup.status !== 0) throw new Error('実行環境の更新に失敗しました。Reel Studioを終了してセットアップを再実行してください。');

// 画面は次の起動時にランチャーが必要に応じてビルドするが、ここで作っておけば起動が速い
npm(['run', 'build'], '画面をビルドしています');

console.log('');
ok('更新が終わりました。');
if (engineChanged) warn('テロップの描画（エンジン）が変わりました。各案件は次のレンダーで自動的に揃います（すぐ揃えるなら Projects の「エンジン同期」）。');
console.log(`\n  ${C.cyan}Reel Studio を起動し直してください${C.reset}（起動中なら閉じてから）。`);
console.log(`  ${C.dim}案件データ・設定・人格はリポジトリの外にあるので、更新で失われていません。${C.reset}\n`);
