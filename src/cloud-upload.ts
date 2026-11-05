import {MODAL_FILE_BYTES, MODAL_PROJECT_BYTES, MODAL_UPLOAD_CHUNK, type ModalSession} from '@shared/modal-render';
import {modalApi} from './modal-api';

export type CloudUpload = {id: string; expectedSessionId: string | null; files: {id: string; path: string; size: number; file: File}[]};
export function planCloudUpload(files: File[], previous: ModalSession | null): CloudUpload {
  if (!files.length) throw new Error('動画を選んでください');
  if (files.length + (previous?.files.length ?? 0) > 128 || files.reduce((n, f) => n + f.size, previous?.totalBytes ?? 0) > MODAL_PROJECT_BYTES) throw new Error('案件の素材は合計1GiB・128ファイルまでです');
  const entries = files.map(file => {
    const ext = /\.(mp4|mov|m4v|webm)$/i.exec(file.name)?.[0].toLowerCase();
    if (!ext || file.size <= 0 || file.size > MODAL_FILE_BYTES) throw new Error(`${file.name}：MP4・MOV・M4V・WebM、1本512MiB以内の動画を選んでください`);
    const id = crypto.randomUUID();
    return {id, path: `uploads/${id}${ext}`, size: file.size, file};
  });
  return {id: crypto.randomUUID(), expectedSessionId: previous?.id ?? null, files: entries};
}
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
};
// The stable manifest and chunk hashes make a retry safe after a lost response.
export async function uploadCloudFiles(slug: string, plan: CloudUpload, signal: AbortSignal, progress: (done: number, total: number) => void) {
  const projectRoute = `/render/projects/${encodeURIComponent(slug)}`;
  const session = await modalApi.post<ModalSession>(`${projectRoute}/sessions`, {
    id: plan.id, allowUpload: true, files: plan.files.map(({file: _file, ...f}) => f),
    ...(plan.expectedSessionId ? {reuseSessionId: plan.expectedSessionId} : {}),
  }, signal);
  const total = plan.files.reduce((n, f) => n + f.size, 0); let done = 0;
  progress(done, total);
  for (const f of plan.files) {
    const route = `/render/sessions/${plan.id}/files/${f.id}`;
    if (!session.files.find(item => item.id === f.id)?.complete) {
      for (let offset = 0, index = 0; offset < f.size; offset += MODAL_UPLOAD_CHUNK, index++) {
        signal.throwIfAborted();
        const bytes = new Uint8Array(await f.file.slice(offset, offset + MODAL_UPLOAD_CHUNK).arrayBuffer());
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const sha256 = [...hash].map(n => n.toString(16).padStart(2, '0')).join('');
        await modalApi.post(`${route}/chunks/${index}`, {data: base64(bytes), sha256}, signal);
        done += bytes.length; progress(done, total);
      }
      await modalApi.post(`${route}/complete`, undefined, signal);
    } else {done += f.size; progress(done, total);}
  }
  signal.throwIfAborted();
  return modalApi.post<{session: ModalSession}>(`${projectRoute}/commit-session`, {sessionId: plan.id, expectedSessionId: plan.expectedSessionId}, signal);
}
