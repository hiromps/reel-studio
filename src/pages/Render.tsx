// Render：仕上げ（一気通貫）・レンダー・音の設定（ボイス／速度／音量）・効果音・キャプション・トライアル・納品・ジョブログ。
// ナレーションの原稿（文言・配置秒）と効果音 1 個ずつの位置は Timeline 画面で編集する。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useStudio} from '../state/store';
import {EmptyState} from '../components/EmptyState';
import {CaptionCard} from '../components/CaptionCard';
import {SfxCard} from '../components/SfxCard';
import {TrialCard} from '../components/TrialCard';
import {BuildCard} from '../components/BuildCard';
import {AiModelSelect, useAiModel} from '../hooks/useAiModel';
import {IssueList} from '../components/IssueList';
import {AI_JOB_LABEL, AiJobStatus} from '../components/AiJobStatus';
import type {Job} from '../api';
import type {Narration, NarrationSegment} from '@shared/schema';
import {findPersona} from '@shared/personas';
import {checkNarration} from '@shared/narration';
import {localTime} from '@shared/time';
import {api} from '../api';

type Voice = {id: string; title: string; source: 'own' | 'persona' | 'extra'; personas: string[]; state?: string};

export const RenderPage: React.FC<{onTab: (t: 'projects' | 'timeline' | 'settings') => void}> = ({onTab}) => {
  const s = useStudio();
  const [sel, setSel] = useState<string | null>(null);
  const [gl, setGl] = useState('swiftshader');
  const [concurrency, setConcurrency] = useState('');
  const [crf, setCrf] = useState('');
  const [cacheMb, setCacheMb] = useState('');
  const [retries, setRetries] = useState('3');
  const narration = s.files.narration.data;
  const needsTts = (narration?.segments ?? []).filter((seg) => (seg as {needsTts?: boolean}).needsTts || !seg.durSec).length;
  const aiBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type.startsWith('ai-') && j.slug === s.active);
  const staleNarration = !s.supportsJob('ai-narration');
  const ttsBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'tts' && j.slug === s.active);
  const ttsChars = (narration?.segments ?? []).filter((seg) => (seg as {needsTts?: boolean}).needsTts || !seg.durSec).reduce((n, seg) => n + [...seg.text].length, 0);
  const ttsBlockedBy = !s.supportsJob('tts')
    ? 'サーバーが古いプロセスです。Reel Studio を再起動してください'
    : s.config?.tts === false
      ? 'Fish Audio の API キーが未設定です（Settings の「音声生成」で設定）'
      : s.files.narration.dirty
        ? 'narration.json に未保存の変更があります。保存してから生成してください'
        : ttsBusy
          ? '生成中です'
          : null;
  const canTts = !!narration && !ttsBlockedBy;
  const briefPersona = s.files.brief.data ? findPersona(s.files.brief.data.persona) : undefined;
  const cps = briefPersona?.narration.charsPerSec ?? 11;
  const personaSpeed = briefPersona?.narration.speed ?? 1.6;
  const segSec = (seg: NarrationSegment) => seg.durSec ?? [...seg.text].length / cps;
  const setNarr = (next: Narration) => s.setFile('narration', next);
  const narrIssues = useMemo(() => (narration ? checkNarration(narration, {estimate: segSec, emptyText: true}) : []), [narration, cps]);
  const [aiModel, setAiModel] = useAiModel();
  const [force, setForce] = useState(false);
  const [noSync, setNoSync] = useState(false);
  const [strictProxy, setStrictProxy] = useState(false);
  const [cut, setCut] = useState('1');
  const [offset, setOffset] = useState('0.3');
  const [qcVideo, setQcVideo] = useState('out/final.mp4');
  const [deliverLabel, setDeliverLabel] = useState('');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  useEffect(() => {
    void api
      .get<{voices: Voice[]; apiError?: string}>('/api/tts/voices')
      .then((r) => {
        setVoices(r.data.voices ?? []);
        setVoiceErr(r.data.apiError ?? null);
      })
      .catch((e) => setVoiceErr((e as Error).message));
  }, []);
  /** すでにある wav を全部使えなくする（ボイス・速度を変えたとき） */
  const invalidateAll = (patch: Partial<Narration>) => {
    if (!narration) return;
    setNarr({
      ...narration,
      ...patch,
      segments: narration.segments.map((sg) => {
        const n: NarrationSegment = {...sg, needsTts: true};
        delete (n as {durSec?: number}).durSec;
        return n;
      }),
    });
  };
  const changeVoice = (id: string) => {
    if (!narration || id === narration.voice) return;
    invalidateAll({voice: id, voiceTitle: voices.find((x) => x.id === id)?.title});
  };
  const changeSpeed = (v: number) => {
    if (!narration || v === (narration.speed ?? personaSpeed)) return;
    invalidateAll({speed: v});
  };

  // ── 試聴 ──────────────────────────────────────────────
  const audio = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSpeed = async (text: string) => {
    if (!narration) return;
    audio.current?.pause();
    setPreviewing(true);
    try {
      const res = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text, voice: narration.voice, speed: narration.speed ?? personaSpeed, latency: narration.latency}),
      });
      if (!res.ok) throw new Error(((await res.json()) as {error?: string}).error ?? `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        setPreviewing(false);
      };
      await a.play();
    } catch (e) {
      s.toast(`試聴できませんでした: ${(e as Error).message}`, 'error');
      setPreviewing(false);
    }
  };

  const jobs = useMemo(() => s.jobs.filter((j) => !s.active || j.slug === s.active), [s.jobs, s.active]);
  const job = jobs.find((j) => j.id === sel) ?? jobs[0];
  // この案件で走っている AI / 音声生成のジョブ（仕上げは BuildCard が自分で出す）
  const liveJob = jobs.find((j) => (j.status === 'running' || j.status === 'queued') && (j.type.startsWith('ai-') || j.type === 'tts'));
  const log = job ? (s.logs[job.id] ?? job.logTail ?? []) : [];

  useEffect(() => {
    if (job && !s.logs[job.id]) void s.fetchJobLog(job.id);
  }, [job, s]);

  const opts = () => ({
    gl,
    concurrency: concurrency ? Number(concurrency) : undefined,
    crf: crf ? Number(crf) : undefined,
    cacheBytes: cacheMb ? Number(cacheMb) * 1024 * 1024 : undefined,
    retries: retries ? Number(retries) : undefined,
    force,
    noSync,
    strictProxy,
  });

  const outFiles = s.projects.find((p) => p.slug === s.active)?.out;
  const mixBlockedBy = !narration ? 'ナレーション原稿がまだありません' : needsTts > 0 ? `${needsTts} ブロックの音声がまだありません` : outFiles && !outFiles.final ? 'out/final.mp4 がありません。先に「本番レンダー」を実行してください' : null;
  const deliverBlockedBy = !s.supportsJob('deliver') ? 'サーバーが古いプロセスです。再起動してください' : outFiles && !outFiles.narration ? 'out/final_narration.mp4 がありません。本番レンダー →「ナレーション合成（mix）」の順で作ってください' : null;
  const lastPreflightFail = s.jobs.find((j) => (j.type === 'render' || j.type === 'draft' || j.type === 'build') && j.slug === s.active && j.status === 'failed' && /preflight に失敗/.test(j.error ?? ''));
  const preflightErrors = (lastPreflightFail?.error ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((l) => l && !/preflight に失敗|で止まりました|残り:/.test(l));
  const forceRender = (type: 'render' | 'draft') => {
    const list = preflightErrors.map((e) => `・${e}`).join('\n');
    if (!window.confirm(`検証の指摘を無視してレンダーします。\n\n${list}\n\nこのまま実行しますか？`)) return;
    void s.addJob(type, {...opts(), allowErrors: true});
  };
  const cutsDirty = s.files.cuts.dirty;
  const canRender = !!s.active && !cutsDirty;
  const resultOf = (j: Job) => {
    const r = j.result as
      | {
          outRel?: string;
          qcTileRel?: string;
          frames?: number;
          expectedFrames?: number;
          sizeBytes?: number;
          durationSec?: number;
          attempts?: number;
          warnings?: string[];
          synced?: string[];
          applied?: number;
          files?: {name: string; kind: string; mb: number; skipped?: string}[];
          outputsDir?: string;
          items?: {id: string; label: string; changes: string[]; outRel: string; deliveredAs?: string; mb: number; durationSec: number}[];
          ran?: string[];
          delivered?: string[];
        }
      | undefined;
    if (!r) return null;
    return (
      <div className="result">
        {r.outRel && /\.mp4$/.test(r.outRel) && (
          <div>
            <video src={`${s.mediaBase}/${r.outRel}?t=${j.endedAt}`} controls />
            <div className="hint">
              {r.outRel} {r.sizeBytes ? `${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ''} {r.frames !== undefined ? `${r.frames}f / 期待 ${r.expectedFrames}f` : ''} {r.durationSec ? `${r.durationSec.toFixed(2)}s` : ''} {r.attempts ? `（${r.attempts} 回目で成功）` : ''}
            </div>
          </div>
        )}
        {r.outRel && /\.png$/.test(r.outRel) && <img src={`${s.mediaBase}/${r.outRel}?t=${j.endedAt}`} alt="" style={{maxWidth: 320}} />}
        {r.qcTileRel && <img src={`${s.mediaBase}/${r.qcTileRel}?t=${j.endedAt}`} alt="QC" />}
        {r.warnings?.map((w, i) => (
          <div key={i} className="issue W">
            <span className="code">W</span>
            <span>{w}</span>
          </div>
        ))}
        {r.items && (
          <div>
            {r.items.map((it) => (
              <div key={it.id} style={{marginBottom: 8}}>
                <video src={`${s.mediaBase}/${it.outRel}`} controls style={{maxWidth: 220}} />
                <div className="hint">
                  <b>{it.id}</b>
                  {it.label ? `（${it.label}）` : ''} {it.changes.join(' / ')} — {it.durationSec.toFixed(2)}s / {it.mb} MB
                </div>
                {it.deliveredAs && <div className="hint">→ {it.deliveredAs}</div>}
              </div>
            ))}
          </div>
        )}
        {r.files && (
          <div>
            {r.files.map((f) => (
              <div key={f.name} className="hint">
                {f.skipped ? '=' : '→'} {f.name}
                {f.kind !== 'caption' ? `（${f.mb} MB）` : ''}
                {f.skipped ? '（同じものが既にありました）' : ''}
              </div>
            ))}
            <div className="hint">{r.outputsDir}</div>
          </div>
        )}
        {r.ran && <div className="hint">実行: {r.ran.join(' → ')}{r.delivered?.length ? ` ／ 納品: ${r.delivered.join(', ')}` : ''}</div>}
        {r.synced && <div className="hint">同期: {r.synced.join(', ') || 'なし'}</div>}
        {r.applied !== undefined && <div className="hint">alias 適用: {r.applied}</div>}
      </div>
    );
  };

  if (!s.active)
    return (
      <div className="page">
        <EmptyState title="案件が開かれていません" steps={['Projects で案件を開く']} action={{label: 'Projects へ', onClick: () => onTab('projects')}} />
      </div>
    );

  return (
    <div className="page">
      <BuildCard onTab={onTab} />
      {liveJob && <AiJobStatus job={liveJob} onCancel={(id) => void s.cancelJob(id)} lines={4} />}

      <section className="card" data-tour="render-run">
        <h2>レンダー（手動）</h2>
        <p className="hint">
          まず<b>ドラフト</b>（0.25 倍・粗い・速い）で全体を通して確認し、問題なければ<b>本番レンダー</b>。書き出したファイルは案件フォルダの out/ に入り、下に再生できる形で出ます。上の「仕上げ」を使えばここは押さなくてよい。
        </p>
        {cutsDirty && (
          <p className="hint" style={{color: 'var(--warn)'}}>
            cuts.json に未保存の変更があります。
            <button className="small" onClick={() => onTab('timeline')}>
              Timeline で保存
            </button>{' '}
            してからレンダーしてください。
          </p>
        )}
        <div className="row">
          <button className="primary" onClick={() => s.addJob('draft', opts())} disabled={!canRender}>
            ドラフト（0.25 倍・crf30）
          </button>
          <button className="primary" onClick={() => s.addJob('render', opts())} disabled={!canRender}>
            本番レンダー（h264 crf20）
          </button>
          <label>
            カット
            <input type="number" min={1} value={cut} onChange={(e) => setCut(e.target.value)} style={{width: 64}} />
          </label>
          <label>
            オフセット秒
            <input type="number" step={0.1} value={offset} onChange={(e) => setOffset(e.target.value)} style={{width: 64}} />
          </label>
          <button onClick={() => s.addJob('still', {cut: Number(cut), offsetSec: Number(offset), gl})} disabled={!canRender}>
            スチル
          </button>
          <label>
            QC 対象
            <select value={qcVideo} onChange={(e) => setQcVideo(e.target.value)}>
              <option value="out/final.mp4">out/final.mp4</option>
              <option value="out/draft.mp4">out/draft.mp4</option>
              <option value="out/final_narration.mp4">out/final_narration.mp4</option>
            </select>
          </label>
          <button onClick={() => s.addJob('qc-tile', {video: qcVideo})}>QC タイル</button>
        </div>
        {preflightErrors.length > 0 && (
          <div className="issues" style={{marginTop: 6}}>
            <div className="hint" style={{color: 'var(--warn)'}}>
              前回のレンダーが検証で止まりました。並びやテロップを自分で決めていて、この指摘を承知のうえで進めたい場合は「承知でレンダー」を押してください
            </div>
            {preflightErrors.map((e, i) => (
              <div key={i} className="issue E">
                <span className="code">E</span>
                <span>{e}</span>
              </div>
            ))}
            <div className="row" style={{marginTop: 6}}>
              <button className="warn" onClick={() => forceRender('render')} disabled={!canRender}>
                指摘を承知で本番レンダー
              </button>
              <button className="warn" onClick={() => forceRender('draft')} disabled={!canRender}>
                指摘を承知でドラフト
              </button>
              <span className="hint">素材が見つからない・尺を超えているなど、そもそもレンダーが失敗するものは承知でも通しません</span>
            </div>
          </div>
        )}
        <details style={{marginTop: 8}}>
          <summary className="hint">オプション（gl / concurrency / crf / cache / retries / force / no-sync / strict-proxy）・保守</summary>
          <div className="row" style={{marginTop: 6}}>
            <label>
              gl
              <select value={gl} onChange={(e) => setGl(e.target.value)}>
                {['swiftshader', 'angle', 'swangle', 'vulkan', 'egl'].map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label>
              concurrency
              <input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} placeholder="auto" style={{width: 64}} />
            </label>
            <label>
              crf
              <input value={crf} onChange={(e) => setCrf(e.target.value)} placeholder="20" style={{width: 64}} />
            </label>
            <label>
              cache MB
              <input value={cacheMb} onChange={(e) => setCacheMb(e.target.value)} placeholder="256" style={{width: 64}} />
            </label>
            <label>
              retries
              <input value={retries} onChange={(e) => setRetries(e.target.value)} style={{width: 64}} />
            </label>
            <label>
              <span>force（W を無視）</span>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            </label>
            <label>
              <span>no-sync</span>
              <input type="checkbox" checked={noSync} onChange={(e) => setNoSync(e.target.checked)} />
            </label>
            <label>
              <span>strict-proxy</span>
              <input type="checkbox" checked={strictProxy} onChange={(e) => setStrictProxy(e.target.checked)} />
            </label>
          </div>
          <div className="row" style={{marginTop: 6}}>
            <button onClick={() => s.addJob('aliases')}>alias 適用</button>
            <button onClick={() => s.addJob('proxy')}>HEVC/4K プロキシ</button>
            <button onClick={() => s.addJob('sync-engine')}>エンジン同期</button>
            <button onClick={() => s.addJob('npm-install')}>npm install</button>
          </div>
        </details>
      </section>

      <section className="card" data-tour="narration">
        <div className="summary">
          <span>
            <b>ナレーション（声の設定と音声生成）</b>
          </span>
          <span>
            {narration ? `${narration.segments.length} ブロック` : '未作成'}
            {narration && needsTts > 0 ? ` / 音声待ち ${needsTts}` : narration ? ' / 音声あり' : ''}
          </span>
          <span className="hint">原稿の文言と配置秒は Timeline の N 段で直します。レンダーは素材の音だけで、完成品はここで合成した out/final_narration.mp4 です</span>
          <span style={{flex: 1}} />
          <button className="small" onClick={() => onTab('timeline')}>
            原稿を Timeline で直す →
          </button>
        </div>
        <div className="row">
          <button className="primary" onClick={() => s.addJob('ai-narration', {model: aiModel})} disabled={aiBusy || staleNarration || !s.files.cuts.data}>
            {aiBusy ? 'AI が作業中…' : narration ? 'AI に原稿を書き直してもらう' : 'AI にナレーションを書いてもらう'}
          </button>
          <AiModelSelect value={aiModel} onChange={setAiModel} label="原稿のモデル" />
          {narration && (
            <label title="読み上げるボイス（Fish Audio のモデル）。変えると全ブロックの音声を作り直します">
              ボイス
              <select value={narration.voice} onChange={(e) => changeVoice(e.target.value)}>
                {!voices.some((v) => v.id === narration.voice) && <option value={narration.voice}>{narration.voiceTitle ?? narration.voice}（一覧に無い）</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                    {v.personas.length ? `（${v.personas.join('・')}の既定）` : v.source === 'own' ? '（自分のモデル）' : v.source === 'extra' ? '（追加ボイス）' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {narration && (
            <label title="読み上げの速さ。変えると全ブロックの音声を作り直します（話速が変わるので尺も変わります）">
              速度
              <span className="btns">
                <input type="range" min={0.5} max={2} step={0.05} value={narration.speed ?? personaSpeed} onChange={(e) => changeSpeed(Number(e.target.value))} style={{width: 110}} />
                <span className="counter">{(narration.speed ?? personaSpeed).toFixed(2)}</span>
                {(narration.speed ?? personaSpeed) !== personaSpeed && (
                  <button className="small" onClick={() => changeSpeed(personaSpeed)} title={`人格の既定 ${personaSpeed} に戻す`}>
                    既定に戻す
                  </button>
                )}
              </span>
            </label>
          )}
          {narration && (
            <button className="small" onClick={() => void previewSpeed(narration.segments[0]?.text || 'この速さで読み上げます')} disabled={previewing || s.config?.tts === false} title="いまのボイスと速度で1本だけ作って鳴らします（ファイルは作りません）">
              {previewing ? '試聴中…' : '▶ この速度で試聴'}
            </button>
          )}
          {voiceErr && (
            <span className="hint" style={{color: 'var(--warn)'}}>
              ボイス一覧: {voiceErr}
            </span>
          )}
        </div>
        {narration && (
          <div className="row" style={{marginTop: 6}}>
            <button className="primary" onClick={() => s.addJob('tts')} disabled={!canTts || needsTts === 0} title={ttsBlockedBy ?? (needsTts === 0 ? 'すべてのブロックに音声があります' : undefined)}>
              {ttsBusy ? '音声を生成中…' : `音声を生成（${needsTts} ブロック / ${ttsChars} 字）`}
            </button>
            <button onClick={() => s.addJob('tts', {force: true})} disabled={!canTts} title={ttsBlockedBy ?? '音声がある分も含めて全ブロック作り直す'}>
              全部作り直す（{narration.segments.length} ブロック）
            </button>
            <span className="hint">{ttsBlockedBy ?? `ボイス ${narration.voiceTitle ?? narration.voice} / speed ${narration.speed ?? personaSpeed} で narration/<id>.wav を作ります`}</span>
            {s.config?.tts === false && (
              <button className="small" onClick={() => onTab('settings')}>
                Settings へ
              </button>
            )}
          </div>
        )}
        {narration && (
          <>
            <div className="row" style={{marginTop: 6}}>
              <label title="ナレーション帯域に足すゲイン。混合後に -14 LUFS へ正規化されるので、上げると声が環境音より前に出ます">
                声の大きさ
                <span className="btns">
                  <input type="range" min={-6} max={12} step={0.5} value={narration.narrationGainDb ?? 0} onChange={(e) => setNarr({...narration, narrationGainDb: Number(e.target.value)})} style={{width: 130}} />
                  <span className="counter">
                    {(narration.narrationGainDb ?? 0) > 0 ? '+' : ''}
                    {(narration.narrationGainDb ?? 0).toFixed(1)} dB
                  </span>
                </span>
              </label>
              <label title="元素材の環境音の音量。下げるとナレーションが相対的に立ちます（既定 0.22）">
                環境音
                <span className="btns">
                  <input type="range" min={0} max={0.6} step={0.01} value={narration.ambientGain ?? 0.22} onChange={(e) => setNarr({...narration, ambientGain: Number(e.target.value)})} style={{width: 130}} />
                  <span className="counter">{Math.round((narration.ambientGain ?? 0.22) * 100)}%</span>
                </span>
              </label>
              <span className="hint">変えたら「ナレーション合成（mix）」をやり直すと反映されます（音声の再生成は不要）</span>
              <span style={{flex: 1}} />
              <button onClick={() => s.loadFile('narration')}>読み直す</button>
              <button className="primary" onClick={() => s.saveFile('narration')} disabled={!s.files.narration.dirty}>
                narration.json を保存
              </button>
              {s.files.narration.external && (
                <button className="warn" onClick={() => s.saveFile('narration', true)}>
                  外部変更を上書き
                </button>
              )}
            </div>
            <div className="narr-list">
              {[...narration.segments]
                .sort((a, b) => a.at - b.at)
                .map((seg) => (
                  <div key={seg.id} className={`narr-row compact${seg.needsTts ? ' needs-tts' : ''}`} title={seg.needsTts ? '要再生成' : `実測 ${seg.durSec?.toFixed(2)}s`}>
                    <span className="narr-id mono">{seg.id}</span>
                    <span className="counter">{seg.at.toFixed(2)}s</span>
                    <span className="narr-text-ro">{seg.text}</span>
                    <span className="counter">{seg.needsTts ? '要再生成' : `${seg.durSec?.toFixed(1)}s`}</span>
                  </div>
                ))}
            </div>
            <IssueList rows={narrIssues.map((mm) => ({severity: 'W', message: mm}))} />
            <span className="hint">
              <b>同じ文・同じ速度でも長さが 0.96〜2.29 秒ばらつく</b>ので（実測）、納得いく読みが出るまで Timeline のインスペクタで「この 1 本だけ生成」で引き直せます。
              {(narration.speed ?? personaSpeed) !== personaSpeed ? `／速度を ${personaSpeed} から変えているので「見積」は当てになりません。実測は音声を作ったあとに出ます` : ''}
            </span>
          </>
        )}
      </section>
      <SfxCard onTab={onTab} />
      <CaptionCard aiModel={aiModel} />
      <TrialCard />

      <section className="card" data-tour="deliver">
        <h2>合成と納品（手動）</h2>
        {(mixBlockedBy || deliverBlockedBy) && (
          <p className="hint" style={{color: 'var(--warn)'}}>
            {mixBlockedBy ?? deliverBlockedBy}
          </p>
        )}
        <div className="row">
          <button onClick={() => s.addJob('mix', {input: 'out/final.mp4', output: 'out/final_narration.mp4'})} disabled={!!mixBlockedBy} title={mixBlockedBy ?? 'narration.json と narration/*.wav を out/final.mp4 に混ぜます'}>
            ナレーション合成（mix）
          </button>
          <button className="primary" onClick={() => s.addJob('deliver', {label: deliverLabel.trim() || undefined})} disabled={!!deliverBlockedBy} title={deliverBlockedBy ?? '完成品（ナレーション付き mp4 とキャプション）を outputs/ に書き出します。draft と音声なしは出しません'}>
            納品（outputs/ へ）
          </button>
          <input value={deliverLabel} onChange={(e) => setDeliverLabel(e.target.value)} placeholder="名前に足す語（任意）：修正版 など" style={{width: 190}} />
          {job && (job.status === 'running' || job.status === 'queued') && (
            <button className="danger" onClick={() => s.cancelJob(job.id)}>
              中断
            </button>
          )}
        </div>
      </section>

      <div className="jobs">
        <section className="card">
          <h2>ジョブ</h2>
          {jobs.length === 0 && <p className="hint">まだありません</p>}
          {jobs.map((j) => (
            <div key={j.id} className={`job ${j.status}${job?.id === j.id ? ' selected' : ''}`} onClick={() => setSel(j.id)}>
              <div>
                <b>{AI_JOB_LABEL[j.type] && j.type === 'build' ? '仕上げ' : j.type}</b> <span className="hint">{j.slug}</span>
              </div>
              <div className="st">
                {j.status} {localTime(j.startedAt ?? j.createdAt)}
                {j.endedAt && j.startedAt ? ` (${Math.round((new Date(j.endedAt).getTime() - new Date(j.startedAt).getTime()) / 1000)}s)` : ''}
                {j.progress ? ` ${j.progress.phase} ${j.progress.total > 0 && j.progress.total <= 12 ? `${j.progress.done}/${j.progress.total}` : `${j.progress.done}/${j.progress.total}`}` : ''}
              </div>
              {j.progress && j.status === 'running' && (
                <div className="progress">
                  <div style={{width: `${Math.min(100, (100 * j.progress.done) / Math.max(1, j.progress.total))}%`}} />
                </div>
              )}
              {j.error && <div className="st">{j.error.split('\n')[0]}</div>}
            </div>
          ))}
        </section>
        <section className="card">
          <h2>{job ? `${job.type} #${job.id}` : 'ログ'}</h2>
          {job && resultOf(job)}
          <div className="log">{log.join('\n')}</div>
        </section>
      </div>
    </div>
  );
};
