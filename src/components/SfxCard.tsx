// 効果音の設計（Render）：自動配置・ライブラリの役割・ダッキング・全体音量。
// 1 個ずつの配置（秒・音源・音量）は Timeline 画面の S 段とインスペクタで直す。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {Narration} from '@shared/schema';
import {SFX_DEFAULTS, SFX_ROLES, SFX_ROLE_LABEL, checkSfx, type SfxLibrary, type SfxRole} from '@shared/sfx';
import {IssueList} from './IssueList';

const emptyLib: SfxLibrary = {version: 1, sounds: []};

export const SfxCard: React.FC<{onTab: (t: 'timeline') => void}> = ({onTab}) => {
  const s = useStudio();
  const narration = s.files.narration.data;
  const [lib, setLib] = useState<SfxLibrary>(emptyLib);
  const [open, setOpen] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const busy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type.startsWith('sfx-'));
  const unsupported = !s.supportsJob('sfx-auto');

  const loadLib = useCallback(async () => {
    try {
      const r = await api.get<SfxLibrary>('/api/sfx');
      setLib(r.data ?? emptyLib);
    } catch {
      setLib(emptyLib); // 古いサーバーには /api/sfx が無い
    }
  }, []);

  useEffect(() => {
    void loadLib();
  }, [loadLib]);

  // sfx-scan / sfx-auto が終わったらライブラリを読み直す
  const lastJob = useRef<string | null>(null);
  useEffect(() => {
    const j = s.jobs.find((x) => x.type.startsWith('sfx-') && x.status === 'done');
    if (!j || j.id === lastJob.current) return;
    lastJob.current = j.id;
    void loadLib();
  }, [s.jobs, loadLib]);

  const sfx = narration?.sfx ?? [];
  const videoSec = narration?.videoSec;
  const issues = useMemo(() => checkSfx(sfx, {videoSec, lib, narration: narration?.segments}), [sfx, videoSec, lib, narration]);
  const setNarr = (next: Narration) => s.setFile('narration', next);

  const play = (file: string, trimSec?: number) => {
    audio.current?.pause();
    const a = new Audio(`/api/sfx/file/${file.split('/').map(encodeURIComponent).join('/')}`);
    audio.current = a;
    void a.play().catch(() => s.toast('試聴できませんでした', 'error'));
    if (trimSec && trimSec > 0) setTimeout(() => a.pause(), trimSec * 1000);
  };

  const setRoles = async (file: string, roles: SfxRole[]) => {
    try {
      const r = await api.put<SfxLibrary>('/api/sfx/sound', {file, roles});
      setLib(r.data);
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  if (!narration) return null;
  const noRole = lib.sounds.filter((x) => !x.roles.length);

  return (
    <section className="card" style={{marginTop: 8}} data-tour="sfx">
      <div className="summary">
        <span>
          <b>効果音</b>
        </span>
        <span>{sfx.length ? `${sfx.length} 個` : '未設定'}</span>
        <span className="hint">
          置きどころを絞って毎回同じ役割に同じ音を当てると、動画をまたいだ統一感が出ます（{videoSec ? `${videoSec.toFixed(0)} 秒なら ${Math.max(2, Math.round(videoSec * SFX_DEFAULTS.perSec))} 個くらいまで` : '入れすぎると耳が慣れて逆効果'}）
        </span>
      </div>
      <div className="row">
        <button className="primary" onClick={() => s.addJob('sfx-auto')} disabled={busy || unsupported || !s.files.cuts.data || s.files.narration.dirty} title={s.files.narration.dirty ? 'narration.json に未保存の変更があります' : 'cuts のフック・テロップ・看板・実食カットから置きどころを決めます'}>
          {busy ? '配置中…' : '効果音を自動で置く'}
        </button>
        <button onClick={() => s.addJob('sfx-scan')} disabled={busy || unsupported}>
          ライブラリを読み直す
        </button>
        <button className="small" onClick={() => onTab('timeline')} title="1 個ずつの位置・音源・音量は Timeline の S 段で">
          配置を Timeline で直す →
        </button>
        <span className="hint">
          ライブラリ {lib.sounds.length} 音{noRole.length ? `（役割未設定 ${noRole.length}）` : ''}
        </span>
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>
      {sfx.length > 0 && (
        <div className="chips" style={{marginTop: 6}}>
          {[...sfx]
            .sort((a, b) => a.at - b.at)
            .map((x) => (
              <span key={x.id} className="chip" title={`${x.label ?? x.file} / ${x.gainDb ?? 0} dB`} onClick={() => onTab('timeline')}>
                {x.at.toFixed(1)}s {x.role ?? x.id}
              </span>
            ))}
        </div>
      )}

      <div className="row" style={{marginTop: 6}}>
        <label title="効果音がナレーションに被ったとき、声ではなく効果音側を自動で沈ませる（放送のダッキング）">
          <span>声に被ったら効果音を下げる</span>
          <input type="checkbox" checked={narration.sfxDuck !== false} onChange={(e) => setNarr({...narration, sfxDuck: e.target.checked})} />
        </label>
        <label title="効果音の全体音量。個々の音量に足される">
          効果音全体
          <span className="btns">
            <input type="range" min={-12} max={6} step={0.5} value={narration.sfxGainDb ?? 0} onChange={(e) => setNarr({...narration, sfxGainDb: Number(e.target.value)})} style={{width: 110}} />
            <span className="counter">
              {(narration.sfxGainDb ?? 0) > 0 ? '+' : ''}
              {(narration.sfxGainDb ?? 0).toFixed(1)} dB
            </span>
          </span>
        </label>
        <span style={{flex: 1}} />
        <button className="primary" onClick={() => s.saveFile('narration')} disabled={!s.files.narration.dirty}>
          narration.json を保存
        </button>
      </div>
      <span className="hint">変更したら「ナレーション合成（mix）」をやり直すと反映されます（音声の再生成は不要）</span>

      <IssueList rows={issues.map((x) => ({severity: x.severity, code: x.code, message: x.message}))} />

      <details style={{marginTop: 8}} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="hint">ライブラリ（どの音をどの役割に使うか）— 自動配置はここの役割を見ます</summary>
        {!lib.sounds.length && <p className="hint">sfx/ に音源（効果音ラボの mp3 など）を置いて「ライブラリを読み直す」を押してください。音源は公開リポジトリには含まれません</p>}
        <div className="narr-rows">
          {lib.sounds.map((y) => (
            <div key={y.file} className="narr-row">
              <span style={{flex: 1, minWidth: 160}}>
                {y.label} <span className="hint">{(y.durSec ?? 0).toFixed(2)}s</span>
              </span>
              {SFX_ROLES.map((r) => (
                <label key={r} title={SFX_ROLE_LABEL[r]} className="sfx-role">
                  <span>{SFX_ROLE_LABEL[r]}</span>
                  <input type="checkbox" checked={y.roles.includes(r)} onChange={(e) => void setRoles(y.file, e.target.checked ? [...y.roles, r] : y.roles.filter((z) => z !== r))} />
                </label>
              ))}
              <button className="small" onClick={() => play(y.file, y.defaultTrimSec)}>
                ▶
              </button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
};
