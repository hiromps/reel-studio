// Render：ジョブ投入（draft / render / still / QC / alias / proxy / sync / mix）とライブログ・結果表示。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useStudio} from '../state/store';
import {EmptyState} from '../components/EmptyState';
import {CaptionCard} from '../components/CaptionCard';
import {SfxCard} from '../components/SfxCard';
import {TrialCard} from '../components/TrialCard';
import type {Job} from '../api';
import type {Narration, NarrationSegment} from '@shared/schema';
import {PERSONAS} from '@shared/personas';
import {applyReadingHints, checkNarration, fixNarrationOverlaps, ttsReadingHints} from '@shared/narration';
import {localTime} from '@shared/time';
import {api} from '../api';

type Voice = {id: string; title: string; source: 'own' | 'persona' | 'extra'; personas: string[]; state?: string};

export const RenderPage: React.FC<{onTab: (t: 'projects' | 'timeline') => void}> = ({onTab}) => {
  const s = useStudio();
  const [sel, setSel] = useState<string | null>(null);
  const [gl, setGl] = useState('swiftshader');
  const [concurrency, setConcurrency] = useState('');
  const [crf, setCrf] = useState('');
  const [cacheMb, setCacheMb] = useState('');
  const [retries, setRetries] = useState('3');
  const narration = s.files.narration.data;
  const needsTts = (narration?.segments ?? []).filter((seg) => (seg as {needsTts?: boolean}).needsTts || !seg.durSec).length;
  const aiBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type.startsWith('ai-'));
  const staleNarration = !s.supportsJob('ai-narration');
  // 音声生成（Fish Audio）。サーバーは narration.json を読むので、未保存の編集があると古い文言で作ってしまう
  const ttsBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'tts');
  const ttsChars = (narration?.segments ?? []).filter((seg) => (seg as {needsTts?: boolean}).needsTts || !seg.durSec).reduce((n, seg) => n + [...seg.text].length, 0);
  const ttsBlockedBy = !s.supportsJob('tts')
    ? 'サーバーが古いプロセスです。Reel Studio を再起動してください'
    : s.config?.tts === false
      ? 'FISH_API_KEY が見つかりません（.claude/settings.local.json の env に設定）'
      : s.files.narration.dirty
        ? 'narration.json に未保存の変更があります。保存してから生成してください'
        : ttsBusy
          ? '生成中です'
          : null;
  const canTts = !!narration && !ttsBlockedBy;
  // 文字数から読み上げ秒を見積もる（実測 durSec があればそちらを使う）
  const cps = s.files.brief.data ? PERSONAS[s.files.brief.data.persona].narration.charsPerSec : 11;
  const personaSpeed = s.files.brief.data ? PERSONAS[s.files.brief.data.persona].narration.speed : 1.6;
  const segSec = (seg: NarrationSegment) => seg.durSec ?? [...seg.text].length / cps;
  const setNarr = (next: Narration) => s.setFile('narration', next);
  const patchSeg = (i: number, patch: Partial<NarrationSegment>, retts = false) => {
    if (!narration) return;
    setNarr({
      ...narration,
      segments: narration.segments.map((sg, k) => {
        if (k !== i) return sg;
        const n: NarrationSegment = {...sg, ...patch};
        // 文言を変えたら既存の wav は使えない。実測尺も無効にする
        if (retts) {
          n.needsTts = true;
          delete (n as {durSec?: number}).durSec;
        }
        return n;
      }),
    });
  };
  const removeSeg = (i: number) => narration && setNarr({...narration, segments: narration.segments.filter((_, k) => k !== i)});
  const addSeg = () => {
    if (!narration) return;
    const last = narration.segments[narration.segments.length - 1];
    const at = last ? Math.round((last.at + segSec(last) + 0.2) * 1000) / 1000 : 0.15;
    const used = new Set(narration.segments.map((x) => x.id));
    let n = narration.segments.length + 1;
    while (used.has(`${String(n).padStart(2, '0')}_new`)) n++;
    setNarr({...narration, segments: [...narration.segments, {id: `${String(n).padStart(2, '0')}_new`, at, text: '', needsTts: true}]});
  };
  const sortSegs = () => narration && setNarr({...narration, segments: [...narration.segments].sort((a, b) => a.at - b.at)});
  // 重なり・無音・尺はみ出しを、いまの内容から出す（判定は core/tts.ts と同じ）
  const narrIssues = useMemo(() => (narration ? checkNarration(narration, {estimate: segSec, emptyText: true}) : []), [narration, cps]);
  /**
   * 重なりを at をずらすだけで解消する。**音声は作り直さない**（at は混合時の配置位置なので）。
   * 収まりきらないぶんは知らせるだけ（文を削るのは人の判断）。
   */
  const fixOverlaps = () => {
    if (!narration) return;
    const r = fixNarrationOverlaps(narration, {estimate: segSec});
    if (!r.moved.length) return s.toast('動かす必要のあるブロックはありませんでした', 'info');
    setNarr({...narration, segments: r.segments});
    for (const n of r.notes) s.toast(n, n.startsWith('!') || n.includes('  !') ? 'error' : 'info');
  };

  // 裏で走らせる Claude のモデル（他画面と同じ設定を共有する）
  const [aiModel, setAiModel] = useState(() => {
    try {
      return localStorage.getItem('reel-studio.aiModel') ?? 'opus';
    } catch {
      return 'opus';
    }
  });
  const changeAiModel = (v: string) => {
    setAiModel(v);
    try {
      localStorage.setItem('reel-studio.aiModel', v);
    } catch {
      /* 記憶できなくても動作には影響しない */
    }
  };
  const [force, setForce] = useState(false);
  const [noSync, setNoSync] = useState(false);
  const [strictProxy, setStrictProxy] = useState(false);
  const [cut, setCut] = useState('1');
  const [offset, setOffset] = useState('0.3');
  const [qcVideo, setQcVideo] = useState('out/final.mp4');
  const [deliverLabel, setDeliverLabel] = useState('');
  // 選べるボイス（自分の Fish Audio モデル ＋ 人格の既定ボイス）
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
  /**
   * ボイスを変えると、すでにある wav は**全部**別人の声なので使えない。
   * 全ブロックを要再生成にして実測尺も捨てる（消し忘れると声が混ざったまま mix される）
   */
  const changeVoice = (id: string) => {
    if (!narration || id === narration.voice) return;
    invalidateAll({voice: id, voiceTitle: voices.find((x) => x.id === id)?.title});
  };
  /** 速度も同じ。話速が変わると wav の長さが変わるので実測尺も捨てる */
  const changeSpeed = (v: number) => {
    if (!narration || v === (narration.speed ?? personaSpeed)) return;
    invalidateAll({speed: v});
  };

  // ── 試聴 ──────────────────────────────────────────────
  const audio = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const stopAudio = () => {
    audio.current?.pause();
    audio.current = null;
    setPreviewing(null);
  };
  /** 生成済みの wav をそのまま鳴らす */
  const playWav = (id: string) => {
    stopAudio();
    if (!s.mediaBase) return;
    const a = new Audio(`${s.mediaBase}/narration/${encodeURIComponent(id)}.wav?t=${Date.now()}`);
    audio.current = a;
    setPreviewing(id);
    a.onended = () => setPreviewing(null);
    void a.play().catch(() => {
      s.toast('音声が見つかりません（まだ生成していないかもしれません）', 'error');
      setPreviewing(null);
    });
  };
  /**
   * いまのボイスと速度で 1 本だけ作って鳴らす（**案件のファイルには何も書かない**）。
   * 速度を決める前に何度でも試せるようにするため。
   */
  const previewSpeed = async (text: string, key = 'speed') => {
    if (!narration) return;
    stopAudio();
    setPreviewing(key);
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
        setPreviewing(null);
      };
      await a.play();
    } catch (e) {
      s.toast(`試聴できませんでした: ${(e as Error).message}`, 'error');
      setPreviewing(null);
    }
  };

  const jobs = useMemo(() => s.jobs.filter((j) => !s.active || j.slug === s.active || j.slug === `${s.active}`), [s.jobs, s.active]);
  const job = jobs.find((j) => j.id === sel) ?? jobs[0];
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

  // out/ に何が書き出されているか（レンダー前に mix を押して ffmpeg のエラーを見る、を防ぐ）
  const outFiles = s.projects.find((p) => p.slug === s.active)?.out;
  const mixBlockedBy = !narration
    ? 'ナレーション原稿がまだありません'
    : needsTts > 0
      ? `${needsTts} ブロックの音声がまだありません`
      : outFiles && !outFiles.final
        ? 'out/final.mp4 がありません。先に「本番レンダー」を実行してください'
        : null;
  const deliverBlockedBy = !s.supportsJob('deliver')
    ? 'サーバーが古いプロセスです。再起動してください'
    : outFiles && !outFiles.narration
      ? 'out/final_narration.mp4 がありません。本番レンダー →「ナレーション合成（mix）」の順で作ってください'
      : null;
  /**
   * 直近のレンダーが preflight（検証）で落ちていたら、その E を拾って
   * 「承知で実行する」導線を出す。並びを自分で決めたときに、検証の意見で詰まないため。
   */
  const lastPreflightFail = s.jobs.find((j) => (j.type === 'render' || j.type === 'draft') && j.status === 'failed' && /preflight に失敗/.test(j.error ?? ''));
  const preflightErrors = (lastPreflightFail?.error ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((l) => l && !/^preflight に失敗/.test(l));
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
        }
      | undefined;
    if (!r) return null;
    return (
      <div className="result">
        {r.outRel && /\.mp4$/.test(r.outRel) && (
          <div>
            <video src={`${s.mediaBase}/${r.outRel}`} controls />
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
      <section className="card" data-tour="render-run">
        <h2>実行</h2>
        <p className="hint">
          まず<b>ドラフト</b>（0.25 倍・粗い・速い）で全体を通して確認し、問題なければ<b>本番レンダー</b>。書き出したファイルは案件フォルダの out/ に入り、下に再生できる形で出ます。
        </p>
        {cutsDirty && (
          <p className="hint" style={{color: 'var(--warn)'}}>
            cuts.json に未保存の変更があります。<button className="small" onClick={() => onTab('timeline')}>Timeline で保存</button> してからレンダーしてください。
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
        <section className="card" style={{marginTop: 8}} data-tour="narration">
          <div className="summary">
            <span>
              <b>ナレーション</b>
            </span>
            <span>
              {narration ? `${narration.segments.length} ブロック` : '未作成'}
              {narration && needsTts > 0 ? ` / 音声待ち ${needsTts}` : narration ? ' / 音声あり' : ''}
            </span>
            <span className="hint">レンダーは素材の音だけです。完成品はここで合成した out/final_narration.mp4 です</span>
          </div>
          <div className="row">
            <button className="primary" onClick={() => s.addJob('ai-narration', {model: aiModel})} disabled={aiBusy || staleNarration || !s.files.cuts.data}>
              {aiBusy ? 'AI が作業中…' : narration ? 'AI に原稿を書き直してもらう' : 'AI にナレーションを書いてもらう'}
            </button>
            <label title="原稿を書かせる Claude のモデル">
              原稿のモデル
              <select value={aiModel} onChange={(e) => changeAiModel(e.target.value)}>
                <option value="opus">opus（精度重視）</option>
                <option value="sonnet">sonnet（速い・安い）</option>
                <option value="haiku">haiku（最安）</option>
              </select>
            </label>
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
              <button
                className="small"
                onClick={() => void previewSpeed(narration.segments[0]?.text || 'この速さで読み上げます')}
                disabled={previewing === 'speed' || s.config?.tts === false}
                title="いまのボイスと速度で1本だけ作って鳴らします（ファイルは作りません）"
              >
                {previewing === 'speed' ? '試聴中…' : '▶ この速度で試聴'}
              </button>
            )}
            {voiceErr && <span className="hint" style={{color: 'var(--warn)'}}>ボイス一覧: {voiceErr}</span>}
          </div>
          {narration && (
            <div className="row" style={{marginTop: 6}}>
              <button className="primary" onClick={() => s.addJob('tts')} disabled={!canTts || needsTts === 0} title={ttsBlockedBy ?? (needsTts === 0 ? 'すべてのブロックに音声があります' : undefined)}>
                {ttsBusy ? '音声を生成中…' : `音声を生成（${needsTts} ブロック / ${ttsChars} 字）`}
              </button>
              <button onClick={() => s.addJob('tts', {force: true})} disabled={!canTts} title={ttsBlockedBy ?? '音声がある分も含めて全ブロック作り直す'}>
                全部作り直す（{narration.segments.length} ブロック）
              </button>
              <span className="hint">
                {ttsBlockedBy ?? `ボイス ${narration.voiceTitle ?? narration.voice} / speed ${narration.speed ?? PERSONAS[s.files.brief.data?.persona ?? 'hiro'].narration.speed} で narration/<id>.wav を作ります`}
              </span>
            </div>
          )}
          {narration && (
            <>
              <div className="row" style={{marginTop: 6}}>
                <label title="ナレーション帯域に足すゲイン。混合後に -14 LUFS へ正規化されるので、上げると声が環境音より前に出ます">
                  声の大きさ
                  <span className="btns">
                    <input
                      type="range"
                      min={-6}
                      max={12}
                      step={0.5}
                      value={narration.narrationGainDb ?? 0}
                      onChange={(e) => setNarr({...narration, narrationGainDb: Number(e.target.value)})}
                      style={{width: 130}}
                    />
                    <span className="counter">{(narration.narrationGainDb ?? 0) > 0 ? '+' : ''}{(narration.narrationGainDb ?? 0).toFixed(1)} dB</span>
                  </span>
                </label>
                <label title="元素材の環境音の音量。下げるとナレーションが相対的に立ちます（既定 0.22）">
                  環境音
                  <span className="btns">
                    <input
                      type="range"
                      min={0}
                      max={0.6}
                      step={0.01}
                      value={narration.ambientGain ?? 0.22}
                      onChange={(e) => setNarr({...narration, ambientGain: Number(e.target.value)})}
                      style={{width: 130}}
                    />
                    <span className="counter">{Math.round((narration.ambientGain ?? 0.22) * 100)}%</span>
                  </span>
                </label>
                <span className="hint">変えたら「ナレーション合成（mix）」をやり直すと反映されます（音声の再生成は不要）</span>
              </div>
              <div className="narr-rows">
                {narration.segments.map((seg, i) => (
                  <div key={i} className={`narr-row${seg.needsTts ? ' needs-tts' : ''}`}>
                    <input className="narr-id" value={seg.id} onChange={(e) => patchSeg(i, {id: e.target.value})} title="ブロック id（narration/<id>.wav と対応）" />
                    <span className="btns">
                      <input type="number" step={0.05} value={seg.at} onChange={(e) => patchSeg(i, {at: Number(e.target.value)})} style={{width: 74}} title="配置秒" />
                      <button className="small" onClick={() => patchSeg(i, {at: Math.round((seg.at - 0.1) * 1000) / 1000})}>
                        -0.1
                      </button>
                      <button className="small" onClick={() => patchSeg(i, {at: Math.round((seg.at + 0.1) * 1000) / 1000})}>
                        +0.1
                      </button>
                    </span>
                    <input className="narr-text" value={seg.text} onChange={(e) => patchSeg(i, {text: e.target.value}, true)} placeholder="読み上げる文" />
                    {ttsReadingHints(seg.text).length > 0 && (
                      <button
                        className="small warn"
                        onClick={() => patchSeg(i, {text: applyReadingHints(seg.text)}, true)}
                        title={`TTS が誤読しやすい表記があります: ${ttsReadingHints(seg.text)
                          .map((h) => `${h.from}→${h.to}`)
                          .join('・')}。押すとかなに開きます（音声は作り直しになります）`}
                      >
                        かなに開く
                      </button>
                    )}
                    <span className="counter" title={seg.durSec ? '実測' : '見積もり'}>
                      {[...seg.text].length}字 / {segSec(seg).toFixed(1)}s{seg.durSec ? '' : '（見積）'}
                    </span>
                    <span className="counter">{seg.needsTts ? '要再生成' : '音声あり'}</span>
                    <button
                      className="small"
                      onClick={() => (seg.needsTts || !seg.durSec ? void previewSpeed(seg.text, seg.id) : playWav(seg.id))}
                      disabled={previewing === seg.id || !seg.text.trim()}
                      title={seg.needsTts || !seg.durSec ? 'まだ音声が無いので、いまの速度で作って鳴らします' : '生成済みの音声を鳴らします'}
                    >
                      {previewing === seg.id ? '再生中' : '▶'}
                    </button>
                    <button
                      className="small"
                      onClick={() => s.addJob('tts', {ids: [seg.id], force: true})}
                      disabled={!!ttsBlockedBy || !seg.text.trim()}
                      title="このブロックだけ作り直す（同じ文でも長さがばらつくので、納得いく読みが出るまで引き直せます）"
                    >
                      作り直す
                    </button>
                    <button className="small danger" onClick={() => removeSeg(i)}>
                      削除
                    </button>
                  </div>
                ))}
              </div>
              <div className="row" style={{marginTop: 6}}>
                <button className="small" onClick={addSeg}>
                  + ブロックを追加
                </button>
                <button className="small" onClick={sortSegs}>
                  at 順に整列
                </button>
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
              {narrIssues.length > 0 && (
                <div className="issues" style={{marginTop: 6}}>
                  {narrIssues.map((m, i) => (
                    <div key={i} className="issue W">
                      <span className="code">W</span>
                      <span>{m}</span>
                    </div>
                  ))}
                  {narrIssues.some((m) => m.includes('重なります')) && (
                    <div className="row" style={{marginTop: 6}}>
                      <button className="primary" onClick={fixOverlaps}>
                        重なりを自動で直す（at をずらす）
                      </button>
                      <span className="hint">後ろにずらすだけなので、音声の作り直しは不要です。前には動かしません（映像と合わなくなるため）</span>
                    </div>
                  )}
                </div>
              )}
              <span className="hint">
                ▶ で聴けます（未生成のブロックはいまの速度で作って鳴らすだけ・保存はしません）。
                <b>同じ文・同じ速度でも長さが 0.96〜2.29 秒ばらつく</b>ので（実測）、納得いく読みが出るまで「作り直す」で引き直せます。
                本文を直すと「要再生成」になります。音声を作り直さないと古い wav のまま混ざります
                {(narration.speed ?? personaSpeed) !== personaSpeed
                  ? `／速度を ${personaSpeed} から変えているので、上の「見積」は当てになりません（話速は速度に比例しないため）。実測は音声を作ったあとに出ます`
                  : ''}
              </span>
            </>
          )}
        </section>
        <SfxCard />
        <CaptionCard aiModel={aiModel} />
        <TrialCard />
        {(mixBlockedBy || deliverBlockedBy) && <p className="hint" style={{color: 'var(--warn)'}}>{mixBlockedBy ?? deliverBlockedBy}</p>}
        <div className="row" style={{marginTop: 8}}>
          <button onClick={() => s.addJob('aliases')}>alias 適用</button>
          <button onClick={() => s.addJob('proxy')}>HEVC/4K プロキシ</button>
          <button onClick={() => s.addJob('sync-engine')}>エンジン同期</button>
          <button onClick={() => s.addJob('npm-install')}>npm install</button>
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
        <details style={{marginTop: 8}}>
          <summary className="hint">オプション（gl / concurrency / crf / cache / retries / force / no-sync / strict-proxy）</summary>
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
        </details>
      </section>

      <div className="jobs">
        <section className="card">
          <h2>ジョブ</h2>
          {jobs.length === 0 && <p className="hint">まだありません</p>}
          {jobs.map((j) => (
            <div key={j.id} className={`job ${j.status}${job?.id === j.id ? ' selected' : ''}`} onClick={() => setSel(j.id)}>
              <div>
                <b>{j.type}</b> <span className="hint">{j.slug}</span>
              </div>
              <div className="st">
                {j.status} {localTime(j.startedAt ?? j.createdAt)}
                {j.endedAt && j.startedAt ? ` (${Math.round((new Date(j.endedAt).getTime() - new Date(j.startedAt).getTime()) / 1000)}s)` : ''}
                {j.progress ? ` ${j.progress.phase} ${j.progress.done}/${j.progress.total}` : ''}
              </div>
              {j.progress && j.status === 'running' && (
                <div className="progress">
                  <div style={{width: `${Math.min(100, (100 * j.progress.done) / Math.max(1, j.progress.total))}%`}} />
                </div>
              )}
              {j.error && <div className="st">{j.error}</div>}
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
