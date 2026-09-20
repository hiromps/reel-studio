// クラウド版を本番に出す。
//
//   npm run cloud:deploy            ビルドして本番に出す
//   npm run cloud:deploy -- --check  確認だけして出さない
//
// なぜ専用のコマンドにするか:
//   このリポジトリには「公開版（ローカル専用）」と「クラウド版」の 2 つの状態がある。
//   公開版のまま `vercel deploy` すると、API（api/ と cloud/）が入っていないものが本番に乗り、
//   画面は出るのに全部 404 になる（「サーバーに接続できません」）。
//   一度やると気づきにくいので、出す前に必ず確かめる。
//
// **GitHub との自動連携は切っておくこと。** 繋がっていると、公開リポジトリへの push で
// 公開版が本番に上書きされて同じ事故になる（この script も毎回確認して警告する）。
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.slice(2).includes('--check');
const isWin = process.platform === 'win32';
const C = {dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m'};
const log = (m) => console.log(`${C.cyan}▸${C.reset} ${m}`);
const ok = (m) => console.log(`${C.green}✔${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✖${C.reset} ${m}`);

/**
 * vercel CLI を呼ぶ。
 * Windows では `npx.cmd` を直接 spawn できない（Node 20 以降は .cmd の起動を塞いでいる）ので、
 * node で npx-cli.js を直に叩く。shell: true は使わない —— URL に ? や & が入るため。
 */
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const vercel = (args, opt = {}) => {
  const [cmd, argv] = fs.existsSync(npxCli)
    ? [process.execPath, [npxCli, '--yes', 'vercel', ...args]]
    : [isWin ? 'npx.cmd' : 'npx', ['vercel', ...args]];
  const r = spawnSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: opt.inherit ? 'inherit' : 'pipe',
    shell: !fs.existsSync(npxCli) && isWin,
  });
  return {code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim()};
};

const npm = (args, label) => {
  log(label);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], {cwd: root, stdio: 'inherit', windowsHide: true})
    : spawnSync(isWin ? 'npm.cmd' : 'npm', args, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (r.status !== 0) throw new Error(`${label} に失敗しました`);
};

// ── 1. クラウド版のコードがあるか（公開版のまま出さない）
for (const p of ['cloud/app.ts', 'api/[...path].js', 'worker/index.ts']) {
  if (!fs.existsSync(path.join(root, p))) {
    fail(`${p} がありません。いまは「公開版（ローカル専用）」のブランチにいます。`);
    console.log(`  クラウド版のブランチに切り替えてから実行してください:`);
    console.log(`  ${C.dim}git checkout feature/cloud-pwa${C.reset}\n`);
    process.exit(1);
  }
}

// ── 2. Vercel のプロジェクトに紐づいているか
const linkFile = path.join(root, '.vercel', 'project.json');
if (!fs.existsSync(linkFile)) {
  fail('Vercel のプロジェクトに紐づいていません。先に `npm run cloud:setup` を実行してください。');
  process.exit(1);
}
const project = JSON.parse(fs.readFileSync(linkFile, 'utf8'));
const teamQ = project.orgId?.startsWith('team_') ? `?teamId=${project.orgId}` : '';

// ── 3. GitHub の自動連携が残っていないか（残っていると push で公開版に上書きされる）
const info = vercel(['api', `/v9/projects/${project.projectId}${teamQ}`]);
try {
  const j = JSON.parse(info.out.slice(info.out.indexOf('{')));
  if (j.link) {
    warn(`このプロジェクトは GitHub（${j.link.org}/${j.link.repo}）と自動連携しています。`);
    console.log(`  ${C.dim}このままだと、公開リポジトリへ push したときに「公開版」が本番に上書きされ、${C.reset}`);
    console.log(`  ${C.dim}画面は出るのに API が全部 404 になります（「サーバーに接続できません」）。${C.reset}`);
    console.log(`  切るには: ${C.dim}npx vercel api "/v9/projects/${project.projectId}/link${teamQ}" -X DELETE${C.reset}\n`);
  } else {
    ok('GitHub の自動連携なし（このコマンドからだけ本番に出ます）');
  }
} catch {
  /* 確認できなくてもデプロイは続ける */
}

// ── 4. ビルドして出す
if (checkOnly) {
  ok('確認だけしました（--check）。出すときは npm run cloud:deploy');
  process.exit(0);
}
npm(['run', 'build'], 'ビルドしています（画面 + API のバンドル）');
log('本番にデプロイしています…');
const dep = vercel(['deploy', '--prod', '--yes'], {inherit: true});
if (dep.code !== 0) throw new Error('デプロイに失敗しました');

console.log('');
ok('本番に出しました。');
console.log(`  ${C.dim}確認: 画面を開いてログインできること、Settings で「PC 接続中」になること${C.reset}`);
console.log(`  ${C.dim}スマホで「PC オフライン」と出ていたら、PC で Reel Studio を起動し直してください${C.reset}\n`);
