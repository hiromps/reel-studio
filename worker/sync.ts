// 案件の同期。契約ファイル（docs）の双方向と、メディア（サムネ・軽量プロキシ・完成動画）の一方向。
//
// 決め事:
// - **契約ファイルはクラウドが正**。衝突したら PC 側を .studio/conflicts/ に退避してクラウドを採る
//   （スマホで直したものが黙って消える方が困る。退避してあるので失われはしない）
// - **原本 4K は上げない**。上げるのはサムネ・ストリップ・軽量プロキシ（540x960）・完成動画・ナレーション音声
// - 何をどこまで同期したかは案件の .studio/cloud-sync.json に残す
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {put} from '@vercel/blob';
import {studioConfig} from '../studio.config';
import {DOC_FILES, DOC_NAMES, isTextDoc, type DocName} from '../shared/project';
import {stableHash} from '../shared/hash';
import {fileStamp} from '../shared/time';
import {writeJsonAtomic} from '../core/json-io';
import {backupsDir, engineDiff, projectInfo, projectSlug} from '../core/project';
import {fontsDir, listFonts} from '../core/fonts';
import {buildFacts} from '../core/build';
import {blobPath, contentTypeOf, type AssetKind, type AssetMode} from '../cloud/blob';
import type {CloudClient} from './client';

const studioDir = (dir: string) => path.join(dir, studioConfig.studioDirName);
const syncStatePath = (dir: string) => path.join(studioDir(dir), 'cloud-sync.json');

type SyncState = {docs: Record<string, {rev: number; hash: string}>; assets: Record<string, string>};

const readSyncState = (dir: string): SyncState => {
  try {
    const raw = JSON.parse(fs.readFileSync(syncStatePath(dir), 'utf8')) as Partial<SyncState>;
    return {docs: raw.docs ?? {}, assets: raw.assets ?? {}};
  } catch {
    return {docs: {}, assets: {}};
  }
};

const writeSyncState = (dir: string, s: SyncState) => writeJsonAtomic(syncStatePath(dir), s);

// ───────────────────────── 契約ファイル ─────────────────────────

const docFile = (dir: string, name: DocName) => path.join(dir, DOC_FILES[name]);

/** ローカルのファイル → docs に載せる形（テキストのものは {text}）。無ければ null */
export const readLocalDoc = (dir: string, name: DocName): unknown | null => {
  const file = docFile(dir, name);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return isTextDoc(name) ? {text: raw} : JSON.parse(raw);
  } catch {
    return null; // 壊れているものは「無い」扱い（クラウド側を壊さない）
  }
};

const writeLocalDoc = (dir: string, name: DocName, data: unknown) => {
  const file = docFile(dir, name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (isTextDoc(name)) {
    if (fs.existsSync(file)) backupTo(file, backupsDir(dir));
    fs.writeFileSync(file, String((data as {text?: string})?.text ?? ''), 'utf8');
  } else {
    writeJsonAtomic(file, data, {backupDir: backupsDir(dir)});
  }
};

const backupTo = (file: string, dir: string): void => {
  fs.mkdirSync(dir, {recursive: true});
  const ext = path.extname(file);
  fs.copyFileSync(file, path.join(dir, `${path.basename(file, ext)}.${fileStamp()}${ext}`));
};

const conflictsDir = (dir: string) => path.join(studioDir(dir), 'conflicts');

export type DocSyncReport = {pulled: DocName[]; pushed: DocName[]; conflicted: DocName[]};

/**
 * 契約ファイルの双方向同期。
 * 「前回同期した版」からの変化を両側で見て、片側だけ動いていればそれを流す。
 * 両方動いていたらクラウドを採り、PC 側の中身は .studio/conflicts/ に残す。
 */
export const syncDocs = async (client: CloudClient, dir: string): Promise<DocSyncReport> => {
  const slug = projectSlug(dir);
  const state = readSyncState(dir);
  const remote = new Map((await client.pullDocs(slug)).docs.map((d) => [d.name, d]));
  const report: DocSyncReport = {pulled: [], pushed: [], conflicted: []};
  const toPush: {name: DocName; data: unknown; baseRev: number | null}[] = [];

  for (const name of DOC_NAMES) {
    const local = readLocalDoc(dir, name);
    const localHash = local === null ? null : stableHash(local);
    const r = remote.get(name);
    const last = state.docs[name];
    const remoteMoved = !!r && (!last || r.rev > last.rev);
    const localMoved = localHash !== null && (!last || localHash !== last.hash);

    if (remoteMoved && r!.hash !== localHash) {
      if (localMoved && local !== null) {
        // 両方動いた。クラウドを採り、PC 側の版は残しておく
        const f = docFile(dir, name);
        if (fs.existsSync(f)) backupTo(f, conflictsDir(dir));
        report.conflicted.push(name);
      }
      writeLocalDoc(dir, name, r!.data);
      state.docs[name] = {rev: r!.rev, hash: r!.hash};
      report.pulled.push(name);
      continue;
    }
    if (localMoved && (!r || r.hash !== localHash)) {
      toPush.push({name, data: local, baseRev: r?.rev ?? null});
      continue;
    }
    // 変わっていない。最新の版番号だけ覚え直す
    if (r) state.docs[name] = {rev: r.rev, hash: r.hash};
  }

  if (toPush.length) {
    const {results} = await client.pushDocs(slug, toPush);
    for (const res of results) {
      const name = res.name as DocName;
      if (res.ok && res.rev !== undefined) {
        state.docs[name] = {rev: res.rev, hash: res.hash!};
        report.pushed.push(name);
      } else if (res.conflict) {
        // 送っている間にクラウドが進んでいた。PC 側を退避してクラウドを採る
        const f = docFile(dir, name);
        if (fs.existsSync(f)) backupTo(f, conflictsDir(dir));
        writeLocalDoc(dir, name, res.conflict.data);
        state.docs[name] = {rev: res.conflict.rev, hash: res.conflict.hash};
        report.conflicted.push(name);
      }
    }
  }
  writeSyncState(dir, state);
  return report;
};

// ───────────────────────── メディア ─────────────────────────

type Candidate = {kind: AssetKind; mode: AssetMode; relPath: string; file: string};

const walk = (root: string, rel = ''): string[] => {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
};

/** 上げる対象。**原本（public/uploads）は入れない** */
const candidates = (dir: string): Candidate[] => {
  const sdir = studioDir(dir);
  const out: Candidate[] = [];
  // サムネイル・ストリップ・コンタクトシート（画面の素材一覧・絵コンテ・トリムバー）
  for (const sub of ['thumbs', 'strips', 'cutframes']) {
    for (const rel of walk(path.join(sdir, sub))) out.push({kind: 'studio', mode: 'full', relPath: `${sub}/${rel}`, file: path.join(sdir, sub, rel)});
  }
  // 参考動画（型を写す元）の分析に使ったコマとコンタクトシート。**動画そのもの（source.*）は上げない**
  for (const rel of walk(path.join(sdir, 'reference'))) if (/\.(jpg|png)$/i.test(rel)) out.push({kind: 'studio', mode: 'full', relPath: `reference/${rel}`, file: path.join(sdir, 'reference', rel)});
  // 軽量プロキシ（540x960）。スマホの Timeline プレビューの本体
  for (const rel of walk(path.join(sdir, 'preview'))) out.push({kind: 'uploads', mode: 'light', relPath: rel, file: path.join(sdir, 'preview', rel)});
  // 書き出し・QC・ナレーション音声
  for (const rel of walk(path.join(dir, 'out'))) if (/\.(mp4|m4v|mov)$/i.test(rel)) out.push({kind: 'out', mode: 'full', relPath: rel, file: path.join(dir, 'out', rel)});
  for (const rel of walk(path.join(dir, 'qc'))) out.push({kind: 'qc', mode: 'full', relPath: rel, file: path.join(dir, 'qc', rel)});
  for (const rel of walk(path.join(dir, 'narration'))) if (/\.wav$/i.test(rel)) out.push({kind: 'narration', mode: 'full', relPath: rel, file: path.join(dir, 'narration', rel)});
  return out;
};

/** 大きいものは中身を読まずに済ませる（作り直せば必ず時刻が変わるため） */
const SMALL_BYTES = 8 * 1024 * 1024;

const fileHash = (file: string): string => {
  const st = fs.statSync(file);
  if (st.size > SMALL_BYTES) return `s${st.size}-m${Math.round(st.mtimeMs)}`;
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 20);
};

const key = (c: {kind: string; mode: string; relPath: string}) => `${c.kind}/${c.mode}/${c.relPath}`;

export type AssetSyncReport = {uploaded: number; skipped: number; bytes: number};

/** 変わったものだけ Blob に上げて索引に登録する */
export const syncAssets = async (client: CloudClient, dir: string, blobToken: string, opt: {limit?: number; onLine?: (l: string) => void} = {}): Promise<AssetSyncReport> => {
  const slug = projectSlug(dir);
  const remote = new Map((await client.listAssets(slug)).assets.map((a) => [key(a), a.hash]));
  const list = candidates(dir);
  const todo: {c: Candidate; hash: string}[] = [];
  for (const c of list) {
    let hash: string;
    try {
      hash = fileHash(c.file);
    } catch {
      continue;
    }
    if (remote.get(key(c)) === hash) continue;
    todo.push({c, hash});
  }
  const limit = opt.limit ?? 400;
  const batch = todo.slice(0, limit);
  if (!batch.length) return {uploaded: 0, skipped: list.length, bytes: 0};
  opt.onLine?.(`クラウドへ ${batch.length} 件アップロード中…`);

  const registered: {kind: string; mode: string; relPath: string; url: string; bytes: number; hash: string; contentType: string}[] = [];
  let bytes = 0;
  for (const {c, hash} of batch) {
    const st = fs.statSync(c.file);
    const contentType = contentTypeOf(c.relPath);
    const body = st.size > SMALL_BYTES ? fs.createReadStream(c.file) : fs.readFileSync(c.file);
    const r = await put(blobPath(slug, c.kind, c.mode, c.relPath), body, {access: 'public', contentType, addRandomSuffix: true, token: blobToken});
    registered.push({kind: c.kind, mode: c.mode, relPath: c.relPath, url: r.url, bytes: st.size, hash, contentType});
    bytes += st.size;
    // 索引は 50 件ずつ入れる（1 リクエストを大きくしすぎない）
    if (registered.length >= 50) {
      await client.registerAssets(slug, registered.splice(0, registered.length));
    }
  }
  if (registered.length) await client.registerAssets(slug, registered);
  return {uploaded: batch.length, skipped: list.length - batch.length, bytes};
};

// ───────────────────────── 自前フォント ─────────────────────────

/**
 * テロップの自前フォント（<設定の置き場>/fonts/）をクラウドへ上げる。
 *
 * 案件に属さないので slug は `_global`（効果音と同じ扱い）。これが無いと、スマホで見る
 * プレビューだけ同梱の明朝で描かれてしまい、PC で見えているものと違う絵になる。
 * レンダー自体は PC で走るので、上げ損ねても完成品の見た目は変わらない。
 */
export const syncFonts = async (client: CloudClient, blobToken: string, opt: {onLine?: (l: string) => void} = {}): Promise<AssetSyncReport> => {
  const dir = fontsDir();
  const list = listFonts();
  if (!list.length) return {uploaded: 0, skipped: 0, bytes: 0};
  const remote = new Map((await client.listAssets('_global')).assets.map((a) => [key(a), a.hash]));
  const registered: {kind: string; mode: string; relPath: string; url: string; bytes: number; hash: string; contentType: string}[] = [];
  let uploaded = 0;
  let bytes = 0;
  for (const f of list) {
    const file = path.join(dir, f.file);
    let hash: string;
    try {
      hash = fileHash(file);
    } catch {
      continue;
    }
    if (remote.get(key({kind: 'fonts', mode: 'full', relPath: f.file})) === hash) continue;
    const contentType = contentTypeOf(f.file);
    const r = await put(blobPath('_global', 'fonts', 'full', f.file), fs.readFileSync(file), {access: 'public', contentType, addRandomSuffix: true, token: blobToken});
    registered.push({kind: 'fonts', mode: 'full', relPath: f.file, url: r.url, bytes: f.sizeBytes, hash, contentType});
    uploaded++;
    bytes += f.sizeBytes;
  }
  if (registered.length) {
    await client.registerAssets('_global', registered);
    opt.onLine?.(`フォントを ${registered.length} 件アップロードしました`);
  }
  return {uploaded, skipped: list.length - uploaded, bytes};
};

// ───────────────────────── 案件の状態 ─────────────────────────

/** PC でしか分からないこと（engine の差分・node_modules・out/ の有無・仕上げの段取り）を送る */
export const pushProjectState = async (client: CloudClient, dir: string): Promise<void> => {
  const info = projectInfo(dir);
  let facts;
  try {
    facts = buildFacts(dir);
  } catch {
    facts = undefined; // まだ cuts が無い等。段取りはクラウド側の既定で出る
  }
  const brief = readLocalDoc(dir, 'brief') as {persona?: string; format?: string; shop?: {name?: string}} | null;
  await client.pushProject(projectSlug(dir), {
    info: {dir: info.dir, engine: info.engine, nodeModules: info.nodeModules, out: info.out},
    buildFacts: facts,
    ...(brief?.persona ? {persona: brief.persona} : {}),
    ...(brief?.format ? {format: brief.format} : {}),
    ...(brief?.shop?.name ? {shopName: brief.shop.name} : {}),
  });
};

export {engineDiff};
