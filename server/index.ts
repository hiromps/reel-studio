// Reel Studio server（express :4310）。API + SSE + 静的配信。dist/ があれば GUI も配信する。
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {studioConfig} from '../studio.config';
import {engineDiff, listProjects} from '../core/project';
import {exec} from '../core/exec';
import {pickFolder} from '../core/pick-folder';
import {ttsAvailable} from '../core/tts';
import {claudeAvailable} from '../core/agent';
import {settingsDir, settingsProblem} from '../core/settings';
import {JOB_TYPES} from './jobs';
import {projectsRouter} from './routes/projects';
import {filesRouter} from './routes/files';
import {planRouter} from './routes/plan';
import {captionRouter} from './routes/caption';
import {sfxRouter} from './routes/sfx';
import {hooksRouter} from './routes/hooks';
import {scriptRouter} from './routes/script';
import {ttsRouter} from './routes/tts';
import {framesRouter} from './routes/frames';
import {buildRouter} from './routes/build';
import {jobsRouter, eventsHandler} from './routes/jobs';
import {mediaRouter} from './routes/media';
import {settingsRouter} from './routes/settings';
import {versionRouter} from './routes/version';
import {personasRouter} from './routes/personas';
import {loadPersonasFromDisk, personasProblem} from '../core/personas-store';
import {listPersonas} from '../shared/personas';
import {state} from './state';
import {watchProject} from './watch';
import {resolveProjectDir} from '../core/project';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 人格は起動時に 1 回読む（無ければ同梱のサンプルで seed）。以後は Settings の保存で更新される
loadPersonasFromDisk();

// ── 「起動後にコードが変わった」検知 ────────────────────────────
// 画面（dist）はリクエストのたびに読み直されるのに対し、サーバーは起動時のコードで固まる。
// format-specs や validate の規則を直しても再起動するまで効かず、GUI からは見分けが付かないので、
// ソースの最終更新が起動時刻より新しければ GUI に警告を出させる。
const startedAtMs = Date.now();
const WATCHED_DIRS = ['shared', 'core', 'server'].map((d) => path.resolve(here, '..', d));

const newestMtimeMs = (p: string): number => {
  let newest = 0;
  const walk = (target: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(target);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(target)) walk(path.join(target, e));
      return;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  walk(p);
  return newest;
};

const sourceMtimeMs = (): number => Math.max(...WATCHED_DIRS.map(newestMtimeMs), newestMtimeMs(path.resolve(here, '..', 'studio.config.ts')));

// ローカル専用サーバーなので、外部サイトからの CSRF（勝手にファイルを書き換える・ダイアログを出す）を弾く。
// Origin が付かないリクエスト（CLI・curl）はそのまま通す。
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({error: `別オリジンからのリクエストは受け付けません: ${origin}`});
  next();
});

app.use(express.json({limit: '30mb'}));

app.get('/api/health', async (_req, res) => {
  const ver = async (cmd: string) => {
    try {
      const r = await exec(cmd, ['-version']);
      return r.stdout.split(/\r?\n/)[0] ?? '';
    } catch {
      return null;
    }
  };
  res.json({ok: true, node: process.version, ffmpeg: await ver('ffmpeg'), ffprobe: await ver('ffprobe'), freeMemMB: Math.round(os.freemem() / 1024 / 1024), totalMemMB: Math.round(os.totalmem() / 1024 / 1024)});
});

app.get('/api/config', (_req, res) => {
  res.json({
    dataRoot: studioConfig.dataRoot,
    workDir: studioConfig.workDir,
    uploadsRoot: studioConfig.uploadsRoot,
    outputsDir: studioConfig.outputsDir,
    sfxDir: studioConfig.sfxDir,
    templateDir: studioConfig.templateDir,
    settingsDir: settingsDir(),
    settingsProblem: settingsProblem(),
    personasProblem: personasProblem(),
    personas: listPersonas().length,
    port: studioConfig.port,
    // 画面（dist）はリクエストのたびに読み直されるのに対し、この一覧は起動時に固まる。
    // 新しいボタンが出ているのにジョブが弾かれる＝サーバーが古いプロセス、を GUI 側で検知させる
    jobTypes: [...JOB_TYPES],
    // true = 起動後にソースが変わっている＝このプロセスは古い規則で動いている
    stale: sourceMtimeMs() > startedAtMs,
    // 音声生成（Fish Audio）が使えるか。鍵そのものは返さない
    tts: ttsAvailable(),
    // 裏で走らせる claude が見つかっているか
    claude: claudeAvailable(),
    startedAt: new Date(startedAtMs).toISOString(),
    uploadsFolders: fs.existsSync(studioConfig.uploadsRoot) ? fs.readdirSync(studioConfig.uploadsRoot).filter((d) => fs.statSync(path.join(studioConfig.uploadsRoot, d)).isDirectory()) : [],
  });
});

/** エクスプローラーのフォルダ選択ダイアログ（同時に 1 つだけ開く） */
let picking = false;
app.post('/api/pick-folder', async (req, res) => {
  if (picking) return res.status(409).json({error: 'フォルダ選択ダイアログを既に開いています。開いているダイアログで選ぶかキャンセルしてください（他のウィンドウの後ろに隠れていることがあります）'});
  picking = true;
  try {
    const initial = typeof req.body?.initial === 'string' && req.body.initial ? req.body.initial : studioConfig.uploadsRoot;
    const r = await pickFolder(initial);
    res.json(r);
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  } finally {
    picking = false;
  }
});

app.use('/api/projects', projectsRouter);
app.use('/api/projects/:slug/files', filesRouter);
app.use('/api/projects/:slug', planRouter);
app.use('/api/projects/:slug', captionRouter);
app.use('/api/projects/:slug', hooksRouter);
app.use('/api/projects/:slug', scriptRouter);
app.use('/api/projects/:slug', framesRouter);
app.use('/api/projects/:slug', buildRouter);
app.use('/api/sfx', sfxRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/version', versionRouter);
app.use('/api/personas', personasRouter);
app.use('/api/jobs', jobsRouter);
app.get('/events', eventsHandler);
app.use(mediaRouter);

// 本番：dist/ を配信
const dist = path.join(here, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|events|uploads|fonts|studio|out|qc|p\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // work/ の外を指す slug は「サーバーの不具合」ではなく要求の誤り
  res.status(/案件名が不正です/.test(err.message) ? 400 : 500).json({error: err.message});
});

const host = process.env.REEL_STUDIO_HOST ?? '127.0.0.1';
const port = Number(process.env.REEL_STUDIO_PORT ?? studioConfig.port);

// 起動時：最新の案件を active にする
const initial = process.env.REEL_STUDIO_PROJECT ?? listProjects()[0]?.slug ?? null;
if (initial) {
  state.activeSlug = initial;
  watchProject(resolveProjectDir(initial));
}

app.listen(port, host, () => {
  console.log(`Reel Studio server: http://${host}:${port}  active=${state.activeSlug ?? '(none)'}  engine=${state.activeSlug ? (engineDiff(resolveProjectDir(state.activeSlug)).stale ? 'STALE' : 'ok') : '-'}`);
});
