import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {ModalJob} from '../shared/modal';
import {ModalError, modalFetch, modalJson} from './modal-client';
import {settingsDir} from './settings';
import {saveLocalUpload} from './local-upload';
import {buildCatalog} from './catalog';
import {execOk} from './exec';

export type ModalResultProvider = {job: (id: string) => Promise<ModalJob>; result: (id: string) => Promise<Response>};
export const downloadModalResult = async (id: string, provider?: ModalResultProvider): Promise<{file: string; type: string; job: ModalJob}> => {
  if (!z.string().uuid().safeParse(id).success) throw new ModalError('ジョブIDが不正です', 400);
  const job = provider ? await provider.job(id) : await modalJson<ModalJob>(`/jobs/${id}`);
  if (job.status !== 'completed' || !job.resultType) throw new ModalError('生成結果はまだありません', 409);
  const dir = path.join(settingsDir(), 'modal-results');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, `${id}.${job.resultType === 'video/mp4' ? 'mp4' : 'png'}`);
  if (!fs.existsSync(file)) {
    const response = provider ? await provider.result(id) : await modalFetch(`/jobs/${id}/result`, {timeoutMs: 60_000});
    if (!response.body || response.headers.get('content-type')?.split(';')[0] !== job.resultType) throw new ModalError('生成結果の形式が不正です');
    let bytes = 0;
    const temporary = `${file}.${randomBytes(6).toString('hex')}.part`;
    try {
      const bounded = async function* () {
        for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
          bytes += chunk.length;
          if (bytes > 64 * 1024 ** 2) throw new ModalError('生成結果のサイズ上限を超えています', 413);
          yield chunk;
        }
        if (!bytes) throw new ModalError('生成結果が空です');
      };
      await pipeline(bounded(), fs.createWriteStream(temporary, {flags: 'wx', mode: 0o600}));
      fs.renameSync(temporary, file);
    } finally {fs.rmSync(temporary, {force: true});}
  }
  return {file, type: job.resultType, job};
};

export const importModalResult = async (id: string, projectDir: string, signal: AbortSignal, onLine: (v: string) => void, provider?: ModalResultProvider) => {
  const result = await downloadModalResult(id, provider);
  signal.throwIfAborted();
  let video = result.file;
  if (result.type === 'image/png') {
    video = result.file.replace(/\.png$/, '-still.mp4');
    if (!fs.existsSync(video)) {
      const temp = video.replace(/\.mp4$/, '-part.mp4');
      try {
        await execOk('ffmpeg', ['-y', '-loop', '1', '-i', result.file, '-t', '3', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temp], {signal, timeoutMs: 60_000});
        fs.renameSync(temp, video);
      } finally {fs.rmSync(temp, {force: true});}
    }
  }
  const saved = await saveLocalUpload(fs.createReadStream(video), `${path.basename(projectDir)}-ai`, path.basename(video), 64 * 1024 ** 2);
  signal.throwIfAborted();
  const r = await buildCatalog({projectDir, materialsDir: path.dirname(saved.file), slug: path.basename(projectDir), append: true, generated: {provider: 'modal', jobId: id}, thumbs: true, proxy: true, onLine});
  return {folder: saved.folder, clips: r.catalog.clips.length, changed: r.changed.length};
};
