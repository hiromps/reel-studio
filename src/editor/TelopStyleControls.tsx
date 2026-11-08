// 動画全体のテロップの見た目（向き・高さ・大きさ・1 行の字数・書体・フチ・影・赤タグ・大きい数字）。
// 既定はテーマ（azu なら横書き 2 行・ゴシック・黒フチ）。ここで変えた項目だけ cuts.json の telopStyle に書く。
// 判定はエンジンと同じ resolveTelopStyle を使うので、表示中の値とレンダー結果がずれない。
import React from 'react';
import type {ReelData} from '@shared/schema';
import {resolveTelopStyle, type TelopStyle} from '@engine/telops';

type Props = {cuts: ReelData; onChange: (telopStyle: TelopStyle | undefined) => void};

export const TelopStyleControls: React.FC<Props> = ({cuts, onChange}) => {
  const own = (cuts.telopStyle ?? {}) as TelopStyle;
  const look = resolveTelopStyle(cuts.theme, own);
  const set = (patch: Partial<TelopStyle>) => {
    const next: TelopStyle = {...own, ...patch};
    for (const k of Object.keys(next) as (keyof TelopStyle)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const horizontalOn = look.layout !== 'vertical';
  return (
    <details className="telop-style full" open={!!cuts.telopStyle || cuts.theme === 'azu'}>
      <summary title="テーマの既定から変えた項目だけ保存します">
        テロップの見た目{cuts.telopStyle ? <span className="hint">（{Object.keys(own).length} 項目を変更中）</span> : <span className="hint">（テーマの既定）</span>}
      </summary>
      <div className="form" style={{marginTop: 6}}>
        <label title="自動 = カットごとの向きに従う。横書き・縦書きを選ぶと全カットをその向きにします">
          向き
          <select value={own.layout ?? ''} onChange={(e) => set({layout: (e.target.value || undefined) as TelopStyle['layout']})}>
            <option value="">既定：{look.layout === 'auto' ? 'カットごと' : look.layout === 'horizontal' ? '横書き' : '縦書き'}</option>
            <option value="auto">カットごと</option>
            <option value="horizontal">横書き（全カット）</option>
            <option value="vertical">縦書き（全カット）</option>
          </select>
        </label>
        {horizontalOn && (
          <label title="横書きの中心の高さ（画面の高さに対する割合）。azu は 44%（39〜48%）">
            横書きの高さ {look.y !== null ? `${Math.round(look.y * 100)}%` : '（上部・従来）'}
            {look.y !== null ? (
              <input type="range" min={0.2} max={0.8} step={0.01} value={look.y} onChange={(e) => set({y: Number(e.target.value)})} />
            ) : (
              <button type="button" className="small" onClick={() => set({y: 0.44})}>
                画面の 44% に置く
              </button>
            )}
          </label>
        )}
        <label title="1080×1920 基準の文字の大きさ。長い行は画面幅に収まるよう自動で縮みます">
          文字の大きさ {Math.round(look.size)}px
          <input type="range" min={40} max={110} step={1} value={look.size} onChange={(e) => set({size: Number(e.target.value)})} />
        </label>
        {horizontalOn && (
          <label title="横書きで 1 行に入れる最大文字数。超えると読点（、）の後ろで 2 行に割ります。文言に改行を入れればその位置で割ります。0 = 割らない">
            1 行の文字数 {look.lineChars || '（割らない）'}
            <input type="range" min={0} max={20} step={1} value={look.lineChars} onChange={(e) => set({lineChars: Number(e.target.value)})} />
          </label>
        )}
        <label>
          書体
          <select value={own.family ?? ''} onChange={(e) => set({family: (e.target.value || undefined) as TelopStyle['family']})}>
            <option value="">既定：{look.family === 'gothic' ? 'ゴシック' : look.family === 'serif' ? '明朝' : '上のフォント'}</option>
            <option value="custom">上で選んだフォント</option>
            <option value="gothic">太めのゴシック</option>
            <option value="serif">同梱の明朝</option>
          </select>
        </label>
        <label>
          フチ
          <select value={own.outline ?? ''} onChange={(e) => set({outline: (e.target.value || undefined) as TelopStyle['outline']})}>
            <option value="">既定：{look.outline === 'hard' ? '黒フチ' : 'ぼかし'}</option>
            <option value="hard">くっきり黒フチ</option>
            <option value="soft">ぼかしフチ</option>
          </select>
        </label>
        <label>
          フチの太さ {Math.round(look.outlineWidth)}px
          <input type="range" min={0} max={24} step={1} value={look.outlineWidth} onChange={(e) => set({outlineWidth: Number(e.target.value)})} />
        </label>
        <label>
          影の濃さ {Math.round(look.shadow * 100)}%
          <input type="range" min={0} max={1} step={0.05} value={look.shadow} onChange={(e) => set({shadow: Number(e.target.value)})} />
        </label>
        <label className="full" title="文言の【名物】【絶品】のように隅付き括弧で囲んだ語を、赤いタグで出します">
          <span>
            <input type="checkbox" checked={look.tags} onChange={(e) => set({tags: e.target.checked})} /> 【】で囲んだ語を赤タグにする
          </span>
        </label>
        <label className="full" title="「100倍」「2000円」など数字のかたまりだけ大きく出します">
          <span>
            <input type="checkbox" checked={look.bigNumbers} onChange={(e) => set({bigNumbers: e.target.checked})} /> 数字だけ大きくする
          </span>
        </label>
      </div>
      {cuts.telopStyle && (
        <button className="small" style={{marginTop: 6}} onClick={() => onChange(undefined)} title="変更した項目を消して、テーマの既定に戻します">
          テーマの既定に戻す
        </button>
      )}
    </details>
  );
};
