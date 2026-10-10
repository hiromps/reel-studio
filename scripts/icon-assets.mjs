// One vector master for Windows, browser/PWA, and in-app branding.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Resvg} from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vector = fs.readFileSync(path.join(root, 'assets/reel-studio.svg'), 'utf8');
const outDir = path.join(root, 'public/icons');
const icoSizes = [256, 128, 64, 48, 32, 24, 16];

function png(size, maskable = false) {
  // Keep the full mark inside Android's central safe circle.
  const svg = maskable ? `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1a73ff"/><g transform="translate(77 77) scale(0.7)">${vector.replace(/<svg[^>]*>/, '').replace('</svg>', '')}</g></svg>` : vector;
  return new Resvg(svg, {fitTo: {mode: 'width', value: size}, font: {loadSystemFonts: false}}).render().asPng();
}

export function makeWindowsIcon() {
  const pngs = icoSizes.map((size) => ({size, data: png(size)}));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = header.length + entries.length;
  pngs.forEach(({size, data}, index) => {
    const pos = index * 16;
    entries.writeUInt8(size === 256 ? 0 : size, pos);
    entries.writeUInt8(size === 256 ? 0 : size, pos + 1);
    entries.writeUInt16LE(1, pos + 4);
    entries.writeUInt16LE(32, pos + 6);
    entries.writeUInt32LE(data.length, pos + 8);
    entries.writeUInt32LE(offset, pos + 12);
    offset += data.length;
  });
  fs.writeFileSync(path.join(root, 'assets/reel-studio.ico'), Buffer.concat([header, entries, ...pngs.map(({data}) => data)]));
  console.log(`Windows icon: ${icoSizes.join('/')} px`);
}

export function makeBrowserIcons() {
  fs.mkdirSync(outDir, {recursive: true});
  fs.copyFileSync(path.join(root, 'assets/reel-studio.svg'), path.join(outDir, 'reel-studio.svg'));
  for (const [name, size, maskable] of [
    ['icon-192.png', 192, false], ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true],
    ['favicon-32.png', 32, false],
  ]) fs.writeFileSync(path.join(outDir, name), png(size, maskable));
  console.log('Browser/PWA icons generated from assets/reel-studio.svg');
}
