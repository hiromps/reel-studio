// サムネイル（投稿のカバー画像）の編集欄。「動画全体」のインスペクタに出す。
//
// 型は engine/src/Thumbnail.tsx（上に英字・左に縦書き・下に大きな横書き）。ここで決めるのは文言・フォント・背景のコマだけ。
// 空欄は案件（brief・カット）から自動で埋まり、本番レンダーのたびに out/thumbnail.jpg が作られる。
// プレビューはエンジンのコンポーネントをそのまま描くので、書き出しと同じ絵になる。
import React, {useEffect, useMemo, useState} from 'react';
import {Thumbnail} from '@remotion/player';
import type {ReelData, ThumbnailDef} from '@shared/schema';
import {bgFromCut, resolveThumbnail, thumbnailDefaults, THUMBNAIL_BUILTIN_FONT, THUMBNAIL_REL} from '@shared/thumbnail';
import {useStudio} from '../state/store';
import type {EditorModel} from './useEditorModel';

type Engine = {ReelThumbnail: React.ComponentType<Record<string, unknown>>};
let enginePromise: Promise<Engine> | null = null;
const loadEngine = () => (enginePromise ??= import('@engine/Thumbnail') as unknown as Promise<Engine>);

/** 空にした欄は消す（＝自動に戻る）。全部消えたら thumbnail ごと消してファイルを汚さない */
export const patchThumbnail = (m: Pick<EditorModel, 'cuts' | 'patchReel'>, p: Partial<ThumbnailDef>) => {
  if (!m.cuts) return;
  const next: Record<string, unknown> = {...(m.cuts.thumbnail ?? {}), ...p};
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
  m.patchReel({thumbnail: Object.keys(next).length ? (next as ThumbnailDef) : undefined} as Partial<ReelData>);
};

/** large … タイムラインの「サムネイル」から開いたとき（プレビューを大きく、欄を縦に並べる） */
export const ThumbnailSection: React.FC<{m: EditorModel; large?: boolean}> = ({m, large = false}) => {
  const PREVIEW_W = large ? 240 : 150;
  const s = useStudio();
  const {cuts, brief} = m;
  const fonts = s.config?.fonts ?? [];
  const [Comp, setComp] = useState<Engine['ReelThumbnail'] | null>(null);
  useEffect(() => {
    let alive = true;
    loadEngine().then((e) => alive && setComp(() => e.ReelThumbnail), () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const t: ThumbnailDef = cuts?.thumbnail ?? {};
  const defaults = useMemo(() => thumbnailDefaults(cuts, brief), [cuts, brief]);
  const resolved = useMemo(() => (cuts ? resolveThumbnail(cuts, brief, s.config?.telopFont) : null), [cuts, brief, s.config?.telopFont]);
  if (!cuts || !resolved) return null;

  const patch = (p: Partial<ThumbnailDef>) => patchThumbnail(m, p);

  // 背景は「いまの再生位置」から取る。カットの外（末尾）なら取れない
  const cutIndex = m.currentCut;
  const range = m.ranges[cutIndex];
  const cutAtHead = cutIndex >= 0 ? cuts.cuts[cutIndex] : undefined;
  const useHead = () => {
    if (!cutAtHead || !range) return;
    const offset = (m.frame / cuts.fps - range.startSec) * (cutAtHead.playbackRate ?? 1);
    patch({bg: bgFromCut(cutAtHead, offset)});
  };
  const bgLabel = (() => {
    const bg = resolved.bg;
    if (!bg) return 'カットがありません';
    const i = cuts.cuts.findIndex((c) => c.src === bg.src && bg.atSec >= c.inSec && bg.atSec <= c.outSec);
    const where = i >= 0 ? `カット ${i + 1}` : bg.src.split('/').pop();
    return `${where} の ${bg.atSec.toFixed(2)} 秒${t.bg ? '' : '（自動）'}`;
  })();

  const telopFontLabel = (() => {
    const f = cuts.font ?? s.config?.telopFont ?? null;
    if (!f) return '同梱の明朝';
    return fonts.find((x) => x.file === f)?.label ?? f;
  })();

  const render = async () => {
    // 書き出しは保存済みの cuts.json を読むので、先に保存する
    if (s.files.cuts.dirty) await s.saveFile('cuts');
    const job = await s.addJob('thumbnail');
    if (job) s.toast(`サムネイルを書き出しています → ${THUMBNAIL_REL}`, 'info');
  };

  return (
    <div className="thumb-editor" style={{display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', flexDirection: large ? 'column' : 'row'}}>
      <div style={{width: PREVIEW_W, flex: 'none'}}>
        {Comp && s.mediaBase ? (
          <Thumbnail
            component={Comp}
            compositionWidth={1080}
            compositionHeight={1920}
            durationInFrames={1}
            fps={30}
            frameToDisplay={0}
            inputProps={{...cuts, thumbnail: resolved}}
            style={{width: PREVIEW_W, height: Math.round((PREVIEW_W * 16) / 9), borderRadius: 6, overflow: 'hidden', background: '#000'}}
          />
        ) : (
          <div className="preview-loading" style={{width: PREVIEW_W, height: Math.round((PREVIEW_W * 16) / 9)}}>
            読込中…
          </div>
        )}
      </div>
      <div className="form" style={{flex: 1, minWidth: 180}}>
        <label title="上に大きく出す英字。空欄なら brief のエリアから決めます">
          英字（上）
          <input value={t.en ?? ''} placeholder={defaults.en} onChange={(e) => patch({en: e.target.value})} />
        </label>
        <label title="左の縦書き。空欄なら「地域×エリア」">
          縦書き（左）
          <input value={t.side ?? ''} placeholder={defaults.side} onChange={(e) => patch({side: e.target.value})} />
        </label>
        <label title="下の大きな横書き。8 文字前後がちょうど横幅いっぱい。改行すると 2 行になります。空欄なら brief のジャンル → 1 つ目のテロップ → 店名">
          キャッチ（下）
          <textarea rows={2} value={t.title ?? ''} placeholder={defaults.title || '例: 神コスパ寿司酒場'} onChange={(e) => patch({title: e.target.value})} />
        </label>
        <label title="サムネイルだけ別のフォントにできます。既定はテロップと同じもの">
          フォント
          <select value={t.font ?? ''} onChange={(e) => patch({font: e.target.value || undefined})}>
            <option value="">テロップと同じ（{telopFontLabel}）</option>
            <option value={THUMBNAIL_BUILTIN_FONT}>同梱の明朝（Noto Serif JP）</option>
            {fonts.map((f) => (
              <option key={f.file} value={f.file}>
                {f.label}
              </option>
            ))}
            {t.font && t.font !== THUMBNAIL_BUILTIN_FONT && !fonts.some((f) => f.file === t.font) && <option value={t.font}>{t.font}（置き場に無い）</option>}
          </select>
        </label>
        <div className="hint">背景: {bgLabel}{large ? '。タイムラインの目盛りの 🖼 を横にドラッグしても変えられます' : ''}</div>
        <div className="row" style={{gap: 6, flexWrap: 'wrap'}}>
          <button className="small" onClick={useHead} disabled={!cutAtHead} title={cutAtHead ? '再生ヘッド（赤い線）のコマを背景にします' : '再生ヘッドをカットの上に置いてください'}>
            再生ヘッドのコマを背景に
          </button>
          {t.bg && (
            <button className="small" onClick={() => patch({bg: undefined})} title="料理のカット（reveal → sizzle）の真ん中に戻します">
              背景を自動に戻す
            </button>
          )}
          <button className="small primary" onClick={() => void render()} disabled={!s.active || !s.supportsJob('thumbnail')} title={s.supportsJob('thumbnail') ? `${THUMBNAIL_REL} に書き出します（本番レンダーでも自動で作られます）` : 'サーバーが古いプロセスです。再起動してください'}>
            サムネイルを書き出す
          </button>
        </div>
      </div>
    </div>
  );
};
