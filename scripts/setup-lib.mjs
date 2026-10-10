import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appRoot, runtimeEnv} from './runtime.mjs';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: appRoot, env: runtimeEnv(), stdio: 'inherit', windowsHide: true, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} に失敗しました（終了コード ${result.status}）`);
  return result;
}

export function runNpm(args, cwd = appRoot) {
  const cli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .find((p) => p && p.endsWith('.js') && fs.existsSync(p));
  if (cli) return run(process.execPath, [cli, ...args], {cwd});
  if (process.platform === 'win32') throw new Error('npm が見つかりません。「Reel Studio セットアップ.cmd」を実行してください。');
  return run('npm', args, {cwd});
}

// 時刻ではなく lock の内容を記録する。ZIP 展開・失敗したインストールも判別できる。
export function dependencyStamp(dir) {
  const hash = createHash('sha256');
  for (const file of ['package.json', 'package-lock.json']) hash.update(fs.readFileSync(path.join(dir, file)));
  return hash.digest('hex');
}

export function ensureDependencies(dir, required) {
  const stamp = path.join(dir, 'node_modules', '.reel-studio-deps');
  const digest = dependencyStamp(dir);
  if (required.every((p) => fs.existsSync(path.join(dir, 'node_modules', p))) &&
      fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === digest) return;
  console.log(`依存パッケージを導入しています: ${path.basename(dir)}（初回は数分かかります）`);
  runNpm(['ci', '--include=dev', '--no-audit', '--no-fund'], dir);
  fs.writeFileSync(stamp, digest);
}

export function probe(command, args = ['-version']) {
  const result = spawnSync(command, args, {env: runtimeEnv(), encoding: 'utf8', windowsHide: true, timeout: 15000});
  return result.status === 0 ? (result.stdout || result.stderr).trim() : null;
}
