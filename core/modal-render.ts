import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {settingsDir} from './settings';
import {modalFetch, modalJson, ModalError} from './modal-client';
import {readCuts, readNarration} from './project';
import {fontsDir} from './fonts';
import {loadCatalog} from './catalog';
import {studioConfig} from '../studio.config';
import {ModalRenderInputSchema, ModalRenderNarrationSchema, ModalSessionInputSchema, MODAL_UPLOAD_CHUNK, safeModalAsset, modalAudioFingerprint, type ModalRenderProject, type ModalSession} from '../shared/modal-render';
import {cloudConfig, CloudClient} from '../worker/client';

const mappingFile = () => path.join(settingsDir(), 'modal-render-projects.json');
export const localModalRenderProjects = (): Record<string, ModalRenderProject> => {
  try {return JSON.parse(fs.readFileSync(mappingFile(), 'utf8'));} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ModalError('クラウド素材の索引を読み込めません', 503);}
};
export const setLocalModalRenderProject = (slug: string, value: ModalRenderProject | null) => {
  const all = localModalRenderProjects();
  if (value) all[slug] = value; else delete all[slug];
  fs.mkdirSync(settingsDir(), {recursive: true});
  const tmp = mappingFile() + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all), {mode: 0o600}); fs.renameSync(tmp, mappingFile());
};
/** Refuse links and traverse only files inside an explicitly selected media root. */
export const checkedModalFile = (root: string, rel: string): string => {
  const base = path.resolve(root), file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) throw new ModalError('素材のパスが不正です', 400);
  let at = base;
  for (const part of path.relative(base, file).split(path.sep)) {
    at = path.join(at, part);
    if (fs.lstatSync(at).isSymbolicLink()) throw new ModalError('リンクされた素材はアップロードできません', 400);
  }
  if (!fs.statSync(file).isFile()) throw new ModalError('素材ファイルがありません', 400);
  return file;
};
export const localRenderSnapshot = (dir: string) => {
  const cuts = readCuts(dir);
  let narration: unknown = null;
  if (fs.existsSync(path.join(dir, 'narration.json'))) {
    const n = readNarration(dir);
    if (n && (n.segments.length || n.sfx?.length)) narration = ModalRenderNarrationSchema.parse(n);
  }
  const parsed = ModalRenderInputSchema.safeParse({kind: 'remotion-render', sessionId: randomUUID(), requestId: randomUUID(), allowGpu: true, cuts, narration});
  if (!parsed.success) throw new ModalError('編集内容を確認してください。書き出しは180秒以内です。ナレーションは先に音声を生成し、変更を保存してください', 400);
  const files = new Map<string, string>();
  const add = (logical: string, base: string, rel: string) => {
    if (!safeModalAsset(logical)) throw new ModalError('素材名を確認してください', 400);
    files.set(logical, checkedModalFile(base, rel));
  };
  for (const cut of cuts.cuts) add(cut.src, path.join(dir, 'public'), cut.src);
  for (const clip of loadCatalog(dir)?.clips ?? []) add(clip.src, path.join(dir, 'public'), clip.src);
  if (cuts.font) {
    const projectFont = path.join(dir, 'public/fonts', cuts.font);
    const fallback = cuts.font === 'NotoSerifJP-Bold.ttf' ? path.join(studioConfig.templateDir, 'public/fonts') : fontsDir();
    add('fonts/' + cuts.font, fs.existsSync(projectFont) ? path.join(dir, 'public/fonts') : fallback, cuts.font);
  }
  const n = parsed.data.narration;
  for (const s of n?.segments ?? []) add('narration/' + s.id + '.wav', path.join(dir, 'narration'), s.id + '.wav');
  for (const s of n?.sfx ?? []) add('sfx/' + s.file, studioConfig.sfxDir, s.file);
  return {cuts: parsed.data.cuts!, narration: n ?? null, files};
};
export async function uploadModalProject(dir: string, sessionId: string, signal: AbortSignal, onProgress: (p: {phase: string; done: number; total: number}) => void) {
  const snapshot = localRenderSnapshot(dir);
  const entries = [...snapshot.files].map(([logical, file]) => ({id: randomUUID(), path: logical, file, size: fs.statSync(file).size}));
  const input = ModalSessionInputSchema.safeParse({id: sessionId, files: entries.map(({file: _file, ...f}) => f), allowUpload: true});
  if (!input.success) throw new ModalError('素材は1ファイル512MiB・案件合計1GiB・128ファイル以内です', 400);
  const total = entries.reduce((n, f) => n + f.size, 0); let done = 0;
  await modalJson('/render/sessions', {method: 'POST', body: input.data, timeoutMs: 60_000});
  for (const f of entries) {
    const handle = await fs.promises.open(f.file, 'r');
    try {
      for (let offset = 0, index = 0; offset < f.size; offset += MODAL_UPLOAD_CHUNK, index++) {
        signal.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(MODAL_UPLOAD_CHUNK, f.size - offset));
        const {bytesRead} = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead !== chunk.length) throw new ModalError('転送中に素材ファイルが変更されました。やり直してください', 409);
        const body = {data: chunk.toString('base64'), sha256: createHash('sha256').update(chunk).digest('hex')};
        await modalJson(`/render/sessions/${sessionId}/files/${f.id}/chunks/${index}`, {method: 'POST', body, timeoutMs: 60_000});
        done += chunk.length; onProgress({phase: '素材をクラウドへ転送中', done, total});
      }
    } finally {await handle.close();}
    await modalJson(`/render/sessions/${sessionId}/files/${f.id}/complete`, {method: 'POST', timeoutMs: 60_000});
  }
  const session = await modalJson<ModalSession>(`/render/sessions/${sessionId}`);
  if (!session.files.every(f => f.complete)) throw new ModalError('素材転送が完了していません', 409);
  signal.throwIfAborted();
  const slug = path.basename(dir), project = {sessionId, uploadedAt: new Date().toISOString(), audioFingerprint: modalAudioFingerprint(snapshot.narration)};
  setLocalModalRenderProject(slug, project);
  const cloud = cloudConfig(); let cloudPublished = false;
  if (cloud) {
    try {await new CloudClient(cloud).publishModalProject(slug, project); cloudPublished = true;} catch { /* Local cloud rendering still works; publication can be retried. */ }
  }
  return {session, project, cloudPublished};
}

export async function publishLocalModalProject(slug: string) {
  const project = localModalRenderProjects()[slug], config = cloudConfig();
  if (!project) throw new ModalError('先に素材をアップロードしてください', 409);
  if (!config) throw new ModalError('PCとWebの同期接続を設定してください', 409);
  await new CloudClient(config).publishModalProject(slug, project);
  return {ok: true};
}
