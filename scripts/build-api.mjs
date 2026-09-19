// Vercel Functions の中身（api/_app.cjs）を 1 ファイルにまとめる。
//
// なぜ自前でバンドルするか:
//   Vercel の Node ランタイムは api/ のファイルを**型だけ外して変換する**（依存をまとめない）。
//   そのため `import {createApp} from '../cloud/app'` が実行時に解決できず関数が起動しない
//   （ESM のままなら Cannot find module '/var/task/cloud/app'、CJS 指定なら Cannot use import statement）。
//   ここで cloud/ と shared/ と npm の依存をすべて 1 つの CommonJS ファイルに畳んでおけば、
//   Vercel 側は api/[...path].js（2 行）をそのまま読むだけで済む。
//
//   node scripts/build-api.mjs
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, 'api', '_app.cjs');

const r = await build({
  entryPoints: [path.join(root, 'cloud', 'entry.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  // Vercel の Node ランタイムに合わせる（プロジェクト設定の Node.js Version）
  target: 'node22',
  format: 'cjs',
  // JSON（shared/format-specs/*.json）も畳み込む
  loader: {'.json': 'json'},
  // node の組み込みだけ外に残す
  packages: 'bundle',
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
});

const bytes = fs.statSync(out).size;
const inputs = Object.keys(r.metafile?.inputs ?? {}).length;
console.log(`api/_app.cjs: ${(bytes / 1024 / 1024).toFixed(2)} MB（${inputs} ファイルを畳み込み）`);
