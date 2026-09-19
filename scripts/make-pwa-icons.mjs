// PWA（ホーム画面のアイコン）用の PNG を public/icons/ に作る。
// assets/reel-studio.ico と同じ意匠。ffmpeg が要るので**手元で実行して結果をコミットする**
// （Vercel のビルド環境には ffmpeg が無い）。再生成するときだけ実行すればよい。
//
//   node scripts/make-pwa-icons.mjs
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'public', 'icons');
const font = path.join(root, 'engine', 'public', 'fonts', 'NotoSerifJP-Bold.ttf');
const BG = '0x12141A';
const FG = '0xFFD966';

/** maskable は外周 20% が切り落とされることがあるので、字と枠を内側に寄せる */
const TARGETS = [
  {name: 'icon-192.png', size: 192, safe: 1},
  {name: 'icon-512.png', size: 512, safe: 1},
  {name: 'icon-maskable-512.png', size: 512, safe: 0.72},
  {name: 'apple-touch-icon.png', size: 180, safe: 1},
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-pwa-icon-'));
try {
  fs.copyFileSync(font, path.join(tmp, 'font.ttf'));
  fs.mkdirSync(outDir, {recursive: true});
  for (const t of TARGETS) {
    const inner = Math.round(t.size * t.safe);
    const pad = Math.round((t.size - inner) / 2);
    const border = Math.max(2, Math.round(inner * 0.023));
    const fontsize = Math.round(inner * 0.62);
    const filters = [
      `drawbox=x=${pad}:y=${pad}:w=${inner}:h=${inner}:color=${FG}:t=${border}`,
      `drawtext=fontfile=font.ttf:text=R:fontcolor=${FG}:fontsize=${fontsize}:x=(w-text_w)/2+${Math.round(t.size * 0.018)}:y=(h-text_h)/2-${Math.round(t.size * 0.03)}`,
    ].join(',');
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${BG}:s=${t.size}x${t.size}`, '-vf', filters, '-frames:v', '1', t.name], {
      cwd: tmp,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`ffmpeg (${t.name}) に失敗: ${r.stderr || r.stdout}`);
    fs.copyFileSync(path.join(tmp, t.name), path.join(outDir, t.name));
    console.log(`${path.join('public', 'icons', t.name)}（${fs.statSync(path.join(outDir, t.name)).size} bytes）`);
  }
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
