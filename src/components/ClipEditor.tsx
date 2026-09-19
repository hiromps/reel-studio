// 素材 1 本の「見せ方」を決める部分：画面内の切り出し（寄り・位置）と、使える区間（トリミング）。
//
// **選別モードと素材ページの詳細欄で、この同じ部品を使う。** 判定しながら直すのも、
// 一覧から選んで直すのも、操作と結果が同じになるようにするため（片方にだけ機能がある、を無くす）。
// 変更は onUpdate で呼び出し側（Materials）に返し、catalog.json への保存もそちらが持つ。
import React, {useEffect, useState} from 'react';
import type {Clip, UsableRange} from '@shared/schema';
import {DEFAULT_CROP} from '@shared/schema/cuts';
import {CropBox} from './CropBox';
import {TrimBar} from './TrimBar';
import {mediaVersion} from './MosaicPanel';
import {primaryRangeIndex, rangeForBar, withRange, withRangeLabel, withoutPrimaryRange} from './triage';
import {useStudio} from '../state/store';

/**
 * 素材の更新。historyKey を渡すと、同じキーの連続した変更（ドラッグ・スライダー）が
 * 「取り消し」1 手にまとまる。渡さなければ 1 回ずつ積まれる。
 */
export type ClipUpdate = (id: string, patch: (c: Clip) => Clip, historyKey?: string) => void;

const LABELS: UsableRange['label'][] = ['best', 'ok', 'motion-full', 'avoid'];
const LABEL_TEXT: Record<UsableRange['label'], string> = {best: 'best（見せ場）', ok: 'ok', 'motion-full': 'motion-full（一連動作）', avoid: 'avoid（使わない）'};

type Props = {
  clip: Clip;
  mediaBase: string | null;
  onUpdate: ClipUpdate;
  /** 再生位置を外から触るため（サムネのコマ送り・モザイク区間の確認） */
  videoRef: React.RefObject<HTMLVideoElement>;
  /** 切り出し枠を大きくしているか。外で持つ（選別モードでは他の段も畳むため） */
  big: boolean;
  onBig: (v: boolean) => void;
  /** 「区間だけ再生」を最初から入れておくか（選別モードは入れる） */
  defaultLoop?: boolean;
};

export const ClipEditor: React.FC<Props> = ({clip, mediaBase, onUpdate, videoRef, big, onBig, defaultLoop = true}) => {
  const s = useStudio();
  const [failed, setFailed] = useState<string | null>(null);
  /** 使える区間だけを繰り返し再生する（決めた部分がどう見えるかを確かめる） */
  const [loopRange, setLoopRange] = useState(defaultLoop);

  const pi = primaryRangeIndex(clip);
  const range = pi >= 0 ? clip.usableRanges[pi] : null;
  const duration = clip.probe.durationSec;
  const {inSec, outSec} = rangeForBar(clip);

  const setRange = (next: {inSec: number; outSec: number}) => onUpdate(clip.id, (c) => withRange(c, next), `trim:${clip.id}`);
  const setLabel = (label: UsableRange['label']) => onUpdate(clip.id, (c) => withRangeLabel(c, label, {inSec, outSec}));
  const clearRange = () => {
    if (pi >= 0) onUpdate(clip.id, (c) => withoutPrimaryRange(c));
  };

  /** IN を動かしたら、その位置を見せる（触っている場所と画が合うように） */
  const seekIn = (sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.max(0, Math.min(duration - 0.05, sec));
    } catch {
      /* まだ読み込み前なら何もしない */
    }
  };

  /** 区間を繰り返し再生する。IN を動かしたらそこから見せる */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !loopRange || !range) return;
    const onTime = () => {
      if (v.currentTime >= outSec - 0.02 || v.currentTime < inSec - 0.05) {
        v.currentTime = inSec;
        if (v.paused) void v.play().catch(() => undefined);
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [videoRef, clip.id, loopRange, range, inSec, outSec]);

  return (
    <div className={`clip-editor${big ? ' big' : ''}`}>
      {/* 9:16 の枠の中で「どこを、どれだけ寄って見せるか」を決める（比率は変わらない） */}
      <div className="clip-stage">
        <CropBox
          key={clip.id}
          src={mediaBase ? `${mediaBase}/${clip.src}${mediaVersion(clip)}` : null}
          crop={clip.crop ?? DEFAULT_CROP}
          onChange={(crop) => onUpdate(clip.id, (c) => ({...c, crop}), `crop:${clip.id}`)}
          probe={clip.probe}
          videoRef={videoRef}
          onError={() => setFailed(clip.id)}
          big={big}
          onBig={onBig}
        >
          {failed === clip.id && (
            <div className="clip-noplay">
              <b>この素材の映像が読めません</b>
              {s.isCloud ? (
                <>
                  <span>クラウドには原本を置かないので、スマホで再生できるのは PC が作った軽量プレビューだけです。この案件ではまだ作られていません。</span>
                  <button
                    className="small primary"
                    onClick={() => void s.addJob('preview-proxy')}
                    disabled={s.jobs.some((j) => j.type === 'preview-proxy' && (j.status === 'running' || j.status === 'queued'))}
                  >
                    軽量プレビューを作る（PC で実行）
                  </button>
                </>
              ) : (
                <span>素材ファイルが案件フォルダにあるか確認してください（{clip.src}）。</span>
              )}
            </div>
          )}
        </CropBox>
      </div>

      {/* 使える区間（トリミング）。帯を掴むとその場で区間ができる */}
      <div className="clip-trim">
        <TrimBar
          inSec={inSec}
          outSec={outSec}
          durationSec={duration}
          fps={clip.probe.fps}
          strip={clip.thumbs.strip}
          mediaBase={mediaBase}
          usableRanges={clip.usableRanges}
          onChange={(r) => {
            setRange(r);
            seekIn(r.inSec);
          }}
        />
        <div className="clip-trim-row">
          <select value={range?.label ?? 'best'} onChange={(e) => setLabel(e.target.value as UsableRange['label'])} title="この区間の扱い" aria-label="区間の扱い">
            {LABELS.map((l) => (
              <option key={l} value={l}>
                {LABEL_TEXT[l]}
              </option>
            ))}
          </select>
          <label className="clip-loop" title="決めた区間だけを繰り返し再生する">
            <input type="checkbox" checked={loopRange} onChange={(e) => setLoopRange(e.target.checked)} />
            <span>区間だけ再生</span>
          </label>
          <button className="small" onClick={() => videoRef.current && setRange({inSec: Math.min(videoRef.current.currentTime, outSec - 0.2), outSec})} title="再生位置を頭にする（I）">
            IN=いま
          </button>
          <button className="small" onClick={() => videoRef.current && setRange({inSec, outSec: Math.max(videoRef.current.currentTime, inSec + 0.2)})} title="再生位置を尻にする（O）">
            OUT=いま
          </button>
          <button className="small" onClick={clearRange} disabled={pi < 0} title="区間の指定をやめる（全尺から使う）">
            区間を消す
          </button>
          {pi < 0 && <span className="hint">未指定（全尺から使う）。帯を掴むと区間ができます</span>}
        </div>
      </div>
    </div>
  );
};
