// 既存の人格を AI で磨く（ジョブ ai-persona-refine の本体）。
// 案を返すだけで personas.json は書かない（画面で見比べてから「人格を保存」で確定する）。
import fs from 'node:fs';
import {studioConfig} from '../studio.config';
import {settingsDir} from './settings';
import {runAgent} from './agent';
import {agentProgress} from './ai';
import {findPersona} from '../shared/personas';
import {
  applyPersonaRefine,
  buildPersonaRefinePrompt,
  PERSONA_REFINE_SCHEMA,
  PersonaRefineDraftSchema,
  REFINABLE_LABEL,
  refinedKeys,
  type PersonaRefineResult,
} from '../shared/persona-refine';

export type RefinePersonaOptions = {
  id: string;
  instruction: string;
  model?: string;
  onLine?: (l: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export async function refinePersona(opt: RefinePersonaOptions): Promise<PersonaRefineResult> {
  const log = opt.onLine ?? (() => {});
  const model = opt.model ?? studioConfig.agent.model;
  const instruction = opt.instruction.trim();
  if (!instruction) throw new Error('どう磨くかの指示が空です（例: フックはターゲットを広く、誰にでも刺さる言葉で）');
  const base = findPersona(opt.id);
  if (!base) throw new Error(`人格がありません: ${opt.id}`);

  opt.onProgress?.(0, 0, `人格「${base.label}」を書き直しています`);
  log(`人格「${base.label}」（${base.id}）を磨きます（model=${model}）`);
  log(`指示: ${instruction}`);
  const cwd = settingsDir();
  fs.mkdirSync(cwd, {recursive: true});
  const {onEvent} = agentProgress({onProgress: opt.onProgress, log, labels: {thinking: '指示に合わせて人格を見直しています', writing: '書き直した人格を書き出しています'}});
  const run = await runAgent({cwd, prompt: buildPersonaRefinePrompt({persona: base, instruction}), schema: PERSONA_REFINE_SCHEMA, model, timeoutMs: studioConfig.agent.timeoutMs, onLine: log, onEvent, signal: opt.signal});
  const parsed = PersonaRefineDraftSchema.safeParse(run.data);
  if (!parsed.success) throw new Error(`書き直しの返答が読めませんでした: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  let persona;
  try {
    persona = applyPersonaRefine(base, parsed.data);
  } catch (e) {
    throw new Error(`書き直した人格が形になりませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
  const changed = refinedKeys(base, persona);
  log(changed.length ? `変わった項目: ${changed.map((k) => REFINABLE_LABEL[k]).join('・')}（まだ保存していません）` : '変わった項目はありませんでした');
  for (const c of parsed.data.changes) log(`  - ${c}`);
  if (parsed.data.samples.length) log(`フックの例: ${parsed.data.samples.map((s) => `「${s}」`).join(' ')}`);
  log(`($${run.costUsd.toFixed(3)})`);
  return {id: base.id, persona, changed, changes: parsed.data.changes, samples: parsed.data.samples, costUsd: run.costUsd};
}
