// 顔モザイク（deface）の操作。Materials 画面の「まとめてかける」カードと、選んだクリップの詳細欄。
// 実行は mosaic / mosaic-revert ジョブ（core/mosaic.ts）。src の中身がモザイク版に入れ替わる（元は .studio に退避）。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {usePref} from '../hooks/usePref';
import {AiJobStatus} from './AiJobStatus';
import {localDate} from '@shared/time';
import {MOSAIC_DEFAULTS, mosaicLabel, resolveMosaicParams, spansText, type MosaicParams} from '@shared/mosaic';
import type {MosaicStatus} from '@shared/schema/settings';
import type {Clip} from '@shared/schema';

const RESTART_HINT = 'Reel Studio を再起動してください（画面だけ新しく、サーバーが古いプロセスです）';

/** 画面で変えられる設定（検出サイズ・間引き・保持秒は CLI の reel mosaic apply で） */
export type MosaicForm = Pick<MosaicParams, 'threshold' | 'cells' | 'maskScale'>;
const FORM_DEFAULTS: MosaicForm = {threshold: MOSAIC_DEFAULTS.threshold, cells: MOSAIC_DEFAULTS.cells, maskScale: MOSAIC_DEFAULTS.maskScale};

export const useMosaicForm = () => usePref<MosaicForm>('reel.mosaic.form', FORM_DEFAULTS);

/** deface が使えるか（サーバーが結果を覚えているので 2 回目からは速い） */
export const useMosaicStatus = () => {
  const [status, setStatus] = useState<MosaicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (refresh = false) => {
    try {
      const r = await api.get<MosaicStatus>(`/api/settings/mosaic${refresh ? '?refresh=1' : ''}`);
      setStatus(r.data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return {status, error, reload: load};
};

/** 画像・動画の URL に付ける版（同じパスのまま中身が入れ替わるので、ブラウザの表示を取り直させる） */
export const mediaVersion = (clip: Pick<Clip, 'mosaic'>): string => (clip.mosaic ? `?v=${Date.parse(clip.mosaic.checkedAt) || 0}` : '');

const useMosaicJobs = () => {
  const s = useStudio();
  const job = s.jobs.find((j) => (j.status === 'running' || j.status === 'queued') && (j.type === 'mosaic' || j.type === 'mosaic-revert') && j.slug === s.active);
  const stale = !s.supportsJob('mosaic');
  const start = async (type: 'mosaic' | 'mosaic-revert', ids: string[], form?: MosaicForm) => {
    if (s.files.catalog.dirty) return void s.toast('先に catalog.json を保存してください（モザイクの結果は catalog.json に書き込まれます）', 'error');
    if (!ids.length) return void s.toast('対象のクリップがありません', 'error');
    let params: MosaicParams | undefined;
    if (form) {
      try {
        params = resolveMosaicParams(form);
      } catch {
        return void s.toast('設定の値が範囲外です（しきい値 0.2〜0.95・マス 4〜24・範囲 1.0〜2.0）', 'error');
      }
    }
    await s.addJob(type, type === 'mosaic' ? {ids, params} : {ids});
  };
  return {job, stale, start};
};

export const MosaicCard: React.FC<{clips: Clip[]; shown: Clip[]; form: MosaicForm; setForm: (f: MosaicForm) => void; onSettings: () => void}> = ({clips, shown, form, setForm, onSettings}) => {
  const s = useStudio();
  const {status, error} = useMosaicStatus();
  const {job, stale, start} = useMosaicJobs();
  const [open, setOpen] = usePref('reel.mosaic.open', false);
  const applied = clips.filter((c) => c.mosaic?.applied).length;
  const noFaces = clips.filter((c) => c.mosaic && !c.mosaic.applied).length;
  const targets = shown.filter((c) => !c.user.ng);
  const ready = !!status?.ok && !stale;

  return (
    <section className="card mosaic-card">
      <details open={open || !!job} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <h2 style={{display: 'inline'}}>顔モザイク（deface）</h2>{' '}
          <span className="hint">
            モザイク済み {applied} 本 / 顔なし {noFaces} 本 / 未チェック {clips.length - applied - noFaces} 本
          </span>
        </summary>
        <p className="hint">
          店員さんや他のお客さんの顔を自動で見つけてモザイクをかけます（顔検出は{' '}
          <a href="https://github.com/ORB-HD/deface" target="_blank" rel="noreferrer">
            deface
          </a>
          ）。素材ファイルがモザイク版に入れ替わり、Timeline のプレビュー・レンダー・納品のすべてに効きます。元のファイルは残るので「元に戻す」で戻せます。顔が見つからなかったクリップは何も変えません。
        </p>
        <div className="row">
          {error ? (
            <span className="pill err">確認できません: {error}</span>
          ) : !status ? (
            <span className="hint">deface を確認中…</span>
          ) : status.ok ? (
            <span className="pill" title={`${status.python}${status.providers.length ? ` / ${status.providers.join(', ')}` : ''}`}>
              deface {status.deface} — {status.message}
            </span>
          ) : (
            <>
              <span className="pill err">使えません</span>
              <span className="hint">{status.message}</span>
              <button className="small" onClick={onSettings}>
                Settings で導入する →
              </button>
            </>
          )}
        </div>
        <div className="row" style={{marginTop: 6}}>
          <label title="顔とみなすスコア。下げると横顔や遠くの顔も拾いますが、料理の模様を顔と取り違えやすくなります（実測で料理の誤検出は 0.59 まで）">
            しきい値
            <input type="number" step={0.05} min={0.2} max={0.95} value={form.threshold} onChange={(e) => setForm({...form, threshold: Number(e.target.value)})} style={{width: 70}} />
          </label>
          <label title="顔 1 つを何マスに割るか。少ないほど粗く、誰だか分からなくなります">
            マス数（少ないほど粗い）
            <input type="number" step={1} min={4} max={24} value={form.cells} onChange={(e) => setForm({...form, cells: Number(e.target.value)})} style={{width: 60}} />
          </label>
          <label title="見つけた顔の枠を何倍に広げて隠すか。髪や輪郭まで隠したいときは大きく">
            隠す範囲（倍）
            <input type="number" step={0.1} min={1} max={2} value={form.maskScale} onChange={(e) => setForm({...form, maskScale: Number(e.target.value)})} style={{width: 60}} />
          </label>
          <button className="small" onClick={() => setForm(FORM_DEFAULTS)} disabled={form.threshold === FORM_DEFAULTS.threshold && form.cells === FORM_DEFAULTS.cells && form.maskScale === FORM_DEFAULTS.maskScale}>
            既定に戻す
          </button>
          <span style={{flex: 1}} />
          <button
            className="primary"
            onClick={() => void start('mosaic', targets.map((c) => c.id), form)}
            disabled={!ready || !!job || !targets.length}
            title={stale ? RESTART_HINT : '下の一覧に今表示されているクリップ（NG は除く）に順にかけます。モザイク済みのものは元のファイルからかけ直します'}
          >
            {job ? '処理中…' : `表示中の ${targets.length} 本にかける`}
          </button>
          <button onClick={() => void start('mosaic-revert', shown.filter((c) => c.mosaic).map((c) => c.id))} disabled={!!job || stale || !shown.some((c) => c.mosaic)} title="表示中のクリップのモザイクを外して元のファイルに戻します（「顔なし」の記録も消します）">
            表示中をすべて元に戻す
          </button>
        </div>
        <p className="hint">
          一覧の検索で「人物」「店内」などに絞ってからかけると速く済みます。1 本ごとに検出と書き出しをするので、GPU で 10 秒の素材あたり 20 秒ほど、CPU だとその数倍かかります。かけたあとは右の詳細で、顔の区間をクリックして確認してください。
        </p>
        {job && <AiJobStatus job={job} onCancel={(id) => void s.cancelJob(id)} compact />}
      </details>
    </section>
  );
};

export const MosaicClipSection: React.FC<{clip: Clip; form: MosaicForm; onSeek: (sec: number) => void}> = ({clip, form, onSeek}) => {
  const {job, stale, start} = useMosaicJobs();
  const m = clip.mosaic;
  return (
    <>
      <h3>
        顔モザイク <span className="hint">{mosaicLabel(m)}</span>
      </h3>
      <div className="row">
        <button className="small" onClick={() => void start('mosaic', [clip.id], form)} disabled={!!job || stale} title={stale ? RESTART_HINT : `しきい値 ${form.threshold}・${form.cells} マス・範囲 ×${form.maskScale}（上の「顔モザイク」カードの設定）`}>
          {m?.applied ? '今の設定でかけ直す' : m ? 'もう一度調べる' : 'このクリップにかける'}
        </button>
        {m && (
          <button className="small" onClick={() => void start('mosaic-revert', [clip.id])} disabled={!!job || stale}>
            {m.applied ? '元に戻す' : '記録を消す'}
          </button>
        )}
        {m?.applied &&
          m.spans.slice(0, 8).map((sp) => (
            <button key={sp.startSec} className="small" onClick={() => onSeek(sp.startSec)} title={`最大 ${sp.maxFaces} 人`}>
              ▶ {spansText([sp])}
            </button>
          ))}
      </div>
      {m && (
        <div className="hint">
          {localDate(m.checkedAt)} / しきい値 {m.params.threshold}・{m.params.cells} マス・範囲 ×{m.params.maskScale} / {m.engine}
          {m.spans.length > 8 ? ` / ほか ${m.spans.length - 8} か所` : ''}
        </div>
      )}
    </>
  );
};
