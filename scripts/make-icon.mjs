// assets/reel-studio.ico を生成する（ffmpeg で PNG を作り、PNG 埋め込み ICO にまとめる）。
// 依存を増やさないため画像ライブラリは使わない。再生成するときだけ実行すればよい。
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outIco = path.join(root, 'assets', 'reel-studio.ico');
const font = path.join(root, 'engine', 'public', 'fonts', 'NotoSerifJP-Bold.ttf');
const SIZES = [256, 128, 64, 48, 32, 16];
const BG = '0x1B1F24';
const FG = '0xFFD966';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-icon-'));
const pngs = [];
try {
  // drawtext の fontfile は Windows のドライブレター（C:）をフィルタ構文と誤認するため、
  // フォントを作業ディレクトリにコピーして相対パスで渡す
  fs.copyFileSync(font, path.join(tmp, 'font.ttf'));
  for (const size of SIZES) {
    const out = `${size}.png`;
    // 濃紺の板に金色の枠と「R」。小さいサイズは字を相対的に大きく、枠を細くする
    const border = Math.max(1, Math.round(size * 0.023));
    const fontsize = Math.round(size * (size <= 32 ? 0.76 : 0.66));
    const filters = [
      `drawbox=x=0:y=0:w=${size}:h=${size}:color=${FG}:t=${border}`,
      `drawtext=fontfile=font.ttf:text=R:fontcolor=${FG}:fontsize=${fontsize}:x=(w-text_w)/2+${Math.round(size * 0.018)}:y=(h-text_h)/2-${Math.round(size * 0.03)}`,
    ].join(',');
    const r = spawnSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${BG}:s=${size}x${size}`, '-vf', filters, '-frames:v', '1', out],
      {cwd: tmp, windowsHide: true, encoding: 'utf8'},
    );
    if (r.status !== 0) throw new Error(`ffmpeg (${size}px) に失敗: ${r.stderr || r.stdout}`);
    pngs.push({size, data: fs.readFileSync(path.join(tmp, out))});
  }

  // ICO（PNG 埋め込み）: ICONDIR(6) + ICONDIRENTRY(16) * n + PNG データ
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((p, i) => {
    const e = i * 16;
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0); // 256 は 0 で表す
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1);
    entries.writeUInt8(0, e + 2); // パレット色数
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(p.data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += p.data.length;
  });

  fs.mkdirSync(path.dirname(outIco), {recursive: true});
  fs.writeFileSync(outIco, Buffer.concat([header, entries, ...pngs.map((p) => p.data)]));
  console.log(`${outIco} を生成しました（${pngs.map((p) => p.size).join('/')}px, ${fs.statSync(outIco).size} bytes）`);
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
