// 勝ちパターンの二次活用：トライアルで伸びた 1 本を「締めの一言だけ変えて 1.1 倍速で書き出し直し、
// 新しいキャプションで再投稿」するための書き出し。
//
// 流れ: （伸びたパターンのフックを当てた cuts）→ 締めテロップを差し替え → レンダー（--props、cuts.json は触らない）
//       → 締めナレーションだけ音声生成 → mix → ffmpeg で倍速 → outputs/ へ（mp4 とキャプション）
// 映像の中身は締め以外 1 フレームも変えない。文言が無ければ AI（aiWinner）に書かせる。
import fs from 'node:fs';
import path from 'node:path';
import {exec, execOk} from './exec';
import {writeJsonAtomic} from './json-io';
import {readBrief, readCaption, readCuts, readNarration} from './project';
import {loadCatalog} from './catalog';
import {renderProject} from './render';
import {synthOne} from './tts';
import {countFrames} from './ffprobe';
import {readHooks} from './trial';
import {aiWinner} from './ai-trial';
import {studioConfig} from '../studio.config';
import {applyHookNarration, applyHookVariant, hookCutIndices, trialCaptionOf} from '../shared/hooks';
import {DEFAULT_WINNER_SPEED, applyTailNarration, applyTailTelop, checkWinner, spedUpSec, tailTelopOf, type WinnerIssue} from '../shared/winner';
import {deliverFileName} from '../shared/deliver';
import {getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {cutDurationSec, totalSec} from '../shared/timeline';
import type {Narration} from '../shared/schema/narration';

const trialDir = (dir: string) => path.join(dir, studioConfig.studioDirName, 'trial');

export type WinnerOptions = {
  /** 伸びたパターンの id（hooks.json）。省略＝元の動画 */
  id?: string;
  /** 締めのテロップ。省略＝AI に書かせる */
  tailTelop?: string;
  /** 締めのナレーション。省略＝AI に書かせる */
  tailNarration?: string;
  /** 新しいキャプション。省略＝AI に書かせる */
  caption?: string;
  /** 倍速。既定 1.1 */
  speed?: number;
  /** 0.25 倍の粗いレンダー（納品しない） */
  draft?: boolean;
  /** outputs/ へ出す（既定 true） */
  deliver?: boolean;
  gl?: string;
  /** W を無視して進める */
  force?: boolean;
  /** 検証の E を承知でレンダーする（trial と同じ。致命的なものは通らない） */
  allowErrors?: boolean;
  model?: string;
  instruction?: string;
  onLine?: (line: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type WinnerResult = {
  key: string;
  tailTelop: string;
  tailNarration: string;
  caption: string;
  speed: number;
  issues: WinnerIssue[];
  /** 案件相対の最終書き出し（倍速後） */
  outRel: string;
  deliveredAs?: string;
  captionAs?: string;
  durationSec: number;
  sizeBytes: number;
  costUsd: number;
  outputsDir: string;
};

/** mixed mp4 を倍速で書き出す（映像は setpts、音声は atempo でピッチを保つ） */
export const speedUpVideo = async (input: string, output: string, speed: number, opt: {fps?: number; onLine?: (l: string) => void; signal?: AbortSignal} = {}): Promise<void> => {
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const args = [
    '-y', '-nostdin', '-v', 'error', '-stats',
    '-i', input,
    '-filter_complex', `[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`,
    '-map', '[v]', '-map', '[a]',
    ...(opt.fps ? ['-r', String(opt.fps)] : []),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
  await execOk('ffmpeg', args, {onLine: opt.onLine ? (l) => opt.onLine!(l) : undefined, signal: opt.signal});
};

/**
 * 二次活用の書き出し。1 本だけ作る（伸びたパターンが 1 本に決まってから使うもの）。
 */
export const runWinner = async (projectDir: string, opt: WinnerOptions = {}): Promise<WinnerResult> => {
  const log = opt.onLine ?? (() => {});
  const brief = readBrief(projectDir);
  if (!brief) throw new Error('brief.json が無い');
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const speed = opt.speed ?? DEFAULT_WINNER_SPEED;
  const catalog = loadCatalog(projectDir);
  const common = (readCaption(projectDir) ?? '').trim();
  let costUsd = 0;

  // ── 伸びたパターンのフックを当てる（トライアルと同じ手順） ──
  let cuts = readCuts(projectDir);
  let narration: Narration | null = readNarration(projectDir);
  let baseCaption = common;
  let key = 'base';
  let hookWavId: string | null = null;
  let hookText = '';
  if (opt.id) {
    const hooks = readHooks(projectDir);
    const v = hooks?.variants.find((x) => x.id === opt.id);
    if (!v) throw new Error(`hooks.json にパターン ${opt.id} がありません`);
    key = v.id;
    const idx = hookCutIndices(cuts, hooks!.cutCount);
    const spanEndSec = idx.reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0);
    cuts = applyHookVariant(cuts, v, {
      count: hooks!.cutCount,
      clipOf: (id) => {
        const c = catalog?.clips.find((x) => x.id === id);
        return c ? {src: c.src, durationSec: c.probe.durationSec} : undefined;
      },
    }).cuts;
    if (narration) {
      const r = applyHookNarration(narration, v, {spanEndSec, charsPerSec: persona.narration.charsPerSecMeasured});
      narration = r.narration;
      hookWavId = r.wavId;
      hookText = v.narration.trim();
    }
    baseCaption = trialCaptionOf(v, common);
    log(`パターン ${v.id}${v.angle ? `［${v.angle}］` : ''} を元にします`);
  }
  const videoSec = totalSec(cuts);
  const prevTelop = tailTelopOf(cuts);
  if (!prevTelop) throw new Error('締めのテロップが見つかりません（末尾のカットに main が無い）');
  const prevNarr = narration ? [...narration.segments].sort((a, b) => a.at - b.at).at(-1)?.text ?? '' : '';

  // ── 文言（無いものだけ AI に書かせる） ──
  let tailTelop = (opt.tailTelop ?? '').trim();
  let tailNarration = (opt.tailNarration ?? '').trim();
  let caption = (opt.caption ?? '').trim();
  const needAi = !tailTelop || (!tailNarration && !!narration) || !caption;
  if (needAi) {
    opt.onProgress?.(0, 5, 'AI が締めとキャプションを書いています');
    const ai = await aiWinner(projectDir, {
      variantId: opt.id,
      given: {tailTelop, tailNarration, caption},
      model: opt.model,
      instruction: opt.instruction,
      onLine: log,
      onProgress: (d, t, phase) => opt.onProgress?.(0, 5, phase || `AI ${d}/${t}`),
      signal: opt.signal,
    });
    costUsd += ai.costUsd;
    tailTelop = ai.tailTelop;
    tailNarration = narration ? ai.tailNarration : '';
    caption = ai.caption;
  }
  const issues = checkWinner({tailTelop, prevTelop, tailNarration, prevNarration: prevNarr, caption, prevCaption: baseCaption, speed, ctaPatterns: persona.ctaPatterns, maxTelopChars: spec.telop.maxChars});
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);
  const errors = issues.filter((i) => i.severity === 'E');
  if (errors.length) throw new Error(`二次活用の指定に問題があります:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
  if (issues.length && !opt.force && issues.some((i) => i.code === 'CAPTION_SAME')) throw new Error('キャプションが元と同じ文面です。書き直してから実行してください（承知の上なら force）');

  // ── 締めテロップを差し替えた cuts を props に（cuts.json は触らない） ──
  const tail = applyTailTelop(cuts, tailTelop);
  fs.mkdirSync(trialDir(projectDir), {recursive: true});
  const propsFile = path.join(trialDir(projectDir), `${key}W.cuts.json`);
  writeJsonAtomic(propsFile, tail.cuts);
  log(`■ 締め「${tail.before}」→「${tailTelop}」（${tail.cutIds.join(', ')}）／${speed} 倍速`);

  // ── レンダー ──
  const suffix = opt.draft ? '_draft' : '';
  const renderedRel = path.posix.join('out', `winner_${key}${suffix}.mp4`);
  opt.onProgress?.(1, 5, 'レンダー');
  const r = await renderProject({
    projectDir,
    props: propsFile,
    out: renderedRel,
    draft: opt.draft,
    gl: opt.gl,
    force: opt.force,
    allowErrors: opt.allowErrors,
    onLine: (l) => log(`  ${l}`),
    onProgress: (p) => opt.onProgress?.(1, 5, `レンダー ${p.phase} ${p.done}/${p.total}`),
    signal: opt.signal,
  });

  // ── 音声（フックの wav が無ければ作り直し、締めは必ず作り直し）→ mix ──
  let mixedRel = renderedRel;
  if (narration?.segments.length) {
    const narrDir = path.join(projectDir, 'narration');
    if (hookWavId && hookText && !fs.existsSync(path.join(narrDir, `${hookWavId}.wav`))) {
      opt.onProgress?.(2, 5, 'フックの音声生成');
      const dur = await synthOne(hookText, {voice: narration.voice, speed: narration.speed ?? persona.narration.speed, latency: narration.latency, out: path.join(narrDir, `${hookWavId}.wav`), signal: opt.signal});
      narration = {...narration, segments: narration.segments.map((s) => (s.id === hookWavId ? {...s, durSec: dur, needsTts: undefined} : s))};
      log(`  フックの音声を作りました: ${hookWavId}.wav ${dur.toFixed(2)}s`);
    } else if (hookWavId) {
      // トライアルで作った wav をそのまま使う（durSec も引き継ぐ）
      const trialNarr = path.join(trialDir(projectDir), `${key}.narration.json`);
      if (fs.existsSync(trialNarr)) {
        const prev = JSON.parse(fs.readFileSync(trialNarr, 'utf8')) as Narration;
        const seg = prev.segments.find((s) => s.id === hookWavId);
        if (seg?.durSec) narration = {...narration, segments: narration.segments.map((s) => (s.id === hookWavId ? {...s, durSec: seg.durSec, needsTts: undefined} : s))};
      }
    }
    if (tailNarration) {
      const t = applyTailNarration(narration, tailNarration, key);
      if (t.wavId) {
        opt.onProgress?.(2, 5, '締めの音声生成');
        const dur = await synthOne(tailNarration, {voice: narration.voice, speed: narration.speed ?? persona.narration.speed, latency: narration.latency, out: path.join(narrDir, `${t.wavId}.wav`), signal: opt.signal});
        narration = {...t.narration, segments: t.narration.segments.map((s) => (s.id === t.wavId ? {...s, durSec: dur, needsTts: undefined} : s))};
        log(`  締めのナレーション: 「${t.before}」→「${tailNarration}」 ${dur.toFixed(2)}s`);
        if (t.at !== null && t.at + dur > videoSec + 0.05) log(`  ! 締めのナレーションが動画の終わり（${videoSec.toFixed(2)} 秒）を ${(t.at + dur - videoSec).toFixed(2)} 秒はみ出します`);
      }
    }
    const narrFile = path.join(trialDir(projectDir), `${key}W.narration.json`);
    writeJsonAtomic(narrFile, narration);
    mixedRel = path.posix.join('out', `winner_${key}${suffix}_narration.mp4`);
    opt.onProgress?.(3, 5, 'ナレーション合成');
    const script = path.join(studioConfig.repoRoot, '.claude', 'skills', 'hiro-daihon', 'scripts', 'mix-narration.js');
    const mr = await exec(process.execPath, [script, narrFile, narrDir, path.join(projectDir, renderedRel), path.join(projectDir, mixedRel)], {
      cwd: projectDir,
      env: {...process.env, REEL_SFX_DIR: studioConfig.sfxDir},
      onLine: (l) => log(`  ${l}`),
      signal: opt.signal,
    });
    if (mr.code !== 0) throw new Error(`mix に失敗 (exit ${mr.code})`);
  } else log('  ! narration.json が無いので素材の音のままです');

  // ── 倍速 ──
  const spedRel = path.posix.join('out', `winner_${key}${suffix}_x${speed}_narration.mp4`);
  opt.onProgress?.(4, 5, `${speed} 倍速で書き出し`);
  await speedUpVideo(path.join(projectDir, mixedRel), path.join(projectDir, spedRel), speed, {fps: cuts.fps, onLine: (l) => log(`  ${l}`), signal: opt.signal});
  const probe = await countFrames(path.join(projectDir, spedRel));
  const sizeBytes = fs.statSync(path.join(projectDir, spedRel)).size;
  log(`  ${spedRel}: ${probe.durationSec.toFixed(2)} 秒（元 ${r.durationSec.toFixed(2)} 秒 → 見込み ${spedUpSec(r.durationSec, speed).toFixed(2)} 秒）`);

  // ── 納品 ──
  let deliveredAs: string | undefined;
  let captionAs: string | undefined;
  const outputsDir = studioConfig.outputsDir;
  if (opt.deliver !== false && !opt.draft) {
    fs.mkdirSync(outputsDir, {recursive: true});
    const label = opt.id ? `フック${key}_二次` : '二次';
    deliveredAs = deliverFileName({shop: brief.shop.name, persona: persona.id, kind: 'narration', label});
    fs.copyFileSync(path.join(projectDir, spedRel), path.join(outputsDir, deliveredAs));
    log(`  → ${deliveredAs}`);
    if (caption) {
      captionAs = deliverFileName({shop: brief.shop.name, persona: persona.id, kind: 'caption', label});
      fs.writeFileSync(path.join(outputsDir, captionAs), `${caption}\n`, 'utf8');
      log(`  → ${captionAs}`);
    }
    log('新しいトライアルリールとして投稿する（元の投稿と同じ文面のキャプションは使わない）');
  }
  opt.onProgress?.(5, 5, '完了');
  return {key, tailTelop, tailNarration, caption, speed, issues, outRel: spedRel, deliveredAs, captionAs, durationSec: probe.durationSec, sizeBytes, costUsd, outputsDir};
};
