// PC 常駐ワーカー。クラウド（Vercel の PWA）から来たジョブを、この PC で実行する。
//
//   npm run worker
//   npm run worker -- --auto   ショートカット（scripts/launch.mjs）からの自動起動。
//                              クラウド未設定なら黙って終わり、二重起動なら先客に譲る
//
// 通信は**この PC からの発信だけ**（ポートは開けない）。やることは 3 つ:
//   1. 生きていることと環境（ffmpeg / claude / 空きメモリ）を知らせる
//   2. 始められるジョブを 1 つもらって実行し、進捗とログを返す
//   3. 案件の契約ファイル・生成物（サムネ・軽量プロキシ・完成動画）を同期する
//
// 重い処理は既存の core/ がそのまま行う（ffmpeg・Remotion・Claude Code CLI）。
// つまり AI は今までどおりログイン済みの Claude Code を使い、API の従量課金は発生しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {exec} from '../core/exec';
import {claudeAvailable, claudeBin, claudeVersion, resetClaudeBin} from '../core/agent';
import {ttsAvailable, resetFishEnv} from '../core/tts';
import {resetInstagramMcpEnv} from '../core/instagram-mcp';
import {mosaicStatus, resetMosaicStatus} from '../core/mosaic';
import {listProjects, resolveProjectDir} from '../core/project';
import {loadSettings, mergeSettings, resetSettings, saveSettings, settingsView} from '../core/settings';
import {listFonts} from '../core/fonts';
import {loadPersonasFromDisk, savePersonas} from '../core/personas-store';
import {listPersonas, PersonaSchema, type Persona} from '../shared/personas';
import {readLibrary, writeLibrary} from '../core/sfx';
import {SettingsPatchSchema} from '../shared/schema/settings';
import {canStartJob} from '../shared/jobs';
import {runJobBody, type JobRunCtx} from '../server/jobs';
import type {CloudJob} from '../cloud/store';
import type {WorkerStatus} from '../cloud/worker-status';
import {CloudClient, CloudError, cloudConfig} from './client';
import {ensurePreviewProxies, runCatalogImport, runCreateProject, runFontJob, runIngest} from './cloud-jobs';
import {acquireWorkerLock, releaseWorkerLock, touchWorkerLock} from './lock';
import {pushProjectState, syncAssets, syncDocs, syncFonts} from './sync';

/** ショートカットからの自動起動（手で叩いたときと違い、やることが無ければ静かに終わる） */
const AUTO = process.argv.slice(2).includes('--auto');

const IDLE_MS = 15_000;
const BUSY_MS = 3_000;
/** 案件の棚卸し（全案件の同期）の間隔 */
const SWEEP_MS = 5 * 60_000;
/** 進捗・ログをまとめて送る間隔 */
const FLUSH_MS = 1200;
/** このジョブのあとは軽量プレビュー（スマホで見る用）の作り漏れを埋める */
const PREVIEW_AFTER = new Set(['catalog', 'mosaic', 'mosaic-revert', 'ingest']);

const log = (...a: unknown[]) => console.log(new Date().toLocaleTimeString('ja-JP'), ...a);

const version = async (cmd: string): Promise<string | null> => {
  try {
    const r = await exec(cmd, ['-version'], {timeoutMs: 10_000});
    return r.stdout.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
};

const uploadsFolders = (): string[] => {
  try {
    return fs.readdirSync(studioConfig.uploadsRoot).filter((d) => fs.statSync(path.join(studioConfig.uploadsRoot, d)).isDirectory());
  } catch {
    return [];
  }
};

type Env = {ffmpeg: string | null; ffprobe: string | null; claudeVersion: string | null};
let env: Env = {ffmpeg: null, ffprobe: null, claudeVersion: null};

const refreshEnv = async (): Promise<void> => {
  env = {
    ffmpeg: await version('ffmpeg'),
    ffprobe: await version('ffprobe'),
    claudeVersion: claudeAvailable() ? await claudeVersion() : null,
  };
};

const status = async (running: {slug: string; type: string}[]): Promise<Omit<WorkerStatus, 'lastSeen'>> => ({
  host: os.hostname(),
  node: process.version,
  ffmpeg: env.ffmpeg,
  ffprobe: env.ffprobe,
  claude: claudeAvailable(),
  claudeBin: claudeBin(),
  claudeVersion: env.claudeVersion,
  tts: ttsAvailable(),
  freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
  uploadsFolders: uploadsFolders(),
  mosaic: await mosaicStatus().catch(() => null),
  running,
});

// ───────────────────────── 画面で変えた設定を PC に反映する ─────────────────────────

let lastPersonasRev = 0;
let lastSfxRev = 0;

const applyRemoteChanges = async (client: CloudClient, reply: Awaited<ReturnType<CloudClient['hello']>>): Promise<void> => {
  // 設定（フォルダ・AI のモデル・顔モザイクの python など）
  if (reply.settingsPatch && Object.keys(reply.settingsPatch.patch).length) {
    const parsed = SettingsPatchSchema.safeParse(reply.settingsPatch.patch);
    if (parsed.success) {
      try {
        saveSettings(mergeSettings(loadSettings(), parsed.data));
        resetFishEnv();
        resetInstagramMcpEnv();
        resetClaudeBin();
        resetMosaicStatus();
        log('設定をクラウドからの指示で更新しました');
      } catch (e) {
        log('設定の更新に失敗:', (e as Error).message);
      }
    }
    await client.pushSettings(await currentSettingsView(), reply.settingsPatch.rev);
  }
  // 人格（画面で編集されたもの）。クラウドが正なので PC の personas.json を合わせる
  if (reply.personasRev && reply.personasRev !== lastPersonasRev) {
    lastPersonasRev = reply.personasRev;
    try {
      const {personas} = await client.pullPersonas();
      const list: Persona[] = [];
      for (const p of personas) {
        const r = PersonaSchema.safeParse(p);
        if (r.success) list.push(r.data);
      }
      if (list.length) {
        savePersonas(list);
        log(`人格を ${list.length} 件、クラウドに合わせました`);
      }
    } catch (e) {
      log('人格の取り込みに失敗:', (e as Error).message);
    }
  }
  // 効果音の設定（役割・trim・gain）
  if (reply.sfx && reply.sfx.rev !== lastSfxRev) {
    lastSfxRev = reply.sfx.rev;
    try {
      writeLibrary(reply.sfx.lib);
      log('効果音の設定をクラウドからの指示で更新しました');
    } catch (e) {
      log('効果音の設定の更新に失敗:', (e as Error).message);
    }
  }
};

const currentSettingsView = async () => {
  const available = claudeAvailable();
  return settingsView({bin: claudeBin(), available, source: 'path', version: available ? await claudeVersion() : null}, studioConfig.templateDir, listFonts());
};

// ───────────────────────── ジョブの実行 ─────────────────────────

const running = new Map<string, {slug: string; type: string; abort: AbortController}>();

/**
 * 画面の「最新に」ボタンから積まれる同期ジョブ。
 * 実体は**この前後で必ず走る** syncDocs（取り込み）と pushAfterJob（押し上げ）なので、ここは知らせるだけ。
 * 5 分ごとの棚卸しを待たずに、PC で直したものをスマホへ出すための入口。
 */
const runSync = (ctx: JobRunCtx): {ok: true} => {
  ctx.onLine('PC の最新をクラウドへ送ります（契約ファイル・サムネイル・軽量プレビュー・書き出し）');
  return {ok: true};
};

const runOne = async (client: CloudClient, job: CloudJob, blobToken: string | null): Promise<void> => {
  const abort = new AbortController();
  running.set(job.id, {slug: job.slug, type: job.type, abort});
  log(`▶ ${job.type} [${job.slug}] ${job.id}`);

  let buffer: string[] = [];
  let progress: {phase: string; done: number; total: number} | undefined;
  let stopped = false;
  const flush = async () => {
    if (!buffer.length && !progress) return;
    const lines = buffer;
    const p = progress;
    buffer = [];
    progress = undefined;
    try {
      const r = await client.progress(job.id, {lines: lines.length ? lines : undefined, progress: p});
      if (r.cancelRequested && !abort.signal.aborted) {
        log(`■ 中断の指示: ${job.id}`);
        abort.abort();
      }
    } catch (e) {
      // 送れなくてもジョブは続ける（次の周回でまとめて送る）
      buffer = [...lines, ...buffer];
      void e;
    }
  };
  const timer = setInterval(() => void flush(), FLUSH_MS);

  const ctx: JobRunCtx = {
    onLine: (l) => {
      buffer.push(l);
      if (buffer.length > 400) buffer.splice(0, buffer.length - 400);
    },
    onProgress: (p) => {
      progress = p;
    },
    signal: abort.signal,
  };

  try {
    // ジョブが読む契約ファイルを、実行前にクラウドと合わせる
    if (job.type !== 'create-project' && job.type !== 'ingest' && job.type !== 'fonts' && job.slug !== '_studio') {
      const dir = resolveProjectDir(job.slug);
      // 案件が PC に無いなら、ここで止める。先へ進めると「何もしなかったのに成功」になる種類の
      // ジョブ（sync-engine など）があり、原因が分からなくなる
      if (!fs.existsSync(dir)) throw new Error(`この PC に案件フォルダがありません: ${dir}\n  （案件名が合っているか、データフォルダの設定が合っているかを確認してください）`);
      const r = await syncDocs(client, dir);
      if (r.pulled.length) ctx.onLine(`クラウドから取り込み: ${r.pulled.join(', ')}`);
      if (r.conflicted.length) ctx.onLine(`※ 衝突（PC 側は .studio/conflicts/ に退避）: ${r.conflicted.join(', ')}`);
    }

    const result =
      job.type === 'create-project'
        ? await runCreateProject(job.slug, job.params, ctx)
        : job.type === 'ingest'
          ? await runIngest(job.slug, job.params, ctx)
          : job.type === 'fonts'
            ? await runFontJob(job.params, ctx)
            : job.type === 'catalog-import'
              ? await runCatalogImport(job.slug, job.params, ctx)
              : job.type === 'sync'
                ? runSync(ctx)
                : await runJobBody({type: job.type as Parameters<typeof runJobBody>[0]['type'], slug: job.slug, params: job.params}, ctx);

    // 取り込んだ・消したフォントは、その場でクラウドへ反映する（スマホの一覧と見本に出す）
    if (job.type === 'fonts' && !abort.signal.aborted) {
      try {
        await client.pushSettings(await currentSettingsView());
        if (blobToken) await syncFonts(client, blobToken, {onLine: ctx.onLine});
      } catch (e) {
        ctx.onLine(`※ フォントの反映に失敗: ${(e as Error).message}（次の同期で入ります）`);
      }
    }

    // カタログ化・モザイクで素材が増えた／差し替わったら、スマホで見るための軽量プレビューを作る。
    // クラウドには原本 4K を上げないので、これが無いと Timeline のプレビューが真っ黒になる
    if (!abort.signal.aborted && PREVIEW_AFTER.has(job.type)) {
      try {
        await ensurePreviewProxies(job.slug, ctx);
      } catch (e) {
        ctx.onLine(`※ 軽量プレビューの作成に失敗: ${(e as Error).message}`);
      }
    }

    clearInterval(timer);
    stopped = true;
    // 結果（契約ファイルの更新・生成物）をクラウドへ返す
    await pushAfterJob(client, job, blobToken, ctx.onLine);
    await flush();
    await client.finish(job.id, {status: abort.signal.aborted ? 'cancelled' : 'done', result, lines: buffer.length ? buffer : undefined});
    log(`✔ ${job.type} [${job.slug}] ${job.id}`);
  } catch (e) {
    clearInterval(timer);
    stopped = true;
    const message = e instanceof Error ? e.message : String(e);
    try {
      await pushAfterJob(client, job, blobToken, ctx.onLine);
    } catch {
      /* 失敗したジョブでも、できたところまでは上げる */
    }
    await flush();
    await client.finish(job.id, {status: abort.signal.aborted ? 'cancelled' : 'failed', error: message, lines: buffer.length ? buffer : undefined});
    log(`✖ ${job.type} [${job.slug}] ${job.id}: ${message}`);
  } finally {
    if (!stopped) clearInterval(timer);
    running.delete(job.id);
  }
};

const pushAfterJob = async (client: CloudClient, job: CloudJob, blobToken: string | null, onLine: (l: string) => void): Promise<void> => {
  if (job.type === 'ingest' || job.slug === '_studio') return;
  const dir = resolveProjectDir(job.slug);
  if (!fs.existsSync(dir)) return;
  const r = await syncDocs(client, dir);
  if (r.pushed.length) onLine(`クラウドへ反映: ${r.pushed.join(', ')}`);
  await pushProjectState(client, dir);
  if (blobToken) {
    const a = await syncAssets(client, dir, blobToken, {onLine});
    if (a.uploaded) onLine(`メディアを ${a.uploaded} 件アップロードしました（${(a.bytes / 1024 / 1024).toFixed(1)} MB）`);
  }
};

// ───────────────────────── 全案件の棚卸し ─────────────────────────

let lastSweep = 0;
/**
 * 棚卸しは**待たずに走らせる**。初回は案件ぶんのサムネイルを上げるので何分もかかることがあり、
 * その間ループを止めると「生きている」の報告もジョブの取得も止まってしまう（画面には PC オフラインと出る）。
 */
let sweeping = false;

const sweep = async (client: CloudClient, blobToken: string | null): Promise<void> => {
  lastSweep = Date.now();
  const projects = listProjects();
  let done = 0;
  for (const p of projects) {
    // ジョブが始まったら譲る（同じ案件の契約ファイルを取り合わない）。残りは次の周回で
    if (running.size) {
      log(`同期を中断（ジョブが始まりました）: ${done}/${projects.length} 件まで`);
      return;
    }
    try {
      await syncDocs(client, p.dir);
      await pushProjectState(client, p.dir);
      if (blobToken) await syncAssets(client, p.dir, blobToken, {limit: 120});
      done++;
    } catch (e) {
      log(`同期に失敗 [${p.slug}]:`, (e as Error).message);
    }
  }
  try {
    await client.pushPersonas(listPersonas());
    await client.pushSfx(readLibrary());
    await client.pushSettings(await currentSettingsView());
    // 自前フォント（スマホのプレビューで PC と同じ絵を出すため）
    if (blobToken) {
      const f = await syncFonts(client, blobToken);
      if (f.uploaded) log(`フォントを ${f.uploaded} 件アップロードしました`);
    }
  } catch (e) {
    log('設定の同期に失敗:', (e as Error).message);
  }
  log(`同期しました（案件 ${done}/${projects.length} 件）`);
};

// ───────────────────────── 本体 ─────────────────────────

const main = async (): Promise<void> => {
  const cfg = cloudConfig();
  if (!cfg) {
    // ローカル専用で使っている人には要らない機能なので、自動起動のときは止めない
    if (AUTO) return log('クラウド接続が未設定なので、スマホ用のワーカーは動かしません（ローカルでの利用には影響しません）');
    console.error(
      [
        'クラウドの接続先が未設定です。次のどちらかを設定してください:',
        '  1) Settings（PC の画面）の「クラウド接続」に URL と ワーカートークン を入れる',
        '  2) 環境変数 REEL_CLOUD_URL と REEL_WORKER_TOKEN を設定する',
        '',
        'トークンは Vercel の環境変数 WORKER_TOKEN と同じ値です。',
      ].join('\n'),
    );
    process.exit(1);
  }
  const other = await acquireWorkerLock();
  if (other !== null) return log(`ワーカーはすでに動いています（pid ${other}）。こちらは起動しません`);
  process.on('exit', releaseWorkerLock);

  loadPersonasFromDisk();
  await refreshEnv();
  const client = new CloudClient(cfg);
  log(`Reel Studio ワーカー起動: ${cfg.url}`);
  log(`  ffmpeg=${env.ffmpeg ? 'ok' : '無し'} claude=${claudeAvailable() ? 'ok' : '無し'} 案件=${listProjects().length} 件`);

  let blobToken: string | null = null;
  let backoff = 0;

  const stop = () => {
    log('終了します（走っているジョブを中断）');
    for (const r of running.values()) r.abort.abort();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (;;) {
    touchWorkerLock(); // 生きているあいだは錠を新しく保つ
    try {
      const reply = await client.hello(await status([...running.values()].map((r) => ({slug: r.slug, type: r.type}))));
      blobToken = reply.blobToken;
      backoff = 0;
      await applyRemoteChanges(client, reply);

      // 待たない（上の hello とジョブの取得を止めないため）
      if (!sweeping && running.size === 0 && Date.now() - lastSweep > SWEEP_MS) {
        sweeping = true;
        void sweep(client, blobToken).finally(() => {
          sweeping = false;
        });
      }

      const {job} = await client.claim(
        [...running.values()].map((r) => ({slug: r.slug, type: r.type})),
        studioConfig.jobs.maxConcurrent,
      );
      if (job) {
        // 実行は待たない（同時に走らせてよい組み合わせはクラウド側が canStartJob で判定済み）
        void runOne(client, job, blobToken);
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    } catch (e) {
      const msg = e instanceof CloudError ? `${e.status} ${e.message}` : (e as Error).message;
      backoff = Math.min(backoff ? backoff * 2 : 5_000, 120_000);
      log(`クラウドに繋がりません（${backoff / 1000} 秒後に再試行）: ${msg}`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    await new Promise((r) => setTimeout(r, running.size ? BUSY_MS : IDLE_MS));
  }
};

// 設定を読み直してから始める（起動直前に Settings で変えていることがある）
resetSettings();
void main();
