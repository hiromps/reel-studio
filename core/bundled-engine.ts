// インストーラー版ではネット接続・npmを使わず、同梱の描画部品を案件へ配る。
// ファイル単位のハードリンクは削除しても元の部品を消さない。別ドライブならコピー。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export async function installBundledEngine(project: string, engine: string, onLine: (line: string) => void = () => {}) {
  const modules = path.join(engine, 'node_modules');
  const required = ['remotion/package.json', '@remotion/cli/remotion-cli.js'];
  if (!required.every((rel) => fs.existsSync(path.join(modules, rel)))) throw new Error('同梱の描画部品が見つかりません。Reel Studioを再インストールしてください。');
  const stamp = createHash('sha256').update(fs.readFileSync(path.join(engine, 'package-lock.json'))).digest('hex');
  const marker = path.join(project, '.studio', 'bundled-engine.json');
  try {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).stamp === stamp && required.every((rel) => fs.existsSync(path.join(project, 'node_modules', rel)))) return;
  } catch { /* 新規/旧案件 */ }
  onLine('同梱の動画エンジンを準備しています（ダウンロードは不要です）');
  const copy = async (from: string, to: string) => {
    if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) throw new Error(`リンクされたフォルダには描画部品を配置できません: ${to}`);
    await fs.promises.mkdir(to, {recursive: true});
    for (const entry of await fs.promises.readdir(from, {withFileTypes: true})) {
      if (['.cache', '.remotion'].includes(entry.name)) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`同梱部品に予期しないリンクがあります: ${src}`);
      if (entry.isDirectory()) await copy(src, dst);
      else {
        // 既存のハードリンクへの上書きは避け、リンクを外してから配置する。
        try { await fs.promises.unlink(dst); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try { await fs.promises.link(src, dst); } catch { await fs.promises.copyFile(src, dst); }
      }
    }
  };
  await copy(modules, path.join(project, 'node_modules'));
  const backup = path.join(project, '.studio', 'backups', `runtime-${Date.now()}`);
  for (const file of ['package.json', 'package-lock.json', 'remotion.config.ts']) {
    const src = path.join(engine, file);
    const dst = path.join(project, file);
    if (fs.existsSync(dst) && !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
      fs.mkdirSync(backup, {recursive: true});
      fs.copyFileSync(dst, path.join(backup, file));
    }
    fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(path.dirname(marker), {recursive: true});
  fs.writeFileSync(marker, JSON.stringify({stamp}, null, 2));
  onLine('動画エンジンの準備が完了しました');
}
