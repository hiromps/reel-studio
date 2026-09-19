// 完成品（out/final_narration.mp4）の確認と持ち出し。
//
// 最後の一手は「スマホから投稿する」なので、**この画面から端末に保存できる**ようにしてある。
//   - ダウンロード … URL に `?download=1` を付ける。サーバー（ローカル）と Blob（クラウド）が
//                    添付として返すので、再生ではなく保存になる
//   - 共有・保存   … Web Share。iOS なら写真アプリや Instagram にそのまま渡せる
import React, {useState} from 'react';
import {useStudio} from '../state/store';

/** 完成品の案件内パス（mix の既定の出力先） */
export const FINISHED_REL = 'out/final_narration.mp4';

export const FinishedVideo: React.FC = () => {
  const s = useStudio();
  /** 一度取り込んだ完成品。共有をやり直すときに取り直さないために持つ */
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s.active || !s.mediaBase) return null;

  const name = `${s.active}_final_narration.mp4`;
  const src = `${s.mediaBase}/${FINISHED_REL}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

  /**
   * iOS Safari は「指を離した直後」でないと共有を許さない（NotAllowedError）。
   * 取り込みに時間がかかる 1 回目は弾かれることがあるので、取れた file は残しておき、
   * 2 回目の押下では待たずに共有する（それなら必ず通る）。
   */
  const share = async () => {
    if (busy) return;
    try {
      let f = file;
      if (!f) {
        setBusy(true);
        const r = await fetch(src);
        if (!r.ok) throw new Error(`取り込めませんでした（${r.status}）`);
        f = new File([await r.blob()], name, {type: 'video/mp4'});
        setFile(f);
        setBusy(false);
      }
      if (!navigator.canShare?.({files: [f]})) throw new Error('この端末は動画の共有に対応していません');
      await navigator.share({files: [f], title: s.active ?? ''});
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return; // 共有シートを自分で閉じただけ
      if (err.name === 'NotAllowedError') return s.toast('動画の用意ができました。もう一度「共有・保存」を押してください', 'info');
      s.toast(`共有できませんでした: ${err.message}（「ダウンロード」はそのまま使えます）`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="finished">
      <video src={src} controls playsInline preload="metadata" />
      <div className="finished-actions">
        <a className="btn-like primary" href={`${src}?download=1`} download={name}>
          ⬇ ダウンロード
        </a>
        {canShare && (
          <button className="primary" onClick={() => void share()} disabled={busy}>
            {busy ? '用意中…' : file ? '📤 共有・保存（用意済み）' : '📤 共有・保存'}
          </button>
        )}
        <span className="hint">
          {FINISHED_REL}
          {canShare ? '。スマホは「共有・保存」→ 写真に保存 が早いです（ダウンロードは「ファイル」アプリに入ります）' : ''}
        </span>
      </div>
    </div>
  );
};
