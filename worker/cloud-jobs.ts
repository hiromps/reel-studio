// クラウド（PWA）からしか来ないジョブ。ローカル単体では投げられない。
//   create-project … 案件フォルダを PC に作る（新規／複製）
//   ingest         … スマホから上げた素材を uploads/ に取り込む
//   catalog-import … タグと slug の取り込み（slug 変更は実ファイルのリネームを伴う）
//   fonts          … スマホから上げたテロップ用フォントの取り込み・削除
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {studioConfig} from '../studio.config';
import {cloneProject, createProject, npmInstall, resolveProjectDir} from '../core/project';
import {importTags, loadCatalog} from '../core/catalog';
import {deleteFont, fontsDir, saveFont} from '../core/fonts';
import {loadSettings, mergeSettings, saveSettings} from '../core/settings';
import {safeFontFile} from '../shared/schema/fonts';
import {makePreviewProxy} from '../core/proxy';
import type {PersonaId} from '../shared/schema/brief';
import type {JobRunCtx} from '../server/jobs';

/** ファイル名に使えない文字を落とす（フォルダを掘られないように） */
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim() || 'clip';

export const runCreateProject = async (slug: string, p: Record<string, unknown>, ctx: JobRunCtx): Promise<unknown> => {
  const persona = typeof p.persona === 'string' ? (p.persona as PersonaId) : undefined;
  const shopName = typeof p.shopName === 'string' ? p.shopName : undefined;
  const from = typeof p.from === 'string' && p.from.trim() ? p.from.trim() : undefined;
  const lines: string[] = [];
  let dir: string;
  if (from) {
    const r = cloneProject(from, slug, {persona, shopName, facts: p.facts !== false, carryTimeline: !!p.carryTimeline, onLine: (l) => (lines.push(l), ctx.onLine(l))});
    dir = r.dir;
  } else {
    if (!persona) throw new Error('persona が必要です');
    const r = createProject(slug, {persona, shopName});
    dir = r.dir;
    ctx.onLine(r.created ? `案件フォルダを作りました: ${dir}` : `既にある案件に不足分を足しました: ${dir}`);
  }
  if (p.install !== false && !fs.existsSync(path.join(dir, 'node_modules', 'remotion'))) {
    ctx.onLine('npm install（Remotion エンジン）…');
    const ok = await npmInstall(dir, ctx.onLine);
    if (!ok) ctx.onLine('※ npm install に失敗しました。レンダーの前に案件フォルダで npm install してください');
  }
  return {dir, lines};
};

export const runIngest = async (slug: string, p: Record<string, unknown>, ctx: JobRunCtx): Promise<unknown> => {
  const files = Array.isArray(p.files) ? (p.files as {url: string; name: string}[]) : [];
  if (!files.length) throw new Error('取り込むファイルがありません');
  // 置き場は uploads/<フォルダ名>/。指定が無ければ案件名を使う
  const folder = safeName(typeof p.folder === 'string' && p.folder.trim() ? p.folder : slug.replace(/-reel$/, ''));
  const destDir = path.join(studioConfig.uploadsRoot, folder);
  fs.mkdirSync(destDir, {recursive: true});
  const saved: string[] = [];
  let i = 0;
  for (const f of files) {
    ctx.signal.throwIfAborted();
    i++;
    ctx.onProgress({phase: f.name, done: i - 1, total: files.length});
    const dest = path.join(destDir, safeName(f.name));
    if (fs.existsSync(dest)) {
      ctx.onLine(`既にあります（飛ばします）: ${path.basename(dest)}`);
      saved.push(dest);
      continue;
    }
    const res = await fetch(f.url, {signal: ctx.signal});
    if (!res.ok || !res.body) throw new Error(`取り込めません（HTTP ${res.status}）: ${f.name}`);
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    saved.push(dest);
    ctx.onLine(`取り込みました: ${path.basename(dest)}（${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB）`);
  }
  ctx.onProgress({phase: '完了', done: files.length, total: files.length});
  ctx.onLine(`素材フォルダ: ${destDir}`);
  ctx.onLine('次は Materials の「カタログ化」でこのフォルダを読み込んでください');
  return {dir: destDir, folder, saved: saved.length};
};

/**
 * テロップの自前フォントを、置き場（<設定の置き場>/fonts/）に入れる／置き場から消す。
 *
 * スマホからは Blob に上がってくるので、ここで落として取り込む（中身の検証は saveFont が行う）。
 * 削除も同じジョブで受ける ── 実体が PC にあり、クラウドからは直接触れないため。
 */
export const runFontJob = async (p: Record<string, unknown>, ctx: JobRunCtx): Promise<unknown> => {
  const remove = typeof p.remove === 'string' ? p.remove : '';
  if (remove) {
    const ok = deleteFont(remove);
    ctx.onLine(ok ? `消しました: ${remove}` : `置き場にありませんでした: ${remove}`);
    // 既定に選ばれていたら外す（無いフォントを指したままにしない）
    const cur = loadSettings();
    if (ok && cur.telop.font === safeFontFile(remove)) {
      saveSettings(mergeSettings(cur, {telop: {font: null}}));
      ctx.onLine('既定のフォントを同梱の明朝に戻しました');
    }
    return {removed: ok, file: remove};
  }

  const files = Array.isArray(p.files) ? (p.files as {url: string; name: string}[]) : [];
  if (!files.length) throw new Error('取り込むフォントがありません');
  const saved: string[] = [];
  let i = 0;
  for (const f of files) {
    ctx.signal.throwIfAborted();
    i++;
    ctx.onProgress({phase: f.name, done: i - 1, total: files.length});
    const res = await fetch(f.url, {signal: ctx.signal});
    if (!res.ok) throw new Error(`取り込めません（HTTP ${res.status}）: ${f.name}`);
    const entry = saveFont(f.name, Buffer.from(await res.arrayBuffer()));
    saved.push(entry.file);
    ctx.onLine(`取り込みました: ${entry.file}（${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB）`);
  }
  ctx.onProgress({phase: '完了', done: files.length, total: files.length});
  ctx.onLine(`置き場: ${fontsDir()}`);
  ctx.onLine('Settings の「テロップのフォント」か、Timeline の「動画全体 → フォント」から選べます');
  return {saved, dir: fontsDir()};
};

/**
 * 軽量プロキシ（540x960）が無いクリップを作る。
 *
 * クラウドには原本 4K を上げないので、**これが無いとスマホでは映像が 1 本も見られない**
 * （Timeline のプレビューが真っ黒になる）。カタログ化のあとに自動で続けて作る。
 * 既にあるものは飛ばすので、2 回目以降はほぼ一瞬で終わる。
 */
export const ensurePreviewProxies = async (slug: string, ctx: JobRunCtx): Promise<{made: number; total: number}> => {
  const dir = resolveProjectDir(slug);
  const catalog = loadCatalog(dir);
  if (!catalog) return {made: 0, total: 0};
  const outDir = path.join(dir, studioConfig.studioDirName, 'preview');
  const missing = catalog.clips.filter((c) => !fs.existsSync(path.join(outDir, path.basename(c.src))));
  if (!missing.length) return {made: 0, total: catalog.clips.length};
  ctx.onLine(`スマホで見るための軽量プレビューを ${missing.length} 本作ります（540x960）`);
  let made = 0;
  for (const clip of missing) {
    ctx.signal.throwIfAborted();
    ctx.onProgress({phase: `軽量プレビュー ${clip.id}`, done: made, total: missing.length});
    const src = path.join(dir, 'public', clip.src);
    if (!fs.existsSync(src)) continue;
    await makePreviewProxy(src, path.join(outDir, path.basename(clip.src)), clip.probe);
    made++;
  }
  ctx.onLine(`軽量プレビューを ${made} 本作りました`);
  return {made, total: catalog.clips.length};
};

export const runCatalogImport = async (slug: string, p: Record<string, unknown>, ctx: JobRunCtx): Promise<unknown> => {
  const dir = resolveProjectDir(slug);
  const catalog = loadCatalog(dir);
  if (!catalog) throw new Error('catalog.json が無い');
  const data = {clips: (p.clips ?? []) as never, facts: p.facts as string[] | undefined};
  const r = importTags(dir, catalog, data, p.source === 'user' ? 'user' : 'claude');
  for (const s of r.skipped) ctx.onLine(`skipped: ${s}`);
  return r;
};
