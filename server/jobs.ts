// ジョブキュー。ログはリングバッファ、進捗・完了は EventEmitter で SSE へ流す。
// 案件が違えば同時に走らせる（複数案件を並行して進めるため）。同じ案件で 2 本、
// および重いジョブ（ffmpeg / Remotion）の 2 本並走は禁止 — canStart を参照。
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildCatalog, loadCatalog, saveCatalog} from '../core/catalog';
import {makeProxy, makePreviewProxy, needsProxy} from '../core/proxy';
import {makeThumbnails, makeQcTile} from '../core/thumbnails';
import {ffprobe} from '../core/ffprobe';
import {renderProject, renderStill} from '../core/render';
import {npmInstall, resolveProjectDir, syncEngine, readCuts, writeCuts} from '../core/project';
import {applyAliases} from '../core/alias';
import {aiCaption, aiEdit, aiFacts, aiNarration, aiOrder, aiTag, aiTelop} from '../core/ai';
import {claudeAvailable, claudeBin} from '../core/agent';
import {generateTts} from '../core/tts';
import {autoPlaceSfx, scanLibrary} from '../core/sfx';
import {deliver} from '../core/deliver';
import {runTrial} from '../core/trial';
import {aiHooks} from '../core/ai-trial';
import {runWinner} from '../core/winner';
import {aiScript} from '../core/script';
import {mixNarration} from '../core/mix';
import {runBuild} from '../core/build';
import {applyMosaic, revertMosaic, setupMosaic} from '../core/mosaic';
import type {MosaicParams} from '../shared/mosaic';
import type {BuildStepId} from '../shared/build';
import type {SfxRole} from '../shared/sfx';
import {formatOrderCheck} from '../shared/order';
import {studioConfig} from '../studio.config';
import {canStartJob, type JobType} from '../shared/jobs';

export {JOB_TYPES, type JobType} from '../shared/jobs';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type Job = {
  id: string;
  type: JobType;
  slug: string;
  params: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  progress?: {phase: string; done: number; total: number};
  log: string[];
  result?: unknown;
  error?: string;
};

const LOG_KEEP = 800;

class JobQueue extends EventEmitter {
  jobs: Job[] = [];
  private running = new Map<string, Job>();
  private aborts = new Map<string, AbortController>();

  add(type: JobType, slug: string, params: Record<string, unknown> = {}): Job {
    const job: Job = {id: randomUUID().slice(0, 8), type, slug, params, status: 'queued', createdAt: new Date().toISOString(), log: []};
    this.jobs.unshift(job);
    if (this.jobs.length > 50) this.jobs.length = 50;
    this.emit('job', this.publicJob(job));
    this.pump();
    return job;
  }

  get(id: string) {
    return this.jobs.find((j) => j.id === id);
  }

  list() {
    return this.jobs.map((j) => this.publicJob(j));
  }

  publicJob(j: Job) {
    return {...j, log: undefined, logTail: j.log.slice(-5)};
  }

  cancel(id: string): boolean {
    const j = this.get(id);
    if (!j) return false;
    if (j.status === 'queued') {
      j.status = 'cancelled';
      j.endedAt = new Date().toISOString();
      this.emit('job', this.publicJob(j));
      return true;
    }
    if (j.status === 'running') {
      this.aborts.get(id)?.abort();
      return true;
    }
    return false;
  }

  private log(job: Job, line: string) {
    job.log.push(line);
    if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP);
    this.emit('log', {jobId: job.id, line});
  }

  private progress(job: Job, p: {phase: string; done: number; total: number}) {
    job.progress = p;
    this.emit('progress', {jobId: job.id, ...p});
  }

  /** いま走っているジョブの一覧（デバッグ・テスト用） */
  runningJobs(): Job[] {
    return [...this.running.values()];
  }

  private canStart(job: Job): boolean {
    return canStartJob(job, this.runningJobs(), studioConfig.jobs.maxConcurrent);
  }

  private pump() {
    // 追加順（jobs は unshift なので末尾が最も古い）に、始められるものから始める
    for (const next of [...this.jobs].reverse()) {
      if (next.status !== 'queued' || !this.canStart(next)) continue;
      void this.start(next);
    }
  }

  private async start(job: Job) {
    this.running.set(job.id, job);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.emit('job', this.publicJob(job));
    const ac = new AbortController();
    this.aborts.set(job.id, ac);
    try {
      job.result = await this.run(job, ac.signal);
      job.status = ac.signal.aborted ? 'cancelled' : 'done';
    } catch (e) {
      job.status = ac.signal.aborted ? 'cancelled' : 'failed';
      job.error = e instanceof Error ? e.message : String(e);
      this.log(job, `ERROR: ${job.error}`);
    } finally {
      job.endedAt = new Date().toISOString();
      this.aborts.delete(job.id);
      this.running.delete(job.id);
      this.emit('job', this.publicJob(job));
      this.pump();
    }
  }

  private run(job: Job, signal: AbortSignal): Promise<unknown> {
    return runJobBody(job, {onLine: (l) => this.log(job, l), onProgress: (pr) => this.progress(job, pr), signal});
  }
}

export const jobs = new JobQueue();

/** ジョブ 1 本の中身。実行主体（ローカルのキュー／クラウドのワーカー）から切り離してある */
export type JobRunCtx = {
  onLine: (line: string) => void;
  onProgress: (p: {phase: string; done: number; total: number}) => void;
  signal: AbortSignal;
};

export async function runJobBody(job: {type: JobType; slug: string; params: Record<string, unknown>}, ctx: JobRunCtx): Promise<unknown> {
  const dir = resolveProjectDir(job.slug);
  const {onLine, signal} = ctx;
  const p = job.params;
  switch (job.type) {
      case 'catalog': {
        const materialsDir = (p.materialsDir as string | undefined) ?? loadCatalog(dir)?.materialsDir;
        if (!materialsDir) throw new Error('materialsDir が未指定');
        const r = await buildCatalog({
          materialsDir: path.resolve(materialsDir),
          projectDir: dir,
          slug: path.basename(dir),
          proxy: p.proxy !== false,
          thumbs: p.thumbs !== false,
          scenes: !!p.scenes,
          speech: !!p.speech,
          force: !!p.force,
          onLine,
          onProgress: (done, total, label) => ctx.onProgress({phase: label, done, total}),
        });
        for (const w of r.warnings) onLine(`W ${w}`);
        return {clips: r.catalog.clips.length, changed: r.changed.length, warnings: r.warnings};
      }
      // 裏で claude を走らせる。書き込みは core/ai.ts 側が zod 検証を通してから行う
      case 'ai-tag': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiTag(dir, {
          force: !!p.force,
          batchSize: typeof p.batchSize === 'number' ? p.batchSize : undefined,
          concurrency: typeof p.concurrency === 'number' ? p.concurrency : undefined,
          model: typeof p.model === 'string' ? p.model : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {tagged: r.tagged.length, batches: r.batches, costUsd: r.costUsd, facts: r.facts.length};
      }
      case 'ai-order': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiOrder(dir, {
          write: p.write !== false,
          copy: p.copy !== false,
          force: !!p.force,
          model: typeof p.model === 'string' ? p.model : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        onLine(formatOrderCheck(r.check));
        if (!r.applied) throw new Error(`並びに E があるので書いていません:\n${r.check.findings.filter((f) => f.severity === 'E').map((f) => `  ${f.code} ${f.message}`).join('\n')}`);
        return {applied: true, written: r.written, cuts: r.plan?.cuts.cuts.length ?? 0, costUsd: r.costUsd, notes: r.notes, losesFinalTelops: r.losesFinalTelops};
      }
      case 'ai-telop': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiTelop(dir, {
          force: !!p.force,
          model: typeof p.model === 'string' ? p.model : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        if (r.skipped.length) onLine(`skipped: ${r.skipped.join('; ')}`);
        return {filled: r.filled.length, costUsd: r.costUsd, notes: r.notes, placeholders: r.validation?.summary.placeholders ?? 0};
      }
      case 'ai-narration': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiNarration(dir, {
          model: typeof p.model === 'string' ? p.model : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {blocks: r.blocks.length, findings: r.findings, costUsd: r.costUsd, notes: r.notes};
      }
      // 自然言語の台本 → cuts.json + narration.json（型ではなく台本が正）
      case 'ai-script': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const write = p.write !== false;
        const r = await aiScript(dir, {
          model: typeof p.model === 'string' ? p.model : undefined,
          write,
          force: !!p.force,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        // 「割り当てを見るだけ」（write: false）は書かないのが正常。以前はここで失敗扱いにしていて、
        // E が 0 件でも「検算で E が出たので書いていません:」で終わり、結果も捨てていた
        if (write && !r.written)
          throw new Error(
            `検算で E が出たので書いていません:\n${r.issues.filter((i) => i.severity === 'E').map((i) => `  ${i.message}`).join('\n')}\n  結果は Brief の「割り当ての結果」で確認できます`,
          );
        return {written: r.written, cuts: r.plan.cuts.length, narration: r.plan.narration.length, totalSec: r.totalSec, issues: r.issues, unmatched: r.plan.unmatched, costUsd: r.costUsd, notes: r.plan.notes};
      }
      case 'ai-caption': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiCaption(dir, {
          model: typeof p.model === 'string' ? p.model : undefined,
          instruction: typeof p.instruction === 'string' ? p.instruction : undefined,
          research: p.research !== false,
          researchForce: !!p.researchForce,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {chars: [...r.caption].length, issues: r.issues, missing: r.missing, costUsd: r.costUsd, notes: r.notes, factsAdded: r.research?.added.length ?? 0, conflicts: r.research?.conflicts ?? []};
      }
      // 店舗情報を Web で裏取りして brief.facts に入れる（Instagram > Google マップ）
      case 'ai-facts': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiFacts(dir, {
          model: typeof p.model === 'string' ? p.model : undefined,
          force: !!p.force,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {added: r.added, kept: r.kept, conflicts: r.conflicts, unresolved: r.unresolved, instagram: r.instagram, costUsd: r.costUsd};
      }
      case 'ai-edit': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const instruction = typeof p.instruction === 'string' ? p.instruction : '';
        const r = await aiEdit(dir, instruction, {
          model: typeof p.model === 'string' ? p.model : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {summary: r.summary, applied: r.applied, unapplied: r.unapplied, needsTts: r.needsTts, costUsd: r.costUsd, placeholders: r.validation?.summary.placeholders};
      }
      // Fish Audio を直接叩いて narration/<id>.wav を作る（Claude は挟まない）
      case 'tts': {
        const r = await generateTts(dir, {
          force: !!p.force,
          ids: Array.isArray(p.ids) ? (p.ids as string[]) : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {made: r.made.length, skipped: r.skipped.length, chars: r.chars, modelId: r.modelId};
      }
      // 効果音（効果音ラボ等）。ライブラリの棚卸しと、cuts.json からの自動配置
      case 'sfx-scan': {
        const r = await scanLibrary({onLine});
        return {sounds: r.lib.sounds.length, added: r.added, removed: r.removed, noRole: r.lib.sounds.filter((x) => !x.roles.length).length};
      }
      case 'sfx-auto': {
        const r = await autoPlaceSfx(dir, {
          max: typeof p.max === 'number' ? p.max : undefined,
          minGapSec: typeof p.minGapSec === 'number' ? p.minGapSec : undefined,
          exclude: Array.isArray(p.exclude) ? (p.exclude as SfxRole[]) : undefined,
          onLine,
        });
        return {placed: r.sfx.length, candidates: r.candidates, missing: r.missing, issues: r.issues};
      }
      // 完成品を outputs/ へ。draft と音声なしは出さない（作業用なので案件フォルダに置いたまま）
      case 'deliver': {
        const r = await deliver(dir, {
          label: typeof p.label === 'string' ? p.label : undefined,
          allowSilent: !!p.allowSilent,
          overwrite: !!p.overwrite,
          onLine,
        });
        return {
          files: r.items.map((x) => ({name: path.basename(x.to), kind: x.kind, mb: Math.round((x.bytes / 1024 / 1024) * 10) / 10, skipped: x.skipped})),
          outputsDir: r.outputsDir,
          warnings: r.warnings,
        };
      }
      // トライアルリールのフック案（A は今の形・B/C は別の切り口）とパターン別キャプションを hooks.json に書く
      case 'ai-hooks': {
        if (!claudeAvailable()) throw new Error(`claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
        const r = await aiHooks(dir, {
          count: typeof p.count === 'number' ? p.count : undefined,
          cutCount: typeof p.cutCount === 'number' ? p.cutCount : undefined,
          fresh: !!p.fresh,
          force: !!p.force,
          model: typeof p.model === 'string' ? p.model : undefined,
          instruction: typeof p.instruction === 'string' ? p.instruction : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {
          variants: r.hooks.variants.map((v) => ({id: v.id, angle: v.angle, label: v.label, telops: v.telops, narration: v.narration, captionChars: [...v.caption].length, why: r.why[v.id]})),
          cutCount: r.cutCount,
          spanSec: r.spanSec,
          issues: r.issues,
          costUsd: r.costUsd,
          notes: r.notes,
        };
      }
      // 勝ちパターンの二次活用：締めだけ変えて倍速で書き出し直し、新しいキャプションで納品
      case 'winner': {
        const r = await runWinner(dir, {
          id: typeof p.id === 'string' && p.id ? p.id : undefined,
          tailTelop: typeof p.tailTelop === 'string' ? p.tailTelop : undefined,
          tailNarration: typeof p.tailNarration === 'string' ? p.tailNarration : undefined,
          caption: typeof p.caption === 'string' ? p.caption : undefined,
          speed: typeof p.speed === 'number' ? p.speed : undefined,
          draft: !!p.draft,
          deliver: p.deliver !== false,
          gl: typeof p.gl === 'string' ? p.gl : undefined,
          force: !!p.force,
          allowErrors: !!p.allowErrors,
          model: typeof p.model === 'string' ? p.model : undefined,
          instruction: typeof p.instruction === 'string' ? p.instruction : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {key: r.key, tailTelop: r.tailTelop, tailNarration: r.tailNarration, speed: r.speed, outRel: r.outRel, deliveredAs: r.deliveredAs, captionAs: r.captionAs, durationSec: r.durationSec, mb: Math.round((r.sizeBytes / 1024 / 1024) * 10) / 10, issues: r.issues, costUsd: r.costUsd};
      }
      // トライアルリール：フックだけ差し替えた複数バージョン（レンダー→音声→mix→納品）
      case 'trial': {
        const r = await runTrial(dir, {
          ids: Array.isArray(p.ids) ? (p.ids as string[]) : undefined,
          deliver: p.deliver !== false,
          draft: !!p.draft,
          gl: typeof p.gl === 'string' ? p.gl : undefined,
          force: !!p.force,
          allowErrors: !!p.allowErrors,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {
          items: r.items.map((x) => ({id: x.id, label: x.label, changes: x.changes, outRel: x.outRel, deliveredAs: x.deliveredAs, captionAs: x.captionAs, mb: Math.round((x.sizeBytes / 1024 / 1024) * 10) / 10, durationSec: x.durationSec})),
          warnings: r.warnings,
          outputsDir: r.outputsDir,
        };
      }
      case 'thumbs': {
        const c = loadCatalog(dir);
        if (!c) throw new Error('catalog.json が無い');
        const sdir = path.join(dir, studioConfig.studioDirName);
        let i = 0;
        for (const clip of c.clips) {
          if (signal.aborted) break;
          ctx.onProgress({phase: clip.original, done: i++, total: c.clips.length});
          try {
            clip.thumbs = await makeThumbnails(path.join(dir, 'public', clip.src), path.join(sdir, 'thumbs'), path.join(sdir, 'strips'), clip.id, clip.probe.durationSec);
            onLine(`${clip.id} ${clip.thumbs.strip.length} 枚`);
          } catch (e) {
            // 1 本の失敗で残り全部を落とさない
            onLine(`W ${clip.id} ${clip.original}: thumbs 失敗 — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        saveCatalog(dir, c);
        return {clips: c.clips.length};
      }
      case 'proxy': {
        const c = loadCatalog(dir);
        if (!c) throw new Error('catalog.json が無い');
        let made = 0;
        for (const clip of c.clips) {
          if (signal.aborted) break;
          const abs = path.join(dir, 'public', clip.src);
          const need = needsProxy(clip.probe);
          if (!need.needed && !p.force) continue;
          // 顔モザイク版はプロキシと同じ形式（H.264 1080x1920）で書き出してある。作り直すと元に戻せなくなる
          if (clip.mosaic?.applied) {
            onLine(`${clip.id} 顔モザイク済みなので飛ばします（元に戻してから作り直してください）`);
            continue;
          }
          const out = abs.replace(/\.[^.]+$/, '') + (abs.endsWith('.mp4') ? '.proxy.mp4' : '.mp4');
          onLine(`${clip.id} proxy (${need.reason ?? 'force'}) → ${path.basename(out)}`);
          await makeProxy(abs, out, clip.probe, {onLine: (l) => onLine(`  ${l}`)});
          if (out !== abs) {
            fs.rmSync(abs, {force: true});
            const rel = `uploads/${path.basename(out)}`;
            clip.src = rel;
          }
          clip.probe = await ffprobe(out);
          made++;
        }
        saveCatalog(dir, c);
        return {made};
      }
      case 'preview-proxy': {
        const c = loadCatalog(dir);
        if (!c) throw new Error('catalog.json が無い');
        const outDir = path.join(dir, studioConfig.studioDirName, 'preview');
        let i = 0;
        for (const clip of c.clips) {
          if (signal.aborted) break;
          ctx.onProgress({phase: clip.original, done: i++, total: c.clips.length});
          const out = path.join(outDir, path.basename(clip.src));
          if (fs.existsSync(out) && !p.force) continue;
          onLine(`${clip.id} preview → ${path.basename(out)}`);
          await makePreviewProxy(path.join(dir, 'public', clip.src), out, clip.probe);
        }
        return {ok: true};
      }
      case 'render':
      case 'draft': {
        const r = await renderProject({
          projectDir: dir,
          draft: job.type === 'draft',
          out: p.out as string | undefined,
          gl: p.gl as string | undefined,
          concurrency: p.concurrency as number | undefined,
          crf: p.crf as number | undefined,
          cacheBytes: p.cacheBytes as number | undefined,
          retries: p.retries as number | undefined,
          force: !!p.force,
          allowErrors: !!p.allowErrors,
          noSync: !!p.noSync,
          strictProxy: !!p.strictProxy,
          onLine,
          onProgress: (pr) => ctx.onProgress(pr),
          signal,
        });
        return {...r, validation: undefined, outRel: path.relative(dir, r.outPath).replace(/\\/g, '/'), qcTileRel: r.qcTile ? path.relative(dir, r.qcTile).replace(/\\/g, '/') : undefined};
      }
      case 'still': {
        const r = await renderStill(dir, {cut: p.cut as number | undefined, frame: p.frame as number | undefined, offsetSec: p.offsetSec as number | undefined, gl: p.gl as string | undefined, onLine});
        return {...r, outRel: path.relative(dir, r.out).replace(/\\/g, '/')};
      }
      case 'qc-tile': {
        const video = path.join(dir, (p.video as string | undefined) ?? 'out/final.mp4');
        const out = await makeQcTile(video, path.join(dir, 'qc', `${path.basename(video, path.extname(video))}-tile.png`));
        return {outRel: path.relative(dir, out).replace(/\\/g, '/')};
      }
      case 'sync-engine':
        return syncEngine(dir);
      case 'npm-install': {
        const ok = await npmInstall(dir, onLine);
        if (!ok) throw new Error('npm install に失敗');
        return {ok};
      }
      case 'aliases': {
        const cuts = readCuts(dir);
        const done = applyAliases(dir, cuts);
        writeCuts(dir, cuts);
        return {applied: done.length};
      }
      case 'mix': {
        // scripts/mix-narration.js（hiro スキル同梱）。足りないものは core/mix.ts が日本語で止める
        return mixNarration(dir, {input: p.input as string | undefined, output: p.output as string | undefined, onLine, signal});
      }
      // 仕上げ：選んだ工程（原稿 → 音声 → レンダー → mix → 納品）を順に走らせる
      case 'build': {
        const steps = (Array.isArray(p.steps) ? (p.steps as string[]) : []) as BuildStepId[];
        const r = await runBuild(dir, {
          steps,
          model: typeof p.model === 'string' ? p.model : undefined,
          allowErrors: !!p.allowErrors,
          label: typeof p.label === 'string' ? p.label : undefined,
          gl: typeof p.gl === 'string' ? p.gl : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {ran: r.ran, skipped: r.skipped, delivered: r.delivered, costUsd: r.costUsd, outRel: r.outRel};
      }
      // 顔モザイク（deface）。src の中身をモザイク版に差し替える（元は .studio/mosaic/originals/ に退避）
      case 'mosaic': {
        const r = await applyMosaic(dir, {
          ids: Array.isArray(p.ids) ? (p.ids as unknown[]).map(String) : [],
          params: p.params && typeof p.params === 'object' ? (p.params as Partial<MosaicParams>) : undefined,
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done: Math.round(done), total}),
          signal,
        });
        const count = (k: string) => r.items.filter((i) => i.result === k).length;
        return {applied: count('applied'), noFaces: count('no-faces'), restored: count('restored'), failed: count('failed'), items: r.items, engine: r.engine};
      }
      case 'mosaic-revert': {
        const r = await revertMosaic(dir, {
          ids: Array.isArray(p.ids) ? (p.ids as unknown[]).map(String) : [],
          onLine,
          onProgress: (done, total, phase) => ctx.onProgress({phase, done, total}),
          signal,
        });
        return {reverted: r.items.filter((i) => i.result === 'reverted').length, items: r.items};
      }
      // deface を <設定の置き場>/deface-venv に入れる（案件に属さない）
      case 'mosaic-setup': {
        const r = await setupMosaic({gpu: !!p.gpu, onLine, signal});
        return {venvDir: r.venvDir, deface: r.status.deface, onnxruntime: r.status.onnxruntime, gpu: r.status.gpu, message: r.status.message};
      }
    default:
      throw new Error(`未知のジョブ: ${job.type}`);
  }
}
