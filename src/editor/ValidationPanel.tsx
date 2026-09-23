// 検証パネル：cuts の E/W・構成（並び順）・ナレーション・効果音の指摘を 1 か所に。行をクリックでその場面へ。
import React, {useState} from 'react';
import {IssueList, type IssueRow} from '../components/IssueList';
import {useAliasFix} from '../components/AliasFix';
import type {EditorModel} from './useEditorModel';
import {usePref} from '../hooks/usePref';

type Tab = 'cuts' | 'order' | 'narr' | 'sfx';

export const ValidationPanel: React.FC<{m: EditorModel; onSeekCut: (i: number) => void; onSeekSec: (sec: number) => void}> = ({m, onSeekCut, onSeekSec}) => {
  const {validation, orderCheck, narrIssues, sfxIssues, applyFix, fixOverlaps, fitBlockedBy, fitToNarration, s} = m;
  // 別名コピー（SAME_SRC_NONCONSECUTIVE）は実ファイルのコピーを伴うので、その場の書き換えではなく PC のジョブに任せる
  const aliasFix = useAliasFix();
  const [open, setOpen] = usePref('reel-studio.editor.validation', true);
  const [tab, setTab] = useState<Tab>('cuts');
  const e = validation?.errors.length ?? 0;
  const w = validation?.warnings.length ?? 0;
  const oe = orderCheck?.findings.filter((f) => f.severity === 'E').length ?? 0;
  const ow = orderCheck?.findings.filter((f) => f.severity === 'W').length ?? 0;
  const ne = narrIssues.length;
  const se = sfxIssues.filter((x) => x.severity === 'E').length;
  const sw = sfxIssues.filter((x) => x.severity === 'W').length;

  const cutRows: IssueRow[] = [...(validation?.errors ?? []), ...(validation?.warnings ?? [])].map((iss) => ({
    severity: iss.severity,
    code: iss.code,
    tag: iss.cutId ? `[${iss.cutId}]` : undefined,
    message: iss.message,
    onClick: iss.cutIndex !== undefined ? () => onSeekCut(iss.cutIndex!) : undefined,
    fix: !iss.fix
      ? undefined
      : iss.fix.type === 'alias'
        ? {label: aliasFix.running ? '最適化中…' : 'ファイル名を最適化', onClick: () => void aliasFix.run()}
        : {label: '適用', onClick: () => applyFix(iss)},
  }));
  const orderRows: IssueRow[] = (orderCheck?.findings ?? []).map((f) => ({
    severity: f.severity,
    code: f.code,
    tag: f.index !== undefined ? `[${f.index + 1}番目]` : undefined,
    message: f.message,
    onClick: f.index !== undefined ? () => onSeekCut(f.index!) : undefined,
  }));
  const narrRows: IssueRow[] = narrIssues.map((msg) => {
    const id = msg.split(':')[0];
    const idx = m.narration?.segments.findIndex((x) => x.id === id) ?? -1;
    const at = idx >= 0 ? m.narration!.segments[idx].at : undefined;
    return {severity: 'W', message: msg, onClick: at !== undefined ? () => onSeekSec(at) : undefined};
  });
  const sfxRows: IssueRow[] = sfxIssues.map((x) => ({severity: x.severity, code: x.code, message: x.message}));

  const badge = (n: number, kind: 'E' | 'W') => (n > 0 ? <span className={`vbadge ${kind}`}>{n}</span> : null);

  return (
    <div className="insp-section validation" data-tour="validation">
      <div className="insp-title clickable" onClick={() => setOpen(!open)}>
        <b>
          {open ? '▾' : '▸'} 検証 {validation ? (validation.ok ? <span className="ok">OK</span> : <span className="ng">NG</span>) : ''}
        </b>
        <span className="vsum">
          {badge(e + oe + se, 'E')}
          {badge(w + ow + sw + ne, 'W')}
        </span>
        <span style={{flex: 1}} />
        {validation && (
          <span className="hint">
            {validation.summary.cutCount} カット / {validation.summary.totalSec}s / テロップ {validation.summary.groupCount} G
            {validation.summary.revealPct !== undefined ? ` / リビール ${Math.round(validation.summary.revealPct * 100)}%` : ''}
            {validation.summary.placeholders > 0 ? ` / 未記入 ${validation.summary.placeholders}` : ''}
          </span>
        )}
      </div>
      {open && (
        <>
          <div className="chips" style={{marginBottom: 6}}>
            {(
              [
                ['cuts', 'カット', e, w],
                ['order', '構成', oe, ow],
                ['narr', 'ナレーション', 0, ne],
                ['sfx', '効果音', se, sw],
              ] as const
            ).map(([id, label, ec, wc]) => (
              <span key={id} className={`chip${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
                {label}
                {ec > 0 ? <span className="vbadge E">{ec}</span> : null}
                {wc > 0 ? <span className="vbadge W">{wc}</span> : null}
              </span>
            ))}
          </div>
          {tab === 'cuts' && (
            <>
              <IssueList rows={cutRows} empty={validation ? '指摘なし' : '構成がありません'} maxHeight={260} />
              {validation && validation.skipped.length > 0 && <div className="hint">skip: {validation.skipped.join(', ')}</div>}
            </>
          )}
          {tab === 'order' && (
            <>
              {orderCheck ? (
                <div className="hint" style={{marginBottom: 4}}>
                  {orderCheck.summary.count} カット（型の推奨 {orderCheck.summary.recommendedCount[0]}〜{orderCheck.summary.recommendedCount[1]}）
                  {orderCheck.summary.signageAt.length > 0 ? ` / 看板 ${orderCheck.summary.signageAt.map((i) => i + 1).join(',')} 番目` : ''}
                  {orderCheck.summary.unusedGood.length > 0 ? ` / 未使用の見せ場 ${orderCheck.summary.unusedGood.length}` : ''}
                </div>
              ) : (
                <div className="hint">catalog に対応付かない素材が混ざっているか、brief が無いので構成チェックは出せません</div>
              )}
              <IssueList rows={orderRows} empty={orderCheck ? '型どおりの並びです' : undefined} maxHeight={260} />
            </>
          )}
          {tab === 'narr' && (
            <>
              <IssueList rows={narrRows} empty={m.narration ? '指摘なし' : 'ナレーションはまだありません'} maxHeight={220} />
              {narrIssues.some((x) => x.includes('重なります')) && (
                <div className="row" style={{marginTop: 6}}>
                  <button
                    className="small primary"
                    onClick={() => {
                      const notes = fixOverlaps();
                      for (const n of notes) s.toast(n, n.includes('!') ? 'error' : 'info');
                    }}
                  >
                    重なりを自動で直す（at をずらす）
                  </button>
                  <span className="hint">後ろにずらすだけなので音声の作り直しは不要です</span>
                </div>
              )}
              {narrIssues.some((x) => x.includes('重なります') || x.includes('はみ出します')) && !fitBlockedBy && (
                <div className="row" style={{marginTop: 6}}>
                  <button
                    className="small"
                    onClick={() => {
                      const notes = fitToNarration();
                      const head = notes[0];
                      if (head) s.toast(head.replace(/^!\s*/, ''), head.startsWith('!') ? 'error' : 'ok');
                      for (const n of notes.slice(1)) if (n.trimStart().startsWith('!')) s.toast(n.trim().replace(/^!\s*/, ''), 'error');
                    }}
                    title="各ナレーションの音声の長さに映像を合わせ、0.75〜0.8 秒のカットに刻み直します（音声は作り直さない・取り消し可）"
                  >
                    映像を音声に合わせる（0.75〜0.8 秒刻み）
                  </button>
                  <span className="hint">カットを刻み直して動画尺を音声に揃えます（Ctrl+Z で戻せます）</span>
                </div>
              )}
            </>
          )}
          {tab === 'sfx' && <IssueList rows={sfxRows} empty={m.narration?.sfx?.length ? '指摘なし' : '効果音はまだありません'} maxHeight={220} />}
        </>
      )}
    </div>
  );
};
