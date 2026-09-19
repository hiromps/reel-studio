// クラウド版：スマホで映像が見られる状態かの知らせ。
//
// クラウドには原本 4K を上げていない（転送量とコストのため）。見られるのは PC が作った
// **軽量プロキシ（540x960）** だけなので、それが無い案件では Timeline のプレビューが真っ黒になる。
// 理由が分からないと詰まるので、ここで足りていないことと直し方（preview-proxy ジョブ）を出す。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';

type Status = {clips: number; ready: number; missing: string[]};

export const PreviewReady: React.FC = () => {
  const s = useStudio();
  const [st, setSt] = useState<Status | null>(null);
  const [hidden, setHidden] = useState(false);
  const running = s.jobs.some((j) => j.type === 'preview-proxy' && (j.status === 'running' || j.status === 'queued'));

  const load = useCallback(async () => {
    if (!s.isCloud || !s.active) return;
    try {
      const r = await api.get<Status>(`/api/projects/${encodeURIComponent(s.active)}/preview-status`);
      setSt(r.data);
    } catch {
      setSt(null); // 古いサーバー等。出さないだけ
    }
  }, [s.isCloud, s.active]);

  useEffect(() => {
    void load();
  }, [load]);
  // 軽量プレビュー生成が終わったら数え直す
  useEffect(() => {
    if (!running) void load();
  }, [running, load]);

  if (!s.isCloud || hidden || !st || !st.clips || !st.missing.length) return null;
  return (
    <div className="preview-warn">
      <span className="pill warn">プレビュー {st.ready}/{st.clips}</span>
      <span>
        スマホで再生できるのは PC が作った軽量プレビューだけです（原本はクラウドに置きません）。
        {st.missing.length} 本ぶんが未作成なので、その部分は映像が出ません。
      </span>
      <button className="small primary" disabled={running} onClick={() => void s.addJob('preview-proxy')}>
        {running ? '作成中…' : '軽量プレビューを作る'}
      </button>
      <button className="small" onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  );
};
