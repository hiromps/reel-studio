// Remotion レンダーのラッパ。preflight（validate・alias・エンジン同期・メモリ）→ 段階リトライ → 事後検証（フレーム数・QC タイル）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {calcTotalFrames, cutStartFrame} from '../shared/timeline';
import {validateCuts, formatValidation, FATAL_CODES, type ValidationResult} from '../shared/validate';
import {FORMAT_SPECS} from '../shared/format-specs';
import {findPersona} from '../shared/personas';
import {fileStamp} from '../shared/time';
import type {ReelData} from '../shared/schema/cuts';
import {exec, type ExecResult} from './exec';
import {countFrames} from './ffprobe';
import {makeQcTile} from './thumbnails';
import {loadCatalog} from './catalog';
import {engineDiff, syncEngine, readCuts, readBrief, writeCuts} from './project';
import {ensureProjectFont, type FontDelivery} from './fonts';
import {pendingAliases, applyAliases} from './alias';

export type RenderProgress = {phase: 'bundle' | 'render' | 'stitch' | 'other'; done: number; total: number; attempt: number};

export type RenderOptions = {
  projectDir: string;
  /** 出力（案件相対 or 絶対）。既定 out/final.mp4（draft は out/draft.mp4） */
  out?: string;
  draft?: boolean;
  gl?: string;
  concurrency?: number;
  crf?: number;
  cacheBytes?: number;
  retries?: number;
  /** W を無視して実行（E とプレースホルダは無視できない） */
  force?: boolean;
  /**
   * **検証の E も無視して実行する。** 並びやテロップを自分で決めたときに、検証の意見
   * （画角の連続・フックの型など）で止められないようにするための逃げ道。
   * ただし「そもそもレンダーが失敗するもの」（素材が無い / node_modules が無い / 空きディスク不足）は
   * 無視できない。ここを通すと成功しようがないため。
   */
  allowErrors?: boolean;
  noSync?: boolean;
  strictProxy?: boolean;
  /** --props に渡す cuts.json（省略時は案件直下の cuts.json＝defaultProps） */
  props?: string;
  lowMemory?: boolean;
  onLine?: (line: string) => void;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
};

export type RenderResult = {
  ok: boolean;
  attempts: number;
  outPath: string;
  sizeBytes: number;
  frames: number;
  expectedFrames: number;
  durationSec: number;
  qcTile?: string;
  warnings: string[];
  logs: string[];
  validation: ValidationResult;
};

export class PreflightError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`preflight に失敗:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.issues = issues;
  }
}

const RETRY_PATTERNS = /Could not extract frame|Compositor panicked|memory allocation|Failed to fetch|Target closed|ENOMEM|out of memory|Navigating frame was detached|Protocol error|EBUSY/i;

export const remotionCli = (projectDir: string) => path.join(projectDir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');

/** validate に渡すコンテキストを案件から組み立てる */
export const validationContext = (projectDir: string, opt: {strictProxy?: boolean} = {}) => {
  const catalog = loadCatalog(projectDir) ?? undefined;
  const brief = readBrief(projectDir) ?? undefined;
  // 人格が未登録でも検証は動かす（spec は brief.format か F0）。未登録は validate 側で気づける
  const persona = brief ? findPersona(brief.persona) : undefined;
  const spec = brief ? FORMAT_SPECS[brief.format ?? persona?.defaultFormat ?? 'F0'] : undefined;
  return {
    catalog,
    brief,
    persona,
    spec,
    srcExists: (src: string) => fs.existsSync(path.join(projectDir, 'public', src)),
    strictProxy: opt.strictProxy,
    engineStale: fs.existsSync(path.join(projectDir, 'src')) ? engineDiff(projectDir).stale : undefined,
  };
};

export const validateProject = (projectDir: string, opt: {strictProxy?: boolean; cuts?: ReelData} = {}): ValidationResult => {
  const cuts = opt.cuts ?? readCuts(projectDir);
  return validateCuts(cuts, validationContext(projectDir, opt));
};

// 「物理的に無理」な E の一覧は shared/validate.ts が正（クラウドの段取り判定も同じものを見る）
export {FATAL_CODES};

export type Preflight = {
  cuts: ReelData;
  validation: ValidationResult;
  /** 実行を止める理由 */
  issues: string[];
  /** allowErrors で通した（＝承知で無視した）理由。ログに残す */
  overridden: string[];
  lowMemory: boolean;
  synced: string[];
  /** 自前フォントの用意（配った / 見つからない）。見つからなくても同梱の明朝で描けるので止めない */
  font: FontDelivery;
};

export const preflight = (opt: RenderOptions): Preflight => {
  const {projectDir} = opt;
  const issues: string[] = [];
  const overridden: string[] = [];
  const synced: string[] = [];
  if (!fs.existsSync(remotionCli(projectDir))) issues.push('node_modules に @remotion/cli が無い（npm install が必要）');
  const cuts = readCuts(projectDir);
  const validation = validateCuts(cuts, validationContext(projectDir, {strictProxy: opt.strictProxy}));
  const fatal = validation.errors.filter((e) => FATAL_CODES.has(e.code));
  const judgement = validation.errors.filter((e) => !FATAL_CODES.has(e.code));
  const line = (e: {code: string; cutId?: string; message: string}) => `E ${e.code}${e.cutId ? ` [${e.cutId}]` : ''} ${e.message}`;
  issues.push(...fatal.map(line));
  if (opt.allowErrors) overridden.push(...judgement.map(line));
  else issues.push(...judgement.map(line));
  if (validation.summary.placeholders > 0) {
    const msg = `テロップに未記入のプレースホルダが ${validation.summary.placeholders} 個`;
    // プレースホルダは画面に {{...}} がそのまま出る。承知で通すこともできるが、既定では止める
    if (opt.allowErrors) overridden.push(`${msg}（{{...}} が画面に出ます）`);
    else issues.push(msg);
  }
  const pend = pendingAliases(projectDir, cuts);
  if (pend.length) {
    const done = applyAliases(projectDir, cuts);
    if (done.length) writeCuts(projectDir, cuts);
    const still = pendingAliases(projectDir, cuts);
    if (still.length) issues.push(`alias 未適用: ${still.map((a) => a.to).join(', ')}`);
  }
  if (fs.existsSync(path.join(projectDir, 'src'))) {
    const diff = engineDiff(projectDir);
    if (diff.stale) {
      if (opt.noSync) issues.push(`エンジンがマスターと差分あり（--no-sync 指定のため同期しない）: ${diff.files.filter((f) => f.status !== 'ok').map((f) => f.file).join(', ')}`);
      else synced.push(...syncEngine(projectDir).synced);
    }
  }
  if (!opt.force && validation.warnings.length) {
    // W は止めないが preflight 結果に載せる
  }
  try {
    const st = fs.statfsSync(projectDir);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    if (freeGb < 2) issues.push(`空きディスクが ${freeGb.toFixed(1)} GB（2 GB 以上が必要）`);
  } catch {
    /* statfs 非対応環境 */
  }
  // テロップの自前フォントを案件へ用意する（cuts.json の font）。無くても同梱の明朝で描けるので止めない
  const font = ensureProjectFont(projectDir, (cuts as {font?: string}).font);
  const lowMemory = opt.lowMemory ?? os.freemem() < 1.2 * 1024 ** 3;
  return {cuts, validation, issues, overridden, lowMemory, synced, font};
};

const parseProgress = (line: string, attempt: number): RenderProgress | null => {
  let m = /Rendered (\d+)\/(\d+)/.exec(line);
  if (m) return {phase: 'render', done: +m[1], total: +m[2], attempt};
  m = /Stitched (\d+)\/(\d+)/.exec(line);
  if (m) return {phase: 'stitch', done: +m[1], total: +m[2], attempt};
  m = /Bundling (\d+)%/.exec(line);
  if (m) return {phase: 'bundle', done: +m[1], total: 100, attempt};
  return null;
};

export async function renderProject(opt: RenderOptions): Promise<RenderResult> {
  const {projectDir} = opt;
  const pf = preflight(opt);
  if (pf.issues.length) throw new PreflightError(pf.issues);
  if (pf.overridden.length) {
    opt.onLine?.(`※ 検証の E を ${pf.overridden.length} 件、承知で無視して実行します`);
    for (const o of pf.overridden) opt.onLine?.(`  （無視）${o}`);
  }
  const log = opt.onLine ?? (() => {});
  for (const s of pf.synced) log(`engine synced: ${s}`);
  if (pf.font.copied) log(`テロップのフォントを案件へ配りました: ${pf.font.file}`);
  const outRel = opt.out ?? (opt.draft ? 'out/draft.mp4' : 'out/final.mp4');
  const outAbs = path.isAbsolute(outRel) ? outRel : path.join(projectDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), {recursive: true});
  const logsDir = path.join(projectDir, studioConfig.studioDirName, 'logs');
  fs.mkdirSync(logsDir, {recursive: true});
  const retries = opt.retries ?? 3;
  const expectedFrames = calcTotalFrames(pf.cuts);
  const logs: string[] = [];
  const warnings: string[] = pf.validation.warnings.map((w) => `${w.code}${w.cutId ? ` [${w.cutId}]` : ''} ${w.message}`);
  if (pf.font.missing) warnings.push(`テロップのフォント ${pf.font.file} が見つかりません（設定の置き場の fonts/ にも案件の public/fonts/ にも無い）。同梱の明朝で描かれます`);
  let attempts = 0;
  let last: ExecResult | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    attempts = attempt;
    const low = pf.lowMemory || attempt >= 2;
    const gl = opt.gl ?? 'swiftshader';
    const concurrency = opt.concurrency ?? (opt.draft || low ? 1 : undefined);
    const cache = opt.cacheBytes ?? (low ? 128 * 1024 * 1024 : 256 * 1024 * 1024);
    const args = ['render', 'GourmetReel', outAbs, '--codec=h264', `--crf=${opt.crf ?? (opt.draft ? 30 : 20)}`, `--gl=${gl}`, `--offthreadvideo-cache-size-in-bytes=${cache}`, '--overwrite'];
    if (concurrency) args.push(`--concurrency=${concurrency}`);
    if (opt.draft) args.push('--scale=0.25');
    if (attempt >= 3) args.push('--x264-preset=veryfast');
    if (opt.props) args.push(`--props=${path.resolve(opt.props)}`);
    const logFile = path.join(logsDir, `render-${fileStamp()}-try${attempt}.log`);
    logs.push(logFile);
    const fh = fs.openSync(logFile, 'w');
    fs.writeSync(fh, `# ${process.execPath} ${remotionCli(projectDir)} ${args.join(' ')}\n# freemem=${Math.round(os.freemem() / 1024 / 1024)}MB lowMemory=${low}\n`);
    log(`[try ${attempt}/${retries}] remotion ${args.slice(0, 3).join(' ')} (gl=${gl}${concurrency ? `, concurrency=${concurrency}` : ''}, cache=${Math.round(cache / 1024 / 1024)}MB)`);
    let lastProgressLine = '';
    const r = await exec(process.execPath, [remotionCli(projectDir), ...args], {
      cwd: projectDir,
      signal: opt.signal,
      env: {NODE_OPTIONS: `--max-old-space-size=${low ? 1024 : 2048}`},
      onLine: (line) => {
        fs.writeSync(fh, line + '\n');
        const p = parseProgress(line, attempt);
        if (p) {
          opt.onProgress?.(p);
          if (line !== lastProgressLine && (p.done === p.total || p.done % 100 === 0)) log(line);
          lastProgressLine = line;
        } else log(line);
      },
    });
    fs.closeSync(fh);
    last = r;
    const output = r.stdout + r.stderr;
    if (r.code === 0 && fs.existsSync(outAbs) && !RETRY_PATTERNS.test(output.slice(-4000))) break;
    if (opt.signal?.aborted) throw new Error('中断された');
    const reason = r.code !== 0 ? `exit ${r.code}` : 'エラーパターン検出';
    log(`[try ${attempt}] 失敗（${reason}）`);
    if (attempt < retries) {
      const wait = [5, 15, 30][attempt - 1] ?? 30;
      log(`${wait} 秒待って再試行（次は concurrency=1・cache 128MB${attempt + 1 >= 3 ? '・x264 veryfast' : ''}）`);
      await new Promise((res) => setTimeout(res, wait * 1000));
    }
  }
  if (!last || last.code !== 0 || !fs.existsSync(outAbs)) {
    const tail = (last?.stderr ?? '').split(/\r?\n/).filter(Boolean).slice(-30).join('\n');
    throw new Error(`レンダーに ${attempts} 回失敗。最後のログ:\n${tail}\n(全文: ${logs[logs.length - 1]})`);
  }

  // 事後検証
  const {frames, durationSec} = await countFrames(outAbs);
  if (frames !== expectedFrames) warnings.push(`フレーム数が一致しない: 出力 ${frames} / 期待 ${expectedFrames}`);
  // レンダーは素材の音だけを載せる。ナレーションは別工程（mix）なので、
  // 本番出力なのに narration.json が無ければ「素出力のまま」だと知らせる
  // （過去に素出力のまま投稿して保存率が落ちた事故があるため）
  if (!opt.draft && !fs.existsSync(path.join(projectDir, 'narration.json')))
    warnings.push('ナレーションが載っていません（narration.json が無い）。これは素材の音だけの出力です。ナレーション原稿と音声を作ってから「ナレーション合成（mix）」で完成させてください');
  let qcTile: string | undefined;
  try {
    qcTile = await makeQcTile(outAbs, path.join(projectDir, 'qc', `${path.basename(outAbs, path.extname(outAbs))}-tile.png`));
  } catch (e) {
    warnings.push(`QC タイル生成に失敗: ${(e as Error).message}`);
  }
  const result: RenderResult = {
    ok: true,
    attempts,
    outPath: outAbs,
    sizeBytes: fs.statSync(outAbs).size,
    frames,
    expectedFrames,
    durationSec,
    qcTile,
    warnings,
    logs,
    validation: pf.validation,
  };
  fs.writeFileSync(path.join(projectDir, studioConfig.studioDirName, 'render-result.json'), JSON.stringify({...result, validation: formatValidation(pf.validation)}, null, 2));
  return result;
}

export async function renderStill(projectDir: string, opt: {cut?: number; frame?: number; offsetSec?: number; out?: string; gl?: string; onLine?: (l: string) => void}): Promise<{out: string; frame: number}> {
  const cuts = readCuts(projectDir);
  let frame = opt.frame ?? 0;
  if (opt.cut !== undefined) {
    const idx = opt.cut - 1;
    if (idx < 0 || idx >= cuts.cuts.length) throw new Error(`カット番号 ${opt.cut} は 1〜${cuts.cuts.length}`);
    // テロップは約 0.13 秒でフェードインするため、カット頭から少し進めた位置（既定 0.3 秒）で撮る
    const offset = Math.round((opt.offsetSec ?? 0.3) * cuts.fps);
    const start = cutStartFrame(cuts, idx);
    const end = cutStartFrame(cuts, idx + 1);
    frame = Math.min(start + offset, Math.max(start, end - 1));
  }
  const outRel = opt.out ?? `qc/${opt.cut !== undefined ? `cut${String(opt.cut).padStart(2, '0')}` : `frame${frame}`}.png`;
  const outAbs = path.isAbsolute(outRel) ? outRel : path.join(projectDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), {recursive: true});
  if (engineDiff(projectDir).stale) syncEngine(projectDir);
  ensureProjectFont(projectDir, (cuts as {font?: string}).font);
  const args = ['still', 'GourmetReel', outAbs, `--frame=${frame}`, `--gl=${opt.gl ?? 'swiftshader'}`, '--overwrite'];
  const r = await exec(process.execPath, [remotionCli(projectDir), ...args], {cwd: projectDir, onLine: (l) => opt.onLine?.(l)});
  if (r.code !== 0 || !fs.existsSync(outAbs)) throw new Error(`still に失敗 (exit ${r.code}):\n${r.stderr.split(/\r?\n/).slice(-20).join('\n')}`);
  return {out: outAbs, frame};
}
