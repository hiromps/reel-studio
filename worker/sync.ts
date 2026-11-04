// 契約ファイルの双方向同期と、ローカルメディアの参照登録。
//
// 決め事:
// - **契約ファイルはクラウドが正**。衝突したら PC 側を .studio/conflicts/ に退避してクラウドを採る
//   （スマホで直したものが黙って消える方が困る。退避してあるので失われはしない）
// - バイナリは全て PC に保持する。DB にはパスとメタデータのみ登録する。
// - 何をどこまで同期したかは案件の .studio/cloud-sync.json に残す
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {DOC_FILES, DOC_NAMES, isTextDoc, type DocName} from '../shared/project';
import {stableHash} from '../shared/hash';
import {fileStamp} from '../shared/time';
import {writeJsonAtomic} from '../core/json-io';
import {backupsDir, engineDiff, projectInfo, projectSlug} from '../core/project';
import {fontsDir, listFonts} from '../core/fonts';
import {buildFacts} from '../core/build';
import {contentTypeOf, type AssetKind, type AssetMode} from '../shared/media';
import {copyLocalMedia} from '../core/local-media';
import {settingsDir} from '../core/settings';
import type {CloudClient} from './client';
import {hasReelCuts} from '../core/reel-cuts';
import {readCuts, readNarration} from '../core/project';
import {readScript} from '../core/script';

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
  if (hasReelCuts(dir)) {
    if (name === 'cuts') return readCuts(dir);
    if (name === 'narration') return readNarration(dir);
    if (name === 'script') return {text: readScript(dir)};
  }
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
  const localDocs = new Map(DOC_NAMES.map((name) => [name, readLocalDoc(dir, name)]));
  const known = Object.fromEntries([...localDocs].filter(([, data]) => data !== null).map(([name, data]) => [name, stableHash(data)]));
  const remote = new Map((await client.pullDocs(slug, known)).docs.map((d) => [d.name, d]));
  const report: DocSyncReport = {pulled: [], pushed: [], conflicted: []};
  const toPush: {name: DocName; data: unknown; baseRev: number | null}[] = [];

  for (const name of DOC_NAMES) {
    const local = localDocs.get(name) ?? null;
    const localHash = local === null ? null : stableHash(local);
    const r = remote.get(name);
    const last = state.docs[name];
    const remoteMoved = !!r && (local === null || !last || r.rev > last.rev);
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

/** 実体を送らず参照として登録する対象。 */
const candidates = (dir: string): Candidate[] => {
  const sdir = studioDir(dir);
  const out: Candidate[] = [];
  for (const rel of walk(path.join(dir, 'public', 'uploads'))) out.push({kind: 'uploads', mode: 'full', relPath: rel, file: path.join(dir, 'public', 'uploads', rel)});
  // サムネイル・ストリップ・コンタクトシート（画面の素材一覧・絵コンテ・トリムバー）
  for (const sub of ['thumbs', 'strips', 'cutframes']) {
    for (const rel of walk(path.join(sdir, sub))) out.push({kind: 'studio', mode: 'full', relPath: `${sub}/${rel}`, file: path.join(sdir, sub, rel)});
  }
  // 参考動画（型を写す元）の分析に使ったコマとコンタクトシート。**動画そのもの（source.*）は上げない**
  for (const rel of walk(path.join(sdir, 'reference'))) if (/\.(jpg|png)$/i.test(rel)) out.push({kind: 'studio', mode: 'full', relPath: `reference/${rel}`, file: path.join(sdir, 'reference', rel)});
  // 軽量プロキシ（540x960）。スマホの Timeline プレビューの本体
  for (const rel of walk(path.join(sdir, 'preview'))) out.push({kind: 'uploads', mode: 'light', relPath: rel, file: path.join(sdir, 'preview', rel)});
  // 書き出し・QC・ナレーション音声
  // 静止画はサムネイル（out/thumbnail.jpg）。スマホから保存して投稿のカバーに使う
  for (const rel of walk(path.join(dir, 'out'))) if (/\.(mp4|m4v|mov|jpg|png)$/i.test(rel)) out.push({kind: 'out', mode: 'full', relPath: rel, file: path.join(dir, 'out', rel)});
  for (const rel of walk(path.join(dir, 'qc'))) out.push({kind: 'qc', mode: 'full', relPath: rel, file: path.join(dir, 'qc', rel)});
  for (const rel of walk(path.join(dir, 'narration'))) if (/\.wav$/i.test(rel)) out.push({kind: 'narration', mode: 'full', relPath: rel, file: path.join(dir, 'narration', rel)});
  return out;
};

/** 大きいものは中身を読まずに済ませる（作り直せば必ず時刻が変わるため） */
const SMALL_BYTES = 8 * 1024 * 1024;

const hashCache = new Map<string, {stamp: string; hash: string}>();
const fileHash = (file: string): string => {
  const st = fs.statSync(file);
  const stamp = `${st.size}-${st.mtimeMs}-${st.ctimeMs}`;
  const cached = hashCache.get(file);
  if (cached?.stamp === stamp) return cached.hash;
  const hash = st.size > SMALL_BYTES ? `s${stamp}` : crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 20);
  if (hashCache.size >= 10_000) hashCache.delete(hashCache.keys().next().value!);
  hashCache.set(file, {stamp, hash});
  return hash;
};

const key = (c: {kind: string; mode: string; relPath: string}) => `${c.kind}/${c.mode}/${c.relPath}`;

export type AssetSyncReport = {uploaded: number; skipped: number; bytes: number};

/** クラウドで保存音声を挿入した場合、PC のレンダー前に WAV を取り込む。 */
export const pullNarrationAudio = async (client: CloudClient, dir: string): Promise<number> => {
  const narration = readLocalDoc(dir, 'narration') as {segments?: {id?: string; durSec?: number; needsTts?: boolean}[]} | null;
  if (!narration?.segments?.length) return 0;
  const needed = narration.segments.filter((s) => s.id && /^[a-zA-Z0-9_-]+$/.test(s.id) && s.durSec && !s.needsTts && !fs.existsSync(path.join(dir, 'narration', `${s.id}.wav`)));
  if (!needed.length) return 0;
  const assets = await client.listAssets(projectSlug(dir));
  const remote = new Map(assets.assets.filter((a) => a.kind === 'narration' && a.mode === 'full').map((a) => [a.relPath, a]));
  const folder = path.join(dir, 'narration');
  let count = 0;
  for (const segment of needed) {
    if (!segment.id || !/^[a-zA-Z0-9_-]+$/.test(segment.id) || !segment.durSec || segment.needsTts) continue;
    const file = path.join(folder, `${segment.id}.wav`);
    if (fs.existsSync(file)) continue;
    const asset = remote.get(`${segment.id}.wav`);
    if (!asset?.url) continue;
    copyLocalMedia(asset.url, file);
    count++;
  }
  return count;
};

/** バイナリを送らず、ローカルの絶対パスとメタデータだけを差分登録する。 */
export const syncAssets = async (client: CloudClient, dir: string, opt: {limit?: number; onLine?: (l: string) => void} = {}): Promise<AssetSyncReport> => {
  const state = readSyncState(dir);
  const list = candidates(dir);
  const registered = [];
  const stamps: [string, string][] = [];
  for (const c of list) {
    const hash = fileHash(c.file);
    const file = path.resolve(c.file);
    const stamp = `local-v1:${file}:${hash}`;
    if (state.assets[key(c)] === stamp) continue;
    registered.push({kind: c.kind, mode: c.mode, relPath: c.relPath, url: file, bytes: fs.statSync(file).size, hash, contentType: contentTypeOf(file)});
    stamps.push([key(c), stamp]);
    if (registered.length >= (opt.limit ?? 400)) break;
  }
  for (let i = 0; i < registered.length; i += 50) {
    const batch = registered.slice(i, i + 50);
    const result = await client.registerAssets(projectSlug(dir), batch);
    if (result.bad.length || result.saved !== batch.length) throw new Error('ローカルメディア索引の登録に失敗しました');
  }
  const current = readSyncState(dir);
  for (const [k, stamp] of stamps) current.assets[k] = stamp;
  writeSyncState(dir, current);
  if (registered.length) opt.onLine?.(`ローカルメディア ${registered.length} 件の参照を登録しました`);
  return {uploaded: registered.length, skipped: list.length - registered.length, bytes: 0};
};

/** フォントも実体は動かさず、参照を登録する。 */
export const syncFonts = async (client: CloudClient, opt: {onLine?: (l: string) => void} = {}): Promise<AssetSyncReport> => {
  const file = path.join(settingsDir(), 'local-font-sync.json');
  let state: Record<string, string> = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 初回 */ }
  const registered = [];
  const list = listFonts();
  for (const font of list) {
    const localPath = path.resolve(fontsDir(), font.file);
    const hash = fileHash(localPath);
    const stamp = `${localPath}:${hash}`;
    if (state[font.file] === stamp) continue;
    registered.push({kind: 'fonts', mode: 'full', relPath: font.file, url: localPath, bytes: font.sizeBytes, hash, contentType: contentTypeOf(font.file)});
    state[font.file] = stamp;
  }
  if (registered.length) {
    const result = await client.registerAssets('_global', registered);
    if (result.bad.length || result.saved !== registered.length) throw new Error('フォント索引の登録に失敗しました');
    writeJsonAtomic(file, state);
    opt.onLine?.(`フォント ${registered.length} 件のローカル参照を登録しました`);
  }
  return {uploaded: registered.length, skipped: list.length - registered.length, bytes: 0};
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
