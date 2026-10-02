// 参考動画（他の人のバズったリール）を取り込んで型を分析し、その型を写した台本を作る。
//
//   importReferenceVideo … 動画を <案件>/.studio/reference/ に取り込む（reference.json は source だけ）
//   analyzeReference     … ffmpeg でシーン検出・コンタクトシート・カット頭のコマ・無音検出を作り、
//                          裏で claude を走らせて型を言語化する → reference.json
//   aiMimic              … 型を写した台本（script.md）を書き、そのまま「台本から組み立てる」（aiScript）まで行う
//
// 判断（検算・台本の書き出し・返答のまとめ）は shared/reference.ts の純粋な関数。ここはファイルと外部プロセス。
// **参考動画の映像・音声・文言は動画に使わない。** 分析のためだけに .studio/ に置き、クラウドにはコマだけ上がる。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {studioConfig} from '../studio.config';
import {settingsDir} from './settings';
import {execOk} from './exec';
import {effectiveSize, ffprobe} from './ffprobe';
import {detectScenes} from './scene';
import {detectSpeech} from './silence';
import {loadCatalog, studioDir, VIDEO_EXT} from './catalog';
import {backupsDir, readBrief} from './project';
import {readJsonLoose, writeJsonAtomic, backupFile} from './json-io';
import {runAgent, type AgentRun} from './agent';
import {instagramMcpEnv} from './instagram-mcp';
import {fetchInstagramVideoInfo, parseInstagramPostUrl} from '../shared/instagram-mcp';
import {agentProgress} from './ai';
import {aiScript, readScript, scriptPath, writeScript, type AiScriptResult} from './script';
import {getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {DOC_FILES} from '../shared/project';
import {AngleSchema, ClipKindSchema} from '../shared/schema/catalog';
import {SlotRoleSchema, ThemeSchema} from '../shared/schema/cuts';
import {listProjects} from './project';
import {
  AnalysisResponseSchema,
  checkMimicPlan,
  cutBoundaries,
  describeReference,
  emptyReference,
  fitMimicToReference,
  fmtSec,
  FRAME_W,
  isReferenceAnalyzed,
  isReferenceKey,
  mergeAnalysis,
  autoReferenceTitle,
  normalizeReferenceTitle,
  referenceKeyFromFilename,
  referenceKeyOfHash,
  referenceKeyOfInstagram,
  type LibraryIndexEntry,
  MimicPlanSchema,
  REFERENCE_MAX_SEC,
  ReferenceSchema,
  renderMimicScript,
  segmentLine,
  SHEET_COLS,
  SHEET_FPS,
  SHEET_ROWS,
  SHEET_TILE_W,
  sheetSpan,
  sheetTileOf,
  tempoStats,
  type MimicIssue,
  type MimicPlan,
  type PreparedReference,
  type Reference,
  type TimeRange,
} from '../shared/reference';

const enumOf = (v: readonly string[]) => ({type: 'string', enum: [...v]});
const rel = (dir: string, abs: string) => path.relative(dir, abs).replace(/\\/g, '/');

// ───────────────────────── 置き場 ─────────────────────────

export const referencePath = (dir: string): string => path.join(dir, DOC_FILES.reference);
/** 動画・コマ・コンタクトシートの置き場（.studio/reference/） */
export const referenceStudioDir = (dir: string): string => path.join(studioDir(dir), 'reference');
/** 取り込み途中のファイルの置き場（ブラウザからの受け口が書く） */
export const referenceInboxDir = (dir: string): string => path.join(studioDir(dir), 'reference-inbox');

/** reference.json。無い・壊れている・墓標（source: null）は null */
export const readReference = (dir: string): Reference | null => {
  const p = referencePath(dir);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = readJsonLoose(p);
  } catch {
    return null;
  }
  const r = ReferenceSchema.safeParse(raw);
  return r.success && r.data.source ? r.data : null;
};

export const writeReference = (dir: string, ref: Reference): Reference => {
  const data = ReferenceSchema.parse(ref);
  writeJsonAtomic(referencePath(dir), data, {backupDir: backupsDir(dir)});
  return data;
};

/** 案件（またはライブラリの 1 本）の中にある参考動画の実体（絶対パス）。無ければ null */
const referenceVideoPathLocal = (dir: string, ref: Reference): string | null => {
  if (!ref.source) return null;
  const abs = path.join(studioDir(dir), ref.source.file);
  return fs.existsSync(abs) ? abs : null;
};

/**
 * 参考動画の実体（絶対パス）。案件に無ければライブラリ（同じ鍵の 1 本）を見る
 * ——ライブラリから分析を写した案件には動画を置かないので、「分析をやり直す」はライブラリの動画で行う
 */
export const referenceVideoPath = (dir: string, ref: Reference): string | null => {
  const local = referenceVideoPathLocal(dir, ref);
  if (local) return local;
  const key = ref.source?.key;
  if (!isReferenceKey(key)) return null;
  const entry = findLibraryEntry(key);
  return entry?.videoPath ?? null;
};

// ───────────────────────── ライブラリ（同じ動画の分析を案件をまたいで使い回す） ─────────────────────────
//
// 同じ参考動画を別の案件で使うとき、分析（ffmpeg + claude で数分・課金あり）をやり直さない。
// <設定の置き場>/reference-library/<鍵>/ に案件と同じ形（reference.json と .studio/reference/）で 1 本ずつ置き、
// 取り込みのときに鍵（Instagram の投稿コード、またはファイルの sha256）で引く。
// 人格づくり（core/persona-study.ts）も同じ置き場を使うので、人格のために分析したリールは案件でも、その逆も使い回せる。

export const referenceLibraryDir = (): string => path.join(settingsDir(), 'reference-library');
/** ライブラリの 1 本のフォルダ（案件と同じ形。analyzeReference がそのまま使える） */
export const libraryEntryDir = (key: string): string => path.join(referenceLibraryDir(), key.replace(/[^A-Za-z0-9_.-]/g, '_'));

/** ファイルの内容の sha256（16 進）。大きな動画でも読み切るだけ */
export const hashFileSha256 = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

export type LibraryEntry = {key: string; dir: string; ref: Reference | null; analyzed: boolean; videoPath: string | null};

/** 鍵でライブラリを引く。フォルダが無ければ null（あっても分析前なら analyzed=false） */
export const findLibraryEntry = (key: string): LibraryEntry | null => {
  if (!isReferenceKey(key)) return null;
  const dir = libraryEntryDir(key);
  if (!fs.existsSync(dir)) return null;
  const ref = readReference(dir);
  return {key, dir, ref, analyzed: isReferenceAnalyzed(ref), videoPath: ref ? referenceVideoPathLocal(dir, ref) : null};
};

/** ライブラリにある分析済みの一覧（新しい順）。画面の「ライブラリから使う」用 */
export const listLibraryEntries = (): LibraryEntry[] => {
  const root = referenceLibraryDir();
  if (!fs.existsSync(root)) return [];
  const out: LibraryEntry[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!isReferenceKey(name)) continue;
    const e = findLibraryEntry(name);
    if (e?.analyzed) out.push(e);
  }
  return out.sort((a, b) => ((a.ref?.analyzedAt ?? '') < (b.ref?.analyzedAt ?? '') ? 1 : -1));
};

/** 動画の内容（sha256）で引く。投稿コードが分からない形（手で落としたファイル）で取り込まれた同じ動画を結び付ける */
export const findLibraryEntryBySha = (sha: string | undefined): LibraryEntry | null => {
  if (!sha) return null;
  const root = referenceLibraryDir();
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root)) {
    if (!isReferenceKey(name)) continue;
    const e = findLibraryEntry(name);
    if (e?.ref?.source?.sha === sha) return e;
  }
  return null;
};

/**
 * ライブラリの一覧（画面・クラウド用の軽い形）。どの案件が使っているかは、各案件の reference.json の鍵を見て数える
 * （案件側は分析を写してあるので、鍵が同じ＝同じ動画の分析）
 */
export const libraryIndex = (): LibraryIndexEntry[] => {
  const entries = listLibraryEntries();
  if (!entries.length) return [];
  const usedBy = new Map<string, string[]>();
  for (const p of listProjects()) {
    const key = readReference(p.dir)?.source?.key;
    if (!isReferenceKey(key)) continue;
    usedBy.set(key, [...(usedBy.get(key) ?? []), p.slug]);
  }
  return entries.map((e) => {
    const r = e.ref!;
    return {
      key: e.key,
      title: r.title,
      originalName: r.source?.originalName ?? '',
      ...(r.source?.sourceUrl ? {sourceUrl: r.source.sourceUrl} : {}),
      ...(r.analyzedAt ? {analyzedAt: r.analyzedAt} : {}),
      durationSec: r.source?.durationSec ?? 0,
      segments: r.segments.length,
      cuts: r.cuts.length,
      hookType: r.pattern.hookType,
      summary: r.summary,
      usedBy: usedBy.get(e.key) ?? [],
    };
  });
};

/** ライブラリの 1 本に名前を付ける（空で消す）。その鍵を写している案件の表示名も揃える */
export const setLibraryTitle = (key: string, title: string): LibraryIndexEntry => {
  const e = findLibraryEntry(key);
  if (!e?.ref) throw new Error(`ライブラリにありません: ${key}`);
  const t = title.trim().slice(0, 60);
  writeReference(e.dir, {...e.ref, title: t});
  for (const p of listProjects()) {
    const r = readReference(p.dir);
    if (r?.source?.key === key && r.title !== t) writeReference(p.dir, {...r, title: t});
  }
  const row = libraryIndex().find((x) => x.key === key);
  if (!row) throw new Error(`ライブラリにありません: ${key}`);
  return row;
};

/**
 * 案件の分析をライブラリに登録する（鍵の無い古い取り込み用）。
 * 鍵は 既存の鍵 → ファイル名の投稿コード（instagram-<code>.mp4 等）→ 動画の sha256 の順に決め、
 * 同じ鍵か同じ内容の 1 本が既にあればそれに結び付ける（案件の鍵をそちらに合わせ、分析は案件の方が新しければ入れ替えない＝既存を正とする）。
 * 無ければ案件の分析をそのまま入れる。title を渡せば名前も付ける
 */
export const registerReferenceToLibrary = async (projectDir: string, opt: {title?: string} = {}): Promise<LibraryIndexEntry> => {
  const ref = readReference(projectDir);
  if (!ref?.source || !isReferenceAnalyzed(ref)) throw new Error('分析済みの参考動画がありません（先に「型を分析する」を実行してください）');
  const video = referenceVideoPathLocal(projectDir, ref);
  const sha = ref.source.sha ?? (video ? await hashFileSha256(video) : undefined);
  let key = isReferenceKey(ref.source.key) ? ref.source.key : (referenceKeyFromFilename(ref.source.originalName) ?? (sha ? referenceKeyOfHash(sha) : null));
  if (!key) throw new Error('鍵を決められません（動画の実体が無く、ファイル名にも投稿コードがありません）');
  const existing = findLibraryEntry(key) ?? findLibraryEntryBySha(sha);
  if (existing?.analyzed && existing.ref) {
    key = existing.key;
    // 案件側の鍵をライブラリに合わせる（分析はそのまま。名前はライブラリのもの）
    writeReference(projectDir, {...ref, title: opt.title?.trim() || existing.ref.title || ref.title, source: {...ref.source, key, ...(sha ? {sha} : {})}});
  } else {
    // 新しく入れるときは、名前が無ければ分析から組み立てる（一覧で見分けられるように）
    const withKey: Reference = {...ref, title: normalizeReferenceTitle(ref.title) || autoReferenceTitle(ref), source: {...ref.source, key, ...(sha ? {sha} : {})}};
    writeReference(projectDir, withKey);
    storeToLibrary(projectDir, withKey);
  }
  return setLibraryTitle(key, opt.title?.trim() || findLibraryEntry(key)?.ref?.title || '');
};

/**
 * 案件の分析をライブラリに写す（動画・コマ・シート・reference.json）。同じ鍵があれば上書き（分析し直したものが新しい正）。
 * 案件に動画が無い（ライブラリから写した案件で分析し直した）ときは、ライブラリの動画を残す
 */
export const storeToLibrary = (projectDir: string, ref: Reference): LibraryEntry | null => {
  const key = ref.source?.key;
  if (!ref.source || !isReferenceKey(key)) return null;
  const dir = libraryEntryDir(key);
  if (path.resolve(dir) === path.resolve(projectDir)) {
    // 人格づくりはライブラリの中で直接分析する。自分自身への複製は要らない
    return findLibraryEntry(key);
  }
  const src = referenceStudioDir(projectDir);
  const dst = referenceStudioDir(dir);
  fs.mkdirSync(dst, {recursive: true});
  for (const sub of ['frames', 'sheets']) fs.rmSync(path.join(dst, sub), {recursive: true, force: true});
  if (fs.existsSync(src)) fs.cpSync(src, dst, {recursive: true, force: true});
  const prev = readReference(dir);
  // 人格づくりの記録（study.json）はそのまま。reusedAt は「この案件がライブラリから写した」印なので、ライブラリ側には持たせない。
  // 名前（title）と元の投稿 URL は、新しい方に無ければライブラリのものを残す
  const {reusedAt: _r, ...clean} = ref;
  void _r;
  writeReference(dir, {
    ...clean,
    title: ref.title.trim() || prev?.title || '',
    source: {...ref.source, ...(prev?.source?.sourceUrl && !ref.source.sourceUrl ? {sourceUrl: prev.source.sourceUrl} : {}), ...(prev?.source?.sha && !ref.source.sha ? {sha: prev.source.sha} : {})},
  });
  return findLibraryEntry(key);
};

/**
 * ライブラリの分析を案件に写す（コマ・シート・reference.json）。**動画は写さない**（容量のため。再分析はライブラリの動画で行う）。
 * 案件の前の取り込みは捨てる
 */
export const reuseFromLibrary = (projectDir: string, entry: LibraryEntry, opt: {originalName?: string; sourceUrl?: string} = {}): Reference => {
  if (!entry.ref?.source || !entry.analyzed) throw new Error(`ライブラリに分析済みの動画がありません: ${entry.key}`);
  const rdir = referenceStudioDir(projectDir);
  fs.rmSync(rdir, {recursive: true, force: true});
  fs.mkdirSync(rdir, {recursive: true});
  for (const sub of ['frames', 'sheets']) {
    const s = path.join(referenceStudioDir(entry.dir), sub);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(rdir, sub), {recursive: true});
  }
  const source = {...entry.ref.source, originalName: opt.originalName ?? entry.ref.source.originalName, ...(opt.sourceUrl ? {sourceUrl: opt.sourceUrl} : {})};
  return writeReference(projectDir, {...entry.ref, source, reusedAt: new Date().toISOString()});
};

/**
 * 取り込みを取り消す。ファイルを消すのではなく **墓標（source: null）を書く**。
 * クラウドとの同期は「ファイルが無い」を伝えられない（無い＝送らない）ので、消したことも 1 つの版として送る。
 */
export const deleteReference = (dir: string): void => {
  fs.rmSync(referenceStudioDir(dir), {recursive: true, force: true});
  writeReference(dir, emptyReference());
};

// ───────────────────────── 取り込み ─────────────────────────

export type ImportOptions = {
  /** 表示に使う元の名前（アップロードなら送られてきた名前） */
  originalName?: string;
  /** コピーではなく移動する（受け口が書いた一時ファイル用） */
  move?: boolean;
  /** 元の投稿の URL（Instagram から取り込んだとき） */
  sourceUrl?: string;
  /** 同じ動画を見分ける鍵。Instagram なら ig_<投稿コード>。無ければファイルの内容から作る */
  key?: string;
  /** ライブラリに同じ動画の分析があっても使わず、取り込み直す */
  noReuse?: boolean;
  onLine?: (l: string) => void;
};

const moveOrCopy = (src: string, dst: string, move: boolean) => {
  if (!move) return fs.copyFileSync(src, dst);
  try {
    fs.renameSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst); // 別ボリュームなら実体コピー
    fs.rmSync(src, {force: true});
  }
};

/**
 * 参考動画を案件に取り込む。前の分析（コマ・シート・reference.json の中身）は捨てる。
 * 長すぎるもの・動画でないものは断る（ショート動画の型を見るための機能なので）。
 */
export const importReferenceVideo = async (dir: string, srcPath: string, opt: ImportOptions = {}): Promise<Reference> => {
  const shownName = opt.originalName ?? path.basename(srcPath);
  const ext = path.extname(srcPath).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    if (opt.move) fs.rmSync(srcPath, {force: true}); // 受け口が書いた一時ファイルを残さない
    throw new Error(`動画ファイルではありません: ${shownName}（${[...VIDEO_EXT].join(' / ')}）`);
  }
  if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) throw new Error(`ファイルが見つかりません: ${srcPath}`);
  // 同じ動画の分析がライブラリにあれば、取り込み直さずにそれを写す（分析は数分・課金あり）。
  // 鍵は 指定（Instagram の投稿コード）→ ファイル名の投稿コード（instagram-<code>.mp4 等）→ 内容の sha256 の順。内容でも引く
  const sha = await hashFileSha256(srcPath);
  const key = isReferenceKey(opt.key) ? opt.key : (referenceKeyFromFilename(shownName) ?? referenceKeyOfHash(sha));
  const entry = opt.noReuse ? null : (findLibraryEntry(key) ?? findLibraryEntryBySha(sha));
  if (entry?.analyzed) {
    if (opt.move) fs.rmSync(srcPath, {force: true});
    opt.onLine?.(`同じ動画の分析がライブラリにあるので再利用します（${entry.ref?.title ? `「${entry.ref.title}」・` : ''}${entry.ref?.analyzedAt?.slice(0, 10) ?? ''} 分析・${entry.ref?.segments.length ?? 0} 区間）`);
    return reuseFromLibrary(dir, entry, {originalName: shownName, sourceUrl: opt.sourceUrl});
  }
  const probe = await ffprobe(srcPath);
  if (!(probe.durationSec > 0.5)) throw new Error('動画の長さが取れません（壊れているか、対応していない形式です）');
  if (probe.durationSec > REFERENCE_MAX_SEC)
    throw new Error(`参考動画が長すぎます（${fmtSec(probe.durationSec)} 秒。上限 ${REFERENCE_MAX_SEC} 秒）。ショート動画の型を見る機能なので、見たい部分だけに切ってから取り込んでください`);
  const rdir = referenceStudioDir(dir);
  fs.rmSync(rdir, {recursive: true, force: true});
  fs.mkdirSync(rdir, {recursive: true});
  const dest = path.join(rdir, `source${ext}`);
  moveOrCopy(srcPath, dest, !!opt.move);
  const {width, height} = effectiveSize(probe);
  return writeReference(dir, {
    ...emptyReference(),
    source: {
      file: rel(studioDir(dir), dest),
      originalName: opt.originalName ?? path.basename(srcPath),
      ...(opt.sourceUrl ? {sourceUrl: opt.sourceUrl} : {}),
      key,
      sha,
      durationSec: probe.durationSec,
      fps: probe.fps,
      width,
      height,
      hasAudio: probe.hasAudio,
      importedAt: new Date().toISOString(),
    },
  });
};

/** URL（クラウドの Blob）から一時ファイルに落とす。スマホから上げた参考動画を PC が受け取るとき用 */
export const fetchReferenceToInbox = async (dir: string, url: string, name: string, signal?: AbortSignal): Promise<string> => {
  const inbox = referenceInboxDir(dir);
  fs.mkdirSync(inbox, {recursive: true});
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim() || 'reference.mp4';
  const dest = path.join(inbox, `${Date.now()}_${safe}`);
  const res = await fetch(url, {signal});
  if (!res.ok || !res.body) throw new Error(`参考動画を取り込めません（HTTP ${res.status}）: ${name}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
};

/**
 * Instagram のリール・投稿の URL から参考動画を取り込む。Smartgram MCP の download_reel_video で
 * 動画の直リンクを取り（HikerAPI 1 トークン）、受け口に落としてから importReferenceVideo に渡す。
 * 鍵は PC の設定（~/.reel-studio/settings.json か SMARTGRAM_MCP_KEY）にあるので、PC 側でだけ動く
 */
export const importReferenceFromInstagram = async (dir: string, url: string, opt: {signal?: AbortSignal; onLine?: (l: string) => void; noReuse?: boolean} = {}): Promise<Reference> => {
  const post = parseInstagramPostUrl(url);
  if (!post) throw new Error(`Instagram の投稿・リールの URL として読めません: ${url.slice(0, 200)}（例: https://www.instagram.com/reel/XXXXXXXXX/）`);
  const key = referenceKeyOfInstagram(post.code);
  // 同じ投稿がライブラリにあれば、ダウンロード（HikerAPI 1 トークン）も分析もやり直さない
  const entry = opt.noReuse ? null : findLibraryEntry(key);
  if (entry?.analyzed) {
    opt.onLine?.(`同じ投稿（${post.code}）の分析がライブラリにあるので再利用します（ダウンロードもしません）`);
    return reuseFromLibrary(dir, entry, {sourceUrl: post.url});
  }
  if (entry?.videoPath) {
    // 落としてあるが分析前（人格づくりの途中など）。ダウンロードだけ省く
    opt.onLine?.(`同じ投稿（${post.code}）の動画がライブラリにあるので、それを取り込みます`);
    return importReferenceVideo(dir, entry.videoPath, {originalName: entry.ref?.source?.originalName || `instagram_${post.code}.mp4`, sourceUrl: post.url, key, noReuse: true, onLine: opt.onLine});
  }
  const env = instagramMcpEnv();
  if (!env) throw new Error('Instagram の URL から取り込むには、Settings の「Instagram の情報取得」に Smartgram の MCP 用 API キーが要ります');
  opt.onLine?.(`Instagram から動画の場所を取得中: ${post.url}（Smartgram / HikerAPI 1 トークン）`);
  const info = await fetchInstagramVideoInfo(env, post, {signal: opt.signal});
  const name = `${info.username ? `@${info.username}_` : 'instagram_'}${post.code}.mp4`;
  opt.onLine?.(`動画をダウンロード中: ${name}`);
  const tmp = await fetchReferenceToInbox(dir, info.videoUrl, name, opt.signal);
  return importReferenceVideo(dir, tmp, {originalName: name, move: true, sourceUrl: post.url, key, noReuse: true, onLine: opt.onLine});
};

/** 別の案件の分析（reference.json とコマ）をそのまま持ってくる。同じ型で別の店を作るとき用 */
export const copyReferenceFrom = (dir: string, fromDir: string): Reference => {
  const src = readReference(fromDir);
  if (!src) throw new Error(`元の案件に参考動画の分析がありません: ${path.basename(fromDir)}`);
  if (path.resolve(fromDir) === path.resolve(dir)) throw new Error('同じ案件です');
  const rdir = referenceStudioDir(dir);
  fs.rmSync(rdir, {recursive: true, force: true});
  const srcDir = referenceStudioDir(fromDir);
  if (fs.existsSync(srcDir)) fs.cpSync(srcDir, rdir, {recursive: true});
  return writeReference(dir, src);
};

// ───────────────────────── ffmpeg：分析の材料 ─────────────────────────

const JPEG_ARGS = ['-pix_fmt', 'yuvj420p', '-q:v', '4'];

const grabFrame = async (input: string, out: string, timeSec: number): Promise<boolean> => {
  const args = ['-y', '-nostdin', '-v', 'error'];
  if (timeSec > 0) args.push('-ss', timeSec.toFixed(3));
  args.push('-i', input, '-frames:v', '1', '-vf', `scale=${FRAME_W}:-2`, ...JPEG_ARGS, out);
  try {
    await execOk('ffmpeg', args, {timeoutMs: 60_000});
  } catch {
    return false;
  }
  return fs.existsSync(out);
};

export type PrepareOptions = {onLine?: (l: string) => void; onProgress?: (done: number, total: number, phase: string) => void; signal?: AbortSignal};

/**
 * 分析に使う材料を作る：シーン検出 → カット頭のコマ → コンタクトシート（0.5 秒ごと）→ 無音検出。
 * 参考動画は 1 本だけなので、素材のカタログ化と違ってプロキシは作らない。
 */
export const prepareReferenceFrames = async (dir: string, ref: Reference, opt: PrepareOptions = {}): Promise<PreparedReference> => {
  const log = opt.onLine ?? (() => {});
  const src = referenceVideoPath(dir, ref);
  if (!src || !ref.source) throw new Error('参考動画の実体がありません（取り込み直してください）');
  const dur = ref.source.durationSec;
  const sdir = studioDir(dir);
  const rdir = referenceStudioDir(dir);

  // 1. シーン検出。粗いカット割りに見えたら（平均 4 秒超）しきい値を下げてもう一度見る
  opt.onProgress?.(0, 4, 'カットの切り替わりを探しています');
  let scenes = await detectScenes(src, 0.25);
  let cuts = cutBoundaries(scenes, dur);
  if (dur >= 8 && tempoStats(cuts).avgSec > 4) {
    const more = await detectScenes(src, 0.12);
    scenes = [...new Set([...scenes, ...more])].sort((a, b) => a - b);
    cuts = cutBoundaries(scenes, dur);
  }
  opt.signal?.throwIfAborted();
  const st = tempoStats(cuts, dur);
  log(`シーン検出: ${cuts.length} カット（平均 ${fmtSec(st.avgSec)} 秒・最短 ${fmtSec(st.minSec)} 秒・最長 ${fmtSec(st.maxSec)} 秒）`);

  // 2. カット頭のコマ（画面の一覧と、AI が個別に確かめたいとき用）
  opt.onProgress?.(1, 4, 'カット頭のコマを切り出しています');
  const framesDir = path.join(rdir, 'frames');
  fs.rmSync(framesDir, {recursive: true, force: true});
  fs.mkdirSync(framesDir, {recursive: true});
  const frames: (string | undefined)[] = [];
  for (let i = 0; i < cuts.length; i++) {
    opt.signal?.throwIfAborted();
    const c = cuts[i];
    const t = c.startSec + Math.min(0.2, (c.endSec - c.startSec) * 0.4);
    const out = path.join(framesDir, `${String(i + 1).padStart(3, '0')}.jpg`);
    frames.push((await grabFrame(src, out, t)) ? rel(sdir, out) : undefined);
  }

  // 3. コンタクトシート（1 秒 2 コマ・3 列 × 4 段）。AI はこれを 1 枚ずつ読んでテロップを書き起こす
  opt.onProgress?.(2, 4, 'コンタクトシートを作っています');
  const sheetsDir = path.join(rdir, 'sheets');
  fs.rmSync(sheetsDir, {recursive: true, force: true});
  fs.mkdirSync(sheetsDir, {recursive: true});
  await execOk('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', src, '-vf', `fps=${SHEET_FPS},scale=${SHEET_TILE_W}:-2,tile=${SHEET_COLS}x${SHEET_ROWS}`, ...JPEG_ARGS, path.join(sheetsDir, '%02d.jpg')], {
    timeoutMs: 10 * 60_000,
    signal: opt.signal,
  });
  const sheets = fs
    .readdirSync(sheetsDir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => rel(sdir, path.join(sheetsDir, f)));
  if (!sheets.length) throw new Error('コンタクトシートを作れませんでした（ffmpeg が動画を読めていません）');
  log(`コンタクトシート ${sheets.length} 枚（1 枚 = ${(SHEET_COLS * SHEET_ROWS) / SHEET_FPS} 秒）`);

  // 4. 声のある区間（無音検出の補集合）。中身は聞けないが「どこで喋っているか」は分かる
  opt.onProgress?.(3, 4, '声のある区間を探しています');
  let speech: TimeRange[] = [];
  if (ref.source.hasAudio) {
    try {
      speech = (await detectSpeech(src, dur)).map((r) => ({startSec: r.startSec, endSec: r.endSec}));
    } catch (e) {
      log(`! 無音検出に失敗（声の区間なしで続行）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  opt.onProgress?.(4, 4, '材料がそろいました');
  return {sceneCuts: scenes, cuts, frames, sheets, speech};
};

// ───────────────────────── 分析（claude） ─────────────────────────

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cuts', 'segments', 'pattern', 'summary', 'mimicRules', 'title'],
  properties: {
    cuts: {
      type: 'array',
      description: '渡したカット一覧の全部について 1 件ずつ（index は変えない）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'telop', 'orientation', 'badge', 'kind', 'angle', 'subject', 'description', 'role'],
        properties: {
          index: {type: 'integer', description: 'カット番号（渡した一覧のもの）'},
          telop: {type: 'string', description: 'そのカットで画面に出ている文言。読めた通りに。無ければ空。読めない文字は書かない'},
          orientation: enumOf(['vertical', 'horizontal', 'none']),
          badge: {type: 'string', description: '中央上部などの短いラベル（エリア名・順位・店名）。無ければ空'},
          kind: enumOf(ClipKindSchema.options),
          angle: enumOf(AngleSchema.options),
          subject: {type: 'string', description: '被写体の短い名前（同じものには同じ語）'},
          description: {type: 'string', description: '何が映っていて、どう動くか 1 行。シーン検出が取りこぼした切り替えがあればそれも'},
          role: enumOf(SlotRoleSchema.options),
        },
      },
    },
    segments: {
      type: 'array',
      description: '役割のまとまり（フック → 証明 → リビール → 本編 → 締め など）。時間順。fromSec/toSec はカットの境界に合わせる',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'fromSec', 'toSec', 'role', 'purpose', 'telopPattern', 'notes'],
        properties: {
          id: {type: 'string', description: '1_hook / 2_proof のような短い id'},
          label: {type: 'string', description: 'フック / 証明 / 店名リビール / 本編 / 締め など'},
          fromSec: {type: 'number'},
          toSec: {type: 'number'},
          role: enumOf(SlotRoleSchema.options),
          purpose: {type: 'string', description: 'この区間が視聴者に何をさせているか（止めさせる・信じさせる・保存させる…）'},
          telopPattern: {type: 'string', description: 'この区間のテロップの型（疑問形 / 数字で言い切る / 体言止め / 煽り / 実用情報 …）'},
          notes: {type: 'string'},
        },
      },
    },
    pattern: {
      type: 'object',
      additionalProperties: false,
      required: ['hookType', 'hookText', 'revealSec', 'revealStyle', 'ctaText', 'ctaStyle', 'telopStyle', 'tempoStyle', 'saveReasons', 'narrationStyle', 'theme'],
      properties: {
        hookType: {type: 'string', description: '疑問形 / 結果先出し / 数字 / 警告・煽り / ギャップ / 断言 など'},
        hookText: {type: 'string', description: '冒頭のテロップそのまま'},
        revealSec: {type: 'number', description: '店名や正体が分かる秒。無ければ -1'},
        revealStyle: {type: 'string', description: 'どう明かしているか（看板 / テロップ / 外観と一緒 …）'},
        ctaText: {type: 'string', description: '締めのテロップそのまま'},
        ctaStyle: {type: 'string', description: '締め方（来店を促す言い切り / 問いかけ / 余韻 …）'},
        telopStyle: {type: 'string', description: '文字数の傾向・語尾・記号・改行・強調・色の癖'},
        tempoStyle: {type: 'string', description: 'カット尺の傾向。どこで速く／遅くするか'},
        saveReasons: {type: 'array', items: {type: 'string'}, description: '保存したくなる実用情報として出しているもの（価格・営業時間・場所・注文方法 …）'},
        narrationStyle: {type: 'string', description: '声がある区間の使い方の推測（テロップの言い換え / 補足 / 語り …）'},
        theme: enumOf(ThemeSchema.options),
      },
    },
    summary: {type: 'string', description: 'この動画が伸びている理由を 1〜3 行'},
    mimicRules: {type: 'array', items: {type: 'string'}, description: '自分の素材で同じ型を作るときに守る規則。8〜15 個。具体的に'},
    title: {type: 'string', description: 'この型を一覧で見分けるための名前。10〜24 文字。店名・地名・料理名・人名は入れず、フックの掛け方・見せ方（リビール・テンポ）・締めが分かるように。例「断言フック→均一0.8秒→キャプション誘導」'},
  },
} as const;

/** ライブラリの名前付け（claude がまとめて付ける）の返り */
const TITLES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titles'],
  properties: {
    titles: {
      type: 'array',
      description: '渡した動画の全部について 1 件ずつ（key は変えない）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title'],
        properties: {
          key: {type: 'string', description: '渡した鍵のまま'},
          title: {type: 'string', description: '10〜24 文字の名前。店名・地名・料理名・人名は入れない。他の動画と同じ名前にしない'},
        },
      },
    },
  },
} as const;

export type NameLibraryOptions = {
  /** 名前があるものも付け直す */
  all?: boolean;
  model?: string;
  onLine?: (l: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

/**
 * ライブラリの動画に、分析の内容から名前を付ける（claude に全部まとめて 1 回で付けさせる。返ってこなければ分析から組み立てる）。
 * 既定では名前の無いものだけ。all で全部付け直す。名前は同じ鍵を写している案件にも揃う（setLibraryTitle）
 */
export async function nameLibraryEntries(opt: NameLibraryOptions = {}): Promise<{named: {key: string; title: string; before: string}[]; costUsd: number}> {
  const log = opt.onLine ?? (() => {});
  const entries = listLibraryEntries().filter((e) => opt.all || !e.ref!.title.trim());
  if (!entries.length) {
    log('名前を付ける動画がありません（全部に名前があります。付け直すなら all）');
    return {named: [], costUsd: 0};
  }
  const model = opt.model ?? studioConfig.agent.model;
  const lines = entries.flatMap((e, i) => [`### ${i + 1}. key: ${e.key}${e.ref!.title ? `（いまの名前「${e.ref!.title}」）` : ''}`, ...describeReference(e.ref!).filter((l) => !l.startsWith('  - ')).map((l) => `- ${l}`), '']);
  const prompt = [
    'グルメのショート動画の「型」の分析に、一覧で見分けるための名前を付けてほしい。',
    '名前は、この型で自分の動画を作るときに「どの型か」が一目で分かるためのもの。**動画の中身（店・料理・地名）ではなく、型（フックの掛け方・見せ方・テンポ・締め）を表す。**',
    '',
    '守ること:',
    '- 10〜24 文字。全角。「→」や「×」で 2〜3 要素をつないでよい（例「断言フック→均一0.8秒→キャプション誘導」「数字で煽る→6秒で看板→行ってみて」）',
    '- 店名・地名・料理名・人名・アカウント名は入れない（フックのテロップにそれらが入っていても、型の言葉に言い換える）',
    '- 同じ名前を 2 つ以上に付けない。似た型は、違いが分かる語（リビールの秒・カット尺・締め方）で区別する',
    '- key は渡したまま返す。全部の動画について 1 件ずつ返す',
    '',
    `## 動画（${entries.length} 本）`,
    ...lines,
  ].join('\n');
  log(`ライブラリの名前付け: ${entries.length} 本（model=${model}）`);
  const {onEvent} = agentProgress({onProgress: opt.onProgress, log, labels: {thinking: '型の違いが分かる名前を考えています', writing: '名前を書き出しています'}});
  const run: AgentRun<{titles?: {key?: string; title?: string}[]}> = await runAgent({cwd: referenceLibraryDir(), prompt, schema: TITLES_SCHEMA, model, timeoutMs: studioConfig.agent.timeoutMs, onLine: log, onEvent, signal: opt.signal});
  const got = new Map<string, string>();
  for (const t of run.data?.titles ?? []) if (typeof t.key === 'string' && typeof t.title === 'string') got.set(t.key, normalizeReferenceTitle(t.title));
  const used = new Set<string>();
  const named: {key: string; title: string; before: string}[] = [];
  for (const e of entries) {
    let title = got.get(e.key) || autoReferenceTitle(e.ref!);
    if (used.has(title)) title = normalizeReferenceTitle(`${title}（${e.ref!.source?.originalName || e.key}）`);
    used.add(title);
    const before = e.ref!.title;
    setLibraryTitle(e.key, title);
    named.push({key: e.key, title, before});
    log(`  ${e.key}: ${before ? `「${before}」→ ` : ''}「${title}」`);
  }
  return {named, costUsd: run.costUsd};
}

export type AnalyzeOptions = {model?: string; onLine?: (l: string) => void; onProgress?: (done: number, total: number, phase: string) => void; signal?: AbortSignal};

/** 参考動画の型を分析して reference.json に書く。動画の中身は使わない（言語化するだけ） */
export async function analyzeReference(dir: string, opt: AnalyzeOptions = {}): Promise<Reference> {
  const log = opt.onLine ?? (() => {});
  const ref = readReference(dir);
  if (!ref?.source) throw new Error('参考動画が取り込まれていません（Brief の「バズ動画の型を写す」で動画を選んでください）');
  const model = opt.model ?? studioConfig.agent.model;
  const prep = await prepareReferenceFrames(dir, ref, opt);
  const dur = ref.source.durationSec;

  const cutLines = prep.cuts.map((c, i) => {
    const t = sheetTileOf(c.startSec);
    return `- カット ${i + 1}: ${c.startSec.toFixed(2)}〜${c.endSec.toFixed(2)}秒（${(c.endSec - c.startSec).toFixed(2)}秒）/ シート ${t.sheet + 1} の ${t.row + 1} 段目 ${t.col + 1} 列目あたり${prep.frames[i] ? ` / 画 ${studioConfig.studioDirName}/${prep.frames[i]}` : ''}`;
  });
  const sheetLines = prep.sheets.map((s, k) => {
    const span = sheetSpan(k);
    return `- ${studioConfig.studioDirName}/${s}（${fmtSec(span.fromSec)}〜${fmtSec(Math.min(dur, span.toSec))} 秒）`;
  });
  const speechLine = ref.source.hasAudio
    ? prep.speech.length
      ? prep.speech.map((r) => `${fmtSec(r.startSec)}〜${fmtSec(r.endSec)}`).join(', ')
      : '（音はあるが発話らしい区間は見つからなかった）'
    : '（音声トラックが無い）';

  const prompt = [
    '他のクリエイターが投稿して伸びたグルメのショート動画（参考動画）を分析してほしい。',
    '目的は、この動画の**型**（構成・テンポ・テロップの書き方・フックの掛け方・店名の明かし方・締め方・保存させる情報の出し方）を言語化して、',
    '**自分の店の素材で同じ型の動画を作る**こと。映像・音声・文言そのものを流用するためではない。',
    '',
    `参考動画: ${fmtSec(dur)} 秒 / ${ref.source.width}x${ref.source.height} / ${ref.source.fps} fps / 音声${ref.source.hasAudio ? 'あり' : 'なし'}`,
    '',
    `## コンタクトシート（0.5 秒ごとのコマを左上から右へ ${SHEET_COLS} 列 × ${SHEET_ROWS} 段。1 枚 = ${(SHEET_COLS * SHEET_ROWS) / SHEET_FPS} 秒）`,
    ...sheetLines,
    '',
    `## シーン検出で見つけたカット（${prep.cuts.length} 個）。各カットの頭のコマも 1 枚ずつある`,
    ...cutLines,
    '',
    `## 声（発話）がある区間（無音検出。中身は聞こえない）: ${speechLine}`,
    '',
    '## やること',
    '1. コンタクトシートを **1 枚ずつ順に Read** して、時間順に何が映っているかと、**画面に焼き込まれている文字（テロップ・ラベル）を読める通りに**書き出す。読めない文字は書かない（推測で補わない）。細かいところはカット頭のコマも Read してよい',
    '2. 上のカット一覧の **全部** について cuts に 1 件ずつ書く（index は変えない・増やさない）。同じ文言が続くカットには同じ telop を書く',
    '3. 区間（segments）に分ける。フック → 証明 → 店名リビール → 本編（保存させる情報・シズル）→ 締め、のような役割のまとまり。fromSec/toSec はカットの境界に合わせ、隙間や重なりを作らない（先頭は 0、末尾は動画の終わり）',
    '4. pattern に型をまとめる。hookText / ctaText はテロップそのまま。revealSec は店名や正体が分かった秒（無ければ -1）',
    '5. summary に、この動画が伸びている理由を 1〜3 行',
    '6. mimicRules に、自分の素材で同じ型を作るときに守る規則を 8〜15 個。「冒頭 1 カット目は料理の寄りを 0.8 秒」「テロップは 10 文字前後の体言止め、句点なし」「店名は 6 秒あたりで外観と一緒に」のように、**秒数・カット数・文字数・画の種類まで具体的に**',
    '7. title に、この型を一覧で見分けるための名前を 10〜24 文字で。店名・地名・料理名・人名は入れず、フックの掛け方・見せ方（リビール・テンポ）・締めが分かるように（例「断言フック→均一0.8秒→キャプション誘導」）',
    '',
    '守ること:',
    '- 見えたものだけを書く。料理名や店名は、画面の文字で読めたときだけ書く（見た目からの推測なら「〜のような料理」と書く）',
    '- role は hook（冒頭の掴み）/ proof（証明）/ tease（焦らし）/ reveal（店名・正体）/ sizzle（食欲の画）/ info（実用情報）/ conversation（会話）/ badgeHead（見出し）/ cta（締め）/ filler（つなぎ）',
    '- kind は素材の種類、angle は wide（引き）/ mid / close（寄り）',
    '- テロップの縦書き・横書き（orientation）は画面の見た目どおり。無ければ none',
  ].join('\n');

  log(`参考動画の分析: ${prep.cuts.length} カット / シート ${prep.sheets.length} 枚（model=${model}）`);
  const {onEvent} = agentProgress({watch: prep.sheets.map((s) => `${studioConfig.studioDirName}/${s}`), onProgress: opt.onProgress, log, labels: {reading: 'シート', thinking: '型を言語化しています', writing: '分析を書き出しています'}});
  const run: AgentRun<unknown> = await runAgent({
    cwd: dir,
    prompt,
    schema: ANALYSIS_SCHEMA,
    model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });
  opt.onProgress?.(prep.sheets.length, prep.sheets.length, 'まとめています');

  const parsed = AnalysisResponseSchema.safeParse(run.data);
  if (!parsed.success) throw new Error(`分析の返答が読めませんでした: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const base = readReference(dir) ?? ref;
  // 古い取り込み（鍵なし）には、ここで鍵を付けてライブラリに入れられるようにする（ファイル名の投稿コード → 内容の sha256）
  let source = base.source!;
  if (!isReferenceKey(source.key)) {
    const video = referenceVideoPathLocal(dir, base);
    const sha = source.sha ?? (video ? await hashFileSha256(video) : undefined);
    const key = referenceKeyFromFilename(source.originalName) ?? (sha ? referenceKeyOfHash(sha) : undefined);
    if (key) source = {...source, key, ...(sha ? {sha} : {})};
  }
  const {reusedAt: _r, ...own} = base;
  void _r;
  const merged = mergeAnalysis({...own, source}, prep, parsed.data, {model, costUsd: run.costUsd, analyzedAt: new Date().toISOString()});
  if (!merged.segments.length) throw new Error('区間が 1 つも返ってきませんでした（もう一度実行してください）');
  writeReference(dir, merged);
  log(`分析完了: ${merged.segments.length} 区間 / ${merged.cuts.length} カット / $${run.costUsd.toFixed(3)}`);
  for (const l of describeReference(merged)) log(`  ${l}`);
  // 同じ動画を別の案件（や人格づくり）で使うときのために、ライブラリにも置く
  try {
    const stored = storeToLibrary(dir, merged);
    if (stored) log(`ライブラリに保存しました（${stored.key}。同じ動画は次から分析を使い回します）`);
  } catch (e) {
    log(`! ライブラリへの保存に失敗（分析結果はこの案件には入っています）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return merged;
}

// ───────────────────────── 型を写す（claude → script.md → aiScript） ─────────────────────────

const MIMIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'notes', 'unmatched'],
  properties: {
    sections: {
      type: 'array',
      description: '参考動画の区間と同じ数・同じ順・同じ秒数',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fromSec', 'toSec', 'label', 'video', 'cutCount', 'cutSec', 'telop', 'badge', 'orientation', 'narration', 'why'],
        properties: {
          fromSec: {type: 'number', description: '参考動画の区間のとおり（変えない）'},
          toSec: {type: 'number', description: '参考動画の区間のとおり（変えない）'},
          label: {type: 'string', description: '区間名（フック / 証明 / 店名リビール / 本編 / 締め …）'},
          video: {type: 'string', description: '映像の指示。参考のショット（寄り／引き・被写体の種類・動き）を写し、手元の素材の id を添える'},
          cutCount: {type: 'integer', description: '参考動画と同じカット数'},
          cutSec: {type: 'string', description: '1 カットの尺の目安（例 0.8〜1.2）。参考のカット尺に合わせる'},
          telop: {type: 'string', description: 'この区間のテロップ。参考の型（文の形・文字数・語尾・記号）を写し、中身はこの店の事実に置き換える。出さない区間は空'},
          badge: {type: 'string', description: '中央上部のラベル（エリア名など）。無ければ空'},
          orientation: enumOf(['vertical', 'horizontal']),
          narration: {type: 'string', description: 'この区間のナレーション 1〜2 文（改行なし）。参考で声が無い区間は空'},
          why: {type: 'string', description: '参考のどの要素を写したか 1 行'},
        },
      },
    },
    notes: {type: 'string', description: '全体の意図を 1〜3 行'},
    unmatched: {type: 'array', items: {type: 'string'}, description: '参考にはあるが手元の素材に無い画（撮り足しの候補）'},
  },
} as const;

export type MimicOptions = {
  model?: string;
  /** script.md を書いたあと、そのまま「台本から組み立てる」まで行う（既定 true） */
  assemble?: boolean;
  /** 組み立ての結果を cuts.json / narration.json に書く（既定 true。false は「割り当てを見るだけ」） */
  write?: boolean;
  /** 組み立ての W を無視して書く */
  force?: boolean;
  onLine?: (l: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type AiMimicResult = {
  plan: MimicPlan;
  issues: MimicIssue[];
  script: string;
  scriptFile: string;
  costUsd: number;
  /** 組み立て（aiScript）の結果。assemble=false なら undefined */
  assembled?: AiScriptResult;
};

/**
 * 分析した型を写した台本を書く。区間・秒数・カット数・テロップの型は参考動画のまま、
 * 中身（店・料理・数字・地名）はこの案件のものにする。E があれば script.md を書かない。
 */
export async function aiMimic(dir: string, opt: MimicOptions = {}): Promise<AiMimicResult> {
  const log = opt.onLine ?? (() => {});
  const ref = readReference(dir);
  if (!ref || !isReferenceAnalyzed(ref)) throw new Error('参考動画の分析がありません（先に「型を分析する」を実行してください）');
  const catalog = loadCatalog(dir);
  if (!catalog) throw new Error('catalog.json が無い（先に素材のカタログ化）');
  const brief = readBrief(dir);
  if (!brief) throw new Error('brief.json が無い（Brief で店名・人格を保存してください）');
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const model = opt.model ?? studioConfig.agent.model;

  const usable = catalog.clips.filter((c) => !c.user.ng);
  if (!usable.length) throw new Error('使える素材がありません（全部 NG になっています）');
  const untagged = usable.filter((c) => !c.tags).length;
  if (untagged) log(`! タグの無い素材が ${untagged} 本あります。先に「AI にタグ付けしてもらう」と当たりが良くなります`);

  const clipLines = usable.map((c) => {
    const t = c.tags;
    const ranges = (c.usableRanges ?? []).filter((r) => r.outSec > r.inSec).map((r) => `${r.inSec.toFixed(1)}〜${r.outSec.toFixed(1)}`);
    return [`- id ${c.id} / ${c.probe.durationSec.toFixed(2)}秒`, t ? `${t.kind}・${t.angle}・シズル${t.sizzleScore}` : 'タグなし', t?.subject ? `被写体:${t.subject}` : '', ranges.length ? `使える区間 ${ranges.join(' , ')}` : '', t?.description ? `／ ${t.description}` : '']
      .filter(Boolean)
      .join(' / ');
  });
  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];
  const p = ref.pattern;
  const segLines = ref.segments.map((s, i) => `- [${i + 1}] ${segmentLine(ref, s)}`);

  const prompt = [
    '参考動画（他の人が投稿して伸びたグルメのショート動画）の型を写して、この案件（自分の店）の台本を書いてほしい。',
    '**構成・テンポ・テロップの型・フックの掛け方・店名の明かし方・締め方は参考動画と同じにし、中身（店・料理・数字・地名・体験）はこの案件のものに置き換える。**',
    '参考動画の映像・音声・文言そのものは使わない（店名・料理名・地名・数字が残っていたら流用になる）。',
    '',
    '## 参考動画の型',
    ref.summary ? `要約: ${ref.summary}` : '',
    `フック: ${p.hookType || '-'}${p.hookText ? `「${p.hookText}」` : ''}`,
    `リビール: ${p.revealSec === null ? '無し' : `${fmtSec(p.revealSec)} 秒`}${p.revealStyle ? `（${p.revealStyle}）` : ''}`,
    `締め: ${p.ctaText ? `「${p.ctaText}」` : '-'}${p.ctaStyle ? `（${p.ctaStyle}）` : ''}`,
    p.telopStyle ? `テロップの癖: ${p.telopStyle}` : '',
    p.tempoStyle ? `テンポ: ${p.tempoStyle}` : '',
    p.saveReasons.length ? `保存させている情報: ${p.saveReasons.join('・')}` : '',
    p.narrationStyle ? `声の使い方: ${p.narrationStyle}` : '',
    '',
    `区間（**この順・この秒数・このカット数で作る。fromSec/toSec は変えない**。${ref.segments.length} 区間）:`,
    ...segLines,
    '',
    ref.mimicRules.length ? `写すときの規則:\n${ref.mimicRules.map((r) => `- ${r}`).join('\n')}` : '',
    '',
    '## この案件',
    `店: ${brief.shop.name}（${brief.shop.area}${brief.shop.station ? `・${brief.shop.station}` : ''}・${brief.shop.genre}）${brief.shop.pr ? '／PR 案件' : ''}`,
    brief.core ? `企画の核: ${brief.core}` : '',
    `人格: ${persona.label}／文体: ${persona.tone || '-'}／締めの語族: ${persona.cta.join('／')}／実測話速 ${persona.narration.charsPerSecMeasured} 文字/秒`,
    ...persona.narrationRules.map((r) => `ナレーションの禁則: ${r}`),
    persona.hookStyle === 'areaDigit' ? `フックの型: 「エリア＋一桁数字」。**エリア名（${brief.shop.area || 'エリア名'}）は本文に入れず badge に出す**。本文はエリア名が無くても通る言い回しに` : '',
    facts.length ? `裏取り済みの事実（ここに無いことは書かない。料理名・数字を推測で作らない）:\n${facts.map((f) => `- ${f}`).join('\n')}` : '裏取り済みの事実は登録されていない。映像から確実に言えることだけ書く（料理名・数字を推測で作らない）',
    '',
    '## 使える素材（AI が映像を見て書いた説明つき）',
    ...clipLines,
    '',
    '## 書くもの（区間ごとに 1 件。参考の区間と同じ数・順・秒数）',
    '- label: 区間名（参考のものをそのまま使ってよい）',
    '- video: 映像の指示。参考のショット（寄り／引き・被写体の種類・動き）を写し、**手元の素材にあるもの**を id を添えて指す。無い画は近いもので代え、unmatched にも書く',
    '- cutCount / cutSec: 参考と同じカット数と 1 カット尺',
    `- telop: 参考の「テロップの型」と文字数・語尾・記号の癖を写し、中身はこの店の事実に置き換える。${spec.telop.maxChars} 文字以内・文末に句点なし・半角括弧と絵文字なし・金額なし・保存やいいねを促さない。三点リーダーは全角 3 文字の「・・・」で書く（「…」は使わない）。参考の店名・料理名・地名・数字を残さない`,
    `- badge: エリア名など。参考がバッジを使っていれば同じ位置で使う`,
    '- orientation: 参考が横書きなら horizontal、それ以外は vertical',
    '- narration: 参考で声がある区間だけ、人格の文体でその区間のテロップを言い換えて 1〜2 文（改行なし・固有名詞と数字の単位はひらがなに開く）。声が無い区間は空',
    `- 締めの区間の telop は ${persona.cta.join('／')} 系で言い切る`,
    '- why: 参考のどの要素を写したか 1 行',
    '',
    'notes に全体の意図を、unmatched に「参考にはあるが手元の素材に無い画」を書く。',
  ]
    .filter(Boolean)
    .join('\n');

  log(`型を写す: ${ref.segments.length} 区間 / 素材 ${usable.length} 本（model=${model}）`);
  const {onEvent} = agentProgress({onProgress: opt.onProgress, log, labels: {thinking: '型に合わせて台本を考えています', writing: '台本を書き出しています'}});
  const run: AgentRun<unknown> = await runAgent({
    cwd: dir,
    prompt,
    schema: MIMIC_SCHEMA,
    model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });
  opt.onProgress?.(0, 0, '検算しています');

  const parsed = MimicPlanSchema.safeParse(run.data);
  if (!parsed.success) throw new Error(`台本の返答が読めませんでした: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const {plan, fitted} = fitMimicToReference(parsed.data, ref);
  if (!fitted) log(`! 区間の数が参考（${ref.segments.length}）と違う（${plan.sections.length}）ので、秒数を参考に合わせられません`);
  const issues = checkMimicPlan(plan, ref, {maxTelopChars: spec.telop.maxChars});
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);
  for (const u of plan.unmatched) log(`  ? 素材が無い: ${u}`);
  if (plan.notes) log(`意図: ${plan.notes}`);
  const errors = issues.filter((i) => i.severity === 'E');
  if (errors.length) throw new Error(`型を写した台本に E が ${errors.length} 件あるので script.md を書いていません:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);

  const script = renderMimicScript(plan, ref, {shopName: brief.shop.name});
  const prev = readScript(dir);
  if (prev?.trim()) backupFile(scriptPath(dir), backupsDir(dir));
  const scriptFile = writeScript(dir, script);
  log(`script.md を書きました（${plan.sections.length} 区間・${plan.sections.reduce((n, s) => n + s.cutCount, 0)} カット・$${run.costUsd.toFixed(3)}）${prev?.trim() ? '。前の台本は .studio/backups/ に残っています' : ''}`);

  let assembled: AiScriptResult | undefined;
  if (opt.assemble !== false) {
    log('続けて「台本から組み立てる」を実行します');
    assembled = await aiScript(dir, {model, write: opt.write !== false, force: opt.force, onLine: log, onProgress: opt.onProgress, signal: opt.signal});
  }
  return {plan, issues, script, scriptFile, costUsd: run.costUsd + (assembled?.costUsd ?? 0), assembled};
}
