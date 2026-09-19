// 顔モザイク：deface（https://github.com/ORB-HD/deface ）の顔検出器で素材の顔を見つけ、
// そのクリップのファイルをモザイク版に差し替える。検出と塗りは scripts/face-mosaic.py（Python）。
//
// - **src のパスは変えずに中身だけ入れ替える。** cuts.json・alias・トライアルの cuts を書き換えずに、
//   プレビュー・レンダー・納品のすべてにモザイクが効く。元のファイルは .studio/mosaic/originals/ に退避し、
//   catalog の mosaic.original に場所を残す（「元に戻す」で戻せる）
// - **入れ替えは上書きではなく rename（新しい実体）で行う。** `reel new --from` の案件は public/ を
//   ハードリンクで共有しているので、同じ実体に書き込むともう片方の案件の素材までモザイクになる
// - **顔が 1 つも無ければファイルは差し替えない**（再エンコードで画質を落とさない）。「顔なし」とだけ記録する
// - 派生物（サムネイル・軽量プレビュー・alias コピー）は作り直す。alias が古いままだと、
//   同じ素材を離れた位置で使ったカットだけ顔が映る
import fs from 'node:fs';
import path from 'node:path';
import {exec, execOk, isWindows} from './exec';
import {ffprobe} from './ffprobe';
import {loadCatalog, mosaicOriginalAbs, saveCatalog, studioDir} from './catalog';
import {makeThumbnails} from './thumbnails';
import {makePreviewProxy} from './proxy';
import {readCuts} from './project';
import {loadSettings, settingsDir} from './settings';
import {studioConfig} from '../studio.config';
import {holdFrames, MosaicReportSchema, resolveMosaicParams, spansText, summarizeMosaicReport, type MosaicInfo, type MosaicParams} from '../shared/mosaic';
import type {Clip} from '../shared/schema/catalog';
import type {MosaicStatus} from '../shared/schema/settings';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Python の標準出力を UTF-8 に固定する（Windows ではパイプが cp932 になり日本語が化ける） */
const PY_ENV = {PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1'};

const GPU_PROVIDERS = ['CUDAExecutionProvider', 'DmlExecutionProvider', 'CoreMLExecutionProvider', 'OpenVINOExecutionProvider'];

export const SETUP_HINT = 'Settings の「顔モザイク（deface）」で「導入する」を押すか、reel mosaic setup を実行してください';

// ───────────────────────── python の在り処 ─────────────────────────

/** `reel mosaic setup` が作る venv（リポジトリの外。~/.reel-studio/deface-venv） */
export const mosaicVenvDir = (): string => path.join(settingsDir(), 'deface-venv');
const venvPython = (dir: string): string => (isWindows ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'));

const findOnPath = (names: string[]): string | null => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};

/** 使う python。REEL_STUDIO_MOSAIC_PYTHON > Settings > 導入した venv > PATH の順 */
export const mosaicPythonInfo = (): {bin: string; source: MosaicStatus['source']} => {
  const env = process.env.REEL_STUDIO_MOSAIC_PYTHON?.trim();
  if (env) return {bin: env, source: 'env'};
  const conf = loadSettings().mosaic.python?.trim();
  if (conf) return {bin: conf, source: 'settings'};
  const venv = venvPython(mosaicVenvDir());
  if (fs.existsSync(venv)) return {bin: venv, source: 'venv'};
  const onPath = findOnPath(isWindows ? ['python.exe'] : ['python3', 'python']);
  if (onPath) return {bin: onPath, source: 'path'};
  return {bin: isWindows ? 'python' : 'python3', source: 'none'};
};

// ───────────────────────── 使えるかの確認 ─────────────────────────

let cachedStatus: MosaicStatus | null = null;

/** 設定を変えた・導入したあとに確かめ直す */
export const resetMosaicStatus = (): void => {
  cachedStatus = null;
};

const tailLines = (s: string, n = 6) =>
  s
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n  ');

/**
 * deface が使えるか（python を起動して import まで確かめる。onnxruntime の読み込みで 1〜3 秒かかるので結果は覚えておく）。
 * python を指定したときは覚えない（Settings の「接続テスト」で入力中の値を試す用）
 */
export const mosaicStatus = async (opt: {refresh?: boolean; python?: string} = {}): Promise<MosaicStatus> => {
  if (cachedStatus && !opt.refresh && !opt.python) return cachedStatus;
  const info = opt.python ? {bin: opt.python, source: 'settings' as const} : mosaicPythonInfo();
  const base = {python: info.bin, source: info.source, venvDir: mosaicVenvDir(), pythonVersion: null, deface: null, onnxruntime: null, providers: [] as string[], gpu: false, checkedAt: new Date().toISOString()};
  let status: MosaicStatus;
  try {
    const r = await exec(info.bin, [studioConfig.faceMosaicScript, '--check'], {env: PY_ENV, timeoutMs: 90_000});
    if (r.code === 3) status = {...base, ok: false, message: `deface が入っていません（${info.bin}）。${SETUP_HINT}`};
    else if (r.code !== 0) status = {...base, ok: false, message: `python で確認できませんでした（${info.bin}・終了コード ${r.code}）\n  ${tailLines(r.stderr || r.stdout)}`};
    else {
      const line = r.stdout.trim().split(/\r?\n/).pop() ?? '{}';
      const j = JSON.parse(line) as {python?: string; deface?: string; onnxruntime?: string | null; providers?: string[]};
      const providers = j.providers ?? [];
      const gpu = providers.some((p) => GPU_PROVIDERS.includes(p));
      status = {
        ...base,
        ok: true,
        pythonVersion: j.python ?? null,
        deface: j.deface ?? null,
        onnxruntime: j.onnxruntime ?? null,
        providers,
        gpu,
        message: !j.onnxruntime
          ? 'onnxruntime が無いので OpenCV で検出します（遅い）。導入し直すと速くなります'
          : gpu
            ? `GPU（${providers.find((p) => GPU_PROVIDERS.includes(p))}）で検出します`
            : `CPU で検出します${isWindows ? '（「GPU 版で導入」で速くなります）' : ''}`,
      };
    }
  } catch (e) {
    status = {...base, ok: false, message: `python を起動できません（${info.bin}）: ${errText(e)}。${SETUP_HINT}`};
  }
  if (!opt.python) cachedStatus = status;
  return status;
};

// ───────────────────────── 導入 ─────────────────────────

/** GPU 版の onnxruntime（同じ onnxruntime モジュールを持つので、どれか 1 つだけ入れる） */
const RUNTIME_PACKAGES = ['onnxruntime', 'onnxruntime-directml', 'onnxruntime-gpu'];
const runtimePackage = (gpu: boolean): string => (!gpu ? 'onnxruntime' : isWindows ? 'onnxruntime-directml' : process.platform === 'linux' ? 'onnxruntime-gpu' : 'onnxruntime');

/** venv を作るための python（3.10 以上）。PATH → Windows の py ランチャーの順 */
const findBasePython = async (explicit?: string): Promise<{cmd: string; args: string[]; version: string}> => {
  const candidates: {cmd: string; args: string[]}[] = [];
  if (explicit) candidates.push({cmd: explicit, args: []});
  for (const n of isWindows ? ['python.exe'] : ['python3', 'python']) {
    const p = findOnPath([n]);
    if (p) candidates.push({cmd: p, args: []});
  }
  if (isWindows) candidates.push({cmd: 'py', args: ['-3']});
  const tried: string[] = [];
  for (const c of candidates) {
    try {
      const r = await exec(c.cmd, [...c.args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {timeoutMs: 30_000});
      const v = r.stdout.trim();
      const [maj, min] = v.split('.').map(Number);
      if (r.code === 0 && (maj > 3 || (maj === 3 && min >= 10))) return {...c, version: v};
      tried.push(`${[c.cmd, ...c.args].join(' ')} → ${r.code === 0 ? `Python ${v}` : `終了コード ${r.code}`}`);
    } catch (e) {
      tried.push(`${[c.cmd, ...c.args].join(' ')} → ${errText(e)}`);
    }
  }
  throw new Error(`Python 3.10 以上が見つかりません。https://www.python.org/ から入れて PATH に通してください${tried.length ? `\n  試したもの:\n  ${tried.join('\n  ')}` : ''}`);
};

export type MosaicSetupOptions = {
  /** GPU 版の onnxruntime を入れる（Windows は DirectML。NVIDIA / AMD / Intel の GPU で動く） */
  gpu?: boolean;
  /** venv を作る python（省略＝PATH から探す） */
  basePython?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
};

/**
 * <設定の置き場>/deface-venv を作り、deface と onnx・onnxruntime を入れる。
 * グローバルの Python には何も入れない（消すときはこのフォルダを消すだけ）
 */
export const setupMosaic = async (opt: MosaicSetupOptions = {}): Promise<{venvDir: string; status: MosaicStatus}> => {
  const log = opt.onLine ?? (() => {});
  const dir = mosaicVenvDir();
  const py = venvPython(dir);
  if (!fs.existsSync(py)) {
    const base = await findBasePython(opt.basePython);
    log(`venv を作ります: ${dir}（${[base.cmd, ...base.args].join(' ')} / Python ${base.version}）`);
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    await execOk(base.cmd, [...base.args, '-m', 'venv', dir], {onLine: log, signal: opt.signal});
  } else log(`既存の venv を使います: ${dir}`);

  const runtime = runtimePackage(!!opt.gpu);
  const others = RUNTIME_PACKAGES.filter((p) => p !== runtime);
  // CPU 版と GPU 版は同じ onnxruntime モジュールを取り合うので、入れ替えるときは先に外す
  await exec(py, ['-m', 'pip', 'uninstall', '-y', ...others], {onLine: (l) => /Successfully uninstalled/.test(l) && log(l), signal: opt.signal});
  log(`pip install deface onnx ${runtime}（初回は 200MB ほどダウンロードします）`);
  await execOk(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'deface', 'onnx', runtime], {onLine: log, signal: opt.signal, timeoutMs: 30 * 60_000});

  resetMosaicStatus();
  const status = await mosaicStatus({refresh: true});
  if (!status.ok) throw new Error(status.message);
  log(`導入できました: deface ${status.deface} / onnxruntime ${status.onnxruntime} / ${status.message}`);
  if (status.source !== 'venv')
    log(`! 導入した venv ではなく ${status.python}（${status.source === 'env' ? '環境変数 REEL_STUDIO_MOSAIC_PYTHON' : status.source === 'settings' ? 'Settings の python' : status.source}）が使われます。使うなら指定を消してください`);
  return {venvDir: dir, status};
};

// ───────────────────────── 1 本ぶんの処理 ─────────────────────────

export type MosaicSourceProbe = {
  width: number;
  height: number;
  /** ffprobe の r_frame_rate そのまま（60000/1001 など。丸めると尺が 1 フレーム単位でずれる） */
  fps: string;
  fpsValue: number;
  frames: number;
  hasAudio: boolean;
  color: {space?: string; primaries?: string; trc?: string; range?: string};
};

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_range?: string;
  tags?: Record<string, string>;
  side_data_list?: {rotation?: number}[];
};

const rateValue = (s: string | undefined): number => {
  const [a, b] = (s ?? '').split('/').map(Number);
  return b ? a / b : a || 0;
};
const known = (v: string | undefined) => (v && v !== 'unknown' && v !== 'reserved' ? v : undefined);

export const probeForMosaic = async (file: string): Promise<MosaicSourceProbe> => {
  const r = await execOk('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const json = JSON.parse(r.stdout) as {streams?: ProbeStream[]; format?: {duration?: string}};
  const v = json.streams?.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error(`映像ストリームが無い: ${file}`);
  const rot = Math.abs(v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(v.tags?.rotate ?? 0)) % 180;
  // ffmpeg は読み込み時に回転を反映するので、渡すのは見た目のサイズ
  const [width, height] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
  const fps = rateValue(v.r_frame_rate) > 0 ? v.r_frame_rate! : v.avg_frame_rate ?? '30';
  const fpsValue = rateValue(fps);
  const duration = Number(v.duration) || Number(json.format?.duration) || 0;
  return {
    width,
    height,
    fps,
    fpsValue,
    frames: Math.max(1, Math.round(duration * fpsValue) || Number(v.nb_frames) || 1),
    hasAudio: !!json.streams?.some((s) => s.codec_type === 'audio'),
    color: {space: known(v.color_space), primaries: known(v.color_primaries), trc: known(v.color_transfer), range: known(v.color_range)},
  };
};

/** scripts/face-mosaic.py の引数（純粋。テストあり） */
export const mosaicScriptArgs = (o: {script: string; input: string; output: string; report: string; probe: MosaicSourceProbe; params: MosaicParams}): string[] => {
  const {probe, params} = o;
  const args = [
    o.script,
    '--input', o.input,
    '--output', o.output,
    '--report', o.report,
    '--width', String(probe.width),
    '--height', String(probe.height),
    '--fps', probe.fps,
    '--frames', String(probe.frames),
    '--threshold', String(params.threshold),
    '--cells', String(params.cells),
    '--mask-scale', String(params.maskScale),
    '--detect-short', String(params.detectShort),
    '--detect-every', String(params.detectEvery),
    '--hold', String(holdFrames(params.holdSec, probe.fpsValue)),
    '--audio', probe.hasAudio ? 'copy' : 'none',
  ];
  if (probe.color.space) args.push('--color-space', probe.color.space);
  if (probe.color.primaries) args.push('--color-primaries', probe.color.primaries);
  if (probe.color.trc) args.push('--color-trc', probe.color.trc);
  if (probe.color.range) args.push('--color-range', probe.color.range);
  return args;
};

const runFaceMosaic = async (python: string, args: string[], opt: {onLine: (l: string) => void; onFrame: (done: number, total: number) => void; signal?: AbortSignal}) => {
  const r = await exec(python, args, {
    env: PY_ENV,
    signal: opt.signal,
    keepChars: 20_000,
    onLine: (line) => {
      const m = /^progress (\d+) (\d+)$/.exec(line.trim());
      if (m) return opt.onFrame(Number(m[1]), Number(m[2]));
      if (/^Running on /.test(line)) return; // deface 自身の出力（info 行と同じ内容）
      opt.onLine(line.replace(/^info /, ''));
    },
  });
  if (opt.signal?.aborted) throw new Error('中断されました');
  if (r.code === 3) throw new Error(`deface が入っていません（${python}）。${SETUP_HINT}`);
  if (r.code !== 0) throw new Error(`顔モザイクの処理が終了コード ${r.code} で失敗\n  ${tailLines(r.stderr || r.stdout)}`);
};

// ───────────────────────── ファイルの入れ替え ─────────────────────────

export const ORIGINALS_SUBDIR = 'mosaic/originals';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Windows ではウイルス対策ソフトが書き出した直後の mp4 を一瞬つかむので、rename を何回かやり直す */
const renameRetry = async (from: string, to: string) => {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code) || attempt >= 5) throw e;
      await sleep(250 * (attempt + 1));
    }
  }
};

const publicAbs = (projectDir: string, src: string) => path.join(projectDir, 'public', src);

/**
 * モザイク版（tmpAbs）を src の位置に入れる。初回は元のファイルを退避する。戻り値は退避先（.studio 相対）。
 * どちらも rename なので、ハードリンクを共有している別の案件の素材は元のまま残る
 */
export const swapInMosaic = async (projectDir: string, clip: Pick<Clip, 'src' | 'mosaic'>, tmpAbs: string): Promise<string> => {
  const dest = publicAbs(projectDir, clip.src);
  const stashed = mosaicOriginalAbs(projectDir, clip);
  if (stashed) {
    // かけ直し：元は退避済み。今のモザイク版を捨てて入れ替える
    if (!fs.existsSync(stashed)) throw new Error(`退避した元のファイルが見つかりません: ${stashed}`);
    fs.rmSync(dest, {force: true});
    await renameRetry(tmpAbs, dest);
    return clip.mosaic!.original!;
  }
  const rel = `${ORIGINALS_SUBDIR}/${path.basename(clip.src)}`;
  const orig = path.join(studioDir(projectDir), rel);
  // 退避先が既にある＝前回が入れ替えの途中で止まった可能性がある。どちらが元か判断できないので止める
  if (fs.existsSync(orig)) throw new Error(`退避先に同じ名前のファイルがあります: ${orig}\n  どちらが元の素材か確かめてから、不要な方を消してください`);
  if (!fs.existsSync(dest)) throw new Error(`素材ファイルが見つかりません: ${dest}`);
  fs.mkdirSync(path.dirname(orig), {recursive: true});
  await renameRetry(dest, orig);
  try {
    await renameRetry(tmpAbs, dest);
  } catch (e) {
    await renameRetry(orig, dest); // 入れられなかったら元の場所に戻す
    throw e;
  }
  return rel;
};

/** 退避した元のファイルを src に戻す */
export const restoreOriginal = async (projectDir: string, clip: Pick<Clip, 'src' | 'mosaic'>): Promise<void> => {
  const orig = mosaicOriginalAbs(projectDir, clip);
  if (!orig || !fs.existsSync(orig)) throw new Error(`退避した元のファイルが見つかりません: ${orig ?? '(記録なし)'}`);
  const dest = publicAbs(projectDir, clip.src);
  fs.rmSync(dest, {force: true});
  await renameRetry(orig, dest);
  // 元のファイルの更新時刻は古い。そのままだと「out/final.mp4 は素材より新しい」＝モザイク版で
  // レンダーしたものが最新と判定されるので、いまの時刻にする
  const now = new Date();
  fs.utimesSync(dest, now, now);
};

/** cuts.json の alias コピーのうち、この src から作ったものを作り直す（作ってあるものだけ。未適用はレンダー前に作られる） */
export const refreshAliases = (projectDir: string, src: string): string[] => {
  if (!fs.existsSync(path.join(projectDir, 'cuts.json'))) return [];
  let aliases: {from: string; to: string}[];
  try {
    aliases = readCuts(projectDir).meta?.aliases ?? [];
  } catch {
    return [];
  }
  const done: string[] = [];
  for (const a of aliases) {
    if (a.from !== src) continue;
    const to = publicAbs(projectDir, a.to);
    if (!fs.existsSync(to)) continue;
    fs.rmSync(to, {force: true}); // 上書きしない（ハードリンク共有の相手を書き換えない）
    fs.copyFileSync(publicAbs(projectDir, src), to);
    done.push(a.to);
  }
  return done;
};

/** src を入れ替えたあとの派生物：サムネイル・軽量プレビュー・alias コピー */
const refreshDerived = async (projectDir: string, clip: Clip, log: (l: string) => void) => {
  const sdir = studioDir(projectDir);
  const dest = publicAbs(projectDir, clip.src);
  if (clip.thumbs.sheet) fs.rmSync(path.join(sdir, clip.thumbs.sheet), {force: true});
  try {
    clip.thumbs = await makeThumbnails(dest, path.join(sdir, 'thumbs'), path.join(sdir, 'strips'), clip.id, clip.probe.durationSec);
  } catch (e) {
    log(`  ! サムネイルを作り直せませんでした: ${errText(e)}`);
  }
  const preview = path.join(sdir, 'preview', path.basename(clip.src));
  if (fs.existsSync(preview)) {
    fs.rmSync(preview, {force: true});
    try {
      await makePreviewProxy(dest, preview, clip.probe);
      log('  軽量プレビューを作り直しました');
    } catch (e) {
      log(`  ! 軽量プレビューを作り直せませんでした（Materials の「軽量プレビュー生成」でやり直せます）: ${errText(e)}`);
    }
  }
  const aliases = refreshAliases(projectDir, clip.src);
  if (aliases.length) log(`  alias コピーを作り直しました: ${aliases.join(', ')}`);
};

// ───────────────────────── まとめて処理 ─────────────────────────

export type MosaicItemResult = 'applied' | 'no-faces' | 'restored' | 'reverted' | 'skipped' | 'failed';
export type MosaicItem = {id: string; result: MosaicItemResult; framesWithFaces?: number; faceSec?: number; maxFaces?: number; message?: string};

export type MosaicOptions = {
  ids: string[];
  params?: Partial<MosaicParams>;
  onLine?: (line: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type MosaicRunResult = {items: MosaicItem[]; params: MosaicParams; engine: string};

export const applyMosaic = async (projectDir: string, opt: MosaicOptions): Promise<MosaicRunResult> => {
  const log = opt.onLine ?? (() => {});
  const catalog = loadCatalog(projectDir);
  if (!catalog) throw new Error('catalog.json がありません（先に Materials でカタログ実行）');
  const params = resolveMosaicParams(opt.params);
  const status = await mosaicStatus({refresh: true});
  if (!status.ok) throw new Error(status.message);

  const items: MosaicItem[] = [];
  const targets: Clip[] = [];
  for (const id of [...new Set(opt.ids)]) {
    const clip = catalog.clips.find((c) => c.id === id);
    if (clip) targets.push(clip);
    else items.push({id, result: 'skipped', message: 'catalog に無い'});
  }
  if (!targets.length) throw new Error('対象のクリップがありません');
  log(`顔モザイク ${targets.length} 本 / しきい値 ${params.threshold} / ${params.cells} マス / 範囲 ×${params.maskScale} / ${status.message}`);

  // 進捗はフレーム数で按分する（長いクリップで止まって見えないように）
  const framesOf = (c: Clip) => Math.max(1, Math.round(c.probe.durationSec * c.probe.fps));
  const totalFrames = targets.reduce((s, c) => s + framesOf(c), 0);
  let doneFrames = 0;
  const tmpDir = path.join(studioDir(projectDir), 'mosaic', 'tmp');
  fs.mkdirSync(tmpDir, {recursive: true});

  for (const [k, clip] of targets.entries()) {
    if (opt.signal?.aborted) throw new Error('中断されました');
    const label = `[${k + 1}/${targets.length}] ${clip.id} ${clip.original}`;
    log(label);
    opt.onProgress?.(doneFrames, totalFrames, label);
    const dest = publicAbs(projectDir, clip.src);
    // かけ直しは必ず元のファイルから（モザイクの上にモザイクを重ねない）
    const input = mosaicOriginalAbs(projectDir, clip) ?? dest;
    const tmp = path.join(tmpDir, `${clip.id}${path.extname(clip.src)}`);
    const reportPath = path.join(tmpDir, `${clip.id}.json`);
    fs.rmSync(tmp, {force: true});
    fs.rmSync(reportPath, {force: true});
    try {
      if (!fs.existsSync(input)) throw new Error(`${clip.mosaic?.applied ? '退避した元のファイル' : '素材ファイル'}が見つかりません: ${input}`);
      const probe = await probeForMosaic(input);
      const args = mosaicScriptArgs({script: studioConfig.faceMosaicScript, input, output: tmp, report: reportPath, probe, params});
      await runFaceMosaic(status.python, args, {
        onLine: (l) => log(`  ${l}`),
        onFrame: (done, total) => opt.onProgress?.(doneFrames + Math.min(done, total) * (framesOf(clip) / Math.max(1, total)), totalFrames, label),
        signal: opt.signal,
      });
      const report = MosaicReportSchema.parse(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
      const sum = summarizeMosaicReport(report);
      const record: Omit<MosaicInfo, 'applied' | 'original'> = {checkedAt: new Date().toISOString(), params, frames: sum.frames, framesWithFaces: sum.framesWithFaces, maxFaces: sum.maxFaces, spans: sum.spans, engine: report.engine};
      const before = clip.probe.durationSec;
      if (sum.framesWithFaces === 0) {
        fs.rmSync(tmp, {force: true});
        if (clip.mosaic?.applied) {
          await restoreOriginal(projectDir, clip);
          clip.probe = await ffprobe(dest);
          clip.mosaic = {applied: false, ...record};
          await refreshDerived(projectDir, clip, log);
          log('  この設定では顔が見つからないので、元のファイルに戻しました');
          items.push({id: clip.id, result: 'restored', framesWithFaces: 0});
        } else {
          clip.mosaic = {applied: false, ...record};
          log(`  顔は見つかりませんでした（ファイルはそのまま・${report.elapsedSec} 秒）`);
          items.push({id: clip.id, result: 'no-faces', framesWithFaces: 0});
        }
      } else {
        const original = await swapInMosaic(projectDir, clip, tmp);
        clip.probe = await ffprobe(dest);
        clip.mosaic = {applied: true, original, ...record};
        await refreshDerived(projectDir, clip, log);
        log(`  顔 ${sum.faceSec} 秒（${spansText(sum.spans)}）・最大 ${sum.maxFaces} 人 → モザイク版に差し替えました（${report.elapsedSec} 秒）`);
        items.push({id: clip.id, result: 'applied', framesWithFaces: sum.framesWithFaces, faceSec: sum.faceSec, maxFaces: sum.maxFaces});
      }
      // 固定フレームレートで書き出すので尺が 1 フレームほど変わることがある。大きく縮んだらカットがはみ出す
      if (clip.probe.durationSec < before - 0.1) log(`  ! 尺が ${before} → ${clip.probe.durationSec} 秒に縮みました。Timeline の検証で OUT が尺を超えていないか確認してください`);
      // 1 本ごとに書く（途中で止めても済んだ分は残る）
      saveCatalog(projectDir, catalog);
    } catch (e) {
      fs.rmSync(tmp, {force: true});
      if (opt.signal?.aborted) throw new Error('中断されました');
      items.push({id: clip.id, result: 'failed', message: errText(e)});
      log(`  ! 失敗: ${errText(e)}`);
    } finally {
      fs.rmSync(reportPath, {force: true});
    }
    doneFrames += framesOf(clip);
  }
  opt.onProgress?.(totalFrames, totalFrames, '完了');
  const count = (r: MosaicItemResult) => items.filter((i) => i.result === r).length;
  log(`完了: モザイク ${count('applied')} 本 / 顔なし ${count('no-faces')} 本${count('restored') ? ` / 元に戻した ${count('restored')} 本` : ''}${count('failed') ? ` / 失敗 ${count('failed')} 本` : ''}`);
  if (count('failed') && count('failed') === targets.length) throw new Error(`すべて失敗しました: ${items.find((i) => i.result === 'failed')?.message}`);
  return {items, params, engine: status.message};
};

/** モザイクを外して元のファイルに戻す。「顔なし」の記録は消すだけ */
export const revertMosaic = async (projectDir: string, opt: Omit<MosaicOptions, 'params'>): Promise<{items: MosaicItem[]}> => {
  const log = opt.onLine ?? (() => {});
  const catalog = loadCatalog(projectDir);
  if (!catalog) throw new Error('catalog.json がありません');
  const items: MosaicItem[] = [];
  const ids = [...new Set(opt.ids)];
  for (const [k, id] of ids.entries()) {
    if (opt.signal?.aborted) throw new Error('中断されました');
    opt.onProgress?.(k, ids.length, id);
    const clip = catalog.clips.find((c) => c.id === id);
    if (!clip?.mosaic) {
      items.push({id, result: 'skipped', message: clip ? 'モザイクの記録なし' : 'catalog に無い'});
      continue;
    }
    try {
      if (clip.mosaic.applied) {
        await restoreOriginal(projectDir, clip);
        clip.probe = await ffprobe(publicAbs(projectDir, clip.src));
        clip.mosaic = undefined;
        await refreshDerived(projectDir, clip, log);
        log(`${clip.id} ${clip.original}: 元のファイルに戻しました`);
      } else {
        clip.mosaic = undefined;
        log(`${clip.id} ${clip.original}: 「顔なし」の記録を消しました`);
      }
      saveCatalog(projectDir, catalog);
      items.push({id, result: 'reverted'});
    } catch (e) {
      items.push({id, result: 'failed', message: errText(e)});
      log(`${clip.id} ${clip.original}: ! 失敗: ${errText(e)}`);
    }
  }
  opt.onProgress?.(ids.length, ids.length, '完了');
  if (items.length && items.every((i) => i.result === 'failed')) throw new Error(`すべて失敗しました: ${items[0].message}`);
  return {items};
};
