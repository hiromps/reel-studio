// PC につながったマイクを選んでナレーションを録音するダイアログ。
// 録った音はブラウザ内で 16bit PCM WAV に直してから渡す（narration/<id>.wav は WAV 前提のため）。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {encodeWav} from '@shared/wav';

type Props = {
  onAdd: (wav: Blob, memo: string, durSec: number) => Promise<void>;
  onClose: () => void;
};

type Take = {wav: Blob; url: string; durSec: number};

const DEVICE_KEY = 'reel-studio.micDeviceId';
const readDevice = (): string => { try { return localStorage.getItem(DEVICE_KEY) ?? ''; } catch { return ''; } };
const saveDevice = (id: string) => { try { localStorage.setItem(DEVICE_KEY, id); } catch { /* 保存できなくても録音はできる */ } };

const micError = (e: unknown): string => {
  const name = (e as {name?: string})?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'マイクの使用が許可されていません。Windows の「設定 → プライバシーとセキュリティ → マイク」でアプリのアクセスを許可してください';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'マイクが見つかりません。PC にマイクをつないでから「再検出」を押してください';
  if (name === 'NotReadableError') return 'マイクを開けません。別のアプリ（Zoom など）が使っていないか確認してください';
  return `マイクを使えません: ${(e as Error)?.message ?? String(e)}`;
};

/** 録音データ（webm/opus 等）を WAV に直す */
const toWav = async (blob: Blob): Promise<Take> => {
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({length: audio.numberOfChannels}, (_, i) => audio.getChannelData(i));
    const wav = new Blob([encodeWav(channels, audio.sampleRate)], {type: 'audio/wav'});
    return {wav, url: URL.createObjectURL(wav), durSec: Math.round(audio.duration * 1000) / 1000};
  } finally {
    void ctx.close();
  }
};

export const MicRecorder: React.FC<Props> = ({onAdd, onClose}) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(readDevice);
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const meterCtx = useRef<AudioContext | null>(null);
  const raf = useRef(0);

  const release = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void meterCtx.current?.close();
    meterCtx.current = null;
    setLevel(0);
    setReady(false);
  }, []);

  /** つながっているマイクを数え直す（ラベルは一度許可を取った後でないと空になる） */
  const listDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId);
    setDevices(inputs);
    return inputs;
  }, []);

  /** 選んだマイクを開いて音量メーターをつなぐ */
  const open = useCallback(async (id: string) => {
    release();
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('この画面ではマイクを使えません（https またはデスクトップ版で開いてください）');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        // ナレーションは声をそのまま録る。エコー除去は声質を崩すので切る
        audio: {...(id ? {deviceId: {exact: id}} : {}), echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1},
      });
      stream.current = s;
      setReady(true);
      const actual = s.getAudioTracks()[0]?.getSettings().deviceId ?? id;
      const inputs = await listDevices();
      const chosen = inputs.some((d) => d.deviceId === actual) ? actual : inputs[0]?.deviceId ?? '';
      setDeviceId(chosen);
      if (chosen) saveDevice(chosen);
      const ctx = new AudioContext();
      meterCtx.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let peak = 0;
        for (const x of data) peak = Math.max(peak, Math.abs(x));
        setLevel(peak);
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      // 前回のマイクが外されていたら既定のマイクでやり直す
      if (id && (e as {name?: string})?.name === 'OverconstrainedError') return open('');
      setError(micError(e));
      await listDevices().catch(() => undefined);
    }
  }, [listDevices, release]);

  useEffect(() => {
    void open(deviceId);
    const onChange = () => void listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
      release();
    };
    // 開いたときに一度だけ。以降の切り替えは select から open を呼ぶ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url); }, [take]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !recording) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, recording]);
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => clearInterval(t);
  }, [recording]);

  const start = () => {
    if (!stream.current) return;
    setError('');
    setTake(null);
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream.current);
    recorder.current = r;
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      setRecording(false);
      setBusy(true);
      void toWav(new Blob(chunks, {type: r.mimeType}))
        .then((t) => (t.durSec < 0.2 ? Promise.reject(new Error('録音が短すぎます')) : setTake(t)))
        .catch((e: Error) => setError(`録音を変換できませんでした: ${e.message}`))
        .finally(() => setBusy(false));
    };
    r.start();
    setElapsed(0);
    setRecording(true);
  };
  const stop = () => { if (recorder.current?.state === 'recording') recorder.current.stop(); };
  const add = async () => {
    if (!take) return;
    setBusy(true);
    setError('');
    try {
      await onAdd(take.wav, memo.trim(), take.durSec);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clipping = level >= 0.98;
  return (
    <div className="modal-root" onClick={() => !recording && onClose()}>
      <div className="modal mic-recorder" role="dialog" aria-modal="true" aria-label="マイクでナレーションを録音" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>マイクでナレーションを録音</b><span style={{flex: 1}} /><button className="small" disabled={recording} onClick={onClose}>閉じる（Esc）</button></div>
        <div className="modal-body">
          <div className="row">
            <label style={{flex: 1}}>マイク
              <select value={deviceId} disabled={recording || !devices.length} onChange={(e) => { setDeviceId(e.target.value); saveDevice(e.target.value); void open(e.target.value); }}>
                {!devices.length && <option value="">マイクが見つかりません</option>}
                {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `マイク ${i + 1}`}</option>)}
              </select>
            </label>
            <button className="small" disabled={recording} onClick={() => void open(deviceId)} title="つなぎ直したマイクを探し直す">再検出</button>
          </div>
          <div className="mic-meter" aria-label="入力レベル" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            <div className={`mic-meter-bar${clipping ? ' clip' : ''}`} style={{width: `${Math.min(100, Math.sqrt(level) * 100)}%`}} />
          </div>
          <p className="hint">{clipping ? '音が割れています。マイクから少し離れるか、入力音量を下げてください' : '話してみてバーが動けば録音できます'}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            {recording
              ? <button className="danger" onClick={stop}>■ 停止（{elapsed.toFixed(1)} 秒）</button>
              : <button className="primary" disabled={busy || !ready} onClick={start}>● {take ? '録り直す' : '録音開始'}</button>}
          </div>
          {take && !recording && <>
            <audio src={take.url} controls style={{width: '100%'}} />
            <label>メモ（話した内容。画面の表示名に使います）
              <input value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} placeholder="例: まずはこのチーズの伸びを見てください" />
            </label>
            <div className="row">
              <span className="hint">{take.durSec.toFixed(1)} 秒</span>
              <span style={{flex: 1}} />
              <button className="primary" disabled={busy} onClick={() => void add()}>再生位置に追加</button>
            </div>
          </>}
        </div>
      </div>
    </div>
  );
};
