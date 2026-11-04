// 素材をローカルサーバーへ直接送り、uploads に保存する。
import React, {useRef, useState} from 'react';
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
    try {
      if (s.isCloud) throw new Error('ローカル保存モードです。PC の Reel Studio で素材を取り込んでください');
      let savedFolder = folder;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setProgress({name: f.name, done: 0, total: f.size, index: i + 1, count: files.length});
        const r = await api.upload<{folder: string}>(`/api/uploads/local?slug=${encodeURIComponent(s.active)}&folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(f.name)}`, f);
        savedFolder = r.data.folder;
        setProgress({name: f.name, done: f.size, total: f.size, index: i + 1, count: files.length});
      }
      onFolder(savedFolder);
      s.toast(`${files.length} 本をローカルに保存しました`, 'ok');
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
        選んだ動画を PC の <code>uploads/{folder || '（案件名）'}/</code> に保存し、「カタログ実行」で読み込みます。
        {s.isCloud && '取り込みは PC の Reel Studio で行ってください。'}
      </p>
      <div className="row">
        <label className="grow">
          置き場（uploads の下に作るフォルダ名）
          <input value={folder} onChange={(e) => onFolder(e.target.value)} placeholder="店名など" spellCheck={false} disabled={busy} />
        </label>
        <button className="primary" onClick={() => input.current?.click()} disabled={busy || !s.active || s.isCloud}>
          {busy ? '取り込み中…' : '動画を選ぶ'}
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
