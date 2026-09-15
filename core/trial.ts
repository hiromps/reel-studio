// トライアルリール：冒頭のフックだけを差し替えた複数バージョンを一気に作る。
//
// 「どのフックが効いたか」を見るための機能なので、**変わるのはフックだけ**でないと意味がない。
// なので cuts.json は書き換えず、フックを差し替えた cuts を `--props` としてレンダーに渡す
// （元の cuts.json はそのまま＝他の版と 1 フレームもずれない）。
import fs from 'node:fs';
import path from 'node:path';
import {exec} from './exec';
import {readJsonFile, writeJsonAtomic} from './json-io';
import {readBrief, readCaption, readCuts, readNarration} from './project';
import {loadCatalog} from './catalog';
import {renderProject} from './render';
import {synthOne} from './tts';
import {studioConfig} from '../studio.config';
import {mixScriptPath} from './mix';
import {HooksSchema, TRIAL_POSTING_RULES, applyHookNarration, applyHookVariant, checkHooks, hookCutIndices, trialCaptionOf, type HookVariant, type Hooks} from '../shared/hooks';
import {deliverFileName} from '../shared/deliver';
import {getPersona} from '../shared/personas';
import {cutDurationSec} from '../shared/timeline';

export const hooksPath = (dir: string) => path.join(dir, 'hooks.json');

export const readHooks = (dir: string): Hooks | null => (fs.existsSync(hooksPath(dir)) ? readJsonFile(hooksPath(dir), HooksSchema) : null);
export const writeHooks = (dir: string, data: Hooks) => writeJsonAtomic(hooksPath(dir), HooksSchema.parse(data));

const trialDir = (dir: string) => path.join(dir, studioConfig.studioDirName, 'trial');

export type TrialItem = {
  id: string;
  label: string;
  changes: string[];
  /** 案件相対の書き出し先 */
  outRel: string;
  /** 納品した名前（outputs/ 直下） */
  deliveredAs?: string;
  /** 納品したキャプションの名前（outputs/ 直下）。パターン専用が無ければ共通の caption.txt を同名で出す */
  captionAs?: string;
  frames: number;
  durationSec: number;
  sizeBytes: number;
};

export type TrialResult = {items: TrialItem[]; warnings: string[]; outputsDir: string};

export type TrialOptions = {
  /** 作るパターンを絞る（省略＝全部） */
  ids?: string[];
  /** outputs/ まで書き出す（既定 true） */
  deliver?: boolean;
  /** 0.25 倍の粗いレンダーで並びだけ確認する */
  draft?: boolean;
  gl?: string;
  /** W を無視して進める */
  force?: boolean;
  /**
   * 検証の E（F7 の看板温存・画角の連続など「構成の意見」）を承知でレンダーする。
   * 通常レンダー・仕上げと同じ逃げ道（render.ts の allowErrors）。素材が無い等の致命的なものは通らない。
   * 2026-09-15: F7 で看板クリップを自分で早めに置いた構成が、ここに配線が無くてトライアルだけ止まった
   */
  allowErrors?: boolean;
  onLine?: (line: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

/**
 * hooks.json の各バリアントについて レンダー → （ナレーションが変わるなら）音声生成 → mix → 納品。
 * レンダーは重いので 1 本ずつ順番に回す。
 */
export const runTrial = async (projectDir: string, opt: TrialOptions = {}): Promise<TrialResult> => {
  const log = opt.onLine ?? (() => {});
  const hooks = readHooks(projectDir);
  if (!hooks?.variants.length) throw new Error('hooks.json が無い（Render の「トライアル（フック差し替え）」でパターンを作ってください）');
  const cuts = readCuts(projectDir);
  const brief = readBrief(projectDir);
  if (!brief) throw new Error('brief.json が無い');
  const persona = getPersona(brief.persona);
  const catalog = loadCatalog(projectDir);
  const narration = readNarration(projectDir);

  const commonCaption = (readCaption(projectDir) ?? '').trim();
  const issues = checkHooks(hooks, {cuts, caption: commonCaption});
  const errors = issues.filter((i) => i.severity === 'E');
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);
  if (errors.length && !opt.force) throw new Error(`フックの指定に問題があります:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);

  const targets = hooks.variants.filter((v) => !opt.ids?.length || opt.ids.includes(v.id));
  if (!targets.length) throw new Error(`指定した id のパターンがありません: ${opt.ids?.join(', ')}`);
  const idx = hookCutIndices(cuts, hooks.cutCount);
  const spanEndSec = idx.reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0);
  log(`トライアル ${targets.length} パターン（差し替えるのは冒頭 ${idx.length} カット: ${idx.map((i) => i + 1).join('・')}＝${spanEndSec.toFixed(2)} 秒）`);

  fs.mkdirSync(trialDir(projectDir), {recursive: true});
  const outputsDir = studioConfig.outputsDir;
  if (opt.deliver !== false) fs.mkdirSync(outputsDir, {recursive: true});

  const items: TrialItem[] = [];
  const warnings: string[] = [];
  let done = 0;

  for (const v of targets) {
    if (opt.signal?.aborted) break;
    opt.onProgress?.(done, targets.length, `${v.id}: 準備中`);

    // ── フックを差し替えた cuts を props として書く（cuts.json は触らない） ──
    for (const id of v.clipIds.filter(Boolean)) if (!catalog?.clips.some((c) => c.id === id)) warnings.push(`${v.id}: clipId ${id} が catalog に無いので素材は差し替えませんでした`);
    const {cuts: variantCuts, changes} = applyHookVariant(cuts, v, {
      count: hooks.cutCount,
      clipOf: (id) => {
        const c = catalog?.clips.find((x) => x.id === id);
        return c ? {src: c.src, durationSec: c.probe.durationSec} : undefined;
      },
    });
    const propsFile = path.join(trialDir(projectDir), `${v.id}.cuts.json`);
    writeJsonAtomic(propsFile, variantCuts);

    // ── レンダー ──
    const outRel = path.posix.join('out', `trial_${v.id}${opt.draft ? '_draft' : ''}.mp4`);
    log(`■ ${v.id}${v.label ? `（${v.label}）` : ''}: ${changes.join(' / ') || '変更なし'} → ${outRel}`);
    opt.onProgress?.(done, targets.length, `${v.id}: レンダー`);
    const r = await renderProject({
      projectDir,
      props: propsFile,
      out: outRel,
      draft: opt.draft,
      gl: opt.gl,
      force: opt.force,
      allowErrors: opt.allowErrors,
      onLine: (l) => log(`  ${l}`),
      onProgress: (p) => opt.onProgress?.(done, targets.length, `${v.id}: レンダー ${p.phase} ${p.done}/${p.total}`),
      signal: opt.signal,
    });

    // ── ナレーション（フック区間に属するブロックを 1 本にまとめて差し替え）→ mix ──
    let finalRel = outRel;
    if (narration?.segments.length) {
      const {narration: vn, wavId, replaced, nextAt} = applyHookNarration(narration, v, {spanEndSec, charsPerSec: persona.narration.charsPerSecMeasured});
      if (wavId) {
        opt.onProgress?.(done, targets.length, `${v.id}: 音声生成`);
        const wav = path.join(projectDir, 'narration', `${wavId}.wav`);
        const dur = await synthOne(v.narration.trim(), {
          voice: vn.voice,
          speed: vn.speed ?? persona.narration.speed,
          latency: vn.latency,
          out: wav,
          signal: opt.signal,
        });
        log(`  フック区間のナレーション（${replaced.join(', ')}）を差し替え: 「${v.narration.trim()}」 ${dur.toFixed(2)}s`);
        const head = vn.segments.find((s) => s.id === wavId);
        if (head && nextAt !== null && head.at + dur > nextAt + 0.05) {
          const over = head.at + dur - nextAt;
          warnings.push(`${v.id}: フックのナレーションが次のブロック（${nextAt.toFixed(2)} 秒）に ${over.toFixed(2)} 秒食い込みます。文を短くするか、Timeline で引き直してください`);
        }
        vn.segments = vn.segments.map((s) => (s.id === wavId ? {...s, durSec: dur, needsTts: undefined} : s));
      }
      const narrFile = path.join(trialDir(projectDir), `${v.id}.narration.json`);
      writeJsonAtomic(narrFile, vn);
      // draft の合成結果を本番と同じ名前にすると、あとで本番を作ったつもりで粗い方を納品しかねない
      const mixedRel = path.posix.join('out', `trial_${v.id}${opt.draft ? '_draft' : ''}_narration.mp4`);
      opt.onProgress?.(done, targets.length, `${v.id}: ナレーション合成`);
      const mr = await exec(
        process.execPath,
        [mixScriptPath(), narrFile, path.join(projectDir, 'narration'), path.join(projectDir, outRel), path.join(projectDir, mixedRel)],
        {cwd: projectDir, env: {...process.env, REEL_SFX_DIR: studioConfig.sfxDir}, onLine: (l) => log(`  ${l}`), signal: opt.signal},
      );
      if (mr.code !== 0) throw new Error(`${v.id}: mix に失敗 (exit ${mr.code})`);
      finalRel = mixedRel;
    } else {
      warnings.push(`${v.id}: narration.json が無いので素材の音のままです`);
    }

    // ── 納品（フック名を入れて区別できるように）。キャプションもパターンごとに出す ──
    let deliveredAs: string | undefined;
    let captionAs: string | undefined;
    if (opt.deliver !== false && !opt.draft) {
      const name = deliverFileName({shop: brief.shop.name, persona: persona.id, kind: 'narration', label: `フック${v.id}`});
      fs.copyFileSync(path.join(projectDir, finalRel), path.join(outputsDir, name));
      deliveredAs = name;
      log(`  → ${name}`);
      const cap = trialCaptionOf(v, commonCaption);
      if (cap) {
        captionAs = deliverFileName({shop: brief.shop.name, persona: persona.id, kind: 'caption', label: `フック${v.id}`});
        fs.writeFileSync(path.join(outputsDir, captionAs), `${cap}\n`, 'utf8');
        log(`  → ${captionAs}${v.caption.trim() ? '' : '（共通の caption.txt）'}`);
      } else warnings.push(`${v.id}: キャプションがありません（専用も共通の caption.txt も無い）`);
    }

    items.push({id: v.id, label: v.label, changes, outRel: finalRel, deliveredAs, captionAs, frames: r.frames, durationSec: r.durationSec, sizeBytes: r.sizeBytes});
    done++;
    opt.onProgress?.(done, targets.length, `${v.id}: 完了`);
  }

  // 尺が揃っているか（フックだけ変えたのに尺が違う＝比較にならない）
  const durs = [...new Set(items.map((i) => Math.round(i.durationSec * 100) / 100))];
  if (durs.length > 1) warnings.push(`パターンごとに尺が違います（${durs.join(' / ')} 秒）。フックのカット尺を揃えると比べやすくなります`);

  log(`トライアル完了: ${items.length} パターン`);
  for (const w of warnings) log(`  ! ${w}`);
  if (opt.deliver !== false && !opt.draft) {
    log('投稿の運用ルール（Instagram 側の操作。ツールは代行しない）:');
    for (const r of TRIAL_POSTING_RULES) log(`  ・${r}`);
  }
  return {items, warnings, outputsDir};
};
