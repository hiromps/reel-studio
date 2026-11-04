import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

it.skipIf(process.platform !== 'win32')('未コミット変更があるフォルダでも、Git・ソース・設定を変えずにデスクトップの更新先を確認できる', () => {
  const files = ['package.json', 'package-lock.json', 'scripts/update.mjs', 'worker/sync.ts'].map((name) => path.join(root, name));
  const before = files.map(hash);
  const result = spawnSync(process.execPath, ['scripts/update.mjs', '--desktop', '--local-build', '--check-only'], {cwd: root, encoding: 'utf8', windowsHide: true});
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('デスクトップ版の更新');
  expect(result.stdout).toContain('まだビルド・インストールは行っていません');
  expect(result.stdout).not.toContain('未コミットの変更があるため');
  expect(files.map(hash)).toEqual(before);
});

it('バッチはASCIIを維持し、デスクトップ更新を既定にして失敗コードを返す', () => {
  const body = fs.readFileSync(path.join(root, 'Reel Studio 更新.cmd'));
  expect(body.every((value) => value < 128)).toBe(true);
  expect(body.toString()).toContain('scripts\\run-desktop-update.ps1" %*');
  expect(body.toString()).toContain('if errorlevel 1 goto failed');
});
