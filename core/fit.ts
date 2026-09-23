// ナレーション音声に映像の尺を合わせる（案件フォルダの読み書き）。ロジックは shared/fit.ts（純粋・テストあり）。
//
// CLI の `reel fit` と、GUI 以外から呼ぶときの入口。GUI（Timeline）は shared/fit.ts を画面の中で直接使い、
// 取り消しできる編集として store に入れる（このファイルは通らない）。
import {readBrief, readCuts, readNarration, writeCuts, writeNarration} from './project';
import {loadCatalog} from './catalog';
import {getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {resolveClip, validateCuts, type ValidationResult} from '../shared/validate';
import {checkNarration} from '../shared/narration';
import {fitCutsToNarration, type FitOptions, type FitResult} from '../shared/fit';

export type FitProjectOptions = Pick<FitOptions, 'minCutSec' | 'maxCutSec' | 'leadSec' | 'tailSec'> & {
  /** false なら書き込まずに結果だけ返す（--dry） */
  write?: boolean;
  /** 音声が無いブロックを文字数からの見積もりで合わせる（既定 false ＝ 音声が無ければ止まる。音声が正のため） */
  estimate?: boolean;
  onLine?: (line: string) => void;
};

export type FitProjectResult = FitResult & {
  written: boolean;
  /** 合わせたあとの cuts の検証（catalog / brief / 型 / 人格つき） */
  validation: ValidationResult;
  /** 合わせたあとの narration の点検（重なり・はみ出し） */
  narrationIssues: string[];
};

/**
 * cuts.json と narration.json を読み、音声に合わせて刻み直し、（write なら）書き戻す。旧版は .studio/backups/ に残る。
 * 音声が無いブロックがあれば（estimate を付けない限り）何も書かずに投げる。
 */
export const fitProject = (projectDir: string, opt: FitProjectOptions = {}): FitProjectResult => {
  const log = opt.onLine ?? (() => {});
  const cuts = readCuts(projectDir);
  const narration = readNarration(projectDir);
  if (!narration) throw new Error('narration.json が無いので合わせられません（先に「AI にナレーションを書いてもらう」→「音声を生成」）');
  const catalog = loadCatalog(projectDir);
  const brief = readBrief(projectDir);
  const persona = brief ? getPersona(brief.persona) : undefined;
  const spec = brief && persona ? FORMAT_SPECS[brief.format ?? persona.defaultFormat] : undefined;
  const aliases = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const cps = persona?.narration.charsPerSecMeasured ?? 8.5;
  const estimate = (s: {text: string}) => [...s.text].length / cps;

  const r = fitCutsToNarration(cuts, narration, {
    minCutSec: opt.minCutSec,
    maxCutSec: opt.maxCutSec,
    leadSec: opt.leadSec,
    tailSec: opt.tailSec,
    clipDurationOf: (src) => resolveClip(catalog ?? undefined, src, aliases)?.probe.durationSec,
    estimate: opt.estimate ? estimate : undefined,
  });
  if (!r.ok) throw new Error(r.blockers.join('\n'));
  for (const n of r.notes) log(n);

  const validation = validateCuts(r.cuts, {catalog: catalog ?? undefined, brief: brief ?? undefined, spec, persona});
  const narrationIssues = checkNarration(r.narration, {estimate});
  for (const e of validation.errors) log(`  E ${e.code}${e.cutId ? ` [${e.cutId}]` : ''} ${e.message}`);
  for (const w of validation.warnings) log(`  W ${w.code}${w.cutId ? ` [${w.cutId}]` : ''} ${w.message}`);
  for (const i of narrationIssues) log(`  ! ${i}`);

  let written = false;
  if (opt.write !== false) {
    writeCuts(projectDir, r.cuts);
    writeNarration(projectDir, r.narration);
    written = true;
    log(`cuts.json（${r.after.cutCount} カット / ${r.after.totalSec.toFixed(2)} 秒）と narration.json を書きました（旧版は .studio/backups/ に残っています）`);
  } else log('まだ書き込んでいません（--dry）');
  return {...r, written, validation, narrationIssues};
};
