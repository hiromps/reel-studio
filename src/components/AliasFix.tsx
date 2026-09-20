// 「ファイル名を最適化」：同じ素材を離れた位置から読み直しているカットを、中身が同じ別名のコピーに振り替える。
// Windows + Remotion では飛び飛びの再参照でレンダーが不安定になるため、preflight が
// E SAME_SRC_NONCONSECUTIVE で止める。レンダーの前にこれを押せば、その E は消える。
// 名前の決め方は shared/alias.ts、実ファイルのコピーは PC 側（aliases ジョブ）。
import React from 'react';
import {useStudio} from '../state/store';
import {realignAliases} from '@shared/alias';

export const useAliasFix = () => {
  const s = useStudio();
  const cuts = s.files.cuts.data;
  const renames = React.useMemo(() => (cuts ? realignAliases(cuts).renames : []), [cuts]);
  const job = s.jobs.find((j) => j.type === 'aliases' && j.slug === s.active && (j.status === 'running' || j.status === 'queued'));
  const blockedBy = !s.supportsJob('aliases') ? 'サーバーが古いプロセスです。Reel Studio を再起動してください' : job ? '実行中です' : null;
  const run = React.useCallback(async () => {
    if (!renames.length || blockedBy) return;
    // ジョブは PC の cuts.json を読むので、編集中のものは先に保存する（失敗したら何もしない）
    if (s.files.cuts.dirty && !(await s.saveFile('cuts'))) return;
    await s.addJob('aliases', {realign: true});
  }, [renames.length, blockedBy, s]);
  return {count: renames.length, renames, running: !!job, blockedBy, run};
};

/** 直すべき再参照があるときだけ出る案内＋ボタン。無ければ何も描かない */
export const AliasFixNotice: React.FC = () => {
  const {count, renames, running, blockedBy, run} = useAliasFix();
  if (!count) return null;
  const list = renames.map((r) => `${r.cutId ?? `#${r.cutIndex + 1}`}: ${r.from} → ${r.to}`).join('\n');
  return (
    <div className="issues" style={{marginTop: 6}}>
      <div className="issue E">
        <span className="code">E</span>
        <span>
          同じ素材を離れた位置から読み直しているカットが <b>{count}</b> 件あります（Windows ではレンダーが固まる・映像が入れ替わることがあります）。
        </span>
      </div>
      <div className="row" style={{marginTop: 6}}>
        <button className="primary" onClick={() => void run()} disabled={!!blockedBy} title={blockedBy ?? list}>
          {running ? 'ファイル名を最適化中…' : `ファイル名を最適化（${count} 件）`}
        </button>
        <span className="hint">{blockedBy ?? '中身が同じ別名のコピーを作って参照を振り替えます。出来上がりの映像は変わりません'}</span>
      </div>
    </div>
  );
};
