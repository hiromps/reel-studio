// 仕上げパイプライン：案件の状態を集めて（buildFacts）、選んだ工程を順に走らせる（runBuild）。
// 段取りの判断は shared/build.ts（純粋）。ここは fs と各工程の実行だけ。
import fs from 'node:fs';
import path from 'node:path';
import {readCaption, readNarration} from './project';
import {FATAL_CODES, PreflightError, renderProject, validateProject} from './render';
import {generateTts, needsTtsIds, ttsAvailable} from './tts';
import {mixNarration} from './mix';
import {deliver, narrationReady} from './deliver';
import {aiCaption, aiNarration} from './ai';
import {claudeAvailable} from './agent';
import {BUILD_STEP_LABEL, orderBuildSteps, planBuild, type BuildFacts, type BuildStep, type BuildStepId} from '../shared/build';

const mtime = (p: string): number => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** 案件フォルダから、段取りの判断に要る事実を集める */
export const buildFacts = (dir: string): BuildFacts => {
  const cutsPath = path.join(dir, 'cuts.json');
  const hasCuts = fs.existsSync(cutsPath);
  let cutCount = 0;
  let placeholders = 0;
  let validationErrors = 0;
  let fatalErrors = 0;
  if (hasCuts) {
    try {
      const v = validateProject(dir);
      cutCount = v.summary.cutCount;
      placeholders = v.summary.placeholders;
      fatalErrors = v.errors.filter((e) => FATAL_CODES.has(e.code)).length;
      validationErrors = v.errors.length - fatalErrors;
    } catch {
      fatalErrors = 1; // 読めない cuts.json はレンダーもできない
    }
  }
  const narration = readNarration(dir);
  const finalPath = path.join(dir, 'out', 'final.mp4');
  const hasFinal = fs.existsSync(finalPath);
  const ready = narrationReady(dir);
  return {
    hasCuts,
    cutCount,
    placeholders,
    validationErrors,
    fatalErrors,
    hasNarration: !!narration,
    segments: narration?.segments.length ?? 0,
    needsTts: narration ? needsTtsIds(dir, narration).length : 0,
    hasFinal,
    finalStale: hasFinal && mtime(cutsPath) > mtime(finalPath),
    hasMixed: fs.existsSync(path.join(dir, 'out', 'final_narration.mp4')),
    mixStaleReason: ready.ok ? undefined : ready.reason,
    hasCaption: !!readCaption(dir)?.trim(),
    ttsAvailable: ttsAvailable(),
    claudeAvailable: claudeAvailable(),
  };
};

export const buildPlan = (dir: string): {facts: BuildFacts; steps: BuildStep[]} => {
  const facts = buildFacts(dir);
  return {facts, steps: planBuild(facts)};
};

export type BuildOptions = {
  steps: BuildStepId[];
  model?: string;
  /** 検証の E を承知でレンダーする */
  allowErrors?: boolean;
  /** 納品ファイル名に足す語 */
  label?: string;
  gl?: string;
  onLine?: (line: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type BuildResult = {
  ran: BuildStepId[];
  skipped: {id: BuildStepId; why: string}[];
  /** 納品したファイル名（deliver を走らせたとき） */
  delivered?: string[];
  costUsd: number;
  outRel?: string;
};

/**
 * 選んだ工程を実行順に走らせる。1 つ失敗したらそこで止める（続きは直してから「仕上げ」を押し直す）。
 * 各工程は既存の関数をそのまま呼ぶ（ボタンを順に押すのと同じ結果になるように）。
 */
export const runBuild = async (dir: string, opt: BuildOptions): Promise<BuildResult> => {
  const log = opt.onLine ?? (() => {});
  const order = orderBuildSteps(opt.steps);
  if (!order.length) throw new Error('走らせる工程が選ばれていません');
  const total = order.length;
  const ran: BuildStepId[] = [];
  const skipped: BuildResult['skipped'] = [];
  let costUsd = 0;
  let delivered: string[] | undefined;
  let outRel: string | undefined;

  const stepProgress = (k: number, label: string) => (done: number, subTotal: number, phase?: string) => {
    const frac = subTotal > 0 ? Math.min(1, done / subTotal) : 0;
    opt.onProgress?.(Math.round((k + frac) * 100) / 100, total, `${k + 1}/${total} ${label}${phase ? ` — ${phase}` : ''}`);
  };

  for (const [k, id] of order.entries()) {
    if (opt.signal?.aborted) throw new Error('中断されました');
    const label = BUILD_STEP_LABEL[id];
    log(`── [${k + 1}/${total}] ${label}`);
    opt.onProgress?.(k, total, `${k + 1}/${total} ${label}`);
    const sub = stepProgress(k, label);
    try {
      switch (id) {
        case 'caption': {
          const r = await aiCaption(dir, {model: opt.model, research: true, onLine: log, onProgress: sub, signal: opt.signal});
          costUsd += r.costUsd;
          break;
        }
        case 'narration': {
          const r = await aiNarration(dir, {model: opt.model, onLine: log, onProgress: sub, signal: opt.signal});
          costUsd += r.costUsd;
          break;
        }
        case 'tts': {
          await generateTts(dir, {onLine: log, onProgress: sub, signal: opt.signal});
          break;
        }
        case 'render': {
          const r = await renderProject({projectDir: dir, draft: false, allowErrors: opt.allowErrors, gl: opt.gl, onLine: log, onProgress: (p) => sub(p.done, p.total, p.phase), signal: opt.signal});
          for (const w of r.warnings) log(`  W ${w}`);
          break;
        }
        case 'mix': {
          const r = await mixNarration(dir, {onLine: log, signal: opt.signal});
          outRel = r.outRel;
          break;
        }
        case 'deliver': {
          const r = await deliver(dir, {label: opt.label, onLine: log});
          delivered = r.items.map((x) => path.basename(x.to));
          for (const w of r.warnings) log(`  ! ${w}`);
          break;
        }
      }
      ran.push(id);
    } catch (e) {
      const msg = e instanceof PreflightError ? e.message : e instanceof Error ? e.message : String(e);
      const rest = order.slice(k + 1);
      for (const r of rest) skipped.push({id: r, why: `${label} が失敗したため`});
      throw new Error(`[${k + 1}/${total}] ${label} で止まりました: ${msg}${rest.length ? `\n  残り: ${rest.map((r) => BUILD_STEP_LABEL[r]).join(' → ')}` : ''}`);
    }
  }
  opt.onProgress?.(total, total, '完了');
  log(`仕上げ 完了: ${ran.map((r) => BUILD_STEP_LABEL[r]).join(' → ')}${costUsd ? ` / AI $${costUsd.toFixed(2)}` : ''}`);
  return {ran, skipped, delivered, costUsd, outRel};
};
