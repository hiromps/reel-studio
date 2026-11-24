// BGM（Render）：曲を選ぶ・新しい曲を取り込む・音量とフェード・ナレーションで自動で下げる。
// 音源は効果音ライブラリの BGM/ フォルダ（sfx/BGM/）。設定は narration.json の bgm に保存し、mix で混ぜる。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {Bgm, Narration} from '@shared/schema';
import type {SfxLibrary} from '@shared/sfx';
import {BGM_DEFAULTS, BGM_EXTENSIONS, BGM_FOLDER, BGM_MAX_BYTES, bgmCandidates, bgmDisplayName, bgmResolved, checkBgm} from '@shared/bgm';
import {totalSec} from '@shared/timeline';
import {IssueList} from './IssueList';

const emptyLib: SfxLibrary = {version: 1, sounds: []};
const fileUrl = (file: string) => `/api/sfx/file/${file.split('/').map(encodeURIComponent).join('/')}`;

export const BgmCard: React.FC = () => {
  const s = useStudio();
  const narration = s.files.narration.data;
  const current: Narration = narration ?? {voice: '', segments: []};
  const bgm = current.bgm;
  const [lib, setLib] = useState<SfxLibrary>(emptyLib);
  const [uploading, setUploading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadLib = useCallback(async () => {
    try {
      const r = await api.get<SfxLibrary>('/api/sfx');
      // 古いサーバーは別の形を返すことがある。曲の一覧が無ければ空として扱う
      setLib(Array.isArray(r.data?.sounds) ? r.data : emptyLib);
    } catch {
      setLib(emptyLib);
    }
  }, []);
  useEffect(() => {
    void loadLib();
  }, [loadLib]);
  // 効果音カードの「ライブラリを読み直す」が終わったら一覧を取り直す
  const lastJob = useRef<string | null>(null);
  useEffect(() => {
    const j = s.jobs.find((x) => x.type === 'sfx-scan' && x.status === 'done');
    if (!j || j.id === lastJob.current) return;
    lastJob.current = j.id;
    void loadLib();
  }, [s.jobs, loadLib]);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  };
  useEffect(() => stop, []);

  const candidates = useMemo(() => bgmCandidates(lib), [lib]);
  const cutsData = s.files.cuts.data;
  const videoSec = useMemo(() => current.videoSec ?? (cutsData ? totalSec(cutsData) : undefined), [current.videoSec, cutsData]);
  const issues = useMemo(() => checkBgm(bgm, {lib: lib.sounds.length ? lib : null, videoSec}), [bgm, lib, videoSec]);
  const r = bgm ? bgmResolved(bgm) : null;
  const sound = bgm ? lib.sounds.find((x) => x.file === bgm.file) : undefined;

  const setNarr = (next: Narration) => s.setFile('narration', next);
  const patch = (p: Partial<Bgm>) => bgm && setNarr({...current, bgm: {...bgm, ...p}});
  const choose = (file: string) => {
    stop();
    if (!file) {
      const {bgm: _drop, ...rest} = current;
      setNarr(rest as Narration);
      return;
    }
    // 曲を替えても音量などの設定は引き継ぐ（頭出しだけは曲ごとに違うので戻す）
    setNarr({...current, bgm: {...(bgm ?? {}), file, label: lib.sounds.find((x) => x.file === file)?.label, startSec: undefined}});
  };

  const preview = () => {
    if (playing) return stop();
    if (!bgm) return;
    const a = new Audio(fileUrl(bgm.file));
    a.volume = Math.max(0.05, Math.min(1, Math.pow(10, (r!.gainDb + 12) / 20)));
    a.currentTime = r!.startSec;
    a.loop = r!.loop;
    a.onended = () => setPlaying(false);
    audio.current = a;
    setPlaying(true);
    void a.play().catch(() => {
      setPlaying(false);
      s.toast('試聴できませんでした', 'error');
    });
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > BGM_MAX_BYTES) return s.toast(`ファイルが大きすぎます（${Math.round(BGM_MAX_BYTES / 1024 / 1024)}MB まで）`, 'error');
    setUploading(true);
    try {
      const res = await api.upload<{file: string; lib: SfxLibrary}>(`/api/sfx/bgm?name=${encodeURIComponent(file.name)}`, file);
      setLib(res.data.lib);
      const label = res.data.lib.sounds.find((x) => x.file === res.data.file)?.label;
      setNarr({...current, bgm: {...(bgm ?? {}), file: res.data.file, label, startSec: undefined}});
      s.toast(`「${file.name}」を BGM に追加しました。narration.json を保存してください`, 'ok');
    } catch (e) {
      s.toast(`BGM を追加できませんでした: ${(e as Error).message}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const outFinal = s.projects.find((p) => p.slug === s.active)?.out?.final;
  const mixBusy = s.jobs.some((j) => j.slug === s.active && j.type === 'mix' && (j.status === 'queued' || j.status === 'running'));
  const applyToRenderedVideo = async () => {
    if (s.files.narration.dirty && !(await s.saveFile('narration'))) return;
    await s.addJob('mix', {input: 'out/final.mp4', output: 'out/final_narration.mp4'});
  };

  const slider = (label: string, title: string, value: number, min: number, max: number, step: number, unit: string, onChange: (v: number) => void) => (
    <label title={title}>
      {label}
      <span className="btns">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{width: 110}} />
        <span className="counter">
          {unit === 'dB' && value > 0 ? '+' : ''}
          {value.toFixed(1)} {unit}
        </span>
      </span>
    </label>
  );

  return (
    <section className="card" style={{marginTop: 8}} data-tour="bgm">
      <div className="summary">
        <span>
          <b>BGM</b>
        </span>
        <span>{bgm ? bgmDisplayName(bgm, lib) : '未設定'}</span>
        <span className="hint">動画全体に 1 曲敷きます。尺は動画に合わせて自動で切り、ナレーションが鳴っている間は自動で下げます</span>
      </div>

      <div className="row">
        <select value={bgm?.file ?? ''} onChange={(e) => choose(e.target.value)} aria-label="BGM の曲" style={{minWidth: 220, maxWidth: '100%'}}>
          <option value="">BGM なし</option>
          {bgm && !candidates.some((c) => c.sound.file === bgm.file) && <option value={bgm.file}>{bgmDisplayName(bgm, lib)}（ライブラリに無い）</option>}
          {candidates.some((c) => c.inFolder) && (
            <optgroup label={`${BGM_FOLDER} フォルダ`}>
              {candidates.filter((c) => c.inFolder).map((c) => (
                <option key={c.sound.file} value={c.sound.file}>
                  {c.sound.label}（{(c.sound.durSec ?? 0).toFixed(0)}秒）
                </option>
              ))}
            </optgroup>
          )}
          {candidates.some((c) => !c.inFolder) && (
            <optgroup label="その他の長い音">
              {candidates.filter((c) => !c.inFolder).map((c) => (
                <option key={c.sound.file} value={c.sound.file}>
                  {c.sound.label}（{(c.sound.durSec ?? 0).toFixed(0)}秒）
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button className="small" onClick={preview} disabled={!bgm || !sound}>
          {playing ? '■ 停止' : '▶ 試聴'}
        </button>
        {!s.isCloud && (
          <>
            <button onClick={() => fileInput.current?.click()} disabled={uploading} title={`音声ファイルを sfx/${BGM_FOLDER}/ に取り込み、この案件の BGM にします`}>
              {uploading ? '取り込み中…' : '＋ 新しい BGM を追加'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={`audio/*,${BGM_EXTENSIONS.join(',')}`}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                void upload(f);
              }}
            />
          </>
        )}
      </div>
      {!candidates.length && (
        <p className="hint">
          {s.isCloud
            ? `PC 版で sfx/${BGM_FOLDER}/ に曲を追加すると、ここで選べるようになります`
            : `まだ曲がありません。「新しい BGM を追加」で取り込むか、sfx/${BGM_FOLDER}/ に置いて効果音の「ライブラリを読み直す」を押してください`}
          。使用権のある音源だけを使ってください
        </p>
      )}

      {bgm && r && (
        <>
          <div className="row" style={{marginTop: 6}}>
            {slider('音量', '0 dB が素材そのまま。声の下に敷くなら -14〜-22 dB が目安', r.gainDb, -40, 0, 0.5, 'dB', (v) => patch({gainDb: v}))}
            {slider('頭を飛ばす', 'イントロを飛ばしてサビから使うときなど。曲の頭から何秒飛ばすか', r.startSec, 0, Math.max(0, Math.floor(sound?.durSec ?? 120) - 1), 0.5, '秒', (v) => patch({startSec: v || undefined}))}
          </div>
          <div className="row" style={{marginTop: 6}}>
            {slider('フェードイン', '動画の頭で音を少しずつ上げる長さ', r.fadeInSec, 0, 5, 0.1, '秒', (v) => patch({fadeInSec: v}))}
            {slider('フェードアウト', '動画の終わりで音を少しずつ下げる長さ', r.fadeOutSec, 0, 5, 0.1, '秒', (v) => patch({fadeOutSec: v}))}
          </div>
          <div className="row" style={{marginTop: 6}}>
            <label title="曲が動画より短いとき、頭から繰り返して最後まで埋める">
              <span>曲が短ければ繰り返す</span>
              <input type="checkbox" checked={r.loop} onChange={(e) => patch({loop: e.target.checked === BGM_DEFAULTS.loop ? undefined : e.target.checked})} />
            </label>
            <label title="ナレーションが鳴っている間だけ BGM を自動で下げる（声が聞き取りやすくなる）">
              <span>声に被ったら BGM を下げる</span>
              <input type="checkbox" checked={r.duck} onChange={(e) => patch({duck: e.target.checked === BGM_DEFAULTS.duck ? undefined : e.target.checked})} />
            </label>
            <span style={{flex: 1}} />
            <button className="primary" onClick={() => s.saveFile('narration')} disabled={!s.files.narration.dirty}>
              narration.json を保存
            </button>
          </div>
          <IssueList rows={issues.map((x) => ({severity: x.severity, code: x.code, message: x.message}))} />
          {!!outFinal && (
            <div className="row" style={{marginTop: 8}}>
              <button className="primary" disabled={mixBusy || issues.some((x) => x.severity === 'E')} onClick={() => void applyToRenderedVideo()} title="既存の本番動画に BGM を合成し、完成動画を更新します">
                {mixBusy ? 'BGM を反映中…' : 'BGM 付きの完成動画を出力'}
              </button>
              <span className="hint">本番レンダーのやり直しは不要です。保存後に out/final_narration.mp4 を更新します</span>
            </div>
          )}
        </>
      )}
    </section>
  );
};
