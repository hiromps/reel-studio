// クラウド接続（URL とワーカートークン）を ~/.reel-studio/settings.json に保存する。
// GUI の Settings「クラウド接続」と同じことを、コマンドからやるためのもの。
//
//   node scripts/set-cloud.mjs <URL> <WORKER_TOKEN>
//   node scripts/set-cloud.mjs --off        … 繋ぐのをやめる（URL とトークンは残す）
//
// 他の設定（フォルダ・鍵・AI）には触らない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = process.env.REEL_STUDIO_HOME?.trim() || path.join(os.homedir(), '.reel-studio');
const file = path.join(dir, 'settings.json');

const args = process.argv.slice(2);
const off = args.includes('--off');
const [url, token] = args.filter((a) => !a.startsWith('--'));
if (!off && (!url || !token)) {
  console.error('使い方: node scripts/set-cloud.mjs <URL> <WORKER_TOKEN>   /   node scripts/set-cloud.mjs --off');
  process.exit(1);
}

let s = {version: 1};
if (fs.existsSync(file)) {
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`${file} を読めません: ${e.message}`);
    process.exit(1);
  }
}
const cloud = {...(s.cloud ?? {})};
if (off) cloud.enabled = false;
else {
  cloud.url = url.replace(/\/+$/, '');
  cloud.token = token;
  cloud.enabled = true;
}
s.cloud = cloud;

fs.mkdirSync(dir, {recursive: true});
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', {encoding: 'utf8', mode: 0o600});
fs.renameSync(tmp, file);

const mask = (v) => (!v ? 'なし' : v.length <= 4 ? '••••' : `••••${v.slice(-4)}`);
console.log(`保存しました: ${file}`);
console.log(`  url     ${cloud.url ?? '(未設定)'}`);
console.log(`  token   ${mask(cloud.token)}`);
console.log(`  enabled ${cloud.enabled}`);
console.log('次: Reel Studio を起動し直す（ショートカットから起動すればワーカーも一緒に動きます）');
