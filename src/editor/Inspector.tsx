// インスペクタ：選んでいるもの（カット / テロップグループ / ナレーション / 効果音 / 何も無し＝動画全体）の編集欄。
import React, {useEffect, useRef, useState} from 'react';
import type {Cut, ReelData} from '@shared/schema';
import {cutDurationSec} from '@shared/timeline';
import {countChars, isPlaceholder} from '@shared/telop-text';
import {applyReadingHints, narrationDisplayName, ttsReadingHints} from '@shared/narration';
import {SFX_ROLES, SFX_ROLE_LABEL, type SfxLibrary} from '@shared/sfx';
import {TrimBar} from '../components/TrimBar';
import {CropBox} from '../components/CropBox';
import {ZoomControls} from '../components/ZoomControls';
import {applyZoomSettings} from '@shared/zoom';
import {DEFAULT_CROP, isDefaultCrop} from '@shared/schema/cuts';
import {fallbackDuration, fixedTrimRange, trimZoomView, type TrimRange} from '../components/trim';
import {CutThumb} from '../components/CutThumb';
import {IssueList} from '../components/IssueList';
import {FIT_DEFAULTS} from '@shared/fit';
import type {EditorModel} from './useEditorModel';
import {BADGE_OPACITY_DEFAULT, GROUP_COLORS, KIND_LABEL, ROLE_LABEL} from './labels';
import {ThumbnailSection} from './ThumbnailSection';
import {TelopFontSelect} from './TelopFontSelect';

type Common = {m: EditorModel; onSeekCut: (i: number) => void};

const Section: React.FC<{title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode}> = ({title, right, children}) => (
  <div className="insp-section">
    <div className="insp-title">
      <b>{title}</b>
      <span style={{flex: 1}} />
      {right}
    </div>
    {children}
  </div>
);

/** 文字数カウンタ（13 文字目安） */
const Counter: React.FC<{text: string; max?: number}> = ({text, max = 13}) => {
  const n = countChars(text);
  return (
    <span className={`counter${n > max ? ' over' : ''}`}>
      {n}/{max}
    </span>
  );
};

// ───────────────────────── 動画全体 ─────────────────────────
export const ReelInspector: React.FC<{m: EditorModel}> = ({m}) => {
  const {cuts, validation, patchReel, fitBlockedBy, fitToNarration} = m;
  // 「ナレーション音声に尺を合わせる」の結果（何をどう刻んだか）。次に押すまで残す
  const [fitNotes, setFitNotes] = useState<string[]>([]);
  useEffect(() => setFitNotes([]), [m.s.active]);
  if (!cuts) return <div className="hint">左の素材をタイムラインへドラッグするか、Brief で構成を作ってください</div>;
  const runFit = () => {
    const notes = fitToNarration();
    setFitNotes(notes);
    const head = notes[0];
    if (head) m.s.toast(head.replace(/^!\s*/, ''), head.startsWith('!') ? 'error' : 'ok');
  };
  return (
    <>
      <Section title="動画全体">
        <div className="summary">
          <span>
            <b>{cuts.cuts.length}</b> カット
          </span>
          <span>
            <b>{m.total.toFixed(2)}</b>s
          </span>
          <span>{cuts.fps}fps</span>
          {validation && (
            <span>
              平均 <b>{validation.summary.avgCutSec}</b>s
            </span>
          )}
          {m.brief && (
            <span>
              {m.persona?.label} / {m.spec?.id}
            </span>
          )}
        </div>
        <div className="form">
          <label>
            テーマ
            <select value={cuts.theme ?? 'pop'} onChange={(e) => patchReel({theme: e.target.value as ReelData['theme']})}>
              {(['pop', 'bold', 'human', 'stylish'] as const).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <TelopFontSelect font={cuts.font} onChange={(font) => patchReel({font})} />
          <label title="バッジ（エリア名・順位）の下地の濃さ。0 で下地なし、1 でベタ塗り。文字の濃さは変わりません">
            バッジの濃さ {Math.round((cuts.badgeOpacity ?? BADGE_OPACITY_DEFAULT) * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={cuts.badgeOpacity ?? BADGE_OPACITY_DEFAULT} onChange={(e) => patchReel({badgeOpacity: Number(e.target.value)})} />
          </label>
        </div>
        <div className="row" style={{marginTop: 8}}>
          <button
            className="small"
            onClick={runFit}
            disabled={!!fitBlockedBy}
            title={
              fitBlockedBy ?? (cuts.meta?.orderLocked ? '並び順・素材・本数・倍速を保持し、IN/OUT の尺だけを音声に合わせます。会話字幕や個別に固定したカットの尺は保持します。素材が足りない場合は変更せず理由を表示します（Ctrl+Z で戻せます）' :
              `各ナレーションの音声の長さ（実測）に映像を合わせ、${FIT_DEFAULTS.minCutSec}〜${FIT_DEFAULTS.maxCutSec} 秒のカットに刻み直します。テロップ・バッジは元のカットから引き継ぎ、会話（字幕つき）とロック済みのカットは触りません。音声は作り直しません（Ctrl+Z で戻せます）`)
            }
            data-tour="fit"
          >
            ナレーション音声に尺を合わせる
          </button>
          <span className="hint">
            {cuts.meta?.orderLocked ? 'ロック中：並び順を保持して尺だけ調整・取り消し可' : FIT_DEFAULTS.minCutSec + '〜' + FIT_DEFAULTS.maxCutSec + ' 秒刻み・取り消し可'}
          </span>
        </div>
        {fitNotes.length > 0 && (
          <details open style={{marginTop: 6}}>
            <summary className="hint">合わせた結果</summary>
            <IssueList rows={fitNotes.map((n) => ({severity: n.trimStart().startsWith('!') ? ('W' as const) : ('info' as const), message: n.trim().replace(/^!\s*/, '')}))} maxHeight={220} />
          </details>
        )}
      </Section>
      <Section title="サムネイル" right={<span className="hint">本番レンダーで自動作成</span>}>
        <ThumbnailSection m={m} />
      </Section>
      <Section title="カットごとのズーム">
        <button className="small" onClick={() => patchReel({cuts: applyZoomSettings(cuts, 'viral_zoom').cuts})}>viral_zoom を全カットに適用</button>
        <button className="small" onClick={() => patchReel({cuts: cuts.cuts.map((c) => ({...c, zoom: undefined}))})}>全カットのズームを解除</button>
      </Section>
      <Section title="操作">
        <ul className="insp-keys">
          <li>
            <code>Space</code> 再生 / 停止　<code>← →</code> 1 コマ（Shift で 10）　<code>Home / End</code> 先頭 / 末尾
          </li>
          <li>
            <code>クリック</code> 選ぶ　<code>Delete</code> 選択を消す　<code>S</code> 再生ヘッドで分割　<code>Ctrl+D</code> 複製
          </li>
          <li>
            <code>Alt + ← →</code> カットを 1 つ前後へ　<code>Ctrl+Z / Ctrl+Y</code> 取り消し / やり直し　<code>Ctrl+S</code> 保存
          </li>
          <li>
            映像ブロック：<b>両端</b>で尺、<b>中</b>をドラッグで並べ替え、<b>Alt+ドラッグ</b>で中身をずらす。<code>Ctrl+ホイール</code>で拡大
          </li>
          <li>ナレーション・効果音：横にドラッグで配置秒。カット境界に吸着（Alt で無効）</li>
        </ul>
      </Section>
    </>
  );
};

// ───────────────────────── カット ─────────────────────────
export const CutInspector: React.FC<Common & {index: number; focusTelop?: boolean; onSplit: (i: number) => void}> = ({m, index, onSeekCut, focusTelop, onSplit}) => {
  const {cuts, catalog, s, clipOf, slotOf, groupOfCut, patchCut, patchSlot, moveCut, duplicateCut, removeCut, replaceClip, pushHistory, setCuts, subsFrom} = m;
  const telopRef = useRef<HTMLInputElement>(null);
  const quickVideoRef = useRef<HTMLVideoElement>(null);
  const [quickCandidate, setQuickCandidate] = useState<{index: number; src: string; range: TrimRange} | null>(null);
  const [quickPendingSave, setQuickPendingSave] = useState<{index: number; src: string; range: TrimRange} | null>(null);
  const [quickZoomSec, setQuickZoomSec] = useState(4);
  const [quickZoomStart, setQuickZoomStart] = useState(0);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);
  const [replaceQuery, setReplaceQuery] = useState('');
  const [replaceId, setReplaceId] = useState<string | null>(null);
  useEffect(() => {
    if (focusTelop) telopRef.current?.focus();
  }, [focusTelop, index]);
  const currentForSave = cuts?.cuts[quickPendingSave?.index ?? -1];
  useEffect(() => {
    if (!quickPendingSave || !currentForSave || !s.files.cuts.dirty) return;
    if (currentForSave.src !== quickPendingSave.src || currentForSave.inSec !== quickPendingSave.range.inSec || currentForSave.outSec !== quickPendingSave.range.outSec) return;
    setQuickPendingSave(null);
    void s.saveFile('cuts');
  }, [quickPendingSave, currentForSave, s]);
  if (!cuts) return null;
  const c = cuts.cuts[index];
  if (!c) return null;
  const clip = clipOf(c.src);
  const slot = slotOf(c);
  const gi = groupOfCut.get(index);
  const text = c.main?.text ?? '';
  const fpsStep = 1 / cuts.fps;
  const replaceKey = `${index}:${c.id ?? c.src}`;
  const replacing = replaceFor === replaceKey;
  const replacement = catalog?.clips.find((k) => k.id === replaceId);
  const replaceMatches = (catalog?.clips ?? []).filter((k) =>
    [k.id, k.slug, k.original, k.tags?.description ?? '', k.tags?.subject ?? '', k.user.ng ? 'NG' : ''].join(' ').toLowerCase().includes(replaceQuery.trim().toLowerCase()),
  );
  const confirmReplace = () => {
    if (!replacement) return;
    const error = replaceClip(index, replacement.id);
    if (error) return s.toast(error, 'error');
    s.toast(`カット ${index + 1} を ${replacement.id} に差し替えました`, 'ok');
    setReplaceFor(null);
    setReplaceId(null);
  };
  const quick = quickCandidate?.index === index && quickCandidate.src === c.src ? quickCandidate.range : null;
  const sourceDuration = clip?.probe.durationSec ?? fallbackDuration(c);
  const canQuickTrim = !!clip && fixedTrimRange(0, sourceDuration, cuts.fps, 0.8 * (c.playbackRate ?? 1)) !== null;
  const quickLength = 0.8 * (c.playbackRate ?? 1);
  const setQuickStart = (start: number, center = false) => {
    const next = fixedTrimRange(start, sourceDuration, cuts.fps, quickLength);
    if (!next) return;
    setQuickCandidate({index, src: c.src, range: next});
    if (center) setQuickZoomStart(trimZoomView(next, sourceDuration, quickZoomSec).inSec);
    const video = quickVideoRef.current;
    if (video) video.currentTime = next.inSec;
  };
  const adoptQuick = () => {
    if (!quick) return;
    patchCut(index, quick);
    setQuickPendingSave({index, src: c.src, range: quick});
    setQuickCandidate(null);
  };

  return (
    <>
      <Section
        title={
          <>
            カット {index + 1}
            {slot?.role ? <span className="hint"> ／ {ROLE_LABEL[slot.role]}</span> : null}
            {gi !== undefined ? (
              <span className="sb-gid" style={{color: GROUP_COLORS[gi % GROUP_COLORS.length], marginLeft: 6}}>
                g{String(gi + 1).padStart(2, '0')}
              </span>
            ) : null}
          </>
        }
        right={
          <span className="btns">
            <button className="small" onClick={() => onSeekCut(index)} title="このカットの頭へ">
              頭へ
            </button>
            <button className="small" onClick={() => moveCut(index, -1)} disabled={index === 0} title="1 つ前へ（Alt+←）">
              ▲
            </button>
            <button className="small" onClick={() => moveCut(index, 1)} disabled={index === cuts.cuts.length - 1} title="1 つ後ろへ（Alt+→）">
              ▼
            </button>
          </span>
        }
      >
        <div className="insp-cut-head">
          <div className="insp-thumb">
            <CutThumb slug={s.active} src={c.src} inSec={c.inSec} width={200} fallback={clip?.thumbs.sheet && s.mediaBase ? `${s.mediaBase}/studio/${clip.thumbs.sheet}` : null} />
          </div>
          <div className="insp-cut-meta">
            <div><b>素材 {clip?.id ?? c.src}</b> {clip?.user.ng && <span className="hint">NG 指定</span>}</div>
            <div className="hint">{clip?.tags?.description ?? clip?.slug ?? ''}</div>
            <button className="small" onClick={() => {
              setReplaceFor(replacing ? null : replaceKey);
              setReplaceQuery('');
              setReplaceId(null);
            }} disabled={!catalog?.clips.length} aria-expanded={replacing}>
              {replacing ? '差し替えを閉じる' : '素材を差し替える'}
            </button>
            <div className="hint">
              {clip ? `${clip.tags ? KIND_LABEL[clip.tags.kind] : '未タグ'} / ${clip.probe.durationSec.toFixed(2)}s / ${clip.probe.fps}fps` : 'catalog に無い素材'}
            </div>
            <div className="hint">
              尺 <b>{cutDurationSec(c).toFixed(2)}s</b>
              {c.playbackRate && c.playbackRate !== 1 ? ` / ${c.playbackRate}x` : ''}
            </div>
          </div>
        </div>
        {replacing && (
          <div className="replace-picker">
            <label>
              差し替える素材を検索
              <input value={replaceQuery} onChange={(e) => setReplaceQuery(e.target.value)} placeholder="例：02、料理名、NG" autoFocus />
            </label>
            <div className="replace-results" role="group" aria-label="差し替え候補">
              {replaceMatches.map((k) => (
                <button key={k.id} className={`replace-option${replaceId === k.id ? ' selected' : ''}`} onClick={() => setReplaceId(k.id)} aria-pressed={replaceId === k.id}>
                  {k.thumbs.sheet && s.mediaBase ? <img src={`${s.mediaBase}/studio/${k.thumbs.sheet}`} alt="" loading="lazy" /> : <span className="thumb-none">no thumb</span>}
                  <span><b>{k.id}</b> {k.tags?.description ?? k.slug}<small>{k.probe.durationSec.toFixed(1)}秒 {k.user.ng ? '・NG指定' : ''}{k.src === c.src ? '・現在の素材' : ''}</small></span>
                </button>
              ))}
              {!replaceMatches.length && <span className="hint">一致する素材がありません</span>}
            </div>
            {replacement && (
              <div className="replace-confirm">
                {s.mediaBase && <video key={replacement.src} src={`${s.mediaBase}/${replacement.src}`} controls muted playsInline preload="none" aria-label={`${replacement.id} の確認映像`} />}
                <div>
                  <span>カット {index + 1}：{clip?.id ?? c.src} → <b>{replacement.id}</b>{replacement.user.ng ? '（NG指定のまま使用）' : ''}</span>
                  <button className="small primary" onClick={confirmReplace} disabled={replacement.src === c.src}>この素材に差し替える</button>
                </div>
              </div>
            )}
            <span className="hint">テロップとカットの位置は維持。素材尺が短い場合はカットを短縮します。保存は画面上部の「保存」から。</span>
          </div>
        )}
        <div className="quick-trim-actions">
          <button className="small" disabled={!canQuickTrim} onClick={() => setQuickStart(c.inSec, true)} title="現在の IN から 0.8 秒の候補を作る">
            0.8秒を選ぶ
          </button>
          {!clip && <span className="hint">素材の尺が不明です</span>}
          {clip && !canQuickTrim && <span className="hint">素材が 0.8 秒分より短いです</span>}
          {quick && <span className="hint">帯の窓か下のスライダーを動かして確認</span>}
        </div>
        <TrimBar
          inSec={quick?.inSec ?? c.inSec}
          outSec={quick?.outSec ?? c.outSec}
          durationSec={sourceDuration}
          fps={cuts.fps}
          strip={clip?.thumbs.strip}
          mediaBase={s.mediaBase}
          usableRanges={clip?.usableRanges}
          disabled={!!quick}
          moveOnly={!!quick}
          onStart={quick ? undefined : pushHistory}
          onChange={(r) => setCuts({...cuts, cuts: cuts.cuts.map((x, k) => (k === index ? {...x, ...r} : x))})}
        />
        {quick && (
          <div className="quick-trim-choice">
            <div className="quick-trim-zoom-head">
              <b>区間を拡大</b>
              <span className="btns">
                {[2, 4, 8].map((seconds) => <button key={seconds} className={`small chip${quickZoomSec === seconds ? ' on' : ''}`} onClick={() => {
                  setQuickZoomSec(seconds);
                  setQuickZoomStart(trimZoomView(quick, sourceDuration, seconds).inSec);
                }}>{seconds}秒幅</button>)}
              </span>
              <button className="small" onClick={() => setQuickZoomStart(trimZoomView(quick, sourceDuration, quickZoomSec).inSec)}>現在位置を中心に</button>
            </div>
            <TrimBar
              inSec={quick.inSec}
              outSec={quick.outSec}
              durationSec={sourceDuration}
              fps={cuts.fps}
              strip={clip?.thumbs.strip}
              mediaBase={s.mediaBase}
              usableRanges={clip?.usableRanges}
              moveOnly
              view={{inSec: quickZoomStart, outSec: Math.min(sourceDuration, quickZoomStart + quickZoomSec)}}
              onChange={(r) => setQuickStart(r.inSec)}
            />
            <video ref={quickVideoRef} src={s.mediaBase ? `${s.mediaBase}/${c.src}` : undefined} autoPlay muted playsInline preload="metadata" onLoadedMetadata={(e) => {e.currentTarget.playbackRate = c.playbackRate ?? 1; e.currentTarget.currentTime = quick.inSec;}} onTimeUpdate={(e) => {
              if (e.currentTarget.currentTime >= quick.outSec - 0.02 || e.currentTarget.currentTime < quick.inSec - 0.05) e.currentTarget.currentTime = quick.inSec;
            }} aria-label="0.8秒の候補を再生" />
            <label>
              開始位置 {quick.inSec.toFixed(2)}秒
              <input type="range" min={0} max={Math.max(0, sourceDuration - (quick.outSec - quick.inSec))} step="any" value={quick.inSec} onChange={(e) => setQuickStart(Number(e.target.value), true)} aria-label="0.8秒区間の開始位置" />
            </label>
            <div className="quick-trim-nudge">
              <button className="small" onClick={() => setQuickStart(quick.inSec - 1 / cuts.fps, true)}>−1コマ</button>
              <button className="small" onClick={() => setQuickStart(quick.inSec + 1 / cuts.fps, true)}>＋1コマ</button>
            </div>
            <button className="small primary" onClick={adoptQuick}>この区間を採用して保存</button>
            <button className="small" onClick={() => setQuickCandidate(null)}>キャンセル</button>
          </div>
        )}

        {/* 画面内の切り出し（アスペクト比は変えない）。カットごとに決められる。
            素材側（Materials・選別モード）で決めた値は、構成を組んだときにここへ引き継がれている */}
        <details className="insp-crop" open={!!c.zoom && c.zoom.mode !== 'none'}>
          <summary>キーフレームズーム</summary>
          <ZoomControls zoom={c.zoom} onStart={pushHistory} onChange={(zoom) => patchCut(index, {zoom}, {history: false})} />
          <button className="small" onClick={() => m.patchReel({cuts: cuts.cuts.map((cut) => ({...cut, zoom: c.zoom ? {...c.zoom} : undefined}))})}>このズームを全カットに適用</button>
        </details>
        <details className="insp-crop" open={!isDefaultCrop(c.crop)}>
          <summary>
            切り出し（拡大・位置）{isDefaultCrop(c.crop) ? '' : ` ${(c.crop?.zoom ?? 1).toFixed(2)}×`}
          </summary>
          <CropBox
            src={s.mediaBase ? `${s.mediaBase}/${c.src}` : null}
            crop={c.crop ?? DEFAULT_CROP}
            onChange={(crop) => {
              pushHistory();
              patchCut(index, {crop: isDefaultCrop(crop) ? undefined : crop});
            }}
            probe={clip?.probe}
          />
          {clip && !isDefaultCrop(clip.crop) && (
            <button
              className="small"
              onClick={() => {
                pushHistory();
                patchCut(index, {crop: {...clip.crop!}});
              }}
              disabled={JSON.stringify(c.crop ?? null) === JSON.stringify(clip.crop)}
              title="Materials・選別モードでこの素材に付けた切り出しを、このカットに取り込む"
            >
              素材の切り出しを取り込む（{(clip.crop?.zoom ?? 1).toFixed(2)}×）
            </button>
          )}
        </details>
        {!quick && <div className="row">
          <label>
            IN
            <span className="btns">
              <input type="number" step={0.01} value={c.inSec} onChange={(e) => patchCut(index, {inSec: Number(e.target.value)})} />
              <button className="small" onClick={() => patchCut(index, {inSec: Math.max(0, Math.round((c.inSec - fpsStep) * 1000) / 1000)})}>
                -1f
              </button>
              <button className="small" onClick={() => patchCut(index, {inSec: Math.round((c.inSec + fpsStep) * 1000) / 1000})}>
                +1f
              </button>
            </span>
          </label>
          <label>
            OUT
            <span className="btns">
              <input type="number" step={0.01} value={c.outSec} onChange={(e) => patchCut(index, {outSec: Number(e.target.value)})} />
              <button className="small" onClick={() => patchCut(index, {outSec: Math.round((c.outSec - 0.1) * 1000) / 1000})}>
                -0.1
              </button>
              <button className="small" onClick={() => patchCut(index, {outSec: Math.round((c.outSec + 0.1) * 1000) / 1000})}>
                +0.1
              </button>
            </span>
          </label>
          <label title="倍速。空か 1 で等速">
            倍速
            <input
              type="number"
              step={0.25}
              min={0.5}
              max={2}
              value={c.playbackRate ?? ''}
              placeholder="1"
              onChange={(e) =>
                patchCut(index, (x) => {
                  const nx = {...x};
                  if (e.target.value === '' || Number(e.target.value) === 1) delete nx.playbackRate;
                  else nx.playbackRate = Number(e.target.value);
                  return nx;
                })
              }
            />
          </label>
        </div>}
      </Section>

      <Section
        title="テロップ"
        right={
          !c.subs?.length && clip?.tags?.hasSpeech ? (
            <button className="small" onClick={() => patchCut(index, (x) => ({...x, main: undefined, subs: [subsFrom(x)]}))} title="会話クリップの発話同期字幕に切り替える">
              字幕（subs）に
            </button>
          ) : null
        }
      >
        <TelopFontSelect font={cuts!.font} onChange={(font) => m.patchReel({font})} />
        {!c.subs?.length && (
          <>
            <div className="row">
              <label className="grow">
                文言{gi !== undefined && m.groups[gi].cutIndices.length > 1 ? <span className="hint">（このカットだけ変えると別グループになります。まとめて直すならテロップ段のブロックをクリック）</span> : null}
                <span className="btns" style={{width: '100%'}}>
                  <input
                    ref={telopRef}
                    className={`telop${isPlaceholder(text) ? ' placeholder' : ''}`}
                    style={{flex: 1}}
                    value={text}
                    placeholder="（無し）"
                    onChange={(e) => patchCut(index, (x) => ({...x, main: {...(x.main ?? {}), text: e.target.value}}), {history: false})}
                    onFocus={pushHistory}
                  />
                  <Counter text={text} />
                </span>
              </label>
            </div>
            <div className="row">
              {c.main && (
                <label>
                  向き
                  <select value={c.main.orientation ?? 'vertical'} onChange={(e) => patchCut(index, {main: {...c.main!, orientation: e.target.value === 'vertical' ? undefined : 'horizontal'}})}>
                    <option value="vertical">縦書き（中央）</option>
                    <option value="horizontal">横書き（上部）</option>
                  </select>
                </label>
              )}
              <label title="左上に出すバッジ。F0 はエリア名（任意）、F2 は順位、F6 は店名">
                バッジ
                <input
                  value={c.badge ?? ''}
                  onFocus={pushHistory}
                  onChange={(e) =>
                    patchCut(
                      index,
                      (x) => {
                        const nx = {...x};
                        if (e.target.value) nx.badge = e.target.value;
                        else delete nx.badge;
                        return nx;
                      },
                      {history: false},
                    )
                  }
                />
              </label>
            </div>
          </>
        )}
        {c.subs && c.subs.length > 0 && (
          <div className="subs-editor">
            {c.subs.map((sub, k) => (
              <div className="sub" key={k}>
                <input type="number" step={0.05} value={sub.startSec} onChange={(e) => patchCut(index, {subs: c.subs!.map((x, j) => (j === k ? {...x, startSec: Number(e.target.value)} : x))})} />
                <input type="number" step={0.05} value={sub.endSec} onChange={(e) => patchCut(index, {subs: c.subs!.map((x, j) => (j === k ? {...x, endSec: Number(e.target.value)} : x))})} />
                <input className={`telop${isPlaceholder(sub.text) ? ' placeholder' : ''}`} value={sub.text} onFocus={pushHistory} onChange={(e) => patchCut(index, {subs: c.subs!.map((x, j) => (j === k ? {...x, text: e.target.value} : x))}, {history: false})} />
                <span className="counter">{countChars(sub.text)}/20</span>
                <button className="small danger" onClick={() => patchCut(index, (x) => ({...x, subs: x.subs!.filter((_, j) => j !== k)}))}>
                  ×
                </button>
              </div>
            ))}
            <button className="small" onClick={() => patchCut(index, {subs: [...c.subs!, {...subsFrom(c), startSec: c.subs![c.subs!.length - 1].endSec}]})}>
              + 字幕
            </button>
          </div>
        )}
      </Section>

      <Section title="このカット">
        <div className="row">
          <button className="small" onClick={() => duplicateCut(index)} title="複製（Ctrl+D）">
            複製
          </button>
          <button
            className="small"
            onClick={() => onSplit(index)}
            title="再生ヘッド（赤い線）の位置で 2 つに割る（S）"
          >
            再生位置で分割
          </button>
          <button className="small danger" onClick={() => !removeCut(index) && s.toast('最後の 1 カットは消せません', 'error')} title="タイムラインから外す（Delete）。素材は残ります">
            削除
          </button>
          {slot && (
            <button className={`small${slot.locked ? ' warn' : ''}`} onClick={() => patchSlot(c, {locked: !slot.locked})} title="再 plan でこのカットを固定する">
              {slot.locked ? '🔒 固定中' : '🔓 固定しない'}
            </button>
          )}
        </div>
      </Section>
    </>
  );
};

// ───────────────────────── テロップグループ ─────────────────────────
export const TelopInspector: React.FC<Common & {group: number}> = ({m, group, onSeekCut}) => {
  const {cuts, groups, setGroupText, setGroupOrientation, patchCut, pushHistory, setCuts} = m;
  const g = groups[group];
  if (!cuts || !g) return null;
  const head = cuts.cuts[g.cutIndices[0]];
  const text = g.def.text;
  const color = GROUP_COLORS[group % GROUP_COLORS.length];
  const shown = g.dur / cuts.fps;
  return (
    <Section
      title={
        <>
          テロップ <span style={{color}}>g{String(group + 1).padStart(2, '0')}</span>
          <span className="hint">
            {' '}
            ／ カット {g.cutIndices.map((i) => i + 1).join('・')} ／ 表示 {shown.toFixed(1)}s
          </span>
        </>
      }
      right={
        <button className="small" onClick={() => onSeekCut(g.cutIndices[0])} title="このテロップの頭へ">
          頭へ
        </button>
      }
    >
      <TelopFontSelect font={cuts.font} onChange={(font) => m.patchReel({font})} />
      <label style={{width: '100%'}}>
        文言（グループ内の {g.cutIndices.length} カットにまとめて入ります）
        <span className="btns" style={{width: '100%'}}>
          <input
            className={`telop${isPlaceholder(text) ? ' placeholder' : ''}`}
            style={{flex: 1}}
            value={text}
            onFocus={pushHistory}
            onChange={(e) => {
              const idx = new Set(g.cutIndices);
              // 入力途中の空文字は削除ではない。枠と向きを残し、同じグループで入力を続ける。
              setCuts({...cuts, cuts: cuts.cuts.map((c, k) => (idx.has(k) ? {...c, main: {...(c.main ?? {}), text: e.target.value}} : c))});
            }}
          />
          <Counter text={text} />
        </span>
      </label>
      {isPlaceholder(text) && <div className="hint">未記入（{text}）。Claude に頼む →「テロップを書いてもらう」でも埋められます</div>}
      <div className="row">
        <label>
          向き
          <select value={g.def.orientation ?? 'vertical'} onChange={(e) => setGroupOrientation(group, e.target.value as 'vertical' | 'horizontal')}>
            <option value="vertical">縦書き（中央）</option>
            <option value="horizontal">横書き（上部）</option>
          </select>
        </label>
        <label title="グループの先頭カットに付くバッジ（エリア名など）">
          バッジ
          <input
            value={head.badge ?? ''}
            onFocus={pushHistory}
            onChange={(e) =>
              patchCut(
                g.cutIndices[0],
                (x) => {
                  const nx = {...x};
                  if (e.target.value) nx.badge = e.target.value;
                  else delete nx.badge;
                  return nx;
                },
                {history: false},
              )
            }
          />
        </label>
        <button className="small" onClick={() => setGroupText(group, '')} title="このグループのカットからテロップを外す">
          テロップを外す
        </button>
      </div>
      <div className="hint">同じ文言が続くカットは 1 かたまり（テロップグループ）です。1 カットずつ変えたいときは映像段のカットを選んでください</div>
    </Section>
  );
};

// ───────────────────────── ナレーション ─────────────────────────
export const NarrationInspector: React.FC<
  Common & {index: number; onPlay: (id: string, text: string, needsTts: boolean, trimSec?: number) => void; playing: string | null; onRegenerate: (id: string) => void; onSaveToLibrary: () => void; ttsBlockedBy: string | null}
> = ({m, index, onPlay, playing, onRegenerate, onSaveToLibrary, ttsBlockedBy}) => {
  const {narration, patchSeg, removeSeg, pushHistory, setNarr, estimateSec, ranges} = m;
  const [draft, setDraft] = useState<string | null>(null);
  const seg = narration?.segments[index];
  useEffect(() => setDraft(null), [index, seg?.text]);
  if (!narration || !seg) return null;
  const hints = ttsReadingHints(seg.text);
  const needsTts = !!(seg as {needsTts?: boolean}).needsTts || !seg.durSec;
  const fullSec = seg.durSec ?? 0;
  const usedSec = Math.min(fullSec, seg.trimSec ?? fullSec);
  const setTrim = (seconds: number) => {
    if (!fullSec || !Number.isFinite(seconds)) return;
    const next = Math.round(Math.max(Math.min(0.1, fullSec), Math.min(fullSec, seconds)) * 1000) / 1000;
    patchSeg(index, {trimSec: next >= fullSec ? undefined : next});
  };
  const cutAt = ranges.findIndex((r) => seg.at >= r.startSec && seg.at < r.endSec);
  const text = draft ?? seg.text;
  const commitText = () => {
    if (draft === null || draft === seg.text) return setDraft(null);
    patchSeg(index, {text: draft}, true);
    setDraft(null);
  };
  return (
    <Section
      title={
        <>
          ナレーション <span>{narrationDisplayName(seg)}</span>
          {cutAt >= 0 ? <span className="hint"> ／ カット {cutAt + 1} の上</span> : null}
        </>
      }
      right={<span className={`pill${needsTts ? ' warn' : ''}`}>{needsTts ? '要再生成' : '音声あり'}</span>}
    >
      <label style={{width: '100%'}}>
        本文（1 ブロック 1 文。変えると音声は作り直しになります）
        <textarea value={text} onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))} onBlur={commitText} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())} style={{minHeight: 64}} />
      </label>
      <div className="row">
        <span className="counter" title={seg.durSec ? '実測' : '見積もり'}>
          {[...seg.text].length}字 / {estimateSec(seg).toFixed(1)}s{seg.durSec ? '' : '（見積）'}
        </span>
        {hints.length > 0 && (
          <button className="small warn" onClick={() => patchSeg(index, {text: applyReadingHints(seg.text)}, true)} title={`TTS が誤読しやすい表記: ${hints.map((h) => `${h.from}→${h.to}`).join('・')}`}>
            かなに開く
          </button>
        )}
      </div>
      <div className="row">
        <label>
          表示名
          <input value={seg.label ?? ''} maxLength={80} placeholder="例: 美味すぎるぅ" onFocus={pushHistory} onChange={(e) => patchSeg(index, {label: e.target.value}, false)} aria-label="ナレーションの表示名" />
        </label>
        <label title="音声ファイルと結び付く内部ID。音声がある場合は変更できません">
          内部ID
          <input className="narr-id" value={seg.id} readOnly={!needsTts} onFocus={pushHistory} onChange={(e) => setNarr({...narration, segments: narration.segments.map((x, k) => (k === index ? {...x, id: e.target.value} : x))})} />
        </label>
        <label>
          配置秒
          <span className="btns">
            <input type="number" step={0.05} min={0} value={seg.at} onChange={(e) => patchSeg(index, {at: Math.max(0, Number(e.target.value))})} style={{width: 74}} />
            <button className="small" onClick={() => patchSeg(index, {at: Math.max(0, Math.round((seg.at - 0.1) * 1000) / 1000)})}>
              -0.1
            </button>
            <button className="small" onClick={() => patchSeg(index, {at: Math.round((seg.at + 0.1) * 1000) / 1000})}>
              +0.1
            </button>
          </span>
        </label>
        <button className="small" onClick={() => patchSeg(index, {at: Math.round((m.frame / m.fps) * 1000) / 1000})} title="再生ヘッドの位置に置く">
          再生位置に置く
        </button>
      </div>
      <div className="row">
        <label title="生成済み音声の先頭から使う長さ。元の音声は残ります">
          使用する長さ（秒）
          <input type="number" min={Math.min(0.1, fullSec)} max={fullSec} step={0.05} value={fullSec ? usedSec : ''} disabled={needsTts} onChange={(e) => setTrim(Number(e.target.value))} style={{width: 82}} />
        </label>
        <span className="hint">元音声 {fullSec.toFixed(2)} 秒</span>
        <button className="small" onClick={() => patchSeg(index, {trimSec: undefined})} disabled={needsTts || !seg.trimSec}>全体を使う</button>
      </div>
      {fullSec > 0 && !needsTts && <input type="range" aria-label="ナレーションの使用する長さ" min={Math.min(0.1, fullSec)} max={fullSec} step={0.01} value={usedSec} onChange={(e) => setTrim(Number(e.target.value))} style={{width: '100%'}} />}
      {seg.trimSec && <span className="hint">出力に反映するには保存後、ナレーション合成を再実行してください。</span>}
      <div className="row">
        <button className="small" onClick={() => onPlay(seg.id, seg.text, needsTts, seg.trimSec)} disabled={playing === seg.id || !seg.text.trim()} title={needsTts ? 'まだ音声が無いので、いまの速度で作って鳴らします（保存しません）' : '使用する長さだけ試聴します'}>
          {playing === seg.id ? '再生中…' : '▶ 聴く'}
        </button>
        <button className="small" onClick={() => onRegenerate(seg.id)} disabled={!!ttsBlockedBy || !seg.text.trim()} title={ttsBlockedBy ?? 'このブロックだけ作り直す（同じ文でも長さがばらつくので、納得いく読みが出るまで引き直せます）'}>
          この 1 本だけ生成
        </button>
        <button className="small" onClick={onSaveToLibrary} disabled={needsTts} title={needsTts ? '先に音声を生成してください' : 'この音声を名前付きで保存して別案件でも使う'}>
          音声を保存
        </button>
        <span style={{flex: 1}} />
        <button className="small danger" onClick={() => removeSeg(index)}>
          削除
        </button>
      </div>
    </Section>
  );
};

// ───────────────────────── 効果音 ─────────────────────────
export const SfxInspector: React.FC<Common & {index: number; lib: SfxLibrary | null; onPlay: (file: string, trimSec?: number) => void}> = ({m, index, lib, onPlay}) => {
  const {narration, patchSfx, removeSfx, pushHistory, setNarr} = m;
  const x = narration?.sfx?.[index];
  if (!narration || !x) return null;
  const sounds = lib?.sounds ?? [];
  return (
    <Section title={<>効果音 <span className="mono">{x.id}</span></>}>
      <div className="row">
        <label className="grow">
          音源
          <select value={x.file} onChange={(e) => patchSfx(index, {file: e.target.value, label: sounds.find((y) => y.file === e.target.value)?.label})}>
            {!sounds.some((y) => y.file === x.file) && <option value={x.file}>{x.file}（ライブラリに無い）</option>}
            {sounds.map((y) => (
              <option key={y.file} value={y.file}>
                {y.label}
              </option>
            ))}
          </select>
        </label>
        <button className="small" onClick={() => onPlay(x.file, x.trimSec)} title="この音を試聴">
          ▶
        </button>
      </div>
      <div className="row">
        <label title="役割（統一感の管理用）">
          役割
          <select value={x.role ?? ''} onChange={(e) => patchSfx(index, {role: e.target.value || undefined})}>
            <option value="">（役割なし）</option>
            {SFX_ROLES.map((r) => (
              <option key={r} value={r}>
                {SFX_ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          id
          <input className="narr-id" value={x.id} onFocus={pushHistory} onChange={(e) => setNarr({...narration, sfx: (narration.sfx ?? []).map((y, k) => (k === index ? {...y, id: e.target.value} : y))})} />
        </label>
      </div>
      <div className="row">
        <label>
          配置秒
          <span className="btns">
            <input type="number" step={0.05} min={0} value={x.at} onChange={(e) => patchSfx(index, {at: Math.max(0, Number(e.target.value))})} style={{width: 74}} />
            <button className="small" onClick={() => patchSfx(index, {at: Math.max(0, Math.round((x.at - 0.1) * 1000) / 1000)})}>
              -0.1
            </button>
            <button className="small" onClick={() => patchSfx(index, {at: Math.round((x.at + 0.1) * 1000) / 1000})}>
              +0.1
            </button>
          </span>
        </label>
        <label title="頭から使う長さ（秒）。長い素材を丸ごと鳴らさない">
          尺
          <input type="number" step={0.1} min={0.1} value={x.trimSec ?? ''} onChange={(e) => patchSfx(index, {trimSec: e.target.value ? Number(e.target.value) : undefined})} style={{width: 62}} />
        </label>
        <label title="音量（dB）">
          音量
          <input type="number" step={1} value={x.gainDb ?? 0} onChange={(e) => patchSfx(index, {gainDb: Number(e.target.value)})} style={{width: 62}} />
        </label>
        <label title="末尾のフェードアウト秒">
          fade
          <input type="number" step={0.05} min={0} value={x.fadeOutSec ?? ''} onChange={(e) => patchSfx(index, {fadeOutSec: e.target.value ? Number(e.target.value) : undefined})} style={{width: 62}} />
        </label>
      </div>
      <div className="row">
        <span className="hint">効果音は mix で乗ります。変えたら Render の「ナレーション合成（mix）」をやり直してください</span>
        <span style={{flex: 1}} />
        <button className="small danger" onClick={() => removeSfx(index)}>
          削除
        </button>
      </div>
    </Section>
  );
};

export const cutOf = (m: EditorModel, i: number): Cut | undefined => m.cuts?.cuts[i];
