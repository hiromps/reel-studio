// 効果音の配置（narration.json の sfx）。自動配置・手動の追加／削除・試聴・役割の割り当て。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {Narration, Sfx} from '@shared/schema';
import {SFX_DEFAULTS, SFX_ROLES, SFX_ROLE_LABEL, checkSfx, type SfxLibrary, type SfxRole} from '@shared/sfx';

const emptyLib: SfxLibrary = {version: 1, sounds: []};

export const SfxCard: React.FC = () => {
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
  const patch = (i: number, p: Partial<Sfx>) => narration && setNarr({...narration, sfx: sfx.map((x, k) => (k === i ? {...x, ...p} : x))});
  const remove = (i: number) => narration && setNarr({...narration, sfx: sfx.filter((_, k) => k !== i)});
  const add = () => {
    if (!narration) return;
    const sound = lib.sounds[0];
    if (!sound) return s.toast('効果音がライブラリにありません（sfx/ に音源を置いて「ライブラリを読み直す」）', 'error');
    const used = new Set(sfx.map((x) => x.id));
    let n = sfx.length + 1;
    while (used.has(`sfx${n}`)) n++;
    const at = sfx.length ? Math.round((Math.max(...sfx.map((x) => x.at)) + SFX_DEFAULTS.minGapSec) * 1000) / 1000 : 0;
    setNarr({
      ...narration,
      sfx: [
        ...sfx,
        {
          id: `sfx${n}`,
          at,
          file: sound.file,
          trimSec: sound.defaultTrimSec ?? Math.min(sound.durSec ?? SFX_DEFAULTS.trimSec, SFX_DEFAULTS.trimSec),
          fadeOutSec: sound.defaultFadeOutSec ?? SFX_DEFAULTS.fadeOutSec,
          gainDb: sound.defaultGainDb ?? SFX_DEFAULTS.gainDb,
          label: sound.label,
        },
      ],
    });
  };

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
        <span className="hint">
          ライブラリ {lib.sounds.length} 音{noRole.length ? `（役割未設定 ${noRole.length}）` : ''}
        </span>
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>

      {sfx.length > 0 && (
        <div className="narr-rows">
          {[...sfx]
            .map((x, i) => ({x, i}))
            .sort((a, b) => a.x.at - b.x.at)
            .map(({x, i}) => (
              <div key={x.id + i} className="narr-row">
                <input className="narr-id" value={x.id} onChange={(e) => patch(i, {id: e.target.value})} title="効果音の id" />
                <span className="btns">
                  <input type="number" step={0.05} min={0} value={x.at} onChange={(e) => patch(i, {at: Number(e.target.value)})} style={{width: 74}} title="配置秒" />
                  <button className="small" onClick={() => patch(i, {at: Math.max(0, Math.round((x.at - 0.1) * 1000) / 1000)})}>
                    -0.1
                  </button>
                  <button className="small" onClick={() => patch(i, {at: Math.round((x.at + 0.1) * 1000) / 1000})}>
                    +0.1
                  </button>
                </span>
                <select value={x.file} onChange={(e) => patch(i, {file: e.target.value, label: lib.sounds.find((y) => y.file === e.target.value)?.label})} style={{flex: 1, minWidth: 160}}>
                  {!lib.sounds.some((y) => y.file === x.file) && <option value={x.file}>{x.file}（ライブラリに無い）</option>}
                  {lib.sounds.map((y) => (
                    <option key={y.file} value={y.file}>
                      {y.label}
                    </option>
                  ))}
                </select>
                <select value={x.role ?? ''} onChange={(e) => patch(i, {role: e.target.value || undefined})} title="役割（統一感の管理用）">
                  <option value="">（役割なし）</option>
                  {SFX_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {SFX_ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <label title="頭から使う長さ（秒）。長い素材を丸ごと鳴らさない">
                  尺
                  <input type="number" step={0.1} min={0.1} value={x.trimSec ?? ''} onChange={(e) => patch(i, {trimSec: e.target.value ? Number(e.target.value) : undefined})} style={{width: 62}} />
                </label>
                <label title="音量（dB）">
                  音量
                  <input type="number" step={1} value={x.gainDb ?? 0} onChange={(e) => patch(i, {gainDb: Number(e.target.value)})} style={{width: 62}} />
                </label>
                <button className="small" onClick={() => play(x.file, x.trimSec)} title="この音を試聴">
                  ▶
                </button>
                <button className="small danger" onClick={() => remove(i)}>
                  削除
                </button>
              </div>
            ))}
        </div>
      )}

      <div className="row" style={{marginTop: 6}}>
        <button className="small" onClick={add} disabled={!lib.sounds.length}>
          + 効果音を追加
        </button>
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

      {issues.length > 0 && (
        <div className="issues" style={{marginTop: 6}}>
          {issues.map((x, k) => (
            <div key={k} className={`issue ${x.severity}`}>
              <span className="code">
                {x.severity} {x.code}
              </span>
              <span>{x.message}</span>
            </div>
          ))}
        </div>
      )}

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
                  <input
                    type="checkbox"
                    checked={y.roles.includes(r)}
                    onChange={(e) => void setRoles(y.file, e.target.checked ? [...y.roles, r] : y.roles.filter((z) => z !== r))}
                  />
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
