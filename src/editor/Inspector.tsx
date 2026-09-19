// インスペクタ：選んでいるもの（カット / テロップグループ / ナレーション / 効果音 / 何も無し＝動画全体）の編集欄。
import React, {useEffect, useRef, useState} from 'react';
import type {Cut, ReelData} from '@shared/schema';
import {cutDurationSec} from '@shared/timeline';
import {countChars, isPlaceholder} from '@shared/telop-text';
import {applyReadingHints, ttsReadingHints} from '@shared/narration';
import {SFX_ROLES, SFX_ROLE_LABEL, type SfxLibrary} from '@shared/sfx';
import {TrimBar} from '../components/TrimBar';
import {CropBox} from '../components/CropBox';
import {DEFAULT_CROP, isDefaultCrop} from '@shared/schema/cuts';
import {fallbackDuration} from '../components/trim';
import {CutThumb} from '../components/CutThumb';
import type {EditorModel} from './useEditorModel';
import {BADGE_OPACITY_DEFAULT, GROUP_COLORS, KIND_LABEL, ROLE_LABEL} from './labels';

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
  const {cuts, validation, patchReel} = m;
  if (!cuts) return <div className="hint">左の素材をタイムラインへドラッグするか、Brief で構成を作ってください</div>;
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
          <label title="バッジ（エリア名・順位）の下地の濃さ。0 で下地なし、1 でベタ塗り。文字の濃さは変わりません">
            バッジの濃さ {Math.round((cuts.badgeOpacity ?? BADGE_OPACITY_DEFAULT) * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={cuts.badgeOpacity ?? BADGE_OPACITY_DEFAULT} onChange={(e) => patchReel({badgeOpacity: Number(e.target.value)})} />
          </label>
        </div>
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
export const CutInspector: React.FC<Common & {index: number; focusTelop?: boolean}> = ({m, index, onSeekCut, focusTelop}) => {
  const {cuts, catalog, s, clipOf, slotOf, groupOfCut, patchCut, patchSlot, moveCut, duplicateCut, removeCut, splitCut, pushHistory, setCuts, subsFrom} = m;
  const telopRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusTelop) telopRef.current?.focus();
  }, [focusTelop, index]);
  if (!cuts) return null;
  const c = cuts.cuts[index];
  if (!c) return null;
  const clip = clipOf(c.src);
  const slot = slotOf(c);
  const gi = groupOfCut.get(index);
  const text = c.main?.text ?? '';
  const fpsStep = 1 / cuts.fps;
  const clipBySrc = new Map((catalog?.clips ?? []).map((k) => [k.src, k]));

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
            <label>
              素材
              <select
                value={clip?.src ?? c.src}
                onChange={(e) => {
                  const nc = clipBySrc.get(e.target.value);
                  if (!nc) return patchCut(index, {src: e.target.value});
                  const dur = Math.min(cutDurationSec(c), nc.probe.durationSec);
                  patchCut(index, {src: nc.src, inSec: 0, outSec: Math.round(dur * 1000) / 1000});
                }}
              >
                {!clip && <option value={c.src}>{c.src}</option>}
                {(catalog?.clips ?? []).map((k) => (
                  <option key={k.id} value={k.src}>
                    {k.id} {k.tags?.description ?? k.slug}（{k.probe.durationSec.toFixed(1)}s）
                  </option>
                ))}
              </select>
            </label>
            <div className="hint">
              {clip ? `${clip.tags ? KIND_LABEL[clip.tags.kind] : '未タグ'} / ${clip.probe.durationSec.toFixed(2)}s / ${clip.probe.fps}fps` : 'catalog に無い素材'}
            </div>
            <div className="hint">
              尺 <b>{cutDurationSec(c).toFixed(2)}s</b>
              {c.playbackRate && c.playbackRate !== 1 ? ` / ${c.playbackRate}x` : ''}
            </div>
          </div>
        </div>
        <TrimBar
          inSec={c.inSec}
          outSec={c.outSec}
          durationSec={clip?.probe.durationSec ?? fallbackDuration(c)}
          fps={cuts.fps}
          strip={clip?.thumbs.strip}
          mediaBase={s.mediaBase}
          usableRanges={clip?.usableRanges}
          onStart={pushHistory}
          onChange={(r) => setCuts({...cuts, cuts: cuts.cuts.map((x, k) => (k === index ? {...x, ...r} : x))})}
        />

        {/* 画面内の切り出し（アスペクト比は変えない）。カットごとに決められる。
            素材側（Materials・選別モード）で決めた値は、構成を組んだときにここへ引き継がれている */}
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
        <div className="row">
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
        </div>
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
                    onChange={(e) => patchCut(index, (x) => (e.target.value === '' ? {...x, main: undefined} : {...x, main: {...(x.main ?? {}), text: e.target.value}}), {history: false})}
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
            onClick={() => {
              const err = splitCut(index);
              if (err) s.toast(err, 'error');
            }}
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
              setCuts({...cuts, cuts: cuts.cuts.map((c, k) => (idx.has(k) ? (e.target.value === '' ? {...c, main: undefined} : {...c, main: {...(c.main ?? {}), text: e.target.value}}) : c))});
            }}
          />
          <Counter text={text} />
        </span>
      </label>
      {isPlaceholder(text) && <div className="hint">未記入（{text}）。AI ▾ →「テロップを書いてもらう」でも埋められます</div>}
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
  Common & {index: number; onPlay: (id: string, text: string, needsTts: boolean) => void; playing: string | null; onRegenerate: (id: string) => void; ttsBlockedBy: string | null}
> = ({m, index, onPlay, playing, onRegenerate, ttsBlockedBy}) => {
  const {narration, patchSeg, removeSeg, pushHistory, setNarr, estimateSec, ranges} = m;
  const [draft, setDraft] = useState<string | null>(null);
  const seg = narration?.segments[index];
  useEffect(() => setDraft(null), [index, seg?.text]);
  if (!narration || !seg) return null;
  const hints = ttsReadingHints(seg.text);
  const needsTts = !!(seg as {needsTts?: boolean}).needsTts || !seg.durSec;
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
          ナレーション <span className="mono">{seg.id}</span>
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
          id
          <input className="narr-id" value={seg.id} onFocus={pushHistory} onChange={(e) => setNarr({...narration, segments: narration.segments.map((x, k) => (k === index ? {...x, id: e.target.value} : x))})} />
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
        <button className="small" onClick={() => onPlay(seg.id, seg.text, needsTts)} disabled={playing === seg.id || !seg.text.trim()} title={needsTts ? 'まだ音声が無いので、いまの速度で作って鳴らします（保存しません）' : '生成済みの音声を鳴らします'}>
          {playing === seg.id ? '再生中…' : '▶ 聴く'}
        </button>
        <button className="small" onClick={() => onRegenerate(seg.id)} disabled={!!ttsBlockedBy || !seg.text.trim()} title={ttsBlockedBy ?? 'このブロックだけ作り直す（同じ文でも長さがばらつくので、納得いく読みが出るまで引き直せます）'}>
          この 1 本だけ生成
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
