// スマホで撮った動画をそのまま案件に入れる（クラウド版だけで出る）。
//
// Vercel の Function は本文 4.5MB までなので、動画はサーバーを経由せず **ブラウザから Blob へ直接**
// 上げる。上げ終わったら ingest ジョブを積み、PC が受け取って uploads/<フォルダ>/ に置く。
// そのあとは今までどおり「カタログ実行」で読み込む。
import React, {useRef, useState} from 'react';
import {put} from '@vercel/blob/client';
import {api} from '../api';
import {useStudio} from '../state/store';

type Progress = {name: string; done: number; total: number; index: number; count: number};

export const UploadMaterials: React.FC<{folder: string; onFolder: (name: string) => void}> = ({folder, onFolder}) => {
  const s = useStudio();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const pick = (files: FileList | null) => {
    if (!files?.length || !s.active) return;
    void run([...files]);
  };

  const run = async (files: File[]) => {
    if (!s.active) return;
    setBusy(true);
    const uploaded: {url: string; name: string}[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setProgress({name: f.name, done: 0, total: f.size, index: i + 1, count: files.length});
        const t = await api.post<{token: string; pathname: string}>('/api/uploads/token', {slug: s.active, filename: f.name, folder});
        const r = await put(t.data.pathname, f, {
          access: 'public',
          // サーバーが出した短命トークンをそのまま使う（この 1 ファイルだけ書ける）
          token: t.data.token,
          contentType: f.type || 'application/octet-stream',
          // 動画は大きい。分割して並列で上げ、落ちた部分だけ再送する
          multipart: f.size > 8 * 1024 * 1024,
          onUploadProgress: (p) => setProgress({name: f.name, done: p.loaded, total: p.total || f.size, index: i + 1, count: files.length}),
        });
        uploaded.push({url: r.url, name: f.name});
      }
      const job = await api.post<{id: string}>('/api/uploads/ingest', {slug: s.active, files: uploaded, folder});
      s.toast(`${uploaded.length} 本を PC に取り込み中です（ジョブ ${job.data.id}）`, 'ok');
      if (folder) onFolder(folder);
    } catch (e) {
      s.toast(`アップロードに失敗: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="upload-materials">
      <p className="hint">
        スマホで撮った動画をここから入れられます。上げた動画は PC の <code>uploads/{folder || '（案件名）'}/</code> に置かれ、そのあと「カタログ実行」で読み込みます。
      </p>
      <div className="row">
        <label className="grow">
          置き場（uploads の下に作るフォルダ名）
          <input value={folder} onChange={(e) => onFolder(e.target.value)} placeholder="店名など" spellCheck={false} disabled={busy} />
        </label>
        <button className="primary" onClick={() => input.current?.click()} disabled={busy || !s.active}>
          {busy ? 'アップロード中…' : '📱 動画を選ぶ'}
        </button>
        <input ref={input} type="file" accept="video/*" multiple hidden onChange={(e) => pick(e.target.files)} />
      </div>
      {progress && (
        <div>
          <div className="hint">
            {progress.index}/{progress.count} {progress.name} — {pct}%（{(progress.done / 1024 / 1024).toFixed(1)} / {(progress.total / 1024 / 1024).toFixed(1)} MB）
          </div>
          <div className="progress">
            <div style={{width: `${pct}%`}} />
          </div>
        </div>
      )}
    </div>
  );
};
