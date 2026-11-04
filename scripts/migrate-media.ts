/** Storage の読み取り専用移行。既定は dry-run。削除 API は実装しない。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import type {Sql} from 'postgres';
import {localMediaRoot} from '../core/local-media';
import {writeJsonAtomic} from '../core/json-io';
import {isAssetKind, isAssetMode} from '../shared/media';
import {normalizeDatabaseUrl} from '../cloud/db/client';
import {resolveProjectDirStrict} from '../core/project';
import {settingsDir} from '../core/settings';

type Asset = {slug: string; kind: string; mode: string; rel_path: string; url: string};
type Item = {id: string; version: string; bucket?: string; key?: string; url: string; size?: number; asset?: Asset};
type RecordEntry = {id: string; version: string; file: string; bytes: number; sha256: string};
type Manifest = {version: 1; entries: Record<string, RecordEntry>};
type Options = {source: 'supabase' | 'assets'; apply: boolean; updateDb: boolean; bucket?: string; root: string; supabaseUrl?: string; key?: string; databaseUrl?: string; fetch?: typeof fetch; log?: (line: string) => void};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const checksum = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const readJson = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
};
const exists = (file: string) => fs.existsSync(file);
const assertInside = (root: string, file: string): void => {
  const relative = path.relative(root, path.resolve(file));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('移行先が保存ディレクトリの範囲外です');
  // 親の既存 symlink も辿って確認する。
  let parent = path.resolve(file);
  while (!exists(parent)) parent = path.dirname(parent);
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(parent));
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('移行先のリンクが保存先の範囲外です');
};

/** 既存案件の欠けたファイルを復元し、Remotion からも読めるようにする。 */
const restoreProjectAsset = (asset: Asset, source: string): void => {
  if (!asset.rel_path || asset.rel_path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || /[:*?"<>|\x00-\x1f]/.test(part))) throw new Error('assets の相対パスが不正です');
  let root: string;
  let sub: string;
  if (asset.slug === '_global') {
    if (asset.kind !== 'fonts') return;
    root = settingsDir();
    fs.mkdirSync(root, {recursive: true});
    sub = 'fonts';
  } else {
    root = resolveProjectDirStrict(asset.slug);
    // 案件JSON・エンジンのない空案件を勝手に作らない。
    if (!exists(root)) return;
    sub = asset.kind === 'uploads' ? (asset.mode === 'light' ? '.studio/preview' : 'public/uploads') : asset.kind === 'studio' ? '.studio' : asset.kind;
    if (!['uploads', 'studio', 'out', 'qc', 'narration'].includes(asset.kind)) return;
  }
  const target = path.resolve(root, sub, asset.rel_path);
  assertInside(root, target);
  if (exists(target)) return; // PC側で編集・生成した版を上書きしない。
  fs.mkdirSync(path.dirname(target), {recursive: true});
  // 生成音声等は同じパスへ書き直されるので、ハードリンクで移行元を共有しない。
  // 対応 FS では copy-on-write、それ以外では通常のコピーになる。
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
};

/** インポートしてモック Storage でも同じ処理を検証できる。 */
export const migrateMedia = async (opt: Options): Promise<{planned: number; downloaded: number; reused: number; updated: number}> => {
  if (opt.updateDb && !opt.apply) throw new Error('--update-db には --apply が必要です');
  if ((opt.source === 'assets' || opt.updateDb) && !opt.databaseUrl) throw new Error('DATABASE_URL が必要です');
  const root = path.resolve(opt.root);
  if (opt.apply) fs.mkdirSync(root, {recursive: true});
  const manifestFile = path.join(root, 'migration-manifest.json');
  const indexFile = path.join(root, 'asset-index.json');
  const manifest = readJson<Manifest>(manifestFile, {version: 1, entries: {}});
  const index = readJson<Record<string, string>>(indexFile, {});
  const request = opt.fetch ?? fetch;
  const log = opt.log ?? console.log;
  const result = {planned: 0, downloaded: 0, reused: 0, updated: 0};
  let sql: Sql | undefined;
  const lock = path.join(root, '.migration.lock');
  let lockFd: number | undefined;
  if (opt.apply) {
    assertInside(root, manifestFile);
    assertInside(root, indexFile);
    lockFd = fs.openSync(lock, 'wx');
    fs.writeFileSync(lockFd, String(process.pid));
  }
  try {
    if (opt.databaseUrl && (opt.source === 'assets' || opt.updateDb)) {
      const {default: postgres} = await import('postgres');
      const url = normalizeDatabaseUrl(opt.databaseUrl);
      sql = postgres(url, {max: 1, prepare: false, ssl: new URL(url).searchParams.get('sslmode') === 'disable' ? false : 'require', connect_timeout: 20});
    }
    const assets: Asset[] = sql ? await sql<Asset[]>`select slug, kind, mode, rel_path, url from assets where url like 'https://%' or url like 'http://%'` : [];
    const items: Item[] = [];
    let base: URL | undefined;
    const headers: Record<string, string> = {};
    const storageJson = async <T>(route: string, body?: unknown): Promise<T> => {
      const response = await request(`${base!.origin}/storage/v1${route}`, {method: body ? 'POST' : 'GET', headers: {...headers, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'error', signal: AbortSignal.timeout(60_000)});
      if (!response.ok) throw new Error(`Storage 一覧取得: HTTP ${response.status}`);
      return response.json() as Promise<T>;
    };
    if (opt.source === 'supabase') {
      if (!opt.supabaseUrl || !opt.key) throw new Error('SUPABASE_URL（https のプロジェクトURL）と SUPABASE_SERVICE_ROLE_KEY が必要です');
      base = new URL(opt.supabaseUrl);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('SUPABASE_URL が不正です');
      headers.apikey = opt.key;
      headers.Authorization = `Bearer ${opt.key}`;
      const buckets: {id: string}[] = opt.bucket ? [{id: opt.bucket}] : [];
      if (!opt.bucket) {
        for (let offset = 0; ; offset += 100) {
          const page = await storageJson<{id: string}[]>(`/bucket?limit=100&offset=${offset}&sortColumn=id&sortOrder=asc`);
          if (!Array.isArray(page)) throw new Error('バケット一覧の形式が不正です');
          buckets.push(...page);
          if (page.length < 100) break;
        }
      }
      for (const {id: bucket} of buckets) {
        const prefixes = [''];
        const seen = new Set<string>();
        while (prefixes.length) {
          const prefix = prefixes.pop()!;
          if (seen.has(prefix)) throw new Error('Storage のフォルダ循環を検出しました');
          seen.add(prefix);
          for (let offset = 0; ; offset += 100) {
            const rows = await storageJson<{id?: string | null; name: string; updated_at?: string; metadata?: {size?: number; eTag?: string} | null}[]>(`/object/list/${encodeURIComponent(bucket)}`, {prefix, limit: 100, offset, sortBy: {column: 'name', order: 'asc'}});
            if (!Array.isArray(rows)) throw new Error('Storage 一覧の形式が不正です');
            for (const row of rows) {
              if (!row.name || row.name.includes('/') || row.name === '.' || row.name === '..') throw new Error('Storage のオブジェクト名が不正です');
              const key = prefix ? `${prefix}/${row.name}` : row.name;
              if (!row.id && !row.metadata) { prefixes.push(key); continue; }
              items.push({id: `supabase:${base.host}/${bucket}/${key}`, bucket, key, version: `${row.updated_at ?? ''}:${row.metadata?.size ?? ''}:${row.metadata?.eTag ?? ''}`, size: row.metadata?.size, url: `${base.origin}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`});
            }
            if (rows.length < 100) break;
          }
        }
      }
    } else {
      for (const asset of assets) {
        const url = new URL(asset.url);
        if (!url.hostname.endsWith('.blob.vercel-storage.com') && !url.pathname.startsWith('/storage/v1/object/')) throw new Error('assets に移行対象外の外部 URL があります');
        // このモードは公開URLを対象にする。非公開 Supabase は --source supabase を使う。
        // 複数の索引が同じ音声・動画を参照していても、ダウンロードは一度だけ。
        items.push({id: `asset:${sha(url.origin + url.pathname)}`, version: sha(asset.url), url: asset.url, asset});
      }
    }
    result.planned = items.length;
    const updates: {asset: Asset; file: string}[] = [];
    for (const item of items) {
      log(`${opt.apply ? '移行' : 'DRY RUN'} ${item.bucket ? `${item.bucket}/${item.key}` : `${item.asset!.slug}/${item.asset!.rel_path}`}`);
      if (!opt.apply) continue;
      const identity = sha(item.id);
      const previous = manifest.entries[identity];
      let record: RecordEntry;
      if (previous?.id === item.id && previous.version === item.version && exists(previous.file)) {
        assertInside(root, previous.file);
        if (fs.statSync(previous.file).size !== previous.bytes || await checksum(previous.file) !== previous.sha256) throw new Error('既存の移行ファイルの検証に失敗しました（上書き・再取得は行いません）');
        record = previous;
        result.reused++;
      } else {
        const extension = path.extname(item.key ?? item.asset!.rel_path).toLowerCase();
        const suffix = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
        const folder = path.join(root, 'imported', identity);
        assertInside(root, folder);
        fs.mkdirSync(folder, {recursive: true});
        const file = path.join(folder, `${sha(item.version)}${suffix}`);
        assertInside(root, file);
        if (exists(file)) throw new Error('未記録の移行先ファイルがあります。確認後、別の保存先で再実行してください');
        const temp = `${file}.${randomUUID()}.part`;
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          const response = await request(item.url, {headers: opt.source === 'supabase' ? headers : {}, redirect: 'error', signal: AbortSignal.timeout(30 * 60_000)});
          if (!response.ok || !response.body) throw new Error(`ダウンロード失敗: HTTP ${response.status}`);
          const counter = new Transform({transform(chunk, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); }});
          await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, fs.createWriteStream(temp, {flags: 'wx'}));
          if (item.size !== undefined && item.size !== bytes) throw new Error('Storage メタデータとのバイト数が一致しません');
          const digest = hash.digest('hex');
          if (await checksum(temp) !== digest) throw new Error('ダウンロードファイルの SHA-256 が一致しません');
          fs.linkSync(temp, file);
          record = {id: item.id, version: item.version, file, bytes, sha256: digest};
        } finally { fs.rmSync(temp, {force: true}); }
        manifest.entries[identity] = record;
        writeJsonAtomic(manifestFile, manifest);
        result.downloaded++;
      }
      const matchingAssets = item.asset ? [item.asset] : assets.filter((asset) => {
        const url = new URL(asset.url);
        const match = /^\/storage\/v1\/object\/(?:public|authenticated|sign)\/([^/]+)\/(.+)$/.exec(url.pathname);
        return url.origin === base!.origin && match && decodeURIComponent(match[1]) === item.bucket && decodeURIComponent(match[2]) === item.key;
      });
      // p/<slug>/<mode>/<kind>/<rel> の従来キーも推定できる。それ以外は manifest にだけ残す。
      const inferred = /^p\/([^/]+)\/(full|light)\/([^/]+)\/(.+)$/.exec(item.key ?? '');
      if (inferred && isAssetMode(inferred[2]) && isAssetKind(inferred[3])) {
        index[`${inferred[1]}/${inferred[2]}/${inferred[3]}/${inferred[4]}`] = record.file;
        restoreProjectAsset({slug: inferred[1], mode: inferred[2], kind: inferred[3], rel_path: inferred[4], url: record.file}, record.file);
      }
      for (const asset of matchingAssets) {
        restoreProjectAsset(asset, record.file);
        index[`${asset.slug}/${asset.mode}/${asset.kind}/${asset.rel_path}`] = record.file;
        updates.push({asset, file: record.file});
      }
      writeJsonAtomic(indexFile, index);
    }
    if (opt.updateDb && sql) {
      await sql.begin(async (transaction) => {
        for (const {asset, file} of updates) {
          const rows = await transaction`update assets set url = ${file}, updated_at = now() where slug = ${asset.slug} and kind = ${asset.kind} and mode = ${asset.mode} and rel_path = ${asset.rel_path} and url = ${asset.url} returning slug`;
          if (rows.length !== 1) throw new Error('移行中に assets が変更されました。DB の更新を取り消しました');
          result.updated++;
        }
      });
    }
    log(`計画 ${result.planned} / 保存 ${result.downloaded} / 再利用 ${result.reused} / DB更新 ${result.updated}。Storage の削除は行っていません。`);
    return result;
  } finally {
    if (sql) await sql.end();
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.rmSync(lock, {force: true}); }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (args.includes('--help')) {
    console.log('npm run media:migrate -- [--source supabase|assets] [--bucket NAME] [--root PATH] [--apply] [--update-db]\n既定は一覧確認のみ。SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY、assets/DB更新には DATABASE_URL が必要。削除機能はありません。');
  } else {
    const source = value('--source') ?? 'supabase';
    if (source !== 'supabase' && source !== 'assets') throw new Error('--source は supabase または assets');
    migrateMedia({source, apply: args.includes('--apply'), updateDb: args.includes('--update-db'), bucket: value('--bucket'), root: value('--root') ?? localMediaRoot(), supabaseUrl: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL}).catch((error) => {
      // 接続URL・鍵・署名URLをエラーへ出さない。
      console.error(`移行に失敗: ${String(error.message).replace(/https?:\/\/\S+|postgres(?:ql)?:\/\/\S+/g, '[URL]')}`);
      process.exitCode = 1;
    });
  }
}
